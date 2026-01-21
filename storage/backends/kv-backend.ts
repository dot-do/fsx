/**
 * Cloudflare KV Backend for Blob Storage
 *
 * Implements the BlobStorage interface using Cloudflare KV as the storage backend.
 * KV is well-suited for extent storage because:
 *
 * - 25MB max value size (our 2MB extents fit easily)
 * - Extents are content-addressed (write once, read many) - perfect for KV's
 *   1 write/sec per key limit since each extent has a unique key
 * - Automatic global replication for low-latency reads at edge
 * - Eventually consistent reads (acceptable for immutable extents)
 *
 * Key Design Decisions:
 * - Keys are prefixed for namespacing (default: 'extent/')
 * - Metadata (size, etag) stored in KV's metadata field
 * - ETag is computed as SHA-256 hash of content for content-addressing
 * - List operations use KV's native list with cursor-based pagination
 *
 * @module storage/backends/kv-backend
 */

import type {
  BlobStorage,
  BlobReadResult,
  BlobWriteResult,
  BlobListResult,
  BlobListOptions,
  BlobWriteOptions,
  BlobObjectInfo,
  StorageHooks,
} from '../interfaces.js'
import { withInstrumentation, StorageError } from '../interfaces.js'

// =============================================================================
// Types
// =============================================================================

/**
 * Cloudflare KV namespace binding type.
 *
 * This matches the KVNamespace interface from @cloudflare/workers-types
 * but is defined here to avoid requiring that package as a dependency.
 */
export interface KVNamespace {
  get(key: string, options?: { type?: 'text' }): Promise<string | null>
  get(key: string, options: { type: 'json' }): Promise<unknown | null>
  get(key: string, options: { type: 'arrayBuffer' }): Promise<ArrayBuffer | null>
  get(key: string, options: { type: 'stream' }): Promise<ReadableStream | null>

  getWithMetadata<Metadata = unknown>(
    key: string,
    options?: { type?: 'text' }
  ): Promise<{ value: string | null; metadata: Metadata | null }>
  getWithMetadata<Metadata = unknown>(
    key: string,
    options: { type: 'json' }
  ): Promise<{ value: unknown | null; metadata: Metadata | null }>
  getWithMetadata<Metadata = unknown>(
    key: string,
    options: { type: 'arrayBuffer' }
  ): Promise<{ value: ArrayBuffer | null; metadata: Metadata | null }>
  getWithMetadata<Metadata = unknown>(
    key: string,
    options: { type: 'stream' }
  ): Promise<{ value: ReadableStream | null; metadata: Metadata | null }>

  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: {
      expiration?: number
      expirationTtl?: number
      metadata?: Record<string, unknown>
    }
  ): Promise<void>

  delete(key: string): Promise<void>

  list(options?: {
    prefix?: string
    limit?: number
    cursor?: string
  }): Promise<{
    keys: Array<{ name: string; expiration?: number; metadata?: unknown }>
    list_complete: boolean
    cursor?: string
  }>
}

/**
 * Metadata stored with each KV value.
 */
interface KVBlobMetadata {
  /** Size in bytes */
  size: number
  /** Content hash (SHA-256 hex) */
  etag: string
  /** Content type (MIME) */
  contentType?: string
  /** Custom metadata from caller */
  customMetadata?: Record<string, string>
  /** Upload timestamp (Unix ms) */
  uploadedAt: number
}

/**
 * Configuration for the KV blob storage backend.
 */
export interface KVBackendConfig {
  /**
   * Cloudflare KV namespace binding.
   */
  kv: KVNamespace

  /**
   * Key prefix for namespacing.
   * All keys will be stored as `${prefix}${path}`.
   * @default 'extent/'
   */
  prefix?: string

  /**
   * Optional instrumentation hooks for monitoring.
   */
  hooks?: StorageHooks
}

// =============================================================================
// Hash Utilities
// =============================================================================

/**
 * Compute SHA-256 hash of data and return as hex string.
 *
 * Uses the Web Crypto API which is available in Cloudflare Workers.
 */
async function computeEtag(data: Uint8Array): Promise<string> {
  // Cast to ArrayBuffer for Web Crypto API compatibility
  // (TypeScript is overly strict about ArrayBufferLike vs ArrayBuffer)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer)
  const hashArray = new Uint8Array(hashBuffer)
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// =============================================================================
// KVBlobStorage Implementation
// =============================================================================

/**
 * Cloudflare KV implementation of BlobStorage.
 *
 * Provides blob storage operations using Cloudflare KV as the backend.
 * Optimized for content-addressed, write-once-read-many workloads like
 * extent storage.
 *
 * @example
 * ```typescript
 * // In a Cloudflare Worker
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const storage = new KVBlobStorage({ kv: env.EXTENT_KV })
 *
 *     // Write an extent
 *     const result = await storage.put('ext-abc123', extentData)
 *
 *     // Read it back
 *     const blob = await storage.get('ext-abc123')
 *
 *     // List extents
 *     const list = await storage.list({ prefix: 'ext-', limit: 100 })
 *   }
 * }
 * ```
 */
export class KVBlobStorage implements BlobStorage {
  private readonly kv: KVNamespace
  private readonly prefix: string
  private readonly hooks?: StorageHooks

  /**
   * Create a new KV blob storage instance.
   *
   * @param config - Configuration options
   */
  constructor(config: KVBackendConfig) {
    this.kv = config.kv
    this.prefix = config.prefix ?? 'extent/'
    this.hooks = config.hooks
  }

  /**
   * Build the full KV key from a path.
   */
  private buildKey(path: string): string {
    return `${this.prefix}${path}`
  }

  /**
   * Extract the path from a full KV key.
   */
  private extractPath(key: string): string {
    if (key.startsWith(this.prefix)) {
      return key.slice(this.prefix.length)
    }
    return key
  }

  /**
   * Store a blob in KV.
   *
   * @param path - Storage key/path (will be prefixed)
   * @param data - Blob data as Uint8Array or ReadableStream
   * @param options - Optional write options (contentType, customMetadata)
   * @returns Write result with etag and size
   *
   * @remarks
   * - Computes SHA-256 etag from content for content-addressing
   * - Stores size and etag in KV metadata for efficient head() operations
   * - ReadableStream input is fully consumed into memory before hashing
   */
  async put(
    path: string,
    data: Uint8Array | ReadableStream,
    options?: BlobWriteOptions
  ): Promise<BlobWriteResult> {
    return withInstrumentation(this.hooks, 'put', path, async () => {
      const key = this.buildKey(path)

      // Convert ReadableStream to Uint8Array if needed
      let bytes: Uint8Array
      if (data instanceof ReadableStream) {
        const chunks: Uint8Array[] = []
        const reader = data.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
          }
        } finally {
          reader.releaseLock()
        }
        // Concatenate chunks
        const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
        bytes = new Uint8Array(totalLength)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.length
        }
      } else {
        bytes = data
      }

      // Compute content-addressed etag
      const etag = await computeEtag(bytes)

      // Build metadata - cast to Record<string, unknown> for KV API compatibility
      const metadata: Record<string, unknown> = {
        size: bytes.length,
        etag,
        contentType: options?.contentType,
        customMetadata: options?.customMetadata,
        uploadedAt: Date.now(),
      }

      // Store in KV with metadata
      await this.kv.put(key, bytes, { metadata })

      return {
        etag,
        size: bytes.length,
      }
    })
  }

  /**
   * Retrieve a blob from KV.
   *
   * @param path - Storage key/path
   * @returns Blob data and metadata, or null if not found
   *
   * @remarks
   * - Uses getWithMetadata to retrieve both content and metadata in one call
   * - Returns null if the blob doesn't exist (KV eventual consistency)
   */
  async get(path: string): Promise<BlobReadResult | null> {
    return withInstrumentation(this.hooks, 'get', path, async () => {
      const key = this.buildKey(path)

      const result = await this.kv.getWithMetadata<KVBlobMetadata>(key, {
        type: 'arrayBuffer',
      })

      if (result.value === null) {
        return null
      }

      const data = new Uint8Array(result.value)
      const metadata = result.metadata

      return {
        data,
        metadata: {
          size: metadata?.size ?? data.length,
          etag: metadata?.etag ?? (await computeEtag(data)),
          contentType: metadata?.contentType,
          customMetadata: metadata?.customMetadata,
          lastModified: metadata?.uploadedAt ? new Date(metadata.uploadedAt) : undefined,
        },
      }
    })
  }

  /**
   * Retrieve a blob as a ReadableStream.
   *
   * @param path - Storage key/path
   * @returns Stream and metadata, or null if not found
   *
   * @remarks
   * KV supports streaming reads which is more efficient for large blobs.
   */
  async getStream(
    path: string
  ): Promise<{ stream: ReadableStream; metadata: BlobReadResult['metadata'] } | null> {
    return withInstrumentation(this.hooks, 'getStream', path, async () => {
      const key = this.buildKey(path)

      const result = await this.kv.getWithMetadata<KVBlobMetadata>(key, {
        type: 'stream',
      })

      if (result.value === null) {
        return null
      }

      const metadata = result.metadata

      return {
        stream: result.value,
        metadata: {
          size: metadata?.size ?? 0,
          etag: metadata?.etag ?? '',
          contentType: metadata?.contentType,
          customMetadata: metadata?.customMetadata,
          lastModified: metadata?.uploadedAt ? new Date(metadata.uploadedAt) : undefined,
        },
      }
    })
  }

  /**
   * Delete a blob from KV.
   *
   * @param path - Storage key/path
   *
   * @remarks
   * KV delete is idempotent - no error if key doesn't exist.
   */
  async delete(path: string): Promise<void> {
    return withInstrumentation(this.hooks, 'delete', path, async () => {
      const key = this.buildKey(path)
      await this.kv.delete(key)
    })
  }

  /**
   * Delete multiple blobs from KV.
   *
   * @param paths - Array of storage keys/paths to delete
   *
   * @remarks
   * Deletes are performed in parallel for efficiency.
   */
  async deleteMany(paths: string[]): Promise<void> {
    await Promise.all(paths.map((path) => this.delete(path)))
  }

  /**
   * Check if a blob exists in KV.
   *
   * @param path - Storage key/path
   * @returns true if blob exists
   *
   * @remarks
   * Uses getWithMetadata with type 'text' which is lightweight.
   * Note: KV is eventually consistent, so existence checks may be stale.
   */
  async exists(path: string): Promise<boolean> {
    return withInstrumentation(this.hooks, 'exists', path, async () => {
      const key = this.buildKey(path)
      // Use text type which doesn't load the full value
      const result = await this.kv.getWithMetadata(key, { type: 'text' })
      return result.value !== null
    })
  }

  /**
   * Get blob metadata without downloading content.
   *
   * @param path - Storage key/path
   * @returns Metadata or null if not found
   *
   * @remarks
   * Uses getWithMetadata with type 'text' to avoid loading blob content.
   * Returns metadata stored during put() operation.
   */
  async head(path: string): Promise<BlobReadResult['metadata'] | null> {
    return withInstrumentation(this.hooks, 'head', path, async () => {
      const key = this.buildKey(path)

      // Get with text type to avoid loading full blob
      const result = await this.kv.getWithMetadata<KVBlobMetadata>(key, {
        type: 'text',
      })

      if (result.value === null) {
        return null
      }

      const metadata = result.metadata

      if (!metadata) {
        // Blob exists but has no metadata (shouldn't happen with our put())
        // Fall back to getting the full blob to compute metadata
        const fullResult = await this.get(path)
        return fullResult?.metadata ?? null
      }

      return {
        size: metadata.size,
        etag: metadata.etag,
        contentType: metadata.contentType,
        customMetadata: metadata.customMetadata,
        lastModified: metadata.uploadedAt ? new Date(metadata.uploadedAt) : undefined,
      }
    })
  }

  /**
   * List blobs with optional prefix filter.
   *
   * @param options - List options (prefix, limit, cursor)
   * @returns List of blob objects with pagination
   *
   * @remarks
   * - Uses KV's native list operation with cursor-based pagination
   * - Prefix is combined with the storage prefix
   * - Returns BlobObjectInfo which includes size from metadata
   */
  async list(options?: BlobListOptions): Promise<BlobListResult> {
    return withInstrumentation(this.hooks, 'list', options?.prefix ?? '', async () => {
      // Combine storage prefix with query prefix
      const queryPrefix = options?.prefix
        ? `${this.prefix}${options.prefix}`
        : this.prefix

      const result = await this.kv.list({
        prefix: queryPrefix,
        limit: options?.limit,
        cursor: options?.cursor,
      })

      const objects: BlobObjectInfo[] = result.keys.map((keyInfo) => {
        const metadata = keyInfo.metadata as KVBlobMetadata | undefined
        return {
          key: this.extractPath(keyInfo.name),
          size: metadata?.size ?? 0,
          etag: metadata?.etag ?? '',
          uploaded: metadata?.uploadedAt ? new Date(metadata.uploadedAt) : new Date(),
        }
      })

      return {
        objects,
        cursor: result.cursor,
        truncated: !result.list_complete,
      }
    })
  }

  /**
   * Copy a blob within KV.
   *
   * @param sourcePath - Source key/path
   * @param destPath - Destination key/path
   * @returns Write result for the copy
   *
   * @remarks
   * KV doesn't have native copy, so this reads and writes.
   * Preserves metadata from source blob.
   */
  async copy(sourcePath: string, destPath: string): Promise<BlobWriteResult> {
    return withInstrumentation(this.hooks, 'copy', `${sourcePath} -> ${destPath}`, async () => {
      // Read source
      const source = await this.get(sourcePath)
      if (!source) {
        throw StorageError.notFound(sourcePath, 'copy')
      }

      // Write to destination with same content type and custom metadata
      return this.put(destPath, source.data, {
        contentType: source.metadata.contentType,
        customMetadata: source.metadata.customMetadata,
      })
    })
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a KV-backed blob storage instance.
 *
 * @param config - KV backend configuration
 * @returns BlobStorage implementation using Cloudflare KV
 *
 * @example
 * ```typescript
 * // In a Cloudflare Worker
 * const storage = createKVBackend({
 *   kv: env.EXTENT_KV,
 *   prefix: 'mydb/extents/',
 * })
 *
 * // Use with ExtentStorage
 * const extentStorage = await createExtentStorage({
 *   backend: storage,
 *   // ... other config
 * })
 * ```
 */
export function createKVBackend(config: KVBackendConfig): BlobStorage {
  return new KVBlobStorage(config)
}

// =============================================================================
// Backend Capabilities (for tiered storage coordination)
// =============================================================================

/**
 * KV backend capabilities for use in tiered storage decisions.
 */
export const KV_BACKEND_CAPABILITIES = {
  /** Maximum value size in bytes (25MB) */
  maxSize: 25 * 1024 * 1024,

  /** KV does not support range reads */
  supportsRange: false,

  /** Write rate limit per key (1 write/sec) */
  writeRateLimitPerKey: 1,

  /** Global replication is automatic */
  globalReplication: true,

  /** Consistency model */
  consistency: 'eventual' as const,

  /** Best suited for immutable, content-addressed blobs */
  bestFor: ['immutable', 'content-addressed', 'read-heavy'] as const,
} as const

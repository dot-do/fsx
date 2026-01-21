/**
 * R2CacheBlobStorage - R2 + Cache API Read-Through Backend
 *
 * Combines Cloudflare R2 as authoritative storage with the Cache API
 * as a read-through cache for improved read performance.
 *
 * Key characteristics:
 * - R2 is the source of truth for all writes
 * - Cache API provides edge-distributed read caching
 * - Cache stores full responses (200), auto-generates 206 for ranges
 * - Metadata stored in HTTP headers for cache preservation
 * - FREE unlimited reads from cache (after first fetch)
 *
 * Cache behavior:
 * - Full objects are cached on first read (not 206 partials)
 * - Cache API auto-serves range requests from cached full objects
 * - TTL-based expiration (configurable, default 24 hours)
 * - Writes go directly to R2 and optionally warm the cache
 *
 * @module storage/backends/r2-cache-backend
 */

import type {
  BlobStorage,
  BlobReadResult,
  BlobWriteResult,
  BlobWriteOptions,
  BlobListResult,
  BlobListOptions,
  StorageHooks,
} from '../interfaces.js'
import {
  createOperationContext,
  createOperationResult,
} from '../interfaces.js'

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configuration options for R2CacheBlobStorage.
 */
export interface R2CacheBackendConfig {
  /**
   * R2 bucket binding from wrangler.toml.
   * This is the authoritative storage.
   */
  bucket: R2Bucket

  /**
   * Base URL for constructing cache keys.
   * Must be a valid URL format (e.g., 'https://fsx.cache/').
   * The path will be appended to this URL.
   */
  cacheBaseUrl: string

  /**
   * Name of the cache to use.
   * @default 'fsx-r2-cache'
   */
  cacheName?: string

  /**
   * Key prefix for R2 objects.
   * @default ''
   */
  prefix?: string

  /**
   * Default TTL in seconds for cached items.
   * @default 86400 (24 hours)
   */
  defaultTtl?: number

  /**
   * Maximum TTL in seconds.
   * @default 2592000 (30 days)
   */
  maxTtl?: number

  /**
   * Whether to warm the cache on writes.
   * If true, after writing to R2, the object is also put in cache.
   * @default false
   */
  warmCacheOnWrite?: boolean

  /**
   * Optional instrumentation hooks for metrics/logging.
   */
  hooks?: StorageHooks
}

/**
 * Extended write options for R2+Cache operations.
 */
export interface R2CacheWriteOptions extends BlobWriteOptions {
  /**
   * TTL in seconds for this specific item.
   * Will be clamped to maxTtl if exceeded.
   */
  ttl?: number

  /**
   * Override warmCacheOnWrite for this specific write.
   */
  warmCache?: boolean
}

// =============================================================================
// Constants
// =============================================================================

/** Default cache name */
const DEFAULT_CACHE_NAME = 'fsx-r2-cache'

/** Default TTL: 24 hours */
const DEFAULT_TTL = 86400

/** Maximum TTL: 30 days */
const MAX_TTL = 2592000

/** Custom header for storing original size */
const HEADER_SIZE = 'X-Fsx-Size'

/** Custom header for storing ETag */
const HEADER_ETAG = 'X-Fsx-Etag'

/** Custom header for storing creation timestamp */
const HEADER_CREATED = 'X-Fsx-Created'

/** Custom header for storing content type */
const HEADER_CONTENT_TYPE = 'X-Fsx-Content-Type'

/** Custom header prefix for custom metadata */
const HEADER_META_PREFIX = 'X-Fsx-Meta-'

/** Header indicating data came from cache */
const HEADER_CACHE_HIT = 'X-Fsx-Cache-Hit'

// =============================================================================
// R2CacheBlobStorage Implementation
// =============================================================================

/**
 * R2CacheBlobStorage - R2 with Cache API read-through layer.
 *
 * Implements the BlobStorage interface with R2 as authoritative storage
 * and Cache API as a transparent read-through cache.
 *
 * @example
 * ```typescript
 * // Create R2+Cache backend
 * const storage = new R2CacheBlobStorage({
 *   bucket: env.MY_R2_BUCKET,
 *   cacheBaseUrl: 'https://fsx.cache/',
 *   defaultTtl: 3600, // 1 hour cache TTL
 *   warmCacheOnWrite: true,
 * })
 *
 * // Writes go to R2 (and optionally cache)
 * await storage.put('data/file.json', jsonData)
 *
 * // First read: fetches from R2, caches full response
 * const result1 = await storage.get('data/file.json')
 *
 * // Subsequent reads: served from cache (FREE!)
 * const result2 = await storage.get('data/file.json')
 *
 * // Range reads: cache auto-generates 206 from cached full object
 * const range = await storage.getRange('data/file.json', 0, 99)
 * ```
 */
export class R2CacheBlobStorage implements BlobStorage {
  private readonly bucket: R2Bucket
  private readonly cacheName: string
  private readonly cacheBaseUrl: string
  private readonly prefix: string
  private readonly defaultTtl: number
  private readonly maxTtl: number
  private readonly warmCacheOnWrite: boolean
  private readonly hooks?: StorageHooks

  /** Lazily initialized cache instance */
  private cache: Cache | null = null

  constructor(config: R2CacheBackendConfig) {
    // Validate cacheBaseUrl
    if (!config.cacheBaseUrl) {
      throw new Error('R2CacheBackendConfig.cacheBaseUrl is required')
    }

    try {
      new URL(config.cacheBaseUrl)
    } catch {
      throw new Error(`Invalid cacheBaseUrl: ${config.cacheBaseUrl}. Must be a valid URL.`)
    }

    this.bucket = config.bucket
    this.cacheName = config.cacheName ?? DEFAULT_CACHE_NAME
    this.cacheBaseUrl = config.cacheBaseUrl.endsWith('/') ? config.cacheBaseUrl : config.cacheBaseUrl + '/'
    this.prefix = config.prefix ?? ''
    this.defaultTtl = Math.min(config.defaultTtl ?? DEFAULT_TTL, config.maxTtl ?? MAX_TTL)
    this.maxTtl = config.maxTtl ?? MAX_TTL
    this.warmCacheOnWrite = config.warmCacheOnWrite ?? false
    this.hooks = config.hooks
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Get the cache instance, opening it lazily.
   */
  private async getCache(): Promise<Cache> {
    if (!this.cache) {
      this.cache = await caches.open(this.cacheName)
    }
    return this.cache
  }

  /**
   * Get full R2 key with prefix.
   */
  private r2Key(path: string): string {
    return this.prefix + path
  }

  /**
   * Build a Request object for cache operations.
   */
  private buildCacheRequest(path: string): Request {
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path
    const url = this.cacheBaseUrl + encodeURIComponent(normalizedPath)
    return new Request(url, { method: 'GET' })
  }

  /**
   * Build a Response object for caching.
   */
  private buildCacheResponse(
    data: Uint8Array,
    r2Object: R2Object,
    options?: { ttl?: number }
  ): Response {
    const now = Date.now()
    const ttl = Math.min(options?.ttl ?? this.defaultTtl, this.maxTtl)

    // Build headers
    const headers = new Headers({
      'Content-Type': r2Object.httpMetadata?.contentType ?? 'application/octet-stream',
      'Content-Length': String(data.length),
      'Cache-Control': `public, max-age=${ttl}`,
      'ETag': r2Object.etag,
      [HEADER_SIZE]: String(r2Object.size),
      [HEADER_ETAG]: r2Object.etag,
      [HEADER_CREATED]: String(now),
      [HEADER_CACHE_HIT]: 'false',
    })

    // Store original content type
    if (r2Object.httpMetadata?.contentType) {
      headers.set(HEADER_CONTENT_TYPE, r2Object.httpMetadata.contentType)
    }

    // Store custom metadata
    if (r2Object.customMetadata) {
      for (const [key, value] of Object.entries(r2Object.customMetadata)) {
        headers.set(HEADER_META_PREFIX + key, String(value))
      }
    }

    // Create a new ArrayBuffer copy for Response compatibility
    const buffer = new ArrayBuffer(data.length)
    new Uint8Array(buffer).set(data)

    return new Response(buffer, {
      status: 200,
      headers,
    })
  }

  /**
   * Extract metadata from cache response headers.
   */
  private extractMetadataFromCache(response: Response): BlobReadResult['metadata'] {
    const headers = response.headers

    // Get size
    const sizeHeader = headers.get(HEADER_SIZE)
    const contentLength = headers.get('Content-Length')
    const size = sizeHeader ? parseInt(sizeHeader, 10) : (contentLength ? parseInt(contentLength, 10) : 0)

    // Get ETag
    const etag = headers.get(HEADER_ETAG) ?? headers.get('ETag') ?? ''

    // Get content type
    const contentType = headers.get(HEADER_CONTENT_TYPE) ?? headers.get('Content-Type') ?? undefined

    // Get creation timestamp
    const createdHeader = headers.get(HEADER_CREATED)
    const lastModified = createdHeader ? new Date(parseInt(createdHeader, 10)) : undefined

    // Extract custom metadata
    const customMetadata: Record<string, string> = {}
    headers.forEach((value, key) => {
      if (key.toLowerCase().startsWith(HEADER_META_PREFIX.toLowerCase())) {
        const metaKey = key.slice(HEADER_META_PREFIX.length)
        customMetadata[metaKey] = value
      }
    })

    return {
      size,
      etag,
      contentType,
      customMetadata: Object.keys(customMetadata).length > 0 ? customMetadata : undefined,
      lastModified,
    }
  }

  /**
   * Extract metadata from R2 object.
   */
  private extractMetadataFromR2(obj: R2Object): BlobReadResult['metadata'] {
    return {
      size: obj.size,
      etag: obj.etag,
      contentType: obj.httpMetadata?.contentType,
      customMetadata: obj.customMetadata,
      lastModified: obj.uploaded,
    }
  }

  // ===========================================================================
  // BlobStorage Interface Implementation
  // ===========================================================================

  /**
   * Store a blob in R2 (and optionally warm the cache).
   *
   * Writes always go to R2 as the authoritative store. If warmCacheOnWrite
   * is enabled (globally or per-write), the data is also cached.
   *
   * @param path - Storage key/path
   * @param data - Blob data (Uint8Array or ReadableStream)
   * @param options - Write options including TTL and cache warming
   * @returns Write result with etag and size
   */
  async put(
    path: string,
    data: Uint8Array | ReadableStream,
    options?: R2CacheWriteOptions
  ): Promise<BlobWriteResult> {
    const ctx = createOperationContext('put', path)
    this.hooks?.onOperationStart?.(ctx)

    try {
      const key = this.r2Key(path)

      // Convert ReadableStream to Uint8Array if needed
      let bytes: Uint8Array
      if (data instanceof Uint8Array) {
        bytes = data
      } else {
        const reader = data.getReader()
        const chunks: Uint8Array[] = []
        let totalLength = 0

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          totalLength += value.length
        }

        bytes = new Uint8Array(totalLength)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.length
        }
      }

      // Write to R2
      const r2Object = await this.bucket.put(key, bytes, {
        httpMetadata: options?.contentType ? { contentType: options.contentType } : undefined,
        customMetadata: options?.customMetadata,
      })

      // Optionally warm the cache
      const shouldWarmCache = options?.warmCache ?? this.warmCacheOnWrite
      if (shouldWarmCache) {
        const cache = await this.getCache()
        const cacheRequest = this.buildCacheRequest(path)
        const cacheResponse = this.buildCacheResponse(bytes, r2Object, { ttl: options?.ttl })
        await cache.put(cacheRequest, cacheResponse)
      }

      const result = {
        etag: r2Object.etag,
        size: r2Object.size,
      }

      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true, size: result.size }))
      return result
    } catch (error) {
      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: false }))
      throw error
    }
  }

  /**
   * Retrieve a blob with cache read-through.
   *
   * 1. Check cache for full object
   * 2. Cache miss -> fetch from R2, cache full response
   * 3. Return data
   *
   * @param path - Storage key/path
   * @returns Blob data and metadata, or null if not found
   */
  async get(path: string): Promise<BlobReadResult | null> {
    const ctx = createOperationContext('get', path)
    this.hooks?.onOperationStart?.(ctx)

    try {
      const cache = await this.getCache()
      const cacheRequest = this.buildCacheRequest(path)

      // Check cache first
      const cachedResponse = await cache.match(cacheRequest)
      if (cachedResponse) {
        const arrayBuffer = await cachedResponse.arrayBuffer()
        const data = new Uint8Array(arrayBuffer)
        const metadata = this.extractMetadataFromCache(cachedResponse)

        this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true, size: data.length }))
        return { data, metadata }
      }

      // Cache miss - fetch from R2
      const key = this.r2Key(path)
      const r2Object = await this.bucket.get(key)

      if (!r2Object) {
        this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true }))
        return null
      }

      const data = new Uint8Array(await r2Object.arrayBuffer())
      const metadata = this.extractMetadataFromR2(r2Object)

      // Cache the full response for future reads
      const cacheResponse = this.buildCacheResponse(data, r2Object)
      await cache.put(cacheRequest, cacheResponse)

      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true, size: data.length }))
      return { data, metadata }
    } catch (error) {
      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: false }))
      throw error
    }
  }

  /**
   * Retrieve a blob as a stream.
   *
   * Streams directly from cache if available, otherwise fetches from R2
   * and caches the full response.
   *
   * @param path - Storage key/path
   * @returns Stream and metadata, or null if not found
   */
  async getStream(path: string): Promise<{ stream: ReadableStream; metadata: BlobReadResult['metadata'] } | null> {
    const ctx = createOperationContext('getStream', path)
    this.hooks?.onOperationStart?.(ctx)

    try {
      const cache = await this.getCache()
      const cacheRequest = this.buildCacheRequest(path)

      // Check cache first
      const cachedResponse = await cache.match(cacheRequest)
      if (cachedResponse && cachedResponse.body) {
        const metadata = this.extractMetadataFromCache(cachedResponse)
        this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true }))
        return { stream: cachedResponse.body, metadata }
      }

      // Cache miss - fetch from R2
      const key = this.r2Key(path)
      const r2Object = await this.bucket.get(key)

      if (!r2Object) {
        this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true }))
        return null
      }

      // We need to read the full body to cache it, then create a new stream
      const data = new Uint8Array(await r2Object.arrayBuffer())
      const metadata = this.extractMetadataFromR2(r2Object)

      // Cache the full response
      const cacheResponse = this.buildCacheResponse(data, r2Object)
      await cache.put(cacheRequest, cacheResponse)

      // Create a new stream from the data
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(data)
          controller.close()
        },
      })

      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true }))
      return { stream, metadata }
    } catch (error) {
      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: false }))
      throw error
    }
  }

  /**
   * Retrieve a range of bytes from a blob.
   *
   * The Cache API automatically generates 206 responses for range requests
   * from cached full objects. If not in cache, fetches full object from R2,
   * caches it, and returns the requested range.
   *
   * @param path - Storage key/path
   * @param start - Start byte offset (inclusive)
   * @param end - End byte offset (inclusive, optional)
   * @returns Partial blob data and metadata, or null if not found
   */
  async getRange(path: string, start: number, end?: number): Promise<BlobReadResult | null> {
    const ctx = createOperationContext('getRange', path)
    this.hooks?.onOperationStart?.(ctx)

    try {
      // First, ensure the full object is cached
      const fullResult = await this.get(path)
      if (!fullResult) {
        this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true }))
        return null
      }

      // Extract the requested range
      const actualEnd = end !== undefined ? Math.min(end + 1, fullResult.data.length) : fullResult.data.length
      const rangeData = fullResult.data.slice(start, actualEnd)

      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true, size: rangeData.length }))
      return {
        data: rangeData,
        metadata: fullResult.metadata,
      }
    } catch (error) {
      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: false }))
      throw error
    }
  }

  /**
   * Delete a blob from R2 and cache.
   *
   * @param path - Storage key/path
   */
  async delete(path: string): Promise<void> {
    const ctx = createOperationContext('delete', path)
    this.hooks?.onOperationStart?.(ctx)

    try {
      const key = this.r2Key(path)

      // Delete from R2
      await this.bucket.delete(key)

      // Delete from cache
      const cache = await this.getCache()
      const cacheRequest = this.buildCacheRequest(path)
      await cache.delete(cacheRequest)

      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true }))
    } catch (error) {
      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: false }))
      throw error
    }
  }

  /**
   * Delete multiple blobs from R2 and cache.
   *
   * @param paths - Storage keys/paths to delete
   */
  async deleteMany(paths: string[]): Promise<void> {
    const ctx = createOperationContext('deleteMany', paths[0] ?? '')
    this.hooks?.onOperationStart?.(ctx)

    try {
      const keys = paths.map(p => this.r2Key(p))

      // Delete from R2
      await this.bucket.delete(keys)

      // Delete from cache
      const cache = await this.getCache()
      await Promise.all(
        paths.map(path => {
          const cacheRequest = this.buildCacheRequest(path)
          return cache.delete(cacheRequest)
        })
      )

      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true }))
    } catch (error) {
      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: false }))
      throw error
    }
  }

  /**
   * Check if a blob exists.
   *
   * Checks cache first, then R2 if not cached.
   *
   * @param path - Storage key/path
   * @returns true if blob exists
   */
  async exists(path: string): Promise<boolean> {
    const ctx = createOperationContext('exists', path)
    this.hooks?.onOperationStart?.(ctx)

    try {
      // Check cache first
      const cache = await this.getCache()
      const cacheRequest = this.buildCacheRequest(path)
      const cachedResponse = await cache.match(cacheRequest)

      if (cachedResponse) {
        this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true }))
        return true
      }

      // Check R2
      const key = this.r2Key(path)
      const r2Object = await this.bucket.head(key)

      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true }))
      return r2Object !== null
    } catch (error) {
      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: false }))
      throw error
    }
  }

  /**
   * Get blob metadata without downloading content.
   *
   * Checks cache first, then R2.
   *
   * @param path - Storage key/path
   * @returns Metadata or null if not found
   */
  async head(path: string): Promise<BlobReadResult['metadata'] | null> {
    const ctx = createOperationContext('head', path)
    this.hooks?.onOperationStart?.(ctx)

    try {
      // Check cache first
      const cache = await this.getCache()
      const cacheRequest = this.buildCacheRequest(path)
      const cachedResponse = await cache.match(cacheRequest)

      if (cachedResponse) {
        const metadata = this.extractMetadataFromCache(cachedResponse)
        this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true }))
        return metadata
      }

      // Check R2
      const key = this.r2Key(path)
      const r2Object = await this.bucket.head(key)

      if (!r2Object) {
        this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true }))
        return null
      }

      const metadata = this.extractMetadataFromR2(r2Object)
      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true }))
      return metadata
    } catch (error) {
      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: false }))
      throw error
    }
  }

  /**
   * List blobs in R2.
   *
   * Note: This lists from R2 directly. The Cache API does not support listing.
   *
   * @param options - List options (prefix, limit, cursor)
   * @returns List of blob objects with pagination
   */
  async list(options?: BlobListOptions): Promise<BlobListResult> {
    const ctx = createOperationContext('list', options?.prefix ?? '')
    this.hooks?.onOperationStart?.(ctx)

    try {
      const fullPrefix = options?.prefix ? this.r2Key(options.prefix) : this.prefix

      const result = await this.bucket.list({
        prefix: fullPrefix,
        limit: options?.limit,
        cursor: options?.cursor,
      })

      const listResult = {
        objects: result.objects.map(obj => ({
          key: obj.key,
          size: obj.size,
          etag: obj.etag,
          uploaded: obj.uploaded,
        })),
        cursor: result.truncated ? result.cursor : undefined,
        truncated: result.truncated,
      }

      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true }))
      return listResult
    } catch (error) {
      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: false }))
      throw error
    }
  }

  /**
   * Copy a blob within R2.
   *
   * Copies in R2 and optionally warms the destination in cache.
   *
   * @param sourcePath - Source key/path
   * @param destPath - Destination key/path
   * @returns Write result for the copy
   * @throws Error if source doesn't exist
   */
  async copy(sourcePath: string, destPath: string): Promise<BlobWriteResult> {
    const ctx = createOperationContext('copy', sourcePath)
    this.hooks?.onOperationStart?.(ctx)

    try {
      const sourceKey = this.r2Key(sourcePath)
      const destKey = this.r2Key(destPath)

      // Get source from R2
      const source = await this.bucket.get(sourceKey)
      if (!source) {
        throw new Error(`Source not found: ${sourcePath}`)
      }

      // Copy to destination in R2
      const destObject = await this.bucket.put(destKey, source.body, {
        httpMetadata: source.httpMetadata,
        customMetadata: source.customMetadata,
      })

      // If the source was cached, also cache the destination
      if (this.warmCacheOnWrite) {
        const sourceResult = await this.get(sourcePath)
        if (sourceResult) {
          const cache = await this.getCache()
          const destCacheRequest = this.buildCacheRequest(destPath)
          const destCacheResponse = this.buildCacheResponse(sourceResult.data, destObject)
          await cache.put(destCacheRequest, destCacheResponse)
        }
      }

      const result = {
        etag: destObject.etag,
        size: destObject.size,
      }

      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true, size: result.size }))
      return result
    } catch (error) {
      this.hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: false }))
      throw error
    }
  }

  // ===========================================================================
  // Cache-Specific Operations
  // ===========================================================================

  /**
   * Invalidate a cached item without affecting R2.
   *
   * Useful for forcing a refresh from R2 on next read.
   *
   * @param path - Storage key/path
   */
  async invalidateCache(path: string): Promise<void> {
    const cache = await this.getCache()
    const cacheRequest = this.buildCacheRequest(path)
    await cache.delete(cacheRequest)
  }

  /**
   * Invalidate multiple cached items without affecting R2.
   *
   * @param paths - Storage keys/paths to invalidate
   */
  async invalidateCacheMany(paths: string[]): Promise<void> {
    const cache = await this.getCache()
    await Promise.all(
      paths.map(path => {
        const cacheRequest = this.buildCacheRequest(path)
        return cache.delete(cacheRequest)
      })
    )
  }

  /**
   * Warm the cache for a specific path.
   *
   * Fetches from R2 and stores in cache if not already cached.
   *
   * @param path - Storage key/path
   * @param options - Optional TTL override
   * @returns true if cache was warmed, false if already cached or not found
   */
  async warmCache(path: string, options?: { ttl?: number }): Promise<boolean> {
    const cache = await this.getCache()
    const cacheRequest = this.buildCacheRequest(path)

    // Check if already cached
    const existing = await cache.match(cacheRequest)
    if (existing) {
      return false
    }

    // Fetch from R2
    const key = this.r2Key(path)
    const r2Object = await this.bucket.get(key)

    if (!r2Object) {
      return false
    }

    const data = new Uint8Array(await r2Object.arrayBuffer())
    const cacheResponse = this.buildCacheResponse(data, r2Object, options)
    await cache.put(cacheRequest, cacheResponse)

    return true
  }

  /**
   * Check if a path is currently cached.
   *
   * @param path - Storage key/path
   * @returns true if the path is in cache
   */
  async isCached(path: string): Promise<boolean> {
    const cache = await this.getCache()
    const cacheRequest = this.buildCacheRequest(path)
    const cachedResponse = await cache.match(cacheRequest)
    return cachedResponse !== undefined
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create an R2CacheBlobStorage instance.
 *
 * @param config - R2+Cache backend configuration
 * @returns Configured R2CacheBlobStorage instance
 *
 * @example
 * ```typescript
 * // Basic usage
 * const storage = createR2CacheBackend({
 *   bucket: env.MY_R2_BUCKET,
 *   cacheBaseUrl: 'https://fsx.cache/',
 * })
 *
 * // With cache warming on writes
 * const storage = createR2CacheBackend({
 *   bucket: env.MY_R2_BUCKET,
 *   cacheBaseUrl: 'https://my-worker.workers.dev/cache/',
 *   cacheName: 'my-app-cache',
 *   defaultTtl: 3600,      // 1 hour default
 *   maxTtl: 604800,        // 1 week max
 *   warmCacheOnWrite: true, // Write-through caching
 * })
 * ```
 */
export function createR2CacheBackend(config: R2CacheBackendConfig): R2CacheBlobStorage {
  return new R2CacheBlobStorage(config)
}

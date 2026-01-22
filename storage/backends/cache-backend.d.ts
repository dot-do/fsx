/**
 * CacheBlobStorage - Cloudflare Cache API Backend for ExtentStorage
 *
 * Provides an ephemeral, FREE storage backend using Cloudflare's Cache API.
 * Perfect for temporary files, scratch space, build artifacts, and session data.
 *
 * Key characteristics:
 * - FREE: No cost for reads or writes
 * - Unlimited: No rate limits on operations
 * - Global: Edge-distributed caching
 * - Ephemeral: No durability guarantees, data may expire
 *
 * Limitations:
 * - No list() support (Cache API doesn't support enumeration)
 * - TTL-based expiration (default 24 hours, max 30 days)
 * - Data may be evicted at any time based on cache pressure
 *
 * @module storage/backends/cache-backend
 */
import type { BlobStorage, BlobReadResult, BlobWriteResult, BlobWriteOptions, BlobListResult, BlobListOptions } from '../interfaces.js';
/**
 * Configuration options for CacheBlobStorage.
 */
export interface CacheBackendConfig {
    /**
     * Name of the cache to use.
     * @default 'fsx-extents'
     */
    cacheName?: string;
    /**
     * Base URL for constructing cache keys.
     * Must be a valid URL format (e.g., 'https://fsx.cache/').
     * The path will be appended to this URL.
     */
    baseUrl: string;
    /**
     * Default TTL in seconds for cached items.
     * @default 86400 (24 hours)
     */
    defaultTtl?: number;
    /**
     * Maximum TTL in seconds.
     * Items cannot have a TTL longer than this.
     * @default 2592000 (30 days)
     */
    maxTtl?: number;
}
/**
 * Options for cache put operations.
 */
export interface CachePutOptions extends BlobWriteOptions {
    /**
     * TTL in seconds for this specific item.
     * Will be clamped to maxTtl if exceeded.
     */
    ttl?: number;
}
/**
 * CacheBlobStorage - Ephemeral blob storage using Cloudflare Cache API.
 *
 * Implements the BlobStorage interface for use with ExtentStorage and other
 * fsx components. Provides free, unlimited read/write storage with global
 * edge distribution.
 *
 * @example
 * ```typescript
 * // Create cache backend
 * const storage = new CacheBlobStorage({
 *   baseUrl: 'https://fsx.cache/',
 *   defaultTtl: 3600, // 1 hour
 * })
 *
 * // Store a blob
 * await storage.put('extent/abc123', extentData)
 *
 * // Retrieve a blob
 * const result = await storage.get('extent/abc123')
 * if (result) {
 *   console.log('Got', result.data.length, 'bytes')
 * }
 *
 * // Delete a blob
 * await storage.delete('extent/abc123')
 * ```
 */
export declare class CacheBlobStorage implements BlobStorage {
    private readonly cacheName;
    private readonly baseUrl;
    private readonly defaultTtl;
    private readonly maxTtl;
    /** Lazily initialized cache instance */
    private cache;
    constructor(config: CacheBackendConfig);
    /**
     * Get the cache instance, opening it lazily.
     */
    private getCache;
    /**
     * Build a Request object for a given path.
     */
    private buildRequest;
    /**
     * Build a Response object for storage.
     */
    private buildResponse;
    /**
     * Generate a simple ETag using FNV-1a hash.
     */
    private generateEtag;
    /**
     * Extract metadata from response headers.
     */
    private extractMetadata;
    /**
     * Store a blob in the cache.
     *
     * @param path - Storage key/path
     * @param data - Blob data (Uint8Array or ReadableStream)
     * @param options - Write options including TTL
     * @returns Write result with etag and size
     */
    put(path: string, data: Uint8Array | ReadableStream, options?: CachePutOptions): Promise<BlobWriteResult>;
    /**
     * Retrieve a blob from the cache.
     *
     * @param path - Storage key/path
     * @returns Blob data and metadata, or null if not found
     */
    get(path: string): Promise<BlobReadResult | null>;
    /**
     * Retrieve a blob as a stream.
     *
     * @param path - Storage key/path
     * @returns Stream and metadata, or null if not found
     */
    getStream(path: string): Promise<{
        stream: ReadableStream;
        metadata: BlobReadResult['metadata'];
    } | null>;
    /**
     * Delete a blob from the cache.
     *
     * @param path - Storage key/path
     */
    delete(path: string): Promise<void>;
    /**
     * Delete multiple blobs from the cache.
     *
     * @param paths - Storage keys/paths to delete
     */
    deleteMany(paths: string[]): Promise<void>;
    /**
     * Check if a blob exists in the cache.
     *
     * @param path - Storage key/path
     * @returns true if blob exists
     */
    exists(path: string): Promise<boolean>;
    /**
     * Get blob metadata without downloading content.
     *
     * Note: Cache API doesn't support true HEAD requests, so this
     * fetches the full response and extracts headers. For large blobs,
     * consider using exists() if you only need presence check.
     *
     * @param path - Storage key/path
     * @returns Metadata or null if not found
     */
    head(path: string): Promise<BlobReadResult['metadata'] | null>;
    /**
     * List blobs in the cache.
     *
     * IMPORTANT: Cache API does not support listing/enumeration.
     * This method returns an empty result with a warning.
     *
     * For use cases requiring listing, consider:
     * 1. Tracking keys in a separate metadata store
     * 2. Using a different backend (R2, KV) that supports listing
     * 3. Maintaining an in-memory or SQL-based index of cached keys
     *
     * @param _options - List options (ignored - Cache API limitation)
     * @returns Empty list result
     */
    list(_options?: BlobListOptions): Promise<BlobListResult>;
    /**
     * Copy a blob within the cache.
     *
     * Note: Implemented as get + put since Cache API doesn't have native copy.
     *
     * @param sourcePath - Source key/path
     * @param destPath - Destination key/path
     * @returns Write result for the copy
     * @throws Error if source doesn't exist
     */
    copy(sourcePath: string, destPath: string): Promise<BlobWriteResult>;
}
/**
 * Create a CacheBlobStorage instance.
 *
 * @param config - Cache backend configuration
 * @returns Configured CacheBlobStorage instance
 *
 * @example
 * ```typescript
 * // Basic usage
 * const cache = createCacheBackend({
 *   baseUrl: 'https://fsx.cache/',
 * })
 *
 * // With custom TTL
 * const cache = createCacheBackend({
 *   baseUrl: 'https://my-worker.workers.dev/cache/',
 *   cacheName: 'my-app-cache',
 *   defaultTtl: 3600,    // 1 hour default
 *   maxTtl: 604800,      // 1 week max
 * })
 *
 * // Use with ExtentStorage
 * const extentStorage = await createExtentStorage({
 *   pageSize: 4096,
 *   extentSize: 2 * 1024 * 1024,
 *   backend: cache,
 *   sql: sqlAdapter,
 * })
 * ```
 */
export declare function createCacheBackend(config: CacheBackendConfig): BlobStorage;
export type { BlobStorage, BlobReadResult, BlobWriteResult, BlobListResult };
//# sourceMappingURL=cache-backend.d.ts.map
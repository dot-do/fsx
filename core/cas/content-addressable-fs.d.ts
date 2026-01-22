/**
 * ContentAddressableFS - Git-style object storage layer
 *
 * Provides a content-addressable storage (CAS) layer on top of FSx that enables
 * git-style object storage. Objects are stored with their SHA-1 hash as the identifier,
 * enabling deduplication and content verification.
 *
 * Features:
 * - Compute SHA-1/SHA-256 hash of content on write
 * - Use hash as the blob identifier (not random UUID)
 * - Deduplicate blobs with identical content
 * - Support git object format: `<type> <size>\0<content>`
 * - Store objects in git loose object structure: `objects/xx/yyyy...`
 * - Zlib compression for stored objects
 *
 * @example
 * ```typescript
 * const cas = new ContentAddressableFS(storage)
 *
 * // Store a blob
 * const hash = await cas.putObject(new TextEncoder().encode('hello'), 'blob')
 * console.log(hash) // 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0'
 *
 * // Retrieve the object
 * const obj = await cas.getObject(hash)
 * console.log(obj?.type) // 'blob'
 * console.log(new TextDecoder().decode(obj?.data)) // 'hello'
 *
 * // Check if object exists
 * const exists = await cas.hasObject(hash)
 * console.log(exists) // true
 *
 * // Delete object
 * await cas.deleteObject(hash)
 * ```
 */
import { type BatchPutResult, type BatchPutOptions } from './put-object.js';
import { RefCountStorage, DeduplicationStats } from './refcount.js';
import { type LRUCacheOptions, type CacheStats } from './cache.js';
import { type ExistenceCacheOptions, type ExistenceCacheStats } from './existence-cache.js';
/**
 * Git object types supported by the CAS
 */
export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';
/**
 * Result of retrieving an object from the CAS
 */
export interface CASObject {
    /** Git object type: blob, tree, commit, or tag */
    type: string;
    /** Raw object data (uncompressed) */
    data: Uint8Array;
}
/**
 * Storage interface required by ContentAddressableFS
 *
 * This interface abstracts the underlying storage mechanism.
 * Implementations can use R2, local filesystem, or in-memory storage.
 */
export interface CASStorage {
    /**
     * Write data to a path
     * @param path - Storage path (e.g., 'objects/ab/cdef...')
     * @param data - Data to write
     */
    write(path: string, data: Uint8Array): Promise<void>;
    /**
     * Read data from a path
     * @param path - Storage path
     * @returns Object with data, or null if not found
     */
    get(path: string): Promise<{
        data: Uint8Array;
    } | null>;
    /**
     * Check if a path exists
     * @param path - Storage path
     * @returns true if the path exists
     */
    exists(path: string): Promise<boolean>;
    /**
     * Delete data at a path
     * @param path - Storage path
     */
    delete(path: string): Promise<void>;
}
/**
 * Options for batch existence checking in ContentAddressableFS
 */
export interface HasObjectBatchOptions {
    /**
     * Maximum concurrent existence checks.
     * Higher values improve throughput but use more resources.
     * @default 10
     */
    concurrency?: number;
    /**
     * Optional progress callback for batch operations
     */
    onProgress?: (progress: HasObjectBatchProgress) => void;
}
/**
 * Progress information for batch operations
 */
export interface HasObjectBatchProgress {
    /** Number of hashes processed so far */
    processed: number;
    /** Total number of hashes to process */
    total: number;
    /** Current hash being processed */
    currentHash: string;
    /** Whether the current hash exists */
    exists: boolean;
}
/**
 * Result of batch existence check
 */
export interface HasObjectBatchResult {
    /** The hash that was checked */
    hash: string;
    /** Whether the object exists */
    exists: boolean;
}
/**
 * Options for ContentAddressableFS constructor
 */
export interface CASOptions {
    /**
     * Optional reference count storage for tracking object references.
     * If not provided, an in-memory storage will be used.
     */
    refCountStorage?: RefCountStorage;
    /**
     * Enable LRU caching for getObject reads.
     * When enabled, frequently accessed objects are cached in memory
     * to reduce storage reads and decompression overhead.
     *
     * Can be:
     * - `true` to enable with default settings (1000 entries, 50MB)
     * - `LRUCacheOptions` to configure cache size
     * - `false` or undefined to disable caching (default)
     */
    cache?: boolean | LRUCacheOptions;
    /**
     * Enable existence caching for hasObject and hasObjectBatch calls.
     * Uses a bloom filter for fast negative lookups and TTL-based cache
     * for positive results.
     *
     * Can be:
     * - `true` to enable with default settings
     * - `ExistenceCacheOptions` to configure cache behavior
     * - `false` or undefined to disable existence caching (default)
     */
    existenceCache?: boolean | ExistenceCacheOptions;
}
/**
 * ContentAddressableFS - Git-compatible content-addressable storage
 *
 * This class provides a high-level API for storing and retrieving git objects.
 * Objects are stored using their content hash as the identifier, enabling
 * deduplication and content integrity verification.
 */
export declare class ContentAddressableFS {
    private storage;
    private refCountStorage;
    private cache;
    private existenceCache;
    /**
     * Create a new ContentAddressableFS instance
     *
     * @param storage - Storage backend implementing CASStorage interface
     * @param options - Optional configuration including refcount storage and caching
     *
     * @example
     * ```typescript
     * // With R2 storage
     * const r2Storage = new R2Storage({ bucket: env.BUCKET })
     * const cas = new ContentAddressableFS({
     *   write: (path, data) => r2Storage.put(path, data),
     *   get: (path) => r2Storage.get(path),
     *   exists: (path) => r2Storage.exists(path),
     *   delete: (path) => r2Storage.delete(path),
     * })
     *
     * // With custom refcount storage
     * const cas = new ContentAddressableFS(storage, {
     *   refCountStorage: new SQLiteRefCountStorage(db)
     * })
     *
     * // With LRU caching enabled
     * const cas = new ContentAddressableFS(storage, {
     *   cache: true // default: 1000 entries, 50MB
     * })
     *
     * // With custom cache settings
     * const cas = new ContentAddressableFS(storage, {
     *   cache: { maxEntries: 500, maxBytes: 10 * 1024 * 1024 } // 500 entries, 10MB
     * })
     *
     * // With existence caching enabled
     * const cas = new ContentAddressableFS(storage, {
     *   existenceCache: true // default settings
     * })
     *
     * // With custom existence cache settings
     * const cas = new ContentAddressableFS(storage, {
     *   existenceCache: { ttl: 120000, maxEntries: 20000 } // 2 min TTL, 20k entries
     * })
     * ```
     */
    constructor(storage: CASStorage, options?: CASOptions);
    /**
     * Store a git object and return its content hash
     *
     * The object is stored in git format:
     * 1. Create header: `<type> <size>\0`
     * 2. Concatenate header with content
     * 3. Compute SHA-1 hash of the full object
     * 4. Compress with zlib
     * 5. Store at `objects/xx/yyyy...`
     *
     * @param data - Object content as Uint8Array
     * @param type - Object type: 'blob', 'tree', 'commit', or 'tag'
     * @returns 40-character lowercase hex SHA-1 hash
     *
     * @example
     * ```typescript
     * // Store a blob
     * const content = new TextEncoder().encode('hello world')
     * const hash = await cas.putObject(content, 'blob')
     * console.log(hash) // '95d09f2b10159347eece71399a7e2e907ea3df4f'
     *
     * // Store a commit
     * const commitData = new TextEncoder().encode(
     *   'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n' +
     *   'author Test <test@test.com> 1234567890 +0000\n' +
     *   'committer Test <test@test.com> 1234567890 +0000\n\n' +
     *   'Initial commit'
     * )
     * const commitHash = await cas.putObject(commitData, 'commit')
     * ```
     */
    putObject(data: Uint8Array, type: ObjectType): Promise<string>;
    /**
     * Store multiple git objects in parallel with progress reporting
     *
     * This method enables efficient batch storage of multiple objects:
     * - Parallelizes hash computation and compression
     * - Deduplicates writes (skips objects that already exist)
     * - Reports progress via optional callback
     * - Controls concurrency to prevent resource exhaustion
     * - Maintains reference counts for all stored objects
     *
     * @param items - Array of objects to store, each with data and type
     * @param options - Configuration for concurrency and progress reporting
     * @returns Array of results with hash and write status for each item
     *
     * @example
     * ```typescript
     * const items = [
     *   { data: new TextEncoder().encode('hello'), type: 'blob' as const },
     *   { data: new TextEncoder().encode('world'), type: 'blob' as const },
     *   { data: treeData, type: 'tree' as const },
     * ]
     *
     * const results = await cas.putObjectBatch(items, {
     *   concurrency: 5,
     *   onProgress: ({ processed, total }) => {
     *     console.log(`Progress: ${processed}/${total}`)
     *   }
     * })
     *
     * results.forEach(r => console.log(`${r.hash}: ${r.written ? 'new' : 'deduped'}`))
     * ```
     */
    putObjectBatch(items: Array<{
        data: Uint8Array;
        type: ObjectType;
    }>, options?: BatchPutOptions): Promise<BatchPutResult[]>;
    /**
     * Retrieve a git object by its hash
     *
     * If caching is enabled, this will first check the cache before reading from storage.
     * On cache miss, the object is read from storage and added to the cache.
     *
     * @param hash - 40 or 64 character hex string (SHA-1 or SHA-256)
     * @returns Object with type and data, or null if not found
     *
     * @example
     * ```typescript
     * const obj = await cas.getObject('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0')
     * if (obj) {
     *   console.log(obj.type) // 'blob'
     *   console.log(new TextDecoder().decode(obj.data)) // 'hello'
     * }
     * ```
     */
    getObject(hash: string): Promise<CASObject | null>;
    /**
     * Check if an object exists in the CAS
     *
     * This is a fast operation that only checks file existence
     * without reading or decompressing content.
     *
     * If existence caching is enabled, uses:
     * 1. Bloom filter for fast negative lookups (O(1) "definitely not exists")
     * 2. TTL cache for positive results
     * 3. Storage check only on cache miss
     *
     * @param hash - 40 or 64 character hex string (SHA-1 or SHA-256)
     * @returns true if the object exists, false otherwise
     *
     * @example
     * ```typescript
     * if (await cas.hasObject('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0')) {
     *   console.log('Object exists!')
     * }
     * ```
     */
    hasObject(hash: string): Promise<boolean>;
    /**
     * Check if multiple objects exist in the CAS in parallel
     *
     * This is more efficient than calling hasObject() multiple times because:
     * 1. Validates all hashes upfront
     * 2. Checks cache for all hashes first
     * 3. Parallelizes storage checks with controlled concurrency
     * 4. Updates cache in batch
     *
     * @param hashes - Array of 40 or 64 character hex strings (SHA-1 or SHA-256)
     * @param options - Configuration for batch processing
     * @returns Array of results with hash and existence status
     *
     * @example
     * ```typescript
     * const results = await cas.hasObjectBatch([
     *   'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
     *   'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0',
     *   '95d09f2b10159347eece71399a7e2e907ea3df4f',
     * ])
     *
     * results.forEach(r => console.log(`${r.hash}: ${r.exists}`))
     * ```
     */
    hasObjectBatch(hashes: string[], options?: HasObjectBatchOptions): Promise<HasObjectBatchResult[]>;
    /**
     * Delete an object from the CAS
     *
     * With reference counting enabled, this decrements the reference count.
     * The object is only physically deleted when the reference count reaches 0.
     *
     * @param hash - 40 or 64 character hex string (SHA-1 or SHA-256)
     *
     * @example
     * ```typescript
     * await cas.deleteObject('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0')
     * ```
     */
    deleteObject(hash: string): Promise<void>;
    /**
     * Force delete an object regardless of reference count
     *
     * This bypasses reference counting and immediately deletes the object.
     * Use with caution as it may leave dangling references.
     *
     * @param hash - 40 or 64 character hex string (SHA-1 or SHA-256)
     *
     * @example
     * ```typescript
     * // Force delete even if there are references
     * await cas.forceDelete('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0')
     * ```
     */
    forceDelete(hash: string): Promise<void>;
    /**
     * Get the reference count for an object
     *
     * @param hash - 40 or 64 character hex string (SHA-1 or SHA-256)
     * @returns The current reference count (0 if object doesn't exist or has no references)
     *
     * @example
     * ```typescript
     * const refCount = await cas.getRefCount('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0')
     * console.log(`Object has ${refCount} references`)
     * ```
     */
    getRefCount(hash: string): Promise<number>;
    /**
     * Get deduplication statistics
     *
     * @returns Statistics about objects, references, and bytes saved
     *
     * @example
     * ```typescript
     * const stats = await cas.getStats()
     * console.log(`Total objects: ${stats.totalObjects}`)
     * console.log(`Total references: ${stats.totalReferences}`)
     * console.log(`Bytes saved by dedup: ${stats.deduplicatedBytes}`)
     * console.log(`Average refs per object: ${stats.averageRefCount}`)
     * ```
     */
    getStats(): Promise<DeduplicationStats>;
    /**
     * Get cache statistics (if caching is enabled)
     *
     * Returns statistics about cache performance including hits, misses,
     * hit ratio, and memory usage. Returns null if caching is disabled.
     *
     * @returns Cache statistics or null if caching is disabled
     *
     * @example
     * ```typescript
     * const cacheStats = cas.getCacheStats()
     * if (cacheStats) {
     *   console.log(`Cache hit ratio: ${(cacheStats.hitRatio * 100).toFixed(1)}%`)
     *   console.log(`Cache size: ${cacheStats.entryCount} entries, ${cacheStats.totalBytes} bytes`)
     *   console.log(`Hits: ${cacheStats.hits}, Misses: ${cacheStats.misses}`)
     * }
     * ```
     */
    getCacheStats(): CacheStats | null;
    /**
     * Check if caching is enabled
     *
     * @returns true if caching is enabled
     */
    isCacheEnabled(): boolean;
    /**
     * Clear the object cache (if caching is enabled)
     *
     * This removes all cached objects but does not affect statistics.
     * To reset statistics, use resetCacheStats().
     *
     * @example
     * ```typescript
     * cas.clearCache()
     * console.log('Cache cleared')
     * ```
     */
    clearCache(): void;
    /**
     * Reset cache statistics (if caching is enabled)
     *
     * This resets hits, misses, and eviction counters to zero.
     * Does not clear cached objects.
     *
     * @example
     * ```typescript
     * cas.resetCacheStats()
     * console.log('Cache statistics reset')
     * ```
     */
    resetCacheStats(): void;
    /**
     * Get existence cache statistics (if existence caching is enabled)
     *
     * Returns statistics about existence cache performance including:
     * - Cache hits and misses
     * - Bloom filter rejections (fast negative lookups)
     * - Hit ratio and false positive rate
     *
     * @returns Existence cache statistics or null if existence caching is disabled
     *
     * @example
     * ```typescript
     * const stats = cas.getExistenceCacheStats()
     * if (stats) {
     *   console.log(`Hit ratio: ${(stats.hitRatio * 100).toFixed(1)}%`)
     *   console.log(`Bloom rejections: ${stats.bloomRejections}`)
     *   console.log(`Estimated FP rate: ${(stats.bloomFalsePositiveRate * 100).toFixed(2)}%`)
     * }
     * ```
     */
    getExistenceCacheStats(): ExistenceCacheStats | null;
    /**
     * Check if existence caching is enabled
     *
     * @returns true if existence caching is enabled
     */
    isExistenceCacheEnabled(): boolean;
    /**
     * Clear the existence cache
     *
     * @param clearBloomFilter - Also clear the bloom filter (more expensive operation)
     *
     * @example
     * ```typescript
     * cas.clearExistenceCache() // Clear only TTL cache
     * cas.clearExistenceCache(true) // Also clear bloom filter
     * ```
     */
    clearExistenceCache(clearBloomFilter?: boolean): void;
    /**
     * Reset existence cache statistics
     *
     * This resets hits, misses, and bloom rejection counters to zero.
     * Does not clear cached entries or bloom filter.
     */
    resetExistenceCacheStats(): void;
    /**
     * Delete multiple objects in a batch operation
     *
     * This method enables efficient batch deletion of multiple objects:
     * - Processes deletions in parallel with controlled concurrency
     * - Respects reference counting (only deletes when refcount reaches 0)
     * - Reports progress via optional callback
     * - Returns detailed results for each object
     *
     * @param hashes - Array of 40 or 64 character hex hashes to delete
     * @param options - Configuration for concurrency and progress reporting
     * @returns Array of results with deletion status for each hash
     *
     * @example
     * ```typescript
     * const results = await cas.deleteObjectBatch(
     *   [hash1, hash2, hash3],
     *   {
     *     concurrency: 5,
     *     onProgress: ({ processed, total, currentHash }) => {
     *       console.log(`Progress: ${processed}/${total}`)
     *     }
     *   }
     * )
     *
     * results.forEach(r => console.log(`${r.hash}: ${r.deleted ? 'deleted' : 'kept'}`))
     * ```
     */
    deleteObjectBatch(hashes: string[], options?: BatchDeleteOptions): Promise<BatchDeleteResult[]>;
    /**
     * Garbage collection: remove all objects with zero references
     *
     * This method scans the refcount storage and deletes any objects
     * that have no remaining references. This is useful for cleaning up
     * orphaned objects that were created but never committed to a ref.
     *
     * @param options - Configuration for the GC operation
     * @returns Statistics about what was collected
     *
     * @example
     * ```typescript
     * const gcResult = await cas.gc({
     *   dryRun: true, // Preview what would be deleted
     *   onProgress: ({ scanned, deletedSoFar }) => {
     *     console.log(`Scanned: ${scanned}, Deleted: ${deletedSoFar}`)
     *   }
     * })
     *
     * console.log(`Would delete ${gcResult.deletedCount} objects (${gcResult.bytesFreed} bytes)`)
     * ```
     */
    gc(options?: GCOptions): Promise<GCResult>;
    /**
     * Validate that a string is a valid hash format
     * Must be exactly 40 (SHA-1) or 64 (SHA-256) hex characters
     */
    private isValidHash;
}
/**
 * Options for batch delete operations
 */
export interface BatchDeleteOptions {
    /**
     * Maximum number of concurrent delete operations.
     * Defaults to 10.
     */
    concurrency?: number;
    /**
     * Progress callback invoked after each deletion
     */
    onProgress?: (progress: BatchDeleteProgress) => void;
}
/**
 * Progress information for batch delete operations
 */
export interface BatchDeleteProgress {
    /** Number of objects processed so far */
    processed: number;
    /** Total number of objects to process */
    total: number;
    /** Hash of the current object */
    currentHash: string;
    /** Whether the current object was deleted */
    deleted: boolean;
}
/**
 * Result of a single delete operation in a batch
 */
export interface BatchDeleteResult {
    /** The hash that was processed */
    hash: string;
    /** Whether the object was actually deleted from storage */
    deleted: boolean;
    /** Reference count before this operation */
    previousRefCount: number;
    /** Reference count after this operation */
    newRefCount: number;
    /** Error message if the operation failed */
    error?: string;
}
/**
 * Options for garbage collection
 */
export interface GCOptions {
    /**
     * If true, only report what would be deleted without actually deleting.
     * Defaults to false.
     */
    dryRun?: boolean;
    /**
     * Progress callback invoked during scanning
     */
    onProgress?: (progress: GCProgress) => void;
}
/**
 * Progress information for garbage collection
 */
export interface GCProgress {
    /** Number of objects scanned so far */
    scanned: number;
    /** Total number of objects to scan */
    total: number;
    /** Number of objects marked for deletion so far */
    deletedSoFar: number;
    /** Hash of the current object being scanned */
    currentHash: string;
}
/**
 * Result of garbage collection
 */
export interface GCResult {
    /** Total number of objects scanned */
    scanned: number;
    /** Number of objects deleted (or would be deleted in dry run) */
    deletedCount: number;
    /** Total bytes freed (or would be freed in dry run) */
    bytesFreed: number;
    /** Whether this was a dry run */
    dryRun: boolean;
    /** List of hashes that were deleted (or would be deleted) */
    deletedHashes: string[];
}
//# sourceMappingURL=content-addressable-fs.d.ts.map
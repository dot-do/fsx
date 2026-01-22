/**
 * Existence Cache for Content-Addressable Storage
 *
 * Provides a fast in-memory cache for object existence checks.
 * Uses a combination of:
 * - Bloom filter for fast negative lookups (O(1) "definitely not exists")
 * - TTL-based cache for positive results
 * - Cache invalidation hooks for put/delete operations
 *
 * Performance characteristics:
 * - Bloom filter: ~1% false positive rate with 10 hash functions
 * - TTL cache: O(1) lookup for positive results
 * - Memory efficient: ~1.2 bytes per item for bloom filter
 */
/**
 * Configuration options for ExistenceCache
 */
export interface ExistenceCacheOptions {
    /**
     * Time-to-live for positive cache entries in milliseconds.
     * After this time, entries are considered stale and will be re-checked.
     * @default 60000 (1 minute)
     */
    ttl?: number;
    /**
     * Maximum number of entries to store in the positive cache.
     * When exceeded, oldest entries are evicted.
     * @default 10000
     */
    maxEntries?: number;
    /**
     * Expected number of items for bloom filter sizing.
     * Higher values use more memory but reduce false positive rate.
     * @default 100000
     */
    expectedItems?: number;
    /**
     * Target false positive rate for bloom filter.
     * Lower values use more memory but are more accurate.
     * @default 0.01 (1%)
     */
    falsePositiveRate?: number;
}
/**
 * Cache statistics for monitoring
 */
export interface ExistenceCacheStats {
    /** Total cache hits (true positives from cache) */
    hits: number;
    /** Total cache misses (required storage check) */
    misses: number;
    /** Bloom filter rejections (fast negative lookup) */
    bloomRejections: number;
    /** Current entries in positive cache */
    cacheSize: number;
    /** Cache hit ratio */
    hitRatio: number;
    /** Bloom filter false positive rate (estimated) */
    bloomFalsePositiveRate: number;
    /** Number of entries in bloom filter */
    bloomEntries: number;
}
/**
 * Simple Bloom Filter implementation
 *
 * Uses MurmurHash3-inspired hash functions for good distribution.
 * Optimized for object hash lookups where we're checking 40/64 char hex strings.
 */
export declare class BloomFilter {
    private bits;
    private numHashFunctions;
    private numBits;
    private itemCount;
    constructor(expectedItems: number, falsePositiveRate?: number);
    /**
     * Add a hash to the bloom filter
     */
    add(hash: string): void;
    /**
     * Check if a hash might exist in the bloom filter
     *
     * @returns false means "definitely not in set", true means "possibly in set"
     */
    mightContain(hash: string): boolean;
    /**
     * Clear all entries from the bloom filter
     */
    clear(): void;
    /**
     * Get estimated false positive rate based on current item count
     */
    getEstimatedFalsePositiveRate(): number;
    /**
     * Get current item count
     */
    getItemCount(): number;
    /**
     * Get memory usage in bytes
     */
    getMemoryUsage(): number;
    /**
     * Calculate hash positions for the bloom filter
     *
     * Uses double hashing technique: h(i) = h1 + i * h2
     * where h1 and h2 are derived from the input hash
     */
    private getHashPositions;
}
/**
 * Existence Cache for fast object existence checks
 *
 * Combines a bloom filter for fast "definitely not exists" responses
 * with a TTL-based positive cache for "definitely exists" responses.
 */
export declare class ExistenceCache {
    private positiveCache;
    private bloomFilter;
    private options;
    private hits;
    private misses;
    private bloomRejections;
    constructor(options?: ExistenceCacheOptions);
    /**
     * Check the cache for an object's existence
     *
     * @returns `true` if definitely exists, `false` if definitely doesn't exist,
     *          `undefined` if cache can't determine (need to check storage)
     */
    check(hash: string): boolean | undefined;
    /**
     * Record an existence check result
     *
     * Called after checking storage to update the cache.
     */
    record(hash: string, exists: boolean): void;
    /**
     * Invalidate cache entry (called on put/delete)
     */
    invalidate(hash: string): void;
    /**
     * Record that an object was added (for bloom filter and cache)
     */
    recordPut(hash: string): void;
    /**
     * Record that an object was deleted
     */
    recordDelete(hash: string): void;
    /**
     * Clear all cached entries
     *
     * Optionally clears the bloom filter as well (expensive operation).
     */
    clear(clearBloomFilter?: boolean): void;
    /**
     * Get cache statistics
     */
    getStats(): ExistenceCacheStats;
    /**
     * Reset statistics counters
     */
    resetStats(): void;
    /**
     * Evict expired and excess entries
     */
    private evictIfNeeded;
}
/**
 * Create a new existence cache
 */
export declare function createExistenceCache(options?: ExistenceCacheOptions): ExistenceCache;
//# sourceMappingURL=existence-cache.d.ts.map
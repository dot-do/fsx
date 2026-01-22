/**
 * Write Buffer Cache for DO SQLite Cost Optimization
 *
 * LRU cache with dirty tracking for batch checkpointing.
 * This enables columnar storage patterns that achieve 99%+ cost reduction
 * by buffering writes and flushing in batches.
 *
 * @module storage/write-buffer
 */
/**
 * Eviction reason for callbacks
 */
export type EvictionReason = 'count' | 'size' | 'expired' | 'deleted' | 'cleared' | 'checkpoint';
/**
 * Options for the write-buffering LRU cache
 */
export interface WriteBufferCacheOptions<V> {
    /** Maximum number of items (default: 500) */
    maxCount?: number;
    /** Maximum size in bytes (default: 25MB) */
    maxBytes?: number;
    /** Default TTL in milliseconds (default: 0, no expiry) */
    defaultTTL?: number;
    /** Callback when an item is evicted */
    onEvict?: (key: string, value: V, reason: EvictionReason) => void;
    /** Size calculator for values */
    sizeCalculator?: (value: V) => number;
}
/**
 * Cache statistics
 */
export interface CacheStats {
    count: number;
    bytes: number;
    dirtyCount: number;
    hits: number;
    misses: number;
    hitRate: number;
    evictions: number;
    checkpoints: number;
    memoryUsageRatio: number;
}
/**
 * LRU Cache with write buffering for batch checkpoints
 *
 * This cache tracks dirty entries and flushes them in batches to minimize
 * row writes to SQLite.
 *
 * ## Key Features
 *
 * - **LRU Eviction**: Automatically evicts least-recently-used items
 * - **Dirty Tracking**: Tracks which entries have been modified since last checkpoint
 * - **Size Limits**: Enforces both count and byte limits
 * - **TTL Support**: Optional time-to-live for cache entries
 * - **Eviction Callbacks**: Hooks for handling evicted items
 *
 * @example
 * ```typescript
 * const cache = new WriteBufferCache<SessionState>({
 *   maxCount: 500,
 *   maxBytes: 25 * 1024 * 1024, // 25MB
 *   defaultTTL: 3600000, // 1 hour
 *   onEvict: (key, value, reason) => {
 *     console.log(`Evicted ${key}: ${reason}`)
 *   },
 * })
 *
 * // Set a value (marks as dirty by default)
 * cache.set('session-123', sessionState)
 *
 * // Get dirty entries for checkpointing
 * const dirty = cache.getDirtyEntries()
 *
 * // Mark entries as clean after checkpoint
 * cache.markClean(Array.from(dirty.keys()))
 * ```
 */
export declare class WriteBufferCache<V> {
    private cache;
    private dirtyKeys;
    private maxCount;
    private maxBytes;
    private defaultTTL;
    private onEvict?;
    private sizeCalculator;
    private totalBytes;
    private hits;
    private misses;
    private evictions;
    private checkpoints;
    constructor(options?: WriteBufferCacheOptions<V>);
    /**
     * Get a value from the cache
     */
    get(key: string): V | undefined;
    /**
     * Set a value in the cache, marking it as dirty
     */
    set(key: string, value: V, options?: {
        ttl?: number;
        markDirty?: boolean;
    }): void;
    /**
     * Delete a value from the cache
     */
    delete(key: string): boolean;
    /**
     * Check if a key exists in the cache
     */
    has(key: string): boolean;
    /**
     * Get all dirty entries for checkpointing
     */
    getDirtyEntries(): Map<string, V>;
    /**
     * Mark entries as clean after checkpoint
     */
    markClean(keys: string[]): void;
    /**
     * Get the number of dirty entries
     */
    get dirtyCount(): number;
    /**
     * Get cache statistics
     */
    getStats(): CacheStats;
    /**
     * Clear all entries from the cache
     */
    clear(): void;
    /**
     * Iterate over cache entries
     */
    entries(): IterableIterator<[string, V]>;
    private defaultSizeCalculator;
    private evictIfNeeded;
    private evictEntry;
}
//# sourceMappingURL=write-buffer.d.ts.map
/**
 * LRU Cache for Content-Addressable Storage
 *
 * Provides an efficient in-memory cache for frequently accessed git objects.
 * Uses a Least Recently Used (LRU) eviction policy to manage cache size.
 *
 * Features:
 * - Configurable maximum cache size (by entry count or total bytes)
 * - LRU eviction when cache is full
 * - Cache hit/miss statistics
 * - Thread-safe for single-threaded JS environments
 */
import type { GitObject } from './get-object.js';
/**
 * Cache statistics for monitoring cache performance
 */
export interface CacheStats {
    /** Total number of cache hits */
    hits: number;
    /** Total number of cache misses */
    misses: number;
    /** Current number of entries in cache */
    entryCount: number;
    /** Current total bytes stored in cache */
    totalBytes: number;
    /** Maximum entries allowed in cache */
    maxEntries: number;
    /** Maximum bytes allowed in cache */
    maxBytes: number;
    /** Cache hit ratio (hits / total requests) */
    hitRatio: number;
    /** Number of evictions performed */
    evictions: number;
}
/**
 * Configuration options for the LRU cache
 */
export interface LRUCacheOptions {
    /**
     * Maximum number of entries to store in cache.
     * When exceeded, least recently used entries are evicted.
     * @default 1000
     */
    maxEntries?: number;
    /**
     * Maximum total bytes to store in cache.
     * When exceeded, least recently used entries are evicted until under limit.
     * @default 50MB (50 * 1024 * 1024)
     */
    maxBytes?: number;
}
/**
 * LRU Cache implementation for git objects
 *
 * Uses a Map for O(1) access and maintains access order for LRU eviction.
 * The Map's insertion order is leveraged for LRU - we delete and re-insert
 * on access to maintain LRU order.
 */
export declare class LRUCache {
    private cache;
    private maxEntries;
    private maxBytes;
    private currentBytes;
    private hits;
    private misses;
    private evictions;
    constructor(options?: LRUCacheOptions);
    /**
     * Get an object from the cache
     *
     * @param hash - The content hash to look up
     * @returns The cached object or undefined if not in cache
     */
    get(hash: string): GitObject | undefined;
    /**
     * Store an object in the cache
     *
     * @param hash - The content hash
     * @param object - The git object to cache
     */
    set(hash: string, object: GitObject): void;
    /**
     * Check if a hash is in the cache (without affecting LRU order)
     */
    has(hash: string): boolean;
    /**
     * Remove an entry from the cache
     */
    delete(hash: string): boolean;
    /**
     * Clear all entries from the cache
     */
    clear(): void;
    /**
     * Get current cache statistics
     */
    getStats(): CacheStats;
    /**
     * Reset statistics counters
     */
    resetStats(): void;
    /**
     * Get current entry count
     */
    get size(): number;
    /**
     * Get current bytes used
     */
    get bytes(): number;
    /**
     * Evict least recently used entries until we have space
     */
    private evictIfNeeded;
    /**
     * Evict the oldest (least recently used) entry
     */
    private evictOldest;
}
/**
 * Create a new LRU cache with the given options
 */
export declare function createLRUCache(options?: LRUCacheOptions): LRUCache;
//# sourceMappingURL=cache.d.ts.map
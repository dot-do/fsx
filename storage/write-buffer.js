/**
 * Write Buffer Cache for DO SQLite Cost Optimization
 *
 * LRU cache with dirty tracking for batch checkpointing.
 * This enables columnar storage patterns that achieve 99%+ cost reduction
 * by buffering writes and flushing in batches.
 *
 * @module storage/write-buffer
 */
// ============================================================================
// Write-Buffering LRU Cache
// ============================================================================
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
export class WriteBufferCache {
    cache = new Map();
    dirtyKeys = new Set();
    maxCount;
    maxBytes;
    defaultTTL;
    onEvict;
    sizeCalculator;
    // Statistics
    totalBytes = 0;
    hits = 0;
    misses = 0;
    evictions = 0;
    checkpoints = 0;
    constructor(options = {}) {
        this.maxCount = options.maxCount ?? 500;
        this.maxBytes = options.maxBytes ?? 25 * 1024 * 1024; // 25MB default
        this.defaultTTL = options.defaultTTL ?? 0;
        this.onEvict = options.onEvict;
        this.sizeCalculator = options.sizeCalculator ?? this.defaultSizeCalculator;
    }
    /**
     * Get a value from the cache
     */
    get(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            this.misses++;
            return undefined;
        }
        // Check if expired
        if (entry.expiresAt && Date.now() > entry.expiresAt) {
            this.evictEntry(key, entry, 'expired');
            this.misses++;
            return undefined;
        }
        // Update access time and move to end (most recently used)
        entry.accessedAt = Date.now();
        this.cache.delete(key);
        this.cache.set(key, entry);
        this.hits++;
        return entry.value;
    }
    /**
     * Set a value in the cache, marking it as dirty
     */
    set(key, value, options) {
        const markDirty = options?.markDirty ?? true;
        // Remove existing entry if present
        const existing = this.cache.get(key);
        if (existing) {
            this.totalBytes -= existing.size;
            this.cache.delete(key);
        }
        // Calculate size
        const size = this.sizeCalculator(value);
        const ttl = options?.ttl ?? this.defaultTTL;
        const now = Date.now();
        const entry = {
            value,
            size,
            dirty: markDirty,
            expiresAt: ttl > 0 ? now + ttl : undefined,
            accessedAt: now,
        };
        // Add entry
        this.cache.set(key, entry);
        this.totalBytes += size;
        // Track dirty entries
        if (markDirty) {
            this.dirtyKeys.add(key);
        }
        // Evict if necessary
        this.evictIfNeeded();
    }
    /**
     * Delete a value from the cache
     */
    delete(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            return false;
        }
        this.evictEntry(key, entry, 'deleted');
        return true;
    }
    /**
     * Check if a key exists in the cache
     */
    has(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            return false;
        }
        if (entry.expiresAt && Date.now() > entry.expiresAt) {
            this.evictEntry(key, entry, 'expired');
            return false;
        }
        return true;
    }
    /**
     * Get all dirty entries for checkpointing
     */
    getDirtyEntries() {
        const dirtyEntries = new Map();
        for (const key of this.dirtyKeys) {
            const entry = this.cache.get(key);
            if (entry && (!entry.expiresAt || Date.now() <= entry.expiresAt)) {
                dirtyEntries.set(key, entry.value);
            }
        }
        return dirtyEntries;
    }
    /**
     * Mark entries as clean after checkpoint
     */
    markClean(keys) {
        for (const key of keys) {
            const entry = this.cache.get(key);
            if (entry) {
                entry.dirty = false;
            }
            this.dirtyKeys.delete(key);
        }
        this.checkpoints++;
    }
    /**
     * Get the number of dirty entries
     */
    get dirtyCount() {
        return this.dirtyKeys.size;
    }
    /**
     * Get cache statistics
     */
    getStats() {
        const totalRequests = this.hits + this.misses;
        return {
            count: this.cache.size,
            bytes: this.totalBytes,
            dirtyCount: this.dirtyKeys.size,
            hits: this.hits,
            misses: this.misses,
            hitRate: totalRequests > 0 ? this.hits / totalRequests : 0,
            evictions: this.evictions,
            checkpoints: this.checkpoints,
            memoryUsageRatio: this.maxBytes > 0 ? this.totalBytes / this.maxBytes : 0,
        };
    }
    /**
     * Clear all entries from the cache
     */
    clear() {
        if (this.onEvict) {
            for (const [key, entry] of this.cache) {
                this.onEvict(key, entry.value, 'cleared');
            }
        }
        this.cache.clear();
        this.dirtyKeys.clear();
        this.totalBytes = 0;
    }
    /**
     * Iterate over cache entries
     */
    *entries() {
        for (const [key, entry] of this.cache.entries()) {
            if (entry.expiresAt && Date.now() > entry.expiresAt) {
                continue;
            }
            yield [key, entry.value];
        }
    }
    // Private methods
    defaultSizeCalculator(value) {
        if (value === null || value === undefined) {
            return 0;
        }
        try {
            return JSON.stringify(value).length * 2; // UTF-16
        }
        catch {
            return 256; // Default estimate
        }
    }
    evictIfNeeded() {
        // Evict by count
        while (this.cache.size > this.maxCount) {
            const key = this.cache.keys().next().value;
            if (key !== undefined) {
                const entry = this.cache.get(key);
                if (entry) {
                    this.evictEntry(key, entry, 'count');
                }
            }
            else {
                break;
            }
        }
        // Evict by size
        while (this.totalBytes > this.maxBytes && this.cache.size > 0) {
            const key = this.cache.keys().next().value;
            if (key !== undefined) {
                const entry = this.cache.get(key);
                if (entry) {
                    this.evictEntry(key, entry, 'size');
                }
            }
            else {
                break;
            }
        }
    }
    evictEntry(key, entry, reason) {
        this.totalBytes -= entry.size;
        this.cache.delete(key);
        this.dirtyKeys.delete(key);
        this.evictions++;
        if (this.onEvict) {
            this.onEvict(key, entry.value, reason);
        }
    }
}
//# sourceMappingURL=write-buffer.js.map
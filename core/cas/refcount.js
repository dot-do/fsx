/**
 * Reference counting for content-addressable storage
 *
 * Tracks how many references exist to each object by its hash.
 * This enables safe deduplication: objects are only deleted when
 * their reference count drops to zero.
 */
/**
 * Creates a fresh metrics object with all counters at zero
 */
export function createMetrics() {
    return {
        incrementCount: 0,
        decrementCount: 0,
        casCount: 0,
        casFailures: 0,
        contentionCount: 0,
        totalLockWaitTimeMs: 0,
        gcSignalCount: 0,
        batchOperationCount: 0,
    };
}
/**
 * In-memory reference count storage with atomic operations
 *
 * Uses a mutex pattern to ensure atomicity of increment/decrement operations.
 * This prevents race conditions where concurrent operations could cause
 * lost updates or incorrect GC signaling.
 *
 * Features:
 * - Per-hash locking for fine-grained concurrency
 * - Metrics tracking for observability
 * - Batch operations for bulk efficiency
 * - Optimized for single-reference common case
 *
 * Suitable for testing and single-instance use cases.
 * For production, use a persistent storage implementation with database-level atomicity.
 */
export class InMemoryRefCountStorage {
    refCounts = new Map();
    sizes = new Map();
    /**
     * Per-hash mutex locks to ensure atomic operations
     * Maps hash -> queue of pending operations
     */
    locks = new Map();
    /**
     * Operation metrics for observability
     */
    metrics = createMetrics();
    /**
     * Acquire a lock for a hash, execute operation, then release
     * Tracks contention metrics when locks are contested
     */
    async withLock(hash, operation) {
        const normalizedHash = hash.toLowerCase();
        // Check for contention and wait if needed
        const pendingLock = this.locks.get(normalizedHash);
        if (pendingLock) {
            this.metrics.contentionCount++;
            const startWait = performance.now();
            await pendingLock;
            this.metrics.totalLockWaitTimeMs += performance.now() - startWait;
        }
        // Create a new lock and store it
        let releaseLock;
        const newLock = new Promise((resolve) => {
            releaseLock = resolve;
        });
        this.locks.set(normalizedHash, newLock);
        try {
            // Execute the operation synchronously while holding the lock
            return operation();
        }
        finally {
            // Release the lock
            this.locks.delete(normalizedHash);
            releaseLock();
        }
    }
    async getRefCount(hash) {
        return this.refCounts.get(hash.toLowerCase()) ?? 0;
    }
    async setRefCount(hash, count) {
        await this.withLock(hash, () => {
            if (count <= 0) {
                this.refCounts.delete(hash.toLowerCase());
            }
            else {
                this.refCounts.set(hash.toLowerCase(), count);
            }
        });
    }
    async incrementRefCount(hash) {
        this.metrics.incrementCount++;
        return this.withLock(hash, () => {
            const normalizedHash = hash.toLowerCase();
            const current = this.refCounts.get(normalizedHash) ?? 0;
            const newCount = current + 1;
            this.refCounts.set(normalizedHash, newCount);
            return newCount;
        });
    }
    async decrementRefCount(hash) {
        this.metrics.decrementCount++;
        return this.withLock(hash, () => {
            const normalizedHash = hash.toLowerCase();
            const current = this.refCounts.get(normalizedHash) ?? 0;
            const newCount = Math.max(0, current - 1);
            if (newCount === 0) {
                this.refCounts.delete(normalizedHash);
            }
            else {
                this.refCounts.set(normalizedHash, newCount);
            }
            return newCount;
        });
    }
    /**
     * Atomic compare-and-swap operation
     * Only updates if current value equals expected value
     */
    async compareAndSwapRefCount(hash, expected, newValue) {
        this.metrics.casCount++;
        return this.withLock(hash, () => {
            const normalizedHash = hash.toLowerCase();
            const current = this.refCounts.get(normalizedHash) ?? 0;
            if (current !== expected) {
                this.metrics.casFailures++;
                return false;
            }
            if (newValue <= 0) {
                this.refCounts.delete(normalizedHash);
            }
            else {
                this.refCounts.set(normalizedHash, newValue);
            }
            return true;
        });
    }
    /**
     * Decrement with GC signal - atomically decrements and only signals GC
     * if this operation is the one that caused the count to reach zero.
     * Prevents double-deletion race conditions.
     */
    async decrementRefCountWithGCSignal(hash, onGC) {
        this.metrics.decrementCount++;
        return this.withLock(hash, () => {
            const normalizedHash = hash.toLowerCase();
            const current = this.refCounts.get(normalizedHash) ?? 0;
            const newCount = Math.max(0, current - 1);
            if (newCount === 0) {
                this.refCounts.delete(normalizedHash);
                // Only signal GC if we actually decremented from a positive value to 0
                // This prevents GC signal when already at 0
                if (current > 0) {
                    this.metrics.gcSignalCount++;
                    onGC(hash);
                }
            }
            else {
                this.refCounts.set(normalizedHash, newCount);
            }
            return newCount;
        });
    }
    async deleteRefCount(hash) {
        await this.withLock(hash, () => {
            const normalizedHash = hash.toLowerCase();
            this.refCounts.delete(normalizedHash);
            this.sizes.delete(normalizedHash);
        });
    }
    async getAllRefCounts() {
        const result = new Map();
        for (const [hash, refCount] of this.refCounts) {
            const size = this.sizes.get(hash) ?? 0;
            result.set(hash, { refCount, size });
        }
        return result;
    }
    async setSize(hash, size) {
        this.sizes.set(hash.toLowerCase(), size);
    }
    async getSize(hash) {
        return this.sizes.get(hash.toLowerCase()) ?? 0;
    }
    /**
     * Batch increment multiple hashes
     * Processes each hash with its own lock for fine-grained concurrency
     * while still being more efficient than individual calls due to
     * reduced async overhead.
     */
    async batchIncrementRefCount(hashes) {
        this.metrics.batchOperationCount++;
        const results = new Map();
        // Process in parallel - each hash has its own lock
        await Promise.all(hashes.map(async (hash) => {
            const newCount = await this.incrementRefCount(hash);
            results.set(hash.toLowerCase(), newCount);
        }));
        return results;
    }
    /**
     * Batch decrement multiple hashes with optional GC signaling
     * Returns both the new refcounts and a list of hashes that reached zero.
     */
    async batchDecrementRefCount(hashes, onGC) {
        this.metrics.batchOperationCount++;
        const results = new Map();
        const gcHashes = [];
        // Process in parallel with GC tracking
        await Promise.all(hashes.map(async (hash) => {
            let newCount;
            if (onGC) {
                newCount = await this.decrementRefCountWithGCSignal(hash, (h) => {
                    gcHashes.push(h);
                    onGC(h);
                });
            }
            else {
                newCount = await this.decrementRefCount(hash);
            }
            results.set(hash.toLowerCase(), newCount);
        }));
        return { results, gcHashes };
    }
    /**
     * Get current operation metrics
     * Returns a copy to prevent external modification
     */
    getMetrics() {
        return { ...this.metrics };
    }
    /**
     * Reset all metrics to zero
     */
    resetMetrics() {
        this.metrics = createMetrics();
    }
    /**
     * Clear all data (for testing)
     */
    clear() {
        this.refCounts.clear();
        this.sizes.clear();
        this.locks.clear();
        this.metrics = createMetrics();
    }
}
/**
 * Calculate deduplication statistics from refcount data
 */
export function calculateStats(refCounts) {
    let totalObjects = 0;
    let totalReferences = 0;
    let deduplicatedBytes = 0;
    for (const { refCount, size } of refCounts.values()) {
        totalObjects++;
        totalReferences += refCount;
        // Bytes saved = (refCount - 1) * size (we only stored one copy)
        if (refCount > 1) {
            deduplicatedBytes += (refCount - 1) * size;
        }
    }
    const averageRefCount = totalObjects > 0 ? totalReferences / totalObjects : 0;
    return {
        totalObjects,
        totalReferences,
        deduplicatedBytes,
        averageRefCount,
    };
}
//# sourceMappingURL=refcount.js.map
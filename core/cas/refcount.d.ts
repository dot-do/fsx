/**
 * Reference counting for content-addressable storage
 *
 * Tracks how many references exist to each object by its hash.
 * This enables safe deduplication: objects are only deleted when
 * their reference count drops to zero.
 */
/**
 * Callback invoked when refcount reaches zero and GC may be needed
 */
export type GCSignalCallback = (hash: string) => void;
/**
 * Metrics for refcount operations
 */
export interface RefCountMetrics {
    /** Total increment operations */
    incrementCount: number;
    /** Total decrement operations */
    decrementCount: number;
    /** Total CAS operations */
    casCount: number;
    /** CAS operations that failed (expected value mismatch) */
    casFailures: number;
    /** Times a lock had contention (another operation was waiting) */
    contentionCount: number;
    /** Total time spent waiting for locks (ms) */
    totalLockWaitTimeMs: number;
    /** Number of GC signals emitted */
    gcSignalCount: number;
    /** Number of batch operations */
    batchOperationCount: number;
}
/**
 * Creates a fresh metrics object with all counters at zero
 */
export declare function createMetrics(): RefCountMetrics;
/**
 * Storage interface for reference counts
 *
 * Reference counts are stored separately from objects to allow
 * for efficient querying and updating without touching object data.
 */
export interface RefCountStorage {
    /**
     * Get the reference count for a hash
     * @returns The current reference count, or 0 if not tracked
     */
    getRefCount(hash: string): Promise<number>;
    /**
     * Set the reference count for a hash
     */
    setRefCount(hash: string, count: number): Promise<void>;
    /**
     * Increment the reference count by 1
     * @returns The new reference count
     */
    incrementRefCount(hash: string): Promise<number>;
    /**
     * Decrement the reference count by 1, but not below 0
     * @returns The new reference count
     */
    decrementRefCount(hash: string): Promise<number>;
    /**
     * Atomic compare-and-swap for reference count
     * Only updates if current value equals expected value
     * @returns true if swap succeeded, false if expected value didn't match
     */
    compareAndSwapRefCount(hash: string, expected: number, newValue: number): Promise<boolean>;
    /**
     * Decrement with GC signal - atomically decrements and signals GC
     * if refcount reaches zero. The callback is only invoked if this
     * operation is the one that caused the count to reach zero.
     * @returns The new reference count
     */
    decrementRefCountWithGCSignal(hash: string, onGC: GCSignalCallback): Promise<number>;
    /**
     * Delete the refcount entry for a hash
     */
    deleteRefCount(hash: string): Promise<void>;
    /**
     * Get all refcount entries for statistics
     * @returns Map of hash to { refCount, size }
     */
    getAllRefCounts(): Promise<Map<string, {
        refCount: number;
        size: number;
    }>>;
    /**
     * Set size for a hash (called when object is first stored)
     */
    setSize(hash: string, size: number): Promise<void>;
    /**
     * Get size for a hash
     */
    getSize(hash: string): Promise<number>;
    /**
     * Batch increment multiple hashes atomically
     * More efficient than individual increments for bulk operations
     * @returns Map of hash to new refcount
     */
    batchIncrementRefCount(hashes: string[]): Promise<Map<string, number>>;
    /**
     * Batch decrement multiple hashes atomically
     * @returns Map of hash to new refcount and hashes that reached zero
     */
    batchDecrementRefCount(hashes: string[], onGC?: GCSignalCallback): Promise<{
        results: Map<string, number>;
        gcHashes: string[];
    }>;
    /**
     * Get current operation metrics
     */
    getMetrics(): RefCountMetrics;
    /**
     * Reset metrics to zero
     */
    resetMetrics(): void;
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
export declare class InMemoryRefCountStorage implements RefCountStorage {
    private refCounts;
    private sizes;
    /**
     * Per-hash mutex locks to ensure atomic operations
     * Maps hash -> queue of pending operations
     */
    private locks;
    /**
     * Operation metrics for observability
     */
    private metrics;
    /**
     * Acquire a lock for a hash, execute operation, then release
     * Tracks contention metrics when locks are contested
     */
    private withLock;
    getRefCount(hash: string): Promise<number>;
    setRefCount(hash: string, count: number): Promise<void>;
    incrementRefCount(hash: string): Promise<number>;
    decrementRefCount(hash: string): Promise<number>;
    /**
     * Atomic compare-and-swap operation
     * Only updates if current value equals expected value
     */
    compareAndSwapRefCount(hash: string, expected: number, newValue: number): Promise<boolean>;
    /**
     * Decrement with GC signal - atomically decrements and only signals GC
     * if this operation is the one that caused the count to reach zero.
     * Prevents double-deletion race conditions.
     */
    decrementRefCountWithGCSignal(hash: string, onGC: GCSignalCallback): Promise<number>;
    deleteRefCount(hash: string): Promise<void>;
    getAllRefCounts(): Promise<Map<string, {
        refCount: number;
        size: number;
    }>>;
    setSize(hash: string, size: number): Promise<void>;
    getSize(hash: string): Promise<number>;
    /**
     * Batch increment multiple hashes
     * Processes each hash with its own lock for fine-grained concurrency
     * while still being more efficient than individual calls due to
     * reduced async overhead.
     */
    batchIncrementRefCount(hashes: string[]): Promise<Map<string, number>>;
    /**
     * Batch decrement multiple hashes with optional GC signaling
     * Returns both the new refcounts and a list of hashes that reached zero.
     */
    batchDecrementRefCount(hashes: string[], onGC?: GCSignalCallback): Promise<{
        results: Map<string, number>;
        gcHashes: string[];
    }>;
    /**
     * Get current operation metrics
     * Returns a copy to prevent external modification
     */
    getMetrics(): RefCountMetrics;
    /**
     * Reset all metrics to zero
     */
    resetMetrics(): void;
    /**
     * Clear all data (for testing)
     */
    clear(): void;
}
/**
 * Deduplication statistics
 */
export interface DeduplicationStats {
    /** Number of unique objects stored */
    totalObjects: number;
    /** Total number of references (including duplicates) */
    totalReferences: number;
    /** Bytes saved by deduplication */
    deduplicatedBytes: number;
    /** Average references per object */
    averageRefCount: number;
}
/**
 * Calculate deduplication statistics from refcount data
 */
export declare function calculateStats(refCounts: Map<string, {
    refCount: number;
    size: number;
}>): DeduplicationStats;
//# sourceMappingURL=refcount.d.ts.map
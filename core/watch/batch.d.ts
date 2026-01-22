/**
 * BatchEmitter - Batch event emission with reduced callback overhead
 *
 * This module provides a BatchEmitter class that collects multiple events
 * and emits them in batches, reducing the overhead of individual callbacks
 * for WebSocket-based watch notifications.
 *
 * Key features:
 * - Configurable batch window (default: 10ms)
 * - Event priority ordering (delete > create > modify)
 * - Event deduplication within batch window
 * - Throughput metrics tracking
 * - Memory-efficient batch assembly
 *
 * @module core/watch/batch
 */
import type { WatchEvent, WatchEventType } from './events.js';
/**
 * Priority values for event types.
 * Higher priority events are emitted first in batched notifications.
 * Delete events have highest priority because they represent final state.
 */
export declare const EVENT_PRIORITY: Record<WatchEventType, number>;
/**
 * Configuration options for BatchEmitter.
 */
export interface BatchEmitterOptions {
    /**
     * Time window in milliseconds for collecting events before emission.
     * Events occurring within this window are batched together.
     * @default 10
     */
    batchWindowMs?: number;
    /**
     * Maximum number of events in a single batch.
     * When reached, batch is emitted immediately.
     * @default 100
     */
    maxBatchSize?: number;
    /**
     * Whether to enable event compression for large batches.
     * When enabled, sequential events to the same path are coalesced.
     * @default true
     */
    compressEvents?: boolean;
    /**
     * Whether to sort events by priority before emission.
     * @default true
     */
    prioritizeEvents?: boolean;
    /**
     * Whether to track throughput metrics.
     * @default false
     */
    enableMetrics?: boolean;
}
/**
 * Throughput metrics for batch emission.
 */
export interface BatchMetrics {
    /** Total number of events received */
    eventsReceived: number;
    /** Total number of events emitted (after coalescing) */
    eventsEmitted: number;
    /** Total number of batches emitted */
    batchesEmitted: number;
    /** Average batch size */
    averageBatchSize: number;
    /** Average latency from event receipt to emission (ms) */
    averageLatencyMs: number;
    /** Compression ratio (eventsReceived / eventsEmitted) */
    compressionRatio: number;
    /** Events per second throughput */
    eventsPerSecond: number;
}
/**
 * Callback type for batch event emission.
 */
export type BatchCallback = (events: WatchEvent[]) => void;
/**
 * BatchEmitter - Collects and emits events in batches.
 *
 * This class reduces callback overhead by collecting multiple events
 * and emitting them together. It's optimized for WebSocket-based
 * watch notifications where batching can significantly reduce
 * message overhead and improve throughput.
 *
 * @example
 * ```typescript
 * const emitter = new BatchEmitter({
 *   batchWindowMs: 10,
 *   maxBatchSize: 50,
 * })
 *
 * // Register batch callback
 * emitter.onBatch((events) => {
 *   ws.send(JSON.stringify({ type: 'batch', events }))
 * })
 *
 * // Queue events (will be batched)
 * emitter.queue('create', '/path/file1.txt')
 * emitter.queue('modify', '/path/file2.txt')
 * emitter.queue('delete', '/path/file3.txt')
 *
 * // Events emitted in single batch after 10ms
 * ```
 */
export declare class BatchEmitter {
    private readonly batchWindowMs;
    private readonly maxBatchSize;
    private readonly compressEvents;
    private readonly prioritizeEvents;
    private readonly enableMetrics;
    private pendingEvents;
    private batchTimer;
    private callbacks;
    private _eventsReceived;
    private _eventsEmitted;
    private _batchesEmitted;
    private _totalLatencyMs;
    private _metricsStartTime;
    /**
     * Create a new BatchEmitter.
     *
     * @param options - Configuration options
     */
    constructor(options?: BatchEmitterOptions);
    /**
     * Register a callback to receive batched events.
     *
     * @param callback - Function to call with batched events
     * @returns Unsubscribe function
     */
    onBatch(callback: BatchCallback): () => void;
    /**
     * Queue an event for batch emission.
     *
     * Events are collected and emitted together after the batch window
     * expires or when the max batch size is reached.
     *
     * @param type - Event type
     * @param path - File path
     * @param oldPath - For rename events, the original path
     * @param metadata - Optional event metadata
     */
    queue(type: WatchEventType, path: string, oldPath?: string, metadata?: {
        size?: number;
        mtime?: number;
        isDirectory?: boolean;
    }): void;
    /**
     * Immediately flush all pending events.
     *
     * Useful for cleanup or when immediate emission is required.
     */
    flush(): void;
    /**
     * Get current metrics.
     *
     * @returns Throughput metrics object
     */
    getMetrics(): BatchMetrics;
    /**
     * Reset metrics to initial state.
     */
    resetMetrics(): void;
    /**
     * Get the number of pending events.
     *
     * @returns Number of events waiting to be emitted
     */
    getPendingCount(): number;
    /**
     * Get the batch window in milliseconds.
     *
     * @returns Batch window duration
     */
    getBatchWindow(): number;
    /**
     * Get the max batch size.
     *
     * @returns Maximum events per batch
     */
    getMaxBatchSize(): number;
    /**
     * Clean up resources.
     *
     * Clears pending events and timers without emitting.
     */
    dispose(): void;
    /**
     * Sort events by priority (delete > rename > create > modify).
     */
    private sortByPriority;
    /**
     * Apply smart coalescing to determine final event type.
     *
     * Rules:
     * - create + modify = create (file was created, modifications don't matter)
     * - modify + delete = delete (file was deleted, prior state doesn't matter)
     * - delete always wins (represents final state)
     */
    private coalesceTypes;
}
/**
 * Create a batch emitter with default configuration.
 *
 * @param options - Optional configuration overrides
 * @returns Configured BatchEmitter instance
 */
export declare function createBatchEmitter(options?: BatchEmitterOptions): BatchEmitter;
//# sourceMappingURL=batch.d.ts.map
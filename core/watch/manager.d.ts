/**
 * WatchManager - File watching with per-path debounce support
 *
 * This module provides a WatchManager class that handles file system event
 * notifications with intelligent debouncing. It coalesces rapid changes to
 * the same path into single events, reducing noise from frequent file operations.
 *
 * Key features:
 * - Per-path debounce tracking
 * - Configurable debounce delay
 * - Smart event coalescing (create + modify = create, modify + delete = delete)
 * - Timer cleanup on watcher removal
 */
/** Event types emitted by file watchers */
export type WatchEventType = 'change' | 'rename';
/** Callback signature for watch event listeners */
export type WatchListener = (eventType: WatchEventType, filename: string) => void;
/** Debounce mode - when events are emitted relative to the debounce window */
export type DebounceMode = 'leading' | 'trailing' | 'both';
/**
 * Internal representation of a registered watcher.
 */
export interface WatchEntry {
    /** Unique identifier for the watcher */
    id: number;
    /** Path being watched (normalized) */
    path: string;
    /** Whether to watch subdirectories recursively */
    recursive: boolean;
    /** Callback to invoke on file system events */
    listener: WatchListener;
    /** Whether the watcher has been closed */
    closed: boolean;
    /** AbortController for cancellation support */
    abortController: AbortController;
}
/**
 * Manages file watchers for a single FSx instance with debouncing support.
 *
 * Optimized for handling many concurrent watchers by using:
 * - Path prefix indexing for O(log n) lookup of potentially matching watchers
 * - Per-path debouncing to coalesce rapid events
 * - Proper cancellation support via AbortController
 *
 * Since FSx runs in a Durable Object environment without native fs.watch,
 * this class implements watching by hooking into FSx operations directly.
 * When a file operation occurs, the WatchManager debounces and then emits
 * events to all registered watchers that match the affected path.
 *
 * @example
 * ```typescript
 * const manager = new WatchManager()
 * const entry = manager.addWatcher('/home/user', true, (event, filename) => {
 *   console.log(`${event}: ${filename}`)
 * })
 *
 * // Emit events (will be debounced)
 * manager.emit('change', '/home/user/file.txt')
 * manager.emit('change', '/home/user/file.txt')
 *
 * // Later, remove the watcher
 * manager.removeWatcher(entry)
 * ```
 */
export declare class WatchManager {
    /** Counter for generating unique watcher IDs */
    private nextId;
    /** All registered watchers indexed by ID for fast removal */
    private watchersById;
    /**
     * Index of watchers by their normalized path.
     * Multiple watchers can watch the same path.
     */
    private watchersByPath;
    /**
     * Pending events waiting to be emitted after debounce delay.
     * Key is the affected path.
     */
    private pendingEvents;
    /**
     * Debounce delay in milliseconds.
     * Default is 50ms which balances responsiveness with coalescing.
     */
    private debounceDelay;
    /**
     * Per-path debounce delay overrides.
     * Key is the path pattern (can be glob), value is delay in ms.
     */
    private pathDebounceDelays;
    /**
     * Debounce mode - leading, trailing, or both.
     * Default is 'trailing' (emit after debounce period ends).
     */
    private debounceMode;
    /**
     * Max wait time in milliseconds.
     * If set, forces event emission even if debounce keeps resetting.
     */
    private maxWait;
    /**
     * Per-path max wait time overrides.
     */
    private pathMaxWaits;
    /**
     * Whether smart coalescing is enabled.
     * Default is true (create + modify = create, modify + delete = delete).
     */
    private smartCoalescing;
    /**
     * Register a new file system watcher.
     *
     * @param path - The path to watch (file or directory)
     * @param recursive - Whether to watch subdirectories recursively
     * @param listener - Callback function to invoke on events
     * @returns The watch entry for later removal
     */
    addWatcher(path: string, recursive: boolean, listener: WatchListener): WatchEntry;
    /**
     * Remove a watcher and clean up its resources.
     *
     * @param entry - The watch entry to remove
     */
    removeWatcher(entry: WatchEntry): void;
    /**
     * Clean up pending events when a watcher is removed.
     * If no watchers remain for a pending event's path, clear both timers.
     */
    private cleanupPendingEventsForClosedWatcher;
    /**
     * Check if a watcher would match a given path.
     */
    private wouldMatch;
    /**
     * Get the AbortSignal for a watcher, useful for cancellation.
     *
     * @param entry - The watch entry
     * @returns The AbortSignal that will be triggered when the watcher is closed
     */
    getAbortSignal(entry: WatchEntry): AbortSignal;
    /**
     * Get the total number of active watchers.
     *
     * @returns Number of registered watchers
     */
    get watcherCount(): number;
    /**
     * Set the debounce delay for coalescing rapid events.
     *
     * @param ms - Delay in milliseconds (0 for immediate emission)
     */
    setDebounceDelay(ms: number): void;
    /**
     * Get the current debounce delay.
     *
     * @returns Delay in milliseconds
     */
    getDebounceDelay(): number;
    /**
     * Set a debounce delay for a specific path pattern.
     * The pattern can be a literal path or a glob pattern (e.g., '*.log').
     *
     * @param pathPattern - Path or glob pattern to configure
     * @param ms - Delay in milliseconds
     */
    setPathDebounceDelay(pathPattern: string, ms: number): void;
    /**
     * Get the debounce delay for a specific path.
     * Checks path-specific configurations first, falls back to global.
     *
     * @param path - The path to check
     * @returns Delay in milliseconds
     */
    getPathDebounceDelay(path: string): number;
    /**
     * Clear a path-specific debounce delay configuration.
     *
     * @param pathPattern - The path pattern to clear
     */
    clearPathDebounceDelay(pathPattern: string): void;
    /**
     * Set the debounce mode (leading, trailing, or both).
     *
     * @param mode - The debounce mode to use
     */
    setDebounceMode(mode: DebounceMode): void;
    /**
     * Get the current debounce mode.
     *
     * @returns The current debounce mode
     */
    getDebounceMode(): DebounceMode;
    /**
     * Set the maximum wait time before forcing event emission.
     * Even if debounce keeps resetting, events will be emitted after this time.
     *
     * @param ms - Max wait in milliseconds, or undefined to disable
     */
    setMaxWait(ms: number | undefined): void;
    /**
     * Get the current max wait time.
     *
     * @returns Max wait in milliseconds, or undefined if disabled
     */
    getMaxWait(): number | undefined;
    /**
     * Set a max wait time for a specific path.
     *
     * @param pathPattern - Path or pattern to configure
     * @param ms - Max wait in milliseconds
     */
    setPathMaxWait(pathPattern: string, ms: number): void;
    /**
     * Get the max wait time for a specific path.
     *
     * @param path - The path to check
     * @returns Max wait in milliseconds, or undefined if not set
     */
    getPathMaxWait(path: string): number | undefined;
    /**
     * Enable or disable smart coalescing.
     * When enabled: create + modify = create, modify + delete = delete
     *
     * @param enabled - Whether to enable smart coalescing
     */
    setSmartCoalescing(enabled: boolean): void;
    /**
     * Check if smart coalescing is enabled.
     *
     * @returns True if smart coalescing is enabled
     */
    isSmartCoalescing(): boolean;
    /**
     * Get the number of pending events waiting to be emitted.
     *
     * @returns Number of pending events
     */
    getPendingCount(): number;
    /**
     * Immediately flush all pending events without waiting for debounce timers.
     * Useful for testing or forced cleanup.
     */
    flushPending(): void;
    /**
     * Emit a file system event to all matching watchers.
     * Events are debounced per-path to coalesce rapid changes.
     *
     * @param eventType - 'change' for content modifications, 'rename' for create/delete/rename
     * @param affectedPath - The full normalized path that was affected
     */
    emit(eventType: WatchEventType, affectedPath: string): void;
    /**
     * Apply smart coalescing rules to determine the final event type.
     *
     * Rules:
     * - 'rename' (create) + 'change' (modify) = 'rename' (file was created, subsequent modifies don't matter)
     * - 'change' (modify) + 'rename' (delete) = 'rename' (file was deleted, ignore prior modifications)
     * - Same types = keep the type
     */
    private coalesceEventTypes;
    /**
     * Schedule an emit to happen after the debounce delay.
     */
    private scheduleEmit;
    /**
     * Immediately emit an event to all matching watchers without debouncing.
     */
    private emitNow;
    /**
     * Find all watchers that match a given path.
     */
    private findMatchingWatchers;
    /**
     * Normalize a path by removing trailing slashes (except for root).
     */
    private normalizePath;
    /**
     * Get the parent directory path.
     */
    private getParentPath;
    /**
     * Get the basename (final component) of a path.
     */
    private getBasename;
    /**
     * Get the relative path from a base to a target.
     */
    private getRelativePath;
    /**
     * Check if a path matches a glob pattern.
     * Supports simple glob patterns like *.log, /path/*, etc.
     */
    private matchesGlobPattern;
}
//# sourceMappingURL=manager.d.ts.map
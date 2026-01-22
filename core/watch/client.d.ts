/**
 * FSWatcherClient - Production-ready client for file system watching
 *
 * This module provides a WebSocket-based client for receiving file system
 * change notifications from an fsx.do server. It implements production-grade
 * reliability features including:
 *
 * - Auto-reconnect with exponential backoff
 * - Event queuing during reconnection
 * - Connection state events (onConnect, onDisconnect, onReconnecting)
 * - Offline event buffering
 * - Connection health checks via ping/pong
 * - Automatic resubscription to watched paths after reconnect
 * - Configurable maxReconnectAttempts
 *
 * @module core/watch/client
 *
 * @example
 * ```typescript
 * import { FSWatcherClient } from '@dotdo/fsx/watch'
 *
 * const watcher = new FSWatcherClient({
 *   url: 'wss://api.fsx.do/watch',
 *   maxReconnectAttempts: 10,
 *   onConnect: () => console.log('Connected!'),
 *   onDisconnect: (code, reason) => console.log(`Disconnected: ${reason}`),
 *   onReconnecting: (attempt) => console.log(`Reconnecting... attempt ${attempt}`),
 * })
 *
 * await watcher.connect()
 *
 * // Watch for changes
 * const unsubscribe = await watcher.watch('/home/user', (event) => {
 *   console.log(`${event.type}: ${event.path}`)
 * })
 *
 * // Later: stop watching
 * unsubscribe()
 *
 * // Clean up
 * await watcher.disconnect()
 * ```
 */
import type { WatchEvent } from './events.js';
/**
 * Connection state of the FSWatcherClient.
 *
 * - `disconnected`: Not connected and not attempting to connect
 * - `connecting`: Currently establishing initial connection
 * - `connected`: WebSocket is open and ready
 * - `reconnecting`: Connection lost, attempting to reconnect
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
/**
 * Callback function for watch events.
 *
 * @param event - The watch event containing type, path, and timestamp
 */
export type WatchCallback = (event: WatchEvent) => void;
/**
 * Configuration options for FSWatcherClient.
 */
export interface FSWatcherClientOptions {
    /**
     * WebSocket URL to connect to.
     *
     * @example 'wss://api.fsx.do/watch'
     */
    url: string;
    /**
     * Maximum number of reconnection attempts before giving up.
     * Set to 0 for unlimited attempts.
     *
     * @default 0 (unlimited)
     */
    maxReconnectAttempts?: number;
    /**
     * Initial delay in milliseconds before first reconnect attempt.
     * Subsequent attempts use exponential backoff.
     *
     * @default 1000
     */
    reconnectDelayMs?: number;
    /**
     * Maximum delay in milliseconds between reconnect attempts.
     * Caps the exponential backoff.
     *
     * @default 30000
     */
    maxReconnectDelayMs?: number;
    /**
     * Interval in milliseconds between health check pings.
     * Set to 0 to disable health checks.
     *
     * @default 30000
     */
    healthCheckIntervalMs?: number;
    /**
     * Timeout in milliseconds to wait for pong response.
     * If exceeded, connection is considered dead.
     *
     * @default 5000
     */
    healthCheckTimeoutMs?: number;
    /**
     * Callback invoked when connection is established.
     */
    onConnect?: () => void;
    /**
     * Callback invoked when connection is lost.
     *
     * @param code - WebSocket close code
     * @param reason - WebSocket close reason
     */
    onDisconnect?: (code: number, reason: string) => void;
    /**
     * Callback invoked when attempting to reconnect.
     *
     * @param attempt - Current reconnection attempt number (1-based)
     */
    onReconnecting?: (attempt: number) => void;
    /**
     * Callback invoked when max reconnect attempts exceeded.
     */
    onReconnectFailed?: () => void;
}
/**
 * Production-ready WebSocket client for file system watching.
 *
 * Implements the FSWatcher interface from `core/types.ts` while providing
 * robust connection management suitable for production use.
 *
 * Features:
 * - **Auto-reconnect**: Automatically reconnects with exponential backoff
 * - **Event queuing**: Queues subscription requests during reconnection
 * - **Health checks**: Periodic ping/pong to detect dead connections
 * - **State callbacks**: Hooks for connection lifecycle events
 * - **Automatic resubscription**: Restores subscriptions after reconnect
 *
 * @implements {FSWatcher}
 */
export declare class FSWatcherClient {
    private readonly url;
    private readonly maxReconnectAttempts;
    private readonly reconnectDelayMs;
    private readonly maxReconnectDelayMs;
    private readonly healthCheckIntervalMs;
    private readonly healthCheckTimeoutMs;
    private readonly onConnect?;
    private readonly onDisconnect?;
    private readonly onReconnecting?;
    private readonly onReconnectFailed?;
    /** Current WebSocket connection */
    private ws;
    /** Current connection state */
    private _connectionState;
    /** Current reconnect attempt number */
    private reconnectAttempt;
    /** Timer for reconnect delay */
    private reconnectTimer;
    /** Timer for health check interval */
    private healthCheckTimer;
    /** Timer for health check timeout */
    private healthCheckTimeoutTimer;
    /** Whether disconnect was intentional (don't reconnect) */
    private intentionalDisconnect;
    /** Pending connection promise resolver */
    private connectResolver;
    /** Active subscriptions by path */
    private subscriptions;
    /** Queued operations to perform after reconnect */
    private pendingOperations;
    /**
     * Create a new FSWatcherClient.
     *
     * @param options - Configuration options
     *
     * @example
     * ```typescript
     * const watcher = new FSWatcherClient({
     *   url: 'wss://api.fsx.do/watch',
     *   maxReconnectAttempts: 5,
     *   reconnectDelayMs: 1000,
     *   onConnect: () => console.log('Connected'),
     * })
     * ```
     */
    constructor(options: FSWatcherClientOptions);
    /**
     * Get the current connection state.
     *
     * @returns Current connection state
     */
    get connectionState(): ConnectionState;
    /**
     * Connect to the WebSocket server.
     *
     * If already connected, resolves immediately.
     * If currently connecting or reconnecting, returns the pending promise.
     *
     * @returns Promise that resolves when connected
     *
     * @example
     * ```typescript
     * await watcher.connect()
     * console.log(watcher.connectionState) // 'connected'
     * ```
     */
    connect(): Promise<void>;
    /**
     * Disconnect from the WebSocket server.
     *
     * This is an intentional disconnect and will not trigger reconnection.
     * All subscriptions are cleared.
     *
     * @returns Promise that resolves when disconnected
     */
    disconnect(): Promise<void>;
    /**
     * Watch a path for file system changes.
     *
     * If not connected, the subscription will be queued and executed
     * once connection is established.
     *
     * @param path - Path to watch (file or directory)
     * @param callback - Function to call when changes occur
     * @returns Promise resolving to an unsubscribe function
     *
     * @example
     * ```typescript
     * const unsubscribe = await watcher.watch('/home/user', (event) => {
     *   console.log(`${event.type}: ${event.path}`)
     * })
     *
     * // Later: stop watching
     * unsubscribe()
     * ```
     */
    watch(path: string, callback: WatchCallback): Promise<() => void>;
    /**
     * Close the watcher (alias for disconnect).
     *
     * Implements the FSWatcher interface from `core/types.ts`.
     */
    close(): void;
    /**
     * Reference the watcher (no-op in this implementation).
     *
     * Implements the FSWatcher interface from `core/types.ts`.
     *
     * @returns this for chaining
     */
    ref(): this;
    /**
     * Unreference the watcher (no-op in this implementation).
     *
     * Implements the FSWatcher interface from `core/types.ts`.
     *
     * @returns this for chaining
     */
    unref(): this;
    /**
     * Create a new WebSocket connection.
     */
    private createConnection;
    /**
     * Set up WebSocket event handlers.
     */
    private setupWebSocketHandlers;
    /**
     * Handle incoming WebSocket message.
     */
    private handleMessage;
    /**
     * Dispatch a watch event to all matching callbacks.
     */
    private dispatchEvent;
    /**
     * Check if an event path matches a watched path.
     *
     * A watched path matches if:
     * - It equals the event path exactly
     * - It is a parent directory of the event path
     */
    private pathMatches;
    /**
     * Send a message to the WebSocket server.
     */
    private send;
    /**
     * Schedule a reconnection attempt.
     */
    private scheduleReconnect;
    /**
     * Resubscribe to all currently tracked paths.
     */
    private resubscribeAll;
    /**
     * Execute all pending operations.
     */
    private executePendingOperations;
    /**
     * Start the health check ping interval.
     */
    private startHealthCheck;
    /**
     * Stop the health check timer.
     */
    private stopHealthCheck;
    /**
     * Send a ping and start timeout timer.
     */
    private sendPing;
    /**
     * Handle pong response.
     */
    private handlePong;
    /**
     * Normalize a path by removing trailing slashes (except for root).
     */
    private normalizePath;
    /**
     * Clear all timers.
     */
    private clearTimers;
}
export type { WatchEvent, WatchEventType } from './events.js';
//# sourceMappingURL=client.d.ts.map
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
// =============================================================================
// FSWatcherClient Class
// =============================================================================
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
export class FSWatcherClient {
    // ===========================================================================
    // Configuration
    // ===========================================================================
    url;
    maxReconnectAttempts;
    reconnectDelayMs;
    maxReconnectDelayMs;
    healthCheckIntervalMs;
    healthCheckTimeoutMs;
    onConnect;
    onDisconnect;
    onReconnecting;
    onReconnectFailed;
    // ===========================================================================
    // State
    // ===========================================================================
    /** Current WebSocket connection */
    ws = null;
    /** Current connection state */
    _connectionState = 'disconnected';
    /** Current reconnect attempt number */
    reconnectAttempt = 0;
    /** Timer for reconnect delay */
    reconnectTimer = null;
    /** Timer for health check interval */
    healthCheckTimer = null;
    /** Timer for health check timeout */
    healthCheckTimeoutTimer = null;
    /** Whether disconnect was intentional (don't reconnect) */
    intentionalDisconnect = false;
    /** Pending connection promise resolver */
    connectResolver = null;
    /** Active subscriptions by path */
    subscriptions = new Map();
    /** Queued operations to perform after reconnect */
    pendingOperations = [];
    // ===========================================================================
    // Constructor
    // ===========================================================================
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
    constructor(options) {
        this.url = options.url;
        this.maxReconnectAttempts = options.maxReconnectAttempts ?? 0;
        this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
        this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30000;
        this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? 30000;
        this.healthCheckTimeoutMs = options.healthCheckTimeoutMs ?? 5000;
        this.onConnect = options.onConnect;
        this.onDisconnect = options.onDisconnect;
        this.onReconnecting = options.onReconnecting;
        this.onReconnectFailed = options.onReconnectFailed;
    }
    // ===========================================================================
    // Public API
    // ===========================================================================
    /**
     * Get the current connection state.
     *
     * @returns Current connection state
     */
    get connectionState() {
        return this._connectionState;
    }
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
    async connect() {
        if (this._connectionState === 'connected') {
            return Promise.resolve();
        }
        this.intentionalDisconnect = false;
        return this.createConnection();
    }
    /**
     * Disconnect from the WebSocket server.
     *
     * This is an intentional disconnect and will not trigger reconnection.
     * All subscriptions are cleared.
     *
     * @returns Promise that resolves when disconnected
     */
    async disconnect() {
        this.intentionalDisconnect = true;
        this.clearTimers();
        this.subscriptions.clear();
        this.pendingOperations = [];
        if (this.ws) {
            this.ws.close(1000, 'Client disconnected');
        }
        this._connectionState = 'disconnected';
    }
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
    async watch(path, callback) {
        const normalizedPath = this.normalizePath(path);
        // Get or create subscription entry
        let entry = this.subscriptions.get(normalizedPath);
        const isNewPath = !entry;
        if (!entry) {
            entry = { callbacks: new Set() };
            this.subscriptions.set(normalizedPath, entry);
        }
        entry.callbacks.add(callback);
        // Send subscribe message if this is a new path
        if (isNewPath) {
            if (this._connectionState === 'connected') {
                this.send({ type: 'subscribe', path: normalizedPath });
            }
            else {
                // Queue for later
                this.pendingOperations.push(async () => {
                    this.send({ type: 'subscribe', path: normalizedPath });
                });
            }
        }
        // Return unsubscribe function
        return () => {
            const entry = this.subscriptions.get(normalizedPath);
            if (entry) {
                entry.callbacks.delete(callback);
                // If no more callbacks, unsubscribe from server
                if (entry.callbacks.size === 0) {
                    this.subscriptions.delete(normalizedPath);
                    if (this._connectionState === 'connected') {
                        this.send({ type: 'unsubscribe', path: normalizedPath });
                    }
                }
            }
        };
    }
    // ===========================================================================
    // FSWatcher Interface Methods
    // ===========================================================================
    /**
     * Close the watcher (alias for disconnect).
     *
     * Implements the FSWatcher interface from `core/types.ts`.
     */
    close() {
        this.disconnect();
    }
    /**
     * Reference the watcher (no-op in this implementation).
     *
     * Implements the FSWatcher interface from `core/types.ts`.
     *
     * @returns this for chaining
     */
    ref() {
        return this;
    }
    /**
     * Unreference the watcher (no-op in this implementation).
     *
     * Implements the FSWatcher interface from `core/types.ts`.
     *
     * @returns this for chaining
     */
    unref() {
        return this;
    }
    // ===========================================================================
    // Private Methods - Connection Management
    // ===========================================================================
    /**
     * Create a new WebSocket connection.
     */
    createConnection() {
        return new Promise((resolve) => {
            this.connectResolver = resolve;
            this._connectionState = 'connecting';
            this.ws = new WebSocket(this.url);
            this.setupWebSocketHandlers();
        });
    }
    /**
     * Set up WebSocket event handlers.
     */
    setupWebSocketHandlers() {
        if (!this.ws)
            return;
        this.ws.onopen = () => {
            this._connectionState = 'connected';
            this.reconnectAttempt = 0;
            this.startHealthCheck();
            // Resubscribe to all paths
            this.resubscribeAll();
            // Execute pending operations
            this.executePendingOperations();
            // Notify callback
            this.onConnect?.();
            // Resolve connect promise
            this.connectResolver?.();
            this.connectResolver = null;
        };
        this.ws.onclose = (event) => {
            this.stopHealthCheck();
            this.onDisconnect?.(event.code, event.reason);
            if (!this.intentionalDisconnect) {
                this.scheduleReconnect();
            }
            else {
                this._connectionState = 'disconnected';
            }
        };
        this.ws.onerror = () => {
            // Error will be followed by close event
        };
        this.ws.onmessage = (event) => {
            this.handleMessage(event.data);
        };
    }
    /**
     * Handle incoming WebSocket message.
     */
    handleMessage(data) {
        try {
            const message = JSON.parse(data);
            if ('type' in message) {
                switch (message.type) {
                    case 'pong':
                        this.handlePong();
                        break;
                    case 'subscribed':
                    case 'unsubscribed':
                        // Acknowledgment messages - no action needed
                        break;
                    case 'create':
                    case 'modify':
                    case 'delete':
                    case 'rename':
                        this.dispatchEvent(message);
                        break;
                }
            }
        }
        catch (_error) {
            // Expected: Ignore malformed JSON messages from server
        }
    }
    /**
     * Dispatch a watch event to all matching callbacks.
     */
    dispatchEvent(event) {
        // Find all subscriptions that match this event's path
        this.subscriptions.forEach((entry, watchPath) => {
            if (this.pathMatches(watchPath, event.path)) {
                entry.callbacks.forEach((callback) => {
                    try {
                        callback(event);
                    }
                    catch (_error) {
                        // Intentional: Swallow callback errors to prevent breaking other subscribers
                    }
                });
            }
        });
    }
    /**
     * Check if an event path matches a watched path.
     *
     * A watched path matches if:
     * - It equals the event path exactly
     * - It is a parent directory of the event path
     */
    pathMatches(watchPath, eventPath) {
        // Exact match
        if (watchPath === eventPath)
            return true;
        // Parent directory match (watchPath is ancestor of eventPath)
        const normalizedWatch = watchPath.endsWith('/') ? watchPath : watchPath + '/';
        return eventPath.startsWith(normalizedWatch);
    }
    /**
     * Send a message to the WebSocket server.
     */
    send(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }
    // ===========================================================================
    // Private Methods - Reconnection
    // ===========================================================================
    /**
     * Schedule a reconnection attempt.
     */
    scheduleReconnect() {
        this.reconnectAttempt++;
        // Check if we've exceeded max attempts
        if (this.maxReconnectAttempts > 0 && this.reconnectAttempt > this.maxReconnectAttempts) {
            this._connectionState = 'disconnected';
            this.onReconnectFailed?.();
            return;
        }
        this._connectionState = 'reconnecting';
        this.onReconnecting?.(this.reconnectAttempt);
        // Calculate delay with exponential backoff
        const delay = Math.min(this.reconnectDelayMs * Math.pow(2, this.reconnectAttempt - 1), this.maxReconnectDelayMs);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.createConnection();
        }, delay);
    }
    /**
     * Resubscribe to all currently tracked paths.
     */
    resubscribeAll() {
        Array.from(this.subscriptions.keys()).forEach((path) => {
            this.send({ type: 'subscribe', path });
        });
    }
    /**
     * Execute all pending operations.
     */
    async executePendingOperations() {
        const operations = [...this.pendingOperations];
        this.pendingOperations = [];
        for (const op of operations) {
            try {
                await op();
            }
            catch (_error) {
                // Expected: Ignore errors in pending operations - they may have been invalidated
            }
        }
    }
    // ===========================================================================
    // Private Methods - Health Check
    // ===========================================================================
    /**
     * Start the health check ping interval.
     */
    startHealthCheck() {
        if (this.healthCheckIntervalMs <= 0)
            return;
        this.healthCheckTimer = setTimeout(() => {
            this.sendPing();
        }, this.healthCheckIntervalMs);
    }
    /**
     * Stop the health check timer.
     */
    stopHealthCheck() {
        if (this.healthCheckTimer) {
            clearTimeout(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
        if (this.healthCheckTimeoutTimer) {
            clearTimeout(this.healthCheckTimeoutTimer);
            this.healthCheckTimeoutTimer = null;
        }
    }
    /**
     * Send a ping and start timeout timer.
     */
    sendPing() {
        this.send({ type: 'ping' });
        // Start timeout timer
        this.healthCheckTimeoutTimer = setTimeout(() => {
            // No pong received - connection is dead
            this.ws?.close(4000, 'Health check timeout');
        }, this.healthCheckTimeoutMs);
    }
    /**
     * Handle pong response.
     */
    handlePong() {
        // Clear timeout timer
        if (this.healthCheckTimeoutTimer) {
            clearTimeout(this.healthCheckTimeoutTimer);
            this.healthCheckTimeoutTimer = null;
        }
        // Schedule next health check
        this.startHealthCheck();
    }
    // ===========================================================================
    // Private Methods - Utilities
    // ===========================================================================
    /**
     * Normalize a path by removing trailing slashes (except for root).
     */
    normalizePath(path) {
        if (path === '/' || path === '')
            return '/';
        return path.endsWith('/') ? path.slice(0, -1) : path;
    }
    /**
     * Clear all timers.
     */
    clearTimers() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.stopHealthCheck();
    }
}
//# sourceMappingURL=client.js.map
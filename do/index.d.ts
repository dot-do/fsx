/**
 * fsx/do - Durable Object filesystem integration
 *
 * This module provides filesystem capabilities for Cloudflare Durable Objects:
 *
 * - FsModule: Standalone filesystem module with lazy initialization
 * - withFs: Mixin function to add $.fs capability to DO classes
 * - FileSystemDO: Complete Durable Object with HTTP API
 *
 * ## Architecture
 *
 * FileSystemDO is a thin HTTP/RPC wrapper around FsModule. All filesystem
 * logic is implemented in FsModule to avoid code duplication. This separation
 * provides:
 *
 * - FsModule: Core filesystem operations, transactions, tiered storage
 * - FileSystemDO: HTTP API layer using Hono, streaming endpoints
 *
 * @example
 * ```typescript
 * // Using FsModule directly
 * import { FsModule } from 'fsx/do'
 *
 * const fs = new FsModule({ sql: ctx.storage.sql })
 * await fs.initialize()
 * await fs.write('/config.json', JSON.stringify(config))
 * ```
 *
 * @example
 * ```typescript
 * // Using withFs mixin with dotdo
 * import { withFs } from 'fsx/do'
 * import { DO } from 'dotdo'
 *
 * class MySite extends withFs(DO) {
 *   async loadContent() {
 *     return this.$.fs.read('/content/index.mdx', { encoding: 'utf-8' })
 *   }
 * }
 * ```
 *
 * @module fsx/do
 */
import { DurableObject } from 'cloudflare:workers';
import { type WatchEvent } from '../core/watch/index.js';
export { FsModule, type FsModuleConfig } from './module.js';
export { withFs, hasFs, getFs, type WithFsContext, type WithFsOptions, type WithFsDO } from './mixin.js';
export { PathValidator, pathValidator, SecurityConstants, type ValidationResult, type ValidationSuccess, type ValidationFailure, } from './security.js';
export { CloudflareContainerExecutor, createContainerExecutor, createIsolatedExecutor, type ContainerBinding, type ContainerInstance, type ContainerExecutorConfig, type ContainerExecResult, type ExecOptions, type StreamingExecEvent, type StreamingExecSession, type ContainerState, type HasContainerExecutor, type WithExecContext, } from './container-executor.js';
interface Env {
    FSX: DurableObjectNamespace;
    R2?: R2Bucket;
    ARCHIVE?: R2Bucket;
}
/**
 * WebSocket connection states following the WebSocket specification
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/readyState
 */
export declare const enum WebSocketState {
    /** Connection not yet established */
    CONNECTING = 0,
    /** Connection established and ready for communication */
    OPEN = 1,
    /** Connection is going through closing handshake */
    CLOSING = 2,
    /** Connection is closed or couldn't be opened */
    CLOSED = 3
}
/**
 * Default configuration values for WebSocket heartbeat and timeouts
 */
export declare const WebSocketDefaults: {
    /** Heartbeat interval in milliseconds (30 seconds) */
    readonly HEARTBEAT_INTERVAL_MS: 30000;
    /** Connection timeout for stale connections in milliseconds (90 seconds - 3 missed heartbeats) */
    readonly CONNECTION_TIMEOUT_MS: 90000;
    /** Grace period for reconnection attempts in milliseconds (5 seconds) */
    readonly RECONNECT_GRACE_PERIOD_MS: 5000;
    /** Maximum number of missed pongs before considering connection stale */
    readonly MAX_MISSED_PONGS: 3;
};
export declare class FileSystemDO extends DurableObject<Env> {
    private app;
    private fsModule;
    /**
     * Subscription manager for WebSocket file watching
     * Uses glob pattern matching to efficiently manage subscribers.
     */
    private subscriptionManager;
    /**
     * Batch emitter for event coalescing
     * Reduces WebSocket message overhead by batching rapid events.
     */
    private batchEmitter;
    /**
     * Active WebSocket connections for file watching
     *
     * Maps WebSocket instances to their connection metadata including
     * heartbeat state, activity timestamps, and watch configuration.
     */
    private watchConnections;
    /**
     * Counter for generating unique connection IDs
     * @internal
     */
    private connectionIdCounter;
    /**
     * Flag indicating whether heartbeat alarm is scheduled
     * @internal
     */
    private heartbeatAlarmScheduled;
    constructor(ctx: DurableObjectState, env: Env);
    /**
     * Generate a unique connection ID for WebSocket tracking
     *
     * @returns Unique connection identifier string
     * @internal
     */
    private generateConnectionId;
    /**
     * Schedule the next heartbeat alarm if not already scheduled
     *
     * Uses Durable Object alarms to periodically check connection health
     * and send ping messages to clients.
     *
     * @internal
     */
    private scheduleHeartbeatAlarm;
    /**
     * Handle Durable Object alarm for heartbeat processing
     *
     * This method is called by the Durable Objects runtime when an alarm fires.
     * It sends ping messages to all active connections and cleans up stale ones.
     */
    alarm(): Promise<void>;
    /**
     * Close a stale WebSocket connection with proper cleanup
     *
     * @param ws - WebSocket to close
     * @param metadata - Connection metadata
     * @param reason - Reason for closing
     * @internal
     */
    private closeStaleConnection;
    /**
     * Get watch system metrics
     *
     * Returns metrics about connections, subscriptions, and event batching.
     * Useful for monitoring and debugging watch system performance.
     *
     * @returns Object containing watch metrics
     */
    getWatchMetrics(): {
        connections: number;
        subscriptions: number;
        batchMetrics: {
            eventsReceived: number;
            eventsEmitted: number;
            batchesEmitted: number;
            compressionRatio: number;
            eventsPerSecond: number;
        };
    };
    private createApp;
    /**
     * Handle streaming read requests with full HTTP semantics
     *
     * Features:
     * - Content-Type inference from file extension
     * - ETag and Last-Modified caching headers
     * - Conditional request support (If-None-Match, If-Match)
     * - HTTP Range header support for partial content (206)
     * - Accept-Ranges header for range request discovery
     */
    private handleStreamRead;
    /**
     * Handle RPC method calls by delegating to FsModule
     */
    private handleMethod;
    /**
     * Handle readFile with encoding support
     */
    private handleReadFile;
    /**
     * Handle readdir with serializable response
     */
    private handleReaddir;
    /**
     * Handle stat/lstat with serializable response
     */
    private handleStat;
    /**
     * Convert Stats object to serializable response
     */
    private statsToResponse;
    fetch(request: Request): Promise<Response>;
    /**
     * Handle incoming WebSocket messages
     *
     * Supports the following message types:
     * - `subscribe`: Change the watched path without reconnecting
     * - `unsubscribe`: Stop watching and disconnect
     * - `ping`: Client-initiated ping (server responds with pong)
     * - `pong`: Client response to server ping (resets heartbeat tracking)
     *
     * All messages update the connection's lastActivity timestamp for
     * timeout tracking purposes.
     *
     * @param ws - The WebSocket connection that sent the message
     * @param message - Raw message data (string or ArrayBuffer)
     */
    webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
    /**
     * Handle WebSocket connection close
     *
     * Updates connection state and removes from active connections.
     * Called by the Durable Objects runtime when client closes connection.
     *
     * @param ws - The WebSocket connection that closed
     * @param code - WebSocket close code (e.g., 1000 for normal closure)
     * @param reason - Close reason string
     * @param wasClean - Whether the close was clean (TCP connection closed properly)
     */
    webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void>;
    /**
     * Handle WebSocket errors
     *
     * Logs the error and removes the connection from active set.
     * Called by the Durable Objects runtime when a WebSocket error occurs.
     *
     * @param ws - The WebSocket connection that errored
     * @param error - The error that occurred
     */
    webSocketError(ws: WebSocket, _error: unknown): Promise<void>;
    /**
     * Broadcast a file change event to all watching connections
     *
     * This method is called internally when filesystem operations modify files.
     * It sends events only to connections that are watching the affected path.
     *
     * @param event - The watch event to broadcast
     */
    /**
     * Queue a watch event for batched broadcast
     *
     * Events are collected and coalesced by the BatchEmitter before being
     * sent to subscribers. This reduces WebSocket message overhead for
     * rapid file operations.
     *
     * @param event - The watch event to queue
     */
    broadcastWatchEvent(event: WatchEvent): void;
    /**
     * Immediately broadcast a watch event to all matching subscribers
     *
     * This is called by the BatchEmitter after coalescing events.
     * Uses SubscriptionManager for efficient glob pattern matching.
     *
     * @param event - The watch event to broadcast
     * @internal
     */
    private broadcastWatchEventImmediate;
    /**
     * Check if an affected path matches a watch subscription
     *
     * @param affectedPath - The path that was modified
     * @param watchPath - The path being watched
     * @param recursive - Whether the watch is recursive
     * @returns true if the affected path matches the watch
     */
    private pathMatchesWatch;
}
//# sourceMappingURL=index.d.ts.map
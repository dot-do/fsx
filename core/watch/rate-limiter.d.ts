/**
 * Rate limiter for WebSocket message handling
 *
 * Implements a sliding window rate limiter to prevent message flooding
 * on WebSocket connections. Each connection is tracked independently.
 *
 * Features:
 * - Configurable rate limits (messages per time window)
 * - Per-connection tracking
 * - Sliding window algorithm for smooth rate limiting
 * - Memory-efficient cleanup of expired entries
 *
 * @module core/watch/rate-limiter
 *
 * @example
 * ```typescript
 * import { RateLimiter } from './rate-limiter.js'
 *
 * const limiter = new RateLimiter({
 *   maxMessages: 100,
 *   windowMs: 1000, // 100 messages per second
 * })
 *
 * // Check if message should be allowed
 * const result = limiter.checkLimit(ws)
 * if (!result.allowed) {
 *   ws.send(JSON.stringify({
 *     type: 'rate_limited',
 *     retryAfterMs: result.retryAfterMs,
 *   }))
 *   return
 * }
 * ```
 */
/**
 * Configuration options for the rate limiter
 */
export interface RateLimiterOptions {
    /**
     * Maximum number of messages allowed per time window
     * @default 100
     */
    maxMessages?: number;
    /**
     * Time window in milliseconds
     * @default 1000 (1 second)
     */
    windowMs?: number;
    /**
     * Whether to track burst limits separately
     * When true, also enforces a shorter burst window
     * @default true
     */
    enableBurstProtection?: boolean;
    /**
     * Maximum messages in burst window (shorter interval)
     * @default 20
     */
    burstMaxMessages?: number;
    /**
     * Burst window in milliseconds
     * @default 100
     */
    burstWindowMs?: number;
}
/**
 * Result of a rate limit check
 */
export interface RateLimitResult {
    /**
     * Whether the message is allowed
     */
    allowed: boolean;
    /**
     * Number of messages remaining in the current window
     * Only present when allowed is true
     */
    remaining?: number;
    /**
     * Milliseconds until the rate limit resets
     * Only present when allowed is false
     */
    retryAfterMs?: number;
    /**
     * Whether this was a burst limit violation (vs regular limit)
     * Only present when allowed is false
     */
    burstLimitExceeded?: boolean;
    /**
     * Current message count in the window
     */
    currentCount: number;
    /**
     * Maximum messages allowed
     */
    limit: number;
}
/**
 * Default rate limiter configuration
 */
export declare const RateLimiterDefaults: {
    /** Default maximum messages per second */
    readonly MAX_MESSAGES: 100;
    /** Default time window (1 second) */
    readonly WINDOW_MS: 1000;
    /** Default burst protection enabled */
    readonly ENABLE_BURST_PROTECTION: true;
    /** Default burst messages (20 per 100ms) */
    readonly BURST_MAX_MESSAGES: 20;
    /** Default burst window (100ms) */
    readonly BURST_WINDOW_MS: 100;
    /** Cleanup interval for stale connection data (5 minutes) */
    readonly CLEANUP_INTERVAL_MS: number;
    /** Maximum age for connection data before cleanup (10 minutes) */
    readonly MAX_DATA_AGE_MS: number;
};
/**
 * Rate limiter for WebSocket connections
 *
 * Uses a sliding window algorithm to track message rates per connection.
 * Supports both regular rate limiting and burst protection.
 */
export declare class RateLimiter {
    private readonly maxMessages;
    private readonly windowMs;
    private readonly enableBurstProtection;
    private readonly burstMaxMessages;
    private readonly burstWindowMs;
    /**
     * Rate data per connection (keyed by WebSocket instance)
     */
    private connectionData;
    /**
     * Timer for periodic cleanup (only set if cleanup is enabled)
     */
    private cleanupTimer;
    constructor(options?: RateLimiterOptions);
    /**
     * Check if a message from a connection should be allowed
     *
     * Call this before processing each incoming WebSocket message.
     * If not allowed, the caller should send a rate_limited response.
     *
     * @param ws - The WebSocket connection
     * @returns Rate limit check result
     */
    checkLimit(ws: WebSocket): RateLimitResult;
    /**
     * Remove tracking data for a connection
     *
     * Call this when a WebSocket connection closes to free memory.
     *
     * @param ws - The WebSocket connection to remove
     */
    removeConnection(ws: WebSocket): void;
    /**
     * Get current rate limit status for a connection without consuming a slot
     *
     * Useful for including rate limit info in response headers.
     *
     * @param ws - The WebSocket connection
     * @returns Current rate status
     */
    getStatus(ws: WebSocket): {
        remaining: number;
        resetMs: number;
        limit: number;
    };
    /**
     * Reset rate limit data for a connection
     *
     * Useful for administrative purposes or testing.
     *
     * @param ws - The WebSocket connection to reset
     */
    reset(ws: WebSocket): void;
    /**
     * Reset all rate limit data
     *
     * Useful for testing or administrative reset.
     */
    resetAll(): void;
    /**
     * Get the number of tracked connections
     *
     * @returns Number of connections being tracked
     */
    getConnectionCount(): number;
    /**
     * Clean up stale connection data
     *
     * Removes data for connections that haven't been active recently.
     * This is called automatically if cleanup timer is enabled.
     *
     * @param maxAgeMs - Maximum age in milliseconds (default: 10 minutes)
     */
    cleanup(maxAgeMs?: number): void;
    /**
     * Start automatic cleanup of stale connection data
     *
     * @param intervalMs - Cleanup interval in milliseconds (default: 5 minutes)
     */
    startCleanup(intervalMs?: number): void;
    /**
     * Stop automatic cleanup
     */
    stopCleanup(): void;
    /**
     * Get current configuration
     *
     * @returns Current rate limiter configuration
     */
    getConfig(): Required<RateLimiterOptions>;
}
/**
 * Create a rate limiter with default configuration
 *
 * @param options - Optional configuration overrides
 * @returns Configured rate limiter
 */
export declare function createRateLimiter(options?: RateLimiterOptions): RateLimiter;
//# sourceMappingURL=rate-limiter.d.ts.map
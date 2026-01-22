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
 * Default rate limiter configuration
 */
export const RateLimiterDefaults = {
    /** Default maximum messages per second */
    MAX_MESSAGES: 100,
    /** Default time window (1 second) */
    WINDOW_MS: 1000,
    /** Default burst protection enabled */
    ENABLE_BURST_PROTECTION: true,
    /** Default burst messages (20 per 100ms) */
    BURST_MAX_MESSAGES: 20,
    /** Default burst window (100ms) */
    BURST_WINDOW_MS: 100,
    /** Cleanup interval for stale connection data (5 minutes) */
    CLEANUP_INTERVAL_MS: 5 * 60 * 1000,
    /** Maximum age for connection data before cleanup (10 minutes) */
    MAX_DATA_AGE_MS: 10 * 60 * 1000,
};
/**
 * Rate limiter for WebSocket connections
 *
 * Uses a sliding window algorithm to track message rates per connection.
 * Supports both regular rate limiting and burst protection.
 */
export class RateLimiter {
    maxMessages;
    windowMs;
    enableBurstProtection;
    burstMaxMessages;
    burstWindowMs;
    /**
     * Rate data per connection (keyed by WebSocket instance)
     */
    connectionData = new Map();
    /**
     * Timer for periodic cleanup (only set if cleanup is enabled)
     */
    cleanupTimer = null;
    constructor(options = {}) {
        this.maxMessages = options.maxMessages ?? RateLimiterDefaults.MAX_MESSAGES;
        this.windowMs = options.windowMs ?? RateLimiterDefaults.WINDOW_MS;
        this.enableBurstProtection = options.enableBurstProtection ?? RateLimiterDefaults.ENABLE_BURST_PROTECTION;
        this.burstMaxMessages = options.burstMaxMessages ?? RateLimiterDefaults.BURST_MAX_MESSAGES;
        this.burstWindowMs = options.burstWindowMs ?? RateLimiterDefaults.BURST_WINDOW_MS;
    }
    /**
     * Check if a message from a connection should be allowed
     *
     * Call this before processing each incoming WebSocket message.
     * If not allowed, the caller should send a rate_limited response.
     *
     * @param ws - The WebSocket connection
     * @returns Rate limit check result
     */
    checkLimit(ws) {
        const now = Date.now();
        // Get or create connection data
        let data = this.connectionData.get(ws);
        if (!data) {
            data = {
                timestamps: [],
                burstTimestamps: [],
                lastAccess: now,
            };
            this.connectionData.set(ws, data);
        }
        data.lastAccess = now;
        // Clean up old timestamps outside the window
        const windowCutoff = now - this.windowMs;
        data.timestamps = data.timestamps.filter((t) => t > windowCutoff);
        // Check burst limit first (if enabled)
        if (this.enableBurstProtection) {
            const burstCutoff = now - this.burstWindowMs;
            data.burstTimestamps = data.burstTimestamps.filter((t) => t > burstCutoff);
            if (data.burstTimestamps.length >= this.burstMaxMessages) {
                // Burst limit exceeded
                const oldestBurst = data.burstTimestamps[0];
                const retryAfterMs = oldestBurst + this.burstWindowMs - now;
                return {
                    allowed: false,
                    retryAfterMs: Math.max(1, retryAfterMs),
                    burstLimitExceeded: true,
                    currentCount: data.timestamps.length,
                    limit: this.maxMessages,
                };
            }
        }
        // Check main rate limit
        if (data.timestamps.length >= this.maxMessages) {
            // Rate limit exceeded
            const oldestTimestamp = data.timestamps[0];
            const retryAfterMs = oldestTimestamp + this.windowMs - now;
            return {
                allowed: false,
                retryAfterMs: Math.max(1, retryAfterMs),
                burstLimitExceeded: false,
                currentCount: data.timestamps.length,
                limit: this.maxMessages,
            };
        }
        // Message allowed - record it
        data.timestamps.push(now);
        if (this.enableBurstProtection) {
            data.burstTimestamps.push(now);
        }
        return {
            allowed: true,
            remaining: this.maxMessages - data.timestamps.length,
            currentCount: data.timestamps.length,
            limit: this.maxMessages,
        };
    }
    /**
     * Remove tracking data for a connection
     *
     * Call this when a WebSocket connection closes to free memory.
     *
     * @param ws - The WebSocket connection to remove
     */
    removeConnection(ws) {
        this.connectionData.delete(ws);
    }
    /**
     * Get current rate limit status for a connection without consuming a slot
     *
     * Useful for including rate limit info in response headers.
     *
     * @param ws - The WebSocket connection
     * @returns Current rate status
     */
    getStatus(ws) {
        const now = Date.now();
        const data = this.connectionData.get(ws);
        if (!data) {
            return {
                remaining: this.maxMessages,
                resetMs: 0,
                limit: this.maxMessages,
            };
        }
        // Clean up old timestamps
        const windowCutoff = now - this.windowMs;
        const currentTimestamps = data.timestamps.filter((t) => t > windowCutoff);
        const remaining = Math.max(0, this.maxMessages - currentTimestamps.length);
        const oldestTimestamp = currentTimestamps[0];
        const resetMs = oldestTimestamp ? oldestTimestamp + this.windowMs - now : 0;
        return {
            remaining,
            resetMs: Math.max(0, resetMs),
            limit: this.maxMessages,
        };
    }
    /**
     * Reset rate limit data for a connection
     *
     * Useful for administrative purposes or testing.
     *
     * @param ws - The WebSocket connection to reset
     */
    reset(ws) {
        const data = this.connectionData.get(ws);
        if (data) {
            data.timestamps = [];
            data.burstTimestamps = [];
        }
    }
    /**
     * Reset all rate limit data
     *
     * Useful for testing or administrative reset.
     */
    resetAll() {
        this.connectionData.clear();
    }
    /**
     * Get the number of tracked connections
     *
     * @returns Number of connections being tracked
     */
    getConnectionCount() {
        return this.connectionData.size;
    }
    /**
     * Clean up stale connection data
     *
     * Removes data for connections that haven't been active recently.
     * This is called automatically if cleanup timer is enabled.
     *
     * @param maxAgeMs - Maximum age in milliseconds (default: 10 minutes)
     */
    cleanup(maxAgeMs = RateLimiterDefaults.MAX_DATA_AGE_MS) {
        const now = Date.now();
        const cutoff = now - maxAgeMs;
        for (const [ws, data] of this.connectionData) {
            if (data.lastAccess < cutoff) {
                this.connectionData.delete(ws);
            }
        }
    }
    /**
     * Start automatic cleanup of stale connection data
     *
     * @param intervalMs - Cleanup interval in milliseconds (default: 5 minutes)
     */
    startCleanup(intervalMs = RateLimiterDefaults.CLEANUP_INTERVAL_MS) {
        if (this.cleanupTimer) {
            return; // Already running
        }
        this.cleanupTimer = setInterval(() => {
            this.cleanup();
        }, intervalMs);
    }
    /**
     * Stop automatic cleanup
     */
    stopCleanup() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }
    /**
     * Get current configuration
     *
     * @returns Current rate limiter configuration
     */
    getConfig() {
        return {
            maxMessages: this.maxMessages,
            windowMs: this.windowMs,
            enableBurstProtection: this.enableBurstProtection,
            burstMaxMessages: this.burstMaxMessages,
            burstWindowMs: this.burstWindowMs,
        };
    }
}
/**
 * Create a rate limiter with default configuration
 *
 * @param options - Optional configuration overrides
 * @returns Configured rate limiter
 */
export function createRateLimiter(options) {
    return new RateLimiter(options);
}
//# sourceMappingURL=rate-limiter.js.map
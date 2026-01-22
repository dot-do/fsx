/**
 * TieredFS - Multi-tier filesystem with automatic placement
 *
 * Provides automatic file placement across storage tiers based on file size.
 * Uses Durable Objects for hot storage (small files) and R2 for warm/cold
 * storage (larger files).
 *
 * Features:
 * - Automatic tier selection based on file size thresholds
 * - In-memory tier tracking for fast lookups
 * - Tier promotion for frequently accessed files (configurable)
 * - Manual demotion for cost optimization
 * - Fallback behavior when tiers are unavailable
 * - Access pattern tracking for smart tier placement
 * - Telemetry/metrics hooks for monitoring
 *
 * Performance optimizations:
 * - Cached threshold values to avoid repeated property access
 * - Access pattern tracking with configurable window
 * - LRU-style tier metadata cache with size limits
 * - Optimized base64 encoding/decoding
 *
 * @example
 * ```typescript
 * const tiered = new TieredFS({
 *   hot: env.FSX_DO,
 *   warm: env.FSX_WARM_BUCKET,
 *   cold: env.FSX_COLD_BUCKET,
 *   thresholds: {
 *     hotMaxSize: 1024 * 1024,  // 1MB
 *     warmMaxSize: 100 * 1024 * 1024,  // 100MB
 *   },
 *   promotionPolicy: 'on-access'
 * })
 *
 * // Small files go to hot tier automatically
 * await tiered.writeFile('/config.json', JSON.stringify(config))
 *
 * // Large files go to warm/cold tier
 * await tiered.writeFile('/data/large.bin', largeData)
 *
 * // Read from any tier transparently
 * const { data, tier } = await tiered.readFile('/config.json')
 * console.log(`Read from ${tier} tier`)
 * ```
 *
 * @module storage/tiered
 */
import type { StorageTier } from '../core/index.js';
import { type StorageHooks } from './interfaces.js';
/**
 * Configuration for TieredFS.
 */
export interface TieredFSConfig {
    /**
     * Hot tier (Durable Object namespace).
     * Used for small files that need low-latency access.
     * Required.
     */
    hot: DurableObjectNamespace;
    /**
     * Warm tier (R2 bucket).
     * Used for larger files that don't fit in hot tier.
     * Optional - falls back to hot if not provided.
     */
    warm?: R2Bucket;
    /**
     * Cold tier (R2 bucket for archive).
     * Used for very large or infrequently accessed files.
     * Optional - falls back to warm/hot if not provided.
     */
    cold?: R2Bucket;
    /**
     * Size thresholds for tier selection.
     */
    thresholds?: {
        /** Max size for hot tier in bytes (default: 1MB) */
        hotMaxSize?: number;
        /** Max size for warm tier in bytes (default: 100MB) */
        warmMaxSize?: number;
    };
    /**
     * Tier promotion policy.
     * - 'none': No automatic promotion
     * - 'on-access': Promote on read (default)
     * - 'aggressive': Promote immediately on any access
     */
    promotionPolicy?: 'none' | 'on-access' | 'aggressive';
    /**
     * Optional instrumentation hooks for metrics/monitoring.
     * @see StorageHooks
     */
    hooks?: StorageHooks;
    /**
     * Maximum size of the tier metadata cache.
     * Default: 10000 entries
     */
    maxCacheSize?: number;
    /**
     * Enable access pattern tracking for smart tier placement.
     * Default: true when promotionPolicy is 'on-access' or 'aggressive'
     */
    trackAccessPatterns?: boolean;
}
/**
 * Metrics collected by TieredFS for monitoring.
 */
export interface TieredFSMetrics {
    /** Total cache hits (tier metadata found in cache) */
    cacheHits: number;
    /** Total cache misses (had to search tiers) */
    cacheMisses: number;
    /** Count of reads per tier */
    readsByTier: Record<StorageTier, number>;
    /** Count of writes per tier */
    writesByTier: Record<StorageTier, number>;
    /** Count of promotions performed */
    promotions: number;
    /** Count of demotions performed */
    demotions: number;
    /** Average read latency in ms per tier */
    avgReadLatencyMs: Record<StorageTier, number>;
}
/**
 * TieredFS - Multi-tier filesystem with automatic tier selection.
 *
 * Automatically places files in the appropriate storage tier based on
 * file size. Provides transparent read/write operations across tiers.
 *
 * Tier selection logic:
 * 1. Files <= hotMaxSize go to hot tier (Durable Object)
 * 2. Files <= warmMaxSize go to warm tier (R2)
 * 3. Larger files go to cold tier (archive R2)
 * 4. Falls back to available tiers if preferred tier is unavailable
 *
 * @example
 * ```typescript
 * const fs = new TieredFS({ hot: env.DO, warm: env.R2 })
 *
 * // Write automatically selects tier
 * const { tier } = await fs.writeFile('/file.txt', 'Hello')
 *
 * // Read finds file in any tier
 * const { data } = await fs.readFile('/file.txt')
 *
 * // Manual tier management
 * await fs.demote('/old-data.json', 'cold')
 * ```
 */
export declare class TieredFS {
    /** Durable Object stub for hot tier operations */
    private readonly hotStub;
    /** R2 bucket for warm tier (optional) */
    private readonly warm?;
    /** R2 bucket for cold tier (optional) */
    private readonly cold?;
    /** Cached hot tier threshold (avoid repeated property access) */
    private readonly hotMaxSize;
    /** Cached warm tier threshold (avoid repeated property access) */
    private readonly warmMaxSize;
    /** Promotion policy */
    private readonly promotionPolicy;
    /** Optional instrumentation hooks */
    private readonly hooks?;
    /** Maximum cache size */
    private readonly maxCacheSize;
    /** Whether to track access patterns */
    private readonly trackAccessPatterns;
    /**
     * In-memory tier tracking cache with LRU eviction.
     * Supplements the DO storage for fast tier lookups without network calls.
     */
    private readonly tierMap;
    /**
     * Metrics tracking for monitoring.
     */
    private readonly metrics;
    /** Read latency samples for averaging */
    private readonly readLatencySamples;
    /**
     * Create a new TieredFS instance.
     *
     * @param config - Tiered filesystem configuration
     *
     * @example
     * ```typescript
     * const fs = new TieredFS({
     *   hot: env.FSX_DO,
     *   warm: env.FSX_WARM,
     *   cold: env.FSX_COLD,
     *   thresholds: { hotMaxSize: 512 * 1024 }  // 512KB hot threshold
     * })
     * ```
     */
    constructor(config: TieredFSConfig);
    /**
     * Get current metrics snapshot.
     *
     * @returns Copy of current metrics
     *
     * @example
     * ```typescript
     * const metrics = fs.getMetrics()
     * console.log(`Cache hit rate: ${metrics.cacheHits / (metrics.cacheHits + metrics.cacheMisses)}`)
     * ```
     */
    getMetrics(): TieredFSMetrics;
    /**
     * Reset metrics counters.
     */
    resetMetrics(): void;
    /**
     * Determine the appropriate storage tier based on file size.
     *
     * Selection logic with fallback:
     * 1. size <= hotMaxSize -> hot tier
     * 2. size <= warmMaxSize -> warm tier (or hot if warm unavailable)
     * 3. size > warmMaxSize -> cold tier (or warm/hot if unavailable)
     *
     * Optimized to use cached threshold values for fast path.
     *
     * @param size - File size in bytes
     * @returns Selected storage tier
     * @internal
     */
    private selectTier;
    /**
     * Update tier metadata cache with LRU eviction.
     *
     * @param path - File path
     * @param metadata - Tier metadata to cache
     * @internal
     */
    private updateTierCache;
    /**
     * Record a read access for access pattern tracking.
     *
     * @param path - File path
     * @internal
     */
    private recordAccess;
    /**
     * Check if a file should be promoted based on access patterns.
     *
     * @param path - File path
     * @param currentTier - Current storage tier
     * @returns Whether promotion should occur
     * @internal
     */
    private shouldAutoPromote;
    /**
     * Record read latency for metrics.
     *
     * @param tier - Storage tier
     * @param latencyMs - Latency in milliseconds
     * @internal
     */
    private recordReadLatency;
    /**
     * Write a file with automatic tier selection.
     *
     * The storage tier is selected based on the data size:
     * - <= hotMaxSize: stored in Durable Object (hot tier)
     * - <= warmMaxSize: stored in R2 warm bucket
     * - > warmMaxSize: stored in R2 cold bucket
     *
     * For hot tier writes, parent directories are automatically created.
     * For warm/cold tier writes, metadata is synced to the hot tier.
     *
     * @param path - Absolute file path
     * @param data - File content (string or bytes)
     * @returns Object containing the tier used
     *
     * @example
     * ```typescript
     * // Small file -> hot tier
     * const result = await fs.writeFile('/config.json', '{"key": "value"}')
     * console.log(result.tier)  // 'hot'
     *
     * // Large file -> warm/cold tier
     * const largeData = new Uint8Array(10 * 1024 * 1024)
     * const result2 = await fs.writeFile('/data.bin', largeData)
     * console.log(result2.tier)  // 'warm' or 'cold'
     * ```
     */
    writeFile(path: string, data: Uint8Array | string): Promise<{
        tier: StorageTier;
    }>;
    /**
     * Read a file from any tier.
     *
     * First checks the in-memory tier cache for quick lookup, then
     * searches through available tiers (warm, cold, hot) to find the file.
     * Updates the tier cache when a file is found.
     *
     * Optimizations:
     * - Cache hit tracking for monitoring cache effectiveness
     * - Access pattern recording for smart promotion decisions
     * - Latency tracking per tier for performance monitoring
     *
     * @param path - Absolute file path
     * @returns Object containing data and the tier it was read from
     * @throws {StorageError} If file is not found in any tier
     *
     * @example
     * ```typescript
     * const { data, tier } = await fs.readFile('/config.json')
     * const text = new TextDecoder().decode(data)
     * console.log(`Read from ${tier} tier: ${text}`)
     * ```
     */
    readFile(path: string): Promise<{
        data: Uint8Array;
        tier: StorageTier;
    }>;
    /**
     * Search through all tiers to find a file.
     *
     * @param path - File path
     * @returns Data and tier
     * @throws {StorageError} If file not found in any tier
     * @internal
     */
    private searchTiers;
    /**
     * Read file from hot tier (Durable Object).
     *
     * @param path - File path
     * @returns Data and tier info
     * @throws {Error} If file not found in hot tier
     * @internal
     */
    private readFromHot;
    /**
     * Read file from warm tier (R2).
     *
     * @param path - File path
     * @returns Data and tier info
     * @throws {StorageError} If warm tier not available or file not found
     * @internal
     */
    private readFromWarm;
    /**
     * Read file from cold tier (R2 archive).
     *
     * @param path - File path
     * @returns Data and tier info
     * @throws {StorageError} If cold tier not available or file not found
     * @internal
     */
    private readFromCold;
    /**
     * Ensure parent directory exists in hot tier.
     *
     * Creates parent directories recursively if they don't exist.
     *
     * @param path - File path (parent will be extracted)
     * @internal
     */
    private ensureParentDir;
    /**
     * Promote a file to a higher (faster) tier.
     *
     * Writes the file to the target tier and updates metadata.
     *
     * @param path - File path
     * @param data - File data
     * @param _fromTier - Current tier (unused, for logging)
     * @param toTier - Target tier
     * @internal
     */
    private _promote;
    /**
     * Promote a file to a higher (faster) tier.
     *
     * Moves a file from its current tier to a higher-performance tier.
     * The file is copied to the target tier and removed from the source tier.
     *
     * The process:
     * 1. Read file from current tier
     * 2. Write to target tier
     * 3. Delete from source tier
     * 4. Update metadata
     *
     * @param path - File path to promote
     * @param toTier - Target tier ('hot' or 'warm')
     * @throws {StorageError} If target tier is not available or file not found
     *
     * @example
     * ```typescript
     * // Promote frequently accessed file to hot tier
     * await fs.promote('/data/active.json', 'hot')
     *
     * // Promote from cold to warm
     * await fs.promote('/archive/recent.bin', 'warm')
     * ```
     */
    promote(path: string, toTier: 'hot' | 'warm'): Promise<void>;
    /**
     * Demote a file to a lower (cheaper) tier.
     *
     * Moves a file from its current tier to a lower-cost tier.
     * Useful for archiving infrequently accessed data.
     *
     * The process:
     * 1. Read file from current tier
     * 2. Write to target tier
     * 3. Delete from original tier
     * 4. Update metadata
     *
     * @param path - File path to demote
     * @param toTier - Target tier ('warm' or 'cold')
     * @throws {StorageError} If target tier is not available
     *
     * @example
     * ```typescript
     * // Move old data to cold storage
     * await fs.demote('/data/archive-2023.json', 'cold')
     *
     * // Move large file from hot to warm
     * await fs.demote('/cache/processed.bin', 'warm')
     * ```
     */
    demote(path: string, toTier: 'warm' | 'cold'): Promise<void>;
    /**
     * Move a file to a new path.
     *
     * Reads the file, writes it to the new location, and deletes the original.
     * The file remains in the same tier unless tier selection changes due to size.
     *
     * @param sourcePath - Original file path
     * @param destPath - New file path
     * @throws {StorageError} If source file is not found
     *
     * @example
     * ```typescript
     * await fs.move('/old/path/file.txt', '/new/path/file.txt')
     * ```
     */
    move(sourcePath: string, destPath: string): Promise<void>;
    /**
     * Copy a file to a new path.
     *
     * Creates a copy of the file at the destination path.
     * Optionally can copy to a different tier.
     *
     * @param sourcePath - Original file path
     * @param destPath - Destination file path
     * @param options - Copy options (optional tier override)
     * @throws {StorageError} If source file is not found
     *
     * @example
     * ```typescript
     * // Copy within same tier
     * await fs.copy('/data/file.txt', '/backup/file.txt')
     *
     * // Copy to different tier
     * await fs.copy('/hot/file.txt', '/archive/file.txt', { tier: 'cold' })
     * ```
     */
    copy(sourcePath: string, destPath: string, options?: {
        tier?: StorageTier;
    }): Promise<void>;
    /**
     * Delete a file from any tier.
     *
     * Removes the file from its current storage tier and cleans up metadata.
     *
     * @param path - File path to delete
     * @throws {StorageError} If file is not found
     *
     * @example
     * ```typescript
     * await fs.deleteFile('/old/data.bin')
     * ```
     */
    deleteFile(path: string): Promise<void>;
    /**
     * Encode binary data to base64 for RPC transport.
     *
     * @param data - Binary data to encode
     * @returns Base64 encoded string
     * @internal
     */
    private encodeBase64;
    /**
     * Decode base64 string to binary data.
     *
     * @param data - Base64 encoded string
     * @returns Decoded binary data
     * @internal
     */
    private decodeBase64;
}
//# sourceMappingURL=tiered.d.ts.map
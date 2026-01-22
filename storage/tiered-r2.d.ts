/**
 * TieredR2Storage - R2-backed tiered storage with automatic tier migration
 *
 * Implements hot/warm/cold tiers based on access patterns:
 * - Hot: Recently accessed (< 1 day by default)
 * - Warm: Moderately accessed (< 30 days by default)
 * - Cold: Infrequently accessed (> 30 days by default)
 *
 * Features:
 * - Automatic tier migration based on access patterns
 * - Configurable tier policies
 * - Access tracking for intelligent placement
 * - Cost optimization through tier demotion
 * - Performance optimization through tier promotion
 */
import type { StorageTier } from '../core/index.js';
/**
 * Tier policy configuration
 */
export interface TierPolicy {
    /** Maximum age in days for hot tier (default: 1 day) */
    hotMaxAgeDays: number;
    /** Maximum age in days for warm tier (default: 30 days) */
    warmMaxAgeDays: number;
    /** Enable automatic promotion on access (default: true) */
    autoPromote: boolean;
    /** Enable automatic demotion based on age (default: true) */
    autoDemote: boolean;
    /** Minimum size for cold tier consideration in bytes (default: 0) */
    coldMinSize: number;
}
/**
 * Configuration for TieredR2Storage
 */
export interface TieredR2StorageConfig {
    /** Hot tier R2 bucket (fast access, higher cost) */
    hotBucket: R2Bucket;
    /** Warm tier R2 bucket (balanced, optional - uses hot if not provided) */
    warmBucket?: R2Bucket;
    /** Cold tier R2 bucket (slow access, lowest cost, optional - uses warm/hot if not provided) */
    coldBucket?: R2Bucket;
    /** Key prefix for all objects */
    prefix?: string;
    /** Tier policy configuration */
    policy?: Partial<TierPolicy>;
    /** SQLite storage for metadata (for Durable Object context) */
    sql?: SqlStorage;
}
/**
 * File metadata stored in R2 custom metadata
 */
export interface TieredFileMetadata {
    /** Current storage tier */
    tier: StorageTier;
    /** Last access timestamp (Unix ms) */
    lastAccess: number;
    /** Access count for analytics */
    accessCount: number;
    /** Original creation timestamp */
    createdAt: number;
    /** Content hash for deduplication */
    contentHash?: string;
    /** Original filename/path */
    originalPath?: string;
}
/**
 * Result of a tiered storage operation
 */
export interface TieredStorageResult {
    /** The storage tier used */
    tier: StorageTier;
    /** Whether a tier migration occurred */
    migrated: boolean;
    /** Previous tier (if migrated) */
    previousTier?: StorageTier;
}
/**
 * Result of a read operation
 */
export interface TieredReadResult extends TieredStorageResult {
    /** The file data */
    data: Uint8Array;
    /** R2 object metadata */
    metadata: R2Object;
}
/**
 * Result of a write operation
 */
export interface TieredWriteResult extends TieredStorageResult {
    /** ETag of the stored object */
    etag: string;
    /** Size of the stored data */
    size: number;
}
/**
 * TieredR2Storage - Intelligent tiered storage using R2
 *
 * Automatically manages file placement across hot/warm/cold tiers
 * based on access patterns and configurable policies.
 *
 * @example
 * ```typescript
 * const storage = new TieredR2Storage({
 *   hotBucket: env.R2_HOT,
 *   warmBucket: env.R2_WARM,
 *   coldBucket: env.R2_COLD,
 *   policy: {
 *     hotMaxAgeDays: 1,
 *     warmMaxAgeDays: 30,
 *     autoPromote: true,
 *     autoDemote: true,
 *   }
 * })
 *
 * // Write - automatically placed in appropriate tier
 * await storage.put('/data/file.json', data)
 *
 * // Read - automatically promoted if frequently accessed
 * const result = await storage.get('/data/file.json')
 * console.log(`Read from ${result.tier} tier`)
 *
 * // Manual tier management
 * await storage.promote('/data/important.json', 'hot')
 * await storage.demote('/data/archive.json', 'cold')
 * ```
 */
export declare class TieredR2Storage {
    private hotBucket;
    private warmBucket;
    private coldBucket;
    private prefix;
    private policy;
    private sql?;
    private initialized;
    constructor(config: TieredR2StorageConfig);
    /**
     * Initialize metadata tracking table if SQL storage is available
     */
    private ensureInitialized;
    /**
     * Get full key with prefix
     */
    private key;
    /**
     * Get the R2 bucket for a given tier
     */
    private getBucket;
    /**
     * Determine the appropriate tier based on access pattern
     * @internal Reserved for automatic tier migration based on access patterns
     */
    private _determineTierByAge;
    /**
     * Parse tier metadata from R2 custom metadata
     */
    private parseMetadata;
    /**
     * Create tier metadata for R2 custom metadata
     */
    private createMetadata;
    /**
     * Update access metadata in SQLite
     */
    private updateAccessMetadata;
    /**
     * Get access metadata from SQLite
     * @internal Reserved for future tier migration based on access patterns
     */
    private _getAccessMetadata;
    /**
     * Store a file with automatic tier selection
     *
     * @param path - File path/key
     * @param data - File data
     * @param options - Storage options
     * @returns Write result with tier information
     */
    put(path: string, data: Uint8Array | ReadableStream, options?: {
        contentType?: string;
        tier?: StorageTier;
        customMetadata?: Record<string, string>;
    }): Promise<TieredWriteResult>;
    /**
     * Retrieve a file with automatic tier promotion
     *
     * @param path - File path/key
     * @returns Read result with data and tier information
     */
    get(path: string): Promise<TieredReadResult | null>;
    /**
     * Get a file as a stream
     */
    getStream(path: string): Promise<{
        stream: ReadableStream;
        metadata: R2Object;
        tier: StorageTier;
    } | null>;
    /**
     * Get a range of bytes from a file
     */
    getRange(path: string, start: number, end?: number): Promise<{
        data: Uint8Array;
        metadata: R2Object;
        tier: StorageTier;
    } | null>;
    /**
     * Check if a file exists
     */
    exists(path: string): Promise<{
        exists: boolean;
        tier?: StorageTier;
    }>;
    /**
     * Get file metadata without downloading
     */
    head(path: string): Promise<{
        metadata: R2Object;
        tier: StorageTier;
    } | null>;
    /**
     * Delete a file from all tiers
     */
    delete(path: string): Promise<void>;
    /**
     * Delete multiple files
     */
    deleteMany(paths: string[]): Promise<void>;
    /**
     * Determine if a file should be promoted based on access pattern
     */
    private shouldPromote;
    /**
     * Internal migration between tiers
     */
    private migrateInternal;
    /**
     * Manually promote a file to a higher tier
     *
     * @param path - File path
     * @param targetTier - Target tier ('hot' or 'warm')
     */
    promote(path: string, targetTier: 'hot' | 'warm'): Promise<TieredStorageResult>;
    /**
     * Manually demote a file to a lower tier
     *
     * @param path - File path
     * @param targetTier - Target tier ('warm' or 'cold')
     */
    demote(path: string, targetTier: 'warm' | 'cold'): Promise<TieredStorageResult>;
    /**
     * Get the current tier for a file
     */
    getTier(path: string): Promise<StorageTier | null>;
    /**
     * Run automatic tier migration based on access patterns
     *
     * This should be called periodically (e.g., via cron) to demote
     * infrequently accessed files to lower tiers.
     *
     * @param options - Migration options
     * @returns Number of files migrated
     */
    runMigration(options?: {
        dryRun?: boolean;
        limit?: number;
    }): Promise<{
        promoted: number;
        demoted: number;
        errors: string[];
    }>;
    /**
     * Get storage statistics by tier
     */
    getStats(): Promise<{
        hot: {
            count: number;
            totalSize: number;
        };
        warm: {
            count: number;
            totalSize: number;
        };
        cold: {
            count: number;
            totalSize: number;
        };
    }>;
    /**
     * List files in a specific tier
     */
    listByTier(tier: StorageTier, options?: {
        prefix?: string;
        limit?: number;
        cursor?: string;
    }): Promise<{
        objects: R2Object[];
        cursor?: string;
        truncated: boolean;
    }>;
    /**
     * Copy a file within tiers
     */
    copy(sourcePath: string, destPath: string, destTier?: StorageTier): Promise<TieredWriteResult>;
}
//# sourceMappingURL=tiered-r2.d.ts.map
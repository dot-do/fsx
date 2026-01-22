/**
 * Blob Management Utilities
 *
 * Shared utilities for content-addressable blob storage:
 * - Hash computation (SHA-256)
 * - Blob ID generation
 * - Deduplication helpers
 * - Tier transition validation
 * - Cleanup scheduling
 *
 * @module storage/blob-utils
 */
import type { StorageTier } from '../core/index.js';
/**
 * Prefix for content-addressable blob IDs.
 * Using a prefix helps identify blobs and prevents ID collisions.
 */
export declare const BLOB_ID_PREFIX = "blob-";
/**
 * Compute SHA-256 checksum of data.
 *
 * Uses the Web Crypto API for efficient, hardware-accelerated hashing.
 * Returns a 64-character lowercase hex string.
 *
 * @param data - Binary data to hash
 * @returns 64-character hex checksum
 *
 * @example
 * ```typescript
 * const checksum = await computeChecksum(new TextEncoder().encode('hello'))
 * console.log(checksum) // '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
 * ```
 */
export declare function computeChecksum(data: Uint8Array): Promise<string>;
/**
 * Generate a content-addressable blob ID from data.
 *
 * The blob ID is derived from the SHA-256 hash of the content,
 * ensuring identical content always maps to the same ID.
 *
 * @param data - Binary data to generate ID for
 * @returns Content-addressable blob ID
 *
 * @example
 * ```typescript
 * const id = await generateBlobId(new TextEncoder().encode('hello'))
 * console.log(id) // 'blob-2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
 * ```
 */
export declare function generateBlobId(data: Uint8Array): Promise<string>;
/**
 * Generate blob ID from a pre-computed checksum.
 *
 * Use this when the checksum is already available to avoid re-hashing.
 *
 * @param checksum - Pre-computed SHA-256 checksum
 * @returns Content-addressable blob ID
 */
export declare function blobIdFromChecksum(checksum: string): string;
/**
 * Extract checksum from a blob ID.
 *
 * @param blobId - Content-addressable blob ID
 * @returns The checksum portion of the ID, or null if invalid format
 */
export declare function checksumFromBlobId(blobId: string): string | null;
/**
 * Check if a blob ID is valid (has correct prefix and checksum length).
 *
 * @param blobId - Blob ID to validate
 * @returns true if valid blob ID format
 */
export declare function isValidBlobId(blobId: string): boolean;
/**
 * Valid tier transition types.
 */
export type TierTransition = 'promote' | 'demote' | 'none';
/**
 * Determine the type of tier transition.
 *
 * @param from - Current tier
 * @param to - Target tier
 * @returns 'promote' (moving hotter), 'demote' (moving colder), or 'none' (same tier)
 */
export declare function getTierTransition(from: StorageTier, to: StorageTier): TierTransition;
/**
 * Check if a tier transition is valid.
 *
 * All transitions are technically valid, but this function
 * can be extended to enforce policies (e.g., no skip transitions).
 *
 * @param from - Current tier
 * @param to - Target tier
 * @param allowSkip - Whether to allow skipping tiers (e.g., cold -> hot)
 * @returns true if the transition is valid
 */
export declare function isValidTierTransition(from: StorageTier, to: StorageTier, allowSkip?: boolean): boolean;
/**
 * Select the appropriate tier based on blob size.
 *
 * This implements the default tiering policy:
 * - Small blobs (< hotMaxSize) -> hot tier (SQLite)
 * - Large blobs (>= hotMaxSize) -> warm tier (R2)
 *
 * @param size - Blob size in bytes
 * @param hotMaxSize - Maximum size for hot tier (default: 1MB)
 * @param hasR2 - Whether R2 storage is available
 * @returns Recommended storage tier
 */
export declare function selectTierBySize(size: number, hotMaxSize?: number, hasR2?: boolean): StorageTier;
/**
 * Configuration for scheduled blob cleanup.
 */
export interface CleanupConfig {
    /**
     * Minimum number of orphaned blobs before triggering cleanup.
     * @default 10
     */
    minOrphanCount?: number;
    /**
     * Minimum age (ms) of orphaned blobs before they can be cleaned.
     * Provides a grace period for concurrent operations.
     * @default 60000 (1 minute)
     */
    minOrphanAgeMs?: number;
    /**
     * Maximum number of blobs to clean in a single batch.
     * @default 100
     */
    batchSize?: number;
    /**
     * Whether to run cleanup in background (non-blocking).
     * @default true
     */
    async?: boolean;
}
/**
 * Default cleanup configuration.
 */
export declare const DEFAULT_CLEANUP_CONFIG: Required<CleanupConfig>;
/**
 * Result of a cleanup operation.
 */
export interface CleanupResult {
    /** Number of blobs cleaned up */
    cleaned: number;
    /** Number of blobs skipped (e.g., too recent) */
    skipped: number;
    /** Total orphaned blobs found */
    found: number;
    /** Time taken in milliseconds */
    durationMs: number;
}
/**
 * Cleanup scheduler state.
 */
export interface CleanupSchedulerState {
    /** Last cleanup timestamp */
    lastCleanup: number;
    /** Number of cleanups performed */
    cleanupCount: number;
    /** Total blobs cleaned */
    totalCleaned: number;
    /** Whether cleanup is currently running */
    running: boolean;
}
/**
 * Create initial cleanup scheduler state.
 */
export declare function createCleanupSchedulerState(): CleanupSchedulerState;
/**
 * Result of a deduplication check.
 */
export interface DedupCheckResult {
    /** Whether the blob already exists */
    exists: boolean;
    /** The blob ID (same for both existing and new) */
    blobId: string;
    /** Checksum of the content */
    checksum: string;
}
/**
 * Check if content already exists and return dedup info.
 *
 * This is a helper for building dedup-aware storage operations.
 * The actual database check must be performed by the caller.
 *
 * @param data - Binary data to check
 * @returns Dedup check result with blobId and checksum
 */
export declare function prepareDedupCheck(data: Uint8Array): Promise<Omit<DedupCheckResult, 'exists'>>;
/**
 * Blob storage statistics.
 */
export interface BlobStats {
    /** Total number of unique blobs */
    totalBlobs: number;
    /** Total file references to blobs */
    totalRefs: number;
    /** Average references per blob */
    avgRefsPerBlob: number;
    /** Total bytes stored */
    totalBytes: number;
    /** Bytes saved by deduplication */
    savedBytes: number;
    /** Deduplication ratio (refs / blobs) */
    dedupRatio: number;
    /** Stats by tier */
    byTier: Record<StorageTier, {
        count: number;
        bytes: number;
    }>;
}
/**
 * Calculate deduplication savings.
 *
 * @param totalBlobs - Number of unique blobs
 * @param totalRefs - Total number of file references
 * @param avgBlobSize - Average blob size in bytes
 * @returns Bytes saved by deduplication
 */
export declare function calculateDedupSavings(totalBlobs: number, totalRefs: number, avgBlobSize: number): number;
/**
 * Calculate deduplication ratio.
 *
 * A ratio of 1.0 means no deduplication benefit.
 * Higher ratios indicate more deduplication savings.
 *
 * @param totalBlobs - Number of unique blobs
 * @param totalRefs - Total number of file references
 * @returns Deduplication ratio (>= 1.0)
 */
export declare function calculateDedupRatio(totalBlobs: number, totalRefs: number): number;
//# sourceMappingURL=blob-utils.d.ts.map
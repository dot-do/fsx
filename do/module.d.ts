/**
 * FsModule - Filesystem capability module for dotdo integration
 *
 * Provides lazy-loaded filesystem operations that integrate with the
 * WorkflowContext ($) proxy. Uses SQLite for metadata and R2 for tiered blob storage.
 *
 * @category Application
 * @example
 * ```typescript
 * // Using with withFs mixin
 * class MySite extends withFs(DO) {
 *   async loadContent() {
 *     const content = await this.$.fs.readFile('content/index.mdx')
 *     return content
 *   }
 * }
 *
 * // Using FsModule directly
 * const fsModule = new FsModule({ sql: ctx.storage.sql })
 * await fsModule.initialize()
 * await fsModule.writeFile('/config.json', '{"key": "value"}')
 * ```
 */
import type { FsCapability, ReadOptions, WriteOptions, ListOptions, MkdirOptions, RmdirOptions, RemoveOptions, ReaddirOptions, Stats, FSWatcher, WatchOptions, ReadStreamOptions, WriteStreamOptions, MoveOptions, CopyOptions } from '../core/index.js';
import { Dirent, FileHandle } from '../core/index.js';
import { type CleanupConfig, type CleanupResult, type CleanupSchedulerState } from '../storage/blob-utils.js';
export { PathValidator, pathValidator, SecurityConstants } from './security.js';
export type { ValidationResult, ValidationSuccess, ValidationFailure } from './security.js';
export { computeChecksum, generateBlobId, blobIdFromChecksum, checksumFromBlobId, isValidBlobId, selectTierBySize, getTierTransition, isValidTierTransition, type CleanupConfig, type CleanupResult, type CleanupSchedulerState, type BlobStats, } from '../storage/blob-utils.js';
/**
 * Configuration options for FsModule
 */
export interface FsModuleConfig {
    /** SQLite storage instance from Durable Object context */
    sql: SqlStorage;
    /** Optional R2 bucket for warm tier storage */
    r2?: R2Bucket;
    /** Optional R2 bucket for cold/archive tier storage */
    archive?: R2Bucket;
    /** Base path prefix for all operations (default: '/') */
    basePath?: string;
    /** Hot tier max size in bytes (default: 1MB) */
    hotMaxSize?: number;
    /** Default file mode (default: 0o644) */
    defaultMode?: number;
    /** Default directory mode (default: 0o755) */
    defaultDirMode?: number;
    /** Configuration for scheduled blob cleanup */
    cleanupConfig?: CleanupConfig;
}
/**
 * Schema version for migration tracking.
 * Increment when making breaking changes to the schema.
 */
export declare const SCHEMA_VERSION = 1;
/**
 * Valid file types stored in the files table.
 * Used for CHECK constraint and TypeScript type safety.
 */
export declare const FILE_TYPES: readonly ["file", "directory", "symlink"];
export type FileType = (typeof FILE_TYPES)[number];
/**
 * Storage tiers for blob data.
 * - hot: SQLite storage (fast, limited size)
 * - warm: R2 storage (medium latency, larger files)
 * - cold: Archive R2 storage (slow, archival)
 */
export declare const STORAGE_TIERS: readonly ["hot", "warm", "cold"];
export type StorageTier = (typeof STORAGE_TIERS)[number];
/**
 * Default file mode (0o644 = rw-r--r--)
 */
export declare const DEFAULT_FILE_MODE = 420;
/**
 * Default directory mode (0o755 = rwxr-xr-x)
 */
export declare const DEFAULT_DIR_MODE = 493;
/**
 * Column definitions for the files table.
 * Each column specifies its SQL type, constraints, and optional default value.
 */
export declare const FILES_TABLE_COLUMNS: {
    readonly id: {
        readonly type: "INTEGER";
        readonly constraints: "PRIMARY KEY AUTOINCREMENT";
    };
    readonly path: {
        readonly type: "TEXT";
        readonly constraints: "UNIQUE NOT NULL";
    };
    readonly name: {
        readonly type: "TEXT";
        readonly constraints: "NOT NULL";
    };
    readonly parent_id: {
        readonly type: "INTEGER";
        readonly constraints: "";
    };
    readonly type: {
        readonly type: "TEXT";
        readonly constraints: `NOT NULL CHECK(type IN (${string}))`;
    };
    readonly mode: {
        readonly type: "INTEGER";
        readonly constraints: "NOT NULL DEFAULT 420";
    };
    readonly uid: {
        readonly type: "INTEGER";
        readonly constraints: "NOT NULL DEFAULT 0";
    };
    readonly gid: {
        readonly type: "INTEGER";
        readonly constraints: "NOT NULL DEFAULT 0";
    };
    readonly size: {
        readonly type: "INTEGER";
        readonly constraints: "NOT NULL DEFAULT 0";
    };
    readonly blob_id: {
        readonly type: "TEXT";
        readonly constraints: "";
    };
    readonly link_target: {
        readonly type: "TEXT";
        readonly constraints: "";
    };
    readonly tier: {
        readonly type: "TEXT";
        readonly constraints: `NOT NULL DEFAULT 'hot' CHECK(tier IN (${string}))`;
    };
    readonly atime: {
        readonly type: "INTEGER";
        readonly constraints: "NOT NULL";
    };
    readonly mtime: {
        readonly type: "INTEGER";
        readonly constraints: "NOT NULL";
    };
    readonly ctime: {
        readonly type: "INTEGER";
        readonly constraints: "NOT NULL";
    };
    readonly birthtime: {
        readonly type: "INTEGER";
        readonly constraints: "NOT NULL";
    };
    readonly nlink: {
        readonly type: "INTEGER";
        readonly constraints: "NOT NULL DEFAULT 1";
    };
};
/**
 * Column definitions for the blobs table.
 * Stores binary content with tiered storage support.
 * Content-addressable: id is derived from SHA-256 hash of content.
 * ref_count tracks how many files reference this blob for dedup and cleanup.
 */
export declare const BLOBS_TABLE_COLUMNS: {
    readonly id: {
        readonly type: "TEXT";
        readonly constraints: "PRIMARY KEY";
    };
    readonly data: {
        readonly type: "BLOB";
        readonly constraints: "";
    };
    readonly size: {
        readonly type: "INTEGER";
        readonly constraints: "NOT NULL";
    };
    readonly checksum: {
        readonly type: "TEXT";
        readonly constraints: "NOT NULL";
    };
    readonly tier: {
        readonly type: "TEXT";
        readonly constraints: `NOT NULL DEFAULT 'hot' CHECK(tier IN (${string}))`;
    };
    readonly ref_count: {
        readonly type: "INTEGER";
        readonly constraints: "NOT NULL DEFAULT 1";
    };
    readonly created_at: {
        readonly type: "INTEGER";
        readonly constraints: "NOT NULL";
    };
};
/**
 * Index definitions for performance optimization.
 * Each index targets specific query patterns.
 */
export declare const SCHEMA_INDEXES: {
    /** Fast path lookups: SELECT * FROM files WHERE path = ? */
    readonly idx_files_path: {
        readonly table: "files";
        readonly columns: readonly ["path"];
    };
    /** Fast directory listings: SELECT * FROM files WHERE parent_id = ? */
    readonly idx_files_parent: {
        readonly table: "files";
        readonly columns: readonly ["parent_id"];
    };
    /** Tier-based queries for storage management */
    readonly idx_files_tier: {
        readonly table: "files";
        readonly columns: readonly ["tier"];
    };
    /** Tier-based blob queries for storage management */
    readonly idx_blobs_tier: {
        readonly table: "blobs";
        readonly columns: readonly ["tier"];
    };
};
/**
 * FsModule - Filesystem capability for Durable Object integration
 *
 * Implements the FsCapability interface with lazy initialization,
 * SQLite-backed metadata, and tiered blob storage (DO SQLite + R2).
 */
/**
 * Transaction log entry structure for FsModule
 */
interface FsTransactionLogEntry {
    id: string;
    status: 'active' | 'committed' | 'rolled_back';
    startTime: number;
    endTime?: number;
}
export declare class FsModule implements FsCapability {
    readonly name = "fs";
    private sql;
    private r2?;
    private archive?;
    private basePath;
    private hotMaxSize;
    private defaultMode;
    private defaultDirMode;
    private initialized;
    private transactionDepth;
    private savepointCounter;
    private transactionLog;
    private currentTransactionId;
    private cleanupConfig;
    private cleanupState;
    constructor(config: FsModuleConfig);
    /**
     * Begin a new transaction or create a savepoint for nested transactions.
     * @param options - Optional transaction options (timeout, etc.)
     */
    beginTransaction(_options?: {
        timeout?: number;
    }): Promise<void>;
    /**
     * Commit the current transaction or release savepoint.
     */
    commit(): Promise<void>;
    /**
     * Rollback the current transaction or to savepoint.
     */
    rollback(): Promise<void>;
    /**
     * Execute a function within a transaction with automatic commit/rollback.
     * @param fn - Function to execute within transaction
     * @returns Result of the function
     */
    transaction<T>(fn: () => Promise<T>): Promise<T>;
    /**
     * Get the transaction log entries.
     */
    getTransactionLog(): Promise<FsTransactionLogEntry[]>;
    /**
     * Recover from uncommitted transactions (for crash recovery).
     */
    recoverTransactions(): Promise<void>;
    /**
     * Check if currently in a transaction.
     */
    isInTransaction(): boolean;
    /**
     * Initialize the module - creates schema and root directory
     */
    initialize(): Promise<void>;
    /**
     * Cleanup hook for capability disposal
     */
    dispose(): Promise<void>;
    private normalizePath;
    private getParentPath;
    private getFileName;
    private getFile;
    private selectTier;
    /**
     * Compute SHA-256 hash of data and return as hex string.
     * Uses shared utility from storage/blob-utils.ts.
     */
    private computeBlobChecksum;
    /**
     * Generate content-addressable blob ID from checksum.
     * Uses shared utility from storage/blob-utils.ts.
     */
    private generateBlobIdFromChecksum;
    /**
     * Store blob with content-addressable ID and reference counting.
     * If blob already exists (same content), just increment ref_count.
     * Returns the blob ID.
     *
     * Optimized deduplication: uses single query to check existence
     * and atomic UPDATE for ref_count increment.
     */
    private storeBlob;
    /**
     * Decrement blob reference count. If ref_count reaches 0, delete the blob.
     */
    private decrementBlobRef;
    /**
     * Completely delete a blob from storage
     */
    private deleteBlobCompletely;
    /**
     * Increment blob reference count (for hard links)
     */
    private incrementBlobRef;
    private getBlob;
    private deleteBlob;
    read(path: string, options?: ReadOptions): Promise<string | Uint8Array>;
    write(path: string, data: string | Uint8Array, options?: WriteOptions): Promise<void>;
    append(path: string, data: string | Uint8Array): Promise<void>;
    unlink(path: string): Promise<void>;
    rename(oldPath: string, newPath: string, options?: MoveOptions): Promise<void>;
    copyFile(src: string, dest: string, options?: CopyOptions): Promise<void>;
    truncate(path: string, length?: number): Promise<void>;
    mkdir(path: string, options?: MkdirOptions): Promise<void>;
    rmdir(path: string, options?: RmdirOptions): Promise<void>;
    private deleteRecursive;
    rm(path: string, options?: RemoveOptions): Promise<void>;
    list(path: string, options?: ListOptions): Promise<string[] | Dirent[]>;
    readdir(path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]>;
    stat(path: string): Promise<Stats>;
    lstat(path: string): Promise<Stats>;
    private fileToStats;
    exists(path: string): Promise<boolean>;
    access(path: string, _mode?: number): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
    chown(path: string, uid: number, gid: number): Promise<void>;
    utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void>;
    symlink(target: string, path: string): Promise<void>;
    link(existingPath: string, newPath: string): Promise<void>;
    readlink(path: string): Promise<string>;
    realpath(path: string): Promise<string>;
    createReadStream(path: string, options?: ReadStreamOptions): Promise<ReadableStream<Uint8Array>>;
    createWriteStream(path: string, options?: WriteStreamOptions): Promise<WritableStream<Uint8Array>>;
    open(path: string, flags?: string | number, mode?: number): Promise<FileHandle>;
    watch(_path: string, _options?: WatchOptions, _listener?: (eventType: 'rename' | 'change', filename: string) => void): FSWatcher;
    promote(path: string, tier: 'hot' | 'warm'): Promise<void>;
    demote(path: string, tier: 'warm' | 'cold'): Promise<void>;
    /**
     * Move a blob from one tier to another, preserving its ID and ref_count.
     */
    private moveBlobToTier;
    getTier(path: string): Promise<'hot' | 'warm' | 'cold'>;
    /**
     * Copy a directory recursively with atomic transaction semantics.
     * Either all files are copied or none (rollback on failure).
     *
     * @param src - Source directory path
     * @param dest - Destination directory path
     * @param options - Copy options
     */
    copyDir(src: string, dest: string, options?: {
        recursive?: boolean;
        preserveMetadata?: boolean;
    }): Promise<void>;
    /**
     * Helper to recursively copy directory contents within a transaction.
     */
    private copyDirContents;
    /**
     * Write multiple files atomically. Either all succeed or all are rolled back.
     * Note: In Cloudflare Durable Objects, each request is processed atomically.
     *
     * @param files - Array of file paths and content to write
     */
    writeMany(files: Array<{
        path: string;
        content: string | Uint8Array;
    }>): Promise<void>;
    /**
     * Soft delete a file or directory. The entry is marked for deletion but
     * only physically removed on commit.
     *
     * @param path - Path to delete
     * @param options - Delete options
     */
    softDelete(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    /**
     * Get information about a blob by file path.
     *
     * @param path - The file path to look up
     * @returns Blob information or null if not found
     */
    getBlobInfoByPath(path: string): Promise<{
        blobId: string;
        size: number;
        checksum: string;
        tier: StorageTier;
        refCount: number;
        createdAt: number;
    } | null>;
    /**
     * Get information about a blob by ID.
     *
     * @param blobId - The blob ID to look up
     * @returns Blob information or null if not found
     */
    getBlobInfo(blobId: string): Promise<{
        id: string;
        size: number;
        checksum: string;
        tier: StorageTier;
        ref_count: number;
        created_at: number;
    } | null>;
    /**
     * Get a blob by its ID, returning both metadata and data.
     *
     * @param blobId - The blob ID to retrieve
     * @returns Blob data and metadata or null if not found
     */
    getBlobById(blobId: string): Promise<{
        id: string;
        data: Uint8Array;
        size: number;
        checksum: string;
        tier: StorageTier;
    } | null>;
    /**
     * Verify the integrity of a blob by checking its checksum.
     *
     * @param blobId - The blob ID to verify
     * @returns Object with valid flag and details
     */
    verifyBlobIntegrity(blobId: string): Promise<{
        valid: boolean;
        storedChecksum: string;
        actualChecksum: string;
        size: number;
    }>;
    /**
     * Verify a checksum matches for given data content.
     *
     * @param checksum - Expected checksum
     * @param content - Content to verify (string or Uint8Array)
     * @returns true if checksum matches
     */
    verifyChecksum(checksum: string, content: string | Uint8Array): Promise<boolean>;
    /**
     * List all orphaned blobs (blobs with ref_count = 0).
     *
     * @returns Array of orphaned blob IDs
     */
    listOrphanedBlobs(): Promise<string[]>;
    /**
     * Clean up all orphaned blobs (blobs with ref_count = 0).
     *
     * @returns Number of blobs cleaned up
     */
    cleanupOrphanedBlobs(): Promise<number>;
    /**
     * Get statistics about blobs by storage tier.
     *
     * @returns Object with counts and sizes by tier
     */
    getTierStats(): Promise<{
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
     * Get deduplication statistics.
     *
     * @returns Object with deduplication metrics
     */
    getDedupStats(): Promise<{
        totalBlobs: number;
        uniqueBlobs: number;
        totalRefs: number;
        dedupRatio: number;
        savedBytes: number;
    }>;
    /**
     * Get the reference count for a blob.
     *
     * @param blobId - The blob ID to check
     * @returns Reference count or 0 if not found
     */
    getBlobRefCount(blobId: string): Promise<number>;
    /**
     * Get the current cleanup scheduler state.
     *
     * @returns Current cleanup scheduler state
     */
    getCleanupState(): CleanupSchedulerState;
    /**
     * Check if cleanup should be triggered based on current conditions.
     *
     * @returns true if cleanup should run
     */
    shouldRunCleanup(): Promise<boolean>;
    /**
     * Count orphaned blobs that are eligible for cleanup.
     *
     * @returns Number of orphaned blobs
     */
    private countOrphanedBlobs;
    /**
     * Run scheduled cleanup of orphaned blobs.
     *
     * This method respects the cleanup configuration:
     * - minOrphanCount: Minimum orphans before cleanup triggers
     * - minOrphanAgeMs: Grace period for recently orphaned blobs
     * - batchSize: Maximum blobs to clean per invocation
     *
     * @param force - Force cleanup even if thresholds not met
     * @returns Cleanup result with statistics
     */
    runScheduledCleanup(force?: boolean): Promise<CleanupResult>;
    /**
     * Trigger background cleanup if conditions are met.
     *
     * This is a non-blocking method that can be called after
     * file operations to opportunistically clean up orphans.
     *
     * @returns Promise that resolves when cleanup check is scheduled
     */
    maybeRunBackgroundCleanup(): Promise<void>;
    /**
     * Get cleanup configuration.
     *
     * @returns Current cleanup configuration
     */
    getCleanupConfig(): Required<CleanupConfig>;
    /**
     * Update cleanup configuration.
     *
     * @param config - Partial configuration to merge
     */
    setCleanupConfig(config: Partial<CleanupConfig>): void;
}
//# sourceMappingURL=module.d.ts.map
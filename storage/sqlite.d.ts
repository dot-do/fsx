/**
 * SQLiteMetadata - SQLite-backed metadata store for fsx
 *
 * Stores filesystem metadata in SQLite (via Durable Objects or D1).
 * Implements the {@link MetadataStorage} interface for consistent API.
 *
 * ## Features
 *
 * - INTEGER PRIMARY KEY for efficient rowid-based lookups
 * - Foreign key constraints for referential integrity
 * - Indexed paths and parent relationships for fast traversal
 * - Tiered storage tracking for hot/warm/cold placement
 * - Blob reference management with checksums and reference counting
 * - Full transaction support with savepoints for nested transactions
 * - Automatic retry logic for transient failures
 * - Configurable timeout handling
 * - Instrumentation hooks for logging and metrics
 *
 * ## Schema
 *
 * - `files` table: filesystem entries (files, directories, symlinks)
 * - `blobs` table: blob storage references with tier tracking and ref_count
 *
 * ## Transaction Isolation
 *
 * SQLite in Durable Objects operates in SERIALIZABLE isolation mode, which is
 * the strongest isolation level. This means:
 *
 * - **Read Committed**: All reads within a transaction see a consistent snapshot
 * - **Repeatable Reads**: Multiple reads of the same data return identical results
 * - **Phantom Prevention**: New rows inserted by other transactions are not visible
 * - **No Dirty Reads**: Only committed data is ever visible
 *
 * Since Durable Objects use a single-connection model, there is no concurrent
 * transaction contention. All transactions are effectively serialized through
 * the Durable Object's input gate.
 *
 * ## Concurrent Access Patterns
 *
 * The implementation is optimized for Durable Object's single-connection model:
 *
 * - Operations are naturally serialized through the DO input gate
 * - Reference counting uses atomic SQL operations (UPDATE ... SET ref_count = ref_count + 1)
 * - Nested transactions use SQLite savepoints for proper isolation
 * - Batch operations are wrapped in transactions for atomicity
 *
 * @example
 * ```typescript
 * const metadata = new SQLiteMetadata(ctx.storage.sql)
 * await metadata.init()
 *
 * // Create a file entry
 * const id = await metadata.createEntry({
 *   path: '/data/config.json',
 *   name: 'config.json',
 *   parentId: parentDirId,
 *   type: 'file',
 *   mode: 0o644,
 *   uid: 0,
 *   gid: 0,
 *   size: 1024,
 *   blobId: 'abc123',
 *   linkTarget: null,
 *   nlink: 1,
 *   tier: 'hot'
 * })
 *
 * // Query by path
 * const entry = await metadata.getByPath('/data/config.json')
 *
 * // Use transaction with automatic retry
 * await metadata.transaction(async () => {
 *   await metadata.createEntry(...)
 *   await metadata.incrementBlobRefCount(...)
 * }, { maxRetries: 3, retryDelayMs: 100 })
 * ```
 *
 * @module storage/sqlite
 */
import type { FileEntry, BlobRef, StorageTier } from '../core/index.js';
import type { MetadataStorage, CreateEntryOptions, UpdateEntryOptions, StorageStats } from './interfaces.js';
/**
 * SQLiteMetadata - Filesystem metadata backed by SQLite.
 *
 * Implements the {@link MetadataStorage} interface for storing filesystem
 * structure and metadata in SQLite. Designed for use with Durable Objects
 * SqlStorage or D1.
 *
 * The implementation uses:
 * - INTEGER PRIMARY KEY AUTOINCREMENT for efficient rowid lookups
 * - Indexes on path, parent_id, and tier for fast queries
 * - Foreign keys with CASCADE delete for referential integrity
 * - CHECK constraints for valid tier values
 *
 * @implements {MetadataStorage}
 *
 * @example
 * ```typescript
 * // In a Durable Object
 * class MyDO extends DurableObject {
 *   private metadata: SQLiteMetadata
 *
 *   constructor(ctx: DurableObjectState) {
 *     this.metadata = new SQLiteMetadata(ctx.storage.sql)
 *   }
 *
 *   async fetch(request: Request) {
 *     await this.metadata.init()
 *     const root = await this.metadata.getByPath('/')
 *     // ...
 *   }
 * }
 * ```
 */
/**
 * Transaction log entry structure for tracking transaction lifecycle.
 *
 * Provides detailed information about each transaction for debugging,
 * auditing, and metrics collection.
 */
interface TransactionLogEntry {
    /** Unique transaction identifier (UUID) */
    id: string;
    /** Current transaction status */
    status: 'active' | 'committed' | 'rolled_back' | 'timed_out';
    /** Transaction start timestamp (Unix ms) */
    startTime: number;
    /** Transaction end timestamp (Unix ms), set on commit/rollback */
    endTime?: number;
    /** Number of operations performed in this transaction */
    operationCount?: number;
    /** Reason for rollback (if applicable) */
    rollbackReason?: string;
    /** Number of retry attempts (if retries were configured) */
    retryCount?: number;
}
/**
 * Options for transaction execution with retry and timeout support.
 */
export interface TransactionOptions {
    /**
     * Maximum number of retry attempts for transient failures.
     * Default: 0 (no retries)
     */
    maxRetries?: number;
    /**
     * Delay between retry attempts in milliseconds.
     * Default: 100ms
     */
    retryDelayMs?: number;
    /**
     * Transaction timeout in milliseconds.
     * If exceeded, the transaction will be rolled back.
     * Default: undefined (no timeout)
     */
    timeoutMs?: number;
    /**
     * Function to determine if an error is retryable.
     * Default: retries on SQLITE_BUSY errors
     */
    isRetryable?: (error: Error) => boolean;
}
/**
 * Transaction event types for instrumentation hooks.
 */
export type TransactionEventType = 'begin' | 'commit' | 'rollback' | 'timeout' | 'retry' | 'operation';
/**
 * Transaction event data passed to hooks.
 */
export interface TransactionEvent {
    /** Event type */
    type: TransactionEventType;
    /** Transaction ID */
    transactionId: string;
    /** Event timestamp (Unix ms) */
    timestamp: number;
    /** Transaction depth (for nested transactions) */
    depth: number;
    /** Duration in milliseconds (for commit/rollback events) */
    durationMs?: number;
    /** Error (for rollback/timeout events) */
    error?: Error;
    /** Retry attempt number (for retry events) */
    retryAttempt?: number;
    /** Operation name (for operation events) */
    operation?: string;
}
/**
 * Instrumentation hooks for transaction monitoring.
 *
 * These hooks enable external systems to observe transaction lifecycle
 * events for metrics, logging, and debugging purposes.
 *
 * @example
 * ```typescript
 * const hooks: TransactionHooks = {
 *   onTransactionEvent: (event) => {
 *     console.log(`[TX:${event.transactionId}] ${event.type}`)
 *     if (event.type === 'commit') {
 *       metrics.recordLatency('tx_commit', event.durationMs)
 *     }
 *   }
 * }
 *
 * const metadata = new SQLiteMetadata(sql, { hooks })
 * ```
 */
export interface TransactionHooks {
    /**
     * Called for each transaction lifecycle event.
     */
    onTransactionEvent?(event: TransactionEvent): void;
}
/**
 * Configuration options for SQLiteMetadata.
 */
export interface SQLiteMetadataOptions {
    /**
     * Instrumentation hooks for monitoring.
     */
    hooks?: TransactionHooks;
    /**
     * Maximum transaction log entries to retain.
     * Older entries are pruned on new transaction start.
     * Default: 100
     */
    maxLogEntries?: number;
    /**
     * Default transaction options applied to all transactions.
     */
    defaultTransactionOptions?: TransactionOptions;
}
export declare class SQLiteMetadata implements MetadataStorage {
    /** SQLite storage instance */
    private readonly sql;
    /** Configuration options */
    private readonly options;
    /** Current transaction depth (0 = no transaction) */
    private transactionDepth;
    /** Savepoint counter for nested transactions */
    private savepointCounter;
    /** Transaction log for recovery and auditing */
    private transactionLog;
    /** Current transaction ID */
    private currentTransactionId;
    /** Current transaction start time (for timeout tracking) */
    private currentTransactionStartTime;
    /** Operation counter for current transaction */
    private currentTransactionOperationCount;
    /** Timeout handle for current transaction */
    private transactionTimeoutHandle;
    /**
     * Prepared statement cache for frequently used queries.
     *
     * Maps statement keys to cached SQL templates with execution statistics.
     * This enables query pattern reuse and performance monitoring.
     *
     * @internal
     */
    private readonly statementCache;
    /**
     * Create a new SQLiteMetadata instance.
     *
     * The constructor initializes the prepared statement cache with optimized
     * SQL templates for common operations. This improves query construction
     * performance and provides execution statistics for monitoring.
     *
     * @param sql - SqlStorage instance from Durable Object context or D1
     * @param options - Optional configuration including hooks and defaults
     *
     * @example
     * ```typescript
     * // Basic usage
     * const metadata = new SQLiteMetadata(ctx.storage.sql)
     *
     * // With instrumentation hooks
     * const metadata = new SQLiteMetadata(ctx.storage.sql, {
     *   hooks: {
     *     onTransactionEvent: (event) => {
     *       console.log(`[TX] ${event.type}: ${event.transactionId}`)
     *     }
     *   },
     *   maxLogEntries: 50,
     *   defaultTransactionOptions: {
     *     maxRetries: 3,
     *     retryDelayMs: 100,
     *     timeoutMs: 5000
     *   }
     * })
     * ```
     */
    constructor(sql: SqlStorage, options?: SQLiteMetadataOptions);
    /**
     * Initialize the prepared statement cache with optimized SQL templates.
     *
     * Pre-caches frequently used queries to avoid repeated string construction.
     * Each cached statement includes execution statistics for performance monitoring.
     *
     * @internal
     */
    private initStatementCache;
    /**
     * Execute a cached prepared statement with parameters.
     *
     * Retrieves the SQL template from cache and executes it with the provided
     * parameters. Updates execution statistics for performance monitoring.
     *
     * @typeParam T - Expected result type
     * @param key - Statement cache key
     * @param params - Query parameters
     * @returns Query result with one() and toArray() methods
     *
     * @internal
     */
    private execCached;
    /**
     * Execute a cached prepared statement that doesn't return data.
     *
     * Used for INSERT, UPDATE, DELETE statements where no result is needed.
     * Updates execution statistics for performance monitoring.
     *
     * @param key - Statement cache key
     * @param params - Query parameters
     *
     * @internal
     */
    private execCachedNoReturn;
    /**
     * Get statement cache statistics for performance monitoring.
     *
     * Returns execution statistics for all cached statements, useful for
     * identifying slow queries and optimization opportunities.
     *
     * @returns Map of statement keys to their execution statistics
     *
     * @example
     * ```typescript
     * const stats = metadata.getStatementStats()
     * for (const [key, stat] of stats) {
     *   const avgMs = stat.totalExecutionTime / stat.executionCount
     *   console.log(`${key}: ${stat.executionCount} calls, avg ${avgMs.toFixed(2)}ms`)
     * }
     * ```
     */
    getStatementStats(): Map<string, {
        executionCount: number;
        totalExecutionTime: number;
        avgExecutionTime: number;
    }>;
    /**
     * Emit a transaction event to registered hooks.
     * @internal
     */
    private emitTransactionEvent;
    /**
     * Prune old transaction log entries to stay within configured limit.
     * @internal
     */
    private pruneTransactionLog;
    /**
     * Default function to determine if an error is retryable.
     * @internal
     */
    private isDefaultRetryable;
    /**
     * Sleep for the specified duration.
     * @internal
     */
    private sleep;
    /**
     * Begin a new transaction or create a savepoint for nested transactions.
     *
     * This method supports both top-level transactions and nested transactions
     * (via SQLite savepoints). The timeout option can be used to automatically
     * rollback long-running transactions.
     *
     * ## Transaction Isolation
     *
     * SQLite in Durable Objects uses SERIALIZABLE isolation:
     * - All operations see a consistent snapshot of the database
     * - No dirty reads, phantom reads, or non-repeatable reads
     * - Concurrent transactions are serialized through the DO input gate
     *
     * @param options - Optional transaction configuration
     * @param options.timeout - Maximum duration in ms before auto-rollback
     *
     * @example
     * ```typescript
     * // Basic transaction
     * await metadata.beginTransaction()
     * try {
     *   await metadata.createEntry(...)
     *   await metadata.commit()
     * } catch (e) {
     *   await metadata.rollback()
     * }
     *
     * // With timeout
     * await metadata.beginTransaction({ timeout: 5000 })
     * ```
     */
    beginTransaction(options?: {
        timeout?: number;
    }): Promise<void>;
    /**
     * Commit the current transaction or release savepoint.
     *
     * For top-level transactions, this commits all changes to the database.
     * For nested transactions (savepoints), this releases the savepoint,
     * merging changes into the parent transaction.
     *
     * @throws Error if no active transaction exists
     *
     * @example
     * ```typescript
     * await metadata.beginTransaction()
     * await metadata.createEntry(...)
     * await metadata.commit() // Changes are now permanent
     * ```
     */
    commit(): Promise<void>;
    /**
     * Rollback the current transaction or to savepoint.
     *
     * For top-level transactions, this discards all changes made since
     * beginTransaction() was called. For nested transactions, this rolls
     * back to the savepoint, discarding changes in the nested scope.
     *
     * @param reason - Optional reason for the rollback (for logging)
     * @throws Error if no active transaction exists
     *
     * @example
     * ```typescript
     * await metadata.beginTransaction()
     * try {
     *   await metadata.createEntry(...)
     *   throw new Error('Something went wrong')
     * } catch (e) {
     *   await metadata.rollback('Error during creation')
     * }
     * ```
     */
    rollback(reason?: string): Promise<void>;
    /**
     * Execute a function within a transaction with automatic commit/rollback.
     *
     * This is the recommended way to execute transactional operations. The
     * transaction is automatically committed on success or rolled back on error.
     *
     * ## Retry Support
     *
     * When `maxRetries` is specified, the transaction will be retried on
     * transient failures (e.g., SQLITE_BUSY). Each retry starts a fresh
     * transaction.
     *
     * ## Timeout Support
     *
     * When `timeoutMs` is specified, the transaction will be automatically
     * rolled back if it exceeds the timeout duration.
     *
     * @param fn - Function to execute within the transaction
     * @param options - Transaction options (retries, timeout)
     * @returns Result of the function
     *
     * @example
     * ```typescript
     * // Basic usage
     * const result = await metadata.transaction(async () => {
     *   const id = await metadata.createEntry(...)
     *   await metadata.incrementBlobRefCount(...)
     *   return id
     * })
     *
     * // With retry logic
     * await metadata.transaction(async () => {
     *   await metadata.createEntriesAtomic(entries)
     * }, { maxRetries: 3, retryDelayMs: 100 })
     *
     * // With timeout
     * await metadata.transaction(async () => {
     *   await metadata.heavyOperation()
     * }, { timeoutMs: 5000 })
     * ```
     */
    transaction<T>(fn: () => Promise<T>, options?: TransactionOptions): Promise<T>;
    /**
     * Get the transaction log entries for debugging and auditing.
     *
     * Returns a copy of the internal transaction log. The log is automatically
     * pruned to stay within the configured `maxLogEntries` limit.
     *
     * @returns Array of transaction log entries (most recent last)
     *
     * @example
     * ```typescript
     * const log = await metadata.getTransactionLog()
     * const failed = log.filter(e => e.status === 'rolled_back')
     * console.log(`${failed.length} transactions rolled back`)
     * ```
     */
    getTransactionLog(): Promise<TransactionLogEntry[]>;
    /**
     * Recover from uncommitted transactions (for crash recovery).
     *
     * This method should be called after a Durable Object hibernates and
     * wakes up, to ensure local state is synchronized. SQLite automatically
     * rolls back uncommitted transactions on connection close/recovery.
     *
     * @example
     * ```typescript
     * // In DO alarm handler or after hibernation
     * await metadata.recoverTransactions()
     * ```
     */
    recoverTransactions(): Promise<void>;
    /**
     * Check if currently within a transaction.
     *
     * Useful for conditional logic that needs to know the current
     * transaction state.
     *
     * @returns true if a transaction is active
     *
     * @example
     * ```typescript
     * if (!metadata.isInTransaction()) {
     *   await metadata.beginTransaction()
     * }
     * ```
     */
    isInTransaction(): boolean;
    /**
     * Get the current transaction depth.
     *
     * Returns 0 if not in a transaction, 1 for top-level transaction,
     * and higher values for nested transactions (savepoints).
     *
     * @returns Current transaction nesting depth
     */
    getTransactionDepth(): number;
    /**
     * Track an operation within the current transaction.
     *
     * Call this method within transactions to increment the operation
     * counter, which is useful for debugging and metrics.
     *
     * @param operationName - Name of the operation being performed
     * @internal
     */
    protected trackOperation(operationName: string): void;
    /**
     * Create multiple entries atomically within a transaction.
     *
     * This method is optimized for bulk inserts by:
     * - Wrapping all inserts in a single transaction (automatic via transaction())
     * - Reusing cached prepared statement for each insert
     * - Batching ID lookups to minimize round trips
     *
     * ## Performance Characteristics
     *
     * - Single transaction commit overhead regardless of entry count
     * - O(n) insert operations using cached statements
     * - All-or-nothing semantics: either all entries are created or none
     *
     * ## Usage Recommendations
     *
     * - Use for creating multiple files/directories in one operation
     * - Particularly efficient for directory tree creation
     * - For very large batches (>1000 entries), consider chunking
     *
     * @param entries - Array of entries to create
     * @returns Array of created entry IDs in the same order as input
     * @throws If any entry creation fails (all changes are rolled back)
     *
     * @example
     * ```typescript
     * // Create multiple files atomically
     * const ids = await metadata.createEntriesAtomic([
     *   { path: '/data/file1.txt', name: 'file1.txt', ... },
     *   { path: '/data/file2.txt', name: 'file2.txt', ... },
     *   { path: '/data/file3.txt', name: 'file3.txt', ... },
     * ])
     * // Either all files are created, or none
     * ```
     */
    createEntriesAtomic(entries: Array<{
        path: string;
        name: string;
        parentId: string;
        type: 'file' | 'directory' | 'symlink';
        mode: number;
        uid: number;
        gid: number;
        size: number;
        blobId: string | null;
        linkTarget: string | null;
        nlink: number;
        tier?: StorageTier;
    }>): Promise<number[]>;
    /**
     * Delete multiple entries atomically within a transaction.
     *
     * Deletes all specified entries in a single transaction. If any deletion
     * fails, all changes are rolled back.
     *
     * ## Performance Characteristics
     *
     * - Single transaction commit overhead
     * - Cascade deletes handled by SQLite foreign keys
     * - All-or-nothing semantics
     *
     * @param ids - Array of entry IDs to delete
     * @throws If any deletion fails (all changes are rolled back)
     *
     * @example
     * ```typescript
     * // Delete multiple entries atomically
     * await metadata.deleteEntriesAtomic(['1', '2', '3'])
     * ```
     */
    deleteEntriesAtomic(ids: string[]): Promise<void>;
    /**
     * Register multiple blobs atomically within a transaction.
     *
     * Creates multiple blob references in a single transaction for
     * optimal performance when uploading multiple files.
     *
     * @param blobs - Array of blob metadata to register
     * @throws If any registration fails (all changes are rolled back)
     *
     * @example
     * ```typescript
     * await metadata.registerBlobsAtomic([
     *   { id: 'blob-1', tier: 'hot', size: 1024 },
     *   { id: 'blob-2', tier: 'hot', size: 2048 },
     * ])
     * ```
     */
    registerBlobsAtomic(blobs: Array<{
        id: string;
        tier: StorageTier;
        size: number;
        checksum?: string;
    }>): Promise<void>;
    /**
     * Initialize the database schema.
     *
     * Creates the required tables and indexes if they don't exist.
     * Safe to call multiple times (uses IF NOT EXISTS).
     *
     * Tables created:
     * - `files`: Filesystem entries with metadata
     * - `blobs`: Blob storage references
     *
     * Also creates the root directory entry if it doesn't exist.
     *
     * @example
     * ```typescript
     * const metadata = new SQLiteMetadata(sql)
     * await metadata.init() // Creates schema
     * await metadata.init() // Safe to call again
     * ```
     */
    init(): Promise<void>;
    /**
     * Convert an internal FileRow to the public FileEntry interface.
     *
     * Transforms snake_case column names to camelCase and converts
     * numeric IDs to strings for external use.
     *
     * @param row - Internal database row
     * @returns Public FileEntry object
     * @internal
     */
    private rowToEntry;
    /**
     * Get a file entry by its absolute path.
     *
     * Uses the indexed path column for efficient lookup. This method uses
     * prepared statement caching for optimal performance on repeated queries.
     *
     * ## Performance
     *
     * - Uses cached prepared statement for query construction
     * - Path index provides O(log n) lookup performance
     * - Statement execution statistics available via getStatementStats()
     *
     * @param path - Absolute file path (e.g., '/data/config.json')
     * @returns FileEntry if found, null otherwise
     *
     * @example
     * ```typescript
     * const entry = await metadata.getByPath('/etc/config.json')
     * if (entry && entry.type === 'file') {
     *   console.log(`File size: ${entry.size}`)
     * }
     * ```
     */
    getByPath(path: string): Promise<FileEntry | null>;
    /**
     * Get a file entry by its numeric ID.
     *
     * Uses the primary key for O(1) lookup performance. This method uses
     * prepared statement caching for optimal performance.
     *
     * ## Performance
     *
     * - Uses cached prepared statement for query construction
     * - Primary key lookup provides O(1) performance
     * - Validates ID format before querying to avoid unnecessary database access
     *
     * @param id - Entry ID as string (will be parsed to number)
     * @returns FileEntry if found, null otherwise
     *
     * @example
     * ```typescript
     * const entry = await metadata.getById('42')
     * if (entry) {
     *   console.log(`Path: ${entry.path}`)
     * }
     * ```
     */
    getById(id: string): Promise<FileEntry | null>;
    /**
     * Get all children of a directory.
     *
     * Uses the indexed parent_id column for efficient queries. This method uses
     * prepared statement caching for optimal performance.
     *
     * ## Performance
     *
     * - Uses cached prepared statement for query construction
     * - Parent ID index provides O(log n + m) performance where m is result count
     * - Validates ID format before querying to avoid unnecessary database access
     *
     * @param parentId - Parent directory ID as string
     * @returns Array of child FileEntry objects
     *
     * @example
     * ```typescript
     * const root = await metadata.getByPath('/')
     * const children = await metadata.getChildren(root!.id)
     * for (const child of children) {
     *   console.log(`${child.name} (${child.type})`)
     * }
     * ```
     */
    getChildren(parentId: string): Promise<FileEntry[]>;
    /**
     * Create a new file or directory entry.
     *
     * The entry ID is auto-generated by SQLite. Timestamps (atime, mtime,
     * ctime, birthtime) are automatically set to the current time.
     *
     * @param entry - Entry creation options
     * @returns The generated entry ID
     * @throws If path already exists (UNIQUE constraint)
     *
     * @example
     * ```typescript
     * const id = await metadata.createEntry({
     *   path: '/data/new-file.txt',
     *   name: 'new-file.txt',
     *   parentId: parentDir.id,
     *   type: 'file',
     *   mode: 0o644,
     *   uid: 0,
     *   gid: 0,
     *   size: 0,
     *   blobId: null,
     *   linkTarget: null,
     *   nlink: 1,
     *   tier: 'hot'
     * })
     * ```
     */
    createEntry(entry: CreateEntryOptions): Promise<number>;
    /**
     * Update an existing file entry.
     *
     * Only the specified fields are updated. The ctime (status change time)
     * is automatically updated to the current time on every update.
     *
     * @param id - Entry ID to update
     * @param updates - Fields to update (partial)
     *
     * @example
     * ```typescript
     * // Update file size after write
     * await metadata.updateEntry(entry.id, {
     *   size: newSize,
     *   mtime: Date.now()
     * })
     *
     * // Move file to different directory
     * await metadata.updateEntry(entry.id, {
     *   path: '/new/path/file.txt',
     *   name: 'file.txt',
     *   parentId: newParentId
     * })
     *
     * // Change storage tier
     * await metadata.updateEntry(entry.id, { tier: 'cold' })
     * ```
     */
    updateEntry(id: string, updates: UpdateEntryOptions): Promise<void>;
    /**
     * Delete a file entry.
     *
     * Uses CASCADE delete to automatically remove child entries
     * when deleting a directory. This method uses prepared statement
     * caching for optimal performance.
     *
     * ## Performance
     *
     * - Uses cached prepared statement for query construction
     * - CASCADE delete handled by SQLite foreign key constraints
     * - Validates ID format before querying to avoid unnecessary database access
     *
     * @param id - Entry ID to delete
     *
     * @example
     * ```typescript
     * await metadata.deleteEntry(entry.id)
     * ```
     */
    deleteEntry(id: string): Promise<void>;
    /**
     * Register a blob in the metadata store.
     *
     * Creates a reference to a blob stored in external storage (e.g., R2).
     * The blob ID should be unique and typically matches the blob's hash.
     * Uses prepared statement caching for optimal performance.
     *
     * ## Initial Reference Count
     *
     * New blobs are registered with ref_count = 1, assuming they are being
     * created for a single file entry. Use incrementBlobRefCount() when
     * creating additional references (hard links).
     *
     * @param blob - Blob metadata to register
     *
     * @example
     * ```typescript
     * await metadata.registerBlob({
     *   id: 'sha256-abc123...',
     *   tier: 'hot',
     *   size: 1024,
     *   checksum: 'sha256:abc123...'
     * })
     * ```
     */
    registerBlob(blob: {
        id: string;
        tier: StorageTier;
        size: number;
        checksum?: string;
    }): Promise<void>;
    /**
     * Get blob metadata by ID.
     *
     * Uses prepared statement caching for optimal performance on repeated queries.
     *
     * @param id - Blob ID
     * @returns BlobRef if found, null otherwise
     *
     * @example
     * ```typescript
     * const blob = await metadata.getBlob('sha256-abc123...')
     * if (blob) {
     *   console.log(`Blob is in ${blob.tier} tier, size: ${blob.size}`)
     * }
     * ```
     */
    getBlob(id: string): Promise<BlobRef | null>;
    /**
     * Update a blob's storage tier.
     *
     * Used when migrating blobs between hot/warm/cold storage.
     * Uses prepared statement caching for optimal performance.
     *
     * @param id - Blob ID
     * @param tier - New storage tier
     *
     * @example
     * ```typescript
     * // Demote to cold storage
     * await metadata.updateBlobTier('sha256-abc123...', 'cold')
     * ```
     */
    updateBlobTier(id: string, tier: StorageTier): Promise<void>;
    /**
     * Delete a blob reference.
     *
     * Note: This only removes the metadata reference. The actual blob
     * data in external storage must be cleaned up separately.
     * Uses prepared statement caching for optimal performance.
     *
     * @param id - Blob ID to delete
     *
     * @example
     * ```typescript
     * await metadata.deleteBlob('sha256-abc123...')
     * ```
     */
    deleteBlob(id: string): Promise<void>;
    /**
     * Get the current reference count for a blob.
     *
     * Reference counting is used to safely manage blob lifecycle when
     * multiple files (hard links) share the same blob data. A blob is
     * only safe to delete when its reference count reaches zero.
     *
     * ## Concurrent Access
     *
     * This method is safe to call concurrently. Reference count reads
     * are atomic and consistent within the Durable Object's single-
     * connection model.
     *
     * @param id - Blob ID to query
     * @returns Reference count, or null if the blob does not exist
     *
     * @example
     * ```typescript
     * const refCount = await metadata.getBlobRefCount('sha256-abc123...')
     * if (refCount !== null && refCount > 0) {
     *   console.log(`Blob has ${refCount} references`)
     * } else if (refCount === 0) {
     *   console.log('Blob is orphaned and can be deleted')
     * } else {
     *   console.log('Blob does not exist')
     * }
     * ```
     */
    getBlobRefCount(id: string): Promise<number | null>;
    /**
     * Increment the reference count for a blob atomically.
     *
     * This method should be called when creating a hard link to an existing
     * file that shares blob data. The increment is performed atomically using
     * SQL to ensure correctness under concurrent access.
     *
     * ## Usage Pattern
     *
     * When creating a hard link:
     * 1. Create the new file entry with the same blob_id
     * 2. Call incrementBlobRefCount() to track the new reference
     * 3. Update nlink on all file entries sharing this blob
     *
     * ## Concurrent Access
     *
     * This operation is atomic. The SQL `UPDATE ... SET ref_count = ref_count + 1`
     * ensures correct behavior even if multiple operations execute concurrently
     * within the Durable Object.
     *
     * @param id - Blob ID to increment
     *
     * @example
     * ```typescript
     * // When creating a hard link
     * await metadata.transaction(async () => {
     *   await metadata.createEntry({
     *     path: '/new-link.txt',
     *     blobId: existingBlobId,
     *     // ... other fields
     *   })
     *   await metadata.incrementBlobRefCount(existingBlobId)
     * })
     * ```
     */
    incrementBlobRefCount(id: string): Promise<void>;
    /**
     * Decrement the reference count for a blob atomically.
     *
     * This method should be called when deleting a file or hard link that
     * shares blob data. Returns true if the reference count reached zero,
     * indicating the blob should be deleted from storage.
     *
     * ## Usage Pattern
     *
     * When deleting a file:
     * 1. Delete the file entry from metadata
     * 2. Call decrementBlobRefCount() to update the reference count
     * 3. If return value is true, delete the blob from storage
     *
     * ## Concurrent Access
     *
     * This operation is atomic. The SQL `UPDATE ... SET ref_count = ref_count - 1`
     * ensures correct behavior under concurrent access. The method also protects
     * against negative reference counts by clamping to zero.
     *
     * ## Return Value
     *
     * - `true`: Reference count reached zero; blob should be deleted
     * - `false`: Other references remain; blob must not be deleted
     *
     * @param id - Blob ID to decrement
     * @returns true if the blob should be deleted (ref_count reached 0)
     *
     * @example
     * ```typescript
     * // When deleting a file
     * await metadata.transaction(async () => {
     *   const entry = await metadata.getByPath('/file.txt')
     *   if (entry?.blobId) {
     *     await metadata.deleteEntry(entry.id)
     *     const shouldDeleteBlob = await metadata.decrementBlobRefCount(entry.blobId)
     *     if (shouldDeleteBlob) {
     *       await metadata.deleteBlob(entry.blobId)
     *       await blobStorage.delete(entry.blobId) // External storage
     *     }
     *   }
     * })
     * ```
     */
    decrementBlobRefCount(id: string): Promise<boolean>;
    /**
     * Count the number of file entries referencing a blob.
     *
     * This method performs a live count of file entries in the files table
     * that have the specified blob_id. This can be used to verify reference
     * count integrity or to recalculate reference counts after recovery.
     *
     * ## vs getBlobRefCount
     *
     * - `getBlobRefCount`: Returns the cached ref_count stored in the blobs table
     * - `countBlobReferences`: Performs a live COUNT query on the files table
     *
     * If these values differ, it indicates ref_count was not properly maintained.
     * Use this method for verification or recovery scenarios.
     *
     * ## Performance
     *
     * This method performs a COUNT query which may be slower than reading
     * ref_count directly. Use getBlobRefCount() for normal operations.
     *
     * @param id - Blob ID to query
     * @returns Number of file entries referencing this blob
     *
     * @example
     * ```typescript
     * // Verify reference count integrity
     * const storedCount = await metadata.getBlobRefCount(blobId)
     * const actualCount = await metadata.countBlobReferences(blobId)
     *
     * if (storedCount !== actualCount) {
     *   console.warn(`Ref count mismatch: stored=${storedCount}, actual=${actualCount}`)
     *   // Could update: UPDATE blobs SET ref_count = ? WHERE id = ?
     * }
     * ```
     */
    countBlobReferences(id: string): Promise<number>;
    /**
     * Synchronize a blob's reference count with actual file references.
     *
     * This method recalculates the ref_count based on actual file entries
     * and updates the blobs table. Use this for recovery or integrity repair.
     *
     * @param id - Blob ID to synchronize
     * @returns The new reference count
     *
     * @example
     * ```typescript
     * // After recovery, ensure counts are accurate
     * const newCount = await metadata.syncBlobRefCount(blobId)
     * if (newCount === 0) {
     *   await metadata.deleteBlob(blobId)
     * }
     * ```
     */
    syncBlobRefCount(id: string): Promise<number>;
    /**
     * Find entries matching a glob-like pattern.
     *
     * Supports:
     * - `*` matches any characters
     * - `?` matches a single character
     *
     * @param pattern - Glob pattern (e.g., '*.json', '/data/*')
     * @param parentPath - Optional parent path constraint
     * @returns Matching FileEntry objects
     *
     * @example
     * ```typescript
     * // Find all JSON files
     * const jsonFiles = await metadata.findByPattern('*.json')
     *
     * // Find all files in /data directory
     * const dataFiles = await metadata.findByPattern('/data/*')
     *
     * // Find with parent constraint
     * const configFiles = await metadata.findByPattern('*.yaml', '/etc')
     * ```
     */
    findByPattern(pattern: string, parentPath?: string): Promise<FileEntry[]>;
    /**
     * Get storage statistics.
     *
     * Returns aggregate counts and sizes for files, directories,
     * and blobs grouped by storage tier.
     *
     * @returns Storage statistics
     *
     * @example
     * ```typescript
     * const stats = await metadata.getStats()
     * console.log(`Files: ${stats.totalFiles}`)
     * console.log(`Directories: ${stats.totalDirectories}`)
     * console.log(`Total size: ${stats.totalSize} bytes`)
     * console.log(`Hot tier: ${stats.blobsByTier.hot?.count ?? 0} blobs`)
     * ```
     */
    getStats(): Promise<StorageStats>;
}
export {};
//# sourceMappingURL=sqlite.d.ts.map
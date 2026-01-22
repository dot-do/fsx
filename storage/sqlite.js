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
export class SQLiteMetadata {
    /** SQLite storage instance */
    sql;
    /** Configuration options */
    options;
    /** Current transaction depth (0 = no transaction) */
    transactionDepth = 0;
    /** Savepoint counter for nested transactions */
    savepointCounter = 0;
    /** Transaction log for recovery and auditing */
    transactionLog = [];
    /** Current transaction ID */
    currentTransactionId = null;
    /** Current transaction start time (for timeout tracking) */
    currentTransactionStartTime = null;
    /** Operation counter for current transaction */
    currentTransactionOperationCount = 0;
    /** Timeout handle for current transaction */
    transactionTimeoutHandle = null;
    /**
     * Prepared statement cache for frequently used queries.
     *
     * Maps statement keys to cached SQL templates with execution statistics.
     * This enables query pattern reuse and performance monitoring.
     *
     * @internal
     */
    statementCache = new Map();
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
    constructor(sql, options = {}) {
        this.sql = sql;
        this.options = {
            maxLogEntries: 100,
            ...options
        };
        this.initStatementCache();
    }
    /**
     * Initialize the prepared statement cache with optimized SQL templates.
     *
     * Pre-caches frequently used queries to avoid repeated string construction.
     * Each cached statement includes execution statistics for performance monitoring.
     *
     * @internal
     */
    initStatementCache() {
        const statements = [
            ["getByPath" /* StatementKey.GET_BY_PATH */, 'SELECT * FROM files WHERE path = ?'],
            ["getById" /* StatementKey.GET_BY_ID */, 'SELECT * FROM files WHERE id = ?'],
            ["getChildren" /* StatementKey.GET_CHILDREN */, 'SELECT * FROM files WHERE parent_id = ?'],
            ["insertFile" /* StatementKey.INSERT_FILE */, `INSERT INTO files (path, name, parent_id, type, mode, uid, gid, size, blob_id, link_target, tier, atime, mtime, ctime, birthtime, nlink)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`],
            ["deleteFile" /* StatementKey.DELETE_FILE */, 'DELETE FROM files WHERE id = ?'],
            ["getBlob" /* StatementKey.GET_BLOB */, 'SELECT * FROM blobs WHERE id = ?'],
            ["insertBlob" /* StatementKey.INSERT_BLOB */, 'INSERT INTO blobs (id, tier, size, checksum, created_at, ref_count) VALUES (?, ?, ?, ?, ?, ?)'],
            ["deleteBlob" /* StatementKey.DELETE_BLOB */, 'DELETE FROM blobs WHERE id = ?'],
            ["getBlobRefCount" /* StatementKey.GET_BLOB_REF_COUNT */, 'SELECT ref_count FROM blobs WHERE id = ?'],
            ["incrementBlobRef" /* StatementKey.INCREMENT_BLOB_REF */, 'UPDATE blobs SET ref_count = ref_count + 1 WHERE id = ?'],
            ["decrementBlobRef" /* StatementKey.DECREMENT_BLOB_REF */, 'UPDATE blobs SET ref_count = ref_count - 1 WHERE id = ?'],
            ["countBlobRefs" /* StatementKey.COUNT_BLOB_REFS */, 'SELECT COUNT(*) as count FROM files WHERE blob_id = ?'],
            ["updateBlobRefCount" /* StatementKey.UPDATE_BLOB_REF_COUNT */, 'UPDATE blobs SET ref_count = ? WHERE id = ?'],
            ["updateBlobTier" /* StatementKey.UPDATE_BLOB_TIER */, 'UPDATE blobs SET tier = ? WHERE id = ?'],
            ["countFiles" /* StatementKey.COUNT_FILES */, `SELECT COUNT(*) as count FROM files WHERE type = 'file'`],
            ["countDirs" /* StatementKey.COUNT_DIRS */, `SELECT COUNT(*) as count FROM files WHERE type = 'directory'`],
            ["sumSize" /* StatementKey.SUM_SIZE */, 'SELECT SUM(size) as total FROM files'],
            ["tierStats" /* StatementKey.TIER_STATS */, 'SELECT tier, COUNT(*) as count, SUM(size) as size FROM blobs GROUP BY tier'],
        ];
        for (const [key, sql] of statements) {
            this.statementCache.set(key, {
                sql,
                executionCount: 0,
                totalExecutionTime: 0,
                lastUsed: 0,
            });
        }
    }
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
    execCached(key, ...params) {
        const cached = this.statementCache.get(key);
        if (!cached) {
            throw new Error(`Statement not found in cache: ${key}`);
        }
        const startTime = performance.now();
        const result = this.sql.exec(cached.sql, ...params);
        const duration = performance.now() - startTime;
        // Update cache statistics
        cached.executionCount++;
        cached.totalExecutionTime += duration;
        cached.lastUsed = Date.now();
        return result;
    }
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
    execCachedNoReturn(key, ...params) {
        const cached = this.statementCache.get(key);
        if (!cached) {
            throw new Error(`Statement not found in cache: ${key}`);
        }
        const startTime = performance.now();
        this.sql.exec(cached.sql, ...params);
        const duration = performance.now() - startTime;
        // Update cache statistics
        cached.executionCount++;
        cached.totalExecutionTime += duration;
        cached.lastUsed = Date.now();
    }
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
    getStatementStats() {
        const stats = new Map();
        for (const [key, cached] of this.statementCache) {
            stats.set(key, {
                executionCount: cached.executionCount,
                totalExecutionTime: cached.totalExecutionTime,
                avgExecutionTime: cached.executionCount > 0 ? cached.totalExecutionTime / cached.executionCount : 0,
            });
        }
        return stats;
    }
    // ===========================================================================
    // INSTRUMENTATION HELPERS
    // ===========================================================================
    /**
     * Emit a transaction event to registered hooks.
     * @internal
     */
    emitTransactionEvent(type, extra = {}) {
        if (!this.options.hooks?.onTransactionEvent)
            return;
        const event = {
            type,
            transactionId: this.currentTransactionId ?? 'none',
            timestamp: Date.now(),
            depth: this.transactionDepth,
            ...extra
        };
        try {
            this.options.hooks.onTransactionEvent(event);
        }
        catch {
            // Swallow hook errors to prevent affecting transaction flow
        }
    }
    /**
     * Prune old transaction log entries to stay within configured limit.
     * @internal
     */
    pruneTransactionLog() {
        const maxEntries = this.options.maxLogEntries ?? 100;
        if (this.transactionLog.length > maxEntries) {
            // Keep only the most recent entries
            this.transactionLog = this.transactionLog.slice(-maxEntries);
        }
    }
    /**
     * Default function to determine if an error is retryable.
     * @internal
     */
    isDefaultRetryable(error) {
        const message = error.message.toLowerCase();
        return (message.includes('sqlite_busy') ||
            message.includes('database is locked') ||
            message.includes('cannot start a transaction within a transaction'));
    }
    /**
     * Sleep for the specified duration.
     * @internal
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    // ===========================================================================
    // TRANSACTION API
    // ===========================================================================
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
    async beginTransaction(options) {
        if (this.transactionDepth === 0) {
            // Prune old log entries before starting new transaction
            this.pruneTransactionLog();
            // Start new transaction
            this.currentTransactionId = crypto.randomUUID();
            this.currentTransactionStartTime = Date.now();
            this.currentTransactionOperationCount = 0;
            this.transactionLog.push({
                id: this.currentTransactionId,
                status: 'active',
                startTime: this.currentTransactionStartTime,
                operationCount: 0,
            });
            // Set up timeout if specified
            if (options?.timeout) {
                this.transactionTimeoutHandle = setTimeout(async () => {
                    if (this.transactionDepth > 0 && this.currentTransactionId) {
                        const logEntry = this.transactionLog.find((e) => e.id === this.currentTransactionId);
                        if (logEntry) {
                            logEntry.status = 'timed_out';
                            logEntry.endTime = Date.now();
                            logEntry.rollbackReason = `Transaction timed out after ${options.timeout}ms`;
                        }
                        this.emitTransactionEvent('timeout', {
                            durationMs: options.timeout,
                            error: new Error(`Transaction timed out after ${options.timeout}ms`)
                        });
                        // Force rollback
                        try {
                            await this.sql.exec('ROLLBACK');
                        }
                        catch {
                            // Ignore rollback errors during timeout
                        }
                        this.transactionDepth = 0;
                        this.savepointCounter = 0;
                        this.currentTransactionId = null;
                        this.currentTransactionStartTime = null;
                        this.transactionTimeoutHandle = null;
                    }
                }, options.timeout);
            }
            await this.sql.exec('BEGIN TRANSACTION');
            this.emitTransactionEvent('begin');
        }
        else {
            // Create savepoint for nested transaction
            this.savepointCounter++;
            await this.sql.exec(`SAVEPOINT sp_${this.savepointCounter}`);
            this.emitTransactionEvent('begin');
        }
        this.transactionDepth++;
    }
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
    async commit() {
        if (this.transactionDepth <= 0) {
            throw new Error('No active transaction to commit');
        }
        this.transactionDepth--;
        if (this.transactionDepth === 0) {
            // Clear timeout if set
            if (this.transactionTimeoutHandle) {
                clearTimeout(this.transactionTimeoutHandle);
                this.transactionTimeoutHandle = null;
            }
            // Commit main transaction
            await this.sql.exec('COMMIT');
            // Calculate duration
            const duration = this.currentTransactionStartTime
                ? Date.now() - this.currentTransactionStartTime
                : 0;
            // Update transaction log
            const logEntry = this.transactionLog.find((e) => e.id === this.currentTransactionId);
            if (logEntry) {
                logEntry.status = 'committed';
                logEntry.endTime = Date.now();
                logEntry.operationCount = this.currentTransactionOperationCount;
            }
            this.emitTransactionEvent('commit', { durationMs: duration });
            this.currentTransactionId = null;
            this.currentTransactionStartTime = null;
            this.currentTransactionOperationCount = 0;
            this.savepointCounter = 0;
        }
        else {
            // Release savepoint
            await this.sql.exec(`RELEASE SAVEPOINT sp_${this.savepointCounter}`);
            this.savepointCounter--;
        }
    }
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
    async rollback(reason) {
        if (this.transactionDepth <= 0) {
            throw new Error('No active transaction to rollback');
        }
        this.transactionDepth--;
        if (this.transactionDepth === 0) {
            // Clear timeout if set
            if (this.transactionTimeoutHandle) {
                clearTimeout(this.transactionTimeoutHandle);
                this.transactionTimeoutHandle = null;
            }
            // Rollback main transaction
            await this.sql.exec('ROLLBACK');
            // Calculate duration
            const duration = this.currentTransactionStartTime
                ? Date.now() - this.currentTransactionStartTime
                : 0;
            // Update transaction log
            const logEntry = this.transactionLog.find((e) => e.id === this.currentTransactionId);
            if (logEntry) {
                logEntry.status = 'rolled_back';
                logEntry.endTime = Date.now();
                logEntry.operationCount = this.currentTransactionOperationCount;
                logEntry.rollbackReason = reason;
            }
            this.emitTransactionEvent('rollback', {
                durationMs: duration,
                error: reason ? new Error(reason) : undefined
            });
            this.currentTransactionId = null;
            this.currentTransactionStartTime = null;
            this.currentTransactionOperationCount = 0;
            this.savepointCounter = 0;
        }
        else {
            // Rollback to savepoint
            await this.sql.exec(`ROLLBACK TO SAVEPOINT sp_${this.savepointCounter}`);
            this.savepointCounter--;
        }
    }
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
    async transaction(fn, options) {
        const opts = {
            ...this.options.defaultTransactionOptions,
            ...options
        };
        const maxRetries = opts.maxRetries ?? 0;
        const retryDelayMs = opts.retryDelayMs ?? 100;
        const isRetryable = opts.isRetryable ?? this.isDefaultRetryable.bind(this);
        let lastError = null;
        let retryCount = 0;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                await this.beginTransaction({ timeout: opts.timeoutMs });
                try {
                    const result = await fn();
                    await this.commit();
                    // Update retry count in log
                    if (retryCount > 0) {
                        const logEntry = this.transactionLog[this.transactionLog.length - 1];
                        if (logEntry) {
                            logEntry.retryCount = retryCount;
                        }
                    }
                    return result;
                }
                catch (error) {
                    await this.rollback(error instanceof Error ? error.message : String(error));
                    throw error;
                }
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                if (attempt < maxRetries && isRetryable(lastError)) {
                    retryCount++;
                    this.emitTransactionEvent('retry', { retryAttempt: retryCount, error: lastError });
                    // Wait before retrying
                    await this.sleep(retryDelayMs * Math.pow(2, attempt)); // Exponential backoff
                }
                else {
                    throw lastError;
                }
            }
        }
        // Should not reach here, but TypeScript needs this
        throw lastError ?? new Error('Transaction failed');
    }
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
    async getTransactionLog() {
        return [...this.transactionLog];
    }
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
    async recoverTransactions() {
        // Clear any pending timeout
        if (this.transactionTimeoutHandle) {
            clearTimeout(this.transactionTimeoutHandle);
            this.transactionTimeoutHandle = null;
        }
        // SQLite automatically rolls back uncommitted transactions on recovery
        // Reset local state
        this.transactionDepth = 0;
        this.savepointCounter = 0;
        this.currentTransactionId = null;
        this.currentTransactionStartTime = null;
        this.currentTransactionOperationCount = 0;
    }
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
    isInTransaction() {
        return this.transactionDepth > 0;
    }
    /**
     * Get the current transaction depth.
     *
     * Returns 0 if not in a transaction, 1 for top-level transaction,
     * and higher values for nested transactions (savepoints).
     *
     * @returns Current transaction nesting depth
     */
    getTransactionDepth() {
        return this.transactionDepth;
    }
    /**
     * Track an operation within the current transaction.
     *
     * Call this method within transactions to increment the operation
     * counter, which is useful for debugging and metrics.
     *
     * @param operationName - Name of the operation being performed
     * @internal
     */
    trackOperation(operationName) {
        if (this.transactionDepth > 0) {
            this.currentTransactionOperationCount++;
            this.emitTransactionEvent('operation', { operation: operationName });
        }
    }
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
    async createEntriesAtomic(entries) {
        if (entries.length === 0) {
            return [];
        }
        return this.transaction(async () => {
            const now = Date.now();
            const ids = [];
            // Batch insert using cached statements
            for (const entry of entries) {
                const parentIdNum = entry.parentId !== null ? parseInt(entry.parentId, 10) : null;
                // Use cached statement for insert
                this.execCachedNoReturn("insertFile" /* StatementKey.INSERT_FILE */, entry.path, entry.name, parentIdNum, entry.type, entry.mode, entry.uid, entry.gid, entry.size, entry.blobId, entry.linkTarget, entry.tier ?? 'hot', now, now, now, now, entry.nlink);
                // Fetch the inserted entry by path to get its ID
                const result = this.execCached("getByPath" /* StatementKey.GET_BY_PATH */, entry.path).one();
                ids.push(result?.id ?? 0);
            }
            return ids;
        });
    }
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
    async deleteEntriesAtomic(ids) {
        if (ids.length === 0) {
            return;
        }
        return this.transaction(async () => {
            for (const id of ids) {
                const numericId = parseInt(id, 10);
                if (!isNaN(numericId)) {
                    this.execCachedNoReturn("deleteFile" /* StatementKey.DELETE_FILE */, numericId);
                }
            }
        });
    }
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
    async registerBlobsAtomic(blobs) {
        if (blobs.length === 0) {
            return;
        }
        return this.transaction(async () => {
            const now = Date.now();
            for (const blob of blobs) {
                this.execCachedNoReturn("insertBlob" /* StatementKey.INSERT_BLOB */, blob.id, blob.tier, blob.size, blob.checksum || null, now, 1);
            }
        });
    }
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
    async init() {
        // Create files table
        await this.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        parent_id INTEGER,
        type TEXT NOT NULL CHECK(type IN ('file', 'directory', 'symlink')),
        mode INTEGER NOT NULL DEFAULT 420,
        uid INTEGER NOT NULL DEFAULT 0,
        gid INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        blob_id TEXT,
        link_target TEXT,
        tier TEXT NOT NULL DEFAULT 'hot' CHECK(tier IN ('hot', 'warm', 'cold')),
        atime INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        ctime INTEGER NOT NULL,
        birthtime INTEGER NOT NULL,
        nlink INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (parent_id) REFERENCES files(id) ON DELETE CASCADE
      )
    `);
        // Create indexes for files table (separate statements for proper tracking)
        await this.sql.exec('CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)');
        await this.sql.exec('CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent_id)');
        await this.sql.exec('CREATE INDEX IF NOT EXISTS idx_files_tier ON files(tier)');
        // Create blobs table
        await this.sql.exec(`
      CREATE TABLE IF NOT EXISTS blobs (
        id TEXT PRIMARY KEY,
        tier TEXT NOT NULL DEFAULT 'hot' CHECK(tier IN ('hot', 'warm', 'cold')),
        size INTEGER NOT NULL,
        checksum TEXT,
        created_at INTEGER NOT NULL,
        ref_count INTEGER NOT NULL DEFAULT 1
      )
    `);
        // Create index for blobs table
        await this.sql.exec('CREATE INDEX IF NOT EXISTS idx_blobs_tier ON blobs(tier)');
        // Create root if not exists (using explicit id=0 to reserve auto-increment for user files)
        const root = await this.getByPath('/');
        if (!root) {
            const now = Date.now();
            await this.sql.exec(`INSERT INTO files (id, path, name, parent_id, type, mode, uid, gid, size, tier, atime, mtime, ctime, birthtime, nlink)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 0, '/', '', null, 'directory', 0o755, 0, 0, 0, 'hot', now, now, now, now, 2);
        }
    }
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
    rowToEntry(row) {
        return {
            id: String(row.id),
            path: row.path,
            name: row.name,
            parentId: row.parent_id !== null ? String(row.parent_id) : null,
            type: row.type,
            mode: row.mode,
            uid: row.uid,
            gid: row.gid,
            size: row.size,
            blobId: row.blob_id,
            linkTarget: row.link_target,
            atime: row.atime,
            mtime: row.mtime,
            ctime: row.ctime,
            birthtime: row.birthtime,
            nlink: row.nlink,
        };
    }
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
    async getByPath(path) {
        const result = this.execCached("getByPath" /* StatementKey.GET_BY_PATH */, path).one();
        return result ? this.rowToEntry(result) : null;
    }
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
    async getById(id) {
        const numericId = parseInt(id, 10);
        if (isNaN(numericId))
            return null;
        const result = this.execCached("getById" /* StatementKey.GET_BY_ID */, numericId).one();
        return result ? this.rowToEntry(result) : null;
    }
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
    async getChildren(parentId) {
        const numericId = parseInt(parentId, 10);
        if (isNaN(numericId))
            return [];
        const rows = this.execCached("getChildren" /* StatementKey.GET_CHILDREN */, numericId).toArray();
        return rows.map((row) => this.rowToEntry(row));
    }
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
    async createEntry(entry) {
        this.trackOperation('createEntry');
        const now = Date.now();
        const parentIdNum = entry.parentId !== null ? parseInt(entry.parentId, 10) : null;
        // Use cached statement for insert
        this.execCachedNoReturn("insertFile" /* StatementKey.INSERT_FILE */, entry.path, entry.name, parentIdNum, entry.type, entry.mode, entry.uid, entry.gid, entry.size, entry.blobId, entry.linkTarget, entry.tier ?? 'hot', now, now, now, now, entry.nlink);
        // Fetch the inserted entry by path to get its ID (avoids race conditions with concurrent inserts)
        const result = this.execCached("getByPath" /* StatementKey.GET_BY_PATH */, entry.path).one();
        return result?.id ?? 0;
    }
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
    async updateEntry(id, updates) {
        const numericId = parseInt(id, 10);
        if (isNaN(numericId))
            return;
        const sets = [];
        const values = [];
        if (updates.path !== undefined) {
            sets.push('path = ?');
            values.push(updates.path);
        }
        if (updates.name !== undefined) {
            sets.push('name = ?');
            values.push(updates.name);
        }
        if (updates.parentId !== undefined) {
            sets.push('parent_id = ?');
            const parentIdNum = updates.parentId !== null ? parseInt(updates.parentId, 10) : null;
            values.push(parentIdNum);
        }
        if (updates.mode !== undefined) {
            sets.push('mode = ?');
            values.push(updates.mode);
        }
        if (updates.uid !== undefined) {
            sets.push('uid = ?');
            values.push(updates.uid);
        }
        if (updates.gid !== undefined) {
            sets.push('gid = ?');
            values.push(updates.gid);
        }
        if (updates.size !== undefined) {
            sets.push('size = ?');
            values.push(updates.size);
        }
        if (updates.blobId !== undefined) {
            sets.push('blob_id = ?');
            values.push(updates.blobId);
        }
        if (updates.tier !== undefined) {
            sets.push('tier = ?');
            values.push(updates.tier);
        }
        if (updates.atime !== undefined) {
            sets.push('atime = ?');
            values.push(updates.atime);
        }
        if (updates.mtime !== undefined) {
            sets.push('mtime = ?');
            values.push(updates.mtime);
        }
        // Always update ctime
        sets.push('ctime = ?');
        values.push(Date.now());
        values.push(numericId);
        await this.sql.exec(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`, ...values);
    }
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
    async deleteEntry(id) {
        this.trackOperation('deleteEntry');
        const numericId = parseInt(id, 10);
        if (isNaN(numericId))
            return;
        this.execCachedNoReturn("deleteFile" /* StatementKey.DELETE_FILE */, numericId);
    }
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
    async registerBlob(blob) {
        this.trackOperation('registerBlob');
        this.execCachedNoReturn("insertBlob" /* StatementKey.INSERT_BLOB */, blob.id, blob.tier, blob.size, blob.checksum || null, Date.now(), 1);
    }
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
    async getBlob(id) {
        const result = this.execCached("getBlob" /* StatementKey.GET_BLOB */, id).one();
        return result || null;
    }
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
    async updateBlobTier(id, tier) {
        this.trackOperation('updateBlobTier');
        this.execCachedNoReturn("updateBlobTier" /* StatementKey.UPDATE_BLOB_TIER */, tier, id);
    }
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
    async deleteBlob(id) {
        this.trackOperation('deleteBlob');
        this.execCachedNoReturn("deleteBlob" /* StatementKey.DELETE_BLOB */, id);
    }
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
    async getBlobRefCount(id) {
        this.trackOperation('getBlobRefCount');
        const result = this.execCached("getBlobRefCount" /* StatementKey.GET_BLOB_REF_COUNT */, id).one();
        return result?.ref_count ?? null;
    }
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
    async incrementBlobRefCount(id) {
        this.trackOperation('incrementBlobRefCount');
        this.execCachedNoReturn("incrementBlobRef" /* StatementKey.INCREMENT_BLOB_REF */, id);
    }
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
    async decrementBlobRefCount(id) {
        this.trackOperation('decrementBlobRefCount');
        // Decrement ref count atomically using cached statement
        this.execCachedNoReturn("decrementBlobRef" /* StatementKey.DECREMENT_BLOB_REF */, id);
        // Check result and fix negative values using cached statement
        const result = this.execCached("getBlobRefCount" /* StatementKey.GET_BLOB_REF_COUNT */, id).one();
        const refCount = result?.ref_count ?? 0;
        // Ensure we don't go negative (fix up if needed)
        if (refCount < 0) {
            this.execCachedNoReturn("updateBlobRefCount" /* StatementKey.UPDATE_BLOB_REF_COUNT */, 0, id);
            return true;
        }
        return refCount === 0;
    }
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
    async countBlobReferences(id) {
        this.trackOperation('countBlobReferences');
        // Count file entries that reference a specific blob using cached statement
        const result = this.execCached("countBlobRefs" /* StatementKey.COUNT_BLOB_REFS */, id).one();
        return result?.count ?? 0;
    }
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
    async syncBlobRefCount(id) {
        this.trackOperation('syncBlobRefCount');
        const actualCount = await this.countBlobReferences(id);
        this.execCachedNoReturn("updateBlobRefCount" /* StatementKey.UPDATE_BLOB_REF_COUNT */, actualCount, id);
        return actualCount;
    }
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
    async findByPattern(pattern, parentPath) {
        // Convert glob to SQL LIKE pattern
        const sqlPattern = pattern.replace(/\*/g, '%').replace(/\?/g, '_');
        let rows;
        if (parentPath) {
            rows = this.sql.exec('SELECT * FROM files WHERE path LIKE ? AND path LIKE ?', parentPath + '%', sqlPattern).toArray();
        }
        else {
            rows = this.sql.exec('SELECT * FROM files WHERE path LIKE ?', sqlPattern).toArray();
        }
        return rows.map((row) => this.rowToEntry(row));
    }
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
    async getStats() {
        // Use cached statements for all aggregate queries
        const files = this.execCached("countFiles" /* StatementKey.COUNT_FILES */).one();
        const dirs = this.execCached("countDirs" /* StatementKey.COUNT_DIRS */).one();
        const size = this.execCached("sumSize" /* StatementKey.SUM_SIZE */).one();
        const tierStats = this.execCached("tierStats" /* StatementKey.TIER_STATS */).toArray();
        // Only include tiers that have data (preserves backward compatibility)
        const blobsByTier = {};
        for (const stat of tierStats) {
            const tier = stat.tier;
            blobsByTier[tier] = { count: stat.count, size: stat.size ?? 0 };
        }
        return {
            totalFiles: files?.count ?? 0,
            totalDirectories: dirs?.count ?? 0,
            totalSize: size?.total ?? 0,
            blobsByTier,
        };
    }
}
//# sourceMappingURL=sqlite.js.map
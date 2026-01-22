/**
 * TransactionManager - Manages transaction and savepoint handling
 *
 * Handles SQLite transactions with:
 * - Nested transaction support via savepoints
 * - Automatic commit/rollback with transaction() wrapper
 * - Transaction logging for debugging
 *
 * WARNING: BEGIN/COMMIT/ROLLBACK are BLOCKED in production Cloudflare DOs.
 * This code works in Miniflare (local testing) but will FAIL in production.
 * Production alternatives:
 * 1. Use state.storage.transactionSync() for synchronous operations
 * 2. Avoid await between SQL statements (automatic atomicity)
 * See db/TRANSACTIONS.md for full documentation
 *
 * @module do/transaction-manager
 */

import { generateSavepointName } from '../storage/blob-utils.js'

/**
 * Transaction log entry structure
 */
export interface TransactionLogEntry {
  id: string
  status: 'active' | 'committed' | 'rolled_back'
  startTime: number
  endTime?: number
}

/**
 * Configuration for TransactionManager
 */
export interface TransactionManagerConfig {
  /** SQLite storage instance */
  sql: SqlStorage
}

/**
 * TransactionManager - Handles all transaction operations
 *
 * This class encapsulates:
 * - Transaction lifecycle (begin, commit, rollback)
 * - Nested transactions via savepoints
 * - Transaction logging
 * - Recovery from uncommitted transactions
 */
export class TransactionManager {
  private sql: SqlStorage
  private transactionDepth = 0
  private savepointCounter = 0
  private transactionLog: TransactionLogEntry[] = []
  private currentTransactionId: string | null = null

  constructor(config: TransactionManagerConfig) {
    this.sql = config.sql
  }

  // ===========================================================================
  // TRANSACTION LIFECYCLE
  // ===========================================================================

  /**
   * Begin a new transaction or create a savepoint for nested transactions.
   * @param options - Optional transaction options (timeout, etc.)
   */
  async begin(_options?: { timeout?: number }): Promise<void> {
    if (this.transactionDepth === 0) {
      // Start new transaction
      this.currentTransactionId = crypto.randomUUID()
      this.transactionLog.push({
        id: this.currentTransactionId,
        status: 'active',
        startTime: Date.now(),
      })
      // WARNING: This will FAIL in production Cloudflare DOs.
      // See module-level documentation for alternatives.
      await this.sql.exec('BEGIN TRANSACTION')
    } else {
      // Create savepoint for nested transaction
      // Use generateSavepointName() for safe identifier generation (prevents SQL injection)
      this.savepointCounter++
      const savepointName = generateSavepointName(this.savepointCounter)
      await this.sql.exec(`SAVEPOINT ${savepointName}`)
    }
    this.transactionDepth++
  }

  /**
   * Commit the current transaction or release savepoint.
   */
  async commit(): Promise<void> {
    if (this.transactionDepth <= 0) {
      throw new Error('No active transaction to commit')
    }

    this.transactionDepth--

    if (this.transactionDepth === 0) {
      // Commit main transaction
      await this.sql.exec('COMMIT')

      // Update transaction log
      const logEntry = this.transactionLog.find((e) => e.id === this.currentTransactionId)
      if (logEntry) {
        logEntry.status = 'committed'
        logEntry.endTime = Date.now()
      }
      this.currentTransactionId = null
      this.savepointCounter = 0
    } else {
      // Release savepoint
      const savepointName = generateSavepointName(this.savepointCounter)
      await this.sql.exec(`RELEASE SAVEPOINT ${savepointName}`)
      this.savepointCounter--
    }
  }

  /**
   * Rollback the current transaction or to savepoint.
   */
  async rollback(): Promise<void> {
    if (this.transactionDepth <= 0) {
      throw new Error('No active transaction to rollback')
    }

    this.transactionDepth--

    if (this.transactionDepth === 0) {
      // Rollback main transaction
      await this.sql.exec('ROLLBACK')

      // Update transaction log
      const logEntry = this.transactionLog.find((e) => e.id === this.currentTransactionId)
      if (logEntry) {
        logEntry.status = 'rolled_back'
        logEntry.endTime = Date.now()
      }
      this.currentTransactionId = null
      this.savepointCounter = 0
    } else {
      // Rollback to savepoint
      const savepointName = generateSavepointName(this.savepointCounter)
      await this.sql.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`)
      this.savepointCounter--
    }
  }

  /**
   * Execute a function within a transaction with automatic commit/rollback.
   * @param fn - Function to execute within transaction
   * @returns Result of the function
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.begin()
    try {
      const result = await fn()
      await this.commit()
      return result
    } catch (error) {
      await this.rollback()
      throw error
    }
  }

  // ===========================================================================
  // TRANSACTION STATE
  // ===========================================================================

  /**
   * Check if currently in a transaction.
   */
  isInTransaction(): boolean {
    return this.transactionDepth > 0
  }

  /**
   * Get the current transaction depth (0 = no active transaction).
   */
  getTransactionDepth(): number {
    return this.transactionDepth
  }

  /**
   * Get the current transaction ID (null if no active transaction).
   */
  getCurrentTransactionId(): string | null {
    return this.currentTransactionId
  }

  // ===========================================================================
  // TRANSACTION LOG
  // ===========================================================================

  /**
   * Get the transaction log entries.
   */
  getLog(): TransactionLogEntry[] {
    return [...this.transactionLog]
  }

  /**
   * Clear the transaction log.
   */
  clearLog(): void {
    this.transactionLog = []
  }

  // ===========================================================================
  // RECOVERY
  // ===========================================================================

  /**
   * Recover from uncommitted transactions (for crash recovery).
   * SQLite automatically rolls back uncommitted transactions on recovery.
   * This method resets local state.
   */
  async recover(): Promise<void> {
    this.transactionDepth = 0
    this.savepointCounter = 0
    this.currentTransactionId = null
  }
}

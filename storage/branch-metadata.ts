/**
 * Branch Metadata Storage - SQLite and R2-backed branch metadata for fsx
 *
 * Implements storage for git-like branch metadata to support the BranchableBackend
 * interface. Stores branch name, parent branch, fork point, head commit,
 * and timestamps.
 *
 * ## Storage Tiers
 *
 * - **Hot Storage (DO SQLite)**: Active branch metadata with fast access
 * - **Cold Storage (R2)**: Archived branch history for long-term retention
 *
 * ## Schema
 *
 * The branches table stores:
 * - `id`: Auto-incrementing primary key
 * - `name`: Unique branch identifier
 * - `parent_branch`: Branch this was forked from (null for root/main)
 * - `fork_point`: Commit/tree hash at fork time
 * - `head_commit`: Current head commit/tree hash
 * - `created_at`: Branch creation timestamp
 * - `updated_at`: Last modification timestamp
 * - `is_default`: Whether this is the default branch
 * - `is_protected`: Whether this branch is protected from deletion
 * - `is_archived`: Whether this branch has been archived to cold storage
 *
 * @example
 * ```typescript
 * const branchStorage = new SQLiteBranchMetadata(ctx.storage.sql)
 * await branchStorage.init()
 *
 * // Create a branch
 * await branchStorage.create({
 *   name: 'feature-auth',
 *   parentBranch: 'main',
 *   forkPoint: 'abc123',
 *   headCommit: 'abc123',
 * })
 *
 * // Get branch info
 * const branch = await branchStorage.get('feature-auth')
 * ```
 *
 * @module storage/branch-metadata
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Branch metadata stored in the database.
 *
 * Contains all information about a branch including its lineage,
 * current state, and protection settings.
 */
export interface BranchMetadata {
  /** Branch identifier */
  name: string

  /** Branch this was created from (null for root/main) */
  parentBranch: string | null

  /** Commit/tree hash at the point of fork */
  forkPoint: string | null

  /** Current head commit/tree hash */
  headCommit: string

  /** Creation timestamp (Unix ms) */
  createdAt: number

  /** Last modification timestamp (Unix ms) */
  updatedAt: number

  /** Whether this is the default branch */
  isDefault: boolean

  /** Whether this branch is protected from deletion */
  isProtected: boolean

  /** Whether this branch has been archived to cold storage */
  isArchived: boolean

  /** Number of commits/changes on this branch since fork */
  commitCount: number
}

/**
 * Options for creating a new branch.
 */
export interface CreateBranchOptions {
  /** Branch identifier (must be unique) */
  name: string

  /** Parent branch to fork from */
  parentBranch?: string | null

  /** Commit/tree hash at fork point */
  forkPoint?: string | null

  /** Initial head commit (defaults to forkPoint) */
  headCommit: string

  /** Mark as default branch */
  isDefault?: boolean

  /** Mark as protected from deletion */
  isProtected?: boolean
}

/**
 * Options for updating a branch.
 */
export interface UpdateBranchOptions {
  /** New head commit hash */
  headCommit?: string

  /** Update protection status */
  isProtected?: boolean

  /** Mark as archived */
  isArchived?: boolean

  /** Update commit count */
  commitCount?: number
}

/**
 * Options for listing branches.
 */
export interface ListBranchesOptions {
  /** Include archived branches */
  includeArchived?: boolean

  /** Filter by parent branch */
  parentBranch?: string

  /** Limit results */
  limit?: number

  /** Offset for pagination */
  offset?: number
}

/**
 * Archived branch record for R2 cold storage.
 *
 * Contains the full branch history and metadata for long-term retention.
 */
export interface ArchivedBranch extends BranchMetadata {
  /** Archive timestamp (Unix ms) */
  archivedAt: number

  /** Reason for archival */
  archiveReason?: string

  /** User/system that initiated archive */
  archivedBy?: string
}

// =============================================================================
// Interface
// =============================================================================

/**
 * Branch metadata storage interface.
 *
 * Defines the contract for storing and retrieving branch metadata.
 * Implementations include SQLiteBranchMetadata for hot storage and
 * R2BranchMetadata for cold/archive storage.
 *
 * @example
 * ```typescript
 * class MyBranchStorage implements BranchMetadataStorage {
 *   async create(options: CreateBranchOptions): Promise<BranchMetadata> {
 *     // Implementation
 *   }
 *   // ... other methods
 * }
 * ```
 */
export interface BranchMetadataStorage {
  /**
   * Initialize the storage (create tables, etc.).
   */
  init(): Promise<void>

  /**
   * Create a new branch.
   *
   * @param options - Branch creation options
   * @returns The created branch metadata
   * @throws {Error} If branch with name already exists
   */
  create(options: CreateBranchOptions): Promise<BranchMetadata>

  /**
   * Get branch metadata by name.
   *
   * @param name - Branch identifier
   * @returns Branch metadata or null if not found
   */
  get(name: string): Promise<BranchMetadata | null>

  /**
   * Update branch metadata.
   *
   * @param name - Branch identifier
   * @param updates - Fields to update
   * @throws {Error} If branch doesn't exist
   */
  update(name: string, updates: UpdateBranchOptions): Promise<void>

  /**
   * Delete a branch.
   *
   * @param name - Branch identifier
   * @throws {Error} If branch is protected or is the default branch
   */
  delete(name: string): Promise<void>

  /**
   * List all branches.
   *
   * @param options - List options (filters, pagination)
   * @returns Array of branch metadata
   */
  list(options?: ListBranchesOptions): Promise<BranchMetadata[]>

  /**
   * Check if a branch exists.
   *
   * @param name - Branch identifier
   * @returns true if branch exists
   */
  exists(name: string): Promise<boolean>

  /**
   * Rename a branch.
   *
   * @param oldName - Current branch name
   * @param newName - New branch name
   * @throws {Error} If source doesn't exist or destination already exists
   */
  rename(oldName: string, newName: string): Promise<void>

  /**
   * Get the default branch.
   *
   * @returns Default branch metadata or null if none set
   */
  getDefault(): Promise<BranchMetadata | null>

  /**
   * Set a branch as the default.
   *
   * @param name - Branch to set as default
   * @throws {Error} If branch doesn't exist
   */
  setDefault(name: string): Promise<void>
}

// =============================================================================
// Internal Types
// =============================================================================

/**
 * Internal row structure matching the SQLite schema.
 *
 * Uses snake_case column names to match SQL conventions.
 *
 * @internal
 */
interface BranchRow {
  /** Auto-incrementing row ID */
  id: number
  /** Branch identifier */
  name: string
  /** Parent branch name */
  parent_branch: string | null
  /** Fork point hash */
  fork_point: string | null
  /** Head commit hash */
  head_commit: string
  /** Creation timestamp (Unix ms) */
  created_at: number
  /** Last modification timestamp (Unix ms) */
  updated_at: number
  /** Is default branch (0 or 1) */
  is_default: number
  /** Is protected (0 or 1) */
  is_protected: number
  /** Is archived (0 or 1) */
  is_archived: number
  /** Number of commits since fork */
  commit_count: number
  /** Index signature for SqlStorage compatibility */
  [key: string]: SqlStorageValue
}

/**
 * Valid SqlStorage value types.
 */
type SqlStorageValue = string | number | null | ArrayBuffer

/**
 * SqlStorage interface matching Cloudflare DO SqlStorage.
 */
interface SqlStorage {
  exec<T = unknown>(sql: string, ...params: unknown[]): { one: () => T | null; toArray: () => T[] }
}

// =============================================================================
// SQLite Implementation
// =============================================================================

/**
 * SQL statement identifiers for the prepared statement cache.
 *
 * @internal
 */
const enum StatementKey {
  GET_BY_NAME = 'getByName',
  GET_DEFAULT = 'getDefault',
  INSERT_BRANCH = 'insertBranch',
  DELETE_BRANCH = 'deleteBranch',
  LIST_ALL = 'listAll',
  LIST_ACTIVE = 'listActive',
  CHECK_EXISTS = 'checkExists',
  UNSET_DEFAULT = 'unsetDefault',
  SET_DEFAULT = 'setDefault',
}

/**
 * Cache entry for prepared SQL statement patterns.
 *
 * @internal
 */
interface PreparedStatementCache {
  /** SQL query template with placeholders */
  sql: string
  /** Number of times this statement has been executed */
  executionCount: number
  /** Total execution time in milliseconds */
  totalExecutionTime: number
  /** Last execution timestamp */
  lastUsed: number
}

/**
 * SQLiteBranchMetadata - Branch metadata backed by SQLite.
 *
 * Implements the BranchMetadataStorage interface for storing branch
 * information in SQLite. Designed for use with Durable Objects SqlStorage.
 *
 * The implementation uses:
 * - INTEGER PRIMARY KEY AUTOINCREMENT for efficient rowid lookups
 * - UNIQUE constraint on name for fast branch lookup
 * - Indexes on parent_branch for lineage queries
 * - CHECK constraints for boolean fields
 *
 * @implements {BranchMetadataStorage}
 *
 * @example
 * ```typescript
 * // In a Durable Object
 * class MyDO extends DurableObject {
 *   private branchStorage: SQLiteBranchMetadata
 *
 *   constructor(ctx: DurableObjectState) {
 *     this.branchStorage = new SQLiteBranchMetadata(ctx.storage.sql)
 *   }
 *
 *   async fetch(request: Request) {
 *     await this.branchStorage.init()
 *     const main = await this.branchStorage.get('main')
 *     // ...
 *   }
 * }
 * ```
 */
export class SQLiteBranchMetadata implements BranchMetadataStorage {
  /** SQLite storage instance */
  private readonly sql: SqlStorage

  /** Prepared statement cache */
  private readonly statementCache: Map<string, PreparedStatementCache> = new Map()

  /** Whether init() has been called */
  private initialized = false

  /**
   * Create a new SQLiteBranchMetadata instance.
   *
   * @param sql - SqlStorage instance from Durable Object context
   */
  constructor(sql: SqlStorage) {
    this.sql = sql
    this.initStatementCache()
  }

  /**
   * Initialize the prepared statement cache.
   *
   * @internal
   */
  private initStatementCache(): void {
    const statements: Array<[string, string]> = [
      [StatementKey.GET_BY_NAME, 'SELECT * FROM branches WHERE name = ?'],
      [StatementKey.GET_DEFAULT, 'SELECT * FROM branches WHERE is_default = 1'],
      [
        StatementKey.INSERT_BRANCH,
        `INSERT INTO branches (name, parent_branch, fork_point, head_commit, created_at, updated_at, is_default, is_protected, is_archived, commit_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ],
      [StatementKey.DELETE_BRANCH, 'DELETE FROM branches WHERE name = ?'],
      [StatementKey.LIST_ALL, 'SELECT * FROM branches ORDER BY updated_at DESC'],
      [StatementKey.LIST_ACTIVE, 'SELECT * FROM branches WHERE is_archived = 0 ORDER BY updated_at DESC'],
      [StatementKey.CHECK_EXISTS, 'SELECT 1 FROM branches WHERE name = ?'],
      [StatementKey.UNSET_DEFAULT, 'UPDATE branches SET is_default = 0 WHERE is_default = 1'],
      [StatementKey.SET_DEFAULT, 'UPDATE branches SET is_default = 1, updated_at = ? WHERE name = ?'],
    ]

    for (const [key, sql] of statements) {
      this.statementCache.set(key, {
        sql,
        executionCount: 0,
        totalExecutionTime: 0,
        lastUsed: 0,
      })
    }
  }

  /**
   * Execute a cached prepared statement.
   *
   * @internal
   */
  private execCached<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(
    key: string,
    ...params: unknown[]
  ): { one: () => T | null; toArray: () => T[] } {
    const cached = this.statementCache.get(key)
    if (!cached) {
      throw new Error(`Statement not found in cache: ${key}`)
    }

    const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const result = this.sql.exec<T>(cached.sql, ...params)
    const duration = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startTime

    // Update cache statistics
    cached.executionCount++
    cached.totalExecutionTime += duration
    cached.lastUsed = Date.now()

    return result
  }

  /**
   * Initialize the storage schema.
   *
   * Creates the branches table if it doesn't exist and ensures
   * the default 'main' branch is present.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return
    }

    // Create branches table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS branches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        parent_branch TEXT,
        fork_point TEXT,
        head_commit TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
        is_protected INTEGER NOT NULL DEFAULT 0 CHECK(is_protected IN (0, 1)),
        is_archived INTEGER NOT NULL DEFAULT 0 CHECK(is_archived IN (0, 1)),
        commit_count INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (parent_branch) REFERENCES branches(name) ON DELETE SET NULL
      )
    `)

    // Create indexes
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_branches_name ON branches(name)`)
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_branches_parent ON branches(parent_branch)`)
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_branches_default ON branches(is_default)`)
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_branches_archived ON branches(is_archived)`)

    // Create default 'main' branch if it doesn't exist
    const main = this.execCached<BranchRow>(StatementKey.GET_BY_NAME, 'main').one()
    if (!main) {
      const now = Date.now()
      // Use empty string as initial head commit for root branch
      this.sql.exec(
        `INSERT INTO branches (name, parent_branch, fork_point, head_commit, created_at, updated_at, is_default, is_protected, is_archived, commit_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'main',
        null,
        null,
        '', // Empty head commit for initial state
        now,
        now,
        1, // is_default
        1, // is_protected
        0, // is_archived
        0 // commit_count
      )
    }

    this.initialized = true
  }

  /**
   * Convert a database row to BranchMetadata.
   *
   * @internal
   */
  private rowToMetadata(row: BranchRow): BranchMetadata {
    return {
      name: row.name,
      parentBranch: row.parent_branch,
      forkPoint: row.fork_point,
      headCommit: row.head_commit,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isDefault: row.is_default === 1,
      isProtected: row.is_protected === 1,
      isArchived: row.is_archived === 1,
      commitCount: row.commit_count,
    }
  }

  /**
   * Create a new branch.
   */
  async create(options: CreateBranchOptions): Promise<BranchMetadata> {
    // Check if branch already exists
    const existing = await this.get(options.name)
    if (existing) {
      throw new Error(`Branch already exists: ${options.name}`)
    }

    const now = Date.now()
    const forkPoint = options.forkPoint ?? null
    const parentBranch = options.parentBranch ?? null

    this.sql.exec(
      `INSERT INTO branches (name, parent_branch, fork_point, head_commit, created_at, updated_at, is_default, is_protected, is_archived, commit_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      options.name,
      parentBranch,
      forkPoint,
      options.headCommit,
      now,
      now,
      options.isDefault ? 1 : 0,
      options.isProtected ? 1 : 0,
      0, // is_archived
      0 // commit_count
    )

    return {
      name: options.name,
      parentBranch,
      forkPoint,
      headCommit: options.headCommit,
      createdAt: now,
      updatedAt: now,
      isDefault: options.isDefault ?? false,
      isProtected: options.isProtected ?? false,
      isArchived: false,
      commitCount: 0,
    }
  }

  /**
   * Get branch metadata by name.
   */
  async get(name: string): Promise<BranchMetadata | null> {
    const row = this.execCached<BranchRow>(StatementKey.GET_BY_NAME, name).one()
    if (!row) {
      return null
    }
    return this.rowToMetadata(row)
  }

  /**
   * Update branch metadata.
   */
  async update(name: string, updates: UpdateBranchOptions): Promise<void> {
    const existing = await this.get(name)
    if (!existing) {
      throw new Error(`Branch not found: ${name}`)
    }

    const setClauses: string[] = []
    const params: unknown[] = []

    if (updates.headCommit !== undefined) {
      setClauses.push('head_commit = ?')
      params.push(updates.headCommit)
    }

    if (updates.isProtected !== undefined) {
      setClauses.push('is_protected = ?')
      params.push(updates.isProtected ? 1 : 0)
    }

    if (updates.isArchived !== undefined) {
      setClauses.push('is_archived = ?')
      params.push(updates.isArchived ? 1 : 0)
    }

    if (updates.commitCount !== undefined) {
      setClauses.push('commit_count = ?')
      params.push(updates.commitCount)
    }

    if (setClauses.length === 0) {
      return
    }

    // Always update timestamp
    setClauses.push('updated_at = ?')
    params.push(Date.now())

    // Add name for WHERE clause
    params.push(name)

    this.sql.exec(`UPDATE branches SET ${setClauses.join(', ')} WHERE name = ?`, ...params)
  }

  /**
   * Delete a branch.
   */
  async delete(name: string): Promise<void> {
    const existing = await this.get(name)
    if (!existing) {
      throw new Error(`Branch not found: ${name}`)
    }

    if (existing.isDefault) {
      throw new Error(`Cannot delete default branch: ${name}`)
    }

    if (existing.isProtected) {
      throw new Error(`Cannot delete protected branch: ${name}`)
    }

    this.execCached(StatementKey.DELETE_BRANCH, name)
  }

  /**
   * List all branches.
   */
  async list(options?: ListBranchesOptions): Promise<BranchMetadata[]> {
    let sql = 'SELECT * FROM branches'
    const params: unknown[] = []
    const whereClauses: string[] = []

    if (!options?.includeArchived) {
      whereClauses.push('is_archived = 0')
    }

    if (options?.parentBranch !== undefined) {
      whereClauses.push('parent_branch = ?')
      params.push(options.parentBranch)
    }

    if (whereClauses.length > 0) {
      sql += ' WHERE ' + whereClauses.join(' AND ')
    }

    sql += ' ORDER BY updated_at DESC'

    if (options?.limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(options.limit)
    }

    if (options?.offset !== undefined) {
      sql += ' OFFSET ?'
      params.push(options.offset)
    }

    const rows = this.sql.exec<BranchRow>(sql, ...params).toArray()
    return rows.map((row) => this.rowToMetadata(row))
  }

  /**
   * Check if a branch exists.
   */
  async exists(name: string): Promise<boolean> {
    const result = this.execCached<{ '1': number }>(StatementKey.CHECK_EXISTS, name).one()
    return result !== null
  }

  /**
   * Rename a branch.
   */
  async rename(oldName: string, newName: string): Promise<void> {
    const existing = await this.get(oldName)
    if (!existing) {
      throw new Error(`Branch not found: ${oldName}`)
    }

    const targetExists = await this.exists(newName)
    if (targetExists) {
      throw new Error(`Branch already exists: ${newName}`)
    }

    const now = Date.now()
    this.sql.exec(`UPDATE branches SET name = ?, updated_at = ? WHERE name = ?`, newName, now, oldName)

    // Update any branches that have this as parent
    this.sql.exec(`UPDATE branches SET parent_branch = ? WHERE parent_branch = ?`, newName, oldName)
  }

  /**
   * Get the default branch.
   */
  async getDefault(): Promise<BranchMetadata | null> {
    const row = this.execCached<BranchRow>(StatementKey.GET_DEFAULT).one()
    if (!row) {
      return null
    }
    return this.rowToMetadata(row)
  }

  /**
   * Set a branch as the default.
   */
  async setDefault(name: string): Promise<void> {
    const existing = await this.get(name)
    if (!existing) {
      throw new Error(`Branch not found: ${name}`)
    }

    // Unset current default
    this.execCached(StatementKey.UNSET_DEFAULT)

    // Set new default
    this.execCached(StatementKey.SET_DEFAULT, Date.now(), name)
  }

  /**
   * Get statement execution statistics.
   *
   * Useful for performance monitoring and debugging.
   *
   * @returns Map of statement keys to execution statistics
   */
  getStatementStats(): Map<string, { executionCount: number; avgExecutionTime: number }> {
    const stats = new Map<string, { executionCount: number; avgExecutionTime: number }>()
    for (const [key, cache] of this.statementCache) {
      stats.set(key, {
        executionCount: cache.executionCount,
        avgExecutionTime: cache.executionCount > 0 ? cache.totalExecutionTime / cache.executionCount : 0,
      })
    }
    return stats
  }
}

// =============================================================================
// R2 Implementation (Cold Storage)
// =============================================================================

/**
 * R2 bucket interface for cold storage operations.
 */
interface R2Bucket {
  put(key: string, value: string | ArrayBuffer | ReadableStream, options?: { customMetadata?: Record<string, string> }): Promise<unknown>
  get(key: string): Promise<{ text(): Promise<string>; customMetadata?: Record<string, string> } | null>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    objects: Array<{ key: string; customMetadata?: Record<string, string> }>
    truncated: boolean
    cursor?: string
  }>
}

/**
 * R2BranchMetadata - Branch metadata archived to R2 cold storage.
 *
 * Stores archived branch metadata as JSON objects in R2. Useful for
 * long-term retention of branch history after branches are deleted
 * or archived from the active SQLite storage.
 *
 * Key format: `branches/archived/{name}.json`
 *
 * @example
 * ```typescript
 * const archive = new R2BranchMetadata(env.MY_BUCKET)
 *
 * // Archive a branch
 * await archive.archive(branchMetadata, 'Merged into main')
 *
 * // Retrieve archived branch
 * const archived = await archive.get('feature-old')
 * ```
 */
export class R2BranchMetadata {
  /** R2 bucket for storage */
  private readonly bucket: R2Bucket

  /** Key prefix for archived branches */
  private readonly prefix: string

  /**
   * Create a new R2BranchMetadata instance.
   *
   * @param bucket - R2 bucket instance
   * @param prefix - Key prefix (default: 'branches/archived')
   */
  constructor(bucket: R2Bucket, prefix = 'branches/archived') {
    this.bucket = bucket
    this.prefix = prefix
  }

  /**
   * Get the R2 key for a branch.
   *
   * @internal
   */
  private getKey(name: string): string {
    return `${this.prefix}/${name}.json`
  }

  /**
   * Archive a branch to R2.
   *
   * @param branch - Branch metadata to archive
   * @param reason - Optional reason for archival
   * @param archivedBy - Optional user/system identifier
   * @returns The archived branch record
   */
  async archive(branch: BranchMetadata, reason?: string, archivedBy?: string): Promise<ArchivedBranch> {
    const archived: ArchivedBranch = {
      ...branch,
      isArchived: true,
      archivedAt: Date.now(),
      archiveReason: reason,
      archivedBy,
    }

    const key = this.getKey(branch.name)
    await this.bucket.put(key, JSON.stringify(archived), {
      customMetadata: {
        archivedAt: String(archived.archivedAt),
        parentBranch: branch.parentBranch ?? '',
      },
    })

    return archived
  }

  /**
   * Get an archived branch.
   *
   * @param name - Branch identifier
   * @returns Archived branch or null if not found
   */
  async get(name: string): Promise<ArchivedBranch | null> {
    const key = this.getKey(name)
    const object = await this.bucket.get(key)
    if (!object) {
      return null
    }

    const text = await object.text()
    return JSON.parse(text) as ArchivedBranch
  }

  /**
   * Delete an archived branch.
   *
   * @param name - Branch identifier
   */
  async delete(name: string): Promise<void> {
    const key = this.getKey(name)
    await this.bucket.delete(key)
  }

  /**
   * List all archived branches.
   *
   * @param options - List options
   * @returns Array of archived branch names
   */
  async list(options?: { limit?: number; cursor?: string }): Promise<{ names: string[]; cursor?: string }> {
    const result = await this.bucket.list({
      prefix: this.prefix,
      limit: options?.limit,
      cursor: options?.cursor,
    })

    const names = result.objects.map((obj) => {
      // Extract branch name from key: prefix/{name}.json
      const key = obj.key
      const nameWithExt = key.slice(this.prefix.length + 1)
      return nameWithExt.replace(/\.json$/, '')
    })

    return {
      names,
      cursor: result.truncated ? result.cursor : undefined,
    }
  }

  /**
   * Check if an archived branch exists.
   *
   * @param name - Branch identifier
   * @returns true if archived branch exists
   */
  async exists(name: string): Promise<boolean> {
    const branch = await this.get(name)
    return branch !== null
  }
}

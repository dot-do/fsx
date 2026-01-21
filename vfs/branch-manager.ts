/**
 * Branch Manager - Copy-on-Write (COW) Branching for VFS
 *
 * Implements git-like branching for the extent-based VFS layer. Each branch
 * has its own ExtentStorage for writes, while reads walk up the branch
 * hierarchy until a page is found. Parent branches are immutable after
 * branching, enabling O(1) branch creation.
 *
 * Architecture:
 * ```
 * +----------------------------------------------------------+
 * |                    SQLite/PGlite VFS                      |
 * +----------------------------------------------------------+
 * |                    BranchManager (this)                   |
 * |  +------------+  +------------+  +------------+           |
 * |  |   Branch   |  |   Branch   |  |   Branch   |           |
 * |  |   "main"   |--|  "feature" |--|   "fix"    |           |
 * |  +------------+  +------------+  +------------+           |
 * |       |              |    COW Read Resolution             |
 * |       v              v                                    |
 * |  [ExtentStorage] [ExtentStorage]  (per-branch)           |
 * +----------------------------------------------------------+
 * |             SQL Metadata (branches, commits)              |
 * +----------------------------------------------------------+
 * |                    BlobStorage Backend                    |
 * +----------------------------------------------------------+
 * ```
 *
 * Key Concepts:
 * - **COW Read**: Walk up branch hierarchy until page is found
 * - **COW Write**: Always write to current branch's ExtentStorage
 * - **O(1) Branch Creation**: No data copy, just metadata
 * - **Immutable Parents**: Once branched, parent is never modified
 *
 * @module vfs/branch-manager
 */

import type { BlobStorage } from '../storage/interfaces.js'
import {
  ExtentStorage,
  createExtentStorage,
  type ExtentStorageConfig,
  type SqlStorageAdapter,
} from '../storage/extent-storage.js'
import { sha256 } from '../core/cas/hash.js'

// =============================================================================
// Branded Types
// =============================================================================

/**
 * Branded type for branch identifiers.
 * Ensures type safety when passing branch IDs.
 */
export interface BranchId {
  readonly _brand: 'BranchId'
  readonly value: string
}

/**
 * Branded type for commit identifiers.
 * Ensures type safety when passing commit IDs.
 */
export interface CommitId {
  readonly _brand: 'CommitId'
  readonly value: string
}

/**
 * Create a BranchId from a string value.
 */
export function createBranchId(value: string): BranchId {
  return { _brand: 'BranchId', value } as BranchId
}

/**
 * Create a CommitId from a string value.
 */
export function createCommitId(value: string): CommitId {
  return { _brand: 'CommitId', value } as CommitId
}

/**
 * Generate a unique branch ID.
 */
function generateBranchId(): BranchId {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return createBranchId(`br-${timestamp}-${random}`)
}

/**
 * Generate a unique commit ID from content hash.
 */
async function generateCommitId(message: string, timestamp: number, branchId: BranchId): Promise<CommitId> {
  const content = `${message}|${timestamp}|${branchId.value}|${Math.random()}`
  const hash = await sha256(content)
  return createCommitId(`cm-${hash.substring(0, 24)}`)
}

// =============================================================================
// Types
// =============================================================================

/**
 * Branch metadata.
 */
export interface Branch {
  /** Unique branch identifier */
  readonly id: BranchId
  /** Human-readable branch name */
  readonly name: string
  /** Parent branch ID (null for root branch) */
  readonly parentBranch: BranchId | null
  /** Commit ID at the time of branching (base commit) */
  readonly baseCommit: CommitId | null
  /** Creation timestamp (ms since epoch) */
  readonly createdAt: number
  /** Current head commit (most recent commit on this branch) */
  readonly headCommit: CommitId | null
}

/**
 * Commit metadata with snapshot reference.
 */
export interface Commit {
  /** Unique commit identifier */
  readonly id: CommitId
  /** Branch this commit belongs to */
  readonly branchId: BranchId
  /** Commit message */
  readonly message: string
  /** Commit timestamp (ms since epoch) */
  readonly timestamp: number
  /** Parent commit (null for initial commit) */
  readonly parentCommit: CommitId | null
  /** Snapshot of extent state at commit time */
  readonly snapshot: ExtentSnapshot
}

/**
 * Snapshot of all files at a point in time.
 */
export interface ExtentSnapshot {
  /** Map of file ID to file snapshot */
  readonly files: Map<string, FileSnapshot>
}

/**
 * Snapshot of a single file's extent state.
 */
export interface FileSnapshot {
  /** File identifier */
  readonly fileId: string
  /** File size in bytes at snapshot time */
  readonly size: number
  /** Extent IDs that make up this file */
  readonly extentIds: string[]
}

/**
 * Configuration for BranchManager.
 */
export interface BranchManagerConfig {
  /** Blob storage backend for extent data */
  backend: BlobStorage
  /** SQL storage adapter for metadata */
  sql: SqlStorageAdapter
  /** Page size in bytes (default: 4096 for SQLite) */
  pageSize: number
  /** Extent size in bytes (default: 2MB) */
  extentSize: number
  /** Compression codec (default: 'none') */
  compression?: 'none' | 'gzip'
  /** Prefix for extent keys in blob storage (default: 'extent/') */
  extentPrefix?: string
}

/**
 * Branch manager interface for COW branching support.
 */
export interface BranchManager {
  // Branch operations
  /** Create a new branch from current or specified branch */
  createBranch(name: string, fromBranch?: string): Promise<BranchId>
  /** Switch to a different branch */
  switchBranch(name: string): Promise<void>
  /** Delete a branch (cannot delete current branch) */
  deleteBranch(name: string): Promise<void>
  /** List all branches */
  listBranches(): Promise<Branch[]>
  /** Get current branch */
  getCurrentBranch(): Branch

  // COW page access (for VFS adapters)
  /** Read a page using COW resolution (walk up branch hierarchy) */
  readPage(fileId: string, pageNum: number): Promise<Uint8Array | null>
  /** Write a page to current branch (COW write) */
  writePage(fileId: string, pageNum: number, data: Uint8Array): Promise<void>

  // File operations
  /** Get file size by walking branch hierarchy */
  getFileSize(fileId: string): Promise<number>
  /** Truncate a file in current branch */
  truncate(fileId: string, size: number): Promise<void>
  /** Delete a file from current branch */
  deleteFile(fileId: string): Promise<void>
  /** List all files visible from current branch */
  listFiles(): Promise<string[]>

  // Sync
  /** Flush all pending writes to extents */
  flush(): Promise<void>

  // Commit/snapshot
  /** Create a commit with current state */
  commit(message: string): Promise<CommitId>
  /** Checkout a specific commit or branch */
  checkout(commitOrBranch: CommitId | string): Promise<void>
  /** Get commit history for current or specified branch */
  getCommitHistory(branchName?: string): Promise<Commit[]>
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Branch manager error codes.
 */
export type BranchErrorCode =
  | 'BRANCH_NOT_FOUND'
  | 'BRANCH_EXISTS'
  | 'CANNOT_DELETE_CURRENT'
  | 'CANNOT_DELETE_MAIN'
  | 'COMMIT_NOT_FOUND'
  | 'NO_CHANGES'
  | 'INVALID_CHECKOUT'
  | 'NOT_INITIALIZED'

/**
 * Branch manager error.
 */
export class BranchError extends Error {
  readonly code: BranchErrorCode

  constructor(code: BranchErrorCode, message: string) {
    super(message)
    this.name = 'BranchError'
    this.code = code

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, BranchError)
    }
  }

  static branchNotFound(name: string): BranchError {
    return new BranchError('BRANCH_NOT_FOUND', `Branch not found: ${name}`)
  }

  static branchExists(name: string): BranchError {
    return new BranchError('BRANCH_EXISTS', `Branch already exists: ${name}`)
  }

  static cannotDeleteCurrent(): BranchError {
    return new BranchError('CANNOT_DELETE_CURRENT', 'Cannot delete current branch')
  }

  static cannotDeleteMain(): BranchError {
    return new BranchError('CANNOT_DELETE_MAIN', 'Cannot delete main branch')
  }

  static commitNotFound(id: string): BranchError {
    return new BranchError('COMMIT_NOT_FOUND', `Commit not found: ${id}`)
  }

  static noChanges(): BranchError {
    return new BranchError('NO_CHANGES', 'No changes to commit')
  }

  static notInitialized(): BranchError {
    return new BranchError('NOT_INITIALIZED', 'Branch manager not initialized. Call init() first.')
  }
}

// =============================================================================
// SQL Schema
// =============================================================================

const CREATE_BRANCHES_TABLE = `
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  parent_branch_id TEXT,
  base_commit_id TEXT,
  head_commit_id TEXT,
  created_at INTEGER NOT NULL
);
`

const CREATE_COMMITS_TABLE = `
CREATE TABLE IF NOT EXISTS commits (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  message TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  parent_commit_id TEXT,
  snapshot_json TEXT NOT NULL
);
`

const CREATE_BRANCH_FILES_TABLE = `
CREATE TABLE IF NOT EXISTS branch_files (
  branch_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  modified_at INTEGER NOT NULL,
  PRIMARY KEY (branch_id, file_id)
);
`

const CREATE_BRANCH_PAGES_TABLE = `
CREATE TABLE IF NOT EXISTS branch_pages (
  branch_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  page_num INTEGER NOT NULL,
  PRIMARY KEY (branch_id, file_id, page_num)
);
`

// =============================================================================
// GitBranchManager Implementation
// =============================================================================

/**
 * Git-like branch manager with COW semantics.
 *
 * Implements Copy-on-Write branching where each branch has its own
 * ExtentStorage for writes, while reads walk up the branch hierarchy.
 * Parent branches are immutable after creation, enabling O(1) branching.
 *
 * @example
 * ```typescript
 * // Create and initialize
 * const manager = new GitBranchManager({
 *   backend: r2Storage,
 *   sql: sqlAdapter,
 *   pageSize: 4096,
 *   extentSize: 2 * 1024 * 1024,
 * })
 * await manager.init()
 *
 * // Write to main branch
 * await manager.writePage('db.sqlite', 0, page0Data)
 * await manager.commit('Initial database')
 *
 * // Create feature branch (O(1) - no data copy)
 * await manager.createBranch('feature')
 * await manager.switchBranch('feature')
 *
 * // Write to feature branch (COW - only this branch modified)
 * await manager.writePage('db.sqlite', 0, modifiedPage0)
 *
 * // Reads walk up hierarchy (feature -> main)
 * const page1 = await manager.readPage('db.sqlite', 1) // From main
 * const page0 = await manager.readPage('db.sqlite', 0) // From feature
 * ```
 */
export class GitBranchManager implements BranchManager {
  private readonly config: Required<BranchManagerConfig>
  private currentBranch: Branch | null = null
  private initialized = false

  // Per-branch ExtentStorage instances (lazy loaded)
  private branchExtentStorage = new Map<string, ExtentStorage>()

  constructor(config: BranchManagerConfig) {
    this.config = {
      backend: config.backend,
      sql: config.sql,
      pageSize: config.pageSize,
      extentSize: config.extentSize,
      compression: config.compression ?? 'none',
      extentPrefix: config.extentPrefix ?? 'extent/',
    }
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  /**
   * Initialize the branch manager.
   * Creates tables and ensures 'main' branch exists.
   */
  async init(): Promise<void> {
    if (this.initialized) return

    // Create tables
    this.config.sql.exec(CREATE_BRANCHES_TABLE)
    this.config.sql.exec(CREATE_COMMITS_TABLE)
    this.config.sql.exec(CREATE_BRANCH_FILES_TABLE)
    this.config.sql.exec(CREATE_BRANCH_PAGES_TABLE)

    // Ensure main branch exists
    const mainResult = this.config.sql.exec("SELECT * FROM branches WHERE name = 'main'")
    if (mainResult.rows.length === 0) {
      const mainId = generateBranchId()
      const now = Date.now()
      this.config.sql.exec(
        'INSERT INTO branches (id, name, parent_branch_id, base_commit_id, head_commit_id, created_at) VALUES (?, ?, NULL, NULL, NULL, ?)',
        [mainId.value, 'main', now]
      )
    }

    // Set current branch to main
    const main = await this.getBranchByName('main')
    if (!main) {
      throw new Error('Failed to initialize main branch')
    }
    this.currentBranch = main

    this.initialized = true
  }

  /**
   * Ensure manager is initialized.
   */
  private ensureInit(): void {
    if (!this.initialized || !this.currentBranch) {
      throw BranchError.notInitialized()
    }
  }

  // ===========================================================================
  // Branch Operations
  // ===========================================================================

  /**
   * Create a new branch.
   *
   * O(1) operation - only creates metadata, no data copy.
   * The new branch shares all data with its parent through COW read resolution.
   *
   * @param name - Name for the new branch
   * @param fromBranch - Parent branch name (default: current branch)
   * @returns New branch ID
   */
  async createBranch(name: string, fromBranch?: string): Promise<BranchId> {
    this.ensureInit()

    // Check if branch already exists
    const existing = await this.getBranchByName(name)
    if (existing) {
      throw BranchError.branchExists(name)
    }

    // Get parent branch
    const parent = fromBranch ? await this.getBranchByName(fromBranch) : this.currentBranch!

    if (!parent) {
      throw BranchError.branchNotFound(fromBranch ?? 'current')
    }

    // Create new branch - O(1), no data copy!
    const id = generateBranchId()
    const now = Date.now()

    this.config.sql.exec(
      'INSERT INTO branches (id, name, parent_branch_id, base_commit_id, head_commit_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
      [id.value, name, parent.id.value, parent.headCommit?.value ?? null, now]
    )

    return id
  }

  /**
   * Switch to a different branch.
   *
   * @param name - Branch name to switch to
   */
  async switchBranch(name: string): Promise<void> {
    this.ensureInit()

    const branch = await this.getBranchByName(name)
    if (!branch) {
      throw BranchError.branchNotFound(name)
    }

    // Flush current branch before switching
    await this.flush()

    this.currentBranch = branch
  }

  /**
   * Delete a branch.
   *
   * Cannot delete the current branch or 'main' branch.
   *
   * @param name - Branch name to delete
   */
  async deleteBranch(name: string): Promise<void> {
    this.ensureInit()

    if (name === 'main') {
      throw BranchError.cannotDeleteMain()
    }

    const branch = await this.getBranchByName(name)
    if (!branch) {
      throw BranchError.branchNotFound(name)
    }

    if (branch.id.value === this.currentBranch!.id.value) {
      throw BranchError.cannotDeleteCurrent()
    }

    // Delete branch data
    this.config.sql.exec('DELETE FROM branch_pages WHERE branch_id = ?', [branch.id.value])
    this.config.sql.exec('DELETE FROM branch_files WHERE branch_id = ?', [branch.id.value])
    this.config.sql.exec('DELETE FROM commits WHERE branch_id = ?', [branch.id.value])
    this.config.sql.exec('DELETE FROM branches WHERE id = ?', [branch.id.value])

    // Clean up extent storage
    const storage = this.branchExtentStorage.get(branch.id.value)
    if (storage) {
      // Delete all files from this branch's storage
      const files = await storage.listFiles()
      for (const fileId of files) {
        await storage.deleteFile(fileId)
      }
      this.branchExtentStorage.delete(branch.id.value)
    }
  }

  /**
   * List all branches.
   *
   * @returns Array of all branches
   */
  async listBranches(): Promise<Branch[]> {
    this.ensureInit()

    const result = this.config.sql.exec('SELECT * FROM branches ORDER BY created_at')
    return result.rows.map((row) => this.rowToBranch(row))
  }

  /**
   * Get the current branch.
   *
   * @returns Current branch
   */
  getCurrentBranch(): Branch {
    this.ensureInit()
    return this.currentBranch!
  }

  // ===========================================================================
  // COW Page Access
  // ===========================================================================

  /**
   * Read a page using COW resolution.
   *
   * Walks up the branch hierarchy until the page is found:
   * 1. Check current branch's ExtentStorage
   * 2. If not found, check parent branch
   * 3. Continue until page is found or no more parents
   *
   * @param fileId - File identifier
   * @param pageNum - Page number (0-indexed)
   * @returns Page data or null if not found
   */
  async readPage(fileId: string, pageNum: number): Promise<Uint8Array | null> {
    this.ensureInit()

    let branch: Branch | null = this.currentBranch!

    while (branch) {
      // Check if this page was written in this branch
      const pageExists = this.isPageInBranch(branch.id, fileId, pageNum)

      if (pageExists) {
        const storage = await this.getExtentStorageForBranch(branch.id)
        const page = await storage.readPage(this.getBranchFileId(branch.id, fileId), pageNum)
        if (page) return page
      }

      // Check if file was deleted in this branch
      if (this.isFileDeletedInBranch(branch.id, fileId)) {
        return null
      }

      // Not found in this branch, check parent
      branch = branch.parentBranch ? await this.getBranchById(branch.parentBranch) : null
    }

    return null // Page doesn't exist anywhere
  }

  /**
   * Write a page to the current branch.
   *
   * Always writes to the current branch's ExtentStorage.
   * Parent branches are never modified (immutable after branching).
   *
   * @param fileId - File identifier
   * @param pageNum - Page number (0-indexed)
   * @param data - Page data
   */
  async writePage(fileId: string, pageNum: number, data: Uint8Array): Promise<void> {
    this.ensureInit()

    const branchId = this.currentBranch!.id
    const storage = await this.getExtentStorageForBranch(branchId)

    // Write to current branch's extent storage
    await storage.writePage(this.getBranchFileId(branchId, fileId), pageNum, data)

    // Track that this page is now in current branch
    this.markPageInBranch(branchId, fileId, pageNum)

    // Update file metadata
    const newSize = (pageNum + 1) * this.config.pageSize
    this.updateFileMetadata(branchId, fileId, newSize)
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Get file size by walking branch hierarchy.
   *
   * @param fileId - File identifier
   * @returns File size in bytes
   */
  async getFileSize(fileId: string): Promise<number> {
    this.ensureInit()

    let branch: Branch | null = this.currentBranch!

    while (branch) {
      // Check if file exists in this branch
      const result = this.config.sql.exec(
        'SELECT size, deleted FROM branch_files WHERE branch_id = ? AND file_id = ?',
        [branch.id.value, fileId]
      )

      if (result.rows.length > 0) {
        const row = result.rows[0]!
        if (row.deleted) {
          return 0 // File was deleted in this branch
        }
        return row.size as number
      }

      // Check parent
      branch = branch.parentBranch ? await this.getBranchById(branch.parentBranch) : null
    }

    return 0
  }

  /**
   * Truncate a file in the current branch.
   *
   * @param fileId - File identifier
   * @param size - New size in bytes
   */
  async truncate(fileId: string, size: number): Promise<void> {
    this.ensureInit()

    const branchId = this.currentBranch!.id
    const storage = await this.getExtentStorageForBranch(branchId)

    await storage.truncate(this.getBranchFileId(branchId, fileId), size)
    this.updateFileMetadata(branchId, fileId, size)
  }

  /**
   * Delete a file from the current branch.
   *
   * Marks the file as deleted in this branch. The file may still exist
   * in parent branches (visible when switching to them).
   *
   * @param fileId - File identifier
   */
  async deleteFile(fileId: string): Promise<void> {
    this.ensureInit()

    const branchId = this.currentBranch!.id
    const storage = await this.getExtentStorageForBranch(branchId)

    // Delete from extent storage
    await storage.deleteFile(this.getBranchFileId(branchId, fileId))

    // Mark as deleted in branch
    const now = Date.now()
    this.config.sql.exec(
      `INSERT OR REPLACE INTO branch_files (branch_id, file_id, size, deleted, modified_at)
       VALUES (?, ?, 0, 1, ?)`,
      [branchId.value, fileId, now]
    )

    // Remove page tracking
    this.config.sql.exec('DELETE FROM branch_pages WHERE branch_id = ? AND file_id = ?', [branchId.value, fileId])
  }

  /**
   * List all files visible from the current branch.
   *
   * @returns Array of file IDs
   */
  async listFiles(): Promise<string[]> {
    this.ensureInit()

    const files = new Map<string, boolean>() // fileId -> deleted
    let branch: Branch | null = this.currentBranch!

    // Walk up branch hierarchy
    while (branch) {
      const result = this.config.sql.exec('SELECT file_id, deleted FROM branch_files WHERE branch_id = ?', [
        branch.id.value,
      ])

      for (const row of result.rows) {
        const fileId = row.file_id as string
        // Only add if not already tracked (child branch takes precedence)
        if (!files.has(fileId)) {
          files.set(fileId, row.deleted === 1)
        }
      }

      branch = branch.parentBranch ? await this.getBranchById(branch.parentBranch) : null
    }

    // Return non-deleted files
    return Array.from(files.entries())
      .filter(([, deleted]) => !deleted)
      .map(([fileId]) => fileId)
      .sort()
  }

  // ===========================================================================
  // Sync
  // ===========================================================================

  /**
   * Flush all pending writes to extents.
   */
  async flush(): Promise<void> {
    this.ensureInit()

    const storage = await this.getExtentStorageForBranch(this.currentBranch!.id)
    await storage.flush()
  }

  // ===========================================================================
  // Commit/Snapshot
  // ===========================================================================

  /**
   * Create a commit with the current state.
   *
   * @param message - Commit message
   * @returns New commit ID
   */
  async commit(message: string): Promise<CommitId> {
    this.ensureInit()

    // Flush pending writes first
    await this.flush()

    const branchId = this.currentBranch!.id
    const timestamp = Date.now()

    // Generate commit ID
    const commitId = await generateCommitId(message, timestamp, branchId)

    // Create snapshot of current state
    const snapshot = await this.createSnapshot(branchId)

    // Get parent commit
    const parentCommit = this.currentBranch!.headCommit

    // Serialize snapshot
    const snapshotJson = this.serializeSnapshot(snapshot)

    // Insert commit
    this.config.sql.exec(
      'INSERT INTO commits (id, branch_id, message, timestamp, parent_commit_id, snapshot_json) VALUES (?, ?, ?, ?, ?, ?)',
      [commitId.value, branchId.value, message, timestamp, parentCommit?.value ?? null, snapshotJson]
    )

    // Update branch head
    this.config.sql.exec('UPDATE branches SET head_commit_id = ? WHERE id = ?', [commitId.value, branchId.value])

    // Update current branch reference
    this.currentBranch = {
      ...this.currentBranch!,
      headCommit: commitId,
    }

    return commitId
  }

  /**
   * Checkout a specific commit or branch.
   *
   * @param commitOrBranch - CommitId or branch name
   */
  async checkout(commitOrBranch: CommitId | string): Promise<void> {
    this.ensureInit()

    if (typeof commitOrBranch === 'string') {
      // Checkout branch
      await this.switchBranch(commitOrBranch)
    } else {
      // Checkout commit (detached HEAD state)
      const commit = await this.getCommitById(commitOrBranch)
      if (!commit) {
        throw BranchError.commitNotFound(commitOrBranch.value)
      }

      // For now, checkout commit means switching to the branch
      // and resetting to that commit's state
      const branch = await this.getBranchById(commit.branchId)
      if (!branch) {
        throw BranchError.branchNotFound(commit.branchId.value)
      }

      await this.flush()
      this.currentBranch = branch
    }
  }

  /**
   * Get commit history for current or specified branch.
   *
   * @param branchName - Branch name (default: current branch)
   * @returns Array of commits, newest first
   */
  async getCommitHistory(branchName?: string): Promise<Commit[]> {
    this.ensureInit()

    const branch = branchName ? await this.getBranchByName(branchName) : this.currentBranch!

    if (!branch) {
      throw BranchError.branchNotFound(branchName ?? 'current')
    }

    const result = this.config.sql.exec(
      'SELECT * FROM commits WHERE branch_id = ? ORDER BY timestamp DESC',
      [branch.id.value]
    )

    return result.rows.map((row) => this.rowToCommit(row))
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Get or create ExtentStorage for a branch.
   */
  private async getExtentStorageForBranch(branchId: BranchId): Promise<ExtentStorage> {
    let storage = this.branchExtentStorage.get(branchId.value)

    if (!storage) {
      const config: ExtentStorageConfig = {
        pageSize: this.config.pageSize,
        extentSize: this.config.extentSize,
        compression: this.config.compression,
        backend: this.config.backend,
        sql: this.config.sql,
        extentPrefix: `${this.config.extentPrefix}${branchId.value}/`,
        autoFlush: true,
      }
      storage = await createExtentStorage(config)
      this.branchExtentStorage.set(branchId.value, storage)
    }

    return storage
  }

  /**
   * Get file ID scoped to a branch.
   */
  private getBranchFileId(branchId: BranchId, fileId: string): string {
    return `${branchId.value}:${fileId}`
  }

  /**
   * Get branch by name.
   */
  private async getBranchByName(name: string): Promise<Branch | null> {
    const result = this.config.sql.exec('SELECT * FROM branches WHERE name = ?', [name])
    if (result.rows.length === 0) return null
    return this.rowToBranch(result.rows[0]!)
  }

  /**
   * Get branch by ID.
   */
  private async getBranchById(id: BranchId): Promise<Branch | null> {
    const result = this.config.sql.exec('SELECT * FROM branches WHERE id = ?', [id.value])
    if (result.rows.length === 0) return null
    return this.rowToBranch(result.rows[0]!)
  }

  /**
   * Get commit by ID.
   */
  private async getCommitById(id: CommitId): Promise<Commit | null> {
    const result = this.config.sql.exec('SELECT * FROM commits WHERE id = ?', [id.value])
    if (result.rows.length === 0) return null
    return this.rowToCommit(result.rows[0]!)
  }

  /**
   * Convert SQL row to Branch.
   */
  private rowToBranch(row: Record<string, unknown>): Branch {
    return {
      id: createBranchId(row.id as string),
      name: row.name as string,
      parentBranch: row.parent_branch_id ? createBranchId(row.parent_branch_id as string) : null,
      baseCommit: row.base_commit_id ? createCommitId(row.base_commit_id as string) : null,
      createdAt: row.created_at as number,
      headCommit: row.head_commit_id ? createCommitId(row.head_commit_id as string) : null,
    }
  }

  /**
   * Convert SQL row to Commit.
   */
  private rowToCommit(row: Record<string, unknown>): Commit {
    return {
      id: createCommitId(row.id as string),
      branchId: createBranchId(row.branch_id as string),
      message: row.message as string,
      timestamp: row.timestamp as number,
      parentCommit: row.parent_commit_id ? createCommitId(row.parent_commit_id as string) : null,
      snapshot: this.deserializeSnapshot(row.snapshot_json as string),
    }
  }

  /**
   * Check if a page exists in a specific branch.
   */
  private isPageInBranch(branchId: BranchId, fileId: string, pageNum: number): boolean {
    const result = this.config.sql.exec(
      'SELECT 1 FROM branch_pages WHERE branch_id = ? AND file_id = ? AND page_num = ?',
      [branchId.value, fileId, pageNum]
    )
    return result.rows.length > 0
  }

  /**
   * Check if a file was deleted in a specific branch.
   */
  private isFileDeletedInBranch(branchId: BranchId, fileId: string): boolean {
    const result = this.config.sql.exec(
      'SELECT deleted FROM branch_files WHERE branch_id = ? AND file_id = ?',
      [branchId.value, fileId]
    )
    return result.rows.length > 0 && result.rows[0]!.deleted === 1
  }

  /**
   * Mark a page as existing in a branch.
   */
  private markPageInBranch(branchId: BranchId, fileId: string, pageNum: number): void {
    this.config.sql.exec(
      'INSERT OR IGNORE INTO branch_pages (branch_id, file_id, page_num) VALUES (?, ?, ?)',
      [branchId.value, fileId, pageNum]
    )
  }

  /**
   * Update file metadata in a branch.
   */
  private updateFileMetadata(branchId: BranchId, fileId: string, size: number): void {
    const now = Date.now()

    // Get current size
    const result = this.config.sql.exec(
      'SELECT size FROM branch_files WHERE branch_id = ? AND file_id = ?',
      [branchId.value, fileId]
    )

    const currentSize = result.rows.length > 0 ? (result.rows[0]!.size as number) : 0
    const newSize = Math.max(currentSize, size)

    this.config.sql.exec(
      `INSERT OR REPLACE INTO branch_files (branch_id, file_id, size, deleted, modified_at)
       VALUES (?, ?, ?, 0, ?)`,
      [branchId.value, fileId, newSize, now]
    )
  }

  /**
   * Create a snapshot of the current branch state.
   */
  private async createSnapshot(branchId: BranchId): Promise<ExtentSnapshot> {
    const filesResult = this.config.sql.exec(
      'SELECT file_id, size FROM branch_files WHERE branch_id = ? AND deleted = 0',
      [branchId.value]
    )

    const files = new Map<string, FileSnapshot>()

    for (const row of filesResult.rows) {
      const fileId = row.file_id as string
      const size = row.size as number

      // Note: ExtentStorage tracks extents internally but doesn't expose extent IDs
      // directly. For full snapshot tracking, we would need to add extent ID
      // tracking to ExtentStorage or query the extents table directly.
      files.set(fileId, {
        fileId,
        size,
        extentIds: [], // Extent IDs tracked separately in extents table
      })
    }

    return { files }
  }

  /**
   * Serialize snapshot to JSON.
   */
  private serializeSnapshot(snapshot: ExtentSnapshot): string {
    const obj: Record<string, { fileId: string; size: number; extentIds: string[] }> = {}
    for (const [key, value] of snapshot.files) {
      obj[key] = value
    }
    return JSON.stringify(obj)
  }

  /**
   * Deserialize snapshot from JSON.
   */
  private deserializeSnapshot(json: string): ExtentSnapshot {
    const obj = JSON.parse(json) as Record<string, { fileId: string; size: number; extentIds: string[] }>
    const files = new Map<string, FileSnapshot>()
    for (const [key, value] of Object.entries(obj)) {
      files.set(key, value)
    }
    return { files }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create and initialize a BranchManager instance.
 *
 * @param config - Branch manager configuration
 * @returns Initialized GitBranchManager instance
 *
 * @example
 * ```typescript
 * const manager = await createBranchManager({
 *   backend: r2Storage,
 *   sql: sqlAdapter,
 *   pageSize: 4096,
 *   extentSize: 2 * 1024 * 1024,
 * })
 *
 * // Write data to main branch
 * await manager.writePage('mydb.sqlite', 0, page0)
 * await manager.commit('Initial commit')
 *
 * // Create feature branch (O(1), no data copy)
 * await manager.createBranch('feature')
 * await manager.switchBranch('feature')
 *
 * // Modify in feature branch
 * await manager.writePage('mydb.sqlite', 0, modifiedPage0)
 *
 * // Reads use COW resolution
 * const page = await manager.readPage('mydb.sqlite', 1) // From main
 * ```
 */
export async function createBranchManager(config: BranchManagerConfig): Promise<BranchManager> {
  const manager = new GitBranchManager(config)
  await manager.init()
  return manager
}

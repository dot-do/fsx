/**
 * SQLiteMetadata - SQLite-backed metadata store for fsx
 *
 * Stores filesystem metadata in SQLite (via Durable Objects or D1).
 * Implements the {@link MetadataStorage} interface for consistent API.
 *
 * Features:
 * - INTEGER PRIMARY KEY for efficient rowid-based lookups
 * - Foreign key constraints for referential integrity
 * - Indexed paths and parent relationships for fast traversal
 * - Tiered storage tracking for hot/warm/cold placement
 * - Blob reference management with checksums
 *
 * Schema:
 * - `files` table: filesystem entries (files, directories, symlinks)
 * - `blobs` table: blob storage references with tier tracking
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
 * ```
 *
 * @module storage/sqlite
 */

import type { FileEntry, FileType, BlobRef, StorageTier } from '../core/types.js'
import type {
  MetadataStorage,
  CreateEntryOptions,
  UpdateEntryOptions,
  StorageStats,
} from './interfaces.js'

/**
 * Internal file row structure matching the SQLite schema.
 *
 * Uses integer rowid for efficient storage and lookups.
 * Column names use snake_case to match SQL conventions.
 *
 * @internal
 */
interface FileRow {
  /** Auto-incrementing row ID */
  id: number
  /** Full absolute path */
  path: string
  /** File/directory name (last path component) */
  name: string
  /** Parent directory ID (null for root) */
  parent_id: number | null
  /** Entry type: 'file' | 'directory' | 'symlink' */
  type: string
  /** POSIX permissions mode */
  mode: number
  /** Owner user ID */
  uid: number
  /** Owner group ID */
  gid: number
  /** File size in bytes */
  size: number
  /** Associated blob ID for file content */
  blob_id: string | null
  /** Symlink target path */
  link_target: string | null
  /** Storage tier: 'hot' | 'warm' | 'cold' */
  tier: string
  /** Access time (Unix ms) */
  atime: number
  /** Modification time (Unix ms) */
  mtime: number
  /** Status change time (Unix ms) */
  ctime: number
  /** Creation time (Unix ms) */
  birthtime: number
  /** Hard link count */
  nlink: number
  /** Index signature for SqlStorage compatibility */
  [key: string]: SqlStorageValue
}

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
export class SQLiteMetadata implements MetadataStorage {
  /** SQLite storage instance */
  private readonly sql: SqlStorage

  /**
   * Create a new SQLiteMetadata instance.
   *
   * @param sql - SqlStorage instance from Durable Object context or D1
   */
  constructor(sql: SqlStorage) {
    this.sql = sql
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
  async init(): Promise<void> {
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
    `)

    // Create indexes for files table (separate statements for proper tracking)
    await this.sql.exec('CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)')
    await this.sql.exec('CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent_id)')
    await this.sql.exec('CREATE INDEX IF NOT EXISTS idx_files_tier ON files(tier)')

    // Create blobs table
    await this.sql.exec(`
      CREATE TABLE IF NOT EXISTS blobs (
        id TEXT PRIMARY KEY,
        tier TEXT NOT NULL DEFAULT 'hot' CHECK(tier IN ('hot', 'warm', 'cold')),
        size INTEGER NOT NULL,
        checksum TEXT,
        created_at INTEGER NOT NULL
      )
    `)

    // Create index for blobs table
    await this.sql.exec('CREATE INDEX IF NOT EXISTS idx_blobs_tier ON blobs(tier)')

    // Create root if not exists (using explicit id=0 to reserve auto-increment for user files)
    const root = await this.getByPath('/')
    if (!root) {
      const now = Date.now()
      await this.sql.exec(
        `INSERT INTO files (id, path, name, parent_id, type, mode, uid, gid, size, tier, atime, mtime, ctime, birthtime, nlink)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        0,
        '/',
        '',
        null,
        'directory',
        0o755,
        0,
        0,
        0,
        'hot',
        now,
        now,
        now,
        now,
        2
      )
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
  private rowToEntry(row: FileRow): FileEntry {
    return {
      id: String(row.id),
      path: row.path,
      name: row.name,
      parentId: row.parent_id !== null ? String(row.parent_id) : null,
      type: row.type as FileType,
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
    }
  }

  /**
   * Get a file entry by its absolute path.
   *
   * Uses the indexed path column for efficient lookup.
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
  async getByPath(path: string): Promise<FileEntry | null> {
    const result = await this.sql.exec<FileRow>('SELECT * FROM files WHERE path = ?', path).one()
    return result ? this.rowToEntry(result) : null
  }

  /**
   * Get a file entry by its numeric ID.
   *
   * Uses the primary key for O(1) lookup performance.
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
  async getById(id: string): Promise<FileEntry | null> {
    const numericId = parseInt(id, 10)
    if (isNaN(numericId)) return null
    const result = await this.sql.exec<FileRow>('SELECT * FROM files WHERE id = ?', numericId).one()
    return result ? this.rowToEntry(result) : null
  }

  /**
   * Get all children of a directory.
   *
   * Uses the indexed parent_id column for efficient queries.
   * Returns an empty array if the parent doesn't exist or has no children.
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
  async getChildren(parentId: string): Promise<FileEntry[]> {
    const numericId = parseInt(parentId, 10)
    if (isNaN(numericId)) return []
    const rows = this.sql.exec<FileRow>('SELECT * FROM files WHERE parent_id = ?', numericId).toArray()
    return rows.map((row) => this.rowToEntry(row))
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
  async createEntry(entry: CreateEntryOptions): Promise<number> {
    const now = Date.now()
    const parentIdNum = entry.parentId !== null ? parseInt(entry.parentId, 10) : null
    await this.sql.exec(
      `INSERT INTO files (path, name, parent_id, type, mode, uid, gid, size, blob_id, link_target, tier, atime, mtime, ctime, birthtime, nlink)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.path,
      entry.name,
      parentIdNum,
      entry.type,
      entry.mode,
      entry.uid,
      entry.gid,
      entry.size,
      entry.blobId,
      entry.linkTarget,
      entry.tier ?? 'hot',
      now,
      now,
      now,
      now,
      entry.nlink
    )
    // Fetch the inserted entry by path to get its ID (avoids race conditions with concurrent inserts)
    const result = await this.sql.exec<FileRow>('SELECT * FROM files WHERE path = ?', entry.path).one()
    return result?.id ?? 0
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
  async updateEntry(id: string, updates: UpdateEntryOptions): Promise<void> {
    const numericId = parseInt(id, 10)
    if (isNaN(numericId)) return

    const sets: string[] = []
    const values: unknown[] = []

    if (updates.path !== undefined) {
      sets.push('path = ?')
      values.push(updates.path)
    }
    if (updates.name !== undefined) {
      sets.push('name = ?')
      values.push(updates.name)
    }
    if (updates.parentId !== undefined) {
      sets.push('parent_id = ?')
      const parentIdNum = updates.parentId !== null ? parseInt(updates.parentId, 10) : null
      values.push(parentIdNum)
    }
    if (updates.mode !== undefined) {
      sets.push('mode = ?')
      values.push(updates.mode)
    }
    if (updates.uid !== undefined) {
      sets.push('uid = ?')
      values.push(updates.uid)
    }
    if (updates.gid !== undefined) {
      sets.push('gid = ?')
      values.push(updates.gid)
    }
    if (updates.size !== undefined) {
      sets.push('size = ?')
      values.push(updates.size)
    }
    if (updates.blobId !== undefined) {
      sets.push('blob_id = ?')
      values.push(updates.blobId)
    }
    if (updates.tier !== undefined) {
      sets.push('tier = ?')
      values.push(updates.tier)
    }
    if (updates.atime !== undefined) {
      sets.push('atime = ?')
      values.push(updates.atime)
    }
    if (updates.mtime !== undefined) {
      sets.push('mtime = ?')
      values.push(updates.mtime)
    }

    // Always update ctime
    sets.push('ctime = ?')
    values.push(Date.now())

    values.push(numericId)

    await this.sql.exec(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`, ...values)
  }

  /**
   * Delete a file entry.
   *
   * Uses CASCADE delete to automatically remove child entries
   * when deleting a directory.
   *
   * @param id - Entry ID to delete
   *
   * @example
   * ```typescript
   * await metadata.deleteEntry(entry.id)
   * ```
   */
  async deleteEntry(id: string): Promise<void> {
    const numericId = parseInt(id, 10)
    if (isNaN(numericId)) return
    await this.sql.exec('DELETE FROM files WHERE id = ?', numericId)
  }

  /**
   * Register a blob in the metadata store.
   *
   * Creates a reference to a blob stored in external storage (e.g., R2).
   * The blob ID should be unique and typically matches the blob's hash.
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
  async registerBlob(blob: { id: string; tier: StorageTier; size: number; checksum?: string }): Promise<void> {
    await this.sql.exec('INSERT INTO blobs (id, tier, size, checksum, created_at) VALUES (?, ?, ?, ?, ?)', blob.id, blob.tier, blob.size, blob.checksum || null, Date.now())
  }

  /**
   * Get blob metadata by ID.
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
  async getBlob(id: string): Promise<BlobRef | null> {
    const result = await this.sql.exec<BlobRef>('SELECT * FROM blobs WHERE id = ?', id).one()
    return result || null
  }

  /**
   * Update a blob's storage tier.
   *
   * Used when migrating blobs between hot/warm/cold storage.
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
  async updateBlobTier(id: string, tier: StorageTier): Promise<void> {
    await this.sql.exec('UPDATE blobs SET tier = ? WHERE id = ?', tier, id)
  }

  /**
   * Delete a blob reference.
   *
   * Note: This only removes the metadata reference. The actual blob
   * data in external storage must be cleaned up separately.
   *
   * @param id - Blob ID to delete
   *
   * @example
   * ```typescript
   * await metadata.deleteBlob('sha256-abc123...')
   * ```
   */
  async deleteBlob(id: string): Promise<void> {
    await this.sql.exec('DELETE FROM blobs WHERE id = ?', id)
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
  async findByPattern(pattern: string, parentPath?: string): Promise<FileEntry[]> {
    // Convert glob to SQL LIKE pattern
    const sqlPattern = pattern.replace(/\*/g, '%').replace(/\?/g, '_')

    let rows: FileRow[]
    if (parentPath) {
      rows = this.sql.exec<FileRow>('SELECT * FROM files WHERE path LIKE ? AND path LIKE ?', parentPath + '%', sqlPattern).toArray()
    } else {
      rows = this.sql.exec<FileRow>('SELECT * FROM files WHERE path LIKE ?', sqlPattern).toArray()
    }

    return rows.map((row) => this.rowToEntry(row))
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
  async getStats(): Promise<StorageStats> {
    const files = await this.sql.exec<{ count: number }>(`SELECT COUNT(*) as count FROM files WHERE type = 'file'`).one()
    const dirs = await this.sql.exec<{ count: number }>(`SELECT COUNT(*) as count FROM files WHERE type = 'directory'`).one()
    const size = await this.sql.exec<{ total: number }>('SELECT SUM(size) as total FROM files').one()

    const tierStats = await this.sql.exec<{ tier: string; count: number; size: number }>('SELECT tier, COUNT(*) as count, SUM(size) as size FROM blobs GROUP BY tier').toArray()

    // Only include tiers that have data (preserves backward compatibility)
    const blobsByTier: Record<StorageTier, { count: number; size: number }> = {} as Record<StorageTier, { count: number; size: number }>

    for (const stat of tierStats) {
      const tier = stat.tier as StorageTier
      blobsByTier[tier] = { count: stat.count, size: stat.size ?? 0 }
    }

    return {
      totalFiles: files?.count ?? 0,
      totalDirectories: dirs?.count ?? 0,
      totalSize: size?.total ?? 0,
      blobsByTier,
    }
  }
}

/**
 * ExtentStorage - Core Layer for Production-Grade VFS
 *
 * Packs 4KB/8KB database pages into 2MB extents for ~500x cost reduction
 * on Cloudflare Durable Objects. This is the foundation layer that sits
 * between the SQLite/PostgreSQL VFS adapters and the blob storage backend.
 *
 * Key Features:
 * - Content-addressable extent storage (hash-based IDs)
 * - Write buffering in SQL for durability
 * - Automatic extent packing when buffer is full
 * - Support for sparse extents (pages with gaps)
 * - Optional gzip compression
 *
 * Architecture:
 * ```
 * +-----------------------------------------------------------------+
 * |                    SQLiteVFS / PGliteFS                         |
 * +-----------------------------------------------------------------+
 * |                    ExtentStorage (this)                         |
 * |  +------------+  +------------+  +------------+                 |
 * |  | Dirty Pages|  |  Extents   |  |  Metadata  |                 |
 * |  |   (SQL)    |  |(BlobStorage|  |    (SQL)   |                 |
 * |  +------------+  +------------+  +------------+                 |
 * +-----------------------------------------------------------------+
 * |            BlobStorage (R2, Memory, etc.)                       |
 * +-----------------------------------------------------------------+
 * ```
 *
 * @module storage/extent-storage
 */

import type { BlobStorage, BlobWriteResult } from './interfaces.js'
import {
  buildExtent,
  parseExtentHeader,
  extractPage,
  calculatePagesPerExtent,
  type ExtentHeader,
  type BuildExtentOptions,
} from './extent-format.js'
import { sha256 } from '../core/cas/hash.js'

// =============================================================================
// SQL Storage Interface (Portable)
// =============================================================================

/**
 * SQL result row type
 */
export type SqlRow = Record<string, string | number | null | ArrayBuffer | Uint8Array>

/**
 * SQL result set from exec()
 */
export interface SqlResultSet {
  /** Result rows */
  rows: SqlRow[]
  /** Number of rows affected (for INSERT/UPDATE/DELETE) */
  rowsAffected?: number
  /** Last inserted row ID */
  lastInsertId?: number
}

/**
 * Minimal SQL storage interface for portability.
 *
 * This interface abstracts the SQL database used for metadata storage,
 * allowing ExtentStorage to work with different SQL backends:
 * - Cloudflare Durable Objects (DO) SqlStorage
 * - better-sqlite3 for local development
 * - In-memory SQL for testing
 *
 * @example
 * ```typescript
 * // Durable Objects adapter
 * const sqlAdapter: SqlStorageAdapter = {
 *   exec: (query, params) => {
 *     const cursor = doSql.exec(query, ...params)
 *     return { rows: cursor.toArray() }
 *   }
 * }
 *
 * // better-sqlite3 adapter
 * const sqliteAdapter: SqlStorageAdapter = {
 *   exec: (query, params) => {
 *     const stmt = db.prepare(query)
 *     const rows = stmt.all(...params)
 *     return { rows }
 *   }
 * }
 * ```
 */
export interface SqlStorageAdapter {
  /**
   * Execute a SQL query with parameters.
   *
   * @param query - SQL query string with ? placeholders
   * @param params - Query parameters
   * @returns Result set with rows
   */
  exec(query: string, params?: (string | number | null | Uint8Array | ArrayBuffer)[]): SqlResultSet
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Compression codec type for extents.
 */
export type ExtentCompression = 'none' | 'gzip'

/**
 * Default page size (4KB for SQLite).
 */
export const DEFAULT_PAGE_SIZE = 4096

/**
 * Default extent size (2MB).
 */
export const DEFAULT_EXTENT_SIZE = 2 * 1024 * 1024

/**
 * ExtentStorage configuration options.
 */
export interface ExtentStorageConfig {
  /**
   * Page size in bytes.
   * - 4096 for SQLite
   * - 8192 for PostgreSQL
   * @default 4096
   */
  pageSize: number

  /**
   * Target extent size in bytes.
   * Pages are packed into extents of this size.
   * @default 2097152 (2MB)
   */
  extentSize: number

  /**
   * Compression codec for extents.
   * - 'none': No compression
   * - 'gzip': Gzip compression (good for text/SQL data)
   * @default 'none'
   */
  compression: ExtentCompression

  /**
   * Blob storage backend for extent data.
   * Must implement the BlobStorage interface.
   */
  backend: BlobStorage

  /**
   * SQL storage adapter for metadata and dirty pages.
   * Must implement the SqlStorageAdapter interface.
   */
  sql: SqlStorageAdapter

  /**
   * Prefix for extent keys in blob storage.
   * @default 'extent/'
   */
  extentPrefix?: string

  /**
   * Whether to automatically flush when dirty page count reaches threshold.
   * @default true
   */
  autoFlush?: boolean

  /**
   * Minimum dirty pages before auto-flush.
   * @default calculated from extentSize/pageSize
   */
  flushThreshold?: number
}

// =============================================================================
// Types
// =============================================================================

/**
 * File metadata stored in SQL
 */
export interface ExtentFileMetadata {
  fileId: string
  pageSize: number
  fileSize: number
  extentCount: number
  createdAt: number
  modifiedAt: number
}

/**
 * Extent metadata stored in SQL
 */
export interface ExtentMetadata {
  extentId: string
  fileId: string
  extentIndex: number
  startPage: number
  pageCount: number
  compressed: boolean
  originalSize: number
  storedSize: number
  checksum: string
}

/**
 * Dirty page stored in SQL
 */
export interface DirtyPage {
  fileId: string
  pageNum: number
  data: Uint8Array
  modifiedAt: number
}

/**
 * Extent cache entry
 */
interface ExtentCacheEntry {
  extentId: string
  data: Uint8Array
  header: ExtentHeader
  lastAccess: number
}

// =============================================================================
// SQL Schema
// =============================================================================

const CREATE_TABLES_SQL = `
-- Track files and their extent mappings
CREATE TABLE IF NOT EXISTS extent_files (
  file_id TEXT PRIMARY KEY,
  page_size INTEGER NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  extent_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL
);

-- Track individual extents
CREATE TABLE IF NOT EXISTS extents (
  extent_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  extent_index INTEGER NOT NULL,
  start_page INTEGER NOT NULL,
  page_count INTEGER NOT NULL,
  compressed INTEGER NOT NULL DEFAULT 0,
  original_size INTEGER,
  stored_size INTEGER NOT NULL,
  checksum TEXT,
  UNIQUE(file_id, extent_index)
);

-- Index for fast page lookups
CREATE INDEX IF NOT EXISTS idx_extents_file_start ON extents(file_id, start_page);

-- Track dirty pages in write buffer
CREATE TABLE IF NOT EXISTS dirty_pages (
  file_id TEXT NOT NULL,
  page_num INTEGER NOT NULL,
  data BLOB NOT NULL,
  modified_at INTEGER NOT NULL,
  PRIMARY KEY (file_id, page_num)
);
`

// =============================================================================
// ExtentStorage Implementation
// =============================================================================

/**
 * ExtentStorage - Core storage layer for database page management.
 *
 * Provides efficient storage of database pages by packing them into
 * larger extents, reducing the number of storage operations and costs.
 *
 * @example
 * ```typescript
 * // Create extent storage
 * const storage = await createExtentStorage({
 *   pageSize: 4096,
 *   extentSize: 2 * 1024 * 1024,
 *   compression: 'gzip',
 *   backend: r2Storage,
 *   sql: sqlAdapter,
 * })
 *
 * // Write pages
 * await storage.writePage('mydb.sqlite', 0, page0Data)
 * await storage.writePage('mydb.sqlite', 1, page1Data)
 *
 * // Read pages
 * const page = await storage.readPage('mydb.sqlite', 0)
 *
 * // Flush to create extents
 * await storage.flush()
 * ```
 */
export class ExtentStorage {
  private readonly config: Required<ExtentStorageConfig>
  private readonly pagesPerExtent: number
  private initialized = false

  // Extent cache (in-memory, per-instance)
  private extentCache = new Map<string, ExtentCacheEntry>()
  private readonly maxCacheSize = 16 // Cache up to 16 extents (32MB at 2MB each)

  constructor(config: ExtentStorageConfig) {
    const flushThreshold =
      config.flushThreshold ??
      calculatePagesPerExtent(config.extentSize ?? DEFAULT_EXTENT_SIZE, config.pageSize ?? DEFAULT_PAGE_SIZE)

    this.config = {
      pageSize: config.pageSize ?? DEFAULT_PAGE_SIZE,
      extentSize: config.extentSize ?? DEFAULT_EXTENT_SIZE,
      compression: config.compression ?? 'none',
      backend: config.backend,
      sql: config.sql,
      extentPrefix: config.extentPrefix ?? 'extent/',
      autoFlush: config.autoFlush ?? true,
      flushThreshold,
    }

    this.pagesPerExtent = calculatePagesPerExtent(this.config.extentSize, this.config.pageSize)
  }

  /**
   * Initialize the storage (create tables if needed).
   */
  async init(): Promise<void> {
    if (this.initialized) return

    // Execute each CREATE statement separately for compatibility
    const statements = CREATE_TABLES_SQL.split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    for (const stmt of statements) {
      this.config.sql.exec(stmt + ';')
    }

    this.initialized = true
  }

  /**
   * Ensure storage is initialized.
   */
  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error('ExtentStorage not initialized. Call init() first.')
    }
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Get or create file metadata.
   */
  private getOrCreateFile(fileId: string): ExtentFileMetadata {
    const result = this.config.sql.exec('SELECT * FROM extent_files WHERE file_id = ?', [fileId])

    if (result.rows.length > 0) {
      const row = result.rows[0]!
      return {
        fileId: row.file_id as string,
        pageSize: row.page_size as number,
        fileSize: row.file_size as number,
        extentCount: row.extent_count as number,
        createdAt: row.created_at as number,
        modifiedAt: row.modified_at as number,
      }
    }

    // Create new file entry
    const now = Date.now()
    this.config.sql.exec(
      'INSERT INTO extent_files (file_id, page_size, file_size, extent_count, created_at, modified_at) VALUES (?, ?, 0, 0, ?, ?)',
      [fileId, this.config.pageSize, now, now]
    )

    return {
      fileId,
      pageSize: this.config.pageSize,
      fileSize: 0,
      extentCount: 0,
      createdAt: now,
      modifiedAt: now,
    }
  }

  /**
   * Update file size in metadata.
   */
  private updateFileSize(fileId: string, size: number): void {
    const now = Date.now()
    this.config.sql.exec('UPDATE extent_files SET file_size = ?, modified_at = ? WHERE file_id = ?', [
      size,
      now,
      fileId,
    ])
  }

  /**
   * Get the current file size.
   *
   * @param fileId - File identifier
   * @returns File size in bytes, or 0 if file doesn't exist
   */
  async getFileSize(fileId: string): Promise<number> {
    this.ensureInit()

    const result = this.config.sql.exec('SELECT file_size FROM extent_files WHERE file_id = ?', [fileId])

    if (result.rows.length === 0) {
      return 0
    }

    return result.rows[0]!.file_size as number
  }

  /**
   * List all files.
   *
   * @returns Array of file IDs
   */
  async listFiles(): Promise<string[]> {
    this.ensureInit()

    const result = this.config.sql.exec('SELECT file_id FROM extent_files ORDER BY file_id')
    return result.rows.map((row) => row.file_id as string)
  }

  /**
   * Delete a file and all its extents.
   *
   * @param fileId - File identifier
   */
  async deleteFile(fileId: string): Promise<void> {
    this.ensureInit()

    // Get all extent IDs for this file
    const extentsResult = this.config.sql.exec('SELECT extent_id FROM extents WHERE file_id = ?', [fileId])

    // Delete from blob storage
    for (const row of extentsResult.rows) {
      const extentId = row.extent_id as string
      const key = `${this.config.extentPrefix}${extentId}`
      await this.config.backend.delete(key)

      // Remove from cache
      this.extentCache.delete(extentId)
    }

    // Delete dirty pages
    this.config.sql.exec('DELETE FROM dirty_pages WHERE file_id = ?', [fileId])

    // Delete extent metadata
    this.config.sql.exec('DELETE FROM extents WHERE file_id = ?', [fileId])

    // Delete file metadata
    this.config.sql.exec('DELETE FROM extent_files WHERE file_id = ?', [fileId])
  }

  /**
   * Truncate a file to a specified size.
   *
   * @param fileId - File identifier
   * @param size - New file size in bytes
   */
  async truncate(fileId: string, size: number): Promise<void> {
    this.ensureInit()

    const file = this.getOrCreateFile(fileId)
    const currentSize = file.fileSize

    if (size >= currentSize) {
      // Extending file - just update size
      this.updateFileSize(fileId, size)
      return
    }

    // Truncating file
    const lastPage = size > 0 ? Math.ceil(size / this.config.pageSize) - 1 : -1

    // Delete dirty pages beyond the new size
    this.config.sql.exec('DELETE FROM dirty_pages WHERE file_id = ? AND page_num > ?', [fileId, lastPage])

    // Find extents that need to be removed or modified
    const extentsResult = this.config.sql.exec(
      'SELECT extent_id, extent_index, start_page, page_count FROM extents WHERE file_id = ? ORDER BY start_page',
      [fileId]
    )

    for (const row of extentsResult.rows) {
      const startPage = row.start_page as number
      const pageCount = row.page_count as number
      const extentId = row.extent_id as string
      const endPage = startPage + pageCount - 1

      if (startPage > lastPage) {
        // Entire extent is beyond truncation point - delete it
        const key = `${this.config.extentPrefix}${extentId}`
        await this.config.backend.delete(key)
        this.config.sql.exec('DELETE FROM extents WHERE extent_id = ?', [extentId])
        this.extentCache.delete(extentId)
      } else if (endPage > lastPage && startPage <= lastPage) {
        // Extent partially overlaps - need to rewrite it
        // For simplicity, we mark these pages as dirty and delete the extent
        // They will be re-packed on next flush
        const extentData = await this.getExtentData(extentId)
        if (extentData) {
          const header = parseExtentHeader(extentData)
          for (let pageNum = startPage; pageNum <= lastPage; pageNum++) {
            // Calculate the page index within the extent
            const pageIndex = pageNum - startPage
            const pageData = extractPage(extentData, pageIndex, header.pageSize)
            if (pageData) {
              // Store as dirty page
              const now = Date.now()
              this.config.sql.exec(
                'INSERT OR REPLACE INTO dirty_pages (file_id, page_num, data, modified_at) VALUES (?, ?, ?, ?)',
                [fileId, pageNum, pageData, now]
              )
            }
          }
        }

        // Delete the extent
        const key = `${this.config.extentPrefix}${extentId}`
        await this.config.backend.delete(key)
        this.config.sql.exec('DELETE FROM extents WHERE extent_id = ?', [extentId])
        this.extentCache.delete(extentId)
      }
      // Extents fully within truncation point are kept
    }

    // Handle partial page at truncation boundary
    if (size > 0) {
      const lastPageSize = size % this.config.pageSize
      if (lastPageSize > 0) {
        // Read the last page
        const pageData = await this.readPageInternal(fileId, lastPage)
        if (pageData) {
          // Zero out bytes beyond truncation point
          const truncatedPage = new Uint8Array(this.config.pageSize)
          truncatedPage.set(pageData.subarray(0, lastPageSize))
          // Store as dirty
          const now = Date.now()
          this.config.sql.exec(
            'INSERT OR REPLACE INTO dirty_pages (file_id, page_num, data, modified_at) VALUES (?, ?, ?, ?)',
            [fileId, lastPage, truncatedPage, now]
          )
        }
      }
    }

    // Update file size
    this.updateFileSize(fileId, size)

    // Update extent count
    const countResult = this.config.sql.exec('SELECT COUNT(*) as cnt FROM extents WHERE file_id = ?', [fileId])
    const extentCount = (countResult.rows[0]?.cnt as number) ?? 0
    this.config.sql.exec('UPDATE extent_files SET extent_count = ? WHERE file_id = ?', [extentCount, fileId])
  }

  // ===========================================================================
  // Page Operations
  // ===========================================================================

  /**
   * Read a page from the storage.
   *
   * Check order:
   * 1. Dirty pages (write buffer)
   * 2. Extent storage
   *
   * @param fileId - File identifier
   * @param pageNum - Page number (0-indexed)
   * @returns Page data, or null if page doesn't exist
   */
  async readPage(fileId: string, pageNum: number): Promise<Uint8Array | null> {
    this.ensureInit()
    return this.readPageInternal(fileId, pageNum)
  }

  /**
   * Internal read page implementation.
   */
  private async readPageInternal(fileId: string, pageNum: number): Promise<Uint8Array | null> {
    // 1. Check dirty pages first
    const dirtyResult = this.config.sql.exec(
      'SELECT data FROM dirty_pages WHERE file_id = ? AND page_num = ?',
      [fileId, pageNum]
    )

    if (dirtyResult.rows.length > 0) {
      const data = dirtyResult.rows[0]!.data
      if (data instanceof ArrayBuffer) {
        return new Uint8Array(data)
      }
      if (data instanceof Uint8Array) {
        return data
      }
      return null
    }

    // 2. Find extent containing this page
    const extentInfo = await this.findExtentForPage(fileId, pageNum)
    if (!extentInfo) {
      return null
    }

    // 3. Get extent data (from cache or storage)
    const extentData = await this.getExtentData(extentInfo.extentId)
    if (!extentData) {
      return null
    }

    // 4. Extract the page
    // Calculate the page index within the extent (0-based relative to extent start)
    const pageIndex = pageNum - extentInfo.startPage
    return extractPage(extentData, pageIndex, this.config.pageSize)
  }

  /**
   * Write a page to the storage.
   *
   * Pages are buffered in the dirty_pages table until flushed.
   * Auto-flush occurs when the buffer reaches the threshold.
   *
   * @param fileId - File identifier
   * @param pageNum - Page number (0-indexed)
   * @param data - Page data (must match pageSize)
   */
  async writePage(fileId: string, pageNum: number, data: Uint8Array): Promise<void> {
    this.ensureInit()

    // Validate page size
    if (data.length !== this.config.pageSize) {
      throw new Error(`Invalid page size: expected ${this.config.pageSize}, got ${data.length}`)
    }

    // Ensure file exists
    this.getOrCreateFile(fileId)

    // Store in dirty pages
    const now = Date.now()
    this.config.sql.exec(
      'INSERT OR REPLACE INTO dirty_pages (file_id, page_num, data, modified_at) VALUES (?, ?, ?, ?)',
      [fileId, pageNum, data, now]
    )

    // Update file size if needed
    const newSize = (pageNum + 1) * this.config.pageSize
    const currentSize = await this.getFileSize(fileId)
    if (newSize > currentSize) {
      this.updateFileSize(fileId, newSize)
    }

    // Check for auto-flush
    if (this.config.autoFlush) {
      const dirtyCount = await this.getDirtyPageCount(fileId)
      if (dirtyCount >= this.config.flushThreshold) {
        await this.flushFile(fileId)
      }
    }
  }

  /**
   * Get the count of dirty pages for a file.
   */
  private async getDirtyPageCount(fileId: string): Promise<number> {
    const result = this.config.sql.exec('SELECT COUNT(*) as cnt FROM dirty_pages WHERE file_id = ?', [
      fileId,
    ])
    return (result.rows[0]?.cnt as number) ?? 0
  }

  // ===========================================================================
  // Flush Operations
  // ===========================================================================

  /**
   * Flush all dirty pages to extents.
   *
   * Groups dirty pages into extent-sized chunks, builds extent blobs,
   * writes to storage, and clears the dirty pages.
   */
  async flush(): Promise<void> {
    this.ensureInit()

    // Get all files with dirty pages
    const filesResult = this.config.sql.exec('SELECT DISTINCT file_id FROM dirty_pages')

    for (const row of filesResult.rows) {
      const fileId = row.file_id as string
      await this.flushFile(fileId)
    }
  }

  /**
   * Flush dirty pages for a specific file.
   */
  private async flushFile(fileId: string): Promise<void> {
    // Get all dirty pages sorted by page number
    const dirtyResult = this.config.sql.exec(
      'SELECT page_num, data FROM dirty_pages WHERE file_id = ? ORDER BY page_num',
      [fileId]
    )

    if (dirtyResult.rows.length === 0) {
      return
    }

    // Convert to page map grouped by extent
    const pagesByExtent = new Map<number, Map<number, Uint8Array>>()

    for (const row of dirtyResult.rows) {
      const pageNum = row.page_num as number
      const data =
        row.data instanceof ArrayBuffer
          ? new Uint8Array(row.data)
          : row.data instanceof Uint8Array
            ? row.data
            : new Uint8Array(0)

      // Determine which extent this page belongs to
      const extentIndex = Math.floor(pageNum / this.pagesPerExtent)

      if (!pagesByExtent.has(extentIndex)) {
        pagesByExtent.set(extentIndex, new Map())
      }

      // Page index within the extent (0-based)
      const pageIndexInExtent = pageNum - extentIndex * this.pagesPerExtent
      pagesByExtent.get(extentIndex)!.set(pageIndexInExtent, data)
    }

    // Process each extent group
    for (const [extentIndex, pages] of pagesByExtent) {
      const startPage = extentIndex * this.pagesPerExtent
      await this.writeExtent(fileId, pages, extentIndex, startPage)
    }

    // Clear flushed dirty pages
    this.config.sql.exec('DELETE FROM dirty_pages WHERE file_id = ?', [fileId])

    // Update extent count
    const countResult = this.config.sql.exec('SELECT COUNT(*) as cnt FROM extents WHERE file_id = ?', [
      fileId,
    ])
    const extentCount = (countResult.rows[0]?.cnt as number) ?? 0
    this.config.sql.exec('UPDATE extent_files SET extent_count = ? WHERE file_id = ?', [extentCount, fileId])
  }

  /**
   * Write an extent to storage.
   */
  private async writeExtent(
    fileId: string,
    pages: Map<number, Uint8Array>,
    extentIndex: number,
    startPage: number
  ): Promise<BlobWriteResult> {
    if (pages.size === 0) {
      throw new Error('Cannot write empty extent')
    }

    // Build extent blob using the extent-format buildExtent function
    const options: BuildExtentOptions = {
      compress: this.config.compression === 'gzip',
    }
    const extentBlob = buildExtent(pages, this.config.pageSize, options)

    // Compute content-addressable ID
    const checksum = await sha256(extentBlob)
    const extentId = `ext-${checksum.substring(0, 32)}`

    // Write to blob storage
    const key = `${this.config.extentPrefix}${extentId}`
    const writeResult = await this.config.backend.put(key, extentBlob)

    // Check if we need to delete an old extent for this file/index
    const existingResult = this.config.sql.exec(
      'SELECT extent_id FROM extents WHERE file_id = ? AND extent_index = ?',
      [fileId, extentIndex]
    )
    if (existingResult.rows.length > 0) {
      const oldExtentId = existingResult.rows[0]!.extent_id as string
      if (oldExtentId !== extentId) {
        // Delete old extent from storage
        const oldKey = `${this.config.extentPrefix}${oldExtentId}`
        await this.config.backend.delete(oldKey)
        this.extentCache.delete(oldExtentId)
      }
    }

    // Calculate page count for metadata (highest index + 1)
    const maxPageIndex = Math.max(...pages.keys())
    const pageCount = maxPageIndex + 1

    // Update extent metadata
    this.config.sql.exec(
      `INSERT OR REPLACE INTO extents
       (extent_id, file_id, extent_index, start_page, page_count, compressed, original_size, stored_size, checksum)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        extentId,
        fileId,
        extentIndex,
        startPage,
        pageCount,
        this.config.compression !== 'none' ? 1 : 0,
        pages.size * this.config.pageSize,
        extentBlob.length,
        checksum,
      ]
    )

    return writeResult
  }

  // ===========================================================================
  // Extent Lookup & Cache
  // ===========================================================================

  /**
   * Find the extent containing a specific page.
   */
  private async findExtentForPage(
    fileId: string,
    pageNum: number
  ): Promise<{ extentId: string; startPage: number } | null> {
    const result = this.config.sql.exec(
      'SELECT extent_id, start_page, page_count FROM extents WHERE file_id = ? AND start_page <= ? ORDER BY start_page DESC LIMIT 1',
      [fileId, pageNum]
    )

    if (result.rows.length === 0) {
      return null
    }

    const row = result.rows[0]!
    const startPage = row.start_page as number
    const pageCount = row.page_count as number

    // Check if page is within this extent's range
    if (pageNum >= startPage && pageNum < startPage + pageCount) {
      return {
        extentId: row.extent_id as string,
        startPage,
      }
    }

    return null
  }

  /**
   * Get extent data from cache or storage.
   */
  private async getExtentData(extentId: string): Promise<Uint8Array | null> {
    // Check cache first
    const cached = this.extentCache.get(extentId)
    if (cached) {
      cached.lastAccess = Date.now()
      return cached.data
    }

    // Fetch from storage
    const key = `${this.config.extentPrefix}${extentId}`
    const result = await this.config.backend.get(key)

    if (!result) {
      return null
    }

    // Cache the extent
    this.cacheExtent(extentId, result.data)

    return result.data
  }

  /**
   * Cache an extent.
   */
  private cacheExtent(extentId: string, data: Uint8Array): void {
    // Evict oldest if cache is full
    if (this.extentCache.size >= this.maxCacheSize) {
      let oldestKey: string | null = null
      let oldestTime = Infinity

      for (const [key, entry] of this.extentCache) {
        if (entry.lastAccess < oldestTime) {
          oldestTime = entry.lastAccess
          oldestKey = key
        }
      }

      if (oldestKey) {
        this.extentCache.delete(oldestKey)
      }
    }

    // Parse header and cache
    try {
      const header = parseExtentHeader(data)
      this.extentCache.set(extentId, {
        extentId,
        data,
        header,
        lastAccess: Date.now(),
      })
    } catch {
      // Don't cache if parsing fails
    }
  }

  // ===========================================================================
  // Sync Operations
  // ===========================================================================

  /**
   * Synchronous read page (for VFS compatibility).
   *
   * Note: This method is provided for VFS adapters that need sync I/O.
   * It requires dirty pages to be checked synchronously, and extents
   * must be pre-cached.
   *
   * @param fileId - File identifier
   * @param pageNum - Page number
   * @returns Page data, or null if not in dirty buffer or cache
   */
  readPageSync(fileId: string, pageNum: number): Uint8Array | null {
    this.ensureInit()

    // Check dirty pages (synchronous SQL)
    const dirtyResult = this.config.sql.exec(
      'SELECT data FROM dirty_pages WHERE file_id = ? AND page_num = ?',
      [fileId, pageNum]
    )

    if (dirtyResult.rows.length > 0) {
      const data = dirtyResult.rows[0]!.data
      if (data instanceof ArrayBuffer) {
        return new Uint8Array(data)
      }
      if (data instanceof Uint8Array) {
        return data
      }
    }

    // Check extent cache (synchronous)
    const extentResult = this.config.sql.exec(
      'SELECT extent_id, start_page FROM extents WHERE file_id = ? AND start_page <= ? ORDER BY start_page DESC LIMIT 1',
      [fileId, pageNum]
    )

    if (extentResult.rows.length === 0) {
      return null
    }

    const extentId = extentResult.rows[0]!.extent_id as string
    const startPage = extentResult.rows[0]!.start_page as number

    const cached = this.extentCache.get(extentId)
    if (!cached) {
      // Extent not in cache - would need async fetch
      return null
    }

    cached.lastAccess = Date.now()

    // Calculate page index within extent
    const pageIndex = pageNum - startPage
    return extractPage(cached.data, pageIndex, this.config.pageSize)
  }

  /**
   * Synchronous write page (for VFS compatibility).
   *
   * @param fileId - File identifier
   * @param pageNum - Page number
   * @param data - Page data
   */
  writePageSync(fileId: string, pageNum: number, data: Uint8Array): void {
    this.ensureInit()

    if (data.length !== this.config.pageSize) {
      throw new Error(`Invalid page size: expected ${this.config.pageSize}, got ${data.length}`)
    }

    // Ensure file exists
    this.getOrCreateFile(fileId)

    // Store in dirty pages
    const now = Date.now()
    this.config.sql.exec(
      'INSERT OR REPLACE INTO dirty_pages (file_id, page_num, data, modified_at) VALUES (?, ?, ?, ?)',
      [fileId, pageNum, data, now]
    )

    // Update file size if needed
    const newSize = (pageNum + 1) * this.config.pageSize
    const result = this.config.sql.exec('SELECT file_size FROM extent_files WHERE file_id = ?', [fileId])
    const currentSize = (result.rows[0]?.file_size as number) ?? 0
    if (newSize > currentSize) {
      this.updateFileSize(fileId, newSize)
    }
  }

  // ===========================================================================
  // Statistics & Debugging
  // ===========================================================================

  /**
   * Get storage statistics.
   */
  async getStats(): Promise<{
    totalFiles: number
    totalExtents: number
    totalDirtyPages: number
    totalStoredBytes: number
    cacheSize: number
    cacheHitRate: number
  }> {
    this.ensureInit()

    const filesResult = this.config.sql.exec('SELECT COUNT(*) as cnt FROM extent_files')
    const extentsResult = this.config.sql.exec('SELECT COUNT(*) as cnt, SUM(stored_size) as total FROM extents')
    const dirtyResult = this.config.sql.exec('SELECT COUNT(*) as cnt FROM dirty_pages')

    return {
      totalFiles: (filesResult.rows[0]?.cnt as number) ?? 0,
      totalExtents: (extentsResult.rows[0]?.cnt as number) ?? 0,
      totalDirtyPages: (dirtyResult.rows[0]?.cnt as number) ?? 0,
      totalStoredBytes: (extentsResult.rows[0]?.total as number) ?? 0,
      cacheSize: this.extentCache.size,
      cacheHitRate: 0, // Would need tracking for this
    }
  }

  /**
   * Clear the extent cache.
   */
  clearCache(): void {
    this.extentCache.clear()
  }

  /**
   * Pre-load extents into cache for a file.
   *
   * @param fileId - File identifier
   */
  async preloadExtents(fileId: string): Promise<void> {
    this.ensureInit()

    const extentsResult = this.config.sql.exec('SELECT extent_id FROM extents WHERE file_id = ?', [fileId])

    for (const row of extentsResult.rows) {
      const extentId = row.extent_id as string
      await this.getExtentData(extentId)
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create and initialize an ExtentStorage instance.
 *
 * @param config - Storage configuration
 * @returns Initialized ExtentStorage instance
 *
 * @example
 * ```typescript
 * // For SQLite databases (4KB pages)
 * const sqliteStorage = await createExtentStorage({
 *   pageSize: 4096,
 *   extentSize: 2 * 1024 * 1024,
 *   compression: 'gzip',
 *   backend: r2Storage,
 *   sql: doSqlAdapter,
 * })
 *
 * // For PostgreSQL (8KB pages)
 * const pgStorage = await createExtentStorage({
 *   pageSize: 8192,
 *   extentSize: 2 * 1024 * 1024,
 *   compression: 'gzip',
 *   backend: r2Storage,
 *   sql: doSqlAdapter,
 * })
 * ```
 */
export async function createExtentStorage(config: ExtentStorageConfig): Promise<ExtentStorage> {
  const storage = new ExtentStorage(config)
  await storage.init()
  return storage
}

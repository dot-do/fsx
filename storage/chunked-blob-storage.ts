/**
 * Chunked Blob Storage - Integration of PageStorage with SQLiteMetadata
 *
 * Combines PageStorage (2MB chunking) with SQLiteMetadata for cost-optimized
 * large file storage in Durable Objects.
 *
 * This module provides:
 * - Automatic chunking of large files into 2MB BLOB rows
 * - Metadata tracking for page keys in SQLite
 * - Seamless read/write API for chunked blobs
 *
 * Cost optimization: DO SQLite charges per row read/write, NOT by size.
 * A 10MB file stored in 2MB chunks costs 5 row operations instead of
 * thousands when stored in smaller rows.
 *
 * Issue: fsx-iti7 - Implement 2MB BLOB chunking for cost-optimized DO storage
 *
 * @module storage/chunked-blob-storage
 */

import { createPageStorage, type PageStorage, CHUNK_SIZE } from './page-storage.js'

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Configuration for ChunkedBlobStorage.
 */
export interface ChunkedBlobStorageConfig {
  /**
   * The Durable Object storage instance.
   */
  storage: DurableObjectStorage

  /**
   * The SQLite storage instance for metadata.
   */
  sql: SqlStorage
}

/**
 * Blob metadata including page keys for chunked storage.
 */
export interface ChunkedBlobMetadata {
  /**
   * Unique blob identifier.
   */
  id: string

  /**
   * Total size in bytes.
   */
  size: number

  /**
   * Storage tier.
   */
  tier: 'hot' | 'warm' | 'cold'

  /**
   * Optional content checksum.
   */
  checksum?: string

  /**
   * Page keys for chunked storage (JSON serialized).
   */
  pageKeys: string[]

  /**
   * Number of chunks.
   */
  chunkCount: number

  /**
   * Creation timestamp (Unix ms).
   */
  createdAt: number
}

/**
 * Result of a write operation.
 */
export interface ChunkedWriteResult {
  /**
   * Blob ID.
   */
  blobId: string

  /**
   * Total bytes written.
   */
  size: number

  /**
   * Number of chunks created.
   */
  chunkCount: number

  /**
   * Page keys for the chunks.
   */
  pageKeys: string[]
}

/**
 * ChunkedBlobStorage interface for cost-optimized large file storage.
 */
export interface ChunkedBlobStorage {
  /**
   * Initialize the storage (creates schema if needed).
   */
  init(): Promise<void>

  /**
   * Write a blob, automatically chunking if larger than CHUNK_SIZE.
   *
   * @param blobId - Unique identifier for the blob
   * @param data - Blob data to store
   * @param options - Optional write options
   * @returns Write result with metadata
   */
  write(
    blobId: string,
    data: Uint8Array,
    options?: { tier?: 'hot' | 'warm' | 'cold'; checksum?: string }
  ): Promise<ChunkedWriteResult>

  /**
   * Read a blob, reassembling from chunks if needed.
   *
   * @param blobId - Blob identifier
   * @returns Blob data, or null if not found
   */
  read(blobId: string): Promise<Uint8Array | null>

  /**
   * Read a range of bytes from a blob.
   *
   * @param blobId - Blob identifier
   * @param offset - Start byte offset
   * @param length - Number of bytes to read
   * @returns Range data, or null if blob not found
   */
  readRange(blobId: string, offset: number, length: number): Promise<Uint8Array | null>

  /**
   * Delete a blob and all its chunks.
   *
   * @param blobId - Blob identifier
   * @returns true if blob was deleted, false if not found
   */
  delete(blobId: string): Promise<boolean>

  /**
   * Check if a blob exists.
   *
   * @param blobId - Blob identifier
   * @returns true if blob exists
   */
  exists(blobId: string): Promise<boolean>

  /**
   * Get blob metadata.
   *
   * @param blobId - Blob identifier
   * @returns Blob metadata, or null if not found
   */
  getMetadata(blobId: string): Promise<ChunkedBlobMetadata | null>

  /**
   * Get the underlying PageStorage instance.
   */
  getPageStorage(): PageStorage
}

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Row structure for chunked_blobs table.
 */
interface ChunkedBlobRow {
  id: string
  size: number
  tier: string
  checksum: string | null
  page_keys: string // JSON array of page keys
  chunk_count: number
  created_at: number
  [key: string]: SqlStorageValue
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a ChunkedBlobStorage instance.
 *
 * Combines PageStorage for efficient 2MB chunk storage with SQLite
 * metadata tracking for managing chunked blobs.
 *
 * @param config - Configuration options
 * @returns ChunkedBlobStorage implementation
 *
 * @example
 * ```typescript
 * const blobStorage = createChunkedBlobStorage({
 *   storage: ctx.storage,
 *   sql: ctx.storage.sql,
 * })
 *
 * await blobStorage.init()
 *
 * // Write a large file (auto-chunked)
 * const result = await blobStorage.write('my-blob', largeData)
 * console.log(`Stored in ${result.chunkCount} chunks`)
 *
 * // Read it back (auto-reassembled)
 * const data = await blobStorage.read('my-blob')
 *
 * // Read a range (efficient - only loads needed chunks)
 * const range = await blobStorage.readRange('my-blob', 0, 1024)
 * ```
 */
export function createChunkedBlobStorage(config: ChunkedBlobStorageConfig): ChunkedBlobStorage {
  const { storage, sql } = config

  // Create the underlying page storage
  const pageStorage = createPageStorage({ storage })

  /**
   * Initialize the schema.
   */
  async function init(): Promise<void> {
    // Create chunked_blobs table for tracking page keys
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS chunked_blobs (
        id TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        tier TEXT NOT NULL DEFAULT 'hot' CHECK(tier IN ('hot', 'warm', 'cold')),
        checksum TEXT,
        page_keys TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)

    await sql.exec('CREATE INDEX IF NOT EXISTS idx_chunked_blobs_tier ON chunked_blobs(tier)')
  }

  /**
   * Write a blob with automatic chunking.
   */
  async function write(
    blobId: string,
    data: Uint8Array,
    options?: { tier?: 'hot' | 'warm' | 'cold'; checksum?: string }
  ): Promise<ChunkedWriteResult> {
    const tier = options?.tier ?? 'hot'
    const checksum = options?.checksum ?? null

    // Write chunks using PageStorage
    const pageKeys = await pageStorage.writePages(blobId, data)

    // Store metadata in SQLite
    const pageKeysJson = JSON.stringify(pageKeys)
    const now = Date.now()

    // Use REPLACE to handle updates
    await sql.exec(
      `INSERT OR REPLACE INTO chunked_blobs (id, size, tier, checksum, page_keys, chunk_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      blobId,
      data.length,
      tier,
      checksum,
      pageKeysJson,
      pageKeys.length,
      now
    )

    return {
      blobId,
      size: data.length,
      chunkCount: pageKeys.length,
      pageKeys,
    }
  }

  /**
   * Read a blob, reassembling from chunks.
   */
  async function read(blobId: string): Promise<Uint8Array | null> {
    const metadata = await getMetadata(blobId)
    if (!metadata) {
      return null
    }

    return pageStorage.readPages(blobId, metadata.pageKeys)
  }

  /**
   * Read a range of bytes from a blob.
   */
  async function readRange(
    blobId: string,
    offset: number,
    length: number
  ): Promise<Uint8Array | null> {
    const metadata = await getMetadata(blobId)
    if (!metadata) {
      return null
    }

    return pageStorage.readRange(blobId, metadata.pageKeys, offset, length)
  }

  /**
   * Delete a blob and all its chunks.
   */
  async function deleteBlob(blobId: string): Promise<boolean> {
    const metadata = await getMetadata(blobId)
    if (!metadata) {
      return false
    }

    // Delete the chunks
    await pageStorage.deletePages(metadata.pageKeys)

    // Delete the metadata
    await sql.exec('DELETE FROM chunked_blobs WHERE id = ?', blobId)

    return true
  }

  /**
   * Check if a blob exists.
   */
  async function exists(blobId: string): Promise<boolean> {
    const result = sql
      .exec<{ count: number }>('SELECT COUNT(*) as count FROM chunked_blobs WHERE id = ?', blobId)
      .one()
    return (result?.count ?? 0) > 0
  }

  /**
   * Get blob metadata.
   */
  async function getMetadata(blobId: string): Promise<ChunkedBlobMetadata | null> {
    const row = sql
      .exec<ChunkedBlobRow>('SELECT * FROM chunked_blobs WHERE id = ?', blobId)
      .one()

    if (!row) {
      return null
    }

    const pageKeys: string[] = JSON.parse(row.page_keys)

    return {
      id: row.id,
      size: row.size,
      tier: row.tier as 'hot' | 'warm' | 'cold',
      checksum: row.checksum ?? undefined,
      pageKeys,
      chunkCount: row.chunk_count,
      createdAt: row.created_at,
    }
  }

  /**
   * Get the underlying PageStorage.
   */
  function getPageStorage(): PageStorage {
    return pageStorage
  }

  return {
    init,
    write,
    read,
    readRange,
    delete: deleteBlob,
    exists,
    getMetadata,
    getPageStorage,
  }
}

// Re-export CHUNK_SIZE for convenience
export { CHUNK_SIZE }

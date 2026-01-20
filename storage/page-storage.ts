/**
 * Page Storage - 2MB BLOB Row Packing for DO SQLite Cost Optimization
 *
 * The Page Storage manages large file storage by chunking data into 2MB
 * BLOB rows to minimize Durable Object storage costs.
 *
 * Key insight: DO SQLite pricing is per-row read/write, NOT by size.
 * By storing files in 2MB chunks, we minimize the number of row operations.
 *
 * Example cost comparison for a 10MB file:
 * - Without chunking (1KB rows): ~10,000 row operations
 * - With 2MB chunking: 5 row operations
 * - Cost reduction: ~2000x fewer billable operations
 *
 * Issue: fsx-iti7 - Implement 2MB BLOB chunking for cost-optimized DO storage
 * Issue: fsx-elxi - Add PageStorage interface for 2MB BLOB pages
 *
 * @module storage/page-storage
 */

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum chunk size for optimal DO SQLite pricing.
 * DO SQLite charges per row read/write regardless of size up to 2MB.
 */
export const CHUNK_SIZE = 2 * 1024 * 1024 // 2MB

/**
 * Storage key prefix for page chunks.
 */
export const PAGE_KEY_PREFIX = '__page__'

/**
 * Storage key prefix for page metadata.
 */
export const PAGE_META_PREFIX = '__page_meta__'

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Configuration options for PageStorage.
 */
export interface PageStorageConfig {
  /**
   * The Durable Object storage instance.
   */
  storage: DurableObjectStorage

  /**
   * Custom chunk size (default: 2MB).
   * Only use for testing - 2MB is optimal for DO pricing.
   */
  chunkSize?: number
}

/**
 * Metadata stored for a chunked blob.
 */
export interface PageMetadata {
  /**
   * The blob ID this metadata belongs to.
   */
  blobId: string

  /**
   * Total size of the blob in bytes.
   */
  totalSize: number

  /**
   * Number of chunks used to store the blob.
   */
  chunkCount: number

  /**
   * Array of page keys for each chunk.
   */
  pageKeys: string[]
}

/**
 * PageStorage interface for managing large blobs in 2MB chunks.
 *
 * This interface provides cost-optimized storage for large files in
 * Durable Object SQLite by chunking data into 2MB BLOB rows.
 */
export interface PageStorage {
  /**
   * Write data as 2MB chunks.
   *
   * Splits the data into chunks of up to CHUNK_SIZE bytes and stores
   * each chunk as a separate row in DO storage. Returns the keys needed
   * to read the data back.
   *
   * @param blobId - Unique identifier for the blob
   * @param data - Data to store
   * @returns Array of page keys for the stored chunks
   *
   * @example
   * ```typescript
   * const pageKeys = await pageStorage.writePages('my-blob', largeData)
   * // pageKeys can be stored in metadata for later retrieval
   * ```
   */
  writePages(blobId: string, data: Uint8Array): Promise<string[]>

  /**
   * Read and reassemble data from chunks.
   *
   * Reads all chunks identified by the page keys and reassembles them
   * into the original data.
   *
   * @param blobId - Blob identifier (for error context)
   * @param pageKeys - Array of page keys from writePages
   * @returns Reassembled data
   * @throws Error if any page is missing
   *
   * @example
   * ```typescript
   * const data = await pageStorage.readPages('my-blob', pageKeys)
   * ```
   */
  readPages(blobId: string, pageKeys: string[]): Promise<Uint8Array>

  /**
   * Read a range of bytes from chunked data.
   *
   * Efficiently reads only the chunks needed to satisfy the range request.
   * Handles ranges that span chunk boundaries automatically.
   *
   * @param blobId - Blob identifier (for error context)
   * @param pageKeys - Array of page keys from writePages
   * @param offset - Start byte offset
   * @param length - Number of bytes to read
   * @returns Range data
   * @throws Error if range exceeds data bounds
   *
   * @example
   * ```typescript
   * // Read 1KB starting at offset 1MB
   * const range = await pageStorage.readRange('my-blob', pageKeys, 1024*1024, 1024)
   * ```
   */
  readRange(blobId: string, pageKeys: string[], offset: number, length: number): Promise<Uint8Array>

  /**
   * Update a range of bytes within chunked data.
   *
   * Reads the affected chunks, applies the update, and writes them back.
   * Handles updates that span chunk boundaries automatically.
   *
   * @param blobId - Blob identifier
   * @param pageKeys - Array of page keys
   * @param offset - Start byte offset for update
   * @param data - New data to write at offset
   *
   * @example
   * ```typescript
   * await pageStorage.updateRange('my-blob', pageKeys, 1000, newData)
   * ```
   */
  updateRange(blobId: string, pageKeys: string[], offset: number, data: Uint8Array): Promise<void>

  /**
   * Delete all pages for a blob.
   *
   * @param pageKeys - Array of page keys to delete
   *
   * @example
   * ```typescript
   * await pageStorage.deletePages(pageKeys)
   * ```
   */
  deletePages(pageKeys: string[]): Promise<void>

  /**
   * Get the total size of the stored data.
   *
   * @param blobId - Blob identifier
   * @param pageKeys - Array of page keys
   * @returns Total size in bytes
   */
  getTotalSize(blobId: string, pageKeys: string[]): Promise<number>

  /**
   * Get metadata for a chunked blob.
   *
   * @param blobId - Blob identifier
   * @param pageKeys - Array of page keys
   * @returns Blob metadata
   */
  getMetadata(blobId: string, pageKeys: string[]): Promise<PageMetadata>
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a PageStorage instance.
 *
 * @param config - PageStorage configuration options
 * @returns PageStorage implementation
 *
 * @example
 * ```typescript
 * const pageStorage = createPageStorage({
 *   storage: ctx.storage,
 * })
 *
 * // Write large file
 * const pageKeys = await pageStorage.writePages('file-id', fileData)
 *
 * // Read it back
 * const data = await pageStorage.readPages('file-id', pageKeys)
 *
 * // Read a range
 * const range = await pageStorage.readRange('file-id', pageKeys, 0, 1024)
 * ```
 */
export function createPageStorage(config: PageStorageConfig): PageStorage {
  const { storage, chunkSize = CHUNK_SIZE } = config

  // Track total sizes for metadata
  const sizeMap = new Map<string, number>()

  /**
   * Generate storage key for a page.
   */
  function getPageKey(blobId: string, chunkIndex: number): string {
    return `${PAGE_KEY_PREFIX}${blobId}:${chunkIndex}`
  }

  /**
   * Calculate which chunk(s) a byte range spans.
   */
  function getChunkRange(
    offset: number,
    length: number
  ): { startChunk: number; endChunk: number } {
    const startChunk = Math.floor(offset / chunkSize)
    const endChunk = Math.floor((offset + length - 1) / chunkSize)
    return { startChunk, endChunk }
  }

  /**
   * Write data as 2MB chunks.
   */
  async function writePages(blobId: string, data: Uint8Array): Promise<string[]> {
    if (data.length === 0) {
      // Store empty data marker
      sizeMap.set(blobId, 0)
      return []
    }

    const chunkCount = Math.ceil(data.length / chunkSize)
    const pageKeys: string[] = []

    for (let i = 0; i < chunkCount; i++) {
      const start = i * chunkSize
      const end = Math.min(start + chunkSize, data.length)
      const chunk = data.slice(start, end)

      const key = getPageKey(blobId, i)
      await storage.put(key, chunk)
      pageKeys.push(key)
    }

    // Track total size for metadata
    sizeMap.set(blobId, data.length)

    return pageKeys
  }

  /**
   * Read and reassemble data from chunks.
   */
  async function readPages(_blobId: string, pageKeys: string[]): Promise<Uint8Array> {
    if (pageKeys.length === 0) {
      return new Uint8Array(0)
    }

    // Read all chunks in parallel
    const chunkPromises = pageKeys.map(async (key) => {
      const chunk = await storage.get<Uint8Array>(key)
      if (chunk === undefined) {
        throw new Error(`Missing page chunk: ${key}`)
      }
      return chunk
    })

    const chunks = await Promise.all(chunkPromises)

    // Calculate total size
    let totalSize = 0
    for (const chunk of chunks) {
      totalSize += chunk.length
    }

    // Reassemble
    const result = new Uint8Array(totalSize)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }

    return result
  }

  /**
   * Read a range of bytes from chunked data.
   */
  async function readRange(
    _blobId: string,
    pageKeys: string[],
    offset: number,
    length: number
  ): Promise<Uint8Array> {
    // Validate inputs
    if (offset < 0) {
      throw new Error(`Invalid offset: ${offset} must be non-negative`)
    }
    if (length < 0) {
      throw new Error(`Invalid length: ${length} must be non-negative`)
    }

    // Handle zero-length read
    if (length === 0) {
      return new Uint8Array(0)
    }

    if (pageKeys.length === 0) {
      if (offset > 0 || length > 0) {
        throw new Error(`Range out of bounds: offset=${offset}, length=${length} for empty data`)
      }
      return new Uint8Array(0)
    }

    // Determine which chunks we need to read
    const { startChunk, endChunk } = getChunkRange(offset, length)

    if (startChunk >= pageKeys.length) {
      throw new Error(
        `Range out of bounds: offset=${offset} exceeds data size (${pageKeys.length} chunks)`
      )
    }

    // Read only the necessary chunks
    const neededKeys = pageKeys.slice(startChunk, Math.min(endChunk + 1, pageKeys.length))

    const chunkPromises = neededKeys.map(async (key) => {
      const chunk = await storage.get<Uint8Array>(key)
      if (chunk === undefined) {
        throw new Error(`Missing page chunk: ${key}`)
      }
      return chunk
    })

    const chunks = await Promise.all(chunkPromises)

    // Calculate the actual data size we have
    let totalChunkSize = 0
    for (const chunk of chunks) {
      totalChunkSize += chunk.length
    }

    // Calculate offsets within the chunk data
    const startOffset = offset - startChunk * chunkSize
    const endOffset = startOffset + length

    // Check bounds
    if (endOffset > totalChunkSize) {
      throw new Error(
        `Range out of bounds: requested ${length} bytes at offset ${offset}, but only ${totalChunkSize - startOffset} bytes available`
      )
    }

    // Assemble the needed chunks
    const assembled = new Uint8Array(totalChunkSize)
    let pos = 0
    for (const chunk of chunks) {
      assembled.set(chunk, pos)
      pos += chunk.length
    }

    // Extract the requested range
    return assembled.slice(startOffset, endOffset)
  }

  /**
   * Update a range of bytes within chunked data.
   */
  async function updateRange(
    _blobId: string,
    pageKeys: string[],
    offset: number,
    data: Uint8Array
  ): Promise<void> {
    if (data.length === 0) {
      return
    }

    // Determine which chunks we need to update
    const { startChunk, endChunk } = getChunkRange(offset, data.length)

    // Read the affected chunks
    const neededKeys = pageKeys.slice(startChunk, endChunk + 1)
    const chunkPromises = neededKeys.map(async (key) => {
      const chunk = await storage.get<Uint8Array>(key)
      if (chunk === undefined) {
        throw new Error(`Missing page chunk: ${key}`)
      }
      return chunk
    })

    const chunks = await Promise.all(chunkPromises)

    // Create a working buffer from the affected chunks
    let totalChunkSize = 0
    for (const chunk of chunks) {
      totalChunkSize += chunk.length
    }

    const buffer = new Uint8Array(totalChunkSize)
    let pos = 0
    for (const chunk of chunks) {
      buffer.set(chunk, pos)
      pos += chunk.length
    }

    // Apply the update
    const startOffset = offset - startChunk * chunkSize
    buffer.set(data, startOffset)

    // Write the modified chunks back
    const writePromises: Promise<void>[] = []
    for (let i = 0; i < neededKeys.length; i++) {
      const key = neededKeys[i]
      if (!key) continue // Safety check for TypeScript
      const chunkStart = i * chunkSize
      const chunkEnd = Math.min(chunkStart + chunkSize, buffer.length)
      const updatedChunk = buffer.slice(chunkStart, chunkEnd)
      writePromises.push(storage.put(key, updatedChunk))
    }

    await Promise.all(writePromises)
  }

  /**
   * Delete all pages for a blob.
   */
  async function deletePages(pageKeys: string[]): Promise<void> {
    if (pageKeys.length === 0) {
      return
    }

    const deletePromises = pageKeys.map((key) => storage.delete(key))
    await Promise.all(deletePromises)
  }

  /**
   * Get the total size of the stored data.
   */
  async function getTotalSize(blobId: string, pageKeys: string[]): Promise<number> {
    // Check if we have cached size
    const cachedSize = sizeMap.get(blobId)
    if (cachedSize !== undefined) {
      return cachedSize
    }

    // Otherwise, calculate from chunks
    if (pageKeys.length === 0) {
      return 0
    }

    let totalSize = 0
    for (const key of pageKeys) {
      const chunk = await storage.get<Uint8Array>(key)
      if (chunk) {
        totalSize += chunk.length
      }
    }

    return totalSize
  }

  /**
   * Get metadata for a chunked blob.
   */
  async function getMetadata(blobId: string, pageKeys: string[]): Promise<PageMetadata> {
    const totalSize = await getTotalSize(blobId, pageKeys)

    return {
      blobId,
      totalSize,
      chunkCount: pageKeys.length,
      pageKeys,
    }
  }

  return {
    writePages,
    readPages,
    readRange,
    updateRange,
    deletePages,
    getTotalSize,
    getMetadata,
  }
}

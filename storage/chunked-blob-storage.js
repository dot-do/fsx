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
import { createPageStorage, CHUNK_SIZE } from './page-storage.js';
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
export function createChunkedBlobStorage(config) {
    const { storage, sql } = config;
    // Create the underlying page storage
    const pageStorage = createPageStorage({ storage });
    /**
     * Initialize the schema.
     */
    async function init() {
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
    `);
        await sql.exec('CREATE INDEX IF NOT EXISTS idx_chunked_blobs_tier ON chunked_blobs(tier)');
    }
    /**
     * Write a blob with automatic chunking.
     */
    async function write(blobId, data, options) {
        const tier = options?.tier ?? 'hot';
        const checksum = options?.checksum ?? null;
        // Write chunks using PageStorage
        const pageKeys = await pageStorage.writePages(blobId, data);
        // Store metadata in SQLite
        const pageKeysJson = JSON.stringify(pageKeys);
        const now = Date.now();
        // Use REPLACE to handle updates
        await sql.exec(`INSERT OR REPLACE INTO chunked_blobs (id, size, tier, checksum, page_keys, chunk_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, blobId, data.length, tier, checksum, pageKeysJson, pageKeys.length, now);
        return {
            blobId,
            size: data.length,
            chunkCount: pageKeys.length,
            pageKeys,
        };
    }
    /**
     * Read a blob, reassembling from chunks.
     */
    async function read(blobId) {
        const metadata = await getMetadata(blobId);
        if (!metadata) {
            return null;
        }
        return pageStorage.readPages(blobId, metadata.pageKeys);
    }
    /**
     * Read a range of bytes from a blob.
     */
    async function readRange(blobId, offset, length) {
        const metadata = await getMetadata(blobId);
        if (!metadata) {
            return null;
        }
        return pageStorage.readRange(blobId, metadata.pageKeys, offset, length);
    }
    /**
     * Delete a blob and all its chunks.
     */
    async function deleteBlob(blobId) {
        const metadata = await getMetadata(blobId);
        if (!metadata) {
            return false;
        }
        // Delete the chunks
        await pageStorage.deletePages(metadata.pageKeys);
        // Delete the metadata
        await sql.exec('DELETE FROM chunked_blobs WHERE id = ?', blobId);
        return true;
    }
    /**
     * Check if a blob exists.
     */
    async function exists(blobId) {
        const result = sql
            .exec('SELECT COUNT(*) as count FROM chunked_blobs WHERE id = ?', blobId)
            .one();
        return (result?.count ?? 0) > 0;
    }
    /**
     * Get blob metadata.
     */
    async function getMetadata(blobId) {
        const row = sql
            .exec('SELECT * FROM chunked_blobs WHERE id = ?', blobId)
            .one();
        if (!row) {
            return null;
        }
        const pageKeys = JSON.parse(row.page_keys);
        return {
            id: row.id,
            size: row.size,
            tier: row.tier,
            checksum: row.checksum ?? undefined,
            pageKeys,
            chunkCount: row.chunk_count,
            createdAt: row.created_at,
        };
    }
    /**
     * Get the underlying PageStorage.
     */
    function getPageStorage() {
        return pageStorage;
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
    };
}
// Re-export CHUNK_SIZE for convenience
export { CHUNK_SIZE };
//# sourceMappingURL=chunked-blob-storage.js.map
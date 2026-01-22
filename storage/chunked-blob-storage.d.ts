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
import { type PageStorage, CHUNK_SIZE } from './page-storage.js';
/**
 * Configuration for ChunkedBlobStorage.
 */
export interface ChunkedBlobStorageConfig {
    /**
     * The Durable Object storage instance.
     */
    storage: DurableObjectStorage;
    /**
     * The SQLite storage instance for metadata.
     */
    sql: SqlStorage;
}
/**
 * Blob metadata including page keys for chunked storage.
 */
export interface ChunkedBlobMetadata {
    /**
     * Unique blob identifier.
     */
    id: string;
    /**
     * Total size in bytes.
     */
    size: number;
    /**
     * Storage tier.
     */
    tier: 'hot' | 'warm' | 'cold';
    /**
     * Optional content checksum.
     */
    checksum?: string;
    /**
     * Page keys for chunked storage (JSON serialized).
     */
    pageKeys: string[];
    /**
     * Number of chunks.
     */
    chunkCount: number;
    /**
     * Creation timestamp (Unix ms).
     */
    createdAt: number;
}
/**
 * Result of a write operation.
 */
export interface ChunkedWriteResult {
    /**
     * Blob ID.
     */
    blobId: string;
    /**
     * Total bytes written.
     */
    size: number;
    /**
     * Number of chunks created.
     */
    chunkCount: number;
    /**
     * Page keys for the chunks.
     */
    pageKeys: string[];
}
/**
 * ChunkedBlobStorage interface for cost-optimized large file storage.
 */
export interface ChunkedBlobStorage {
    /**
     * Initialize the storage (creates schema if needed).
     */
    init(): Promise<void>;
    /**
     * Write a blob, automatically chunking if larger than CHUNK_SIZE.
     *
     * @param blobId - Unique identifier for the blob
     * @param data - Blob data to store
     * @param options - Optional write options
     * @returns Write result with metadata
     */
    write(blobId: string, data: Uint8Array, options?: {
        tier?: 'hot' | 'warm' | 'cold';
        checksum?: string;
    }): Promise<ChunkedWriteResult>;
    /**
     * Read a blob, reassembling from chunks if needed.
     *
     * @param blobId - Blob identifier
     * @returns Blob data, or null if not found
     */
    read(blobId: string): Promise<Uint8Array | null>;
    /**
     * Read a range of bytes from a blob.
     *
     * @param blobId - Blob identifier
     * @param offset - Start byte offset
     * @param length - Number of bytes to read
     * @returns Range data, or null if blob not found
     */
    readRange(blobId: string, offset: number, length: number): Promise<Uint8Array | null>;
    /**
     * Delete a blob and all its chunks.
     *
     * @param blobId - Blob identifier
     * @returns true if blob was deleted, false if not found
     */
    delete(blobId: string): Promise<boolean>;
    /**
     * Check if a blob exists.
     *
     * @param blobId - Blob identifier
     * @returns true if blob exists
     */
    exists(blobId: string): Promise<boolean>;
    /**
     * Get blob metadata.
     *
     * @param blobId - Blob identifier
     * @returns Blob metadata, or null if not found
     */
    getMetadata(blobId: string): Promise<ChunkedBlobMetadata | null>;
    /**
     * Get the underlying PageStorage instance.
     */
    getPageStorage(): PageStorage;
}
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
export declare function createChunkedBlobStorage(config: ChunkedBlobStorageConfig): ChunkedBlobStorage;
export { CHUNK_SIZE };
//# sourceMappingURL=chunked-blob-storage.d.ts.map
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
/**
 * Maximum chunk size for optimal DO SQLite pricing.
 * DO SQLite charges per row read/write regardless of size up to 2MB.
 */
export declare const CHUNK_SIZE: number;
/**
 * Storage key prefix for page chunks.
 */
export declare const PAGE_KEY_PREFIX = "__page__";
/**
 * Storage key prefix for page metadata.
 */
export declare const PAGE_META_PREFIX = "__page_meta__";
/**
 * Configuration options for PageStorage.
 */
export interface PageStorageConfig {
    /**
     * The Durable Object storage instance.
     */
    storage: DurableObjectStorage;
    /**
     * Custom chunk size (default: 2MB).
     * Only use for testing - 2MB is optimal for DO pricing.
     */
    chunkSize?: number;
}
/**
 * Metadata stored for a chunked blob.
 */
export interface PageMetadata {
    /**
     * The blob ID this metadata belongs to.
     */
    blobId: string;
    /**
     * Total size of the blob in bytes.
     */
    totalSize: number;
    /**
     * Number of chunks used to store the blob.
     */
    chunkCount: number;
    /**
     * Array of page keys for each chunk.
     */
    pageKeys: string[];
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
    writePages(blobId: string, data: Uint8Array): Promise<string[]>;
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
    readPages(blobId: string, pageKeys: string[]): Promise<Uint8Array>;
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
    readRange(blobId: string, pageKeys: string[], offset: number, length: number): Promise<Uint8Array>;
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
    updateRange(blobId: string, pageKeys: string[], offset: number, data: Uint8Array): Promise<void>;
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
    deletePages(pageKeys: string[]): Promise<void>;
    /**
     * Get the total size of the stored data.
     *
     * @param blobId - Blob identifier
     * @param pageKeys - Array of page keys
     * @returns Total size in bytes
     */
    getTotalSize(blobId: string, pageKeys: string[]): Promise<number>;
    /**
     * Get metadata for a chunked blob.
     *
     * @param blobId - Blob identifier
     * @param pageKeys - Array of page keys
     * @returns Blob metadata
     */
    getMetadata(blobId: string, pageKeys: string[]): Promise<PageMetadata>;
}
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
export declare function createPageStorage(config: PageStorageConfig): PageStorage;
//# sourceMappingURL=page-storage.d.ts.map
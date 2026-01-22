/**
 * R2Storage - R2-backed blob storage for fsx
 *
 * Provides a simple key-value blob storage interface backed by Cloudflare R2.
 * Implements the {@link BlobStorage} interface for consistent API across backends.
 *
 * Features:
 * - Key prefix support for namespacing
 * - Streaming reads and writes
 * - Range reads for partial content
 * - Batch delete operations
 * - Multipart upload support for large files
 * - Optional instrumentation hooks for metrics/logging
 *
 * @example
 * ```typescript
 * const storage = new R2Storage({
 *   bucket: env.MY_BUCKET,
 *   prefix: 'files/',
 *   hooks: {
 *     onOperationEnd: (ctx, result) => {
 *       console.log(`${ctx.operation} took ${result.durationMs}ms`)
 *     }
 *   }
 * })
 *
 * await storage.put('/data.json', new TextEncoder().encode('{}'))
 * const result = await storage.get('/data.json')
 * ```
 *
 * @module storage/r2
 */
import { type BlobStorage, type BlobWriteResult, type BlobReadResult, type BlobListResult, type BlobWriteOptions, type BlobListOptions, type StorageHooks } from './interfaces.js';
/**
 * Configuration for retry logic with exponential backoff.
 */
export interface RetryConfig {
    /** Maximum number of retry attempts (default: 3) */
    maxAttempts?: number;
    /** Base delay in milliseconds for exponential backoff (default: 100) */
    baseDelayMs?: number;
    /** Maximum delay in milliseconds (default: 5000) */
    maxDelayMs?: number;
    /** Error codes that should trigger a retry (default: ['ETIMEDOUT', 'EIO']) */
    retryableErrors?: string[];
}
/**
 * Configuration options for R2Storage.
 */
export interface R2StorageConfig {
    /** R2 bucket binding from wrangler.toml */
    bucket: R2Bucket;
    /** Key prefix for all objects (default: '') */
    prefix?: string;
    /** Optional instrumentation hooks for metrics/logging */
    hooks?: StorageHooks;
    /** Optional retry configuration for transient errors */
    retry?: RetryConfig;
}
/**
 * Extended write options for R2-specific features.
 */
export interface R2WriteOptions extends BlobWriteOptions {
    /** MD5 checksum for integrity verification */
    md5?: string;
}
/**
 * Metadata returned from R2 operations.
 *
 * Extends the base metadata interface with R2-specific fields.
 */
export interface R2ObjectMetadata {
    /** Size in bytes */
    size: number;
    /** ETag */
    etag: string;
    /** Content type (if set) */
    contentType?: string;
    /** Custom metadata */
    customMetadata?: Record<string, string>;
    /** Last modified timestamp */
    lastModified?: Date;
    /** R2 HTTP metadata */
    httpMetadata?: R2HTTPMetadata;
    /** MD5 checksum (if available) */
    md5?: string;
}
/**
 * R2Storage - Blob storage backed by Cloudflare R2.
 *
 * Implements the {@link BlobStorage} interface for storing binary data
 * in Cloudflare R2 object storage. Provides a clean API for common
 * operations with optional instrumentation support.
 *
 * @implements {BlobStorage}
 *
 * @example
 * ```typescript
 * // Basic usage
 * const storage = new R2Storage({ bucket: env.MY_BUCKET })
 * await storage.put('/file.txt', data)
 * const result = await storage.get('/file.txt')
 *
 * // With prefix namespacing
 * const userStorage = new R2Storage({
 *   bucket: env.MY_BUCKET,
 *   prefix: `users/${userId}/`
 * })
 *
 * // With instrumentation
 * const storage = new R2Storage({
 *   bucket: env.MY_BUCKET,
 *   hooks: {
 *     onOperationStart: (ctx) => console.log(`Starting ${ctx.operation}`),
 *     onOperationEnd: (ctx, result) => {
 *       metrics.record(ctx.operation, result.durationMs)
 *     }
 *   }
 * })
 * ```
 */
export declare class R2Storage implements BlobStorage {
    private readonly bucket;
    private readonly prefix;
    private readonly hooks?;
    /** @internal Reserved for future retry functionality */
    private readonly _retryConfig;
    /**
     * Create a new R2Storage instance.
     *
     * @param config - Storage configuration
     */
    constructor(config: R2StorageConfig);
    /**
     * Get full key with prefix.
     *
     * @param path - Relative path
     * @returns Full key with prefix
     * @internal
     */
    private key;
    /**
     * Store a blob in R2.
     *
     * @param path - Storage key/path
     * @param data - Blob data (bytes or stream)
     * @param options - Write options (contentType, customMetadata, md5)
     * @returns Write result with etag and size
     *
     * @example
     * ```typescript
     * // Store binary data
     * const result = await storage.put('/data.bin', bytes)
     * console.log(`Stored ${result.size} bytes, etag: ${result.etag}`)
     *
     * // Store with content type
     * await storage.put('/image.png', imageBytes, {
     *   contentType: 'image/png'
     * })
     *
     * // Store with custom metadata
     * await storage.put('/file.txt', data, {
     *   customMetadata: { author: 'user123' }
     * })
     * ```
     */
    put(path: string, data: Uint8Array | ReadableStream, options?: R2WriteOptions): Promise<BlobWriteResult>;
    /**
     * Retrieve a blob from R2.
     *
     * @param path - Storage key/path
     * @returns Blob data and metadata, or null if not found
     *
     * @example
     * ```typescript
     * const result = await storage.get('/data.json')
     * if (result) {
     *   const text = new TextDecoder().decode(result.data)
     *   console.log(`Size: ${result.metadata.size} bytes`)
     * }
     * ```
     */
    get(path: string): Promise<BlobReadResult<Uint8Array> | null>;
    /**
     * Retrieve a blob as a readable stream.
     *
     * Useful for large files where buffering the entire content
     * in memory is not desirable.
     *
     * @param path - Storage key/path
     * @returns Stream and metadata, or null if not found
     *
     * @example
     * ```typescript
     * const result = await storage.getStream('/large-file.bin')
     * if (result) {
     *   // Pipe to response
     *   return new Response(result.stream, {
     *     headers: { 'Content-Length': String(result.metadata.size) }
     *   })
     * }
     * ```
     */
    getStream(path: string): Promise<{
        stream: ReadableStream;
        metadata: R2ObjectMetadata;
    } | null>;
    /**
     * Retrieve a range of bytes from a blob.
     *
     * Useful for resumable downloads or seeking within large files.
     *
     * @param path - Storage key/path
     * @param start - Start byte offset (inclusive)
     * @param end - End byte offset (inclusive, optional)
     * @returns Partial blob data and metadata, or null if not found
     *
     * @example
     * ```typescript
     * // Get first 1KB
     * const head = await storage.getRange('/file.bin', 0, 1023)
     *
     * // Get bytes 1000 to end
     * const tail = await storage.getRange('/file.bin', 1000)
     * ```
     */
    getRange(path: string, start: number, end?: number): Promise<BlobReadResult<Uint8Array> | null>;
    /**
     * Retrieve the last N bytes from a blob (suffix range).
     *
     * @param path - Storage key/path
     * @param length - Number of bytes from the end
     * @returns Partial blob data and metadata, or null if not found
     *
     * @example
     * ```typescript
     * // Get last 100 bytes
     * const tail = await storage.getRangeSuffix('/file.bin', 100)
     * ```
     */
    getRangeSuffix(path: string, length: number): Promise<BlobReadResult<Uint8Array> | null>;
    /**
     * Delete a blob from R2.
     *
     * This operation is idempotent - it succeeds even if the blob doesn't exist.
     *
     * @param path - Storage key/path
     *
     * @example
     * ```typescript
     * await storage.delete('/old-file.txt')
     * ```
     */
    delete(path: string): Promise<void>;
    /**
     * Delete multiple blobs in a single operation.
     *
     * More efficient than individual deletes for batch cleanup.
     *
     * @param paths - Storage keys/paths to delete
     *
     * @example
     * ```typescript
     * await storage.deleteMany(['/file1.txt', '/file2.txt', '/file3.txt'])
     * ```
     */
    deleteMany(paths: string[]): Promise<void>;
    /**
     * Check if a blob exists in R2.
     *
     * Uses HEAD request for efficiency - doesn't download the blob content.
     *
     * @param path - Storage key/path
     * @returns true if blob exists
     *
     * @example
     * ```typescript
     * if (await storage.exists('/config.json')) {
     *   const config = await storage.get('/config.json')
     * }
     * ```
     */
    exists(path: string): Promise<boolean>;
    /**
     * Get blob metadata without downloading content.
     *
     * Efficient way to check file size, content type, or custom metadata.
     *
     * @param path - Storage key/path
     * @returns Metadata or null if not found
     *
     * @example
     * ```typescript
     * const meta = await storage.head('/file.txt')
     * if (meta) {
     *   console.log(`Size: ${meta.size}, Type: ${meta.contentType}`)
     * }
     * ```
     */
    head(path: string): Promise<R2ObjectMetadata | null>;
    /**
     * List blobs with optional prefix filter.
     *
     * Supports pagination for large result sets using cursor-based pagination.
     *
     * @param options - List options (prefix, limit, cursor)
     * @returns List of blob objects with pagination info
     *
     * @example
     * ```typescript
     * // List all blobs
     * const result = await storage.list()
     *
     * // List with prefix filter
     * const images = await storage.list({ prefix: 'images/' })
     *
     * // Paginate through results
     * let cursor: string | undefined
     * do {
     *   const page = await storage.list({ limit: 100, cursor })
     *   for (const obj of page.objects) {
     *     console.log(obj.key)
     *   }
     *   cursor = page.cursor
     * } while (cursor)
     * ```
     */
    list(options?: BlobListOptions): Promise<BlobListResult>;
    /**
     * Copy a blob within R2.
     *
     * Note: R2 doesn't have native copy, so this reads and writes the data.
     * For large files, consider using multipart upload.
     *
     * @param sourcePath - Source key/path
     * @param destPath - Destination key/path
     * @returns Write result for the copy
     * @throws {StorageError} If source not found (ENOENT)
     *
     * @example
     * ```typescript
     * await storage.copy('/original.txt', '/backup.txt')
     * ```
     */
    copy(sourcePath: string, destPath: string): Promise<BlobWriteResult>;
    /**
     * Create a multipart upload for large files.
     *
     * Use for files larger than 5MB for better reliability and performance.
     * Allows parallel uploads of file parts.
     *
     * @param path - Storage key/path
     * @param options - Upload options (contentType, customMetadata)
     * @returns R2MultipartUpload handle
     *
     * @example
     * ```typescript
     * const upload = await storage.createMultipartUpload('/large-file.bin', {
     *   contentType: 'application/octet-stream'
     * })
     *
     * const parts: R2UploadedPart[] = []
     * for (let i = 0; i < chunks.length; i++) {
     *   const part = await upload.uploadPart(i + 1, chunks[i])
     *   parts.push(part)
     * }
     *
     * await upload.complete(parts)
     * ```
     */
    createMultipartUpload(path: string, options?: BlobWriteOptions): Promise<R2MultipartUpload>;
    /**
     * Resume an in-progress multipart upload.
     *
     * Use to continue an upload that was interrupted or to add more parts.
     *
     * @param path - Storage key/path
     * @param uploadId - Upload ID from createMultipartUpload
     * @returns R2MultipartUpload handle
     *
     * @example
     * ```typescript
     * // Resume a previous upload
     * const upload = storage.resumeMultipartUpload('/large-file.bin', savedUploadId)
     * const part = await upload.uploadPart(nextPartNumber, nextChunk)
     * ```
     */
    resumeMultipartUpload(path: string, uploadId: string): R2MultipartUpload;
}
//# sourceMappingURL=r2.d.ts.map
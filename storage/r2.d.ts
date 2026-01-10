/**
 * R2Storage - R2-backed blob storage for fsx
 */
export interface R2StorageConfig {
    /** R2 bucket binding */
    bucket: R2Bucket;
    /** Key prefix for all objects */
    prefix?: string;
}
/**
 * R2Storage - Store blobs in R2
 */
export declare class R2Storage {
    private bucket;
    private prefix;
    constructor(config: R2StorageConfig);
    /**
     * Get full key with prefix
     */
    private key;
    /**
     * Store a blob
     */
    put(path: string, data: Uint8Array | ReadableStream, options?: {
        contentType?: string;
        customMetadata?: Record<string, string>;
    }): Promise<{
        etag: string;
        size: number;
    }>;
    /**
     * Get a blob
     */
    get(path: string): Promise<{
        data: Uint8Array;
        metadata: R2Object;
    } | null>;
    /**
     * Get a blob as a stream
     */
    getStream(path: string): Promise<{
        stream: ReadableStream;
        metadata: R2Object;
    } | null>;
    /**
     * Get a range of a blob
     */
    getRange(path: string, start: number, end?: number): Promise<{
        data: Uint8Array;
        metadata: R2Object;
    } | null>;
    /**
     * Delete a blob
     */
    delete(path: string): Promise<void>;
    /**
     * Delete multiple blobs
     */
    deleteMany(paths: string[]): Promise<void>;
    /**
     * Check if blob exists
     */
    exists(path: string): Promise<boolean>;
    /**
     * Get blob metadata without downloading
     */
    head(path: string): Promise<R2Object | null>;
    /**
     * List blobs
     */
    list(options?: {
        prefix?: string;
        limit?: number;
        cursor?: string;
    }): Promise<{
        objects: R2Object[];
        cursor?: string;
        truncated: boolean;
    }>;
    /**
     * Copy a blob
     */
    copy(sourcePath: string, destPath: string): Promise<{
        etag: string;
        size: number;
    }>;
    /**
     * Create a multipart upload
     */
    createMultipartUpload(path: string, options?: {
        contentType?: string;
        customMetadata?: Record<string, string>;
    }): Promise<R2MultipartUpload>;
    /**
     * Resume a multipart upload
     */
    resumeMultipartUpload(path: string, uploadId: string): R2MultipartUpload;
}
//# sourceMappingURL=r2.d.ts.map
/**
 * R2Storage - R2-backed blob storage for fsx
 */
/**
 * R2Storage - Store blobs in R2
 */
export class R2Storage {
    bucket;
    prefix;
    constructor(config) {
        this.bucket = config.bucket;
        this.prefix = config.prefix || '';
    }
    /**
     * Get full key with prefix
     */
    key(path) {
        return this.prefix + path;
    }
    /**
     * Store a blob
     */
    async put(path, data, options) {
        const key = this.key(path);
        const object = await this.bucket.put(key, data, {
            httpMetadata: options?.contentType ? { contentType: options.contentType } : undefined,
            customMetadata: options?.customMetadata,
        });
        return {
            etag: object.etag,
            size: object.size,
        };
    }
    /**
     * Get a blob
     */
    async get(path) {
        const key = this.key(path);
        const object = await this.bucket.get(key);
        if (!object) {
            return null;
        }
        const data = new Uint8Array(await object.arrayBuffer());
        return { data, metadata: object };
    }
    /**
     * Get a blob as a stream
     */
    async getStream(path) {
        const key = this.key(path);
        const object = await this.bucket.get(key);
        if (!object) {
            return null;
        }
        return { stream: object.body, metadata: object };
    }
    /**
     * Get a range of a blob
     */
    async getRange(path, start, end) {
        const key = this.key(path);
        const range = end !== undefined ? { offset: start, length: end - start + 1 } : { offset: start };
        const object = await this.bucket.get(key, { range });
        if (!object) {
            return null;
        }
        const data = new Uint8Array(await object.arrayBuffer());
        return { data, metadata: object };
    }
    /**
     * Delete a blob
     */
    async delete(path) {
        const key = this.key(path);
        await this.bucket.delete(key);
    }
    /**
     * Delete multiple blobs
     */
    async deleteMany(paths) {
        const keys = paths.map((p) => this.key(p));
        await this.bucket.delete(keys);
    }
    /**
     * Check if blob exists
     */
    async exists(path) {
        const key = this.key(path);
        const object = await this.bucket.head(key);
        return object !== null;
    }
    /**
     * Get blob metadata without downloading
     */
    async head(path) {
        const key = this.key(path);
        return this.bucket.head(key);
    }
    /**
     * List blobs
     */
    async list(options) {
        const fullPrefix = options?.prefix ? this.key(options.prefix) : this.prefix;
        const result = await this.bucket.list({
            prefix: fullPrefix,
            limit: options?.limit,
            cursor: options?.cursor,
        });
        return {
            objects: result.objects,
            cursor: result.cursor,
            truncated: result.truncated,
        };
    }
    /**
     * Copy a blob
     */
    async copy(sourcePath, destPath) {
        const sourceKey = this.key(sourcePath);
        const destKey = this.key(destPath);
        // R2 doesn't have native copy, so we need to get and put
        const source = await this.bucket.get(sourceKey);
        if (!source) {
            throw new Error(`Source not found: ${sourcePath}`);
        }
        const object = await this.bucket.put(destKey, source.body, {
            httpMetadata: source.httpMetadata,
            customMetadata: source.customMetadata,
        });
        return {
            etag: object.etag,
            size: object.size,
        };
    }
    /**
     * Create a multipart upload
     */
    async createMultipartUpload(path, options) {
        const key = this.key(path);
        return this.bucket.createMultipartUpload(key, {
            httpMetadata: options?.contentType ? { contentType: options.contentType } : undefined,
            customMetadata: options?.customMetadata,
        });
    }
    /**
     * Resume a multipart upload
     */
    resumeMultipartUpload(path, uploadId) {
        const key = this.key(path);
        return this.bucket.resumeMultipartUpload(key, uploadId);
    }
}
//# sourceMappingURL=r2.js.map
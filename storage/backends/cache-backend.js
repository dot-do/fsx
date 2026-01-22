/**
 * CacheBlobStorage - Cloudflare Cache API Backend for ExtentStorage
 *
 * Provides an ephemeral, FREE storage backend using Cloudflare's Cache API.
 * Perfect for temporary files, scratch space, build artifacts, and session data.
 *
 * Key characteristics:
 * - FREE: No cost for reads or writes
 * - Unlimited: No rate limits on operations
 * - Global: Edge-distributed caching
 * - Ephemeral: No durability guarantees, data may expire
 *
 * Limitations:
 * - No list() support (Cache API doesn't support enumeration)
 * - TTL-based expiration (default 24 hours, max 30 days)
 * - Data may be evicted at any time based on cache pressure
 *
 * @module storage/backends/cache-backend
 */
// =============================================================================
// Constants
// =============================================================================
/** Default cache name */
const DEFAULT_CACHE_NAME = 'fsx-extents';
/** Default TTL: 24 hours */
const DEFAULT_TTL = 86400;
/** Maximum TTL: 30 days */
const MAX_TTL = 2592000;
/** Custom header for storing size metadata */
const HEADER_SIZE = 'X-Fsx-Size';
/** Custom header for storing ETag */
const HEADER_ETAG = 'X-Fsx-Etag';
/** Custom header for storing creation timestamp */
const HEADER_CREATED = 'X-Fsx-Created';
/** Custom header for storing content type */
const HEADER_CONTENT_TYPE = 'X-Fsx-Content-Type';
/** Custom metadata prefix */
const HEADER_META_PREFIX = 'X-Fsx-Meta-';
// =============================================================================
// CacheBlobStorage Implementation
// =============================================================================
/**
 * CacheBlobStorage - Ephemeral blob storage using Cloudflare Cache API.
 *
 * Implements the BlobStorage interface for use with ExtentStorage and other
 * fsx components. Provides free, unlimited read/write storage with global
 * edge distribution.
 *
 * @example
 * ```typescript
 * // Create cache backend
 * const storage = new CacheBlobStorage({
 *   baseUrl: 'https://fsx.cache/',
 *   defaultTtl: 3600, // 1 hour
 * })
 *
 * // Store a blob
 * await storage.put('extent/abc123', extentData)
 *
 * // Retrieve a blob
 * const result = await storage.get('extent/abc123')
 * if (result) {
 *   console.log('Got', result.data.length, 'bytes')
 * }
 *
 * // Delete a blob
 * await storage.delete('extent/abc123')
 * ```
 */
export class CacheBlobStorage {
    cacheName;
    baseUrl;
    defaultTtl;
    maxTtl;
    /** Lazily initialized cache instance */
    cache = null;
    constructor(config) {
        // Validate baseUrl
        if (!config.baseUrl) {
            throw new Error('CacheBackendConfig.baseUrl is required');
        }
        try {
            new URL(config.baseUrl);
        }
        catch {
            throw new Error(`Invalid baseUrl: ${config.baseUrl}. Must be a valid URL.`);
        }
        this.cacheName = config.cacheName ?? DEFAULT_CACHE_NAME;
        this.baseUrl = config.baseUrl.endsWith('/') ? config.baseUrl : config.baseUrl + '/';
        this.defaultTtl = Math.min(config.defaultTtl ?? DEFAULT_TTL, config.maxTtl ?? MAX_TTL);
        this.maxTtl = config.maxTtl ?? MAX_TTL;
    }
    // ===========================================================================
    // Private Helpers
    // ===========================================================================
    /**
     * Get the cache instance, opening it lazily.
     */
    async getCache() {
        if (!this.cache) {
            this.cache = await caches.open(this.cacheName);
        }
        return this.cache;
    }
    /**
     * Build a Request object for a given path.
     */
    buildRequest(path) {
        // Normalize path: remove leading slash, encode components
        const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
        const url = this.baseUrl + encodeURIComponent(normalizedPath);
        return new Request(url, { method: 'GET' });
    }
    /**
     * Build a Response object for storage.
     */
    buildResponse(data, options) {
        const now = Date.now();
        const ttl = Math.min(options?.ttl ?? this.defaultTtl, this.maxTtl);
        // Generate ETag from content hash (simple FNV-1a for speed)
        const etag = this.generateEtag(data);
        // Build headers
        const headers = new Headers({
            'Content-Type': options?.contentType ?? 'application/octet-stream',
            'Content-Length': String(data.length),
            'Cache-Control': `public, max-age=${ttl}`,
            'ETag': etag,
            [HEADER_SIZE]: String(data.length),
            [HEADER_ETAG]: etag,
            [HEADER_CREATED]: String(now),
        });
        // Store original content type if provided
        if (options?.contentType) {
            headers.set(HEADER_CONTENT_TYPE, options.contentType);
        }
        // Store custom metadata
        if (options?.customMetadata) {
            for (const [key, value] of Object.entries(options.customMetadata)) {
                headers.set(HEADER_META_PREFIX + key, value);
            }
        }
        // Create a new ArrayBuffer copy to ensure compatibility with Response constructor
        // This handles cases where data.buffer might be SharedArrayBuffer
        const buffer = new ArrayBuffer(data.length);
        new Uint8Array(buffer).set(data);
        return new Response(buffer, {
            status: 200,
            headers,
        });
    }
    /**
     * Generate a simple ETag using FNV-1a hash.
     */
    generateEtag(data) {
        // FNV-1a 32-bit hash
        let hash = 2166136261;
        for (let i = 0; i < data.length; i++) {
            hash ^= data[i];
            hash = Math.imul(hash, 16777619);
        }
        // Convert to unsigned and hex
        const unsigned = hash >>> 0;
        return `"${unsigned.toString(16)}-${data.length}"`;
    }
    /**
     * Extract metadata from response headers.
     */
    extractMetadata(response) {
        const headers = response.headers;
        // Get size (prefer custom header, fall back to content-length)
        const sizeHeader = headers.get(HEADER_SIZE);
        const contentLength = headers.get('Content-Length');
        const size = sizeHeader ? parseInt(sizeHeader, 10) : (contentLength ? parseInt(contentLength, 10) : 0);
        // Get ETag (prefer custom header, fall back to standard)
        const etag = headers.get(HEADER_ETAG) ?? headers.get('ETag') ?? '';
        // Get content type
        const contentType = headers.get(HEADER_CONTENT_TYPE) ?? headers.get('Content-Type') ?? undefined;
        // Get creation timestamp
        const createdHeader = headers.get(HEADER_CREATED);
        const lastModified = createdHeader ? new Date(parseInt(createdHeader, 10)) : undefined;
        // Extract custom metadata
        const customMetadata = {};
        headers.forEach((value, key) => {
            if (key.toLowerCase().startsWith(HEADER_META_PREFIX.toLowerCase())) {
                const metaKey = key.slice(HEADER_META_PREFIX.length);
                customMetadata[metaKey] = value;
            }
        });
        return {
            size,
            etag,
            contentType,
            customMetadata: Object.keys(customMetadata).length > 0 ? customMetadata : undefined,
            lastModified,
        };
    }
    // ===========================================================================
    // BlobStorage Interface Implementation
    // ===========================================================================
    /**
     * Store a blob in the cache.
     *
     * @param path - Storage key/path
     * @param data - Blob data (Uint8Array or ReadableStream)
     * @param options - Write options including TTL
     * @returns Write result with etag and size
     */
    async put(path, data, options) {
        const cache = await this.getCache();
        const request = this.buildRequest(path);
        // Convert ReadableStream to Uint8Array if needed
        let bytes;
        if (data instanceof Uint8Array) {
            bytes = data;
        }
        else {
            // Read stream to completion
            const reader = data.getReader();
            const chunks = [];
            let totalLength = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                chunks.push(value);
                totalLength += value.length;
            }
            bytes = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
            }
        }
        const response = this.buildResponse(bytes, options);
        await cache.put(request, response);
        const etag = this.generateEtag(bytes);
        return {
            etag,
            size: bytes.length,
        };
    }
    /**
     * Retrieve a blob from the cache.
     *
     * @param path - Storage key/path
     * @returns Blob data and metadata, or null if not found
     */
    async get(path) {
        const cache = await this.getCache();
        const request = this.buildRequest(path);
        const response = await cache.match(request);
        if (!response) {
            return null;
        }
        // Read response body
        const arrayBuffer = await response.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);
        const metadata = this.extractMetadata(response);
        return {
            data,
            metadata,
        };
    }
    /**
     * Retrieve a blob as a stream.
     *
     * @param path - Storage key/path
     * @returns Stream and metadata, or null if not found
     */
    async getStream(path) {
        const cache = await this.getCache();
        const request = this.buildRequest(path);
        const response = await cache.match(request);
        if (!response || !response.body) {
            return null;
        }
        return {
            stream: response.body,
            metadata: this.extractMetadata(response),
        };
    }
    /**
     * Delete a blob from the cache.
     *
     * @param path - Storage key/path
     */
    async delete(path) {
        const cache = await this.getCache();
        const request = this.buildRequest(path);
        await cache.delete(request);
    }
    /**
     * Delete multiple blobs from the cache.
     *
     * @param paths - Storage keys/paths to delete
     */
    async deleteMany(paths) {
        const cache = await this.getCache();
        await Promise.all(paths.map(path => {
            const request = this.buildRequest(path);
            return cache.delete(request);
        }));
    }
    /**
     * Check if a blob exists in the cache.
     *
     * @param path - Storage key/path
     * @returns true if blob exists
     */
    async exists(path) {
        const cache = await this.getCache();
        const request = this.buildRequest(path);
        const response = await cache.match(request);
        return response !== undefined;
    }
    /**
     * Get blob metadata without downloading content.
     *
     * Note: Cache API doesn't support true HEAD requests, so this
     * fetches the full response and extracts headers. For large blobs,
     * consider using exists() if you only need presence check.
     *
     * @param path - Storage key/path
     * @returns Metadata or null if not found
     */
    async head(path) {
        const cache = await this.getCache();
        const request = this.buildRequest(path);
        const response = await cache.match(request);
        if (!response) {
            return null;
        }
        return this.extractMetadata(response);
    }
    /**
     * List blobs in the cache.
     *
     * IMPORTANT: Cache API does not support listing/enumeration.
     * This method returns an empty result with a warning.
     *
     * For use cases requiring listing, consider:
     * 1. Tracking keys in a separate metadata store
     * 2. Using a different backend (R2, KV) that supports listing
     * 3. Maintaining an in-memory or SQL-based index of cached keys
     *
     * @param _options - List options (ignored - Cache API limitation)
     * @returns Empty list result
     */
    async list(_options) {
        // Cache API does not support listing
        // Return empty result rather than throwing to maintain compatibility
        console.warn('CacheBlobStorage.list() called but Cache API does not support listing. ' +
            'Consider using R2 or KV backend if listing is required, or maintain a separate key index.');
        return {
            objects: [],
            truncated: false,
        };
    }
    /**
     * Copy a blob within the cache.
     *
     * Note: Implemented as get + put since Cache API doesn't have native copy.
     *
     * @param sourcePath - Source key/path
     * @param destPath - Destination key/path
     * @returns Write result for the copy
     * @throws Error if source doesn't exist
     */
    async copy(sourcePath, destPath) {
        const source = await this.get(sourcePath);
        if (!source) {
            throw new Error(`Source not found: ${sourcePath}`);
        }
        return this.put(destPath, source.data, {
            contentType: source.metadata.contentType,
            customMetadata: source.metadata.customMetadata,
        });
    }
}
// =============================================================================
// Factory Function
// =============================================================================
/**
 * Create a CacheBlobStorage instance.
 *
 * @param config - Cache backend configuration
 * @returns Configured CacheBlobStorage instance
 *
 * @example
 * ```typescript
 * // Basic usage
 * const cache = createCacheBackend({
 *   baseUrl: 'https://fsx.cache/',
 * })
 *
 * // With custom TTL
 * const cache = createCacheBackend({
 *   baseUrl: 'https://my-worker.workers.dev/cache/',
 *   cacheName: 'my-app-cache',
 *   defaultTtl: 3600,    // 1 hour default
 *   maxTtl: 604800,      // 1 week max
 * })
 *
 * // Use with ExtentStorage
 * const extentStorage = await createExtentStorage({
 *   pageSize: 4096,
 *   extentSize: 2 * 1024 * 1024,
 *   backend: cache,
 *   sql: sqlAdapter,
 * })
 * ```
 */
export function createCacheBackend(config) {
    return new CacheBlobStorage(config);
}
//# sourceMappingURL=cache-backend.js.map
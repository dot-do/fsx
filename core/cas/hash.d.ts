/**
 * Hash computation functions using the Web Crypto API (crypto.subtle)
 *
 * These functions compute cryptographic hashes for content-addressable storage.
 * They return lowercase hex-encoded strings.
 *
 * Features:
 * - Multiple algorithm support (SHA-1, SHA-256, SHA-384, SHA-512)
 * - Streaming hash support for large files via ReadableStream
 * - LRU cache for repeated hash computations
 * - Optimized hex conversion with pre-computed lookup tables
 */
/**
 * Supported hash algorithms.
 *
 * @example
 * ```typescript
 * const hash = await computeHash(data, HashAlgorithm.SHA256)
 * ```
 */
export declare enum HashAlgorithm {
    /** SHA-1 (160-bit, 40 hex chars) - git default, fast but cryptographically weak */
    SHA1 = "SHA-1",
    /** SHA-256 (256-bit, 64 hex chars) - recommended for new applications */
    SHA256 = "SHA-256",
    /** SHA-384 (384-bit, 96 hex chars) - truncated SHA-512 */
    SHA384 = "SHA-384",
    /** SHA-512 (512-bit, 128 hex chars) - maximum security */
    SHA512 = "SHA-512"
}
/**
 * Hash output lengths in hex characters for each algorithm.
 * @internal
 */
export declare const HASH_LENGTHS: Record<HashAlgorithm, number>;
/**
 * Convert a Uint8Array to a hexadecimal string.
 *
 * Uses a pre-computed lookup table for O(1) byte-to-hex conversion,
 * making this significantly faster than string formatting approaches.
 *
 * @param bytes - Binary data to convert
 * @returns Lowercase hexadecimal string
 *
 * @example
 * ```typescript
 * const hello = new TextEncoder().encode('Hello')
 * const hex = bytesToHex(hello)
 * console.log(hex) // '48656c6c6f'
 * ```
 */
export declare function bytesToHex(bytes: Uint8Array): string;
/**
 * Convert a hexadecimal string to a Uint8Array.
 *
 * Uses pre-computed reverse lookup for O(1) conversion per byte pair.
 *
 * @param hex - Hexadecimal string (case-insensitive)
 * @returns Binary data as Uint8Array
 * @throws Error if hex string has odd length or invalid characters
 *
 * @example
 * ```typescript
 * const bytes = hexToBytes('48656c6c6f')
 * console.log(new TextDecoder().decode(bytes)) // 'Hello'
 * ```
 */
export declare function hexToBytes(hex: string): Uint8Array;
/**
 * Configuration for the hash cache.
 */
export interface HashCacheConfig {
    /** Maximum number of entries to cache (default: 1000) */
    maxSize?: number;
    /** Whether caching is enabled (default: true) */
    enabled?: boolean;
}
/**
 * Configure the global hash cache.
 *
 * @example
 * ```typescript
 * // Disable caching
 * configureHashCache({ enabled: false })
 *
 * // Increase cache size
 * configureHashCache({ maxSize: 5000 })
 * ```
 */
export declare function configureHashCache(config: HashCacheConfig): void;
/**
 * Clear the global hash cache.
 */
export declare function clearHashCache(): void;
/**
 * Get statistics about the hash cache.
 */
export declare function getHashCacheStats(): {
    size: number;
    maxSize: number;
    enabled: boolean;
};
/**
 * Compute hash using specified algorithm.
 *
 * This is the unified hash function that supports all algorithms
 * and optional caching.
 *
 * @param data - Input data as Uint8Array or string (UTF-8 encoded)
 * @param algorithm - Hash algorithm to use (default: SHA-256)
 * @param options - Optional configuration
 * @returns Hex-encoded hash string
 *
 * @example
 * ```typescript
 * // Using the unified API
 * const hash = await computeHash(data, HashAlgorithm.SHA256)
 *
 * // With caching disabled for this call
 * const hash = await computeHash(data, HashAlgorithm.SHA1, { useCache: false })
 * ```
 */
export declare function computeHash(data: Uint8Array | string, algorithm?: HashAlgorithm, options?: {
    useCache?: boolean;
}): Promise<string>;
/**
 * Compute SHA-1 hash of data
 * @param data - Input data as Uint8Array or string (UTF-8 encoded)
 * @returns 40-character lowercase hex string
 */
export declare function sha1(data: Uint8Array | string): Promise<string>;
/**
 * Compute SHA-256 hash of data
 * @param data - Input data as Uint8Array or string (UTF-8 encoded)
 * @returns 64-character lowercase hex string
 */
export declare function sha256(data: Uint8Array | string): Promise<string>;
/**
 * Compute SHA-384 hash of data
 * @param data - Input data as Uint8Array or string (UTF-8 encoded)
 * @returns 96-character lowercase hex string
 */
export declare function sha384(data: Uint8Array | string): Promise<string>;
/**
 * Compute SHA-512 hash of data
 * @param data - Input data as Uint8Array or string (UTF-8 encoded)
 * @returns 128-character lowercase hex string
 */
export declare function sha512(data: Uint8Array | string): Promise<string>;
/**
 * Options for streaming hash computation.
 */
export interface StreamingHashOptions {
    /** Chunk size for processing (default: 64KB) */
    chunkSize?: number;
    /** Progress callback, called after each chunk with bytes processed */
    onProgress?: (bytesProcessed: number, totalBytes?: number) => void;
}
/**
 * Incremental hasher for streaming data.
 *
 * Since Web Crypto API doesn't support incremental hashing directly,
 * this collects chunks and computes the final hash when finalized.
 * For truly large files, consider using chunked uploads with per-chunk hashes.
 *
 * @example
 * ```typescript
 * const hasher = createStreamingHasher(HashAlgorithm.SHA256)
 * hasher.update(chunk1)
 * hasher.update(chunk2)
 * const hash = await hasher.finalize()
 * ```
 */
export interface StreamingHasher {
    /** Add data to the hash computation */
    update(chunk: Uint8Array | string): void;
    /** Finalize and return the hash */
    finalize(): Promise<string>;
    /** Get total bytes processed so far */
    bytesProcessed(): number;
    /** Reset the hasher for reuse */
    reset(): void;
}
/**
 * Create an incremental hasher for streaming data.
 *
 * @param algorithm - Hash algorithm to use
 * @returns StreamingHasher instance
 */
export declare function createStreamingHasher(algorithm?: HashAlgorithm): StreamingHasher;
/**
 * Compute hash from a ReadableStream.
 *
 * Processes the stream in chunks to minimize memory usage for large files.
 *
 * @param stream - ReadableStream of Uint8Array chunks
 * @param algorithm - Hash algorithm to use
 * @param options - Streaming options
 * @returns Hex-encoded hash string
 *
 * @example
 * ```typescript
 * // Hash a file stream
 * const response = await fetch('https://example.com/large-file')
 * const hash = await hashStream(response.body!, HashAlgorithm.SHA256)
 *
 * // With progress tracking
 * const hash = await hashStream(stream, HashAlgorithm.SHA256, {
 *   onProgress: (bytes) => console.log(`Processed ${bytes} bytes`)
 * })
 * ```
 */
export declare function hashStream(stream: ReadableStream<Uint8Array>, algorithm?: HashAlgorithm, options?: StreamingHashOptions): Promise<string>;
/**
 * Compute hash of an ArrayBuffer in chunks to reduce memory pressure.
 *
 * @param buffer - Input ArrayBuffer
 * @param algorithm - Hash algorithm to use
 * @param options - Streaming options
 * @returns Hex-encoded hash string
 */
export declare function hashBuffer(buffer: ArrayBuffer, algorithm?: HashAlgorithm, options?: StreamingHashOptions): Promise<string>;
/**
 * Validate a hash string format.
 *
 * @param hash - Hash string to validate
 * @param algorithm - Expected algorithm (for length validation)
 * @returns true if valid hex string of correct length
 */
export declare function isValidHash(hash: string, algorithm?: HashAlgorithm): boolean;
/**
 * Detect the likely algorithm from a hash string length.
 *
 * @param hash - Hash string
 * @returns Detected algorithm or undefined if unknown
 */
export declare function detectAlgorithm(hash: string): HashAlgorithm | undefined;
//# sourceMappingURL=hash.d.ts.map
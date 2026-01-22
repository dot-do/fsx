/**
 * Zlib compression utilities for Content-Addressable Storage
 *
 * Uses the zlib format (RFC 1950) which is:
 * - CMF byte (usually 0x78 for deflate with 32K window)
 * - FLG byte (determines compression level)
 * - Compressed data (deflate algorithm)
 * - ADLER-32 checksum (4 bytes)
 *
 * This format is compatible with git's object storage.
 */
/**
 * Compression level from 0-9
 * - 0: No compression (store only)
 * - 1: Best speed (fastest compression)
 * - 6: Default (balanced)
 * - 9: Best compression (smallest size)
 */
export type CompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
/**
 * Compression strategy options
 * - default: Normal data (most use cases)
 * - filtered: Data produced by a filter (or predictor)
 * - huffmanOnly: Force Huffman encoding only (no string matching)
 * - rle: Run-length encoding for PNG image data
 * - fixed: Use fixed Huffman codes (prevents dynamic trees)
 */
export type CompressionStrategy = 'default' | 'filtered' | 'huffmanOnly' | 'rle' | 'fixed';
/**
 * Compression options
 */
export interface CompressionOptions {
    /**
     * Compression level (0-9)
     * @default 6 (balanced)
     */
    level?: CompressionLevel;
    /**
     * Compression strategy
     * @default 'default'
     */
    strategy?: CompressionStrategy;
    /**
     * Memory level (1-9) - higher uses more memory but is faster
     * @default 8
     */
    memLevel?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}
/**
 * Compression result with metrics
 */
export interface CompressionResult {
    /** Compressed data */
    data: Uint8Array;
    /** Original size in bytes */
    originalSize: number;
    /** Compressed size in bytes */
    compressedSize: number;
    /** Compression ratio (compressed/original). Values > 1 mean data expanded */
    ratio: number;
    /** Whether data expanded (compressed is larger than original) */
    expanded: boolean;
}
/** Default compression options */
export declare const DEFAULT_COMPRESSION_OPTIONS: Required<CompressionOptions>;
/**
 * Compress data using zlib deflate format
 *
 * @param data - The data to compress
 * @param options - Compression options (level, strategy, memLevel)
 * @returns Compressed data in zlib format (header + deflate + adler32)
 */
export declare function compress(data: Uint8Array, options?: CompressionOptions): Promise<Uint8Array>;
/**
 * Compress data and return detailed metrics
 *
 * Useful for monitoring compression efficiency and detecting
 * data that doesn't compress well (already compressed, random, etc.)
 *
 * @param data - The data to compress
 * @param options - Compression options
 * @returns Compression result with metrics
 */
export declare function compressWithMetrics(data: Uint8Array, options?: CompressionOptions): Promise<CompressionResult>;
/**
 * Error codes for compression/decompression failures
 */
export type CompressionErrorCode = 'INVALID_LEVEL' | 'INVALID_MEM_LEVEL' | 'COMPRESSION_FAILED' | 'DECOMPRESSION_FAILED' | 'INVALID_ZLIB_HEADER' | 'INVALID_CHECKSUM' | 'TRUNCATED_DATA' | 'CORRUPTED_DATA';
/**
 * Custom error class for compression failures with error codes
 */
export declare class CompressionError extends Error {
    readonly code: CompressionErrorCode;
    constructor(message: string, code: CompressionErrorCode);
}
/**
 * Decompress zlib deflate format data
 *
 * @param data - The compressed data in zlib format
 * @returns Decompressed original data
 * @throws CompressionError if data is invalid, corrupted, or truncated
 */
export declare function decompress(data: Uint8Array): Promise<Uint8Array>;
/**
 * Check if data appears to be zlib-compressed
 *
 * Performs a quick header check without attempting full decompression.
 * Useful for detecting already-compressed data before compression.
 *
 * @param data - Data to check
 * @returns true if data appears to be valid zlib format
 */
export declare function isZlibCompressed(data: Uint8Array): boolean;
//# sourceMappingURL=compression.d.ts.map
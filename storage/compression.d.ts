/**
 * R2 Cold Storage Compression Module
 *
 * Provides optional compression for pages before writing to R2 cold storage.
 * This module supports multiple compression codecs and tracks compression metrics.
 *
 * Features:
 * - Multiple codecs: none, zstd, brotli, gzip
 * - Automatic skip for already-compressed MIME types
 * - Configurable minimum size threshold
 * - Compression metrics tracking
 *
 * @module storage/compression
 */
/**
 * Supported compression codecs.
 */
export type CompressionCodec = 'none' | 'zstd' | 'brotli' | 'gzip';
/**
 * Metadata for compressed page data.
 */
export interface CompressedPageMetadata {
    /** Compression codec used */
    codec: CompressionCodec;
    /** Original uncompressed size in bytes */
    originalSize: number;
    /** Compressed size in bytes */
    compressedSize: number;
    /** Compression ratio (originalSize / compressedSize) */
    compressionRatio: number;
}
/**
 * Configuration for compression behavior.
 */
export interface CompressionConfig {
    /** Enable compression (default: false) */
    enabled: boolean;
    /** Preferred codec (default: 'zstd') */
    codec: CompressionCodec;
    /** Minimum size to compress in bytes (default: 1024) - files smaller than this skip compression */
    minSize: number;
    /** MIME types to skip compression (already compressed) */
    skipMimeTypes: string[];
}
/**
 * Result of a compression operation.
 */
export interface CompressionResult {
    /** Compressed data (or original if compression skipped) */
    data: Uint8Array;
    /** Compression metadata */
    metadata: CompressedPageMetadata;
    /** Whether compression was actually applied */
    compressed: boolean;
}
/**
 * Compression statistics for monitoring/metrics.
 */
export interface CompressionStats {
    /** Total bytes before compression */
    totalOriginalBytes: number;
    /** Total bytes after compression */
    totalCompressedBytes: number;
    /** Number of pages compressed */
    pagesCompressed: number;
    /** Number of pages skipped (too small, already compressed, etc.) */
    pagesSkipped: number;
    /** Average compression ratio */
    averageRatio: number;
}
/**
 * R2 Cold Storage Compressor interface.
 */
export interface R2ColdStorageCompressor {
    /**
     * Compress data before writing to R2.
     * @param data - Data to compress
     * @param mimeType - Optional MIME type for skip detection
     */
    compress(data: Uint8Array, mimeType?: string): Promise<CompressionResult>;
    /**
     * Decompress data read from R2.
     * @param data - Compressed data
     * @param metadata - Compression metadata
     */
    decompress(data: Uint8Array, metadata: CompressedPageMetadata): Promise<Uint8Array>;
    /**
     * Get current compression statistics.
     */
    getStats(): CompressionStats;
    /**
     * Reset compression statistics.
     */
    resetStats(): void;
    /**
     * Get current configuration.
     */
    getConfig(): CompressionConfig;
    /**
     * Update configuration.
     */
    setConfig(config: Partial<CompressionConfig>): void;
}
/**
 * Default MIME types to skip compression (already compressed formats).
 */
declare const DEFAULT_SKIP_MIME_TYPES: string[];
/**
 * Create a new R2 cold storage compressor.
 *
 * @param config - Optional configuration overrides
 * @returns R2ColdStorageCompressor instance
 *
 * @example
 * ```typescript
 * // Create with compression disabled (default)
 * const compressor = createR2ColdStorageCompressor()
 *
 * // Create with compression enabled
 * const compressor = createR2ColdStorageCompressor({
 *   enabled: true,
 *   codec: 'gzip',
 *   minSize: 4096,
 * })
 *
 * // Compress data before R2 write
 * const result = await compressor.compress(data, 'text/plain')
 * await r2Bucket.put(key, result.data, {
 *   customMetadata: {
 *     codec: result.metadata.codec,
 *     originalSize: String(result.metadata.originalSize),
 *   }
 * })
 *
 * // Decompress data after R2 read
 * const stored = await r2Bucket.get(key)
 * const decompressed = await compressor.decompress(stored.data, metadata)
 * ```
 */
export declare function createR2ColdStorageCompressor(config?: Partial<CompressionConfig>): R2ColdStorageCompressor;
export { DEFAULT_SKIP_MIME_TYPES };
//# sourceMappingURL=compression.d.ts.map
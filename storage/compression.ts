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

// @ts-expect-error - pako types (@types/pako) not included in tsconfig.json 'types' array.
// The fsx package uses a restricted types array for Cloudflare Workers compatibility.
// Installing @types/pako or adding to types array would fix this, but is low priority.
import pako from 'pako'

// =============================================================================
// Types
// =============================================================================

/**
 * Supported compression codecs.
 */
export type CompressionCodec = 'none' | 'zstd' | 'brotli' | 'gzip'

/**
 * Metadata for compressed page data.
 */
export interface CompressedPageMetadata {
  /** Compression codec used */
  codec: CompressionCodec
  /** Original uncompressed size in bytes */
  originalSize: number
  /** Compressed size in bytes */
  compressedSize: number
  /** Compression ratio (originalSize / compressedSize) */
  compressionRatio: number
}

/**
 * Configuration for compression behavior.
 */
export interface CompressionConfig {
  /** Enable compression (default: false) */
  enabled: boolean
  /** Preferred codec (default: 'zstd') */
  codec: CompressionCodec
  /** Minimum size to compress in bytes (default: 1024) - files smaller than this skip compression */
  minSize: number
  /** MIME types to skip compression (already compressed) */
  skipMimeTypes: string[]
}

/**
 * Result of a compression operation.
 */
export interface CompressionResult {
  /** Compressed data (or original if compression skipped) */
  data: Uint8Array
  /** Compression metadata */
  metadata: CompressedPageMetadata
  /** Whether compression was actually applied */
  compressed: boolean
}

/**
 * Compression statistics for monitoring/metrics.
 */
export interface CompressionStats {
  /** Total bytes before compression */
  totalOriginalBytes: number
  /** Total bytes after compression */
  totalCompressedBytes: number
  /** Number of pages compressed */
  pagesCompressed: number
  /** Number of pages skipped (too small, already compressed, etc.) */
  pagesSkipped: number
  /** Average compression ratio */
  averageRatio: number
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
  compress(data: Uint8Array, mimeType?: string): Promise<CompressionResult>

  /**
   * Decompress data read from R2.
   * @param data - Compressed data
   * @param metadata - Compression metadata
   */
  decompress(data: Uint8Array, metadata: CompressedPageMetadata): Promise<Uint8Array>

  /**
   * Get current compression statistics.
   */
  getStats(): CompressionStats

  /**
   * Reset compression statistics.
   */
  resetStats(): void

  /**
   * Get current configuration.
   */
  getConfig(): CompressionConfig

  /**
   * Update configuration.
   */
  setConfig(config: Partial<CompressionConfig>): void
}

// =============================================================================
// Default Configuration
// =============================================================================

/**
 * Default MIME types to skip compression (already compressed formats).
 */
const DEFAULT_SKIP_MIME_TYPES = [
  // Images (typically already compressed)
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
  // Video (already compressed)
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  // Audio (already compressed)
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/webm',
  'audio/aac',
  'audio/flac',
  // Archives (already compressed)
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/x-bzip2',
  'application/x-xz',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/x-tar',
  'application/x-compress',
  // Other compressed formats
  'application/pdf', // PDFs often have internal compression
]

/**
 * Default compression configuration.
 */
const DEFAULT_CONFIG: CompressionConfig = {
  enabled: false,
  codec: 'zstd',
  minSize: 1024, // 1KB
  skipMimeTypes: [...DEFAULT_SKIP_MIME_TYPES],
}

// =============================================================================
// Codec Implementations
// =============================================================================

/**
 * Compress data using gzip via pako.
 */
async function compressGzip(data: Uint8Array): Promise<Uint8Array> {
  return pako.gzip(data, { level: 6 })
}

/**
 * Decompress gzip data via pako.
 */
async function decompressGzip(data: Uint8Array): Promise<Uint8Array> {
  return pako.ungzip(data)
}

/**
 * Compress data using zstd.
 * Note: Uses a simple implementation that falls back to gzip-like compression.
 * For production, consider using a WASM-based zstd library.
 */
async function compressZstd(data: Uint8Array): Promise<Uint8Array> {
  // ZSTD magic number: 0x28B52FFD
  const ZSTD_MAGIC = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd])

  // Use deflate for the actual compression (simulated zstd)
  const compressed = pako.deflate(data, { level: 9 })

  // Prepend ZSTD magic and original size (8 bytes for size)
  const sizeBytes = new Uint8Array(8)
  const view = new DataView(sizeBytes.buffer)
  view.setBigUint64(0, BigInt(data.length), true) // little-endian

  const result = new Uint8Array(ZSTD_MAGIC.length + sizeBytes.length + compressed.length)
  result.set(ZSTD_MAGIC, 0)
  result.set(sizeBytes, ZSTD_MAGIC.length)
  result.set(compressed, ZSTD_MAGIC.length + sizeBytes.length)

  return result
}

/**
 * Decompress zstd data.
 */
async function decompressZstd(data: Uint8Array): Promise<Uint8Array> {
  // Verify ZSTD magic number
  const ZSTD_MAGIC = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd])

  if (data.length < 12) {
    throw new Error('Invalid zstd data: too short')
  }

  for (let i = 0; i < 4; i++) {
    if (data[i] !== ZSTD_MAGIC[i]) {
      throw new Error('Invalid zstd data: bad magic number')
    }
  }

  // Extract original size
  const view = new DataView(data.buffer, data.byteOffset, data.length)
  const originalSize = Number(view.getBigUint64(4, true))

  // Decompress the deflate payload
  const compressed = data.slice(12)
  const decompressed = pako.inflate(compressed)

  // Verify size matches
  if (decompressed.length !== originalSize) {
    throw new Error(`Decompressed size mismatch: expected ${originalSize}, got ${decompressed.length}`)
  }

  return decompressed
}

/**
 * Compress data using brotli.
 * Note: Uses a simple implementation that falls back to deflate compression.
 * For production, consider using a WASM-based brotli library.
 */
async function compressBrotli(data: Uint8Array): Promise<Uint8Array> {
  // Brotli signature (custom, for our implementation)
  const BROTLI_MAGIC = new Uint8Array([0xce, 0xb2, 0xcf, 0x81]) // Custom magic

  // Use deflate for the actual compression (simulated brotli)
  const compressed = pako.deflate(data, { level: 9 })

  // Prepend magic and original size
  const sizeBytes = new Uint8Array(8)
  const view = new DataView(sizeBytes.buffer)
  view.setBigUint64(0, BigInt(data.length), true)

  const result = new Uint8Array(BROTLI_MAGIC.length + sizeBytes.length + compressed.length)
  result.set(BROTLI_MAGIC, 0)
  result.set(sizeBytes, BROTLI_MAGIC.length)
  result.set(compressed, BROTLI_MAGIC.length + sizeBytes.length)

  return result
}

/**
 * Decompress brotli data.
 */
async function decompressBrotli(data: Uint8Array): Promise<Uint8Array> {
  const BROTLI_MAGIC = new Uint8Array([0xce, 0xb2, 0xcf, 0x81])

  if (data.length < 12) {
    throw new Error('Invalid brotli data: too short')
  }

  for (let i = 0; i < 4; i++) {
    if (data[i] !== BROTLI_MAGIC[i]) {
      throw new Error('Invalid brotli data: bad magic number')
    }
  }

  const view = new DataView(data.buffer, data.byteOffset, data.length)
  const originalSize = Number(view.getBigUint64(4, true))

  const compressed = data.slice(12)
  const decompressed = pako.inflate(compressed)

  if (decompressed.length !== originalSize) {
    throw new Error(`Decompressed size mismatch: expected ${originalSize}, got ${decompressed.length}`)
  }

  return decompressed
}

// =============================================================================
// R2ColdStorageCompressor Implementation
// =============================================================================

/**
 * Implementation of R2ColdStorageCompressor.
 */
class R2ColdStorageCompressorImpl implements R2ColdStorageCompressor {
  private config: CompressionConfig
  private stats: {
    totalOriginalBytes: number
    totalCompressedBytes: number
    pagesCompressed: number
    pagesSkipped: number
    ratioSum: number
  }

  constructor(config?: Partial<CompressionConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      skipMimeTypes: config?.skipMimeTypes ?? [...DEFAULT_SKIP_MIME_TYPES],
    }
    this.stats = {
      totalOriginalBytes: 0,
      totalCompressedBytes: 0,
      pagesCompressed: 0,
      pagesSkipped: 0,
      ratioSum: 0,
    }
  }

  /**
   * Check if compression should be skipped for the given data and mime type.
   */
  private shouldSkipCompression(data: Uint8Array, mimeType?: string): boolean {
    // Skip if compression is disabled
    if (!this.config.enabled) {
      return true
    }

    // Skip if data is smaller than minSize
    if (data.length < this.config.minSize) {
      return true
    }

    // Skip if mime type is in skip list
    if (mimeType && this.config.skipMimeTypes.includes(mimeType)) {
      return true
    }

    return false
  }

  /**
   * Compress data using the configured codec.
   */
  private async compressWithCodec(data: Uint8Array): Promise<Uint8Array> {
    switch (this.config.codec) {
      case 'gzip':
        return compressGzip(data)
      case 'zstd':
        return compressZstd(data)
      case 'brotli':
        return compressBrotli(data)
      case 'none':
      default:
        return data
    }
  }

  /**
   * Decompress data using the specified codec.
   */
  private async decompressWithCodec(
    data: Uint8Array,
    codec: CompressionCodec
  ): Promise<Uint8Array> {
    switch (codec) {
      case 'gzip':
        return decompressGzip(data)
      case 'zstd':
        return decompressZstd(data)
      case 'brotli':
        return decompressBrotli(data)
      case 'none':
      default:
        return data
    }
  }

  async compress(data: Uint8Array, mimeType?: string): Promise<CompressionResult> {
    const originalSize = data.length

    // Check if we should skip compression
    if (this.shouldSkipCompression(data, mimeType)) {
      // Update stats for skipped
      this.stats.totalOriginalBytes += originalSize
      this.stats.totalCompressedBytes += originalSize
      this.stats.pagesSkipped++

      return {
        data,
        metadata: {
          codec: 'none',
          originalSize,
          compressedSize: originalSize,
          compressionRatio: 1,
        },
        compressed: false,
      }
    }

    // Perform compression
    const compressedData = await this.compressWithCodec(data)
    const compressedSize = compressedData.length

    // Check if compression actually helped
    // If compressed is larger or equal, return original
    if (compressedSize >= originalSize) {
      this.stats.totalOriginalBytes += originalSize
      this.stats.totalCompressedBytes += originalSize
      this.stats.pagesSkipped++

      return {
        data,
        metadata: {
          codec: 'none',
          originalSize,
          compressedSize: originalSize,
          compressionRatio: 1,
        },
        compressed: false,
      }
    }

    // Compression was beneficial
    const compressionRatio = originalSize / compressedSize

    // Update stats
    this.stats.totalOriginalBytes += originalSize
    this.stats.totalCompressedBytes += compressedSize
    this.stats.pagesCompressed++
    this.stats.ratioSum += compressionRatio

    return {
      data: compressedData,
      metadata: {
        codec: this.config.codec,
        originalSize,
        compressedSize,
        compressionRatio,
      },
      compressed: true,
    }
  }

  async decompress(
    data: Uint8Array,
    metadata: CompressedPageMetadata
  ): Promise<Uint8Array> {
    // Validate codec
    const validCodecs: CompressionCodec[] = ['none', 'zstd', 'brotli', 'gzip']
    if (!validCodecs.includes(metadata.codec)) {
      throw new Error(`Invalid compression codec: ${metadata.codec}`)
    }

    // Handle 'none' codec (no decompression needed)
    if (metadata.codec === 'none') {
      return data
    }

    // Check for empty data
    if (data.length === 0) {
      throw new Error('Cannot decompress empty data')
    }

    // Decompress
    const decompressed = await this.decompressWithCodec(data, metadata.codec)

    // Verify decompressed size matches expected
    if (decompressed.length !== metadata.originalSize) {
      throw new Error(
        `Decompressed size mismatch: expected ${metadata.originalSize}, got ${decompressed.length}`
      )
    }

    return decompressed
  }

  getStats(): CompressionStats {
    const averageRatio =
      this.stats.pagesCompressed > 0
        ? this.stats.ratioSum / this.stats.pagesCompressed
        : 0

    return {
      totalOriginalBytes: this.stats.totalOriginalBytes,
      totalCompressedBytes: this.stats.totalCompressedBytes,
      pagesCompressed: this.stats.pagesCompressed,
      pagesSkipped: this.stats.pagesSkipped,
      averageRatio,
    }
  }

  resetStats(): void {
    this.stats = {
      totalOriginalBytes: 0,
      totalCompressedBytes: 0,
      pagesCompressed: 0,
      pagesSkipped: 0,
      ratioSum: 0,
    }
  }

  getConfig(): CompressionConfig {
    return { ...this.config }
  }

  setConfig(config: Partial<CompressionConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

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
export function createR2ColdStorageCompressor(
  config?: Partial<CompressionConfig>
): R2ColdStorageCompressor {
  return new R2ColdStorageCompressorImpl(config)
}

// =============================================================================
// Re-exports for convenience
// =============================================================================

export { DEFAULT_SKIP_MIME_TYPES }

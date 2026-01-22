/**
 * Zstd Compressor - Tree-shakable compression module
 *
 * Zstd (Zstandard) provides excellent compression ratios with good speed.
 * This implementation uses pako's deflate as a fallback with a Zstd-compatible
 * framing format. For production use with true Zstd, consider using zstd-wasm.
 *
 * Import this module directly for tree-shaking benefits:
 * ```typescript
 * import { ZstdCompressor, createZstdCompressor } from '@dotdo/fsx/compression/zstd'
 * ```
 *
 * @module storage/compression/zstd
 */

// @ts-expect-error - pako types (@types/pako) not included in tsconfig.json 'types' array.
import pako from 'pako'

import {
  type Compressor,
  type CompressorWithMetrics,
  type CompressionMetrics,
  CompressionError,
} from './types.js'

/**
 * Zstd frame magic number (0x28B52FFD)
 */
const ZSTD_MAGIC = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Zstd compression level.
 * - 1-3: Fast mode
 * - 4-9: Normal mode (default: 3 for speed, 9 for ratio)
 * - 10-22: High compression mode
 */
export type ZstdLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/**
 * Zstd compressor options.
 */
export interface ZstdOptions {
  /**
   * Compression level (1-9 in this implementation).
   * Default: 3 (balanced)
   */
  level?: ZstdLevel
}

/**
 * Default Zstd options.
 */
export const DEFAULT_ZSTD_OPTIONS: Required<ZstdOptions> = {
  level: 3,
}

/**
 * Zstd compressor implementation.
 *
 * Uses a custom framing format compatible with Zstd frame format magic numbers.
 * The actual compression uses pako's deflate. For true Zstd performance,
 * use a WASM-based implementation like zstd-wasm.
 *
 * Frame format:
 * - 4 bytes: Zstd magic (0x28 0xb5 0x2f 0xfd)
 * - 8 bytes: Original size (little-endian uint64)
 * - N bytes: Compressed payload (deflate)
 */
export class ZstdCompressor implements CompressorWithMetrics {
  readonly name = 'zstd'
  private readonly level: ZstdLevel

  constructor(options?: ZstdOptions) {
    this.level = options?.level ?? DEFAULT_ZSTD_OPTIONS.level
  }

  async compress(data: Uint8Array): Promise<Uint8Array> {
    try {
      // Map zstd level to deflate level
      const compressed = pako.deflate(data, { level: this.level })

      // Build frame: magic + size + payload
      const sizeBytes = new Uint8Array(8)
      const view = new DataView(sizeBytes.buffer)
      view.setBigUint64(0, BigInt(data.length), true) // little-endian

      const result = new Uint8Array(ZSTD_MAGIC.length + sizeBytes.length + compressed.length)
      result.set(ZSTD_MAGIC, 0)
      result.set(sizeBytes, ZSTD_MAGIC.length)
      result.set(compressed, ZSTD_MAGIC.length + sizeBytes.length)

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      throw new CompressionError(
        `Zstd compression failed: ${message}`,
        'COMPRESSION_FAILED'
      )
    }
  }

  async decompress(data: Uint8Array): Promise<Uint8Array> {
    if (data.length === 0) {
      throw new CompressionError(
        'Cannot decompress empty data',
        'INVALID_DATA'
      )
    }

    // Minimum size: magic (4) + size (8) + some data
    if (data.length < 12) {
      throw new CompressionError(
        'Invalid Zstd data: too short',
        'INVALID_DATA'
      )
    }

    // Verify magic number
    for (let i = 0; i < 4; i++) {
      if (data[i] !== ZSTD_MAGIC[i]) {
        throw new CompressionError(
          'Invalid Zstd data: bad magic number',
          'INVALID_DATA'
        )
      }
    }

    try {
      // Extract original size
      const view = new DataView(data.buffer, data.byteOffset, data.length)
      const originalSize = Number(view.getBigUint64(4, true))

      // Extract and decompress payload
      const payload = data.slice(12)
      const decompressed = pako.inflate(payload)

      // Verify size matches
      if (decompressed.length !== originalSize) {
        throw new CompressionError(
          `Size mismatch: expected ${originalSize}, got ${decompressed.length}`,
          'SIZE_MISMATCH'
        )
      }

      return decompressed
    } catch (error) {
      if (error instanceof CompressionError) {
        throw error
      }
      const message = error instanceof Error ? error.message : 'Unknown error'
      throw new CompressionError(
        `Zstd decompression failed: ${message}`,
        'DECOMPRESSION_FAILED'
      )
    }
  }

  async compressWithMetrics(data: Uint8Array): Promise<CompressionMetrics> {
    const originalSize = data.length
    const compressed = await this.compress(data)
    const compressedSize = compressed.length
    const ratio = originalSize > 0 ? originalSize / compressedSize : 1

    return {
      data: compressed,
      originalSize,
      compressedSize,
      ratio,
      expanded: compressedSize >= originalSize,
      algorithm: this.name,
    }
  }
}

/**
 * Create a new Zstd compressor instance.
 *
 * @param options - Optional Zstd options
 * @returns Zstd compressor instance
 *
 * @example
 * ```typescript
 * import { createZstdCompressor } from '@dotdo/fsx/compression/zstd'
 *
 * const compressor = createZstdCompressor({ level: 9 })
 * const compressed = await compressor.compress(data)
 * const decompressed = await compressor.decompress(compressed)
 * ```
 */
export function createZstdCompressor(options?: ZstdOptions): CompressorWithMetrics {
  return new ZstdCompressor(options)
}

/**
 * Check if data appears to be Zstd-compressed.
 *
 * @param data - Data to check
 * @returns true if data has Zstd magic number
 */
export function isZstdCompressed(data: Uint8Array): boolean {
  if (data.length < 4) return false
  for (let i = 0; i < 4; i++) {
    if (data[i] !== ZSTD_MAGIC[i]) return false
  }
  return true
}

// Re-export types for convenience
export type { Compressor, CompressorWithMetrics, CompressionMetrics } from './types.js'

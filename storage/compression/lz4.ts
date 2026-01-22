/**
 * LZ4 Compressor - Tree-shakable compression module
 *
 * LZ4 is optimized for speed over compression ratio.
 * This implementation uses pako's deflate as a fallback with an LZ4-compatible
 * framing format. For production use with true LZ4, consider using lz4-wasm.
 *
 * Import this module directly for tree-shaking benefits:
 * ```typescript
 * import { Lz4Compressor, createLz4Compressor } from '@dotdo/fsx/compression/lz4'
 * ```
 *
 * @module storage/compression/lz4
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
 * LZ4 frame magic number (0x184D2204)
 */
const LZ4_MAGIC = new Uint8Array([0x04, 0x22, 0x4d, 0x18])

/**
 * LZ4 compressor options.
 */
export interface Lz4Options {
  /**
   * Fast compression mode (lower ratio, faster speed).
   * Default: true
   */
  fast?: boolean
}

/**
 * Default LZ4 options.
 */
export const DEFAULT_LZ4_OPTIONS: Required<Lz4Options> = {
  fast: true,
}

/**
 * LZ4 compressor implementation.
 *
 * Uses a custom framing format compatible with LZ4 frame format magic numbers.
 * The actual compression uses pako's deflate at level 1 (fastest) to simulate
 * LZ4's speed-optimized behavior.
 *
 * Frame format:
 * - 4 bytes: LZ4 magic (0x04 0x22 0x4d 0x18)
 * - 8 bytes: Original size (little-endian uint64)
 * - N bytes: Compressed payload (deflate)
 */
export class Lz4Compressor implements CompressorWithMetrics {
  readonly name = 'lz4'
  private readonly fast: boolean

  constructor(options?: Lz4Options) {
    this.fast = options?.fast ?? DEFAULT_LZ4_OPTIONS.fast
  }

  async compress(data: Uint8Array): Promise<Uint8Array> {
    try {
      // Use fastest deflate level to simulate LZ4's speed characteristics
      const level = this.fast ? 1 : 3
      const compressed = pako.deflate(data, { level })

      // Build frame: magic + size + payload
      const sizeBytes = new Uint8Array(8)
      const view = new DataView(sizeBytes.buffer)
      view.setBigUint64(0, BigInt(data.length), true) // little-endian

      const result = new Uint8Array(LZ4_MAGIC.length + sizeBytes.length + compressed.length)
      result.set(LZ4_MAGIC, 0)
      result.set(sizeBytes, LZ4_MAGIC.length)
      result.set(compressed, LZ4_MAGIC.length + sizeBytes.length)

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      throw new CompressionError(
        `LZ4 compression failed: ${message}`,
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
        'Invalid LZ4 data: too short',
        'INVALID_DATA'
      )
    }

    // Verify magic number
    for (let i = 0; i < 4; i++) {
      if (data[i] !== LZ4_MAGIC[i]) {
        throw new CompressionError(
          'Invalid LZ4 data: bad magic number',
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
        `LZ4 decompression failed: ${message}`,
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
 * Create a new LZ4 compressor instance.
 *
 * @param options - Optional LZ4 options
 * @returns LZ4 compressor instance
 *
 * @example
 * ```typescript
 * import { createLz4Compressor } from '@dotdo/fsx/compression/lz4'
 *
 * const compressor = createLz4Compressor({ fast: true })
 * const compressed = await compressor.compress(data)
 * const decompressed = await compressor.decompress(compressed)
 * ```
 */
export function createLz4Compressor(options?: Lz4Options): CompressorWithMetrics {
  return new Lz4Compressor(options)
}

/**
 * Check if data appears to be LZ4-compressed.
 *
 * @param data - Data to check
 * @returns true if data has LZ4 magic number
 */
export function isLz4Compressed(data: Uint8Array): boolean {
  if (data.length < 4) return false
  for (let i = 0; i < 4; i++) {
    if (data[i] !== LZ4_MAGIC[i]) return false
  }
  return true
}

// Re-export types for convenience
export type { Compressor, CompressorWithMetrics, CompressionMetrics } from './types.js'

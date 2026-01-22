/**
 * Gzip Compressor - Tree-shakable compression module
 *
 * Uses pako for gzip compression. This is a lightweight, well-tested
 * implementation that works in all JavaScript environments.
 *
 * Import this module directly for tree-shaking benefits:
 * ```typescript
 * import { GzipCompressor, createGzipCompressor } from '@dotdo/fsx/compression/gzip'
 * ```
 *
 * @module storage/compression/gzip
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
 * Gzip compression level (0-9)
 * - 0: No compression (store only)
 * - 1: Best speed (fastest)
 * - 6: Default (balanced)
 * - 9: Best compression (smallest)
 */
export type GzipLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/**
 * Gzip compressor options.
 */
export interface GzipOptions {
  /** Compression level (0-9), default: 6 */
  level?: GzipLevel
}

/**
 * Default gzip options.
 */
export const DEFAULT_GZIP_OPTIONS: Required<GzipOptions> = {
  level: 6,
}

/**
 * Gzip compressor implementation.
 *
 * Uses pako for gzip compression, which is compatible with
 * all JavaScript environments including Cloudflare Workers.
 */
export class GzipCompressor implements CompressorWithMetrics {
  readonly name = 'gzip'
  private readonly level: GzipLevel

  constructor(options?: GzipOptions) {
    this.level = options?.level ?? DEFAULT_GZIP_OPTIONS.level
  }

  async compress(data: Uint8Array): Promise<Uint8Array> {
    try {
      return pako.gzip(data, { level: this.level })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      throw new CompressionError(
        `Gzip compression failed: ${message}`,
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

    // Verify gzip magic number (0x1f 0x8b)
    if (data.length < 2 || data[0] !== 0x1f || data[1] !== 0x8b) {
      throw new CompressionError(
        'Invalid gzip data: missing magic number (0x1f 0x8b)',
        'INVALID_DATA'
      )
    }

    try {
      return pako.ungzip(data)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      throw new CompressionError(
        `Gzip decompression failed: ${message}`,
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
 * Create a new gzip compressor instance.
 *
 * @param options - Optional gzip options
 * @returns Gzip compressor instance
 *
 * @example
 * ```typescript
 * import { createGzipCompressor } from '@dotdo/fsx/compression/gzip'
 *
 * const compressor = createGzipCompressor({ level: 9 })
 * const compressed = await compressor.compress(data)
 * const decompressed = await compressor.decompress(compressed)
 * ```
 */
export function createGzipCompressor(options?: GzipOptions): CompressorWithMetrics {
  return new GzipCompressor(options)
}

/**
 * Check if data appears to be gzip-compressed.
 *
 * @param data - Data to check
 * @returns true if data has gzip magic number
 */
export function isGzipCompressed(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b
}

// Re-export types for convenience
export type { Compressor, CompressorWithMetrics, CompressionMetrics } from './types.js'

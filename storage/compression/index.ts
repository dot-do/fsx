/**
 * Tree-shakable Compression Module
 *
 * This module provides a unified interface for compression with automatic
 * algorithm detection and selection. Import specific compressors directly
 * for tree-shaking benefits:
 *
 * ```typescript
 * // Full bundle - includes all compressors
 * import { createCompressor, detectCompressor } from '@dotdo/fsx/compression'
 *
 * // Tree-shakable - only gzip
 * import { createGzipCompressor } from '@dotdo/fsx/compression/gzip'
 *
 * // Tree-shakable - only lz4
 * import { createLz4Compressor } from '@dotdo/fsx/compression/lz4'
 *
 * // Tree-shakable - only zstd
 * import { createZstdCompressor } from '@dotdo/fsx/compression/zstd'
 * ```
 *
 * @module storage/compression
 */

// Re-export types
export {
  type Compressor,
  type CompressorWithMetrics,
  type CompressionMetrics,
  type CompressionConfig,
  type CompressionErrorCode,
  CompressionError,
} from './types.js'

// Re-export individual compressors
export {
  GzipCompressor,
  createGzipCompressor,
  isGzipCompressed,
  type GzipLevel,
  type GzipOptions,
  DEFAULT_GZIP_OPTIONS,
} from './gzip.js'

export {
  Lz4Compressor,
  createLz4Compressor,
  isLz4Compressed,
  type Lz4Options,
  DEFAULT_LZ4_OPTIONS,
} from './lz4.js'

export {
  ZstdCompressor,
  createZstdCompressor,
  isZstdCompressed,
  type ZstdLevel,
  type ZstdOptions,
  DEFAULT_ZSTD_OPTIONS,
} from './zstd.js'

import type { Compressor, CompressorWithMetrics } from './types.js'
import { CompressionError } from './types.js'
import { createGzipCompressor, isGzipCompressed } from './gzip.js'
import { createLz4Compressor, isLz4Compressed } from './lz4.js'
import { createZstdCompressor, isZstdCompressed } from './zstd.js'

/**
 * Supported compression algorithm names.
 */
export type CompressionAlgorithm = 'gzip' | 'lz4' | 'zstd'

/**
 * Options for creating a compressor by algorithm name.
 */
export interface CreateCompressorOptions {
  /** Compression algorithm */
  algorithm: CompressionAlgorithm
  /** Algorithm-specific options */
  options?: Record<string, unknown>
}

/**
 * Create a compressor by algorithm name.
 *
 * This function imports all compressors. For tree-shaking, import
 * individual compressors directly from their modules.
 *
 * @param options - Algorithm and options
 * @returns Compressor instance
 *
 * @example
 * ```typescript
 * // Auto-select compressor by name (not tree-shakable)
 * const compressor = createCompressor({ algorithm: 'gzip' })
 *
 * // For tree-shaking, import directly:
 * import { createGzipCompressor } from '@dotdo/fsx/compression/gzip'
 * const compressor = createGzipCompressor()
 * ```
 */
export function createCompressor(options: CreateCompressorOptions): CompressorWithMetrics {
  switch (options.algorithm) {
    case 'gzip':
      return createGzipCompressor(options.options as Parameters<typeof createGzipCompressor>[0])
    case 'lz4':
      return createLz4Compressor(options.options as Parameters<typeof createLz4Compressor>[0])
    case 'zstd':
      return createZstdCompressor(options.options as Parameters<typeof createZstdCompressor>[0])
    default:
      throw new CompressionError(
        `Unsupported compression algorithm: ${options.algorithm}`,
        'UNSUPPORTED_ALGORITHM'
      )
  }
}

/**
 * Detection result from analyzing compressed data.
 */
export interface DetectionResult {
  /** Detected algorithm, or null if unknown */
  algorithm: CompressionAlgorithm | null
  /** Confidence level (1.0 = certain, 0.0 = unknown) */
  confidence: number
  /** Compressor instance for detected algorithm */
  compressor: Compressor | null
}

/**
 * Detect compression algorithm from data magic numbers.
 *
 * Analyzes the data header to determine which compression algorithm
 * was used, then returns a compressor instance for decompression.
 *
 * @param data - Compressed data to analyze
 * @returns Detection result with algorithm and compressor
 *
 * @example
 * ```typescript
 * const result = detectCompressor(compressedData)
 * if (result.compressor) {
 *   const decompressed = await result.compressor.decompress(compressedData)
 * }
 * ```
 */
export function detectCompressor(data: Uint8Array): DetectionResult {
  // Check gzip (0x1f 0x8b)
  if (isGzipCompressed(data)) {
    return {
      algorithm: 'gzip',
      confidence: 1.0,
      compressor: createGzipCompressor(),
    }
  }

  // Check zstd (0x28 0xb5 0x2f 0xfd)
  if (isZstdCompressed(data)) {
    return {
      algorithm: 'zstd',
      confidence: 1.0,
      compressor: createZstdCompressor(),
    }
  }

  // Check lz4 (0x04 0x22 0x4d 0x18)
  if (isLz4Compressed(data)) {
    return {
      algorithm: 'lz4',
      confidence: 1.0,
      compressor: createLz4Compressor(),
    }
  }

  // Unknown compression
  return {
    algorithm: null,
    confidence: 0.0,
    compressor: null,
  }
}

/**
 * Auto-decompress data by detecting the compression algorithm.
 *
 * Analyzes the data header to determine the compression algorithm,
 * then decompresses using the appropriate compressor.
 *
 * @param data - Compressed data
 * @returns Decompressed data
 * @throws CompressionError if algorithm cannot be detected
 *
 * @example
 * ```typescript
 * // Decompress without knowing the algorithm
 * const decompressed = await autoDecompress(compressedData)
 * ```
 */
export async function autoDecompress(data: Uint8Array): Promise<Uint8Array> {
  const result = detectCompressor(data)

  if (!result.compressor) {
    throw new CompressionError(
      'Unable to detect compression algorithm from data header',
      'UNSUPPORTED_ALGORITHM'
    )
  }

  return result.compressor.decompress(data)
}

/**
 * Get the best compressor for a given use case.
 *
 * @param preference - Preference for speed vs ratio
 * @returns Recommended compressor
 *
 * @example
 * ```typescript
 * // Get fastest compressor
 * const fast = getBestCompressor('speed')
 *
 * // Get best ratio compressor
 * const best = getBestCompressor('ratio')
 * ```
 */
export function getBestCompressor(
  preference: 'speed' | 'ratio' | 'balanced' = 'balanced'
): CompressorWithMetrics {
  switch (preference) {
    case 'speed':
      // LZ4 is optimized for speed
      return createLz4Compressor({ fast: true })
    case 'ratio':
      // Zstd with high level for best ratio
      return createZstdCompressor({ level: 9 })
    case 'balanced':
    default:
      // Gzip level 6 is a good balance
      return createGzipCompressor({ level: 6 })
  }
}

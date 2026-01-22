/**
 * Tree-shakable Compression Module Types
 *
 * This module defines the core interface for compression implementations.
 * Import specific compressors (lz4, zstd, gzip) for tree-shaking benefits.
 *
 * @module storage/compression/types
 */

/**
 * Core Compressor interface.
 *
 * All compression implementations must implement this interface.
 * Each compressor is a separate entry point for tree-shaking.
 */
export interface Compressor {
  /**
   * Compress data.
   * @param data - Data to compress
   * @returns Compressed data
   */
  compress(data: Uint8Array): Promise<Uint8Array>

  /**
   * Decompress data.
   * @param data - Compressed data
   * @returns Decompressed data
   */
  decompress(data: Uint8Array): Promise<Uint8Array>

  /**
   * Name of the compression algorithm.
   * Used for identification and debugging.
   */
  readonly name: string
}

/**
 * Extended compressor interface with additional metadata.
 */
export interface CompressorWithMetrics extends Compressor {
  /**
   * Compress data and return detailed metrics.
   * @param data - Data to compress
   * @returns Compression result with metrics
   */
  compressWithMetrics(data: Uint8Array): Promise<CompressionMetrics>
}

/**
 * Compression metrics returned from compressWithMetrics.
 */
export interface CompressionMetrics {
  /** Compressed data */
  data: Uint8Array
  /** Original size in bytes */
  originalSize: number
  /** Compressed size in bytes */
  compressedSize: number
  /** Compression ratio (originalSize / compressedSize). Values > 1 mean good compression */
  ratio: number
  /** Whether data expanded (compressed is larger than original) */
  expanded: boolean
  /** Compression algorithm name */
  algorithm: string
}

/**
 * Configuration for automatic compressor selection.
 */
export interface CompressionConfig {
  /** Preferred algorithm order for auto-detection */
  preferredAlgorithms?: string[]
  /** Minimum data size to attempt compression (bytes) */
  minSize?: number
  /** Whether to fall back to no compression if preferred is unavailable */
  allowFallback?: boolean
}

/**
 * Factory function type for creating compressors.
 */
export type CompressorFactory = () => Compressor

/**
 * Registry entry for a compressor.
 */
export interface CompressorRegistryEntry {
  /** Factory function to create the compressor */
  factory: CompressorFactory
  /** Algorithm identifier */
  name: string
  /** Priority for auto-selection (higher = preferred) */
  priority: number
}

/**
 * Error codes for compression operations.
 */
export type CompressionErrorCode =
  | 'COMPRESSION_FAILED'
  | 'DECOMPRESSION_FAILED'
  | 'INVALID_DATA'
  | 'UNSUPPORTED_ALGORITHM'
  | 'DATA_CORRUPTED'
  | 'SIZE_MISMATCH'

/**
 * Custom error class for compression failures.
 */
export class CompressionError extends Error {
  readonly code: CompressionErrorCode

  constructor(message: string, code: CompressionErrorCode) {
    super(message)
    this.name = 'CompressionError'
    this.code = code
  }
}

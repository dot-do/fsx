/**
 * Compression Tests - Optional Compression for R2 Cold Storage
 *
 * RED phase TDD tests for optional compression of pages before writing to R2.
 * These tests define the expected behavior for:
 *
 * 1. Compression disabled by default (no compression overhead)
 * 2. Enable compression via config
 * 3. Compressed page smaller than original
 * 4. Decompression on read from R2
 * 5. Compression codec metadata stored with page
 * 6. Invalid/corrupted compressed data handled gracefully
 * 7. Compression ratio tracking/metrics
 * 8. Skip compression for already-compressed data (images, etc.)
 *
 * Issue: fsx-tgho - [RED] Optional compression for R2 cold storage
 *
 * @module storage/compression.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createR2ColdStorageCompressor,
  type CompressionCodec,
  type CompressedPageMetadata,
  type CompressionConfig,
  type CompressionResult,
  type CompressionStats,
  type R2ColdStorageCompressor,
} from './compression.js'

// =============================================================================
// Mock Implementations for Testing
// =============================================================================

/**
 * Mock R2 Bucket for testing compression behavior.
 */
class MockR2Bucket {
  private objects = new Map<string, { data: Uint8Array; metadata?: Record<string, string> }>()

  async put(key: string, data: Uint8Array, options?: { customMetadata?: Record<string, string> }): Promise<void> {
    this.objects.set(key, {
      data,
      metadata: options?.customMetadata,
    })
  }

  async get(key: string): Promise<{ data: Uint8Array; customMetadata?: Record<string, string> } | null> {
    const obj = this.objects.get(key)
    if (!obj) return null
    return {
      data: obj.data,
      customMetadata: obj.metadata,
    }
  }

  async delete(key: string): Promise<boolean> {
    return this.objects.delete(key)
  }

  // Test helpers
  getStoredSize(key: string): number | undefined {
    return this.objects.get(key)?.data.length
  }

  getMetadata(key: string): Record<string, string> | undefined {
    return this.objects.get(key)?.metadata
  }

  clear(): void {
    this.objects.clear()
  }

  has(key: string): boolean {
    return this.objects.has(key)
  }
}


// =============================================================================
// Test Data Helpers
// =============================================================================

/**
 * Create compressible data (repetitive pattern compresses well).
 */
function createCompressibleData(size: number): Uint8Array {
  const data = new Uint8Array(size)
  const pattern = 'Hello, World! This is compressible data. '
  const patternBytes = new TextEncoder().encode(pattern)
  for (let i = 0; i < size; i++) {
    data[i] = patternBytes[i % patternBytes.length]
  }
  return data
}

/**
 * Create incompressible data (random bytes).
 */
function createIncompressibleData(size: number): Uint8Array {
  const data = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    data[i] = Math.floor(Math.random() * 256)
  }
  return data
}

/**
 * Create mock PNG header (magic bytes).
 */
function createMockPngData(size: number): Uint8Array {
  const data = new Uint8Array(size)
  // PNG magic bytes
  data[0] = 0x89
  data[1] = 0x50 // P
  data[2] = 0x4e // N
  data[3] = 0x47 // G
  data[4] = 0x0d
  data[5] = 0x0a
  data[6] = 0x1a
  data[7] = 0x0a
  // Fill rest with random data
  for (let i = 8; i < size; i++) {
    data[i] = Math.floor(Math.random() * 256)
  }
  return data
}

/**
 * Create mock JPEG header (magic bytes).
 */
function createMockJpegData(size: number): Uint8Array {
  const data = new Uint8Array(size)
  // JPEG magic bytes (SOI marker)
  data[0] = 0xff
  data[1] = 0xd8
  data[2] = 0xff
  data[3] = 0xe0 // JFIF marker
  // Fill rest with random data
  for (let i = 4; i < size; i++) {
    data[i] = Math.floor(Math.random() * 256)
  }
  return data
}

/**
 * Create corrupted compressed data.
 */
function createCorruptedCompressedData(): Uint8Array {
  // Start with gzip magic bytes but corrupt the rest
  return new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff, 0xff, 0xff, 0x00, 0x03])
}

// =============================================================================
// Tests
// =============================================================================

describe('R2ColdStorageCompressor', () => {
  let compressor: R2ColdStorageCompressor
  let r2Bucket: MockR2Bucket

  beforeEach(() => {
    r2Bucket = new MockR2Bucket()
  })

  describe('compression disabled by default', () => {
    it('should have compression disabled by default', () => {
      compressor = createR2ColdStorageCompressor()
      const config = compressor.getConfig()

      expect(config.enabled).toBe(false)
    })

    it('should not compress data when disabled', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: false })
      const originalData = createCompressibleData(10 * 1024) // 10KB

      const result = await compressor.compress(originalData)

      expect(result.compressed).toBe(false)
      expect(result.data).toEqual(originalData)
      expect(result.metadata.codec).toBe('none')
      expect(result.metadata.originalSize).toBe(originalData.length)
      expect(result.metadata.compressedSize).toBe(originalData.length)
      expect(result.metadata.compressionRatio).toBe(1)
    })

    it('should have no compression overhead when disabled', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: false })
      const originalData = createCompressibleData(100 * 1024) // 100KB

      const startTime = performance.now()
      await compressor.compress(originalData)
      const duration = performance.now() - startTime

      // Should be nearly instant (no compression work)
      expect(duration).toBeLessThan(10) // 10ms threshold
    })
  })

  describe('enable compression via config', () => {
    it('should enable compression via constructor config', () => {
      compressor = createR2ColdStorageCompressor({ enabled: true })
      const config = compressor.getConfig()

      expect(config.enabled).toBe(true)
    })

    it('should enable compression via setConfig', () => {
      compressor = createR2ColdStorageCompressor({ enabled: false })
      compressor.setConfig({ enabled: true })
      const config = compressor.getConfig()

      expect(config.enabled).toBe(true)
    })

    it('should use zstd as default codec', () => {
      compressor = createR2ColdStorageCompressor({ enabled: true })
      const config = compressor.getConfig()

      expect(config.codec).toBe('zstd')
    })

    it('should allow configuring different codecs', () => {
      const codecs: CompressionCodec[] = ['zstd', 'brotli', 'gzip']

      for (const codec of codecs) {
        compressor = createR2ColdStorageCompressor({ enabled: true, codec })
        const config = compressor.getConfig()

        expect(config.codec).toBe(codec)
      }
    })

    it('should have sensible default minSize', () => {
      compressor = createR2ColdStorageCompressor({ enabled: true })
      const config = compressor.getConfig()

      expect(config.minSize).toBe(1024) // 1KB default
    })
  })

  describe('compressed page smaller than original', () => {
    it('should compress data smaller than original for compressible data', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })
      const originalData = createCompressibleData(100 * 1024) // 100KB of repetitive data

      const result = await compressor.compress(originalData)

      expect(result.compressed).toBe(true)
      expect(result.data.length).toBeLessThan(originalData.length)
      expect(result.metadata.compressedSize).toBeLessThan(result.metadata.originalSize)
      expect(result.metadata.compressionRatio).toBeGreaterThan(1)
    })

    it('should achieve good compression ratio with zstd', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'zstd' })
      const originalData = createCompressibleData(100 * 1024)

      const result = await compressor.compress(originalData)

      // Repetitive data should compress to at least 50% smaller
      expect(result.metadata.compressionRatio).toBeGreaterThan(2)
    })

    it('should achieve good compression ratio with brotli', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'brotli' })
      const originalData = createCompressibleData(100 * 1024)

      const result = await compressor.compress(originalData)

      // Repetitive data should compress to at least 50% smaller
      expect(result.metadata.compressionRatio).toBeGreaterThan(2)
    })

    it('should handle incompressible data gracefully', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })
      const originalData = createIncompressibleData(10 * 1024) // Random data

      const result = await compressor.compress(originalData)

      // Incompressible data might not compress (or might even expand slightly)
      // The compressor should still work correctly
      expect(result.metadata.originalSize).toBe(originalData.length)
      expect(result.data.length).toBeLessThanOrEqual(originalData.length * 1.1) // Allow 10% expansion
    })

    it('should skip compression if result would be larger', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })
      // Very small random data that won't compress well
      const originalData = createIncompressibleData(100)

      const result = await compressor.compress(originalData)

      // Should return original data if compression doesn't help
      if (!result.compressed) {
        expect(result.data).toEqual(originalData)
        expect(result.metadata.codec).toBe('none')
      }
    })
  })

  describe('decompression on read from R2', () => {
    it('should decompress gzip data correctly', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })
      const originalData = createCompressibleData(50 * 1024)

      const compressed = await compressor.compress(originalData)
      const decompressed = await compressor.decompress(compressed.data, compressed.metadata)

      expect(decompressed).toEqual(originalData)
    })

    it('should decompress zstd data correctly', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'zstd' })
      const originalData = createCompressibleData(50 * 1024)

      const compressed = await compressor.compress(originalData)
      const decompressed = await compressor.decompress(compressed.data, compressed.metadata)

      expect(decompressed).toEqual(originalData)
    })

    it('should decompress brotli data correctly', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'brotli' })
      const originalData = createCompressibleData(50 * 1024)

      const compressed = await compressor.compress(originalData)
      const decompressed = await compressor.decompress(compressed.data, compressed.metadata)

      expect(decompressed).toEqual(originalData)
    })

    it('should return original data for codec none', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: false })
      const originalData = createCompressibleData(10 * 1024)

      const result = await compressor.compress(originalData)
      const decompressed = await compressor.decompress(result.data, result.metadata)

      expect(decompressed).toEqual(originalData)
    })

    it('should preserve exact byte content through roundtrip', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'zstd' })
      // Create data with all possible byte values
      const originalData = new Uint8Array(256 * 100)
      for (let i = 0; i < originalData.length; i++) {
        originalData[i] = i % 256
      }

      const compressed = await compressor.compress(originalData)
      const decompressed = await compressor.decompress(compressed.data, compressed.metadata)

      expect(decompressed.length).toBe(originalData.length)
      expect(decompressed).toEqual(originalData)
    })

    it('should decompress data of varying sizes correctly', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })
      const sizes = [1024, 10 * 1024, 100 * 1024, 1024 * 1024] // 1KB, 10KB, 100KB, 1MB

      for (const size of sizes) {
        const originalData = createCompressibleData(size)
        const compressed = await compressor.compress(originalData)
        const decompressed = await compressor.decompress(compressed.data, compressed.metadata)

        expect(decompressed.length).toBe(size)
        expect(decompressed).toEqual(originalData)
      }
    })
  })

  describe('compression codec metadata stored with page', () => {
    it('should store codec in metadata', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'zstd' })
      const data = createCompressibleData(10 * 1024)

      const result = await compressor.compress(data)

      expect(result.metadata.codec).toBe('zstd')
    })

    it('should store original size in metadata', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })
      const data = createCompressibleData(50 * 1024)

      const result = await compressor.compress(data)

      expect(result.metadata.originalSize).toBe(50 * 1024)
    })

    it('should store compressed size in metadata', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })
      const data = createCompressibleData(50 * 1024)

      const result = await compressor.compress(data)

      expect(result.metadata.compressedSize).toBe(result.data.length)
    })

    it('should calculate compression ratio correctly', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })
      const data = createCompressibleData(50 * 1024)

      const result = await compressor.compress(data)

      const expectedRatio = result.metadata.originalSize / result.metadata.compressedSize
      expect(result.metadata.compressionRatio).toBeCloseTo(expectedRatio, 2)
    })

    it('should return ratio of 1 when compression disabled', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: false })
      const data = createCompressibleData(10 * 1024)

      const result = await compressor.compress(data)

      expect(result.metadata.compressionRatio).toBe(1)
    })

    it('should metadata be serializable to JSON', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'zstd' })
      const data = createCompressibleData(10 * 1024)

      const result = await compressor.compress(data)
      const serialized = JSON.stringify(result.metadata)
      const deserialized = JSON.parse(serialized) as CompressedPageMetadata

      expect(deserialized.codec).toBe(result.metadata.codec)
      expect(deserialized.originalSize).toBe(result.metadata.originalSize)
      expect(deserialized.compressedSize).toBe(result.metadata.compressedSize)
      expect(deserialized.compressionRatio).toBe(result.metadata.compressionRatio)
    })
  })

  describe('invalid/corrupted compressed data handled gracefully', () => {
    it('should throw descriptive error for corrupted gzip data', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })
      const corruptedData = createCorruptedCompressedData()
      const metadata: CompressedPageMetadata = {
        codec: 'gzip',
        originalSize: 1000,
        compressedSize: corruptedData.length,
        compressionRatio: 100,
      }

      await expect(compressor.decompress(corruptedData, metadata)).rejects.toThrow()
    })

    it('should throw for invalid codec in metadata', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true })
      const data = new Uint8Array(100)
      const metadata = {
        codec: 'invalid-codec' as CompressionCodec,
        originalSize: 100,
        compressedSize: 100,
        compressionRatio: 1,
      }

      await expect(compressor.decompress(data, metadata)).rejects.toThrow()
    })

    it('should throw for truncated compressed data', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })
      const originalData = createCompressibleData(10 * 1024)

      const compressed = await compressor.compress(originalData)
      // Truncate the compressed data
      const truncated = compressed.data.slice(0, compressed.data.length / 2)

      await expect(
        compressor.decompress(truncated, compressed.metadata)
      ).rejects.toThrow()
    })

    it('should throw for empty compressed data', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })
      const emptyData = new Uint8Array(0)
      const metadata: CompressedPageMetadata = {
        codec: 'gzip',
        originalSize: 1000,
        compressedSize: 0,
        compressionRatio: Infinity,
      }

      await expect(compressor.decompress(emptyData, metadata)).rejects.toThrow()
    })

    it('should throw when decompressed size does not match originalSize', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })
      const originalData = createCompressibleData(10 * 1024)

      const compressed = await compressor.compress(originalData)
      // Corrupt the metadata with wrong original size
      const wrongMetadata: CompressedPageMetadata = {
        ...compressed.metadata,
        originalSize: 5000, // Wrong size
      }

      await expect(
        compressor.decompress(compressed.data, wrongMetadata)
      ).rejects.toThrow()
    })
  })

  describe('compression ratio tracking/metrics', () => {
    it('should track total original bytes', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })

      await compressor.compress(createCompressibleData(10 * 1024))
      await compressor.compress(createCompressibleData(20 * 1024))

      const stats = compressor.getStats()
      expect(stats.totalOriginalBytes).toBe(30 * 1024)
    })

    it('should track total compressed bytes', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })
      const data1 = createCompressibleData(10 * 1024)
      const data2 = createCompressibleData(20 * 1024)

      const result1 = await compressor.compress(data1)
      const result2 = await compressor.compress(data2)

      const stats = compressor.getStats()
      expect(stats.totalCompressedBytes).toBe(
        result1.metadata.compressedSize + result2.metadata.compressedSize
      )
    })

    it('should track pages compressed count', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })

      await compressor.compress(createCompressibleData(10 * 1024))
      await compressor.compress(createCompressibleData(20 * 1024))
      await compressor.compress(createCompressibleData(30 * 1024))

      const stats = compressor.getStats()
      expect(stats.pagesCompressed).toBe(3)
    })

    it('should track pages skipped count', async () => {
      compressor = createR2ColdStorageCompressor({
        enabled: true,
        codec: 'gzip',
        minSize: 5 * 1024, // 5KB minimum
      })

      await compressor.compress(createCompressibleData(1024)) // Too small, skipped
      await compressor.compress(createCompressibleData(2048)) // Too small, skipped
      await compressor.compress(createCompressibleData(10 * 1024)) // Compressed

      const stats = compressor.getStats()
      expect(stats.pagesSkipped).toBe(2)
      expect(stats.pagesCompressed).toBe(1)
    })

    it('should calculate average compression ratio', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })

      const result1 = await compressor.compress(createCompressibleData(10 * 1024))
      const result2 = await compressor.compress(createCompressibleData(20 * 1024))

      const stats = compressor.getStats()
      const expectedAvg =
        (result1.metadata.compressionRatio + result2.metadata.compressionRatio) / 2
      expect(stats.averageRatio).toBeCloseTo(expectedAvg, 1)
    })

    it('should reset stats correctly', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })

      await compressor.compress(createCompressibleData(10 * 1024))
      await compressor.compress(createCompressibleData(20 * 1024))

      compressor.resetStats()
      const stats = compressor.getStats()

      expect(stats.totalOriginalBytes).toBe(0)
      expect(stats.totalCompressedBytes).toBe(0)
      expect(stats.pagesCompressed).toBe(0)
      expect(stats.pagesSkipped).toBe(0)
      expect(stats.averageRatio).toBe(0)
    })

    it('should not count disabled compression in stats', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: false })

      await compressor.compress(createCompressibleData(10 * 1024))

      const stats = compressor.getStats()
      expect(stats.pagesCompressed).toBe(0)
      expect(stats.pagesSkipped).toBe(1)
    })
  })

  describe('skip compression for already-compressed data', () => {
    it('should skip compression for PNG images', async () => {
      compressor = createR2ColdStorageCompressor({
        enabled: true,
        codec: 'gzip',
        skipMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
      })
      const pngData = createMockPngData(10 * 1024)

      const result = await compressor.compress(pngData, 'image/png')

      expect(result.compressed).toBe(false)
      expect(result.data).toEqual(pngData)
      expect(result.metadata.codec).toBe('none')
    })

    it('should skip compression for JPEG images', async () => {
      compressor = createR2ColdStorageCompressor({
        enabled: true,
        codec: 'gzip',
        skipMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
      })
      const jpegData = createMockJpegData(10 * 1024)

      const result = await compressor.compress(jpegData, 'image/jpeg')

      expect(result.compressed).toBe(false)
      expect(result.data).toEqual(jpegData)
    })

    it('should skip compression for video files', async () => {
      compressor = createR2ColdStorageCompressor({
        enabled: true,
        codec: 'gzip',
        skipMimeTypes: ['video/mp4', 'video/webm'],
      })
      const videoData = new Uint8Array(100 * 1024)

      const result = await compressor.compress(videoData, 'video/mp4')

      expect(result.compressed).toBe(false)
    })

    it('should skip compression for data smaller than minSize', async () => {
      compressor = createR2ColdStorageCompressor({
        enabled: true,
        codec: 'gzip',
        minSize: 10 * 1024, // 10KB minimum
      })
      const smallData = createCompressibleData(5 * 1024) // 5KB

      const result = await compressor.compress(smallData)

      expect(result.compressed).toBe(false)
      expect(result.data).toEqual(smallData)
    })

    it('should compress data at exactly minSize', async () => {
      compressor = createR2ColdStorageCompressor({
        enabled: true,
        codec: 'gzip',
        minSize: 10 * 1024,
      })
      const exactData = createCompressibleData(10 * 1024)

      const result = await compressor.compress(exactData)

      expect(result.compressed).toBe(true)
    })

    it('should have default skip mime types for common compressed formats', () => {
      compressor = createR2ColdStorageCompressor({ enabled: true })
      const config = compressor.getConfig()

      // Common compressed formats should be skipped by default
      expect(config.skipMimeTypes).toContain('image/png')
      expect(config.skipMimeTypes).toContain('image/jpeg')
      expect(config.skipMimeTypes).toContain('image/gif')
      expect(config.skipMimeTypes).toContain('image/webp')
      expect(config.skipMimeTypes).toContain('video/mp4')
      expect(config.skipMimeTypes).toContain('video/webm')
      expect(config.skipMimeTypes).toContain('application/zip')
      expect(config.skipMimeTypes).toContain('application/gzip')
    })

    it('should compress non-skipped mime types', async () => {
      compressor = createR2ColdStorageCompressor({
        enabled: true,
        codec: 'gzip',
        skipMimeTypes: ['image/png'],
      })
      const textData = createCompressibleData(50 * 1024)

      const result = await compressor.compress(textData, 'text/plain')

      expect(result.compressed).toBe(true)
    })

    it('should handle undefined mime type by compressing', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })
      const data = createCompressibleData(50 * 1024)

      const result = await compressor.compress(data, undefined)

      expect(result.compressed).toBe(true)
    })
  })

  describe('integration with R2 storage', () => {
    it('should compress data before storing to R2', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })
      const originalData = createCompressibleData(100 * 1024)

      const result = await compressor.compress(originalData)
      await r2Bucket.put('test-page', result.data, {
        customMetadata: {
          codec: result.metadata.codec,
          originalSize: String(result.metadata.originalSize),
          compressedSize: String(result.metadata.compressedSize),
        },
      })

      // Verify stored size is compressed
      const storedSize = r2Bucket.getStoredSize('test-page')
      expect(storedSize).toBeLessThan(originalData.length)
    })

    it('should decompress data after reading from R2', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: true, codec: 'gzip' })
      const originalData = createCompressibleData(50 * 1024)

      // Store compressed
      const compressed = await compressor.compress(originalData)
      await r2Bucket.put('test-page', compressed.data, {
        customMetadata: {
          codec: compressed.metadata.codec,
          originalSize: String(compressed.metadata.originalSize),
          compressedSize: String(compressed.metadata.compressedSize),
          compressionRatio: String(compressed.metadata.compressionRatio),
        },
      })

      // Read and decompress
      const stored = await r2Bucket.get('test-page')
      expect(stored).not.toBeNull()

      const metadata: CompressedPageMetadata = {
        codec: stored!.customMetadata!.codec as CompressionCodec,
        originalSize: parseInt(stored!.customMetadata!.originalSize, 10),
        compressedSize: parseInt(stored!.customMetadata!.compressedSize, 10),
        compressionRatio: parseFloat(stored!.customMetadata!.compressionRatio),
      }

      const decompressed = await compressor.decompress(stored!.data, metadata)
      expect(decompressed).toEqual(originalData)
    })

    it('should handle uncompressed pages from R2', async () => {
      compressor = createR2ColdStorageCompressor({ enabled: false })
      const originalData = createCompressibleData(10 * 1024)

      // Store uncompressed
      const result = await compressor.compress(originalData)
      await r2Bucket.put('test-page', result.data, {
        customMetadata: {
          codec: 'none',
          originalSize: String(result.metadata.originalSize),
          compressedSize: String(result.metadata.compressedSize),
        },
      })

      // Read back
      const stored = await r2Bucket.get('test-page')
      const metadata: CompressedPageMetadata = {
        codec: 'none',
        originalSize: parseInt(stored!.customMetadata!.originalSize, 10),
        compressedSize: parseInt(stored!.customMetadata!.compressedSize, 10),
        compressionRatio: 1,
      }

      const decompressed = await compressor.decompress(stored!.data, metadata)
      expect(decompressed).toEqual(originalData)
    })
  })
})

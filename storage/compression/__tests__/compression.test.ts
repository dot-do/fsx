/**
 * Tree-shakable Compression Module Tests
 *
 * Tests for the compression module including:
 * - Individual compressors (gzip, lz4, zstd)
 * - Auto-detection
 * - Error handling
 * - Round-trip compression/decompression
 */

import { describe, it, expect, beforeEach } from 'vitest'

// Import from index (full bundle)
import {
  createCompressor,
  detectCompressor,
  autoDecompress,
  getBestCompressor,
  CompressionError,
  type CompressionAlgorithm,
} from '../index.js'

// Import individual compressors (tree-shakable)
import {
  GzipCompressor,
  createGzipCompressor,
  isGzipCompressed,
} from '../gzip.js'

import {
  Lz4Compressor,
  createLz4Compressor,
  isLz4Compressed,
} from '../lz4.js'

import {
  ZstdCompressor,
  createZstdCompressor,
  isZstdCompressed,
} from '../zstd.js'

// Test data
const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()

function createTestData(size: number): Uint8Array {
  // Create compressible data (repeated pattern)
  const pattern = 'Hello, World! This is test data for compression. '
  const repeated = pattern.repeat(Math.ceil(size / pattern.length))
  return TEXT_ENCODER.encode(repeated.slice(0, size))
}

function createRandomData(size: number): Uint8Array {
  const data = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    data[i] = Math.floor(Math.random() * 256)
  }
  return data
}

describe('GzipCompressor', () => {
  let compressor: GzipCompressor

  beforeEach(() => {
    compressor = new GzipCompressor()
  })

  it('should have correct name', () => {
    expect(compressor.name).toBe('gzip')
  })

  it('should compress and decompress data', async () => {
    const original = createTestData(1000)
    const compressed = await compressor.compress(original)
    const decompressed = await compressor.decompress(compressed)

    expect(decompressed).toEqual(original)
  })

  it('should create valid gzip format', async () => {
    const original = createTestData(100)
    const compressed = await compressor.compress(original)

    // Check gzip magic number
    expect(compressed[0]).toBe(0x1f)
    expect(compressed[1]).toBe(0x8b)
  })

  it('should detect gzip data correctly', async () => {
    const original = createTestData(100)
    const compressed = await compressor.compress(original)

    expect(isGzipCompressed(compressed)).toBe(true)
    expect(isGzipCompressed(original)).toBe(false)
  })

  it('should compress data smaller than original', async () => {
    const original = createTestData(10000)
    const compressed = await compressor.compress(original)

    expect(compressed.length).toBeLessThan(original.length)
  })

  it('should support different compression levels', async () => {
    const original = createTestData(5000)

    const fast = createGzipCompressor({ level: 1 })
    const best = createGzipCompressor({ level: 9 })

    const fastCompressed = await fast.compress(original)
    const bestCompressed = await best.compress(original)

    // Best compression should be smaller or equal
    expect(bestCompressed.length).toBeLessThanOrEqual(fastCompressed.length)

    // Both should decompress correctly
    expect(await fast.decompress(fastCompressed)).toEqual(original)
    expect(await best.decompress(bestCompressed)).toEqual(original)
  })

  it('should return metrics with compressWithMetrics', async () => {
    const original = createTestData(1000)
    const result = await compressor.compressWithMetrics(original)

    expect(result.originalSize).toBe(original.length)
    expect(result.compressedSize).toBe(result.data.length)
    expect(result.ratio).toBeGreaterThan(1) // Good compression
    expect(result.expanded).toBe(false)
    expect(result.algorithm).toBe('gzip')
  })

  it('should throw on invalid data', async () => {
    const invalidData = new Uint8Array([0x00, 0x01, 0x02])

    await expect(compressor.decompress(invalidData)).rejects.toThrow(CompressionError)
  })

  it('should throw on empty data', async () => {
    await expect(compressor.decompress(new Uint8Array(0))).rejects.toThrow(CompressionError)
  })
})

describe('Lz4Compressor', () => {
  let compressor: Lz4Compressor

  beforeEach(() => {
    compressor = new Lz4Compressor()
  })

  it('should have correct name', () => {
    expect(compressor.name).toBe('lz4')
  })

  it('should compress and decompress data', async () => {
    const original = createTestData(1000)
    const compressed = await compressor.compress(original)
    const decompressed = await compressor.decompress(compressed)

    expect(decompressed).toEqual(original)
  })

  it('should create valid lz4 format with magic number', async () => {
    const original = createTestData(100)
    const compressed = await compressor.compress(original)

    // Check LZ4 magic number (0x04 0x22 0x4d 0x18)
    expect(compressed[0]).toBe(0x04)
    expect(compressed[1]).toBe(0x22)
    expect(compressed[2]).toBe(0x4d)
    expect(compressed[3]).toBe(0x18)
  })

  it('should detect lz4 data correctly', async () => {
    const original = createTestData(100)
    const compressed = await compressor.compress(original)

    expect(isLz4Compressed(compressed)).toBe(true)
    expect(isLz4Compressed(original)).toBe(false)
  })

  it('should support fast mode option', async () => {
    const original = createTestData(5000)

    const fast = createLz4Compressor({ fast: true })
    const slow = createLz4Compressor({ fast: false })

    const fastCompressed = await fast.compress(original)
    const slowCompressed = await slow.compress(original)

    // Both should decompress correctly
    expect(await fast.decompress(fastCompressed)).toEqual(original)
    expect(await slow.decompress(slowCompressed)).toEqual(original)
  })

  it('should throw on invalid data', async () => {
    const invalidData = new Uint8Array([0x00, 0x01, 0x02, 0x03])

    await expect(compressor.decompress(invalidData)).rejects.toThrow(CompressionError)
  })

  it('should throw on data too short', async () => {
    const shortData = new Uint8Array([0x04, 0x22, 0x4d, 0x18]) // Just magic, no size

    await expect(compressor.decompress(shortData)).rejects.toThrow(CompressionError)
  })
})

describe('ZstdCompressor', () => {
  let compressor: ZstdCompressor

  beforeEach(() => {
    compressor = new ZstdCompressor()
  })

  it('should have correct name', () => {
    expect(compressor.name).toBe('zstd')
  })

  it('should compress and decompress data', async () => {
    const original = createTestData(1000)
    const compressed = await compressor.compress(original)
    const decompressed = await compressor.decompress(compressed)

    expect(decompressed).toEqual(original)
  })

  it('should create valid zstd format with magic number', async () => {
    const original = createTestData(100)
    const compressed = await compressor.compress(original)

    // Check Zstd magic number (0x28 0xb5 0x2f 0xfd)
    expect(compressed[0]).toBe(0x28)
    expect(compressed[1]).toBe(0xb5)
    expect(compressed[2]).toBe(0x2f)
    expect(compressed[3]).toBe(0xfd)
  })

  it('should detect zstd data correctly', async () => {
    const original = createTestData(100)
    const compressed = await compressor.compress(original)

    expect(isZstdCompressed(compressed)).toBe(true)
    expect(isZstdCompressed(original)).toBe(false)
  })

  it('should support different compression levels', async () => {
    const original = createTestData(5000)

    const fast = createZstdCompressor({ level: 1 })
    const best = createZstdCompressor({ level: 9 })

    const fastCompressed = await fast.compress(original)
    const bestCompressed = await best.compress(original)

    // Best compression should be smaller or equal
    expect(bestCompressed.length).toBeLessThanOrEqual(fastCompressed.length)

    // Both should decompress correctly
    expect(await fast.decompress(fastCompressed)).toEqual(original)
    expect(await best.decompress(bestCompressed)).toEqual(original)
  })

  it('should throw on invalid data', async () => {
    const invalidData = new Uint8Array([0x00, 0x01, 0x02, 0x03])

    await expect(compressor.decompress(invalidData)).rejects.toThrow(CompressionError)
  })
})

describe('createCompressor', () => {
  const algorithms: CompressionAlgorithm[] = ['gzip', 'lz4', 'zstd']

  for (const algorithm of algorithms) {
    it(`should create ${algorithm} compressor`, () => {
      const compressor = createCompressor({ algorithm })
      expect(compressor.name).toBe(algorithm)
    })

    it(`should round-trip with ${algorithm}`, async () => {
      const compressor = createCompressor({ algorithm })
      const original = createTestData(500)

      const compressed = await compressor.compress(original)
      const decompressed = await compressor.decompress(compressed)

      expect(decompressed).toEqual(original)
    })
  }

  it('should throw on unsupported algorithm', () => {
    expect(() => createCompressor({ algorithm: 'invalid' as CompressionAlgorithm }))
      .toThrow(CompressionError)
  })
})

describe('detectCompressor', () => {
  it('should detect gzip compressed data', async () => {
    const compressor = createGzipCompressor()
    const original = createTestData(100)
    const compressed = await compressor.compress(original)

    const result = detectCompressor(compressed)

    expect(result.algorithm).toBe('gzip')
    expect(result.confidence).toBe(1.0)
    expect(result.compressor).not.toBeNull()
    expect(result.compressor?.name).toBe('gzip')
  })

  it('should detect lz4 compressed data', async () => {
    const compressor = createLz4Compressor()
    const original = createTestData(100)
    const compressed = await compressor.compress(original)

    const result = detectCompressor(compressed)

    expect(result.algorithm).toBe('lz4')
    expect(result.confidence).toBe(1.0)
    expect(result.compressor).not.toBeNull()
    expect(result.compressor?.name).toBe('lz4')
  })

  it('should detect zstd compressed data', async () => {
    const compressor = createZstdCompressor()
    const original = createTestData(100)
    const compressed = await compressor.compress(original)

    const result = detectCompressor(compressed)

    expect(result.algorithm).toBe('zstd')
    expect(result.confidence).toBe(1.0)
    expect(result.compressor).not.toBeNull()
    expect(result.compressor?.name).toBe('zstd')
  })

  it('should return null for uncompressed data', () => {
    const data = createTestData(100)
    const result = detectCompressor(data)

    expect(result.algorithm).toBeNull()
    expect(result.confidence).toBe(0.0)
    expect(result.compressor).toBeNull()
  })
})

describe('autoDecompress', () => {
  const algorithms: CompressionAlgorithm[] = ['gzip', 'lz4', 'zstd']

  for (const algorithm of algorithms) {
    it(`should auto-decompress ${algorithm} data`, async () => {
      const compressor = createCompressor({ algorithm })
      const original = createTestData(500)
      const compressed = await compressor.compress(original)

      const decompressed = await autoDecompress(compressed)

      expect(decompressed).toEqual(original)
    })
  }

  it('should throw on unrecognized data', async () => {
    const data = createTestData(100)

    await expect(autoDecompress(data)).rejects.toThrow(CompressionError)
  })
})

describe('getBestCompressor', () => {
  it('should return lz4 for speed preference', () => {
    const compressor = getBestCompressor('speed')
    expect(compressor.name).toBe('lz4')
  })

  it('should return zstd for ratio preference', () => {
    const compressor = getBestCompressor('ratio')
    expect(compressor.name).toBe('zstd')
  })

  it('should return gzip for balanced preference', () => {
    const compressor = getBestCompressor('balanced')
    expect(compressor.name).toBe('gzip')
  })

  it('should default to balanced', () => {
    const compressor = getBestCompressor()
    expect(compressor.name).toBe('gzip')
  })
})

describe('Edge cases', () => {
  it('should handle empty string compression', async () => {
    const compressor = createGzipCompressor()
    const original = new Uint8Array(0)

    // Empty data should still compress/decompress
    const compressed = await compressor.compress(original)
    const decompressed = await compressor.decompress(compressed)

    expect(decompressed.length).toBe(0)
  })

  it('should handle single byte', async () => {
    const compressor = createGzipCompressor()
    const original = new Uint8Array([42])

    const compressed = await compressor.compress(original)
    const decompressed = await compressor.decompress(compressed)

    expect(decompressed).toEqual(original)
  })

  it('should handle binary data', async () => {
    const compressor = createZstdCompressor()
    const original = createRandomData(1000)

    const compressed = await compressor.compress(original)
    const decompressed = await compressor.decompress(compressed)

    expect(decompressed).toEqual(original)
  })

  it('should handle large data', async () => {
    const compressor = createLz4Compressor()
    const original = createTestData(1024 * 1024) // 1MB

    const compressed = await compressor.compress(original)
    const decompressed = await compressor.decompress(compressed)

    expect(decompressed).toEqual(original)
  })
})

describe('CompressionError', () => {
  it('should have correct error properties', () => {
    const error = new CompressionError('Test error', 'COMPRESSION_FAILED')

    expect(error.name).toBe('CompressionError')
    expect(error.message).toBe('Test error')
    expect(error.code).toBe('COMPRESSION_FAILED')
    expect(error instanceof Error).toBe(true)
  })
})

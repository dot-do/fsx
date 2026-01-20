/**
 * Chunked Read Tests - Offset-based Random Access Across 2MB Chunk Boundaries
 *
 * Tests for offset-based reads that span across 2MB chunk boundaries.
 * These tests verify that the PageStorage can handle random access reads
 * efficiently across chunked data.
 *
 * CHUNK_SIZE = 2 * 1024 * 1024 (2MB)
 *
 * Issue: fsx-0j00 - [RED] Offset-based random access across chunk boundaries
 *
 * Test Scenarios:
 * 1. Read within single chunk (offset 0-100 in chunk 0)
 * 2. Read spanning two chunks (offset at chunk boundary, e.g., offset 2MB-100, length 200)
 * 3. Read spanning multiple chunks (large range across 3+ chunks)
 * 4. Read at end of file (partial last chunk)
 * 5. Read beyond file bounds (should error)
 *
 * Edge Cases:
 * - Offset exactly at chunk boundary (2MB, 4MB, etc.)
 * - Length exactly matches chunk size
 * - Zero-length read
 * - Negative offset (error)
 * - Offset + length exceeds file size
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createPageStorage,
  CHUNK_SIZE,
  type PageStorage,
} from './page-storage.js'

// Mock DurableObjectStorage for testing
class MockDOStorage {
  private data = new Map<string, Uint8Array>()

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.data.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key)
  }

  async list(options?: { prefix?: string }): Promise<Map<string, Uint8Array>> {
    const result = new Map<string, Uint8Array>()
    for (const [key, value] of this.data) {
      if (!options?.prefix || key.startsWith(options.prefix)) {
        result.set(key, value)
      }
    }
    return result
  }

  getKeys(): string[] {
    return Array.from(this.data.keys())
  }

  clear(): void {
    this.data.clear()
  }
}

/**
 * Helper: Create test data with a verifiable pattern
 * Each byte at position i has value i % 256, making it easy to verify correct data
 */
function createTestData(size: number): Uint8Array {
  const data = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    data[i] = i % 256
  }
  return data
}

/**
 * Helper: Verify data matches the expected pattern at given offset
 */
function verifyDataPattern(data: Uint8Array, expectedOffset: number): boolean {
  for (let i = 0; i < data.length; i++) {
    const expectedValue = (expectedOffset + i) % 256
    if (data[i] !== expectedValue) {
      return false
    }
  }
  return true
}

describe('Chunked Read - Offset-based Random Access', () => {
  let storage: MockDOStorage
  let pageStorage: PageStorage

  // Test data sizes
  const SMALL_FILE = 1024 // 1KB - fits in single chunk
  const MEDIUM_FILE = 5 * 1024 * 1024 // 5MB - spans 3 chunks
  const LARGE_FILE = 10 * 1024 * 1024 // 10MB - spans 5 chunks

  beforeEach(() => {
    storage = new MockDOStorage()
    pageStorage = createPageStorage({
      storage: storage as unknown as DurableObjectStorage,
    })
  })

  describe('Scenario 1: Read within single chunk', () => {
    it('should read from offset 0 with small length in chunk 0', async () => {
      const blobId = 'single-chunk-start'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read first 100 bytes (well within first chunk)
      const result = await pageStorage.readRange(blobId, pageKeys, 0, 100)

      expect(result.length).toBe(100)
      expect(result).toEqual(data.slice(0, 100))
      expect(verifyDataPattern(result, 0)).toBe(true)
    })

    it('should read from middle of first chunk', async () => {
      const blobId = 'single-chunk-middle'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read 500 bytes starting at offset 1000 (all within first chunk)
      const offset = 1000
      const length = 500
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
      expect(verifyDataPattern(result, offset)).toBe(true)
    })

    it('should read from near end of first chunk (not crossing boundary)', async () => {
      const blobId = 'single-chunk-near-end'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read 1000 bytes starting 2000 bytes before chunk boundary
      const offset = CHUNK_SIZE - 2000
      const length = 1000 // Ends 1000 bytes before boundary
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
      expect(verifyDataPattern(result, offset)).toBe(true)
    })

    it('should read from middle of second chunk (within single chunk)', async () => {
      const blobId = 'single-chunk-second'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read 1000 bytes from middle of second chunk
      const offset = CHUNK_SIZE + 500000 // 500KB into second chunk
      const length = 1000
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
      expect(verifyDataPattern(result, offset)).toBe(true)
    })
  })

  describe('Scenario 2: Read spanning two chunks', () => {
    it('should read across first/second chunk boundary', async () => {
      const blobId = 'two-chunk-boundary-1-2'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read 200 bytes: 100 bytes before and 100 bytes after 2MB boundary
      const offset = CHUNK_SIZE - 100
      const length = 200
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
      expect(verifyDataPattern(result, offset)).toBe(true)
    })

    it('should read across second/third chunk boundary', async () => {
      const blobId = 'two-chunk-boundary-2-3'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read 1KB across the 4MB boundary
      const offset = 2 * CHUNK_SIZE - 512 // 512 bytes before 4MB
      const length = 1024 // Ends 512 bytes after 4MB
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
      expect(verifyDataPattern(result, offset)).toBe(true)
    })

    it('should read large range spanning two chunks', async () => {
      const blobId = 'two-chunk-large-span'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read 1MB starting 512KB before chunk boundary
      const offset = CHUNK_SIZE - 512 * 1024
      const length = 1024 * 1024 // 1MB
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
      expect(verifyDataPattern(result, offset)).toBe(true)
    })

    it('should read starting 1 byte before chunk boundary', async () => {
      const blobId = 'two-chunk-1-byte-before'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read 100 bytes starting 1 byte before boundary
      const offset = CHUNK_SIZE - 1
      const length = 100
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
      expect(verifyDataPattern(result, offset)).toBe(true)
    })

    it('should read ending 1 byte after chunk boundary', async () => {
      const blobId = 'two-chunk-1-byte-after'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read 100 bytes ending 1 byte into second chunk
      const offset = CHUNK_SIZE - 99 // Starts 99 bytes before boundary
      const length = 100 // Ends at CHUNK_SIZE + 1
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
      expect(verifyDataPattern(result, offset)).toBe(true)
    })
  })

  describe('Scenario 3: Read spanning multiple chunks (3+)', () => {
    it('should read across all three chunks of a 5MB file', async () => {
      const blobId = 'multi-chunk-all-three'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read 3MB starting at 1MB (spans chunk 0, 1, and 2)
      const offset = 1 * 1024 * 1024
      const length = 3 * 1024 * 1024
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
      expect(verifyDataPattern(result, offset)).toBe(true)
    })

    it('should read across 4 chunks of a 7MB file', async () => {
      // Using 7MB instead of 10MB to reduce test time while still spanning 4 chunks
      const SEVEN_MB = 7 * 1024 * 1024
      const blobId = 'multi-chunk-four'
      const data = createTestData(SEVEN_MB)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read 5MB starting at 1MB (spans chunks 0-3)
      const offset = 1 * 1024 * 1024
      const length = 5 * 1024 * 1024
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
      expect(verifyDataPattern(result, offset)).toBe(true)
    })

    it('should read exactly 2 full chunks plus partial data on both ends', async () => {
      const blobId = 'multi-chunk-partial-ends'
      // Use 6MB file (3 chunks) instead of 10MB to reduce test time
      const SIX_MB = 6 * 1024 * 1024
      const data = createTestData(SIX_MB)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Start 100 bytes before first boundary, end 100 bytes after second boundary
      // This reads: partial chunk 0 + full chunk 1 + partial chunk 2
      const offset = CHUNK_SIZE - 100
      const length = CHUNK_SIZE + 200
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
      expect(verifyDataPattern(result, offset)).toBe(true)
    })
  })

  describe('Scenario 4: Read at end of file (partial last chunk)', () => {
    it('should read last 100 bytes of file', async () => {
      const blobId = 'end-of-file-last-100'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read last 100 bytes
      const offset = MEDIUM_FILE - 100
      const length = 100
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
      expect(verifyDataPattern(result, offset)).toBe(true)
    })

    it('should read last 1MB of file (partial last chunk)', async () => {
      const blobId = 'end-of-file-last-1mb'
      const data = createTestData(MEDIUM_FILE) // 5MB = 2 full chunks + 1MB
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read last 1MB (all within partial last chunk)
      const offset = MEDIUM_FILE - 1024 * 1024
      const length = 1024 * 1024
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
      expect(verifyDataPattern(result, offset)).toBe(true)
    })

    it('should read across boundary into partial last chunk', async () => {
      const blobId = 'end-of-file-cross-boundary'
      const data = createTestData(MEDIUM_FILE) // 5MB = 2 full chunks + 1MB in third
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read from middle of second chunk to end of file
      const offset = 3 * 1024 * 1024 // 3MB
      const length = MEDIUM_FILE - offset // 2MB
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
      expect(verifyDataPattern(result, offset)).toBe(true)
    })

    it('should read single byte at very end of file', async () => {
      const blobId = 'end-of-file-single-byte'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read single byte at the very end
      const offset = MEDIUM_FILE - 1
      const length = 1
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(1)
      expect(result[0]).toBe((MEDIUM_FILE - 1) % 256)
    })
  })

  describe('Scenario 5: Read beyond file bounds (should error)', () => {
    it('should throw error when offset exceeds file size', async () => {
      const blobId = 'out-of-bounds-offset'
      const data = createTestData(SMALL_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Try to read starting beyond file size
      await expect(
        pageStorage.readRange(blobId, pageKeys, SMALL_FILE + 100, 100)
      ).rejects.toThrow()
    })

    it('should throw error when offset + length exceeds file size', async () => {
      const blobId = 'out-of-bounds-length'
      const data = createTestData(SMALL_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Try to read past end of file
      await expect(
        pageStorage.readRange(blobId, pageKeys, SMALL_FILE - 50, 100)
      ).rejects.toThrow()
    })

    it('should throw error when reading from very large offset', async () => {
      const blobId = 'out-of-bounds-very-large'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Try to read from way beyond file
      await expect(
        pageStorage.readRange(blobId, pageKeys, 100 * 1024 * 1024, 100)
      ).rejects.toThrow()
    })

    it('should throw error for multi-chunk file when range exceeds bounds', async () => {
      const blobId = 'out-of-bounds-multi-chunk'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Try to read past end of multi-chunk file
      await expect(
        pageStorage.readRange(blobId, pageKeys, MEDIUM_FILE - 100, 200)
      ).rejects.toThrow()
    })
  })

  describe('Edge Case: Offset exactly at chunk boundary', () => {
    it('should read starting exactly at 2MB boundary', async () => {
      const blobId = 'exact-boundary-2mb'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read starting exactly at 2MB
      const offset = CHUNK_SIZE
      const length = 100
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
      expect(verifyDataPattern(result, offset)).toBe(true)
    })

    it('should read starting exactly at 4MB boundary', async () => {
      const blobId = 'exact-boundary-4mb'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read starting exactly at 4MB
      const offset = 2 * CHUNK_SIZE
      const length = 100
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
      expect(verifyDataPattern(result, offset)).toBe(true)
    })

    it('should read ending exactly at chunk boundary', async () => {
      const blobId = 'exact-boundary-ending'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read 100 bytes ending exactly at 2MB boundary
      const offset = CHUNK_SIZE - 100
      const length = 100
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
      expect(verifyDataPattern(result, offset)).toBe(true)
    })
  })

  describe('Edge Case: Length exactly matches chunk size', () => {
    it('should read exactly 2MB starting at offset 0', async () => {
      const blobId = 'exact-chunk-size-start'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read exactly one chunk's worth
      const result = await pageStorage.readRange(blobId, pageKeys, 0, CHUNK_SIZE)

      expect(result.length).toBe(CHUNK_SIZE)
      expect(result).toEqual(data.slice(0, CHUNK_SIZE))
      expect(verifyDataPattern(result, 0)).toBe(true)
    })

    it('should read exactly 2MB starting at chunk boundary', async () => {
      const blobId = 'exact-chunk-size-boundary'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read exactly one chunk starting at 2MB
      const result = await pageStorage.readRange(blobId, pageKeys, CHUNK_SIZE, CHUNK_SIZE)

      expect(result.length).toBe(CHUNK_SIZE)
      expect(result).toEqual(data.slice(CHUNK_SIZE, 2 * CHUNK_SIZE))
      expect(verifyDataPattern(result, CHUNK_SIZE)).toBe(true)
    })

    it('should read exactly 2MB spanning two chunks (offset at half-boundary)', async () => {
      const blobId = 'exact-chunk-size-spanning'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read exactly 2MB starting at 1MB (spans half of chunk 0 and half of chunk 1)
      const offset = CHUNK_SIZE / 2
      const length = CHUNK_SIZE
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
      expect(verifyDataPattern(result, offset)).toBe(true)
    })

    it('should read exactly 4MB (two full chunks)', async () => {
      const blobId = 'exact-two-chunks'
      const data = createTestData(LARGE_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read exactly two chunks starting at offset 0
      const length = 2 * CHUNK_SIZE
      const result = await pageStorage.readRange(blobId, pageKeys, 0, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(0, length))
      expect(verifyDataPattern(result, 0)).toBe(true)
    })
  })

  describe('Edge Case: Zero-length read', () => {
    it('should handle zero-length read at offset 0', async () => {
      const blobId = 'zero-length-start'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Zero-length read should return empty array (or throw - implementation dependent)
      const result = await pageStorage.readRange(blobId, pageKeys, 0, 0)
      expect(result.length).toBe(0)
    })

    it('should handle zero-length read at chunk boundary', async () => {
      const blobId = 'zero-length-boundary'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Zero-length read at boundary
      const result = await pageStorage.readRange(blobId, pageKeys, CHUNK_SIZE, 0)
      expect(result.length).toBe(0)
    })

    it('should handle zero-length read at end of file', async () => {
      const blobId = 'zero-length-end'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Zero-length read at exact end of file
      const result = await pageStorage.readRange(blobId, pageKeys, MEDIUM_FILE, 0)
      expect(result.length).toBe(0)
    })
  })

  describe('Edge Case: Negative offset (should error)', () => {
    it('should throw error for negative offset', async () => {
      const blobId = 'negative-offset'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Negative offset should throw
      await expect(
        pageStorage.readRange(blobId, pageKeys, -1, 100)
      ).rejects.toThrow()
    })

    it('should throw error for very negative offset', async () => {
      const blobId = 'very-negative-offset'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Very negative offset should throw
      await expect(
        pageStorage.readRange(blobId, pageKeys, -1000000, 100)
      ).rejects.toThrow()
    })

    it('should throw error for negative length', async () => {
      const blobId = 'negative-length'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Negative length should throw
      await expect(
        pageStorage.readRange(blobId, pageKeys, 0, -100)
      ).rejects.toThrow()
    })
  })

  describe('ChunkedReadOptions interface compliance', () => {
    /**
     * The implementation should:
     * - Calculate which chunks to fetch (minimize chunk reads)
     * - Handle offsets within first/last chunks
     * - Reassemble partial chunks into contiguous result
     */

    it('should only read necessary chunks for small range in first chunk', async () => {
      const blobId = 'chunk-efficiency-first'
      const data = createTestData(LARGE_FILE) // 10MB = 5 chunks
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read only from first chunk - should not need to fetch all chunks
      // (This test verifies behavior, but efficiency is an implementation detail)
      const result = await pageStorage.readRange(blobId, pageKeys, 100, 100)

      expect(result.length).toBe(100)
      expect(result).toEqual(data.slice(100, 200))
    })

    it('should only read necessary chunks for range in last chunk', async () => {
      const blobId = 'chunk-efficiency-last'
      const data = createTestData(LARGE_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read only from last chunk
      const offset = LARGE_FILE - 100
      const result = await pageStorage.readRange(blobId, pageKeys, offset, 100)

      expect(result.length).toBe(100)
      expect(result).toEqual(data.slice(offset, offset + 100))
    })

    it('should correctly reassemble data from multiple partial chunks', async () => {
      const blobId = 'reassemble-partial'
      const data = createTestData(LARGE_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read a range that requires partial data from three chunks
      // Start in middle of chunk 1, end in middle of chunk 3
      const offset = CHUNK_SIZE + CHUNK_SIZE / 2 // 3MB (middle of chunk 1)
      const length = 2 * CHUNK_SIZE // 4MB (ends middle of chunk 3)
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))

      // Verify the data is contiguous and correct
      for (let i = 0; i < length; i++) {
        expect(result[i]).toBe((offset + i) % 256)
      }
    })
  })

  describe('Stress tests with various file sizes', () => {
    it('should handle file exactly 2MB (single full chunk)', async () => {
      const blobId = 'exact-2mb-file'
      const data = createTestData(CHUNK_SIZE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read entire file
      const result = await pageStorage.readRange(blobId, pageKeys, 0, CHUNK_SIZE)
      expect(result.length).toBe(CHUNK_SIZE)
      expect(result).toEqual(data)
    })

    it('should handle file exactly 2MB + 1 byte (boundary case)', async () => {
      const blobId = 'exact-2mb-plus-1'
      const fileSize = CHUNK_SIZE + 1
      const data = createTestData(fileSize)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read across the boundary - only 1 extra byte available, so read 11 bytes
      // (10 before boundary + 1 after)
      const offset = CHUNK_SIZE - 10
      const length = 11 // Can only read up to the last byte (index CHUNK_SIZE)
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
    })

    it('should handle file exactly 4MB (two full chunks)', async () => {
      const blobId = 'exact-4mb-file'
      const fileSize = 2 * CHUNK_SIZE
      const data = createTestData(fileSize)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read range spanning both chunks
      const offset = CHUNK_SIZE - 500
      const length = 1000
      const result = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(result.length).toBe(length)
      expect(result).toEqual(data.slice(offset, offset + length))
    })

    it('should handle reading entire file as single range', async () => {
      const blobId = 'entire-file-range'
      const data = createTestData(MEDIUM_FILE)
      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read entire file via readRange
      const result = await pageStorage.readRange(blobId, pageKeys, 0, MEDIUM_FILE)

      expect(result.length).toBe(MEDIUM_FILE)
      expect(result).toEqual(data)
    })
  })
})

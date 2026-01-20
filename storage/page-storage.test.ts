/**
 * Page Storage Tests - 2MB BLOB Chunking for DO SQLite Cost Optimization
 *
 * Tests for the PageStorage interface that manages large file storage
 * by chunking data into 2MB BLOB rows for optimal DO SQLite pricing.
 *
 * Key insight: DO SQLite charges per row read/write, NOT by size.
 * Using 2MB BLOBs reduces storage operations significantly.
 *
 * Issue: fsx-iti7 - Implement 2MB BLOB chunking for cost-optimized DO storage
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createPageStorage,
  CHUNK_SIZE,
  type PageStorage,
  type PageStorageConfig,
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

  // Helper for tests to inspect state
  getKeys(): string[] {
    return Array.from(this.data.keys())
  }

  clear(): void {
    this.data.clear()
  }
}

describe('PageStorage', () => {
  let storage: MockDOStorage
  let pageStorage: PageStorage

  beforeEach(() => {
    storage = new MockDOStorage()
    pageStorage = createPageStorage({
      storage: storage as unknown as DurableObjectStorage,
    })
  })

  describe('constants', () => {
    it('should define CHUNK_SIZE as 2MB', () => {
      expect(CHUNK_SIZE).toBe(2 * 1024 * 1024)
    })
  })

  describe('writePages', () => {
    it('should write a small file as a single chunk', async () => {
      const blobId = 'test-blob-1'
      const data = new Uint8Array(1024) // 1KB
      data.fill(0x42)

      const pageKeys = await pageStorage.writePages(blobId, data)

      expect(pageKeys).toHaveLength(1)
      expect(pageKeys[0]).toContain(blobId)
    })

    it('should chunk a 5MB file into 3 chunks', async () => {
      const blobId = 'test-blob-5mb'
      const size = 5 * 1024 * 1024 // 5MB
      const data = new Uint8Array(size)

      // Fill with pattern for verification
      for (let i = 0; i < size; i++) {
        data[i] = i % 256
      }

      const pageKeys = await pageStorage.writePages(blobId, data)

      // 5MB / 2MB = 2.5, rounds up to 3 chunks
      expect(pageKeys).toHaveLength(3)
      expect(pageKeys[0]).toContain(blobId)
      expect(pageKeys[1]).toContain(blobId)
      expect(pageKeys[2]).toContain(blobId)

      // Verify storage keys were created
      const storageKeys = storage.getKeys()
      expect(storageKeys.length).toBe(3)
    })

    it('should chunk exactly 2MB file into 1 chunk', async () => {
      const blobId = 'test-blob-2mb'
      const data = new Uint8Array(CHUNK_SIZE)
      data.fill(0xAB)

      const pageKeys = await pageStorage.writePages(blobId, data)

      expect(pageKeys).toHaveLength(1)
    })

    it('should chunk 2MB + 1 byte file into 2 chunks', async () => {
      const blobId = 'test-blob-2mb-plus-1'
      const data = new Uint8Array(CHUNK_SIZE + 1)
      data.fill(0xCD)

      const pageKeys = await pageStorage.writePages(blobId, data)

      expect(pageKeys).toHaveLength(2)
    })

    it('should chunk 4MB file into exactly 2 chunks', async () => {
      const blobId = 'test-blob-4mb'
      const data = new Uint8Array(4 * 1024 * 1024)
      data.fill(0xEF)

      const pageKeys = await pageStorage.writePages(blobId, data)

      expect(pageKeys).toHaveLength(2)
    })
  })

  describe('readPages', () => {
    it('should read back a single chunk file', async () => {
      const blobId = 'test-read-1'
      const originalData = new Uint8Array(1024)
      originalData.fill(0x42)

      const pageKeys = await pageStorage.writePages(blobId, originalData)
      const readData = await pageStorage.readPages(blobId, pageKeys)

      expect(readData).toEqual(originalData)
    })

    it('should reassemble a 5MB file from 3 chunks', async () => {
      const blobId = 'test-read-5mb'
      const size = 5 * 1024 * 1024
      const originalData = new Uint8Array(size)

      // Fill with verifiable pattern
      for (let i = 0; i < size; i++) {
        originalData[i] = i % 256
      }

      const pageKeys = await pageStorage.writePages(blobId, originalData)
      const readData = await pageStorage.readPages(blobId, pageKeys)

      expect(readData.length).toBe(originalData.length)
      expect(readData).toEqual(originalData)
    })

    it('should handle empty data', async () => {
      const blobId = 'test-empty'
      const data = new Uint8Array(0)

      const pageKeys = await pageStorage.writePages(blobId, data)
      const readData = await pageStorage.readPages(blobId, pageKeys)

      expect(readData).toEqual(data)
    })

    it('should throw if page keys are missing', async () => {
      const blobId = 'test-missing'
      const missingKeys = ['nonexistent-key-1', 'nonexistent-key-2']

      await expect(
        pageStorage.readPages(blobId, missingKeys)
      ).rejects.toThrow()
    })
  })

  describe('readRange', () => {
    it('should read range within first chunk', async () => {
      const blobId = 'test-range-1'
      const size = 5 * 1024 * 1024
      const data = new Uint8Array(size)

      for (let i = 0; i < size; i++) {
        data[i] = i % 256
      }

      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read first 100 bytes
      const rangeData = await pageStorage.readRange(blobId, pageKeys, 0, 100)

      expect(rangeData.length).toBe(100)
      expect(rangeData).toEqual(data.slice(0, 100))
    })

    it('should read range within second chunk', async () => {
      const blobId = 'test-range-2'
      const size = 5 * 1024 * 1024
      const data = new Uint8Array(size)

      for (let i = 0; i < size; i++) {
        data[i] = i % 256
      }

      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read 100 bytes starting at 3MB (in second chunk)
      const offset = 3 * 1024 * 1024
      const rangeData = await pageStorage.readRange(blobId, pageKeys, offset, 100)

      expect(rangeData.length).toBe(100)
      expect(rangeData).toEqual(data.slice(offset, offset + 100))
    })

    it('should read range spanning chunk boundary', async () => {
      const blobId = 'test-range-boundary'
      const size = 5 * 1024 * 1024
      const data = new Uint8Array(size)

      for (let i = 0; i < size; i++) {
        data[i] = i % 256
      }

      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read 1MB starting 512KB before chunk boundary (at 1.5MB to 2.5MB)
      const offset = CHUNK_SIZE - 512 * 1024 // 512KB before 2MB boundary
      const length = 1024 * 1024 // 1MB (spans into second chunk)
      const rangeData = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(rangeData.length).toBe(length)
      expect(rangeData).toEqual(data.slice(offset, offset + length))
    })

    it('should read range spanning multiple chunk boundaries', async () => {
      const blobId = 'test-range-multi'
      const size = 5 * 1024 * 1024
      const data = new Uint8Array(size)

      for (let i = 0; i < size; i++) {
        data[i] = i % 256
      }

      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read from middle of first chunk to middle of third chunk
      const offset = 1 * 1024 * 1024 // 1MB
      const length = 3 * 1024 * 1024 // 3MB (spans all three chunks)
      const rangeData = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(rangeData.length).toBe(length)
      expect(rangeData).toEqual(data.slice(offset, offset + length))
    })

    it('should handle range read at exact chunk boundary', async () => {
      const blobId = 'test-range-exact'
      const size = 5 * 1024 * 1024
      const data = new Uint8Array(size)

      for (let i = 0; i < size; i++) {
        data[i] = i % 256
      }

      const pageKeys = await pageStorage.writePages(blobId, data)

      // Read exactly at 2MB boundary
      const offset = CHUNK_SIZE
      const length = 100
      const rangeData = await pageStorage.readRange(blobId, pageKeys, offset, length)

      expect(rangeData.length).toBe(length)
      expect(rangeData).toEqual(data.slice(offset, offset + length))
    })

    it('should throw for out of bounds range', async () => {
      const blobId = 'test-range-oob'
      const data = new Uint8Array(1024)
      data.fill(0xFF)

      const pageKeys = await pageStorage.writePages(blobId, data)

      await expect(
        pageStorage.readRange(blobId, pageKeys, 2000, 100)
      ).rejects.toThrow()
    })
  })

  describe('deletePages', () => {
    it('should delete all pages', async () => {
      const blobId = 'test-delete'
      const data = new Uint8Array(5 * 1024 * 1024)
      data.fill(0x11)

      const pageKeys = await pageStorage.writePages(blobId, data)
      expect(storage.getKeys().length).toBe(3)

      await pageStorage.deletePages(pageKeys)
      expect(storage.getKeys().length).toBe(0)
    })

    it('should handle deleting empty page list', async () => {
      await expect(pageStorage.deletePages([])).resolves.not.toThrow()
    })

    it('should handle deleting non-existent pages gracefully', async () => {
      // Should not throw even if keys don't exist
      await expect(
        pageStorage.deletePages(['fake-key-1', 'fake-key-2'])
      ).resolves.not.toThrow()
    })
  })

  describe('partial updates', () => {
    it('should update data within a single chunk', async () => {
      const blobId = 'test-update-1'
      const size = 1024 * 1024 // 1MB
      const data = new Uint8Array(size)
      data.fill(0x00)

      const pageKeys = await pageStorage.writePages(blobId, data)

      // Update first 100 bytes
      const updateData = new Uint8Array(100)
      updateData.fill(0xFF)

      await pageStorage.updateRange(blobId, pageKeys, 0, updateData)

      // Read back and verify
      const readData = await pageStorage.readPages(blobId, pageKeys)
      expect(readData.slice(0, 100)).toEqual(updateData)
      expect(readData.slice(100, 200)).toEqual(new Uint8Array(100).fill(0x00))
    })

    it('should update data spanning chunk boundary', async () => {
      const blobId = 'test-update-boundary'
      const size = 5 * 1024 * 1024
      const data = new Uint8Array(size)
      data.fill(0x00)

      const pageKeys = await pageStorage.writePages(blobId, data)

      // Update 1MB starting 512KB before chunk boundary
      const offset = CHUNK_SIZE - 512 * 1024
      const updateSize = 1024 * 1024
      const updateData = new Uint8Array(updateSize)
      updateData.fill(0xFF)

      await pageStorage.updateRange(blobId, pageKeys, offset, updateData)

      // Read back and verify
      const readData = await pageStorage.readPages(blobId, pageKeys)

      // Data before update should be zeros
      expect(readData.slice(0, offset)).toEqual(new Uint8Array(offset).fill(0x00))

      // Updated region should be 0xFF
      expect(readData.slice(offset, offset + updateSize)).toEqual(updateData)

      // Data after update should be zeros
      const afterOffset = offset + updateSize
      expect(readData.slice(afterOffset, afterOffset + 100)).toEqual(
        new Uint8Array(100).fill(0x00)
      )
    })

    it('should update data in the middle of a chunk', async () => {
      const blobId = 'test-update-middle'
      const data = new Uint8Array(CHUNK_SIZE)

      // Fill with pattern
      for (let i = 0; i < CHUNK_SIZE; i++) {
        data[i] = i % 256
      }

      const pageKeys = await pageStorage.writePages(blobId, data)

      // Update 1000 bytes in the middle
      const offset = CHUNK_SIZE / 2
      const updateData = new Uint8Array(1000)
      updateData.fill(0xAA)

      await pageStorage.updateRange(blobId, pageKeys, offset, updateData)

      // Read back and verify
      const readData = await pageStorage.readPages(blobId, pageKeys)

      // Check before update region
      for (let i = 0; i < offset; i++) {
        expect(readData[i]).toBe(i % 256)
      }

      // Check updated region
      expect(readData.slice(offset, offset + 1000)).toEqual(updateData)

      // Check after update region
      for (let i = offset + 1000; i < CHUNK_SIZE; i++) {
        expect(readData[i]).toBe(i % 256)
      }
    })
  })

  describe('getTotalSize', () => {
    it('should return correct total size for chunked data', async () => {
      const blobId = 'test-size'
      const size = 5 * 1024 * 1024
      const data = new Uint8Array(size)
      data.fill(0x42)

      const pageKeys = await pageStorage.writePages(blobId, data)
      const totalSize = await pageStorage.getTotalSize(blobId, pageKeys)

      expect(totalSize).toBe(size)
    })

    it('should return correct total size for small data', async () => {
      const blobId = 'test-size-small'
      const size = 1234
      const data = new Uint8Array(size)
      data.fill(0x42)

      const pageKeys = await pageStorage.writePages(blobId, data)
      const totalSize = await pageStorage.getTotalSize(blobId, pageKeys)

      expect(totalSize).toBe(size)
    })

    it('should use cached size after writePages', async () => {
      const blobId = 'test-size-cached'
      const size = 5 * 1024 * 1024
      const data = new Uint8Array(size)
      data.fill(0x42)

      const pageKeys = await pageStorage.writePages(blobId, data)

      // Clear storage to prove cache is used
      storage.clear()

      // Should still return correct size from cache
      const totalSize = await pageStorage.getTotalSize(blobId, pageKeys)
      expect(totalSize).toBe(size)
    })

    it('should return zero for empty page keys', async () => {
      const totalSize = await pageStorage.getTotalSize('empty-blob', [])
      expect(totalSize).toBe(0)
    })
  })

  describe('getTotalSize performance', () => {
    it('should read chunks in parallel, not sequentially', async () => {
      // Create a tracking mock that records when gets start and complete
      const getStartTimes: number[] = []
      const getEndTimes: number[] = []
      let getCallCount = 0

      const trackingStorage = {
        data: new Map<string, Uint8Array>(),
        async get<T>(key: string): Promise<T | undefined> {
          const callIndex = getCallCount++
          getStartTimes[callIndex] = Date.now()
          // Small delay to make timing measurable
          await new Promise((resolve) => setTimeout(resolve, 10))
          getEndTimes[callIndex] = Date.now()
          return this.data.get(key) as T | undefined
        },
        async put(key: string, value: Uint8Array): Promise<void> {
          this.data.set(key, value)
        },
        async delete(key: string): Promise<boolean> {
          return this.data.delete(key)
        },
      }

      const trackingPageStorage = createPageStorage({
        storage: trackingStorage as unknown as DurableObjectStorage,
      })

      // Write data to create multiple chunks
      const blobId = 'parallel-test'
      const data = new Uint8Array(5 * 1024 * 1024) // 5MB = 3 chunks
      data.fill(0x42)

      const pageKeys = await trackingPageStorage.writePages(blobId, data)
      expect(pageKeys).toHaveLength(3)

      // Reset tracking for getTotalSize measurement
      getCallCount = 0
      getStartTimes.length = 0
      getEndTimes.length = 0

      // Clear cache to force recalculation
      const newPageStorage = createPageStorage({
        storage: trackingStorage as unknown as DurableObjectStorage,
      })

      await newPageStorage.getTotalSize(blobId, pageKeys)

      // Verify 3 chunks were read
      expect(getCallCount).toBe(3)

      // For parallel execution: all reads should start before any completes
      // Check that the second read started before the first completed
      // (this would be impossible with sequential reads)
      const firstEndTime = Math.min(...getEndTimes)
      const lastStartTime = Math.max(...getStartTimes)

      // If parallel: lastStartTime < firstEndTime (all started before any finished)
      // If sequential: lastStartTime > firstEndTime (each starts after previous finishes)
      expect(lastStartTime).toBeLessThan(firstEndTime)
    })

    it('should cache computed size for subsequent calls', async () => {
      let getCallCount = 0

      const countingStorage = {
        data: new Map<string, Uint8Array>(),
        async get<T>(key: string): Promise<T | undefined> {
          getCallCount++
          return this.data.get(key) as T | undefined
        },
        async put(key: string, value: Uint8Array): Promise<void> {
          this.data.set(key, value)
        },
        async delete(key: string): Promise<boolean> {
          return this.data.delete(key)
        },
      }

      const countingPageStorage = createPageStorage({
        storage: countingStorage as unknown as DurableObjectStorage,
      })

      // Write data
      const blobId = 'cache-test'
      const data = new Uint8Array(5 * 1024 * 1024) // 5MB = 3 chunks
      data.fill(0x42)

      const pageKeys = await countingPageStorage.writePages(blobId, data)

      // First call after write should use in-memory cache from write
      getCallCount = 0
      const size1 = await countingPageStorage.getTotalSize(blobId, pageKeys)
      expect(size1).toBe(5 * 1024 * 1024)
      expect(getCallCount).toBe(0) // No reads needed, used cache from write

      // Second call should also use cache
      const size2 = await countingPageStorage.getTotalSize(blobId, pageKeys)
      expect(size2).toBe(5 * 1024 * 1024)
      expect(getCallCount).toBe(0) // Still no reads needed
    })

    it('should cache size after computing from chunks', async () => {
      let getCallCount = 0

      const countingStorage = {
        data: new Map<string, Uint8Array>(),
        async get<T>(key: string): Promise<T | undefined> {
          getCallCount++
          return this.data.get(key) as T | undefined
        },
        async put(key: string, value: Uint8Array): Promise<void> {
          this.data.set(key, value)
        },
        async delete(key: string): Promise<boolean> {
          return this.data.delete(key)
        },
      }

      // First instance writes data
      const writerStorage = createPageStorage({
        storage: countingStorage as unknown as DurableObjectStorage,
      })

      const blobId = 'cross-instance-cache-test'
      const data = new Uint8Array(5 * 1024 * 1024) // 5MB = 3 chunks
      data.fill(0x42)

      const pageKeys = await writerStorage.writePages(blobId, data)

      // New instance without cached size (simulates server restart)
      const readerStorage = createPageStorage({
        storage: countingStorage as unknown as DurableObjectStorage,
      })

      getCallCount = 0

      // First getTotalSize should read chunks (no cache)
      const size1 = await readerStorage.getTotalSize(blobId, pageKeys)
      expect(size1).toBe(5 * 1024 * 1024)
      expect(getCallCount).toBe(3) // Read all 3 chunks

      // Second call should use the now-cached value
      const size2 = await readerStorage.getTotalSize(blobId, pageKeys)
      expect(size2).toBe(5 * 1024 * 1024)
      expect(getCallCount).toBe(3) // No additional reads
    })
  })

  describe('metadata', () => {
    it('should store and retrieve blob metadata', async () => {
      const blobId = 'test-meta'
      const data = new Uint8Array(5 * 1024 * 1024)
      data.fill(0x42)

      const pageKeys = await pageStorage.writePages(blobId, data)
      const metadata = await pageStorage.getMetadata(blobId, pageKeys)

      expect(metadata).toEqual({
        blobId,
        totalSize: 5 * 1024 * 1024,
        chunkCount: 3,
        pageKeys,
      })
    })
  })

  describe('edge cases', () => {
    it('should handle binary data with all byte values', async () => {
      const blobId = 'test-binary'
      const data = new Uint8Array(256 * 100) // 25,600 bytes

      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256
      }

      const pageKeys = await pageStorage.writePages(blobId, data)
      const readData = await pageStorage.readPages(blobId, pageKeys)

      expect(readData).toEqual(data)
    })

    it('should handle maximum chunk size exactly', async () => {
      const blobId = 'test-max-chunk'
      const data = new Uint8Array(CHUNK_SIZE)

      for (let i = 0; i < CHUNK_SIZE; i++) {
        data[i] = i % 256
      }

      const pageKeys = await pageStorage.writePages(blobId, data)
      expect(pageKeys).toHaveLength(1)

      const readData = await pageStorage.readPages(blobId, pageKeys)
      expect(readData).toEqual(data)
    })

    it('should handle concurrent writes to different blobs', async () => {
      const blob1 = 'concurrent-1'
      const blob2 = 'concurrent-2'

      const data1 = new Uint8Array(3 * 1024 * 1024)
      data1.fill(0x11)

      const data2 = new Uint8Array(3 * 1024 * 1024)
      data2.fill(0x22)

      // Write concurrently
      const [keys1, keys2] = await Promise.all([
        pageStorage.writePages(blob1, data1),
        pageStorage.writePages(blob2, data2),
      ])

      // Read back and verify isolation
      const read1 = await pageStorage.readPages(blob1, keys1)
      const read2 = await pageStorage.readPages(blob2, keys2)

      expect(read1).toEqual(data1)
      expect(read2).toEqual(data2)
    })
  })
})

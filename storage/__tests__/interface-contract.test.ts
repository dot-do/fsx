/**
 * BlobStorage Interface Contract Tests
 *
 * These tests define the contract that all BlobStorage implementations must fulfill.
 * They serve as "executable documentation" - if your implementation passes these tests,
 * it's compatible with the fsx storage layer.
 *
 * @module storage/__tests__/interface-contract
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  StorageError,
  type BlobStorage,
  type BlobWriteResult,
  type BlobReadResult,
  type BlobListResult,
  type BlobWriteOptions,
  type BlobListOptions,
} from '../interfaces.js'

// =============================================================================
// Memory Implementation for Testing
// =============================================================================

/**
 * In-memory BlobStorage implementation for testing.
 * This serves as a reference implementation of the BlobStorage interface.
 */
class MemoryBlobStorage implements BlobStorage {
  private data = new Map<
    string,
    {
      bytes: Uint8Array
      contentType?: string
      customMetadata?: Record<string, string>
      modified: Date
    }
  >()

  async put(
    path: string,
    data: Uint8Array | ReadableStream,
    options?: BlobWriteOptions
  ): Promise<BlobWriteResult> {
    // Convert stream to bytes if needed
    const bytes =
      data instanceof ReadableStream ? new Uint8Array(await new Response(data).arrayBuffer()) : data

    const etag = `"${this.computeHash(bytes)}"`
    this.data.set(path, {
      bytes: bytes.slice(), // Copy to prevent mutation
      contentType: options?.contentType,
      customMetadata: options?.customMetadata,
      modified: new Date(),
    })

    return { etag, size: bytes.length }
  }

  async get(path: string): Promise<BlobReadResult | null> {
    const entry = this.data.get(path)
    if (!entry) return null

    return {
      data: entry.bytes.slice(),
      metadata: {
        size: entry.bytes.length,
        etag: `"${this.computeHash(entry.bytes)}"`,
        contentType: entry.contentType,
        customMetadata: entry.customMetadata,
        lastModified: entry.modified,
      },
    }
  }

  async getStream(
    path: string
  ): Promise<{ stream: ReadableStream; metadata: BlobReadResult['metadata'] } | null> {
    const result = await this.get(path)
    if (!result) return null

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(result.data)
        controller.close()
      },
    })

    return { stream, metadata: result.metadata }
  }

  async getRange(path: string, start: number, end?: number): Promise<BlobReadResult | null> {
    const entry = this.data.get(path)
    if (!entry) return null

    // Validate range
    if (end !== undefined && start > end) {
      throw new StorageError('EINVAL', `Invalid range: start (${start}) > end (${end})`, {
        path,
        operation: 'getRange',
      })
    }

    const effectiveEnd = end !== undefined ? end + 1 : entry.bytes.length
    const sliced = entry.bytes.slice(start, effectiveEnd)

    return {
      data: sliced,
      metadata: {
        size: entry.bytes.length, // Total size, not slice size
        etag: `"${this.computeHash(entry.bytes)}"`,
        contentType: entry.contentType,
        customMetadata: entry.customMetadata,
        lastModified: entry.modified,
      },
    }
  }

  async delete(path: string): Promise<void> {
    this.data.delete(path) // Idempotent
  }

  async deleteMany(paths: string[]): Promise<void> {
    for (const path of paths) {
      this.data.delete(path)
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.data.has(path)
  }

  async head(path: string): Promise<BlobReadResult['metadata'] | null> {
    const entry = this.data.get(path)
    if (!entry) return null

    return {
      size: entry.bytes.length,
      etag: `"${this.computeHash(entry.bytes)}"`,
      contentType: entry.contentType,
      customMetadata: entry.customMetadata,
      lastModified: entry.modified,
    }
  }

  async list(options?: BlobListOptions): Promise<BlobListResult> {
    let keys = [...this.data.keys()].sort()

    if (options?.prefix) {
      keys = keys.filter((k) => k.startsWith(options.prefix!))
    }

    // Handle cursor-based pagination
    let startIndex = 0
    if (options?.cursor) {
      const cursorIndex = keys.indexOf(options.cursor)
      if (cursorIndex >= 0) {
        startIndex = cursorIndex + 1
      }
    }

    const limit = options?.limit ?? 1000
    const page = keys.slice(startIndex, startIndex + limit)
    const truncated = startIndex + limit < keys.length

    return {
      objects: page.map((key) => {
        const entry = this.data.get(key)!
        return {
          key,
          size: entry.bytes.length,
          etag: `"${this.computeHash(entry.bytes)}"`,
          uploaded: entry.modified,
        }
      }),
      cursor: truncated ? page[page.length - 1] : undefined,
      truncated,
    }
  }

  async copy(sourcePath: string, destPath: string): Promise<BlobWriteResult> {
    const entry = this.data.get(sourcePath)
    if (!entry) {
      throw StorageError.notFound(sourcePath, 'copy')
    }

    this.data.set(destPath, {
      bytes: entry.bytes.slice(),
      contentType: entry.contentType,
      customMetadata: entry.customMetadata,
      modified: new Date(),
    })

    return {
      etag: `"${this.computeHash(entry.bytes)}"`,
      size: entry.bytes.length,
    }
  }

  /** Clear all stored data (for test cleanup) */
  clear(): void {
    this.data.clear()
  }

  private computeHash(data: Uint8Array): string {
    let hash = 0
    for (let i = 0; i < data.length; i++) {
      hash = ((hash << 5) - hash + data[i]) | 0
    }
    return hash.toString(16)
  }
}

// =============================================================================
// Contract Test Suite
// =============================================================================

describe('BlobStorage Interface Contract', () => {
  let storage: MemoryBlobStorage

  beforeEach(() => {
    storage = new MemoryBlobStorage()
  })

  // ===========================================================================
  // Required Method Tests
  // ===========================================================================

  describe('Required Methods', () => {
    describe('put()', () => {
      it('should store Uint8Array data and return write result', async () => {
        const data = new TextEncoder().encode('Hello, World!')
        const result = await storage.put('/test.txt', data)

        expect(result).toHaveProperty('etag')
        expect(result).toHaveProperty('size')
        expect(result.size).toBe(data.length)
        expect(typeof result.etag).toBe('string')
        expect(result.etag.length).toBeGreaterThan(0)
      })

      it('should store ReadableStream data', async () => {
        const data = new TextEncoder().encode('Stream data')
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(data)
            controller.close()
          },
        })

        const result = await storage.put('/stream.txt', stream)
        expect(result.size).toBe(data.length)

        // Verify data was stored correctly
        const read = await storage.get('/stream.txt')
        expect(read).not.toBeNull()
        expect(new TextDecoder().decode(read!.data)).toBe('Stream data')
      })

      it('should apply write options (contentType, customMetadata)', async () => {
        const data = new TextEncoder().encode('{}')
        await storage.put('/config.json', data, {
          contentType: 'application/json',
          customMetadata: { version: '1.0' },
        })

        const result = await storage.get('/config.json')
        expect(result).not.toBeNull()
        expect(result!.metadata.contentType).toBe('application/json')
        expect(result!.metadata.customMetadata).toEqual({ version: '1.0' })
      })

      it('should overwrite existing data', async () => {
        const data1 = new TextEncoder().encode('Version 1')
        const data2 = new TextEncoder().encode('Version 2')

        await storage.put('/file.txt', data1)
        await storage.put('/file.txt', data2)

        const result = await storage.get('/file.txt')
        expect(new TextDecoder().decode(result!.data)).toBe('Version 2')
      })

      it('should generate different etags for different content', async () => {
        const result1 = await storage.put('/a.txt', new TextEncoder().encode('AAA'))
        const result2 = await storage.put('/b.txt', new TextEncoder().encode('BBB'))

        expect(result1.etag).not.toBe(result2.etag)
      })
    })

    describe('get()', () => {
      it('should return null for non-existent blob', async () => {
        const result = await storage.get('/nonexistent')
        expect(result).toBeNull()
      })

      it('should return data and metadata for existing blob', async () => {
        const data = new TextEncoder().encode('Test content')
        await storage.put('/file.txt', data, { contentType: 'text/plain' })

        const result = await storage.get('/file.txt')
        expect(result).not.toBeNull()
        expect(result!.data).toBeInstanceOf(Uint8Array)
        expect(new TextDecoder().decode(result!.data)).toBe('Test content')
        expect(result!.metadata.size).toBe(data.length)
        expect(result!.metadata.etag).toBeTruthy()
        expect(result!.metadata.contentType).toBe('text/plain')
      })

      it('should preserve binary data integrity', async () => {
        // Create binary data with all byte values
        const data = new Uint8Array(256)
        for (let i = 0; i < 256; i++) {
          data[i] = i
        }

        await storage.put('/binary.bin', data)
        const result = await storage.get('/binary.bin')

        expect(result).not.toBeNull()
        expect(result!.data.length).toBe(256)
        for (let i = 0; i < 256; i++) {
          expect(result!.data[i]).toBe(i)
        }
      })

      it('should return independent copies (no mutation)', async () => {
        const original = new TextEncoder().encode('Original')
        await storage.put('/file.txt', original)

        const result1 = await storage.get('/file.txt')
        result1!.data[0] = 0 // Mutate the returned data

        const result2 = await storage.get('/file.txt')
        expect(result2!.data[0]).not.toBe(0) // Should be unaffected
      })
    })

    describe('delete()', () => {
      it('should delete existing blob', async () => {
        await storage.put('/file.txt', new TextEncoder().encode('data'))
        expect(await storage.exists('/file.txt')).toBe(true)

        await storage.delete('/file.txt')
        expect(await storage.exists('/file.txt')).toBe(false)
      })

      it('should be idempotent (succeed even if blob does not exist)', async () => {
        // Should not throw
        await expect(storage.delete('/nonexistent')).resolves.toBeUndefined()

        // Multiple deletes should also work
        await storage.put('/file.txt', new TextEncoder().encode('data'))
        await storage.delete('/file.txt')
        await expect(storage.delete('/file.txt')).resolves.toBeUndefined()
      })
    })

    describe('exists()', () => {
      it('should return false for non-existent blob', async () => {
        expect(await storage.exists('/nonexistent')).toBe(false)
      })

      it('should return true for existing blob', async () => {
        await storage.put('/file.txt', new TextEncoder().encode('data'))
        expect(await storage.exists('/file.txt')).toBe(true)
      })

      it('should return false after deletion', async () => {
        await storage.put('/file.txt', new TextEncoder().encode('data'))
        await storage.delete('/file.txt')
        expect(await storage.exists('/file.txt')).toBe(false)
      })
    })
  })

  // ===========================================================================
  // Optional Method Tests
  // ===========================================================================

  describe('Optional Methods', () => {
    describe('getStream()', () => {
      it('should return null for non-existent blob', async () => {
        const result = await storage.getStream?.('/nonexistent')
        expect(result).toBeNull()
      })

      it('should return readable stream with metadata', async () => {
        const data = new TextEncoder().encode('Stream test')
        await storage.put('/stream.txt', data)

        const result = await storage.getStream?.('/stream.txt')
        expect(result).not.toBeNull()
        expect(result!.stream).toBeInstanceOf(ReadableStream)
        expect(result!.metadata.size).toBe(data.length)

        // Read the stream
        const reader = result!.stream.getReader()
        const { value } = await reader.read()
        expect(new TextDecoder().decode(value)).toBe('Stream test')
      })
    })

    describe('getRange()', () => {
      it('should return null for non-existent blob', async () => {
        const result = await storage.getRange?.('/nonexistent', 0, 10)
        expect(result).toBeNull()
      })

      it('should return byte range (start and end inclusive)', async () => {
        const data = new TextEncoder().encode('Hello, World!')
        await storage.put('/file.txt', data)

        const result = await storage.getRange?.('/file.txt', 0, 4)
        expect(result).not.toBeNull()
        expect(new TextDecoder().decode(result!.data)).toBe('Hello')
      })

      it('should return from start to end when end is omitted', async () => {
        const data = new TextEncoder().encode('Hello, World!')
        await storage.put('/file.txt', data)

        const result = await storage.getRange?.('/file.txt', 7)
        expect(result).not.toBeNull()
        expect(new TextDecoder().decode(result!.data)).toBe('World!')
      })

      it('should return total size in metadata, not slice size', async () => {
        const data = new TextEncoder().encode('Hello, World!')
        await storage.put('/file.txt', data)

        const result = await storage.getRange?.('/file.txt', 0, 4)
        expect(result!.metadata.size).toBe(data.length) // Total size
        expect(result!.data.length).toBe(5) // Slice size
      })

      it('should throw EINVAL for invalid range (start > end)', async () => {
        const data = new TextEncoder().encode('Test')
        await storage.put('/file.txt', data)

        await expect(storage.getRange?.('/file.txt', 10, 5)).rejects.toThrow(StorageError)
        try {
          await storage.getRange?.('/file.txt', 10, 5)
        } catch (e) {
          expect(e).toBeInstanceOf(StorageError)
          expect((e as StorageError).code).toBe('EINVAL')
        }
      })
    })

    describe('head()', () => {
      it('should return null for non-existent blob', async () => {
        const result = await storage.head?.('/nonexistent')
        expect(result).toBeNull()
      })

      it('should return metadata without data', async () => {
        const data = new TextEncoder().encode('Test content')
        await storage.put('/file.txt', data, {
          contentType: 'text/plain',
          customMetadata: { key: 'value' },
        })

        const result = await storage.head?.('/file.txt')
        expect(result).not.toBeNull()
        expect(result!.size).toBe(data.length)
        expect(result!.etag).toBeTruthy()
        expect(result!.contentType).toBe('text/plain')
        expect(result!.customMetadata).toEqual({ key: 'value' })
        expect(result!.lastModified).toBeInstanceOf(Date)
      })
    })

    describe('list()', () => {
      beforeEach(async () => {
        // Setup test data
        await storage.put('/a.txt', new TextEncoder().encode('a'))
        await storage.put('/b.txt', new TextEncoder().encode('b'))
        await storage.put('/dir/c.txt', new TextEncoder().encode('c'))
        await storage.put('/dir/d.txt', new TextEncoder().encode('d'))
        await storage.put('/other/e.txt', new TextEncoder().encode('e'))
      })

      it('should list all blobs when no options provided', async () => {
        const result = await storage.list?.()
        expect(result).not.toBeNull()
        expect(result!.objects.length).toBe(5)
        expect(result!.truncated).toBe(false)
      })

      it('should filter by prefix', async () => {
        const result = await storage.list?.({ prefix: '/dir/' })
        expect(result!.objects.length).toBe(2)
        expect(result!.objects.map((o) => o.key)).toContain('/dir/c.txt')
        expect(result!.objects.map((o) => o.key)).toContain('/dir/d.txt')
      })

      it('should return objects sorted lexicographically', async () => {
        const result = await storage.list?.()
        const keys = result!.objects.map((o) => o.key)
        const sorted = [...keys].sort()
        expect(keys).toEqual(sorted)
      })

      it('should support pagination with limit', async () => {
        const page1 = await storage.list?.({ limit: 2 })
        expect(page1!.objects.length).toBe(2)
        expect(page1!.truncated).toBe(true)
        expect(page1!.cursor).toBeTruthy()

        const page2 = await storage.list?.({ limit: 2, cursor: page1!.cursor })
        expect(page2!.objects.length).toBe(2)
        expect(page2!.truncated).toBe(true)

        const page3 = await storage.list?.({ limit: 2, cursor: page2!.cursor })
        expect(page3!.objects.length).toBe(1)
        expect(page3!.truncated).toBe(false)
      })

      it('should return correct object metadata', async () => {
        const result = await storage.list?.({ prefix: '/a.txt' })
        expect(result!.objects.length).toBe(1)
        const obj = result!.objects[0]
        expect(obj.key).toBe('/a.txt')
        expect(obj.size).toBe(1)
        expect(obj.etag).toBeTruthy()
        expect(obj.uploaded).toBeInstanceOf(Date)
      })
    })

    describe('copy()', () => {
      it('should copy blob to new path', async () => {
        const data = new TextEncoder().encode('Copy me')
        await storage.put('/original.txt', data, {
          contentType: 'text/plain',
          customMetadata: { foo: 'bar' },
        })

        const result = await storage.copy?.('/original.txt', '/copy.txt')
        expect(result).not.toBeNull()
        expect(result!.size).toBe(data.length)

        // Verify copy exists and has same content
        const copied = await storage.get('/copy.txt')
        expect(copied).not.toBeNull()
        expect(new TextDecoder().decode(copied!.data)).toBe('Copy me')
        expect(copied!.metadata.contentType).toBe('text/plain')
        expect(copied!.metadata.customMetadata).toEqual({ foo: 'bar' })
      })

      it('should throw ENOENT if source does not exist', async () => {
        await expect(storage.copy?.('/nonexistent', '/dest')).rejects.toThrow(StorageError)
        try {
          await storage.copy?.('/nonexistent', '/dest')
        } catch (e) {
          expect(e).toBeInstanceOf(StorageError)
          expect((e as StorageError).code).toBe('ENOENT')
        }
      })

      it('should overwrite destination if it exists', async () => {
        await storage.put('/source.txt', new TextEncoder().encode('Source'))
        await storage.put('/dest.txt', new TextEncoder().encode('Destination'))

        await storage.copy?.('/source.txt', '/dest.txt')

        const result = await storage.get('/dest.txt')
        expect(new TextDecoder().decode(result!.data)).toBe('Source')
      })
    })

    describe('deleteMany()', () => {
      it('should delete multiple blobs', async () => {
        await storage.put('/a.txt', new TextEncoder().encode('a'))
        await storage.put('/b.txt', new TextEncoder().encode('b'))
        await storage.put('/c.txt', new TextEncoder().encode('c'))

        await storage.deleteMany?.(['/a.txt', '/b.txt'])

        expect(await storage.exists('/a.txt')).toBe(false)
        expect(await storage.exists('/b.txt')).toBe(false)
        expect(await storage.exists('/c.txt')).toBe(true)
      })

      it('should succeed even if some blobs do not exist', async () => {
        await storage.put('/exists.txt', new TextEncoder().encode('data'))

        await expect(
          storage.deleteMany?.(['/exists.txt', '/nonexistent1', '/nonexistent2'])
        ).resolves.toBeUndefined()

        expect(await storage.exists('/exists.txt')).toBe(false)
      })

      it('should handle empty array', async () => {
        await expect(storage.deleteMany?.([])).resolves.toBeUndefined()
      })
    })
  })

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('StorageError', () => {
    it('should have correct error properties', () => {
      const error = new StorageError('ENOENT', 'Not found: /test', {
        path: '/test',
        operation: 'get',
      })

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(StorageError)
      expect(error.code).toBe('ENOENT')
      expect(error.message).toBe('Not found: /test')
      expect(error.path).toBe('/test')
      expect(error.operation).toBe('get')
      expect(error.name).toBe('StorageError')
    })

    it('should preserve cause for debugging', () => {
      const cause = new Error('Network failed')
      const error = new StorageError('EIO', 'I/O error', { cause })

      expect(error.cause).toBe(cause)
    })

    describe('static factory methods', () => {
      it('notFound() creates ENOENT error', () => {
        const error = StorageError.notFound('/missing', 'get')
        expect(error.code).toBe('ENOENT')
        expect(error.path).toBe('/missing')
        expect(error.operation).toBe('get')
      })

      it('exists() creates EEXIST error', () => {
        const error = StorageError.exists('/existing', 'create')
        expect(error.code).toBe('EEXIST')
        expect(error.path).toBe('/existing')
      })

      it('invalidArg() creates EINVAL error', () => {
        const error = StorageError.invalidArg('Invalid path format', '/bad path', 'put')
        expect(error.code).toBe('EINVAL')
        expect(error.message).toBe('Invalid path format')
      })

      it('io() creates EIO error with cause', () => {
        const cause = new Error('Disk full')
        const error = StorageError.io(cause, '/file', 'put')
        expect(error.code).toBe('EIO')
        expect(error.cause).toBe(cause)
      })
    })

    it('toJSON() returns serializable representation', () => {
      const error = new StorageError('ENOENT', 'Not found', {
        path: '/test',
        operation: 'get',
      })

      const json = error.toJSON()
      expect(json).toEqual({
        name: 'StorageError',
        code: 'ENOENT',
        message: 'Not found',
        path: '/test',
        operation: 'get',
      })
    })
  })

  // ===========================================================================
  // Edge Cases and Boundary Conditions
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle empty data', async () => {
      const empty = new Uint8Array(0)
      const result = await storage.put('/empty.bin', empty)

      expect(result.size).toBe(0)

      const read = await storage.get('/empty.bin')
      expect(read).not.toBeNull()
      expect(read!.data.length).toBe(0)
      expect(read!.metadata.size).toBe(0)
    })

    it('should handle paths with special characters', async () => {
      const paths = [
        '/file with spaces.txt',
        '/file-with-dashes.txt',
        '/file_with_underscores.txt',
        '/dir/nested/deep/file.txt',
        '/unicode-\u00e9\u00e8\u00ea.txt',
      ]

      for (const path of paths) {
        const data = new TextEncoder().encode(`Content for ${path}`)
        await storage.put(path, data)
        const result = await storage.get(path)
        expect(result).not.toBeNull()
        expect(new TextDecoder().decode(result!.data)).toBe(`Content for ${path}`)
      }
    })

    it('should handle large data (1MB)', async () => {
      const size = 1024 * 1024 // 1MB
      const data = new Uint8Array(size)
      for (let i = 0; i < size; i++) {
        data[i] = i % 256
      }

      const writeResult = await storage.put('/large.bin', data)
      expect(writeResult.size).toBe(size)

      const readResult = await storage.get('/large.bin')
      expect(readResult).not.toBeNull()
      expect(readResult!.data.length).toBe(size)
      expect(readResult!.metadata.size).toBe(size)

      // Verify data integrity
      for (let i = 0; i < size; i++) {
        if (readResult!.data[i] !== i % 256) {
          throw new Error(`Data mismatch at byte ${i}`)
        }
      }
    })

    it('should maintain consistency under rapid operations', async () => {
      const iterations = 100

      // Rapid put/get/delete cycle
      for (let i = 0; i < iterations; i++) {
        const path = `/rapid-${i}.txt`
        const data = new TextEncoder().encode(`Iteration ${i}`)

        await storage.put(path, data)
        const result = await storage.get(path)
        expect(result).not.toBeNull()
        expect(new TextDecoder().decode(result!.data)).toBe(`Iteration ${i}`)
        await storage.delete(path)
        expect(await storage.exists(path)).toBe(false)
      }
    })

    it('should handle concurrent operations correctly', async () => {
      const paths = Array.from({ length: 10 }, (_, i) => `/concurrent-${i}.txt`)

      // Concurrent puts
      await Promise.all(
        paths.map((path, i) => storage.put(path, new TextEncoder().encode(`Content ${i}`)))
      )

      // Concurrent gets
      const results = await Promise.all(paths.map((path) => storage.get(path)))

      for (let i = 0; i < paths.length; i++) {
        expect(results[i]).not.toBeNull()
        expect(new TextDecoder().decode(results[i]!.data)).toBe(`Content ${i}`)
      }

      // Concurrent deletes
      await Promise.all(paths.map((path) => storage.delete(path)))

      // Verify all deleted
      const existsResults = await Promise.all(paths.map((path) => storage.exists(path)))
      expect(existsResults.every((e) => e === false)).toBe(true)
    })
  })
})

// =============================================================================
// Exported Test Runner for Custom Implementations
// =============================================================================

/**
 * Run the BlobStorage contract tests against a custom implementation.
 *
 * Use this to verify your BlobStorage implementation is compliant:
 *
 * @example
 * ```typescript
 * import { runBlobStorageContractTests } from '@dotdo/fsx/storage/__tests__/interface-contract'
 *
 * describe('MyBlobStorage', () => {
 *   runBlobStorageContractTests(() => new MyBlobStorage())
 * })
 * ```
 */
export function runBlobStorageContractTests(
  createStorage: () => BlobStorage & { clear?: () => void }
): void {
  let storage: BlobStorage & { clear?: () => void }

  beforeEach(() => {
    storage = createStorage()
    storage.clear?.()
  })

  describe('BlobStorage Contract', () => {
    describe('put()', () => {
      it('should store and return write result', async () => {
        const data = new TextEncoder().encode('Test')
        const result = await storage.put('/test.txt', data)
        expect(result.etag).toBeTruthy()
        expect(result.size).toBe(data.length)
      })
    })

    describe('get()', () => {
      it('should return null for non-existent', async () => {
        expect(await storage.get('/nonexistent')).toBeNull()
      })

      it('should return stored data', async () => {
        await storage.put('/test.txt', new TextEncoder().encode('Hello'))
        const result = await storage.get('/test.txt')
        expect(result).not.toBeNull()
        expect(new TextDecoder().decode(result!.data)).toBe('Hello')
      })
    })

    describe('delete()', () => {
      it('should be idempotent', async () => {
        await expect(storage.delete('/nonexistent')).resolves.toBeUndefined()
      })
    })

    describe('exists()', () => {
      it('should return correct boolean', async () => {
        expect(await storage.exists('/test.txt')).toBe(false)
        await storage.put('/test.txt', new TextEncoder().encode('data'))
        expect(await storage.exists('/test.txt')).toBe(true)
      })
    })
  })
}

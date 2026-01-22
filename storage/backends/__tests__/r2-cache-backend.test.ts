/**
 * Tests for R2CacheBlobStorage - R2 + Cache API Read-Through Backend
 *
 * These tests cover:
 * 1. Basic operations: get, put, delete, list
 * 2. Cache read-through behavior
 * 3. Cache invalidation and warming
 * 4. Range reads from cached objects
 * 5. Metadata preservation through cache
 * 6. Error handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { R2CacheBlobStorage, type R2CacheBackendConfig } from '../r2-cache-backend'

// =============================================================================
// Mock R2Object Implementation
// =============================================================================

class MockR2Object implements R2Object {
  key: string
  version: string
  size: number
  etag: string
  httpEtag: string
  checksums: R2Checksums
  uploaded: Date
  httpMetadata?: R2HTTPMetadata
  customMetadata?: Record<string, string>
  storageClass: string
  private data: Uint8Array
  private rangeStart: number
  private rangeEnd: number

  constructor(
    key: string,
    data: Uint8Array,
    options?: {
      customMetadata?: Record<string, string>
      httpMetadata?: R2HTTPMetadata
      rangeStart?: number
      rangeEnd?: number
    }
  ) {
    this.key = key
    this.data = data
    this.size = data.length
    this.version = '1'
    this.etag = `"${Math.random().toString(36).substring(7)}"`
    this.httpEtag = this.etag
    this.checksums = { toJSON: () => ({}) }
    this.uploaded = new Date()
    this.customMetadata = options?.customMetadata
    this.httpMetadata = options?.httpMetadata
    this.storageClass = 'Standard'
    this.rangeStart = options?.rangeStart ?? 0
    this.rangeEnd = options?.rangeEnd ?? data.length
  }

  get body(): ReadableStream<Uint8Array> {
    const slicedData = this.data.slice(this.rangeStart, this.rangeEnd)
    return new ReadableStream({
      start(controller) {
        controller.enqueue(slicedData)
        controller.close()
      },
    })
  }

  get bodyUsed(): boolean {
    return false
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const slicedData = this.data.slice(this.rangeStart, this.rangeEnd)
    return slicedData.buffer.slice(slicedData.byteOffset, slicedData.byteOffset + slicedData.byteLength)
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.data.slice(this.rangeStart, this.rangeEnd))
  }

  async json<T>(): Promise<T> {
    return JSON.parse(await this.text())
  }

  async blob(): Promise<Blob> {
    return new Blob([this.data.slice(this.rangeStart, this.rangeEnd)])
  }

  writeHttpMetadata(_headers: Headers): void {
    // no-op
  }

  get range(): R2Range | undefined {
    if (this.rangeStart === 0 && this.rangeEnd === this.data.length) {
      return undefined
    }
    return { offset: this.rangeStart, length: this.rangeEnd - this.rangeStart }
  }
}

// =============================================================================
// Mock R2Bucket Implementation
// =============================================================================

class MockR2Bucket implements R2Bucket {
  private objects = new Map<string, { data: Uint8Array; metadata?: Record<string, string>; httpMetadata?: R2HTTPMetadata }>()
  private _shouldThrowNetworkError = false

  // Tracking for test assertions
  public getCount = 0
  public putCount = 0
  public headCount = 0

  async put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions
  ): Promise<R2Object> {
    if (this._shouldThrowNetworkError) {
      throw new Error('Network error: connection refused')
    }

    this.putCount++

    let data: Uint8Array

    if (value === null) {
      data = new Uint8Array(0)
    } else if (value instanceof ReadableStream) {
      const reader = value.getReader()
      const chunks: Uint8Array[] = []
      let done = false
      while (!done) {
        const result = await reader.read()
        if (result.value) chunks.push(result.value)
        done = result.done
      }
      const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
      data = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        data.set(chunk, offset)
        offset += chunk.length
      }
    } else if (value instanceof ArrayBuffer) {
      data = new Uint8Array(value)
    } else if (ArrayBuffer.isView(value)) {
      data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    } else if (typeof value === 'string') {
      data = new TextEncoder().encode(value)
    } else if (value instanceof Blob) {
      data = new Uint8Array(await value.arrayBuffer())
    } else {
      data = new Uint8Array(0)
    }

    this.objects.set(key, {
      data,
      metadata: options?.customMetadata,
      httpMetadata: options?.httpMetadata,
    })

    return new MockR2Object(key, data, {
      customMetadata: options?.customMetadata,
      httpMetadata: options?.httpMetadata,
    })
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    if (this._shouldThrowNetworkError) {
      throw new Error('Network error: connection refused')
    }

    this.getCount++

    const obj = this.objects.get(key)
    if (!obj) return null

    let rangeStart = 0
    let rangeEnd = obj.data.length

    if (options?.range) {
      const range = options.range as { offset?: number; length?: number; suffix?: number }
      if (range.offset !== undefined) {
        rangeStart = range.offset
        if (range.length !== undefined) {
          rangeEnd = rangeStart + range.length
        }
      } else if (range.suffix !== undefined) {
        rangeStart = Math.max(0, obj.data.length - range.suffix)
      }
    }

    return new MockR2Object(key, obj.data, {
      customMetadata: obj.metadata,
      httpMetadata: obj.httpMetadata,
      rangeStart,
      rangeEnd,
    }) as unknown as R2ObjectBody
  }

  async head(key: string): Promise<R2Object | null> {
    if (this._shouldThrowNetworkError) {
      throw new Error('Network error: connection refused')
    }

    this.headCount++

    const obj = this.objects.get(key)
    if (!obj) return null
    return new MockR2Object(key, obj.data, {
      customMetadata: obj.metadata,
      httpMetadata: obj.httpMetadata,
    })
  }

  async delete(keys: string | string[]): Promise<void> {
    if (this._shouldThrowNetworkError) {
      throw new Error('Network error: connection refused')
    }

    const keysArray = Array.isArray(keys) ? keys : [keys]
    for (const key of keysArray) {
      this.objects.delete(key)
    }
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    if (this._shouldThrowNetworkError) {
      throw new Error('Network error: connection refused')
    }

    const prefix = options?.prefix ?? ''
    const limit = options?.limit ?? 1000
    const cursor = options?.cursor
    const objects: R2Object[] = []

    const allKeys = Array.from(this.objects.keys())
      .filter((key) => key.startsWith(prefix))
      .sort()

    let startIndex = 0
    if (cursor) {
      const cursorIndex = allKeys.findIndex((key) => key > cursor)
      startIndex = cursorIndex >= 0 ? cursorIndex : allKeys.length
    }

    const pageKeys = allKeys.slice(startIndex, startIndex + limit)

    for (const key of pageKeys) {
      const obj = this.objects.get(key)!
      objects.push(
        new MockR2Object(key, obj.data, {
          customMetadata: obj.metadata,
          httpMetadata: obj.httpMetadata,
        })
      )
    }

    const hasMore = startIndex + limit < allKeys.length
    const nextCursor = hasMore ? pageKeys[pageKeys.length - 1] : undefined

    return {
      objects,
      truncated: hasMore,
      cursor: nextCursor,
      delimitedPrefixes: [],
    }
  }

  createMultipartUpload(_key: string, _options?: R2MultipartOptions): Promise<R2MultipartUpload> {
    throw new Error('Not implemented in mock')
  }

  resumeMultipartUpload(_key: string, _uploadId: string): R2MultipartUpload {
    throw new Error('Not implemented in mock')
  }

  // Test helpers
  setNetworkError(shouldThrow: boolean): void {
    this._shouldThrowNetworkError = shouldThrow
  }

  clear(): void {
    this.objects.clear()
    this.getCount = 0
    this.putCount = 0
    this.headCount = 0
  }

  has(key: string): boolean {
    return this.objects.has(key)
  }

  getStoredData(key: string): Uint8Array | undefined {
    return this.objects.get(key)?.data
  }
}

// =============================================================================
// Mock Cache Implementation
// =============================================================================

class MockCache implements Cache {
  private store = new Map<string, Response>()
  public matchCount = 0
  public putCount = 0
  public deleteCount = 0

  async match(request: RequestInfo | URL, _options?: CacheQueryOptions): Promise<Response | undefined> {
    this.matchCount++
    const url = this.getUrl(request)
    const response = this.store.get(url)
    if (response) {
      // Clone the response so it can be read multiple times
      return response.clone()
    }
    return undefined
  }

  async matchAll(_request?: RequestInfo | URL, _options?: CacheQueryOptions): Promise<readonly Response[]> {
    return Array.from(this.store.values()).map(r => r.clone())
  }

  async add(_request: RequestInfo | URL): Promise<void> {
    throw new Error('Not implemented in mock')
  }

  async addAll(_requests: RequestInfo[]): Promise<void> {
    throw new Error('Not implemented in mock')
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.putCount++
    const url = this.getUrl(request)
    // Clone the response so the original can still be used
    this.store.set(url, response.clone())
  }

  async delete(request: RequestInfo | URL, _options?: CacheQueryOptions): Promise<boolean> {
    this.deleteCount++
    const url = this.getUrl(request)
    return this.store.delete(url)
  }

  async keys(_request?: RequestInfo | URL, _options?: CacheQueryOptions): Promise<readonly Request[]> {
    return Array.from(this.store.keys()).map(url => new Request(url))
  }

  // Helper
  private getUrl(request: RequestInfo | URL): string {
    if (request instanceof Request) {
      return request.url
    } else if (request instanceof URL) {
      return request.href
    } else {
      return request
    }
  }

  // Test helpers
  clear(): void {
    this.store.clear()
    this.matchCount = 0
    this.putCount = 0
    this.deleteCount = 0
  }

  has(url: string): boolean {
    return this.store.has(url)
  }

  size(): number {
    return this.store.size
  }
}

// =============================================================================
// Mock caches global
// =============================================================================

const mockCache = new MockCache()

const mockCaches = {
  open: vi.fn().mockResolvedValue(mockCache),
  default: mockCache,
  delete: vi.fn().mockResolvedValue(true),
  has: vi.fn().mockResolvedValue(true),
  keys: vi.fn().mockResolvedValue([]),
  match: vi.fn().mockImplementation((request: RequestInfo) => mockCache.match(request)),
}

// Set up global caches mock
;(globalThis as unknown as { caches: typeof mockCaches }).caches = mockCaches

// =============================================================================
// Tests
// =============================================================================

describe('R2CacheBlobStorage', () => {
  let bucket: MockR2Bucket
  let storage: R2CacheBlobStorage

  beforeEach(() => {
    bucket = new MockR2Bucket()
    mockCache.clear()
    vi.clearAllMocks()

    storage = new R2CacheBlobStorage({
      bucket: bucket as unknown as R2Bucket,
      cacheBaseUrl: 'https://fsx.cache/',
    })
  })

  describe('Configuration', () => {
    it('should throw if cacheBaseUrl is not provided', () => {
      expect(() => {
        new R2CacheBlobStorage({
          bucket: bucket as unknown as R2Bucket,
          cacheBaseUrl: '',
        })
      }).toThrow('cacheBaseUrl is required')
    })

    it('should throw if cacheBaseUrl is invalid', () => {
      expect(() => {
        new R2CacheBlobStorage({
          bucket: bucket as unknown as R2Bucket,
          cacheBaseUrl: 'not-a-url',
        })
      }).toThrow('Invalid cacheBaseUrl')
    })

    it('should accept valid configuration', () => {
      const storage = new R2CacheBlobStorage({
        bucket: bucket as unknown as R2Bucket,
        cacheBaseUrl: 'https://fsx.cache/',
        cacheName: 'custom-cache',
        prefix: 'tenant1/',
        defaultTtl: 3600,
        maxTtl: 86400,
        warmCacheOnWrite: true,
      })

      expect(storage).toBeDefined()
    })
  })

  describe('put', () => {
    it('should store data in R2', async () => {
      const data = new TextEncoder().encode('hello world')
      const result = await storage.put('/test.txt', data)

      expect(result.etag).toBeDefined()
      expect(result.size).toBe(data.length)
      expect(bucket.has('/test.txt')).toBe(true)
    })

    it('should store data with content type', async () => {
      const data = new TextEncoder().encode('{"key": "value"}')
      await storage.put('/data.json', data, {
        contentType: 'application/json',
      })

      const obj = await bucket.head('/data.json')
      expect(obj?.httpMetadata?.contentType).toBe('application/json')
    })

    it('should store data with custom metadata', async () => {
      const data = new TextEncoder().encode('test')
      const metadata = { author: 'test', version: '1.0' }
      await storage.put('/meta.txt', data, { customMetadata: metadata })

      const obj = await bucket.head('/meta.txt')
      expect(obj?.customMetadata).toEqual(metadata)
    })

    it('should not cache on write by default', async () => {
      const data = new TextEncoder().encode('test')
      await storage.put('/test.txt', data)

      expect(mockCache.putCount).toBe(0)
    })

    it('should cache on write when warmCacheOnWrite is enabled', async () => {
      const warmStorage = new R2CacheBlobStorage({
        bucket: bucket as unknown as R2Bucket,
        cacheBaseUrl: 'https://fsx.cache/',
        warmCacheOnWrite: true,
      })

      const data = new TextEncoder().encode('test')
      await warmStorage.put('/test.txt', data)

      expect(mockCache.putCount).toBe(1)
    })

    it('should cache on write when warmCache option is provided', async () => {
      const data = new TextEncoder().encode('test')
      await storage.put('/test.txt', data, { warmCache: true })

      expect(mockCache.putCount).toBe(1)
    })

    it('should handle ReadableStream input', async () => {
      const data = new TextEncoder().encode('streamed content')
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(data)
          controller.close()
        },
      })

      const result = await storage.put('/streamed.txt', stream)

      expect(result.size).toBe(data.length)
      expect(bucket.has('/streamed.txt')).toBe(true)
    })
  })

  describe('get', () => {
    it('should fetch from R2 on cache miss', async () => {
      const data = new TextEncoder().encode('hello world')
      await bucket.put('/test.txt', data)
      bucket.getCount = 0 // Reset after put

      const result = await storage.get('/test.txt')

      expect(result).not.toBeNull()
      expect(result!.data).toEqual(data)
      expect(bucket.getCount).toBe(1)
    })

    it('should cache the response after R2 fetch', async () => {
      const data = new TextEncoder().encode('hello world')
      await bucket.put('/test.txt', data)

      await storage.get('/test.txt')

      expect(mockCache.putCount).toBe(1)
    })

    it('should serve from cache on subsequent reads', async () => {
      const data = new TextEncoder().encode('hello world')
      await bucket.put('/test.txt', data)
      bucket.getCount = 0

      // First read - cache miss
      await storage.get('/test.txt')
      expect(bucket.getCount).toBe(1)

      // Second read - cache hit
      bucket.getCount = 0
      await storage.get('/test.txt')
      expect(bucket.getCount).toBe(0) // Should not hit R2
      expect(mockCache.matchCount).toBeGreaterThan(0)
    })

    it('should return null for non-existent key', async () => {
      const result = await storage.get('/nonexistent.txt')

      expect(result).toBeNull()
    })

    it('should include metadata in result', async () => {
      const data = new TextEncoder().encode('test')
      const customMetadata = { key: 'value' }
      await bucket.put('/meta.txt', data, { customMetadata })

      const result = await storage.get('/meta.txt')

      expect(result!.metadata.size).toBe(data.length)
      expect(result!.metadata.etag).toBeDefined()
    })
  })

  describe('getStream', () => {
    it('should return a readable stream', async () => {
      const data = new TextEncoder().encode('streamed data')
      await bucket.put('/stream.txt', data)

      const result = await storage.getStream('/stream.txt')

      expect(result).not.toBeNull()
      expect(result!.stream).toBeInstanceOf(ReadableStream)

      // Read the stream
      const reader = result!.stream.getReader()
      const { value } = await reader.read()
      expect(new TextDecoder().decode(value)).toBe('streamed data')
    })

    it('should return null for non-existent key', async () => {
      const result = await storage.getStream('/nonexistent.txt')
      expect(result).toBeNull()
    })
  })

  describe('getRange', () => {
    const testData = new TextEncoder().encode('0123456789ABCDEFGHIJ')

    beforeEach(async () => {
      await bucket.put('/range.txt', testData)
    })

    it('should return requested range', async () => {
      const result = await storage.getRange('/range.txt', 5, 9)

      expect(result).not.toBeNull()
      expect(new TextDecoder().decode(result!.data)).toBe('56789')
    })

    it('should return from offset to end when no end specified', async () => {
      const result = await storage.getRange('/range.txt', 10)

      expect(result).not.toBeNull()
      expect(new TextDecoder().decode(result!.data)).toBe('ABCDEFGHIJ')
    })

    it('should read from start', async () => {
      const result = await storage.getRange('/range.txt', 0, 4)

      expect(result).not.toBeNull()
      expect(new TextDecoder().decode(result!.data)).toBe('01234')
    })

    it('should return null for non-existent key', async () => {
      const result = await storage.getRange('/nonexistent.txt', 0, 10)

      expect(result).toBeNull()
    })

    it('should cache full object for range reads', async () => {
      bucket.getCount = 0
      mockCache.putCount = 0

      // First range read should cache full object
      await storage.getRange('/range.txt', 0, 5)
      expect(bucket.getCount).toBe(1)
      expect(mockCache.putCount).toBe(1)

      // Second range read should use cached full object
      bucket.getCount = 0
      await storage.getRange('/range.txt', 5, 10)
      expect(bucket.getCount).toBe(0) // No R2 fetch
    })
  })

  describe('delete', () => {
    it('should delete from R2 and cache', async () => {
      const data = new TextEncoder().encode('to delete')
      await bucket.put('/delete.txt', data)
      await storage.get('/delete.txt') // Cache it

      await storage.delete('/delete.txt')

      expect(bucket.has('/delete.txt')).toBe(false)
      expect(mockCache.deleteCount).toBe(1)
    })

    it('should not throw when deleting non-existent key', async () => {
      await expect(storage.delete('/nonexistent.txt')).resolves.toBeUndefined()
    })
  })

  describe('deleteMany', () => {
    it('should delete multiple items from R2 and cache', async () => {
      const data = new TextEncoder().encode('test')
      await bucket.put('/file1.txt', data)
      await bucket.put('/file2.txt', data)
      await bucket.put('/file3.txt', data)
      await storage.get('/file1.txt') // Cache it
      await storage.get('/file2.txt') // Cache it

      await storage.deleteMany(['/file1.txt', '/file2.txt'])

      expect(bucket.has('/file1.txt')).toBe(false)
      expect(bucket.has('/file2.txt')).toBe(false)
      expect(bucket.has('/file3.txt')).toBe(true)
      expect(mockCache.deleteCount).toBe(2)
    })
  })

  describe('exists', () => {
    it('should return true for cached item', async () => {
      const data = new TextEncoder().encode('test')
      await bucket.put('/exists.txt', data)
      await storage.get('/exists.txt') // Cache it
      bucket.headCount = 0

      const result = await storage.exists('/exists.txt')

      expect(result).toBe(true)
      expect(bucket.headCount).toBe(0) // Should not hit R2
    })

    it('should check R2 on cache miss', async () => {
      const data = new TextEncoder().encode('test')
      await bucket.put('/exists.txt', data)
      bucket.headCount = 0

      const result = await storage.exists('/exists.txt')

      expect(result).toBe(true)
      expect(bucket.headCount).toBe(1)
    })

    it('should return false for non-existent item', async () => {
      const result = await storage.exists('/nonexistent.txt')

      expect(result).toBe(false)
    })
  })

  describe('head', () => {
    it('should return metadata from cache if available', async () => {
      const data = new TextEncoder().encode('test content')
      await bucket.put('/head.txt', data, {
        httpMetadata: { contentType: 'text/plain' },
        customMetadata: { key: 'value' },
      })
      await storage.get('/head.txt') // Cache it
      bucket.headCount = 0

      const result = await storage.head('/head.txt')

      expect(result).not.toBeNull()
      expect(result!.size).toBe(data.length)
      expect(bucket.headCount).toBe(0) // Should not hit R2
    })

    it('should fetch from R2 on cache miss', async () => {
      const data = new TextEncoder().encode('test content')
      await bucket.put('/head.txt', data, {
        httpMetadata: { contentType: 'text/plain' },
      })
      bucket.headCount = 0

      const result = await storage.head('/head.txt')

      expect(result).not.toBeNull()
      expect(result!.size).toBe(data.length)
      expect(result!.contentType).toBe('text/plain')
      expect(bucket.headCount).toBe(1)
    })

    it('should return null for non-existent item', async () => {
      const result = await storage.head('/nonexistent.txt')
      expect(result).toBeNull()
    })
  })

  describe('list', () => {
    beforeEach(async () => {
      const data = new TextEncoder().encode('test')
      await bucket.put('/docs/file1.txt', data)
      await bucket.put('/docs/file2.txt', data)
      await bucket.put('/images/photo.jpg', data)
    })

    it('should list all objects from R2', async () => {
      const result = await storage.list()

      expect(result.objects.length).toBe(3)
      expect(result.truncated).toBe(false)
    })

    it('should filter by prefix', async () => {
      const result = await storage.list({ prefix: '/docs/' })

      expect(result.objects.length).toBe(2)
      expect(result.objects.every(o => o.key.startsWith('/docs/'))).toBe(true)
    })

    it('should support pagination', async () => {
      const page1 = await storage.list({ limit: 2 })

      expect(page1.objects.length).toBe(2)
      expect(page1.truncated).toBe(true)
      expect(page1.cursor).toBeDefined()
    })
  })

  describe('copy', () => {
    it('should copy data in R2', async () => {
      const data = new TextEncoder().encode('content to copy')
      await bucket.put('/source.txt', data)

      const result = await storage.copy('/source.txt', '/dest.txt')

      expect(result.size).toBe(data.length)
      expect(bucket.has('/dest.txt')).toBe(true)

      const destData = bucket.getStoredData('/dest.txt')
      expect(new TextDecoder().decode(destData)).toBe('content to copy')
    })

    it('should throw when source does not exist', async () => {
      await expect(storage.copy('/nonexistent.txt', '/dest.txt')).rejects.toThrow('Source not found')
    })
  })

  describe('Cache-specific operations', () => {
    describe('invalidateCache', () => {
      it('should remove item from cache without affecting R2', async () => {
        const data = new TextEncoder().encode('test')
        await bucket.put('/cached.txt', data)
        await storage.get('/cached.txt') // Cache it

        await storage.invalidateCache('/cached.txt')

        expect(bucket.has('/cached.txt')).toBe(true) // R2 still has it
        expect(mockCache.deleteCount).toBe(1)
      })
    })

    describe('invalidateCacheMany', () => {
      it('should remove multiple items from cache', async () => {
        const data = new TextEncoder().encode('test')
        await bucket.put('/file1.txt', data)
        await bucket.put('/file2.txt', data)
        await storage.get('/file1.txt')
        await storage.get('/file2.txt')
        mockCache.deleteCount = 0

        await storage.invalidateCacheMany(['/file1.txt', '/file2.txt'])

        expect(mockCache.deleteCount).toBe(2)
      })
    })

    describe('warmCache', () => {
      it('should fetch and cache item if not cached', async () => {
        const data = new TextEncoder().encode('test')
        await bucket.put('/warm.txt', data)
        bucket.getCount = 0

        const result = await storage.warmCache('/warm.txt')

        expect(result).toBe(true)
        expect(bucket.getCount).toBe(1)
        expect(mockCache.putCount).toBe(1)
      })

      it('should return false if already cached', async () => {
        const data = new TextEncoder().encode('test')
        await bucket.put('/warm.txt', data)
        await storage.get('/warm.txt') // Cache it
        mockCache.putCount = 0

        const result = await storage.warmCache('/warm.txt')

        expect(result).toBe(false)
        expect(mockCache.putCount).toBe(0) // No new cache put
      })

      it('should return false if item does not exist', async () => {
        const result = await storage.warmCache('/nonexistent.txt')

        expect(result).toBe(false)
      })
    })

    describe('isCached', () => {
      it('should return true for cached items', async () => {
        const data = new TextEncoder().encode('test')
        await bucket.put('/cached.txt', data)
        await storage.get('/cached.txt') // Cache it

        const result = await storage.isCached('/cached.txt')

        expect(result).toBe(true)
      })

      it('should return false for non-cached items', async () => {
        const data = new TextEncoder().encode('test')
        await bucket.put('/notcached.txt', data)

        const result = await storage.isCached('/notcached.txt')

        expect(result).toBe(false)
      })
    })
  })

  describe('Prefix handling', () => {
    let prefixedStorage: R2CacheBlobStorage

    beforeEach(() => {
      prefixedStorage = new R2CacheBlobStorage({
        bucket: bucket as unknown as R2Bucket,
        cacheBaseUrl: 'https://fsx.cache/',
        prefix: 'tenant1/',
      })
    })

    it('should add prefix to R2 keys', async () => {
      const data = new TextEncoder().encode('prefixed')
      await prefixedStorage.put('/test.txt', data)

      expect(bucket.has('tenant1//test.txt')).toBe(true)
    })

    it('should add prefix when reading', async () => {
      await bucket.put('tenant1//test.txt', new TextEncoder().encode('prefixed content'))

      const result = await prefixedStorage.get('/test.txt')

      expect(result).not.toBeNull()
      expect(new TextDecoder().decode(result!.data)).toBe('prefixed content')
    })

    it('should add prefix to list operations', async () => {
      await bucket.put('tenant1/docs/file1.txt', new TextEncoder().encode('1'))
      await bucket.put('tenant1/docs/file2.txt', new TextEncoder().encode('2'))
      await bucket.put('tenant2/docs/file3.txt', new TextEncoder().encode('3'))

      const result = await prefixedStorage.list({ prefix: 'docs/' })

      expect(result.objects.length).toBe(2)
      expect(result.objects.every(o => o.key.startsWith('tenant1/docs/'))).toBe(true)
    })
  })

  describe('Metadata preservation', () => {
    it('should preserve metadata through cache', async () => {
      const data = new TextEncoder().encode('test')
      const customMetadata = { author: 'test-user', version: '1.0' }
      await bucket.put('/meta.txt', data, {
        httpMetadata: { contentType: 'text/plain' },
        customMetadata,
      })

      // First read - from R2, cached
      const result1 = await storage.get('/meta.txt')
      expect(result1!.metadata.contentType).toBe('text/plain')

      // Second read - from cache
      bucket.getCount = 0
      const result2 = await storage.get('/meta.txt')
      expect(bucket.getCount).toBe(0) // Cache hit
      expect(result2!.metadata.size).toBe(data.length)
      expect(result2!.metadata.etag).toBeDefined()
    })
  })

  describe('Instrumentation hooks', () => {
    it('should call hooks on operations', async () => {
      const onStart = vi.fn()
      const onEnd = vi.fn()

      const instrumentedStorage = new R2CacheBlobStorage({
        bucket: bucket as unknown as R2Bucket,
        cacheBaseUrl: 'https://fsx.cache/',
        hooks: {
          onOperationStart: onStart,
          onOperationEnd: onEnd,
        },
      })

      const data = new TextEncoder().encode('test')
      await instrumentedStorage.put('/test.txt', data)

      expect(onStart).toHaveBeenCalled()
      expect(onEnd).toHaveBeenCalled()

      const startCtx = onStart.mock.calls[0][0]
      expect(startCtx.operation).toBe('put')
      expect(startCtx.path).toBe('/test.txt')

      const endResult = onEnd.mock.calls[0][1]
      expect(endResult.success).toBe(true)
    })
  })
})

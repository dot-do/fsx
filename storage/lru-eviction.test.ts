/**
 * LRU Eviction Tests - Cold Pages from DO Storage to R2
 *
 * RED phase TDD tests for LRU eviction of cold pages from Durable Object
 * storage to R2. These tests define the expected behavior for:
 *
 * 1. Eviction triggers at threshold (e.g., 90% of maxHotPages)
 * 2. Correct pages evicted (oldest last_access_at first)
 * 3. Evicts down to target (e.g., 70% of maxHotPages)
 * 4. Page metadata updated to 'cold' tier
 * 5. DO storage keys deleted after eviction
 * 6. R2 storage keys created with page data
 * 7. No data loss during eviction (R2 write before DO delete)
 * 8. Eviction is idempotent (calling twice doesn't break anything)
 *
 * Issue: fsx-4wyw - [RED] LRU eviction from DO to R2
 *
 * @module storage/lru-eviction.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  LRUEvictionManagerImpl,
  type EvictionConfig,
  type PageMeta,
  type EvictionResult,
  type LRUEvictionManager,
} from './lru-eviction.js'

// =============================================================================
// Mock Implementations for Testing
// =============================================================================

/**
 * Mock DO Storage for testing.
 */
class MockDOStorage {
  private data = new Map<string, Uint8Array>()
  private pageMeta = new Map<string, PageMeta>()

  async get<T>(key: string): Promise<T | undefined> {
    if (key.startsWith('__page_meta__')) {
      return this.pageMeta.get(key) as T | undefined
    }
    return this.data.get(key) as T | undefined
  }

  async put(key: string, value: Uint8Array | PageMeta): Promise<void> {
    if (key.startsWith('__page_meta__')) {
      this.pageMeta.set(key, value as PageMeta)
    } else {
      this.data.set(key, value as Uint8Array)
    }
  }

  async delete(key: string): Promise<boolean> {
    if (key.startsWith('__page_meta__')) {
      return this.pageMeta.delete(key)
    }
    return this.data.delete(key)
  }

  async list(options?: { prefix?: string }): Promise<Map<string, unknown>> {
    const result = new Map<string, unknown>()
    const prefix = options?.prefix ?? ''

    for (const [key, value] of this.data) {
      if (key.startsWith(prefix)) {
        result.set(key, value)
      }
    }
    for (const [key, value] of this.pageMeta) {
      if (key.startsWith(prefix)) {
        result.set(key, value)
      }
    }
    return result
  }

  // Test helpers
  getPageCount(): number {
    let count = 0
    for (const key of this.data.keys()) {
      if (key.startsWith('__page__')) {
        count++
      }
    }
    return count
  }

  getAllPageMeta(): PageMeta[] {
    return Array.from(this.pageMeta.values())
  }

  clear(): void {
    this.data.clear()
    this.pageMeta.clear()
  }

  has(key: string): boolean {
    return this.data.has(key) || this.pageMeta.has(key)
  }
}

/**
 * Mock R2 Bucket for testing.
 */
class MockR2Bucket {
  private objects = new Map<string, { data: Uint8Array; metadata?: Record<string, string> }>()

  async put(key: string, value: Uint8Array | ArrayBuffer | ReadableStream, options?: { customMetadata?: Record<string, string> }): Promise<void> {
    let data: Uint8Array
    if (value instanceof Uint8Array) {
      data = value
    } else if (value instanceof ArrayBuffer) {
      data = new Uint8Array(value)
    } else {
      // ReadableStream
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
    }
    this.objects.set(key, { data, metadata: options?.customMetadata })
  }

  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const obj = this.objects.get(key)
    if (!obj) return null
    return {
      arrayBuffer: async () => obj.data.buffer.slice(obj.data.byteOffset, obj.data.byteOffset + obj.data.byteLength),
    }
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  async head(key: string): Promise<{ size: number } | null> {
    const obj = this.objects.get(key)
    if (!obj) return null
    return { size: obj.data.length }
  }

  // Test helpers
  has(key: string): boolean {
    return this.objects.has(key)
  }

  getKeys(): string[] {
    return Array.from(this.objects.keys())
  }

  clear(): void {
    this.objects.clear()
  }

  getData(key: string): Uint8Array | undefined {
    return this.objects.get(key)?.data
  }
}


// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Create a test page with data and metadata.
 */
function createTestPage(
  doStorage: MockDOStorage,
  pageId: string,
  blobId: string,
  pageIndex: number,
  lastAccessAt: number,
  tier: 'warm' | 'cold' = 'warm'
): { data: Uint8Array; meta: PageMeta } {
  const data = new Uint8Array(2 * 1024 * 1024) // 2MB page
  data.fill(pageIndex % 256)

  const meta: PageMeta = {
    pageId,
    blobId,
    pageIndex,
    size: data.length,
    tier,
    last_access_at: lastAccessAt,
    created_at: lastAccessAt - 1000,
  }

  // Store page data
  doStorage.put(`__page__${pageId}`, data)
  // Store page metadata
  doStorage.put(`__page_meta__${pageId}`, meta as unknown as Uint8Array)

  return { data, meta }
}

/**
 * Create multiple test pages with staggered access times.
 */
function createTestPages(
  doStorage: MockDOStorage,
  count: number,
  baseTime: number = Date.now()
): { pages: Array<{ data: Uint8Array; meta: PageMeta }> } {
  const pages: Array<{ data: Uint8Array; meta: PageMeta }> = []

  for (let i = 0; i < count; i++) {
    const pageId = `page-${i}`
    const blobId = `blob-${Math.floor(i / 3)}` // 3 pages per blob
    // Older pages have earlier timestamps
    const lastAccessAt = baseTime - (count - i) * 1000
    const page = createTestPage(doStorage, pageId, blobId, i, lastAccessAt)
    pages.push(page)
  }

  return { pages }
}

// =============================================================================
// Test Suite
// =============================================================================

describe('LRU Eviction Manager', () => {
  let doStorage: MockDOStorage
  let r2Bucket: MockR2Bucket
  let evictionManager: LRUEvictionManager
  let defaultConfig: EvictionConfig

  beforeEach(() => {
    doStorage = new MockDOStorage()
    r2Bucket = new MockR2Bucket()
    defaultConfig = {
      maxHotPages: 256, // 512MB at 2MB/page
      evictionThreshold: 0.9, // 90%
      evictionTarget: 0.7, // 70%
    }
    evictionManager = new LRUEvictionManagerImpl(doStorage, r2Bucket, defaultConfig)
  })

  describe('Configuration', () => {
    it('should use default configuration values', () => {
      const config = evictionManager.getConfig()

      expect(config.maxHotPages).toBe(256)
      expect(config.evictionThreshold).toBe(0.9)
      expect(config.evictionTarget).toBe(0.7)
    })

    it('should calculate threshold at 90% of maxHotPages (231 pages)', () => {
      const config = evictionManager.getConfig()
      const thresholdPages = Math.floor(config.maxHotPages * config.evictionThreshold)

      // 256 * 0.9 = 230.4, floor = 230
      expect(thresholdPages).toBe(230)
    })

    it('should calculate target at 70% of maxHotPages (179 pages)', () => {
      const config = evictionManager.getConfig()
      const targetPages = Math.floor(config.maxHotPages * config.evictionTarget)

      // 256 * 0.7 = 179.2, floor = 179
      expect(targetPages).toBe(179)
    })
  })

  describe('Hot Page Count Tracking', () => {
    it('should return 0 when no pages exist', async () => {
      const count = await evictionManager.getHotPageCount()
      expect(count).toBe(0)
    })

    it('should count only warm tier pages in DO storage', async () => {
      // Create 10 warm pages
      createTestPages(doStorage, 10)

      const count = await evictionManager.getHotPageCount()
      expect(count).toBe(10)
    })

    it('should not count cold tier pages', async () => {
      const baseTime = Date.now()
      // Create 5 warm pages
      for (let i = 0; i < 5; i++) {
        createTestPage(doStorage, `warm-${i}`, 'blob-1', i, baseTime - i * 1000, 'warm')
      }
      // Create 3 cold pages (shouldn't be counted)
      for (let i = 0; i < 3; i++) {
        createTestPage(doStorage, `cold-${i}`, 'blob-2', i, baseTime - i * 1000, 'cold')
      }

      const count = await evictionManager.getHotPageCount()
      expect(count).toBe(5)
    })
  })

  describe('Eviction Trigger Detection', () => {
    it('should not trigger eviction when below threshold', async () => {
      // Create 100 pages (below 230 threshold)
      createTestPages(doStorage, 100)

      const shouldEvict = await evictionManager.shouldEvict()
      expect(shouldEvict).toBe(false)
    })

    it('should trigger eviction when at threshold (231 pages)', async () => {
      // Create 231 pages (at 90% of 256)
      createTestPages(doStorage, 231)

      const shouldEvict = await evictionManager.shouldEvict()
      expect(shouldEvict).toBe(true)
    })

    it('should trigger eviction when above threshold', async () => {
      // Create 250 pages (above 90% threshold)
      createTestPages(doStorage, 250)

      const shouldEvict = await evictionManager.shouldEvict()
      expect(shouldEvict).toBe(true)
    })

    it('should trigger eviction at exactly maxHotPages', async () => {
      // Create exactly 256 pages
      createTestPages(doStorage, 256)

      const shouldEvict = await evictionManager.shouldEvict()
      expect(shouldEvict).toBe(true)
    })
  })

  describe('Coldest Pages Selection', () => {
    it('should return pages sorted by last_access_at (oldest first)', async () => {
      const baseTime = Date.now()
      // Create pages with known access times
      createTestPage(doStorage, 'page-new', 'blob-1', 0, baseTime)
      createTestPage(doStorage, 'page-mid', 'blob-1', 1, baseTime - 5000)
      createTestPage(doStorage, 'page-old', 'blob-1', 2, baseTime - 10000)

      const coldest = await evictionManager.getColdestPages(3)

      expect(coldest).toHaveLength(3)
      expect(coldest[0].pageId).toBe('page-old')
      expect(coldest[1].pageId).toBe('page-mid')
      expect(coldest[2].pageId).toBe('page-new')
    })

    it('should respect the limit parameter', async () => {
      createTestPages(doStorage, 100)

      const coldest = await evictionManager.getColdestPages(10)

      expect(coldest).toHaveLength(10)
    })

    it('should return empty array when no pages exist', async () => {
      const coldest = await evictionManager.getColdestPages(10)
      expect(coldest).toHaveLength(0)
    })

    it('should only return warm tier pages', async () => {
      const baseTime = Date.now()
      // Create warm and cold pages
      createTestPage(doStorage, 'warm-1', 'blob-1', 0, baseTime - 1000, 'warm')
      createTestPage(doStorage, 'cold-1', 'blob-1', 1, baseTime - 5000, 'cold') // Older but cold
      createTestPage(doStorage, 'warm-2', 'blob-1', 2, baseTime - 2000, 'warm')

      const coldest = await evictionManager.getColdestPages(10)

      expect(coldest).toHaveLength(2)
      expect(coldest.every(p => p.tier === 'warm')).toBe(true)
    })
  })

  describe('Eviction to Target', () => {
    it('should evict down to target (70% = 179 pages)', async () => {
      // Create 250 pages (above threshold)
      createTestPages(doStorage, 250)

      const result = await evictionManager.runEviction()

      // Should have evicted 250 - 179 = 71 pages
      expect(result.evictedCount).toBe(71)
      expect(result.evictedPageIds).toHaveLength(71)

      // Verify final count is at target
      const finalCount = await evictionManager.getHotPageCount()
      expect(finalCount).toBe(179)
    })

    it('should evict the oldest pages first', async () => {
      const baseTime = Date.now()
      // Create 10 pages with known access times
      for (let i = 0; i < 10; i++) {
        createTestPage(doStorage, `page-${i}`, 'blob-1', i, baseTime - i * 1000)
      }

      // Use a small config for this test
      const smallConfig: EvictionConfig = {
        maxHotPages: 10,
        evictionThreshold: 0.8, // 8 pages
        evictionTarget: 0.5, // 5 pages
      }
      const smallEvictionManager = new LRUEvictionManagerImpl(doStorage, r2Bucket, smallConfig)

      const result = await smallEvictionManager.runEviction()

      // Should evict 5 oldest pages (10 - 5 = 5)
      expect(result.evictedCount).toBe(5)

      // The evicted pages should be the oldest ones (page-9 through page-5)
      expect(result.evictedPageIds).toContain('page-9')
      expect(result.evictedPageIds).toContain('page-8')
      expect(result.evictedPageIds).toContain('page-7')
      expect(result.evictedPageIds).toContain('page-6')
      expect(result.evictedPageIds).toContain('page-5')
    })

    it('should not evict when below threshold', async () => {
      // Create 100 pages (well below 230 threshold)
      createTestPages(doStorage, 100)

      const result = await evictionManager.runEviction()

      expect(result.evictedCount).toBe(0)
      expect(result.evictedPageIds).toHaveLength(0)
    })
  })

  describe('Page Metadata Updates', () => {
    it('should update page tier from warm to cold after eviction', async () => {
      const baseTime = Date.now()
      createTestPage(doStorage, 'test-page', 'blob-1', 0, baseTime - 10000)

      await evictionManager.evictPage('test-page')

      const meta = await evictionManager.getPageMeta('test-page')
      expect(meta).not.toBeNull()
      expect(meta!.tier).toBe('cold')
    })

    it('should preserve other metadata fields during eviction', async () => {
      const baseTime = Date.now()
      const { meta: originalMeta } = createTestPage(doStorage, 'test-page', 'blob-1', 5, baseTime - 10000)

      await evictionManager.evictPage('test-page')

      const meta = await evictionManager.getPageMeta('test-page')
      expect(meta).not.toBeNull()
      expect(meta!.pageId).toBe(originalMeta.pageId)
      expect(meta!.blobId).toBe(originalMeta.blobId)
      expect(meta!.pageIndex).toBe(originalMeta.pageIndex)
      expect(meta!.size).toBe(originalMeta.size)
      expect(meta!.created_at).toBe(originalMeta.created_at)
    })
  })

  describe('DO Storage Deletion', () => {
    it('should delete page data from DO storage after eviction', async () => {
      const baseTime = Date.now()
      createTestPage(doStorage, 'test-page', 'blob-1', 0, baseTime)

      // Verify page exists in DO
      expect(doStorage.has('__page__test-page')).toBe(true)

      await evictionManager.evictPage('test-page')

      // Page data should be deleted from DO
      expect(doStorage.has('__page__test-page')).toBe(false)
    })

    it('should keep page metadata in DO after eviction (with updated tier)', async () => {
      const baseTime = Date.now()
      createTestPage(doStorage, 'test-page', 'blob-1', 0, baseTime)

      await evictionManager.evictPage('test-page')

      // Metadata should still exist (for tracking which tier the page is in)
      const meta = await evictionManager.getPageMeta('test-page')
      expect(meta).not.toBeNull()
    })
  })

  describe('R2 Storage Creation', () => {
    it('should create page in R2 storage during eviction', async () => {
      const baseTime = Date.now()
      createTestPage(doStorage, 'test-page', 'blob-1', 0, baseTime)

      // Verify page not in R2 initially
      expect(r2Bucket.has('__page__test-page')).toBe(false)

      await evictionManager.evictPage('test-page')

      // Page should now exist in R2
      expect(r2Bucket.has('__page__test-page')).toBe(true)
    })

    it('should preserve page data integrity during eviction', async () => {
      const baseTime = Date.now()
      const { data: originalData } = createTestPage(doStorage, 'test-page', 'blob-1', 42, baseTime)

      await evictionManager.evictPage('test-page')

      // Get data from R2 and verify it matches
      const r2Data = r2Bucket.getData('__page__test-page')
      expect(r2Data).toBeDefined()
      expect(r2Data!.length).toBe(originalData.length)
      expect(r2Data).toEqual(originalData)
    })
  })

  describe('No Data Loss During Eviction', () => {
    it('should write to R2 before deleting from DO', async () => {
      const baseTime = Date.now()
      createTestPage(doStorage, 'test-page', 'blob-1', 0, baseTime)

      // Track operation order
      const operations: string[] = []
      const originalR2Put = r2Bucket.put.bind(r2Bucket)
      const originalDODelete = doStorage.delete.bind(doStorage)

      r2Bucket.put = async (...args) => {
        operations.push('r2-put')
        return originalR2Put(...args)
      }

      doStorage.delete = async (...args) => {
        operations.push('do-delete')
        return originalDODelete(...args)
      }

      await evictionManager.evictPage('test-page')

      // R2 put should come before DO delete
      const r2PutIndex = operations.indexOf('r2-put')
      const doDeleteIndex = operations.indexOf('do-delete')

      expect(r2PutIndex).toBeGreaterThanOrEqual(0)
      expect(doDeleteIndex).toBeGreaterThanOrEqual(0)
      expect(r2PutIndex).toBeLessThan(doDeleteIndex)
    })

    it('should not delete from DO if R2 write fails', async () => {
      const baseTime = Date.now()
      createTestPage(doStorage, 'test-page', 'blob-1', 0, baseTime)

      // Make R2 put fail
      r2Bucket.put = async () => {
        throw new Error('R2 write failed')
      }

      // Eviction should fail
      await expect(evictionManager.evictPage('test-page')).rejects.toThrow('R2 write failed')

      // Page should still exist in DO
      expect(doStorage.has('__page__test-page')).toBe(true)
    })

    it('should handle partial eviction failure gracefully', async () => {
      const baseTime = Date.now()
      // Create 10 pages
      for (let i = 0; i < 10; i++) {
        createTestPage(doStorage, `page-${i}`, 'blob-1', i, baseTime - i * 1000)
      }

      // Make R2 fail for specific pages
      const failingPages = ['page-3', 'page-7']
      const originalR2Put = r2Bucket.put.bind(r2Bucket)
      r2Bucket.put = async (key, ...args) => {
        if (failingPages.some(p => key.includes(p))) {
          throw new Error(`R2 write failed for ${key}`)
        }
        return originalR2Put(key, ...args)
      }

      // Use small config to trigger eviction
      const smallConfig: EvictionConfig = {
        maxHotPages: 10,
        evictionThreshold: 0.8,
        evictionTarget: 0.3, // Try to evict 7 pages
      }
      const smallEvictionManager = new LRUEvictionManagerImpl(doStorage, r2Bucket, smallConfig)

      const result = await smallEvictionManager.runEviction()

      // Should report errors for failed pages
      expect(result.errors.length).toBeGreaterThan(0)

      // Failed pages should still be in DO
      expect(doStorage.has('__page__page-3')).toBe(true)
      expect(doStorage.has('__page__page-7')).toBe(true)
    })
  })

  describe('Eviction Idempotency', () => {
    it('should be safe to call runEviction multiple times', async () => {
      // Create pages at threshold
      createTestPages(doStorage, 231)

      // First eviction
      const result1 = await evictionManager.runEviction()
      const countAfterFirst = await evictionManager.getHotPageCount()

      // Second eviction (should be no-op since we're at target)
      const result2 = await evictionManager.runEviction()
      const countAfterSecond = await evictionManager.getHotPageCount()

      expect(countAfterFirst).toBe(179)
      expect(countAfterSecond).toBe(179)
      expect(result2.evictedCount).toBe(0)
    })

    it('should not double-evict the same page', async () => {
      const baseTime = Date.now()
      createTestPage(doStorage, 'test-page', 'blob-1', 0, baseTime)

      // First eviction
      await evictionManager.evictPage('test-page')
      const meta1 = await evictionManager.getPageMeta('test-page')

      // Second eviction attempt (should be no-op or throw)
      // The page is already cold, so evicting again should not cause issues
      await evictionManager.evictPage('test-page')
      const meta2 = await evictionManager.getPageMeta('test-page')

      expect(meta1!.tier).toBe('cold')
      expect(meta2!.tier).toBe('cold')
    })

    it('should handle concurrent eviction attempts safely', async () => {
      createTestPages(doStorage, 250)

      // Run multiple evictions concurrently
      const results = await Promise.all([
        evictionManager.runEviction(),
        evictionManager.runEviction(),
        evictionManager.runEviction(),
      ])

      // Total evicted should be around 71 (250 - 179)
      const totalEvicted = results.reduce((sum, r) => sum + r.evictedCount, 0)

      // Final count should be at target
      const finalCount = await evictionManager.getHotPageCount()
      expect(finalCount).toBe(179)

      // One of the evictions should have done the work
      expect(totalEvicted).toBeGreaterThanOrEqual(71)
    })
  })

  describe('Touch Page (Access Update)', () => {
    it('should update last_access_at when page is touched', async () => {
      const baseTime = Date.now() - 10000
      createTestPage(doStorage, 'test-page', 'blob-1', 0, baseTime)

      const before = Date.now()
      await evictionManager.touchPage('test-page')
      const after = Date.now()

      const meta = await evictionManager.getPageMeta('test-page')
      expect(meta!.last_access_at).toBeGreaterThanOrEqual(before)
      expect(meta!.last_access_at).toBeLessThanOrEqual(after)
    })

    it('should make recently touched pages less likely to be evicted', async () => {
      const baseTime = Date.now()
      // Create 10 pages with page-0 being the oldest
      for (let i = 0; i < 10; i++) {
        createTestPage(doStorage, `page-${i}`, 'blob-1', i, baseTime - (10 - i) * 1000)
      }

      // Touch the oldest page (page-0) to make it recent
      await evictionManager.touchPage('page-0')

      // Get coldest pages
      const coldest = await evictionManager.getColdestPages(3)

      // page-0 should no longer be among the coldest
      expect(coldest.map(p => p.pageId)).not.toContain('page-0')
    })
  })

  describe('Edge Cases', () => {
    it('should handle empty storage gracefully', async () => {
      const count = await evictionManager.getHotPageCount()
      expect(count).toBe(0)

      const shouldEvict = await evictionManager.shouldEvict()
      expect(shouldEvict).toBe(false)

      const result = await evictionManager.runEviction()
      expect(result.evictedCount).toBe(0)
    })

    it('should handle evicting a non-existent page', async () => {
      await expect(evictionManager.evictPage('non-existent')).rejects.toThrow()
    })

    it('should handle touching a non-existent page', async () => {
      await expect(evictionManager.touchPage('non-existent')).rejects.toThrow()
    })

    it('should handle pages with identical access times', async () => {
      const baseTime = Date.now()
      // Create pages with same access time
      for (let i = 0; i < 5; i++) {
        createTestPage(doStorage, `page-${i}`, 'blob-1', i, baseTime)
      }

      const coldest = await evictionManager.getColdestPages(3)

      // Should still return 3 pages (order may be arbitrary for same timestamp)
      expect(coldest).toHaveLength(3)
    })

    it('should handle very large page counts', async () => {
      // Create more pages than maxHotPages
      createTestPages(doStorage, 300)

      const count = await evictionManager.getHotPageCount()
      expect(count).toBe(300)

      const shouldEvict = await evictionManager.shouldEvict()
      expect(shouldEvict).toBe(true)
    })
  })

  describe('Performance Metrics', () => {
    it('should report eviction duration', async () => {
      createTestPages(doStorage, 250)

      const result = await evictionManager.runEviction()

      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('should report individual page IDs that were evicted', async () => {
      createTestPages(doStorage, 250)

      const result = await evictionManager.runEviction()

      expect(result.evictedPageIds).toHaveLength(result.evictedCount)
      result.evictedPageIds.forEach(id => {
        expect(typeof id).toBe('string')
        expect(id.length).toBeGreaterThan(0)
      })
    })
  })
})

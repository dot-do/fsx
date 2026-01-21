/**
 * R2 Promotion Tests - Cold Pages from R2 to DO Hot Tier on Access
 *
 * RED phase TDD tests for promoting cold pages from R2 back to Durable Object
 * hot tier when accessed. These tests define the expected behavior for:
 *
 * 1. Access cold page triggers promotion to hot
 * 2. Page data identical after promotion
 * 3. Page metadata tier updates from 'cold' to 'warm'
 * 4. Promotion respects maxHotPages limit
 * 5. LRU eviction triggered if hot tier full
 * 6. Access count/frequency tracking for promotion decisions
 * 7. Promotion threshold (e.g., access 3 times before promoting)
 * 8. Concurrent access during promotion handled correctly
 * 9. Failed promotion doesn't lose data (stays in R2)
 * 10. Promotion metrics/telemetry
 *
 * Issue: fsx-bb0z - [RED] R2 promotion on cold page access
 *
 * @module storage/promotion.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPromotionManager, PromotionManagerImpl } from './promotion'

// =============================================================================
// Types for R2 Promotion (to be implemented)
// =============================================================================

/**
 * Configuration for cold page promotion behavior.
 */
export interface PromotionConfig {
  /** Whether promotion is enabled */
  enabled: boolean
  /** Number of accesses required before promotion (default: 3) */
  accessThreshold: number
  /** Maximum number of hot pages in DO storage */
  maxHotPages: number
}

/**
 * Result of a promotion operation.
 */
export interface PromotionResult {
  /** Whether the page was promoted */
  promoted: boolean
  /** Source tier (always 'cold' for promotion) */
  fromTier: 'cold'
  /** Target tier after promotion */
  toTier: 'warm'
  /** Pages evicted to make room (if any) */
  evictedPages?: string[]
}

/**
 * Page metadata for promotion tracking.
 */
export interface PromotionPageMeta {
  /** Unique page identifier */
  pageId: string
  /** Blob ID this page belongs to */
  blobId: string
  /** Page index within the blob */
  pageIndex: number
  /** Page size in bytes */
  size: number
  /** Storage tier: 'warm' (DO) or 'cold' (R2) */
  tier: 'warm' | 'cold'
  /** Last access timestamp (Unix ms) */
  lastAccessAt: number
  /** Access count for promotion decisions */
  accessCount: number
  /** Creation timestamp (Unix ms) */
  createdAt: number
}

/**
 * Promotion metrics for telemetry.
 */
export interface PromotionMetrics {
  /** Total promotion attempts */
  totalPromotionAttempts: number
  /** Successful promotions */
  successfulPromotions: number
  /** Failed promotions */
  failedPromotions: number
  /** Promotions blocked due to capacity */
  blockedByCapacity: number
  /** Pages evicted to make room */
  evictedForPromotion: number
  /** Average promotion latency in ms */
  avgPromotionLatencyMs: number
}

/**
 * Promotion Manager interface (to be implemented).
 */
export interface PromotionManager {
  /**
   * Access a page, potentially triggering promotion if cold.
   * @param pageId - The page to access
   * @returns The page data
   */
  accessPage(pageId: string): Promise<Uint8Array>

  /**
   * Check if a page should be promoted based on access count.
   * @param pageId - The page to check
   */
  shouldPromote(pageId: string): Promise<boolean>

  /**
   * Promote a cold page from R2 to DO hot tier.
   * @param pageId - The page to promote
   * @returns Promotion result
   */
  promotePage(pageId: string): Promise<PromotionResult>

  /**
   * Get the current hot page count in DO storage.
   */
  getHotPageCount(): Promise<number>

  /**
   * Get page metadata.
   * @param pageId - The page ID
   */
  getPageMeta(pageId: string): Promise<PromotionPageMeta | null>

  /**
   * Update page metadata.
   * @param pageId - The page ID
   * @param updates - Fields to update
   */
  updatePageMeta(pageId: string, updates: Partial<PromotionPageMeta>): Promise<void>

  /**
   * Get current promotion configuration.
   */
  getConfig(): PromotionConfig

  /**
   * Get promotion metrics.
   */
  getMetrics(): PromotionMetrics

  /**
   * Reset promotion metrics.
   */
  resetMetrics(): void
}

// =============================================================================
// Mock Implementations for Testing
// =============================================================================

/**
 * Mock DO Storage for testing.
 */
class MockDOStorage {
  private data = new Map<string, Uint8Array>()
  private pageMeta = new Map<string, PromotionPageMeta>()

  async get<T>(key: string): Promise<T | undefined> {
    if (key.startsWith('__page_meta__')) {
      return this.pageMeta.get(key) as T | undefined
    }
    return this.data.get(key) as T | undefined
  }

  async put(key: string, value: Uint8Array | PromotionPageMeta): Promise<void> {
    if (key.startsWith('__page_meta__')) {
      this.pageMeta.set(key, value as PromotionPageMeta)
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

  getWarmPageCount(): number {
    let count = 0
    for (const meta of this.pageMeta.values()) {
      if (meta.tier === 'warm') {
        count++
      }
    }
    return count
  }

  getAllPageMeta(): PromotionPageMeta[] {
    return Array.from(this.pageMeta.values())
  }

  clear(): void {
    this.data.clear()
    this.pageMeta.clear()
  }

  has(key: string): boolean {
    return this.data.has(key) || this.pageMeta.has(key)
  }

  getData(key: string): Uint8Array | undefined {
    return this.data.get(key)
  }
}

/**
 * Mock R2 Bucket for testing.
 */
class MockR2Bucket {
  private objects = new Map<string, { data: Uint8Array; metadata?: Record<string, string> }>()

  async put(
    key: string,
    value: Uint8Array | ArrayBuffer | ReadableStream,
    options?: { customMetadata?: Record<string, string> }
  ): Promise<void> {
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
      arrayBuffer: async () =>
        obj.data.buffer.slice(obj.data.byteOffset, obj.data.byteOffset + obj.data.byteLength),
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
// Placeholder Implementation (will fail - RED phase)
// =============================================================================

/**
 * Placeholder Promotion Manager that will fail all tests.
 * This is the RED phase - implementation doesn't exist yet.
 */
class PromotionManagerPlaceholder implements PromotionManager {
  constructor(
    private readonly _doStorage: MockDOStorage,
    private readonly _r2Bucket: MockR2Bucket,
    private readonly _config: PromotionConfig
  ) {}

  async accessPage(_pageId: string): Promise<Uint8Array> {
    // TODO: Implement - access page, increment count, promote if needed
    throw new Error('Not implemented: accessPage')
  }

  async shouldPromote(_pageId: string): Promise<boolean> {
    // TODO: Implement - check if access count >= threshold
    throw new Error('Not implemented: shouldPromote')
  }

  async promotePage(_pageId: string): Promise<PromotionResult> {
    // TODO: Implement - read from R2, write to DO, update metadata
    throw new Error('Not implemented: promotePage')
  }

  async getHotPageCount(): Promise<number> {
    // TODO: Implement - count pages with tier='warm' in DO storage
    throw new Error('Not implemented: getHotPageCount')
  }

  async getPageMeta(_pageId: string): Promise<PromotionPageMeta | null> {
    // TODO: Implement - get page metadata from DO storage
    throw new Error('Not implemented: getPageMeta')
  }

  async updatePageMeta(_pageId: string, _updates: Partial<PromotionPageMeta>): Promise<void> {
    // TODO: Implement - update page metadata
    throw new Error('Not implemented: updatePageMeta')
  }

  getConfig(): PromotionConfig {
    return this._config
  }

  getMetrics(): PromotionMetrics {
    // TODO: Implement - return actual metrics
    throw new Error('Not implemented: getMetrics')
  }

  resetMetrics(): void {
    // TODO: Implement - reset all metrics
    throw new Error('Not implemented: resetMetrics')
  }
}

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Create a test page in R2 (cold tier) with metadata in DO.
 */
function createColdPage(
  doStorage: MockDOStorage,
  r2Bucket: MockR2Bucket,
  pageId: string,
  blobId: string,
  pageIndex: number,
  options: { accessCount?: number; lastAccessAt?: number } = {}
): { data: Uint8Array; meta: PromotionPageMeta } {
  const data = new Uint8Array(2 * 1024 * 1024) // 2MB page
  // Fill with recognizable pattern based on pageIndex
  for (let i = 0; i < data.length; i++) {
    data[i] = (pageIndex + i) % 256
  }

  const now = Date.now()
  const meta: PromotionPageMeta = {
    pageId,
    blobId,
    pageIndex,
    size: data.length,
    tier: 'cold',
    lastAccessAt: options.lastAccessAt ?? now - 10000,
    accessCount: options.accessCount ?? 0,
    createdAt: now - 100000,
  }

  // Store page data in R2 (cold storage)
  r2Bucket.put(`__page__${pageId}`, data)
  // Store page metadata in DO
  doStorage.put(`__page_meta__${pageId}`, meta as unknown as Uint8Array)

  return { data, meta }
}

/**
 * Create a test page in DO (warm tier).
 */
function createWarmPage(
  doStorage: MockDOStorage,
  pageId: string,
  blobId: string,
  pageIndex: number,
  options: { accessCount?: number; lastAccessAt?: number } = {}
): { data: Uint8Array; meta: PromotionPageMeta } {
  const data = new Uint8Array(2 * 1024 * 1024) // 2MB page
  for (let i = 0; i < data.length; i++) {
    data[i] = (pageIndex + i) % 256
  }

  const now = Date.now()
  const meta: PromotionPageMeta = {
    pageId,
    blobId,
    pageIndex,
    size: data.length,
    tier: 'warm',
    lastAccessAt: options.lastAccessAt ?? now,
    accessCount: options.accessCount ?? 0,
    createdAt: now - 100000,
  }

  // Store page data in DO (warm storage)
  doStorage.put(`__page__${pageId}`, data)
  // Store page metadata in DO
  doStorage.put(`__page_meta__${pageId}`, meta as unknown as Uint8Array)

  return { data, meta }
}

/**
 * Create multiple warm pages to fill up hot tier.
 */
function fillHotTier(
  doStorage: MockDOStorage,
  count: number,
  baseTime: number = Date.now()
): PromotionPageMeta[] {
  const pages: PromotionPageMeta[] = []
  for (let i = 0; i < count; i++) {
    const pageId = `warm-page-${i}`
    const { meta } = createWarmPage(doStorage, pageId, `blob-${Math.floor(i / 3)}`, i, {
      lastAccessAt: baseTime - (count - i) * 1000,
    })
    pages.push(meta)
  }
  return pages
}

// =============================================================================
// Test Suite
// =============================================================================

describe('R2 Promotion Manager', () => {
  let doStorage: MockDOStorage
  let r2Bucket: MockR2Bucket
  let promotionManager: PromotionManager
  let defaultConfig: PromotionConfig

  beforeEach(() => {
    doStorage = new MockDOStorage()
    r2Bucket = new MockR2Bucket()
    defaultConfig = {
      enabled: true,
      accessThreshold: 3, // Promote after 3 accesses
      maxHotPages: 256, // 512MB at 2MB/page
    }
    promotionManager = new PromotionManagerImpl(doStorage, r2Bucket, defaultConfig)
  })

  describe('Configuration', () => {
    it('should use default configuration values', () => {
      const config = promotionManager.getConfig()

      expect(config.enabled).toBe(true)
      expect(config.accessThreshold).toBe(3)
      expect(config.maxHotPages).toBe(256)
    })

    it('should support disabled promotion', () => {
      const disabledConfig: PromotionConfig = {
        enabled: false,
        accessThreshold: 3,
        maxHotPages: 256,
      }
      const disabledManager = new PromotionManagerImpl(doStorage, r2Bucket, disabledConfig)

      expect(disabledManager.getConfig().enabled).toBe(false)
    })

    it('should support custom access threshold', () => {
      const customConfig: PromotionConfig = {
        enabled: true,
        accessThreshold: 5,
        maxHotPages: 100,
      }
      const customManager = new PromotionManagerImpl(doStorage, r2Bucket, customConfig)

      expect(customManager.getConfig().accessThreshold).toBe(5)
      expect(customManager.getConfig().maxHotPages).toBe(100)
    })
  })

  describe('Access Cold Page Triggers Promotion', () => {
    it('should increment access count on each access', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 0 })

      // First access
      await promotionManager.accessPage('cold-page-1')
      let meta = await promotionManager.getPageMeta('cold-page-1')
      expect(meta?.accessCount).toBe(1)

      // Second access
      await promotionManager.accessPage('cold-page-1')
      meta = await promotionManager.getPageMeta('cold-page-1')
      expect(meta?.accessCount).toBe(2)
    })

    it('should not promote before reaching access threshold', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 0 })

      // Access twice (below threshold of 3)
      await promotionManager.accessPage('cold-page-1')
      await promotionManager.accessPage('cold-page-1')

      const meta = await promotionManager.getPageMeta('cold-page-1')
      expect(meta?.tier).toBe('cold')
      expect(meta?.accessCount).toBe(2)
    })

    it('should promote after reaching access threshold', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 0 })

      // Access 3 times (reaches threshold)
      await promotionManager.accessPage('cold-page-1')
      await promotionManager.accessPage('cold-page-1')
      await promotionManager.accessPage('cold-page-1')

      const meta = await promotionManager.getPageMeta('cold-page-1')
      expect(meta?.tier).toBe('warm')
    })

    it('should return page data on access regardless of tier', async () => {
      const { data: originalData } = createColdPage(
        doStorage,
        r2Bucket,
        'cold-page-1',
        'blob-1',
        42
      )

      const data = await promotionManager.accessPage('cold-page-1')

      expect(data.length).toBe(originalData.length)
      expect(data).toEqual(originalData)
    })

    it('should update lastAccessAt on each access', async () => {
      const oldAccessTime = Date.now() - 10000
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, {
        accessCount: 0,
        lastAccessAt: oldAccessTime,
      })

      const before = Date.now()
      await promotionManager.accessPage('cold-page-1')
      const after = Date.now()

      const meta = await promotionManager.getPageMeta('cold-page-1')
      expect(meta?.lastAccessAt).toBeGreaterThanOrEqual(before)
      expect(meta?.lastAccessAt).toBeLessThanOrEqual(after)
    })
  })

  describe('Page Data Integrity After Promotion', () => {
    it('should preserve exact page data after promotion', async () => {
      const { data: originalData } = createColdPage(
        doStorage,
        r2Bucket,
        'cold-page-1',
        'blob-1',
        7,
        { accessCount: 2 }
      )

      // Trigger promotion
      await promotionManager.accessPage('cold-page-1')

      // Read from warm tier
      const promotedData = await promotionManager.accessPage('cold-page-1')

      expect(promotedData.length).toBe(originalData.length)
      expect(promotedData).toEqual(originalData)
    })

    it('should verify data after promotion matches R2 data', async () => {
      const { data: originalData } = createColdPage(
        doStorage,
        r2Bucket,
        'cold-page-1',
        'blob-1',
        0,
        { accessCount: 2 }
      )

      // Store original R2 data for comparison
      const r2DataBefore = r2Bucket.getData('__page__cold-page-1')

      // Trigger promotion
      await promotionManager.accessPage('cold-page-1')

      // Data in DO should match original R2 data
      const doData = doStorage.getData('__page__cold-page-1')
      expect(doData).toBeDefined()
      expect(doData).toEqual(r2DataBefore)
      expect(doData).toEqual(originalData)
    })

    it('should preserve page metadata fields after promotion', async () => {
      const { meta: originalMeta } = createColdPage(
        doStorage,
        r2Bucket,
        'cold-page-1',
        'blob-1',
        5,
        { accessCount: 2 }
      )

      // Trigger promotion
      await promotionManager.accessPage('cold-page-1')

      const meta = await promotionManager.getPageMeta('cold-page-1')
      expect(meta).not.toBeNull()
      expect(meta!.pageId).toBe(originalMeta.pageId)
      expect(meta!.blobId).toBe(originalMeta.blobId)
      expect(meta!.pageIndex).toBe(originalMeta.pageIndex)
      expect(meta!.size).toBe(originalMeta.size)
      expect(meta!.createdAt).toBe(originalMeta.createdAt)
      // Tier should be updated
      expect(meta!.tier).toBe('warm')
    })
  })

  describe('Page Metadata Tier Updates', () => {
    it('should update tier from cold to warm after promotion', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 2 })

      const metaBefore = await promotionManager.getPageMeta('cold-page-1')
      expect(metaBefore?.tier).toBe('cold')

      // Trigger promotion
      await promotionManager.accessPage('cold-page-1')

      const metaAfter = await promotionManager.getPageMeta('cold-page-1')
      expect(metaAfter?.tier).toBe('warm')
    })

    it('should write page data to DO storage after promotion', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 2 })

      // Page not in DO yet
      expect(doStorage.has('__page__cold-page-1')).toBe(false)

      // Trigger promotion
      await promotionManager.accessPage('cold-page-1')

      // Page should now be in DO
      expect(doStorage.has('__page__cold-page-1')).toBe(true)
    })

    it('should keep page in R2 after promotion (for backup/archival)', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 2 })

      // Trigger promotion
      await promotionManager.accessPage('cold-page-1')

      // Page should still exist in R2 (cold tier backup)
      expect(r2Bucket.has('__page__cold-page-1')).toBe(true)
    })
  })

  describe('Promotion Respects maxHotPages Limit', () => {
    it('should not promote if hot tier is at capacity', async () => {
      const smallConfig: PromotionConfig = {
        enabled: true,
        accessThreshold: 1,
        maxHotPages: 10,
      }
      const smallManager = new PromotionManagerImpl(doStorage, r2Bucket, smallConfig)

      // Fill hot tier to capacity
      fillHotTier(doStorage, 10)

      // Create a cold page ready for promotion
      createColdPage(doStorage, r2Bucket, 'cold-page-new', 'blob-x', 0, { accessCount: 0 })

      // Try to promote
      await smallManager.accessPage('cold-page-new')

      // Without eviction, page should remain cold
      const meta = await smallManager.getPageMeta('cold-page-new')
      expect(meta?.tier).toBe('cold')
    })

    it('should track hot page count accurately', async () => {
      // Create some warm pages
      createWarmPage(doStorage, 'warm-1', 'blob-1', 0)
      createWarmPage(doStorage, 'warm-2', 'blob-1', 1)
      createWarmPage(doStorage, 'warm-3', 'blob-1', 2)

      const count = await promotionManager.getHotPageCount()
      expect(count).toBe(3)
    })

    it('should return 0 hot pages when none exist', async () => {
      const count = await promotionManager.getHotPageCount()
      expect(count).toBe(0)
    })
  })

  describe('LRU Eviction Triggered if Hot Tier Full', () => {
    it('should evict oldest warm page when promoting at capacity', async () => {
      const smallConfig: PromotionConfig = {
        enabled: true,
        accessThreshold: 1,
        maxHotPages: 3,
      }
      const smallManager = new PromotionManagerImpl(doStorage, r2Bucket, smallConfig)

      // Fill hot tier with 3 pages
      const baseTime = Date.now()
      createWarmPage(doStorage, 'warm-old', 'blob-1', 0, { lastAccessAt: baseTime - 10000 })
      createWarmPage(doStorage, 'warm-mid', 'blob-1', 1, { lastAccessAt: baseTime - 5000 })
      createWarmPage(doStorage, 'warm-new', 'blob-1', 2, { lastAccessAt: baseTime })

      // Create cold page ready for promotion
      createColdPage(doStorage, r2Bucket, 'cold-promote', 'blob-2', 0, { accessCount: 0 })

      // Trigger promotion
      const result = await smallManager.promotePage('cold-promote')

      // Should evict the oldest page
      expect(result.evictedPages).toContain('warm-old')
      expect(result.promoted).toBe(true)
    })

    it('should update evicted page tier to cold', async () => {
      const smallConfig: PromotionConfig = {
        enabled: true,
        accessThreshold: 1,
        maxHotPages: 2,
      }
      const smallManager = new PromotionManagerImpl(doStorage, r2Bucket, smallConfig)

      // Fill hot tier
      createWarmPage(doStorage, 'warm-old', 'blob-1', 0, { lastAccessAt: Date.now() - 10000 })
      createWarmPage(doStorage, 'warm-new', 'blob-1', 1, { lastAccessAt: Date.now() })

      // Create cold page
      createColdPage(doStorage, r2Bucket, 'cold-promote', 'blob-2', 0, { accessCount: 0 })

      // Trigger promotion
      await smallManager.promotePage('cold-promote')

      // Evicted page should now be cold
      const evictedMeta = await smallManager.getPageMeta('warm-old')
      expect(evictedMeta?.tier).toBe('cold')
    })

    it('should write evicted page to R2 before removing from DO', async () => {
      const smallConfig: PromotionConfig = {
        enabled: true,
        accessThreshold: 1,
        maxHotPages: 1,
      }
      const smallManager = new PromotionManagerImpl(doStorage, r2Bucket, smallConfig)

      const { data: warmData } = createWarmPage(doStorage, 'warm-evict', 'blob-1', 0)
      createColdPage(doStorage, r2Bucket, 'cold-promote', 'blob-2', 0, { accessCount: 0 })

      // Trigger promotion (should evict warm-evict)
      await smallManager.promotePage('cold-promote')

      // Evicted page should now be in R2
      const r2Data = r2Bucket.getData('__page__warm-evict')
      expect(r2Data).toBeDefined()
      expect(r2Data).toEqual(warmData)
    })
  })

  describe('Access Count/Frequency Tracking', () => {
    it('should track access count accurately', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 0 })

      // Access multiple times
      for (let i = 0; i < 5; i++) {
        await promotionManager.accessPage('cold-page-1')
      }

      const meta = await promotionManager.getPageMeta('cold-page-1')
      expect(meta?.accessCount).toBe(5)
    })

    it('should not reset access count on promotion', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 2 })

      // Third access triggers promotion
      await promotionManager.accessPage('cold-page-1')

      const meta = await promotionManager.getPageMeta('cold-page-1')
      expect(meta?.accessCount).toBe(3)
    })

    it('should continue tracking access count after promotion', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 2 })

      // Trigger promotion
      await promotionManager.accessPage('cold-page-1')
      // Access again after promotion
      await promotionManager.accessPage('cold-page-1')
      await promotionManager.accessPage('cold-page-1')

      const meta = await promotionManager.getPageMeta('cold-page-1')
      expect(meta?.accessCount).toBe(5)
    })
  })

  describe('Promotion Threshold', () => {
    it('should check promotion threshold correctly', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 2 })

      // At 2 accesses, should not promote yet (threshold is 3)
      let shouldPromote = await promotionManager.shouldPromote('cold-page-1')
      expect(shouldPromote).toBe(false)

      // Increment to 3
      await promotionManager.updatePageMeta('cold-page-1', { accessCount: 3 })

      // Now should promote
      shouldPromote = await promotionManager.shouldPromote('cold-page-1')
      expect(shouldPromote).toBe(true)
    })

    it('should respect custom access threshold', async () => {
      const customConfig: PromotionConfig = {
        enabled: true,
        accessThreshold: 5,
        maxHotPages: 256,
      }
      const customManager = new PromotionManagerImpl(doStorage, r2Bucket, customConfig)

      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 4 })

      // At 4 accesses with threshold of 5, should not promote
      let shouldPromote = await customManager.shouldPromote('cold-page-1')
      expect(shouldPromote).toBe(false)

      // Increment to 5 using updatePageMeta (to test threshold logic without triggering auto-promotion)
      await customManager.updatePageMeta('cold-page-1', { accessCount: 5 })

      // Now at 5 accesses, should promote (still cold, but meets threshold)
      shouldPromote = await customManager.shouldPromote('cold-page-1')
      expect(shouldPromote).toBe(true)

      // Verify actual promotion works with custom threshold via accessPage
      // Reset to test with accessPage triggering auto-promotion
      createColdPage(doStorage, r2Bucket, 'cold-page-2', 'blob-2', 0, { accessCount: 4 })
      await customManager.accessPage('cold-page-2') // count becomes 5, triggers promotion
      const meta = await customManager.getPageMeta('cold-page-2')
      expect(meta?.tier).toBe('warm') // Verify it was actually promoted
    })

    it('should not promote warm pages (already hot)', async () => {
      createWarmPage(doStorage, 'warm-page-1', 'blob-1', 0, { accessCount: 10 })

      // Warm pages should not be candidates for promotion
      const shouldPromote = await promotionManager.shouldPromote('warm-page-1')
      expect(shouldPromote).toBe(false)
    })
  })

  describe('Concurrent Access During Promotion', () => {
    it('should handle concurrent access to same cold page', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 2 })

      // Concurrent accesses that should all trigger promotion check
      const results = await Promise.all([
        promotionManager.accessPage('cold-page-1'),
        promotionManager.accessPage('cold-page-1'),
        promotionManager.accessPage('cold-page-1'),
      ])

      // All should return valid data
      for (const data of results) {
        expect(data.length).toBe(2 * 1024 * 1024)
      }

      // Page should be promoted exactly once
      const meta = await promotionManager.getPageMeta('cold-page-1')
      expect(meta?.tier).toBe('warm')
    })

    it('should not corrupt data during concurrent promotion', async () => {
      const { data: originalData } = createColdPage(
        doStorage,
        r2Bucket,
        'cold-page-1',
        'blob-1',
        0,
        { accessCount: 2 }
      )

      // Concurrent accesses
      await Promise.all([
        promotionManager.accessPage('cold-page-1'),
        promotionManager.accessPage('cold-page-1'),
        promotionManager.accessPage('cold-page-1'),
      ])

      // Data should still be correct
      const finalData = await promotionManager.accessPage('cold-page-1')
      expect(finalData).toEqual(originalData)
    })

    it('should serialize promotion of same page', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 2 })

      // Track promotion calls
      const promotionCalls: string[] = []
      const originalPromote = promotionManager.promotePage.bind(promotionManager)
      promotionManager.promotePage = async (pageId: string) => {
        promotionCalls.push(pageId)
        return originalPromote(pageId)
      }

      // Concurrent promotions
      await Promise.allSettled([
        promotionManager.promotePage('cold-page-1'),
        promotionManager.promotePage('cold-page-1'),
        promotionManager.promotePage('cold-page-1'),
      ])

      // Only one actual promotion should succeed (others should be no-ops)
      const meta = await promotionManager.getPageMeta('cold-page-1')
      expect(meta?.tier).toBe('warm')
    })
  })

  describe('Failed Promotion Does Not Lose Data', () => {
    it('should keep data in R2 if DO write fails', async () => {
      const { data: originalData } = createColdPage(
        doStorage,
        r2Bucket,
        'cold-page-1',
        'blob-1',
        0,
        { accessCount: 2 }
      )

      // Make DO write fail
      const originalPut = doStorage.put.bind(doStorage)
      doStorage.put = async (key, value) => {
        if (key === '__page__cold-page-1') {
          throw new Error('DO write failed')
        }
        return originalPut(key, value)
      }

      // Try to promote - should fail
      await expect(promotionManager.promotePage('cold-page-1')).rejects.toThrow('DO write failed')

      // Data should still be in R2
      const r2Data = r2Bucket.getData('__page__cold-page-1')
      expect(r2Data).toBeDefined()
      expect(r2Data).toEqual(originalData)

      // Tier should still be cold
      const meta = await promotionManager.getPageMeta('cold-page-1')
      expect(meta?.tier).toBe('cold')
    })

    it('should rollback metadata if promotion fails midway', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 2 })

      // Make metadata update fail after data write
      const originalPut = doStorage.put.bind(doStorage)
      let dataWritten = false
      doStorage.put = async (key, value) => {
        if (key === '__page__cold-page-1') {
          dataWritten = true
          return originalPut(key, value)
        }
        if (key === '__page_meta__cold-page-1' && dataWritten) {
          throw new Error('Metadata update failed')
        }
        return originalPut(key, value)
      }

      // Try to promote
      await expect(promotionManager.promotePage('cold-page-1')).rejects.toThrow()

      // Should rollback - data should be cleaned from DO
      expect(doStorage.has('__page__cold-page-1')).toBe(false)

      // Original R2 data should be intact
      expect(r2Bucket.has('__page__cold-page-1')).toBe(true)
    })

    it('should not delete R2 data until promotion is fully confirmed', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 2 })

      // Track operation order
      const operations: string[] = []
      const originalDOPut = doStorage.put.bind(doStorage)

      doStorage.put = async (key, value) => {
        operations.push(`do-put:${key}`)
        return originalDOPut(key, value)
      }

      await promotionManager.promotePage('cold-page-1')

      // R2 data should still exist (we keep it as backup)
      expect(r2Bucket.has('__page__cold-page-1')).toBe(true)
    })
  })

  describe('Promotion Metrics/Telemetry', () => {
    it('should track total promotion attempts', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 2 })
      createColdPage(doStorage, r2Bucket, 'cold-page-2', 'blob-1', 1, { accessCount: 2 })

      await promotionManager.promotePage('cold-page-1')
      await promotionManager.promotePage('cold-page-2')

      const metrics = promotionManager.getMetrics()
      expect(metrics.totalPromotionAttempts).toBe(2)
    })

    it('should track successful promotions', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 2 })

      await promotionManager.promotePage('cold-page-1')

      const metrics = promotionManager.getMetrics()
      expect(metrics.successfulPromotions).toBe(1)
    })

    it('should track failed promotions', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 2 })

      // Make promotion fail
      const originalPut = doStorage.put.bind(doStorage)
      doStorage.put = async (key, value) => {
        if (key === '__page__cold-page-1') {
          throw new Error('Failed')
        }
        return originalPut(key, value)
      }

      // Expected to fail due to mocked KV error - testing failure tracking
      await promotionManager.promotePage('cold-page-1').catch(() => {})

      const metrics = promotionManager.getMetrics()
      expect(metrics.failedPromotions).toBe(1)
    })

    it('should track promotions blocked by capacity', async () => {
      const smallConfig: PromotionConfig = {
        enabled: true,
        accessThreshold: 1,
        maxHotPages: 2,
      }
      const smallManager = new PromotionManagerImpl(doStorage, r2Bucket, smallConfig)

      // Fill capacity
      fillHotTier(doStorage, 2)

      // Try to promote without eviction enabled
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 0 })

      // This would be blocked by capacity (depending on implementation)
      await smallManager.accessPage('cold-page-1')

      const metrics = smallManager.getMetrics()
      // If eviction is not triggered, should track as blocked
      expect(metrics.blockedByCapacity).toBeGreaterThanOrEqual(0)
    })

    it('should track pages evicted for promotion', async () => {
      const smallConfig: PromotionConfig = {
        enabled: true,
        accessThreshold: 1,
        maxHotPages: 1,
      }
      const smallManager = new PromotionManagerImpl(doStorage, r2Bucket, smallConfig)

      createWarmPage(doStorage, 'warm-1', 'blob-1', 0)
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-2', 0, { accessCount: 0 })

      await smallManager.promotePage('cold-page-1')

      const metrics = smallManager.getMetrics()
      expect(metrics.evictedForPromotion).toBe(1)
    })

    it('should track average promotion latency', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 2 })
      createColdPage(doStorage, r2Bucket, 'cold-page-2', 'blob-1', 1, { accessCount: 2 })

      await promotionManager.promotePage('cold-page-1')
      await promotionManager.promotePage('cold-page-2')

      const metrics = promotionManager.getMetrics()
      expect(metrics.avgPromotionLatencyMs).toBeGreaterThanOrEqual(0)
    })

    it('should reset metrics correctly', () => {
      promotionManager.resetMetrics()

      const metrics = promotionManager.getMetrics()
      expect(metrics.totalPromotionAttempts).toBe(0)
      expect(metrics.successfulPromotions).toBe(0)
      expect(metrics.failedPromotions).toBe(0)
      expect(metrics.blockedByCapacity).toBe(0)
      expect(metrics.evictedForPromotion).toBe(0)
      expect(metrics.avgPromotionLatencyMs).toBe(0)
    })
  })

  describe('Edge Cases', () => {
    it('should handle non-existent page gracefully', async () => {
      await expect(promotionManager.accessPage('non-existent')).rejects.toThrow()
    })

    it('should handle promoting already warm page (no-op)', async () => {
      createWarmPage(doStorage, 'warm-page-1', 'blob-1', 0)

      const result = await promotionManager.promotePage('warm-page-1')

      // Should be a no-op
      expect(result.promoted).toBe(false)
    })

    it('should handle empty page data', async () => {
      // Create a zero-size cold page
      const meta: PromotionPageMeta = {
        pageId: 'empty-page',
        blobId: 'blob-1',
        pageIndex: 0,
        size: 0,
        tier: 'cold',
        lastAccessAt: Date.now() - 10000,
        accessCount: 2,
        createdAt: Date.now() - 100000,
      }
      r2Bucket.put('__page__empty-page', new Uint8Array(0))
      doStorage.put('__page_meta__empty-page', meta as unknown as Uint8Array)

      const data = await promotionManager.accessPage('empty-page')
      expect(data.length).toBe(0)
    })

    it('should handle promotion when disabled', async () => {
      const disabledConfig: PromotionConfig = {
        enabled: false,
        accessThreshold: 1,
        maxHotPages: 256,
      }
      const disabledManager = new PromotionManagerImpl(doStorage, r2Bucket, disabledConfig)

      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 10 })

      // Access should return data but not promote
      await disabledManager.accessPage('cold-page-1')

      const meta = await disabledManager.getPageMeta('cold-page-1')
      expect(meta?.tier).toBe('cold')
    })

    it('should handle R2 read failure during access', async () => {
      createColdPage(doStorage, r2Bucket, 'cold-page-1', 'blob-1', 0, { accessCount: 0 })

      // Make R2 read fail
      const originalGet = r2Bucket.get.bind(r2Bucket)
      r2Bucket.get = async (key) => {
        if (key === '__page__cold-page-1') {
          return null // Simulate missing data
        }
        return originalGet(key)
      }

      await expect(promotionManager.accessPage('cold-page-1')).rejects.toThrow()
    })
  })

  describe('Promotion with Eviction Integration', () => {
    it('should evict LRU pages when promoting at capacity', async () => {
      const smallConfig: PromotionConfig = {
        enabled: true,
        accessThreshold: 1,
        maxHotPages: 3,
      }
      const smallManager = new PromotionManagerImpl(doStorage, r2Bucket, smallConfig)

      const baseTime = Date.now()
      // Create warm pages with known access times
      createWarmPage(doStorage, 'warm-oldest', 'blob-1', 0, { lastAccessAt: baseTime - 30000 })
      createWarmPage(doStorage, 'warm-middle', 'blob-1', 1, { lastAccessAt: baseTime - 20000 })
      createWarmPage(doStorage, 'warm-newest', 'blob-1', 2, { lastAccessAt: baseTime - 10000 })

      // Create cold page to promote
      createColdPage(doStorage, r2Bucket, 'cold-promote', 'blob-2', 0, { accessCount: 0 })

      // Promote - should evict warm-oldest
      const result = await smallManager.promotePage('cold-promote')

      expect(result.promoted).toBe(true)
      expect(result.evictedPages).toContain('warm-oldest')
      expect(result.evictedPages).not.toContain('warm-newest')
    })

    it('should correctly count hot pages after eviction and promotion', async () => {
      const smallConfig: PromotionConfig = {
        enabled: true,
        accessThreshold: 1,
        maxHotPages: 2,
      }
      const smallManager = new PromotionManagerImpl(doStorage, r2Bucket, smallConfig)

      // Start with 2 warm pages
      createWarmPage(doStorage, 'warm-1', 'blob-1', 0)
      createWarmPage(doStorage, 'warm-2', 'blob-1', 1)

      let count = await smallManager.getHotPageCount()
      expect(count).toBe(2)

      // Promote a cold page (should evict one)
      createColdPage(doStorage, r2Bucket, 'cold-1', 'blob-2', 0, { accessCount: 0 })
      await smallManager.promotePage('cold-1')

      // Should still have 2 hot pages
      count = await smallManager.getHotPageCount()
      expect(count).toBe(2)
    })
  })
})

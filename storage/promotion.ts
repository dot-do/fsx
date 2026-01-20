/**
 * R2 Promotion Manager - Cold Pages from R2 to DO Hot Tier on Access
 *
 * Promotes cold pages from R2 back to Durable Object hot tier when accessed.
 * This module provides:
 *
 * - Access cold page triggers promotion to hot tier
 * - Track access counts per page
 * - Promote after accessThreshold (default 3) accesses
 * - Respect maxHotPages limit
 * - Trigger LRU eviction if hot tier full before promotion
 * - Safe promotion: copy to DO first, then keep R2 as backup
 *
 * Issue: fsx-bb0z - [GREEN] R2 promotion on cold page access
 *
 * @module storage/promotion
 */

// =============================================================================
// Type Definitions
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
 * Promotion Manager interface.
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
// Storage Interfaces (compatible with Cloudflare types)
// =============================================================================

/**
 * Interface for DO storage operations.
 */
export interface DOStorageInterface {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  list(options?: { prefix?: string }): Promise<Map<string, unknown>>
}

/**
 * Interface for R2 bucket operations.
 */
export interface R2BucketInterface {
  put(
    key: string,
    value: Uint8Array | ArrayBuffer | ReadableStream,
    options?: { customMetadata?: Record<string, string> }
  ): Promise<unknown>
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
  delete(key: string): Promise<void>
  head(key: string): Promise<{ size: number } | null>
}

// =============================================================================
// Constants
// =============================================================================

/** Prefix for page data keys in DO storage */
const PAGE_DATA_PREFIX = '__page__'

/** Prefix for page metadata keys in DO storage */
const PAGE_META_PREFIX = '__page_meta__'

// =============================================================================
// Promotion Manager Implementation
// =============================================================================

/**
 * Promotion Manager implementation.
 *
 * Manages the promotion of cold pages from R2 back to Durable Object hot tier
 * based on access patterns.
 */
export class PromotionManagerImpl implements PromotionManager {
  private readonly doStorage: DOStorageInterface
  private readonly r2Bucket: R2BucketInterface
  private readonly config: PromotionConfig
  private metrics: PromotionMetrics
  private promotionLatencies: number[] = []
  private promotingPages: Set<string> = new Set()

  constructor(
    doStorage: DOStorageInterface,
    r2Bucket: R2BucketInterface,
    config: PromotionConfig
  ) {
    this.doStorage = doStorage
    this.r2Bucket = r2Bucket
    this.config = config
    this.metrics = this.createEmptyMetrics()
  }

  /**
   * Create empty metrics object.
   */
  private createEmptyMetrics(): PromotionMetrics {
    return {
      totalPromotionAttempts: 0,
      successfulPromotions: 0,
      failedPromotions: 0,
      blockedByCapacity: 0,
      evictedForPromotion: 0,
      avgPromotionLatencyMs: 0,
    }
  }

  /**
   * Get current promotion configuration.
   */
  getConfig(): PromotionConfig {
    return { ...this.config }
  }

  /**
   * Get promotion metrics.
   */
  getMetrics(): PromotionMetrics {
    return { ...this.metrics }
  }

  /**
   * Reset promotion metrics.
   */
  resetMetrics(): void {
    this.metrics = this.createEmptyMetrics()
    this.promotionLatencies = []
  }

  /**
   * Get page metadata.
   */
  async getPageMeta(pageId: string): Promise<PromotionPageMeta | null> {
    const metaKey = `${PAGE_META_PREFIX}${pageId}`
    const meta = await this.doStorage.get<PromotionPageMeta>(metaKey)
    return meta ?? null
  }

  /**
   * Update page metadata.
   */
  async updatePageMeta(pageId: string, updates: Partial<PromotionPageMeta>): Promise<void> {
    const metaKey = `${PAGE_META_PREFIX}${pageId}`
    const meta = await this.doStorage.get<PromotionPageMeta>(metaKey)

    if (!meta) {
      throw new Error(`Page not found: ${pageId}`)
    }

    const updatedMeta: PromotionPageMeta = { ...meta, ...updates }
    await this.doStorage.put(metaKey, updatedMeta)
  }

  /**
   * Get the current hot page count in DO storage.
   * Only counts pages with tier='warm'.
   */
  async getHotPageCount(): Promise<number> {
    const allMeta = await this.getAllPageMeta()
    return allMeta.filter((meta) => meta.tier === 'warm').length
  }

  /**
   * Check if a page should be promoted based on access count and tier.
   */
  async shouldPromote(pageId: string): Promise<boolean> {
    const meta = await this.getPageMeta(pageId)

    if (!meta) {
      return false
    }

    // Only cold pages can be promoted
    if (meta.tier !== 'cold') {
      return false
    }

    // Check if access count meets threshold
    return meta.accessCount >= this.config.accessThreshold
  }

  /**
   * Access a page, potentially triggering promotion if cold.
   */
  async accessPage(pageId: string): Promise<Uint8Array> {
    const meta = await this.getPageMeta(pageId)

    if (!meta) {
      throw new Error(`Page not found: ${pageId}`)
    }

    // Increment access count and update last access time
    const newAccessCount = meta.accessCount + 1
    await this.updatePageMeta(pageId, {
      accessCount: newAccessCount,
      lastAccessAt: Date.now(),
    })

    // Get page data
    let pageData: Uint8Array

    if (meta.tier === 'cold') {
      // Read from R2
      const dataKey = `${PAGE_DATA_PREFIX}${pageId}`
      const r2Object = await this.r2Bucket.get(dataKey)

      if (!r2Object) {
        throw new Error(`Page data not found in R2: ${pageId}`)
      }

      const arrayBuffer = await r2Object.arrayBuffer()
      pageData = new Uint8Array(arrayBuffer)

      // Check if we should promote (after incrementing access count)
      // Only auto-promote if enabled, threshold met, AND hot tier has capacity
      if (this.config.enabled && newAccessCount >= this.config.accessThreshold) {
        const hotCount = await this.getHotPageCount()
        if (hotCount < this.config.maxHotPages) {
          try {
            await this.promotePage(pageId)
          } catch {
            // Promotion failed but we still have the data - continue
          }
        } else {
          // At capacity - track as blocked (accessPage doesn't trigger eviction)
          this.metrics.blockedByCapacity++
        }
      }
    } else {
      // Read from DO (warm tier)
      const dataKey = `${PAGE_DATA_PREFIX}${pageId}`
      const data = await this.doStorage.get<Uint8Array>(dataKey)

      if (!data) {
        throw new Error(`Page data not found in DO: ${pageId}`)
      }

      pageData = data
    }

    return pageData
  }

  /**
   * Promote a cold page from R2 to DO hot tier.
   */
  async promotePage(pageId: string): Promise<PromotionResult> {
    const startTime = Date.now()
    this.metrics.totalPromotionAttempts++

    const meta = await this.getPageMeta(pageId)

    if (!meta) {
      this.metrics.failedPromotions++
      throw new Error(`Page not found: ${pageId}`)
    }

    // If already warm, return no-op result
    if (meta.tier === 'warm') {
      return {
        promoted: false,
        fromTier: 'cold',
        toTier: 'warm',
      }
    }

    // Check if page is already being promoted (concurrency guard)
    if (this.promotingPages.has(pageId)) {
      // Another promotion is in progress, wait for it
      return {
        promoted: false,
        fromTier: 'cold',
        toTier: 'warm',
      }
    }

    // Mark as being promoted
    this.promotingPages.add(pageId)

    try {
      const evictedPages: string[] = []

      // Check capacity and evict if necessary
      const hotCount = await this.getHotPageCount()

      if (hotCount >= this.config.maxHotPages) {
        // Need to evict to make room
        const pageToEvict = await this.getLRUPage()

        if (pageToEvict) {
          await this.evictPage(pageToEvict.pageId)
          evictedPages.push(pageToEvict.pageId)
          this.metrics.evictedForPromotion++
        } else {
          // No page to evict, can't promote
          this.metrics.blockedByCapacity++
          return {
            promoted: false,
            fromTier: 'cold',
            toTier: 'warm',
          }
        }
      }

      // Read data from R2
      const dataKey = `${PAGE_DATA_PREFIX}${pageId}`
      const r2Object = await this.r2Bucket.get(dataKey)

      if (!r2Object) {
        this.metrics.failedPromotions++
        throw new Error(`Page data not found in R2: ${pageId}`)
      }

      const arrayBuffer = await r2Object.arrayBuffer()
      const pageData = new Uint8Array(arrayBuffer)

      // Write to DO first (safe promotion)
      try {
        await this.doStorage.put(dataKey, pageData)
      } catch (error) {
        this.metrics.failedPromotions++
        throw error
      }

      // Update metadata to warm tier
      try {
        await this.updatePageMeta(pageId, { tier: 'warm' })
      } catch (error) {
        // Rollback: delete from DO since metadata update failed
        await this.doStorage.delete(dataKey)
        this.metrics.failedPromotions++
        throw error
      }

      // Success - update metrics
      this.metrics.successfulPromotions++
      const latency = Date.now() - startTime
      this.promotionLatencies.push(latency)
      this.metrics.avgPromotionLatencyMs =
        this.promotionLatencies.reduce((a, b) => a + b, 0) / this.promotionLatencies.length

      // Note: We keep data in R2 as backup (don't delete)

      return {
        promoted: true,
        fromTier: 'cold',
        toTier: 'warm',
        evictedPages: evictedPages.length > 0 ? evictedPages : undefined,
      }
    } finally {
      // Clear promotion lock
      this.promotingPages.delete(pageId)
    }
  }

  /**
   * Get the least recently used warm page.
   */
  private async getLRUPage(): Promise<PromotionPageMeta | null> {
    const allMeta = await this.getAllPageMeta()
    const warmPages = allMeta.filter((meta) => meta.tier === 'warm')

    if (warmPages.length === 0) {
      return null
    }

    // Sort by lastAccessAt ascending (oldest first)
    warmPages.sort((a, b) => a.lastAccessAt - b.lastAccessAt)

    return warmPages[0] ?? null
  }

  /**
   * Evict a page from DO to R2.
   */
  private async evictPage(pageId: string): Promise<void> {
    const meta = await this.getPageMeta(pageId)

    if (!meta || meta.tier === 'cold') {
      return
    }

    const dataKey = `${PAGE_DATA_PREFIX}${pageId}`

    // Get data from DO
    const pageData = await this.doStorage.get<Uint8Array>(dataKey)

    if (pageData) {
      // Write to R2 first (safe eviction)
      await this.r2Bucket.put(dataKey, pageData, {
        customMetadata: {
          pageId: meta.pageId,
          blobId: meta.blobId,
          pageIndex: String(meta.pageIndex),
        },
      })

      // Delete from DO
      await this.doStorage.delete(dataKey)
    }

    // Update tier to cold
    await this.updatePageMeta(pageId, { tier: 'cold' })
  }

  /**
   * Get all page metadata from DO storage.
   */
  private async getAllPageMeta(): Promise<PromotionPageMeta[]> {
    const allItems = await this.doStorage.list({ prefix: PAGE_META_PREFIX })
    const result: PromotionPageMeta[] = []

    for (const [, value] of allItems) {
      if (value && typeof value === 'object' && 'pageId' in value) {
        result.push(value as PromotionPageMeta)
      }
    }

    return result
  }
}

/**
 * Create a Promotion Manager instance.
 *
 * @param doStorage - Durable Object storage instance
 * @param r2Bucket - R2 bucket for cold storage
 * @param config - Promotion configuration
 * @returns Promotion Manager instance
 *
 * @example
 * ```typescript
 * const promotionManager = createPromotionManager(
 *   ctx.storage,
 *   env.R2_BUCKET,
 *   {
 *     enabled: true,
 *     accessThreshold: 3,     // Promote after 3 accesses
 *     maxHotPages: 256,       // 512MB at 2MB/page
 *   }
 * )
 *
 * // Access a cold page (may trigger promotion)
 * const data = await promotionManager.accessPage('page-123')
 *
 * // Check metrics
 * const metrics = promotionManager.getMetrics()
 * console.log(`Promoted ${metrics.successfulPromotions} pages`)
 * ```
 */
export function createPromotionManager(
  doStorage: DOStorageInterface,
  r2Bucket: R2BucketInterface,
  config: PromotionConfig
): PromotionManager {
  return new PromotionManagerImpl(doStorage, r2Bucket, config)
}

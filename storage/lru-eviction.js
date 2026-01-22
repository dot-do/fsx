/**
 * LRU Eviction Manager - Cold Pages from DO Storage to R2
 *
 * Manages LRU eviction of cold pages from Durable Object storage to R2.
 * This module provides:
 *
 * - Eviction triggers at configurable threshold (default: 90% of maxHotPages)
 * - LRU selection: oldest last_access_at pages evicted first
 * - Evicts down to configurable target (default: 70% of maxHotPages)
 * - Page metadata updated to 'cold' tier
 * - Safe eviction: R2 write BEFORE DO delete (no data loss)
 * - Idempotent eviction (calling twice is safe)
 *
 * Issue: fsx-dyd4 - [GREEN] Integrate PageStorage with FsModule.storeBlob
 *
 * @module storage/lru-eviction
 */
// =============================================================================
// Constants
// =============================================================================
/** Prefix for page data keys in DO storage */
const PAGE_DATA_PREFIX = '__page__';
/** Prefix for page metadata keys in DO storage */
const PAGE_META_PREFIX = '__page_meta__';
// =============================================================================
// LRU Eviction Manager Implementation
// =============================================================================
/**
 * LRU Eviction Manager implementation.
 *
 * Manages the eviction of cold pages from Durable Object storage to R2
 * based on LRU (Least Recently Used) policy.
 */
export class LRUEvictionManagerImpl {
    doStorage;
    r2Bucket;
    config;
    evictionInProgress = false;
    constructor(doStorage, r2Bucket, config) {
        this.doStorage = doStorage;
        this.r2Bucket = r2Bucket;
        this.config = config;
    }
    /**
     * Get current eviction configuration.
     */
    getConfig() {
        return { ...this.config };
    }
    /**
     * Get the current hot page count in DO storage.
     * Only counts pages with tier='warm'.
     */
    async getHotPageCount() {
        const allMeta = await this.getAllPageMeta();
        return allMeta.filter((meta) => meta.tier === 'warm').length;
    }
    /**
     * Check if eviction should be triggered based on current page count.
     */
    async shouldEvict() {
        const hotCount = await this.getHotPageCount();
        const threshold = Math.floor(this.config.maxHotPages * this.config.evictionThreshold);
        return hotCount >= threshold;
    }
    /**
     * Get pages sorted by last_access_at (oldest first).
     * Only returns warm tier pages.
     */
    async getColdestPages(limit) {
        const allMeta = await this.getAllPageMeta();
        // Filter to warm tier only and sort by last_access_at ascending (oldest first)
        const warmPages = allMeta
            .filter((meta) => meta.tier === 'warm')
            .sort((a, b) => a.last_access_at - b.last_access_at);
        return warmPages.slice(0, limit);
    }
    /**
     * Run eviction to move cold pages from DO to R2.
     * Evicts oldest pages until we reach the target count.
     */
    async runEviction() {
        const startTime = Date.now();
        const evictedPageIds = [];
        const errors = [];
        // Check if eviction is needed
        const hotCount = await this.getHotPageCount();
        const threshold = Math.floor(this.config.maxHotPages * this.config.evictionThreshold);
        const target = Math.floor(this.config.maxHotPages * this.config.evictionTarget);
        if (hotCount < threshold) {
            // Below threshold, no eviction needed
            return {
                evictedCount: 0,
                evictedPageIds: [],
                errors: [],
                durationMs: Date.now() - startTime,
            };
        }
        // Calculate how many pages to evict
        const toEvict = hotCount - target;
        if (toEvict <= 0) {
            return {
                evictedCount: 0,
                evictedPageIds: [],
                errors: [],
                durationMs: Date.now() - startTime,
            };
        }
        // Get the coldest pages to evict
        const coldestPages = await this.getColdestPages(toEvict);
        // Evict each page
        for (const page of coldestPages) {
            try {
                await this.evictPage(page.pageId);
                evictedPageIds.push(page.pageId);
            }
            catch (error) {
                errors.push(`Failed to evict ${page.pageId}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return {
            evictedCount: evictedPageIds.length,
            evictedPageIds,
            errors,
            durationMs: Date.now() - startTime,
        };
    }
    /**
     * Evict a single page from DO to R2.
     * CRITICAL: Write to R2 BEFORE deleting from DO to prevent data loss.
     */
    async evictPage(pageId) {
        const metaKey = `${PAGE_META_PREFIX}${pageId}`;
        const dataKey = `${PAGE_DATA_PREFIX}${pageId}`;
        // Get current metadata
        const meta = await this.doStorage.get(metaKey);
        if (!meta) {
            // Page doesn't exist
            throw new Error(`Page not found: ${pageId}`);
        }
        // If already cold, nothing to do
        if (meta.tier === 'cold') {
            return;
        }
        // Get page data from DO
        const pageData = await this.doStorage.get(dataKey);
        if (!pageData) {
            // Data not found, just update metadata to cold
            const updatedMeta = { ...meta, tier: 'cold' };
            await this.doStorage.put(metaKey, updatedMeta);
            return;
        }
        // CRITICAL: Write to R2 FIRST (before deleting from DO)
        // This ensures no data loss if the operation fails midway
        await this.r2Bucket.put(dataKey, pageData, {
            customMetadata: {
                pageId: meta.pageId,
                blobId: meta.blobId,
                pageIndex: String(meta.pageIndex),
            },
        });
        // Update metadata to cold tier
        const updatedMeta = { ...meta, tier: 'cold' };
        await this.doStorage.put(metaKey, updatedMeta);
        // Now safe to delete from DO (R2 has the data)
        await this.doStorage.delete(dataKey);
    }
    /**
     * Update the last_access_at timestamp for a page.
     */
    async touchPage(pageId) {
        const metaKey = `${PAGE_META_PREFIX}${pageId}`;
        const meta = await this.doStorage.get(metaKey);
        if (!meta) {
            throw new Error(`Page not found: ${pageId}`);
        }
        const updatedMeta = {
            ...meta,
            last_access_at: Date.now(),
        };
        await this.doStorage.put(metaKey, updatedMeta);
    }
    /**
     * Get page metadata.
     */
    async getPageMeta(pageId) {
        const metaKey = `${PAGE_META_PREFIX}${pageId}`;
        const meta = await this.doStorage.get(metaKey);
        return meta ?? null;
    }
    /**
     * Get all page metadata from DO storage.
     */
    async getAllPageMeta() {
        const allItems = await this.doStorage.list({ prefix: PAGE_META_PREFIX });
        const result = [];
        for (const [, value] of allItems) {
            if (value && typeof value === 'object' && 'pageId' in value) {
                result.push(value);
            }
        }
        return result;
    }
}
/**
 * Create an LRU Eviction Manager instance.
 *
 * @param doStorage - Durable Object storage instance
 * @param r2Bucket - R2 bucket for cold storage
 * @param config - Eviction configuration
 * @returns LRU Eviction Manager instance
 *
 * @example
 * ```typescript
 * const evictionManager = createLRUEvictionManager(
 *   ctx.storage,
 *   env.R2_BUCKET,
 *   {
 *     maxHotPages: 256,     // 512MB at 2MB/page
 *     evictionThreshold: 0.9, // 90%
 *     evictionTarget: 0.7,    // 70%
 *   }
 * )
 *
 * // Check if eviction is needed
 * if (await evictionManager.shouldEvict()) {
 *   const result = await evictionManager.runEviction()
 *   console.log(`Evicted ${result.evictedCount} pages`)
 * }
 * ```
 */
export function createLRUEvictionManager(doStorage, r2Bucket, config) {
    return new LRUEvictionManagerImpl(doStorage, r2Bucket, config);
}
//# sourceMappingURL=lru-eviction.js.map
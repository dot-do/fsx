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
/**
 * Configuration for LRU eviction behavior.
 */
export interface EvictionConfig {
    /** Maximum number of hot pages in DO storage (default: 256 = 512MB at 2MB/page) */
    maxHotPages: number;
    /** Threshold percentage to trigger eviction (default: 0.9 = 90%) */
    evictionThreshold: number;
    /** Target percentage after eviction (default: 0.7 = 70%) */
    evictionTarget: number;
}
/**
 * Page metadata stored in DO storage.
 */
export interface PageMeta {
    /** Unique page identifier */
    pageId: string;
    /** Blob ID this page belongs to */
    blobId: string;
    /** Page index within the blob */
    pageIndex: number;
    /** Page size in bytes */
    size: number;
    /** Storage tier: 'warm' (DO) or 'cold' (R2) */
    tier: 'warm' | 'cold';
    /** Last access timestamp (Unix ms) */
    last_access_at: number;
    /** Creation timestamp (Unix ms) */
    created_at: number;
}
/**
 * Result of an eviction run.
 */
export interface EvictionResult {
    /** Number of pages evicted */
    evictedCount: number;
    /** Page IDs that were evicted */
    evictedPageIds: string[];
    /** Any errors encountered during eviction */
    errors: string[];
    /** Time taken in milliseconds */
    durationMs: number;
}
/**
 * LRU Eviction Manager interface.
 */
export interface LRUEvictionManager {
    /**
     * Get the current hot page count in DO storage.
     */
    getHotPageCount(): Promise<number>;
    /**
     * Check if eviction should be triggered based on current page count.
     */
    shouldEvict(): Promise<boolean>;
    /**
     * Get pages sorted by last_access_at (oldest first).
     * @param limit - Maximum number of pages to return
     */
    getColdestPages(limit: number): Promise<PageMeta[]>;
    /**
     * Run eviction to move cold pages from DO to R2.
     * @returns Eviction result with stats
     */
    runEviction(): Promise<EvictionResult>;
    /**
     * Evict a single page from DO to R2.
     * @param pageId - The page ID to evict
     */
    evictPage(pageId: string): Promise<void>;
    /**
     * Update the last_access_at timestamp for a page.
     * @param pageId - The page ID to touch
     */
    touchPage(pageId: string): Promise<void>;
    /**
     * Get page metadata.
     * @param pageId - The page ID
     */
    getPageMeta(pageId: string): Promise<PageMeta | null>;
    /**
     * Get current eviction configuration.
     */
    getConfig(): EvictionConfig;
}
/**
 * Interface for DO storage operations.
 */
export interface DOStorageInterface {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    list(options?: {
        prefix?: string;
    }): Promise<Map<string, unknown>>;
}
/**
 * Interface for R2 bucket operations.
 */
export interface R2BucketInterface {
    put(key: string, value: Uint8Array | ArrayBuffer | ReadableStream, options?: {
        customMetadata?: Record<string, string>;
    }): Promise<unknown>;
    get(key: string): Promise<{
        arrayBuffer(): Promise<ArrayBuffer>;
    } | null>;
    delete(key: string): Promise<void>;
    head(key: string): Promise<{
        size: number;
    } | null>;
}
/**
 * LRU Eviction Manager implementation.
 *
 * Manages the eviction of cold pages from Durable Object storage to R2
 * based on LRU (Least Recently Used) policy.
 */
export declare class LRUEvictionManagerImpl implements LRUEvictionManager {
    private readonly doStorage;
    private readonly r2Bucket;
    private readonly config;
    private evictionInProgress;
    constructor(doStorage: DOStorageInterface, r2Bucket: R2BucketInterface, config: EvictionConfig);
    /**
     * Get current eviction configuration.
     */
    getConfig(): EvictionConfig;
    /**
     * Get the current hot page count in DO storage.
     * Only counts pages with tier='warm'.
     */
    getHotPageCount(): Promise<number>;
    /**
     * Check if eviction should be triggered based on current page count.
     */
    shouldEvict(): Promise<boolean>;
    /**
     * Get pages sorted by last_access_at (oldest first).
     * Only returns warm tier pages.
     */
    getColdestPages(limit: number): Promise<PageMeta[]>;
    /**
     * Run eviction to move cold pages from DO to R2.
     * Evicts oldest pages until we reach the target count.
     */
    runEviction(): Promise<EvictionResult>;
    /**
     * Evict a single page from DO to R2.
     * CRITICAL: Write to R2 BEFORE deleting from DO to prevent data loss.
     */
    evictPage(pageId: string): Promise<void>;
    /**
     * Update the last_access_at timestamp for a page.
     */
    touchPage(pageId: string): Promise<void>;
    /**
     * Get page metadata.
     */
    getPageMeta(pageId: string): Promise<PageMeta | null>;
    /**
     * Get all page metadata from DO storage.
     */
    private getAllPageMeta;
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
export declare function createLRUEvictionManager(doStorage: DOStorageInterface, r2Bucket: R2BucketInterface, config: EvictionConfig): LRUEvictionManager;
//# sourceMappingURL=lru-eviction.d.ts.map
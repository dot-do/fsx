/**
 * Page Metadata Store - 2MB BLOB Chunk Tracking for VFS
 *
 * Manages the page_metadata schema that tracks 2MB blob chunks for the
 * Virtual File System. This schema enables:
 *
 * - Tracking individual 2MB pages/chunks for large files
 * - Storage tier management (hot/warm/cold) per page
 * - LRU-based eviction decisions via last_access_at tracking
 * - Access pattern analysis via access_count for tier promotion
 * - Compression metadata tracking
 * - Integrity verification via checksums
 *
 * Issue: fsx-dyd4 - [GREEN] Integrate PageStorage with FsModule.storeBlob
 *
 * @module storage/page-metadata
 */
/**
 * Page metadata record representing a single 2MB chunk.
 */
export interface PageMetadata {
    fileId: number;
    pageNumber: number;
    pageKey: string;
    tier: 'hot' | 'warm' | 'cold';
    size: number;
    checksum: string | null;
    lastAccessAt: number;
    accessCount: number;
    compressed: number;
    originalSize: number | null;
}
/**
 * Options for creating a new page.
 */
export interface CreatePageOptions {
    fileId: number;
    pageNumber: number;
    pageKey: string;
    tier?: 'hot' | 'warm' | 'cold';
    size: number;
    checksum?: string | null;
    lastAccessAt: number;
    accessCount?: number;
    compressed?: number;
    originalSize?: number | null;
}
/**
 * Options for updating a page.
 */
export interface UpdatePageOptions {
    pageKey?: string;
    tier?: 'hot' | 'warm' | 'cold';
    size?: number;
    checksum?: string | null;
    lastAccessAt?: number;
    accessCount?: number;
    compressed?: number;
    originalSize?: number | null;
}
/**
 * Tier statistics.
 */
export interface TierStats {
    hot: {
        count: number;
        totalSize: number;
    };
    warm: {
        count: number;
        totalSize: number;
    };
    cold: {
        count: number;
        totalSize: number;
    };
}
/**
 * PageMetadataStore manages the page_metadata table which tracks 2MB blob chunks
 * for the VFS tiered storage system.
 */
export declare class PageMetadataStore {
    private sql;
    private pageKeyIndex;
    constructor(sql: SqlStorage);
    /**
     * Initialize the schema - creates table and indexes.
     */
    init(): Promise<void>;
    /**
     * Create a new page entry.
     */
    createPage(options: CreatePageOptions): Promise<void>;
    /**
     * Get a single page by file_id and page_number.
     */
    getPage(fileId: number, pageNumber: number): Promise<PageMetadata | null>;
    /**
     * Get all pages for a file, sorted by page_number.
     */
    getPagesForFile(fileId: number): Promise<PageMetadata[]>;
    /**
     * Update a page's metadata.
     */
    updatePage(fileId: number, pageNumber: number, options: UpdatePageOptions): Promise<void>;
    /**
     * Delete a single page.
     */
    deletePage(fileId: number, pageNumber: number): Promise<void>;
    /**
     * Delete all pages for a file.
     */
    deletePagesForFile(fileId: number): Promise<void>;
    /**
     * Get the oldest pages by last_access_at.
     */
    getOldestPages(limit: number, options?: {
        tier?: string;
    }): Promise<PageMetadata[]>;
    /**
     * Get eviction candidates prioritizing by tier and access count.
     * Cold tier pages are evicted first, then by lowest access_count.
     */
    getEvictionCandidates(limit: number): Promise<PageMetadata[]>;
    /**
     * Get pages by tier.
     */
    getPagesByTier(tier: 'hot' | 'warm' | 'cold'): Promise<PageMetadata[]>;
    /**
     * Get statistics per tier.
     */
    getTierStats(): Promise<TierStats>;
    /**
     * Record an access - increments access_count and updates last_access_at.
     * Note: The mock expects params[0]=fileId, params[1]=pageNumber with
     * 'access_count = access_count + 1' in the SQL for pattern matching.
     */
    recordAccess(fileId: number, pageNumber: number): Promise<void>;
    /**
     * Get pages with high access counts (hot candidates).
     */
    getHotPages(options: {
        minAccessCount: number;
        tier?: string;
    }): Promise<PageMetadata[]>;
    /**
     * Handle file deletion - cascade delete all pages for the file.
     */
    onFileDeleted(fileId: number): Promise<void>;
    /**
     * Get total file size from all its pages.
     */
    getTotalFileSize(fileId: number): Promise<number>;
    /**
     * Get all page keys for a file in order.
     */
    getPageKeysForFile(fileId: number): Promise<string[]>;
    /**
     * Convert a database row to PageMetadata.
     */
    private rowToPageMetadata;
}
//# sourceMappingURL=page-metadata.d.ts.map
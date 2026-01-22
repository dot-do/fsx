/**
 * ExtentStorage - Core Layer for Production-Grade VFS
 *
 * Packs 4KB/8KB database pages into 2MB extents for ~500x cost reduction
 * on Cloudflare Durable Objects. This is the foundation layer that sits
 * between the SQLite/PostgreSQL VFS adapters and the blob storage backend.
 *
 * Key Features:
 * - Content-addressable extent storage (hash-based IDs)
 * - Write buffering in SQL for durability
 * - Automatic extent packing when buffer is full
 * - Support for sparse extents (pages with gaps)
 * - Optional gzip compression
 *
 * Architecture:
 * ```
 * +-----------------------------------------------------------------+
 * |                    SQLiteVFS / PGliteFS                         |
 * +-----------------------------------------------------------------+
 * |                    ExtentStorage (this)                         |
 * |  +------------+  +------------+  +------------+                 |
 * |  | Dirty Pages|  |  Extents   |  |  Metadata  |                 |
 * |  |   (SQL)    |  |(BlobStorage|  |    (SQL)   |                 |
 * |  +------------+  +------------+  +------------+                 |
 * +-----------------------------------------------------------------+
 * |            BlobStorage (R2, Memory, etc.)                       |
 * +-----------------------------------------------------------------+
 * ```
 *
 * @module storage/extent-storage
 */
import type { BlobStorage } from './interfaces.js';
/**
 * SQL result row type
 */
export type SqlRow = Record<string, string | number | null | ArrayBuffer | Uint8Array>;
/**
 * SQL result set from exec()
 */
export interface SqlResultSet {
    /** Result rows */
    rows: SqlRow[];
    /** Number of rows affected (for INSERT/UPDATE/DELETE) */
    rowsAffected?: number;
    /** Last inserted row ID */
    lastInsertId?: number;
}
/**
 * Minimal SQL storage interface for portability.
 *
 * This interface abstracts the SQL database used for metadata storage,
 * allowing ExtentStorage to work with different SQL backends:
 * - Cloudflare Durable Objects (DO) SqlStorage
 * - better-sqlite3 for local development
 * - In-memory SQL for testing
 *
 * @example
 * ```typescript
 * // Durable Objects adapter
 * const sqlAdapter: SqlStorageAdapter = {
 *   exec: (query, params) => {
 *     const cursor = doSql.exec(query, ...params)
 *     return { rows: cursor.toArray() }
 *   }
 * }
 *
 * // better-sqlite3 adapter
 * const sqliteAdapter: SqlStorageAdapter = {
 *   exec: (query, params) => {
 *     const stmt = db.prepare(query)
 *     const rows = stmt.all(...params)
 *     return { rows }
 *   }
 * }
 * ```
 */
export interface SqlStorageAdapter {
    /**
     * Execute a SQL query with parameters.
     *
     * @param query - SQL query string with ? placeholders
     * @param params - Query parameters
     * @returns Result set with rows
     */
    exec(query: string, params?: (string | number | null | Uint8Array | ArrayBuffer)[]): SqlResultSet;
}
/**
 * Compression codec type for extents.
 */
export type ExtentCompression = 'none' | 'gzip';
/**
 * Default page size (4KB for SQLite).
 */
export declare const DEFAULT_PAGE_SIZE = 4096;
/**
 * Default extent size (2MB).
 */
export declare const DEFAULT_EXTENT_SIZE: number;
/**
 * ExtentStorage configuration options.
 */
export interface ExtentStorageConfig {
    /**
     * Page size in bytes.
     * - 4096 for SQLite
     * - 8192 for PostgreSQL
     * @default 4096
     */
    pageSize: number;
    /**
     * Target extent size in bytes.
     * Pages are packed into extents of this size.
     * @default 2097152 (2MB)
     */
    extentSize: number;
    /**
     * Compression codec for extents.
     * - 'none': No compression
     * - 'gzip': Gzip compression (good for text/SQL data)
     * @default 'none'
     */
    compression: ExtentCompression;
    /**
     * Blob storage backend for extent data.
     * Must implement the BlobStorage interface.
     */
    backend: BlobStorage;
    /**
     * SQL storage adapter for metadata and dirty pages.
     * Must implement the SqlStorageAdapter interface.
     */
    sql: SqlStorageAdapter;
    /**
     * Prefix for extent keys in blob storage.
     * @default 'extent/'
     */
    extentPrefix?: string;
    /**
     * Whether to automatically flush when dirty page count reaches threshold.
     * @default true
     */
    autoFlush?: boolean;
    /**
     * Minimum dirty pages before auto-flush.
     * @default calculated from extentSize/pageSize
     */
    flushThreshold?: number;
}
/**
 * File metadata stored in SQL
 */
export interface ExtentFileMetadata {
    fileId: string;
    pageSize: number;
    fileSize: number;
    extentCount: number;
    createdAt: number;
    modifiedAt: number;
}
/**
 * Extent metadata stored in SQL
 */
export interface ExtentMetadata {
    extentId: string;
    fileId: string;
    extentIndex: number;
    startPage: number;
    pageCount: number;
    compressed: boolean;
    originalSize: number;
    storedSize: number;
    checksum: string;
}
/**
 * Dirty page stored in SQL
 */
export interface DirtyPage {
    fileId: string;
    pageNum: number;
    data: Uint8Array;
    modifiedAt: number;
}
/**
 * ExtentStorage - Core storage layer for database page management.
 *
 * Provides efficient storage of database pages by packing them into
 * larger extents, reducing the number of storage operations and costs.
 *
 * @example
 * ```typescript
 * // Create extent storage
 * const storage = await createExtentStorage({
 *   pageSize: 4096,
 *   extentSize: 2 * 1024 * 1024,
 *   compression: 'gzip',
 *   backend: r2Storage,
 *   sql: sqlAdapter,
 * })
 *
 * // Write pages
 * await storage.writePage('mydb.sqlite', 0, page0Data)
 * await storage.writePage('mydb.sqlite', 1, page1Data)
 *
 * // Read pages
 * const page = await storage.readPage('mydb.sqlite', 0)
 *
 * // Flush to create extents
 * await storage.flush()
 * ```
 */
export declare class ExtentStorage {
    private readonly config;
    private readonly pagesPerExtent;
    private initialized;
    private extentCache;
    private readonly maxCacheSize;
    constructor(config: ExtentStorageConfig);
    /**
     * Initialize the storage (create tables if needed).
     */
    init(): Promise<void>;
    /**
     * Ensure storage is initialized.
     */
    private ensureInit;
    /**
     * Get or create file metadata.
     */
    private getOrCreateFile;
    /**
     * Update file size in metadata.
     */
    private updateFileSize;
    /**
     * Get the current file size.
     *
     * @param fileId - File identifier
     * @returns File size in bytes, or 0 if file doesn't exist
     */
    getFileSize(fileId: string): Promise<number>;
    /**
     * List all files.
     *
     * @returns Array of file IDs
     */
    listFiles(): Promise<string[]>;
    /**
     * Delete a file and all its extents.
     *
     * @param fileId - File identifier
     */
    deleteFile(fileId: string): Promise<void>;
    /**
     * Truncate a file to a specified size.
     *
     * @param fileId - File identifier
     * @param size - New file size in bytes
     */
    truncate(fileId: string, size: number): Promise<void>;
    /**
     * Read a page from the storage.
     *
     * Check order:
     * 1. Dirty pages (write buffer)
     * 2. Extent storage
     *
     * @param fileId - File identifier
     * @param pageNum - Page number (0-indexed)
     * @returns Page data, or null if page doesn't exist
     */
    readPage(fileId: string, pageNum: number): Promise<Uint8Array | null>;
    /**
     * Internal read page implementation.
     */
    private readPageInternal;
    /**
     * Write a page to the storage.
     *
     * Pages are buffered in the dirty_pages table until flushed.
     * Auto-flush occurs when the buffer reaches the threshold.
     *
     * @param fileId - File identifier
     * @param pageNum - Page number (0-indexed)
     * @param data - Page data (must match pageSize)
     */
    writePage(fileId: string, pageNum: number, data: Uint8Array): Promise<void>;
    /**
     * Get the count of dirty pages for a file.
     */
    private getDirtyPageCount;
    /**
     * Flush all dirty pages to extents.
     *
     * Groups dirty pages into extent-sized chunks, builds extent blobs,
     * writes to storage, and clears the dirty pages.
     */
    flush(): Promise<void>;
    /**
     * Flush dirty pages for a specific file.
     */
    private flushFile;
    /**
     * Write an extent to storage.
     */
    private writeExtent;
    /**
     * Find the extent containing a specific page.
     */
    private findExtentForPage;
    /**
     * Get extent data from cache or storage.
     */
    private getExtentData;
    /**
     * Cache an extent.
     */
    private cacheExtent;
    /**
     * Synchronous read page (for VFS compatibility).
     *
     * Note: This method is provided for VFS adapters that need sync I/O.
     * It requires dirty pages to be checked synchronously, and extents
     * must be pre-cached.
     *
     * @param fileId - File identifier
     * @param pageNum - Page number
     * @returns Page data, or null if not in dirty buffer or cache
     */
    readPageSync(fileId: string, pageNum: number): Uint8Array | null;
    /**
     * Synchronous write page (for VFS compatibility).
     *
     * @param fileId - File identifier
     * @param pageNum - Page number
     * @param data - Page data
     */
    writePageSync(fileId: string, pageNum: number, data: Uint8Array): void;
    /**
     * Get storage statistics.
     */
    getStats(): Promise<{
        totalFiles: number;
        totalExtents: number;
        totalDirtyPages: number;
        totalStoredBytes: number;
        cacheSize: number;
        cacheHitRate: number;
    }>;
    /**
     * Clear the extent cache.
     */
    clearCache(): void;
    /**
     * Pre-load extents into cache for a file.
     *
     * @param fileId - File identifier
     */
    preloadExtents(fileId: string): Promise<void>;
}
/**
 * Create and initialize an ExtentStorage instance.
 *
 * @param config - Storage configuration
 * @returns Initialized ExtentStorage instance
 *
 * @example
 * ```typescript
 * // For SQLite databases (4KB pages)
 * const sqliteStorage = await createExtentStorage({
 *   pageSize: 4096,
 *   extentSize: 2 * 1024 * 1024,
 *   compression: 'gzip',
 *   backend: r2Storage,
 *   sql: doSqlAdapter,
 * })
 *
 * // For PostgreSQL (8KB pages)
 * const pgStorage = await createExtentStorage({
 *   pageSize: 8192,
 *   extentSize: 2 * 1024 * 1024,
 *   compression: 'gzip',
 *   backend: r2Storage,
 *   sql: doSqlAdapter,
 * })
 * ```
 */
export declare function createExtentStorage(config: ExtentStorageConfig): Promise<ExtentStorage>;
//# sourceMappingURL=extent-storage.d.ts.map
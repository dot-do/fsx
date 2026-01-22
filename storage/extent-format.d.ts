/**
 * Extent Binary Format Utilities
 *
 * This module provides utilities for building, parsing, and manipulating extent
 * binary data structures for the extent-based VFS layer.
 *
 * An extent is a contiguous group of database pages stored as a single blob,
 * designed to reduce the number of storage operations when working with
 * databases on Durable Objects (where per-row operations are billed).
 *
 * Extent Format:
 * ```
 * +----------------------------------------------------------+
 * | Extent Header (64 bytes)                                  |
 * +----------------------------------------------------------+
 * | magic: 4 bytes ("EXT1" as little-endian 0x31545845)      |
 * | version: 2 bytes (1)                                      |
 * | flags: 2 bytes (bit 0 = compressed)                       |
 * | pageSize: 4 bytes (4096 or 8192)                         |
 * | pageCount: 4 bytes                                        |
 * | extentSize: 4 bytes (total data size)                    |
 * | checksum: 8 bytes (FNV-1a hash of page data)             |
 * | reserved: 36 bytes                                        |
 * +----------------------------------------------------------+
 * | Page Bitmap (ceil(pageCount/8) bytes)                    |
 * | - Bit set = page present at that index (LSB first)       |
 * +----------------------------------------------------------+
 * | Page Data (present pages x pageSize bytes)               |
 * | - Only present pages stored, in index order              |
 * +----------------------------------------------------------+
 * ```
 *
 * @module storage/extent-format
 */
/**
 * Magic number for extent files: "EXT1" as little-endian uint32.
 * Bytes: 0x45 ('E'), 0x58 ('X'), 0x54 ('T'), 0x31 ('1')
 * Little-endian: 0x31545845
 */
export declare const EXTENT_MAGIC = 827611205;
/**
 * Current extent format version.
 */
export declare const EXTENT_VERSION = 1;
/**
 * Size of the extent header in bytes.
 */
export declare const EXTENT_HEADER_SIZE = 64;
/**
 * Flag indicating the extent data is compressed.
 */
export declare const EXTENT_FLAG_COMPRESSED = 1;
/**
 * Extent header structure containing metadata about the extent.
 */
export interface ExtentHeader {
    /** Magic number (must be EXTENT_MAGIC = 0x31545845) */
    magic: number;
    /** Format version (currently 1) */
    version: number;
    /** Flags bitmask (bit 0 = compressed) */
    flags: number;
    /** Page size in bytes (4096 for SQLite, 8192 for PostgreSQL) */
    pageSize: number;
    /** Number of page slots in this extent */
    pageCount: number;
    /** Total size of page data in bytes (present pages only) */
    extentSize: number;
    /** FNV-1a 64-bit checksum of the page data */
    checksum: bigint;
}
/**
 * Options for building an extent.
 */
export interface BuildExtentOptions {
    /** Whether to mark the extent as compressed */
    compress?: boolean;
}
/**
 * Compute a 64-bit FNV-1a hash of the given data.
 *
 * FNV-1a is a fast, non-cryptographic hash function with good distribution.
 * It is suitable for checksums and hash tables but NOT for security purposes.
 *
 * @param data - The data to hash
 * @returns The 64-bit hash as a BigInt
 *
 * @example
 * ```typescript
 * const data = new Uint8Array([1, 2, 3, 4])
 * const hash = computeChecksum(data)
 * console.log(hash.toString(16)) // e.g., "f88a31dd4b1b4e24"
 * ```
 */
export declare function computeChecksum(data: Uint8Array): bigint;
/**
 * Build an extent from a map of pages.
 *
 * Creates a binary extent structure containing the header, page bitmap,
 * and page data. Only present pages are stored; the bitmap indicates
 * which page slots have data.
 *
 * @param pages - Map of page index to page data (0-based indices)
 * @param pageSize - Size of each page in bytes (typically 4096 or 8192)
 * @param options - Optional build options (e.g., compression flag)
 * @returns The complete extent as a Uint8Array
 *
 * @throws {Error} If pageSize is not positive
 * @throws {Error} If any page data size doesn't match pageSize
 *
 * @example
 * ```typescript
 * const pages = new Map<number, Uint8Array>()
 * pages.set(0, new Uint8Array(4096).fill(1))
 * pages.set(2, new Uint8Array(4096).fill(2))
 * // Page 1 is not present (sparse)
 *
 * const extent = buildExtent(pages, 4096)
 * // extent contains header + bitmap + pages 0 and 2
 * ```
 */
export declare function buildExtent(pages: Map<number, Uint8Array>, pageSize: number, options?: BuildExtentOptions): Uint8Array;
/**
 * Parse the extent header from binary data.
 *
 * Reads and validates the header structure from the beginning of an extent.
 * Does not validate the checksum; use validateExtent() for full validation.
 *
 * @param data - The extent binary data
 * @returns The parsed extent header
 *
 * @throws {Error} If data is too small for header
 * @throws {Error} If magic number is invalid
 * @throws {Error} If version is unsupported
 *
 * @example
 * ```typescript
 * const extent = await loadExtent()
 * const header = parseExtentHeader(extent)
 * console.log(`Page size: ${header.pageSize}`)
 * console.log(`Page count: ${header.pageCount}`)
 * console.log(`Compressed: ${(header.flags & EXTENT_FLAG_COMPRESSED) !== 0}`)
 * ```
 */
export declare function parseExtentHeader(data: Uint8Array): ExtentHeader;
/**
 * Get the page bitmap from an extent.
 *
 * The bitmap indicates which pages are present in the extent.
 * Bit N being set means page N has data stored (LSB first).
 *
 * @param extent - The extent binary data
 * @returns The page bitmap as a Uint8Array
 *
 * @throws {Error} If extent is invalid
 *
 * @example
 * ```typescript
 * const bitmap = getPageBitmap(extent)
 * for (let i = 0; i < pageCount; i++) {
 *   const byteIndex = Math.floor(i / 8)
 *   const bitIndex = i % 8
 *   const present = (bitmap[byteIndex] & (1 << bitIndex)) !== 0
 *   console.log(`Page ${i}: ${present ? 'present' : 'absent'}`)
 * }
 * ```
 */
export declare function getPageBitmap(extent: Uint8Array): Uint8Array;
/**
 * Check if a specific page is present in the extent.
 *
 * @param extent - The extent binary data
 * @param pageIndex - The 0-based page index to check
 * @returns true if the page is present, false otherwise
 *
 * @throws {Error} If extent is invalid
 *
 * @example
 * ```typescript
 * if (isPagePresent(extent, 5)) {
 *   const page = extractPage(extent, 5, 4096)
 *   // process page...
 * }
 * ```
 */
export declare function isPagePresent(extent: Uint8Array, pageIndex: number): boolean;
/**
 * Extract a specific page from an extent.
 *
 * Returns the page data if present, or null if the page slot is empty.
 * The page index is relative to this extent (0-based).
 *
 * @param extent - The extent binary data
 * @param pageIndex - The 0-based page index within this extent
 * @param pageSize - The size of each page in bytes
 * @returns The page data, or null if not present
 *
 * @throws {Error} If extent is invalid
 * @throws {Error} If pageSize doesn't match extent's page size
 *
 * @example
 * ```typescript
 * const page = extractPage(extent, 0, 4096)
 * if (page !== null) {
 *   console.log(`Read ${page.length} bytes from page 0`)
 * } else {
 *   console.log('Page 0 is not present in this extent')
 * }
 * ```
 */
export declare function extractPage(extent: Uint8Array, pageIndex: number, pageSize: number): Uint8Array | null;
/**
 * Validate the integrity of an extent.
 *
 * Performs the following checks:
 * 1. Header is valid (magic, version)
 * 2. Data size matches expected size
 * 3. Checksum matches computed checksum
 *
 * @param extent - The extent binary data
 * @returns true if the extent is valid, false otherwise
 *
 * @example
 * ```typescript
 * const extent = await loadExtent()
 * if (!validateExtent(extent)) {
 *   console.error('Extent is corrupted!')
 *   // Handle corruption...
 * }
 * ```
 */
export declare function validateExtent(extent: Uint8Array): boolean;
/**
 * Get the number of present pages in an extent.
 *
 * Counts the number of bits set in the page bitmap.
 *
 * @param extent - The extent binary data
 * @returns The number of present pages
 *
 * @throws {Error} If extent is invalid
 *
 * @example
 * ```typescript
 * const presentCount = getPresentPageCount(extent)
 * console.log(`Extent has ${presentCount} pages stored`)
 * ```
 */
export declare function getPresentPageCount(extent: Uint8Array): number;
/**
 * Get the indices of all present pages in an extent.
 *
 * @param extent - The extent binary data
 * @returns Array of 0-based page indices that are present
 *
 * @throws {Error} If extent is invalid
 *
 * @example
 * ```typescript
 * const presentIndices = getPresentPageIndices(extent)
 * for (const index of presentIndices) {
 *   const page = extractPage(extent, index, 4096)
 *   // process page...
 * }
 * ```
 */
export declare function getPresentPageIndices(extent: Uint8Array): number[];
/**
 * Check if an extent is compressed.
 *
 * @param extent - The extent binary data
 * @returns true if the extent is marked as compressed
 *
 * @throws {Error} If extent header is invalid
 *
 * @example
 * ```typescript
 * if (isExtentCompressed(extent)) {
 *   const decompressed = await decompress(extent)
 *   // process decompressed data...
 * }
 * ```
 */
export declare function isExtentCompressed(extent: Uint8Array): boolean;
/**
 * Calculate the bitmap size for a given page count.
 *
 * @param pageCount - The number of page slots
 * @returns The bitmap size in bytes
 *
 * @example
 * ```typescript
 * const bitmapSize = calculateBitmapSize(512)
 * console.log(`Bitmap for 512 pages: ${bitmapSize} bytes`) // 64 bytes
 * ```
 */
export declare function calculateBitmapSize(pageCount: number): number;
/**
 * Calculate the total extent size for given parameters.
 *
 * @param pageCount - Total number of page slots
 * @param presentPageCount - Number of pages with data
 * @param pageSize - Size of each page in bytes
 * @returns Total extent size in bytes
 *
 * @example
 * ```typescript
 * const size = calculateExtentSize(512, 100, 4096)
 * console.log(`Extent size: ${size} bytes`)
 * // 64 (header) + 64 (bitmap) + 409600 (100 * 4096) = 409728 bytes
 * ```
 */
export declare function calculateExtentSize(pageCount: number, presentPageCount: number, pageSize: number): number;
/**
 * Calculate the maximum number of pages per extent for a given extent size.
 *
 * @param extentSize - Target extent size in bytes (e.g., 2MB)
 * @param pageSize - Size of each page in bytes
 * @returns Maximum number of pages that can fit in the extent
 *
 * @example
 * ```typescript
 * const maxPages = calculatePagesPerExtent(2 * 1024 * 1024, 4096)
 * console.log(`Max pages: ${maxPages}`) // ~512 pages
 * ```
 */
export declare function calculatePagesPerExtent(extentSize: number, pageSize: number): number;
/**
 * Set a page as present in a bitmap (mutates the bitmap).
 *
 * @param bitmap - The bitmap Uint8Array
 * @param pageIndex - The 0-based page index to set
 *
 * @example
 * ```typescript
 * const bitmap = new Uint8Array(8) // 64 page slots
 * setPagePresent(bitmap, 0)
 * setPagePresent(bitmap, 5)
 * setPagePresent(bitmap, 63)
 * ```
 */
export declare function setPagePresent(bitmap: Uint8Array, pageIndex: number): void;
/**
 * Clear a page from a bitmap (mutates the bitmap).
 *
 * @param bitmap - The bitmap Uint8Array
 * @param pageIndex - The 0-based page index to clear
 *
 * @example
 * ```typescript
 * clearPagePresent(bitmap, 5)
 * ```
 */
export declare function clearPagePresent(bitmap: Uint8Array, pageIndex: number): void;
/**
 * Check if a page is present in a standalone bitmap.
 *
 * @param bitmap - The bitmap Uint8Array
 * @param pageIndex - The 0-based page index to check
 * @returns true if the page is present
 *
 * @example
 * ```typescript
 * const present = isPagePresentInBitmap(bitmap, 5)
 * ```
 */
export declare function isPagePresentInBitmap(bitmap: Uint8Array, pageIndex: number): boolean;
/**
 * Count the number of pages present in a standalone bitmap.
 *
 * Uses Brian Kernighan's algorithm for efficient bit counting.
 *
 * @param bitmap - The bitmap Uint8Array
 * @returns The number of bits set (present pages)
 *
 * @example
 * ```typescript
 * const count = countPresentPagesInBitmap(bitmap)
 * console.log(`${count} pages are present`)
 * ```
 */
export declare function countPresentPagesInBitmap(bitmap: Uint8Array): number;
/**
 * Default page size for SQLite (4KB)
 */
export declare const DEFAULT_PAGE_SIZE = 4096;
/**
 * Default extent size (2MB = 512 x 4KB pages)
 */
export declare const DEFAULT_EXTENT_SIZE: number;
/**
 * Compression codec for extent data
 */
export type ExtentCompression = 'none' | 'gzip' | 'zstd';
/**
 * Page entry for building extents (legacy API compatibility)
 */
export interface PageEntry {
    /** Page number within the file */
    pageNum: number;
    /** Page data */
    data: Uint8Array;
}
/**
 * Result from parsing an extent (legacy API compatibility)
 */
export interface ParsedExtent {
    /** Parsed header */
    header: ExtentHeader;
    /** Page bitmap (which pages are present) */
    bitmap: Uint8Array;
    /** Page data section */
    pageData: Uint8Array;
    /** Whether the extent is compressed */
    isCompressed: boolean;
    /** Whether the extent is sparse */
    isSparse: boolean;
}
/**
 * Parse a complete extent blob (legacy API compatibility)
 *
 * @param extent - Raw extent blob data
 * @returns Parsed extent with header, bitmap, and page data
 */
export declare function parseExtent(extent: Uint8Array): ParsedExtent;
/**
 * Get information about an extent without fully parsing page data (legacy API)
 *
 * @param extent - Raw extent blob data
 * @returns Extent header and basic info
 */
export declare function getExtentInfo(extent: Uint8Array): {
    header: ExtentHeader;
    bitmapSize: number;
    isSparse: boolean;
    isCompressed: boolean;
    presentPageCount: number;
};
//# sourceMappingURL=extent-format.d.ts.map
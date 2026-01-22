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
// =============================================================================
// Constants
// =============================================================================
/**
 * Magic number for extent files: "EXT1" as little-endian uint32.
 * Bytes: 0x45 ('E'), 0x58 ('X'), 0x54 ('T'), 0x31 ('1')
 * Little-endian: 0x31545845
 */
export const EXTENT_MAGIC = 0x31545845;
/**
 * Current extent format version.
 */
export const EXTENT_VERSION = 1;
/**
 * Size of the extent header in bytes.
 */
export const EXTENT_HEADER_SIZE = 64;
/**
 * Flag indicating the extent data is compressed.
 */
export const EXTENT_FLAG_COMPRESSED = 0x01;
// =============================================================================
// Checksum Implementation (FNV-1a 64-bit)
// =============================================================================
/**
 * FNV-1a 64-bit hash offset basis.
 */
const FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n;
/**
 * FNV-1a 64-bit hash prime.
 */
const FNV1A_64_PRIME = 0x100000001b3n;
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
export function computeChecksum(data) {
    let hash = FNV1A_64_OFFSET_BASIS;
    for (let i = 0; i < data.length; i++) {
        const byte = data[i];
        if (byte !== undefined) {
            hash ^= BigInt(byte);
            hash = (hash * FNV1A_64_PRIME) & 0xffffffffffffffffn; // Keep it 64-bit
        }
    }
    return hash;
}
// =============================================================================
// Extent Building
// =============================================================================
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
export function buildExtent(pages, pageSize, options) {
    // Validate pageSize
    if (pageSize <= 0) {
        throw new Error(`Invalid pageSize: ${pageSize}. Must be positive.`);
    }
    // Handle empty extent case
    if (pages.size === 0) {
        // Create an extent with no pages
        const bitmapSize = 0;
        const totalSize = EXTENT_HEADER_SIZE + bitmapSize;
        const extent = new Uint8Array(totalSize);
        const view = new DataView(extent.buffer);
        // Write header
        view.setUint32(0, EXTENT_MAGIC, true); // magic
        view.setUint16(4, EXTENT_VERSION, true); // version
        view.setUint16(6, options?.compress ? EXTENT_FLAG_COMPRESSED : 0, true); // flags
        view.setUint32(8, pageSize, true); // pageSize
        view.setUint32(12, 0, true); // pageCount
        view.setUint32(16, 0, true); // extentSize
        view.setBigUint64(20, 0n, true); // checksum (empty data)
        // bytes 28-63 are reserved (already zeroed)
        return extent;
    }
    // Validate page data sizes
    for (const [index, data] of pages) {
        if (data.length !== pageSize) {
            throw new Error(`Page ${index} has size ${data.length}, expected ${pageSize}`);
        }
    }
    // Determine the page count (highest index + 1)
    const maxIndex = Math.max(...pages.keys());
    const pageCount = maxIndex + 1;
    // Calculate bitmap size
    const bitmapSize = Math.ceil(pageCount / 8);
    // Calculate total data size (only present pages)
    const presentPageCount = pages.size;
    const dataSize = presentPageCount * pageSize;
    // Calculate total extent size
    const totalSize = EXTENT_HEADER_SIZE + bitmapSize + dataSize;
    // Allocate extent buffer
    const extent = new Uint8Array(totalSize);
    const view = new DataView(extent.buffer);
    // Build bitmap (LSB first: bit 0 of byte 0 = page 0)
    const bitmap = new Uint8Array(bitmapSize);
    for (const index of pages.keys()) {
        const byteIndex = Math.floor(index / 8);
        const bitIndex = index % 8;
        const currentByte = bitmap[byteIndex];
        if (currentByte !== undefined) {
            bitmap[byteIndex] = currentByte | (1 << bitIndex);
        }
    }
    // Collect page data in order (sorted by index)
    const sortedIndices = [...pages.keys()].sort((a, b) => a - b);
    const pageData = new Uint8Array(dataSize);
    let offset = 0;
    for (const index of sortedIndices) {
        const data = pages.get(index);
        if (data) {
            pageData.set(data, offset);
            offset += pageSize;
        }
    }
    // Compute checksum of page data
    const checksum = computeChecksum(pageData);
    // Write header (all little-endian)
    view.setUint32(0, EXTENT_MAGIC, true); // magic
    view.setUint16(4, EXTENT_VERSION, true); // version
    view.setUint16(6, options?.compress ? EXTENT_FLAG_COMPRESSED : 0, true); // flags
    view.setUint32(8, pageSize, true); // pageSize
    view.setUint32(12, pageCount, true); // pageCount
    view.setUint32(16, dataSize, true); // extentSize
    view.setBigUint64(20, checksum, true); // checksum
    // bytes 28-63 are reserved (already zeroed)
    // Write bitmap
    extent.set(bitmap, EXTENT_HEADER_SIZE);
    // Write page data
    extent.set(pageData, EXTENT_HEADER_SIZE + bitmapSize);
    return extent;
}
// =============================================================================
// Extent Parsing
// =============================================================================
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
export function parseExtentHeader(data) {
    if (data.length < EXTENT_HEADER_SIZE) {
        throw new Error(`Extent data too small: ${data.length} bytes, minimum is ${EXTENT_HEADER_SIZE}`);
    }
    const view = new DataView(data.buffer, data.byteOffset, data.length);
    const magic = view.getUint32(0, true);
    if (magic !== EXTENT_MAGIC) {
        throw new Error(`Invalid extent magic: 0x${magic.toString(16)}, expected 0x${EXTENT_MAGIC.toString(16)}`);
    }
    const version = view.getUint16(4, true);
    if (version !== EXTENT_VERSION) {
        throw new Error(`Unsupported extent version: ${version}, expected ${EXTENT_VERSION}`);
    }
    const flags = view.getUint16(6, true);
    const pageSize = view.getUint32(8, true);
    const pageCount = view.getUint32(12, true);
    const extentSize = view.getUint32(16, true);
    const checksum = view.getBigUint64(20, true);
    return {
        magic,
        version,
        flags,
        pageSize,
        pageCount,
        extentSize,
        checksum,
    };
}
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
export function getPageBitmap(extent) {
    const header = parseExtentHeader(extent);
    const bitmapSize = Math.ceil(header.pageCount / 8);
    if (extent.length < EXTENT_HEADER_SIZE + bitmapSize) {
        throw new Error(`Extent data too small for bitmap: ${extent.length} bytes, ` +
            `need at least ${EXTENT_HEADER_SIZE + bitmapSize}`);
    }
    return extent.slice(EXTENT_HEADER_SIZE, EXTENT_HEADER_SIZE + bitmapSize);
}
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
export function isPagePresent(extent, pageIndex) {
    const header = parseExtentHeader(extent);
    // Check if index is within range
    if (pageIndex < 0 || pageIndex >= header.pageCount) {
        return false;
    }
    const bitmapSize = Math.ceil(header.pageCount / 8);
    if (extent.length < EXTENT_HEADER_SIZE + bitmapSize) {
        throw new Error('Extent data too small for bitmap');
    }
    const byteIndex = Math.floor(pageIndex / 8);
    const bitIndex = pageIndex % 8;
    const bitmapByte = extent[EXTENT_HEADER_SIZE + byteIndex];
    return bitmapByte !== undefined && (bitmapByte & (1 << bitIndex)) !== 0;
}
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
export function extractPage(extent, pageIndex, pageSize) {
    const header = parseExtentHeader(extent);
    // Validate pageSize matches
    if (pageSize !== header.pageSize) {
        throw new Error(`Page size mismatch: requested ${pageSize}, extent has ${header.pageSize}`);
    }
    // Check if page is within range
    if (pageIndex < 0 || pageIndex >= header.pageCount) {
        return null;
    }
    // Check if page is present in bitmap
    if (!isPagePresent(extent, pageIndex)) {
        return null;
    }
    // Calculate the offset of this page in the data section
    // We need to count how many pages before this one are present
    const bitmapSize = Math.ceil(header.pageCount / 8);
    let precedingPagesPresent = 0;
    for (let i = 0; i < pageIndex; i++) {
        const byteIndex = Math.floor(i / 8);
        const bitIndex = i % 8;
        const byte = extent[EXTENT_HEADER_SIZE + byteIndex];
        if (byte !== undefined && (byte & (1 << bitIndex)) !== 0) {
            precedingPagesPresent++;
        }
    }
    const dataOffset = EXTENT_HEADER_SIZE + bitmapSize + precedingPagesPresent * pageSize;
    // Validate we have enough data
    if (extent.length < dataOffset + pageSize) {
        throw new Error(`Extent data truncated: expected at least ${dataOffset + pageSize} bytes, ` +
            `got ${extent.length}`);
    }
    // Extract and return a copy of the page data
    return extent.slice(dataOffset, dataOffset + pageSize);
}
// =============================================================================
// Extent Validation
// =============================================================================
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
export function validateExtent(extent) {
    try {
        // Parse and validate header
        const header = parseExtentHeader(extent);
        // Calculate expected size
        const bitmapSize = Math.ceil(header.pageCount / 8);
        const expectedMinSize = EXTENT_HEADER_SIZE + bitmapSize + header.extentSize;
        if (extent.length < expectedMinSize) {
            return false;
        }
        // Handle empty extent
        if (header.extentSize === 0) {
            return header.checksum === 0n;
        }
        // Extract page data
        const pageDataStart = EXTENT_HEADER_SIZE + bitmapSize;
        const pageData = extent.slice(pageDataStart, pageDataStart + header.extentSize);
        // Verify checksum
        const computedChecksum = computeChecksum(pageData);
        return computedChecksum === header.checksum;
    }
    catch {
        return false;
    }
}
// =============================================================================
// Utility Functions
// =============================================================================
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
export function getPresentPageCount(extent) {
    const header = parseExtentHeader(extent);
    const bitmap = getPageBitmap(extent);
    let count = 0;
    for (let i = 0; i < header.pageCount; i++) {
        const byteIndex = Math.floor(i / 8);
        const bitIndex = i % 8;
        const byte = bitmap[byteIndex];
        if (byte !== undefined && (byte & (1 << bitIndex)) !== 0) {
            count++;
        }
    }
    return count;
}
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
export function getPresentPageIndices(extent) {
    const header = parseExtentHeader(extent);
    const bitmap = getPageBitmap(extent);
    const indices = [];
    for (let i = 0; i < header.pageCount; i++) {
        const byteIndex = Math.floor(i / 8);
        const bitIndex = i % 8;
        const byte = bitmap[byteIndex];
        if (byte !== undefined && (byte & (1 << bitIndex)) !== 0) {
            indices.push(i);
        }
    }
    return indices;
}
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
export function isExtentCompressed(extent) {
    const header = parseExtentHeader(extent);
    return (header.flags & EXTENT_FLAG_COMPRESSED) !== 0;
}
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
export function calculateBitmapSize(pageCount) {
    return Math.ceil(pageCount / 8);
}
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
export function calculateExtentSize(pageCount, presentPageCount, pageSize) {
    const bitmapSize = calculateBitmapSize(pageCount);
    return EXTENT_HEADER_SIZE + bitmapSize + presentPageCount * pageSize;
}
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
export function calculatePagesPerExtent(extentSize, pageSize) {
    // Account for header; bitmap is proportional to page count
    // extentSize = HEADER + ceil(pageCount/8) + pageCount * pageSize
    // Approximate: extentSize ≈ HEADER + pageCount * (pageSize + 1/8)
    const usableSize = extentSize - EXTENT_HEADER_SIZE;
    const effectivePageSize = pageSize + 0.125; // 1/8 byte for bitmap
    return Math.floor(usableSize / effectivePageSize);
}
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
export function setPagePresent(bitmap, pageIndex) {
    const byteIndex = Math.floor(pageIndex / 8);
    const bitIndex = pageIndex % 8;
    if (byteIndex < bitmap.length) {
        const currentByte = bitmap[byteIndex];
        if (currentByte !== undefined) {
            bitmap[byteIndex] = currentByte | (1 << bitIndex);
        }
    }
}
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
export function clearPagePresent(bitmap, pageIndex) {
    const byteIndex = Math.floor(pageIndex / 8);
    const bitIndex = pageIndex % 8;
    if (byteIndex < bitmap.length) {
        const currentByte = bitmap[byteIndex];
        if (currentByte !== undefined) {
            bitmap[byteIndex] = currentByte & ~(1 << bitIndex);
        }
    }
}
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
export function isPagePresentInBitmap(bitmap, pageIndex) {
    const byteIndex = Math.floor(pageIndex / 8);
    const bitIndex = pageIndex % 8;
    if (byteIndex >= bitmap.length)
        return false;
    const byte = bitmap[byteIndex];
    return byte !== undefined && (byte & (1 << bitIndex)) !== 0;
}
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
export function countPresentPagesInBitmap(bitmap) {
    let count = 0;
    for (let i = 0; i < bitmap.length; i++) {
        let byte = bitmap[i];
        // Brian Kernighan's algorithm
        while (byte) {
            byte &= byte - 1;
            count++;
        }
    }
    return count;
}
// =============================================================================
// Compatibility Types and Functions
// (For backward compatibility with extent-storage.ts)
// =============================================================================
/**
 * Default page size for SQLite (4KB)
 */
export const DEFAULT_PAGE_SIZE = 4096;
/**
 * Default extent size (2MB = 512 x 4KB pages)
 */
export const DEFAULT_EXTENT_SIZE = 2 * 1024 * 1024;
/**
 * Parse a complete extent blob (legacy API compatibility)
 *
 * @param extent - Raw extent blob data
 * @returns Parsed extent with header, bitmap, and page data
 */
export function parseExtent(extent) {
    // Parse header
    const header = parseExtentHeader(extent);
    // Calculate bitmap size
    const bitmapSize = Math.ceil(header.pageCount / 8);
    // Extract bitmap
    const bitmap = extent.slice(EXTENT_HEADER_SIZE, EXTENT_HEADER_SIZE + bitmapSize);
    // Extract page data
    const pageDataOffset = EXTENT_HEADER_SIZE + bitmapSize;
    const pageData = extent.slice(pageDataOffset, pageDataOffset + header.extentSize);
    // Determine flags
    const isCompressed = (header.flags & EXTENT_FLAG_COMPRESSED) !== 0;
    // All extents with a bitmap are considered sparse in the new format
    const isSparse = header.pageCount > 0;
    return {
        header,
        bitmap,
        pageData,
        isCompressed,
        isSparse,
    };
}
/**
 * Get information about an extent without fully parsing page data (legacy API)
 *
 * @param extent - Raw extent blob data
 * @returns Extent header and basic info
 */
export function getExtentInfo(extent) {
    const header = parseExtentHeader(extent);
    const isCompressed = (header.flags & EXTENT_FLAG_COMPRESSED) !== 0;
    const bitmapSize = Math.ceil(header.pageCount / 8);
    let presentPageCount = 0;
    if (header.pageCount > 0) {
        const bitmap = extent.slice(EXTENT_HEADER_SIZE, EXTENT_HEADER_SIZE + bitmapSize);
        presentPageCount = countPresentPagesInBitmap(bitmap);
    }
    return {
        header,
        bitmapSize,
        isSparse: header.pageCount > 0,
        isCompressed,
        presentPageCount,
    };
}
//# sourceMappingURL=extent-format.js.map
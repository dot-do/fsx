/**
 * Storage backends for fsx
 *
 * This module provides storage implementations for the fsx filesystem:
 *
 * - {@link R2Storage} - R2-backed blob storage
 * - {@link SQLiteMetadata} - SQLite-backed metadata store
 * - {@link TieredFS} - Multi-tier filesystem with automatic placement
 * - {@link TieredR2Storage} - R2-backed tiered storage with migration
 *
 * @module storage
 */
// Core storage interfaces
export { 
// Error handling
StorageError, 
// Helper functions
createOperationContext, createOperationResult, withInstrumentation, } from './interfaces.js';
// Storage implementations
export { TieredFS } from './tiered.js';
export { R2Storage } from './r2.js';
export { SQLiteMetadata } from './sqlite.js';
export { R2Backend } from './r2-backend.js';
export { TieredR2Storage,
// Note: TieredReadResult and TieredWriteResult are exported from ./interfaces.js
// to avoid TS2300 duplicate identifier errors
 } from './tiered-r2.js';
// Content-Addressable Storage (re-exported from core)
export { ContentAddressableFS, } from '../core/cas/content-addressable-fs.js';
export { sha1, sha256, bytesToHex, hexToBytes } from '../core/cas/hash.js';
export { compress, decompress } from '../core/cas/compression.js';
export { hashToPath, pathToHash } from '../core/cas/path-mapping.js';
// Columnar Storage Pattern (cost-optimized DO SQLite)
export { 
// Write buffer cache
WriteBufferCache, } from './write-buffer.js';
export { 
// Columnar store
ColumnarStore, 
// Cost analysis utilities
analyzeWorkloadCost, printCostReport, } from './columnar.js';
// Blob Management Utilities
export { 
// ID generation
computeChecksum, generateBlobId, blobIdFromChecksum, checksumFromBlobId, isValidBlobId, BLOB_ID_PREFIX, 
// Tier management
selectTierBySize, getTierTransition, isValidTierTransition, createCleanupSchedulerState, DEFAULT_CLEANUP_CONFIG, 
// Deduplication
prepareDedupCheck, 
// Statistics
calculateDedupSavings, calculateDedupRatio, } from './blob-utils.js';
// Page Storage (2MB BLOB chunking for DO cost optimization)
export { 
// Factory function
createPageStorage, 
// Constants
CHUNK_SIZE, PAGE_KEY_PREFIX, PAGE_META_PREFIX, } from './page-storage.js';
// Chunked Blob Storage (PageStorage + SQLite metadata integration)
export { 
// Factory function
createChunkedBlobStorage, } from './chunked-blob-storage.js';
// Page Metadata Store (SQLite-based page tracking for VFS)
export { 
// Class
PageMetadataStore, } from './page-metadata.js';
// LRU Eviction Manager (DO to R2 cold page eviction)
export { 
// Factory function
createLRUEvictionManager, 
// Implementation class
LRUEvictionManagerImpl, } from './lru-eviction.js';
// R2 Cold Storage Compression (optional compression for R2 pages)
export { 
// Factory function
createR2ColdStorageCompressor, 
// Constants
DEFAULT_SKIP_MIME_TYPES, } from './compression.js';
// Extent Storage (VFS core layer for database page management)
export { 
// Factory function
createExtentStorage, 
// Class
ExtentStorage, 
// Constants
DEFAULT_PAGE_SIZE, DEFAULT_EXTENT_SIZE, } from './extent-storage.js';
// Extent Format Utilities (binary format for extent blobs)
export { 
// Building/parsing
buildExtent, parseExtentHeader, extractPage, validateExtent, 
// Bitmap utilities
calculateBitmapSize, setPagePresent, clearPagePresent, isPagePresent, isPagePresentInBitmap, countPresentPagesInBitmap, 
// Extent info
getPageBitmap, getPresentPageCount, getPresentPageIndices, isExtentCompressed, calculateExtentSize, calculatePagesPerExtent, 
// Checksum
computeChecksum as computeExtentChecksum, 
// Constants
EXTENT_MAGIC, EXTENT_VERSION, EXTENT_HEADER_SIZE, EXTENT_FLAG_COMPRESSED, } from './extent-format.js';
// Backend Implementations
export { 
// Cache API Backend (FREE, ephemeral storage)
CacheBlobStorage, createCacheBackend, } from './backends/cache-backend.js';
//# sourceMappingURL=index.js.map
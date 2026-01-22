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
export { StorageError, type StorageErrorCode, type StorageHooks, type StorageOperationContext, type StorageOperationResult, type BlobStorage, type BlobWriteResult, type BlobReadResult, type BlobListResult, type BlobObjectInfo, type BlobWriteOptions, type BlobListOptions, type MetadataStorage, type CreateEntryOptions, type UpdateEntryOptions, type StorageStats, type TieredStorage, type TieredWriteResult, type TieredReadResult, createOperationContext, createOperationResult, withInstrumentation, } from './interfaces.js';
export { TieredFS, type TieredFSConfig } from './tiered.js';
export { R2Storage, type R2StorageConfig } from './r2.js';
export { SQLiteMetadata } from './sqlite.js';
export { R2Backend, type R2BackendConfig } from './r2-backend.js';
export { TieredR2Storage, type TieredR2StorageConfig, type TierPolicy, type TieredFileMetadata, type TieredStorageResult, } from './tiered-r2.js';
export { ContentAddressableFS, type CASObject, type CASStorage, type ObjectType, } from '../core/cas/content-addressable-fs.js';
export { sha1, sha256, bytesToHex, hexToBytes } from '../core/cas/hash.js';
export { compress, decompress } from '../core/cas/compression.js';
export { hashToPath, pathToHash } from '../core/cas/path-mapping.js';
export { WriteBufferCache, type WriteBufferCacheOptions, type EvictionReason, type CacheStats, } from './write-buffer.js';
export { ColumnarStore, type ColumnType, type ColumnDefinition, type SchemaDefinition, type CheckpointTriggers, type ColumnarStoreOptions, type CheckpointStats, type CostComparison, analyzeWorkloadCost, printCostReport, } from './columnar.js';
export { computeChecksum, generateBlobId, blobIdFromChecksum, checksumFromBlobId, isValidBlobId, BLOB_ID_PREFIX, selectTierBySize, getTierTransition, isValidTierTransition, type TierTransition, type CleanupConfig, type CleanupResult, type CleanupSchedulerState, createCleanupSchedulerState, DEFAULT_CLEANUP_CONFIG, prepareDedupCheck, type DedupCheckResult, calculateDedupSavings, calculateDedupRatio, type BlobStats, } from './blob-utils.js';
export { createPageStorage, CHUNK_SIZE, PAGE_KEY_PREFIX, PAGE_META_PREFIX, type PageStorage, type PageStorageConfig, type PageMetadata, } from './page-storage.js';
export { createChunkedBlobStorage, type ChunkedBlobStorage, type ChunkedBlobStorageConfig, type ChunkedBlobMetadata, type ChunkedWriteResult, } from './chunked-blob-storage.js';
export { PageMetadataStore, type PageMetadata as SQLitePageMetadata, type CreatePageOptions, type UpdatePageOptions, type TierStats, } from './page-metadata.js';
export { createLRUEvictionManager, LRUEvictionManagerImpl, type LRUEvictionManager, type EvictionConfig, type EvictionResult, type PageMeta as LRUPageMeta, type DOStorageInterface, type R2BucketInterface, } from './lru-eviction.js';
export { createR2ColdStorageCompressor, DEFAULT_SKIP_MIME_TYPES, type R2ColdStorageCompressor, type CompressionCodec, type CompressedPageMetadata, type CompressionConfig, type CompressionResult, type CompressionStats, } from './compression.js';
export { createExtentStorage, ExtentStorage, DEFAULT_PAGE_SIZE, DEFAULT_EXTENT_SIZE, type ExtentStorageConfig, type ExtentCompression, type ExtentFileMetadata, type ExtentMetadata, type DirtyPage, type SqlStorageAdapter, type SqlResultSet, type SqlRow, } from './extent-storage.js';
export { buildExtent, parseExtentHeader, extractPage, validateExtent, calculateBitmapSize, setPagePresent, clearPagePresent, isPagePresent, isPagePresentInBitmap, countPresentPagesInBitmap, getPageBitmap, getPresentPageCount, getPresentPageIndices, isExtentCompressed, calculateExtentSize, calculatePagesPerExtent, computeChecksum as computeExtentChecksum, EXTENT_MAGIC, EXTENT_VERSION, EXTENT_HEADER_SIZE, EXTENT_FLAG_COMPRESSED, type ExtentHeader, type BuildExtentOptions, } from './extent-format.js';
export { CacheBlobStorage, createCacheBackend, type CacheBackendConfig, type CachePutOptions, } from './backends/cache-backend.js';
//# sourceMappingURL=index.d.ts.map
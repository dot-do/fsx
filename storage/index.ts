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
  type StorageErrorCode,
  // Instrumentation hooks
  type StorageHooks,
  type StorageOperationContext,
  type StorageOperationResult,
  // Blob storage interface
  type BlobStorage,
  type BlobWriteResult,
  type BlobReadResult,
  type BlobListResult,
  type BlobObjectInfo,
  type BlobWriteOptions,
  type BlobListOptions,
  // Metadata storage interface
  type MetadataStorage,
  type CreateEntryOptions,
  type UpdateEntryOptions,
  type StorageStats,
  // Tiered storage interface
  type TieredStorage,
  type TieredWriteResult,
  type TieredReadResult,
  // Helper functions
  createOperationContext,
  createOperationResult,
  withInstrumentation,
} from './interfaces.js'

// Storage implementations
export { TieredFS, type TieredFSConfig } from './tiered.js'
export { R2Storage, type R2StorageConfig } from './r2.js'
export { SQLiteMetadata } from './sqlite.js'
export {
  TieredR2Storage,
  type TieredR2StorageConfig,
  type TierPolicy,
  type TieredFileMetadata,
  type TieredStorageResult,
  // Note: TieredReadResult and TieredWriteResult are exported from ./interfaces.js
  // to avoid TS2300 duplicate identifier errors
} from './tiered-r2.js'

// Content-Addressable Storage (re-exported from core)
export {
  ContentAddressableFS,
  type CASObject,
  type CASStorage,
  type ObjectType,
} from '../core/cas/content-addressable-fs.js'
export { sha1, sha256, bytesToHex, hexToBytes } from '../core/cas/hash.js'
export { compress, decompress } from '../core/cas/compression.js'
export { hashToPath, pathToHash } from '../core/cas/path-mapping.js'

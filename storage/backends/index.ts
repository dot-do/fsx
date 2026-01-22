/**
 * Storage Backend Exports
 *
 * Provides a unified export for all storage backend implementations.
 * Each backend implements the BlobStorage interface from ../interfaces.ts.
 *
 * Available Backends:
 * - KVBlobStorage: Cloudflare KV (warm tier, global replication)
 * - CacheBlobStorage: Cloudflare Cache API (edge caching, ephemeral)
 * - (Future) R2BlobStorage: Cloudflare R2 (cold tier, large objects)
 * - (Future) MemoryBlobStorage: In-memory (testing, development)
 *
 * @module storage/backends
 */

// KV Backend
export {
  KVBlobStorage,
  createKVBackend,
  KV_BACKEND_CAPABILITIES,
  type KVBackendConfig,
  type KVNamespace,
} from './kv-backend.js'

// Cache Backend
export {
  CacheBlobStorage,
  createCacheBackend,
  type CacheBackendConfig,
  type CachePutOptions,
} from './cache-backend.js'

// R2+Cache Backend (Read-Through)
export {
  R2CacheBlobStorage,
  createR2CacheBackend,
  type R2CacheBackendConfig,
  type R2CacheWriteOptions,
} from './r2-cache-backend.js'

// Re-export common interfaces for convenience
export type {
  BlobStorage,
  BlobReadResult,
  BlobWriteResult,
  BlobListResult,
  BlobListOptions,
  BlobWriteOptions,
  BlobObjectInfo,
  StorageHooks,
} from '../interfaces.js'

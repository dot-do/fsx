/**
 * Storage backends for fsx
 */

export { TieredFS, type TieredFSConfig } from './tiered.js'
export { R2Storage, type R2StorageConfig } from './r2.js'
export { SQLiteMetadata } from './sqlite.js'
export {
  TieredR2Storage,
  type TieredR2StorageConfig,
  type TierPolicy,
  type TieredFileMetadata,
  type TieredStorageResult,
  type TieredReadResult,
  type TieredWriteResult,
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

/**
 * Storage backends for fsx
 */

export { TieredFS, type TieredFSConfig } from './tiered.js'
export { R2Storage, type R2StorageConfig } from './r2.js'
export { SQLiteMetadata } from './sqlite.js'

// Content-Addressable Storage
export {
  ContentAddressableFS,
  type CASObject,
  type CASStorage,
  type ObjectType,
} from '../cas/content-addressable-fs.js'
export { sha1, sha256, bytesToHex, hexToBytes } from '../cas/hash.js'
export { compress, decompress } from '../cas/compression.js'
export { hashToPath, pathToHash } from '../cas/path-mapping.js'

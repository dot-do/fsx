/**
 * Core filesystem module
 *
 * This module exports the core types and utilities for the fsx.do filesystem.
 * It provides a POSIX-like API for filesystem operations on Cloudflare Durable
 * Objects with tiered storage support.
 *
 * @module core
 */

export { FSx, type FSxOptions } from './fsx.js'
export { constants, type Constants } from './constants.js'
export { FSError, ENOENT, EEXIST, EISDIR, ENOTDIR, EACCES, ENOTEMPTY, EINVAL, ELOOP, ENAMETOOLONG, ENOSPC, EROFS, EBUSY, EMFILE, EXDEV } from './errors.js'
export type {
  // Core capability interface
  FsCapability,

  // Storage tier type
  StorageTier,

  // File statistics types
  FileStat,
  Stats,
  StatsInit,
  StatsLike,

  // Directory entry types
  Dirent,
  DirentType,
  FileType,
  FileEntry,
  FileMode,

  // Operation options
  ReadOptions,
  WriteOptions,
  ListOptions,
  CopyOptions,
  MoveOptions,
  RemoveOptions,
  ReadStreamOptions,
  WriteStreamOptions,
  MkdirOptions,
  RmdirOptions,
  ReaddirOptions,
  WatchOptions,

  // Result types
  WriteResult,
  ReadResult,

  // File handle and watcher
  FileHandle,
  FSWatcher,

  // Encoding and storage
  BufferEncoding,
  BlobRef,
} from './types.js'

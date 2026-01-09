/**
 * fsx.do - Filesystem on Cloudflare Durable Objects
 *
 * A virtual filesystem for the edge with POSIX-like API,
 * tiered storage, and MCP integration for AI-assisted operations.
 *
 * @example
 * ```typescript
 * import { FSx, type FsCapability } from 'fsx.do'
 *
 * const fs = new FSx(env.FSX)
 * await fs.writeFile('/hello.txt', 'Hello, World!')
 * const content = await fs.readFile('/hello.txt', 'utf-8')
 * ```
 *
 * @packageDocumentation
 */

// Core filesystem API
export { FSx, type FSxOptions } from './core/fsx.js'

// Types - Core capability interface
export type {
  // Main capability interface for dotdo integration
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
} from './core/types.js'

// Constants
export { constants } from './core/constants.js'

// Errors
export { FSError, ENOENT, EEXIST, EISDIR, ENOTDIR, EACCES, ENOTEMPTY } from './core/errors.js'

// Durable Object
export { FileSystemDO } from './durable-object/index.js'

// MCP Tools
export { fsTools, invokeTool, registerTool } from './mcp/index.js'

// Storage backends
export { TieredFS, R2Storage, SQLiteMetadata } from './storage/index.js'

// Unix-like utilities
export { match, createMatcher, type MatchOptions } from './glob/match.js'
export { glob, type GlobOptions } from './glob/glob.js'
export { find, type FindOptions, type FindResult } from './find/find.js'
export { grep, type GrepOptions, type GrepMatch, type GrepResult } from './grep/grep.js'

// Sparse checkout patterns
export { parsePattern, type ParsedPattern } from './sparse/patterns.js'

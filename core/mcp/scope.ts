/**
 * DoScope for MCP filesystem operations
 *
 * Provides a sandboxed scope with fs bindings for use with the `do` tool.
 * The fs binding exposes filesystem operations that can be executed in
 * sandboxed code.
 *
 * @module core/mcp/scope
 */

import type { StorageBackend } from './shared'

// =============================================================================
// Types
// =============================================================================

/**
 * Permissions for the scope's sandbox environment.
 */
export interface FsPermissions {
  /** Whether write operations are allowed */
  allowWrite?: boolean
  /** Whether delete operations are allowed */
  allowDelete?: boolean
  /** List of allowed paths (if specified, only these paths are accessible) */
  allowedPaths?: string[]
}

/**
 * The scope configuration for the Do tool with fs binding.
 */
export interface FsDoScope {
  /**
   * Bindings to inject into the sandbox.
   * The `fs` binding provides filesystem operations.
   */
  bindings: {
    fs: FsBinding
    [key: string]: unknown
  }

  /**
   * TypeScript .d.ts content describing the bindings.
   * Used by the LLM to generate correctly typed code.
   */
  types: string

  /** Optional execution timeout in milliseconds */
  timeout?: number

  /** Optional permissions for the sandbox environment */
  permissions?: FsPermissions
}

/**
 * File stat result returned by fs.stat()
 */
export interface FsStatResult {
  /** File size in bytes */
  size: number
  /** True if regular file */
  isFile: boolean
  /** True if directory */
  isDirectory: boolean
  /** True if symbolic link */
  isSymbolicLink: boolean
  /** Modification time (ms since epoch) */
  mtime: number
  /** Creation time (ms since epoch) */
  birthtime: number
  /** File mode (permissions) */
  mode: number
}

/**
 * Directory entry returned by fs.list()
 */
export interface FsListEntry {
  /** Entry name (basename) */
  name: string
  /** Entry type */
  type: 'file' | 'directory' | 'symlink'
  /** File size in bytes */
  size?: number
}

/**
 * Options for fs.list()
 */
export interface FsListOptions {
  /** Include hidden files (starting with .) */
  showHidden?: boolean
  /** Include file details (size, type) */
  withDetails?: boolean
}

/**
 * Options for fs.tree()
 */
export interface FsTreeOptions {
  /** Maximum depth to traverse */
  maxDepth?: number
  /** Include hidden files */
  showHidden?: boolean
  /** Show file sizes */
  showSize?: boolean
}

/**
 * Options for fs.search()
 */
export interface FsSearchOptions {
  /** Search within file contents */
  contentSearch?: string
  /** Case-sensitive content search */
  caseSensitive?: boolean
  /** Maximum search depth */
  maxDepth?: number
  /** Patterns to exclude */
  exclude?: string[]
  /** Include hidden files */
  showHidden?: boolean
  /** Maximum number of results */
  limit?: number
}

/**
 * Options for fs.mkdir()
 */
export interface FsMkdirOptions {
  /** Create parent directories if needed */
  recursive?: boolean
  /** Permission mode (e.g., 0o755) */
  mode?: number
}

/**
 * The fs binding interface available in the sandbox.
 *
 * This provides filesystem operations that can be called from
 * code executed by the `do` tool.
 */
export interface FsBinding {
  /**
   * Read file contents as string.
   * @param path - File path to read
   * @returns File contents as UTF-8 string
   */
  read(path: string): Promise<string>

  /**
   * Write content to a file.
   * @param path - File path to write
   * @param content - Content to write
   */
  write(path: string, content: string): Promise<void>

  /**
   * Append content to a file.
   * @param path - File path to append to
   * @param content - Content to append
   */
  append(path: string, content: string): Promise<void>

  /**
   * Delete a file or directory.
   * @param path - Path to delete
   */
  delete(path: string): Promise<void>

  /**
   * Move/rename a file or directory.
   * @param from - Source path
   * @param to - Destination path
   */
  move(from: string, to: string): Promise<void>

  /**
   * Copy a file.
   * @param from - Source file path
   * @param to - Destination file path
   */
  copy(from: string, to: string): Promise<void>

  /**
   * Create a directory.
   * @param path - Directory path to create
   * @param options - Optional mkdir options
   */
  mkdir(path: string, options?: FsMkdirOptions): Promise<void>

  /**
   * Get file/directory statistics.
   * @param path - Path to stat
   * @returns Stat result with size, type, timestamps
   */
  stat(path: string): Promise<FsStatResult>

  /**
   * List directory contents.
   * @param path - Directory path to list
   * @param options - Optional list options
   * @returns Array of entry names or entry objects
   */
  list(path: string, options?: FsListOptions): Promise<string[] | FsListEntry[]>

  /**
   * Generate directory tree visualization.
   * @param path - Directory path to visualize
   * @param options - Optional tree options
   * @returns ASCII tree string
   */
  tree(path: string, options?: FsTreeOptions): Promise<string>

  /**
   * Search for files matching a glob pattern.
   * @param pattern - Glob pattern to match
   * @param options - Optional search options
   * @returns Array of matching paths
   */
  search(pattern: string, options?: FsSearchOptions): Promise<string[]>

  /**
   * Check if a file or directory exists.
   * @param path - Path to check
   * @returns True if path exists
   */
  exists(path: string): Promise<boolean>
}

// =============================================================================
// Extended Storage Backend
// =============================================================================

/**
 * Extended storage backend interface with additional methods for fs binding.
 */
export interface ExtendedFsStorage extends StorageBackend {
  /** Add a file to storage */
  addFile(path: string, content: string | Uint8Array, options?: { mode?: number }): void
  /** Add a directory to storage */
  addDirectory(path: string, options?: { mode?: number }): void
  /** Remove an entry */
  remove(path: string): boolean
  /** Update file content */
  updateContent?(path: string, content: string | Uint8Array): void
  /** Get all paths in storage */
  getAllPaths?(): string[]
  /** Normalize a path */
  normalizePath?(path: string): string
  /** Get file name from path */
  getFileName?(path: string): string
  /** Get parent path */
  getParentPath?(path: string): string
  /** Check if parent exists */
  parentExists?(path: string): boolean
}

// =============================================================================
// Path Utilities
// =============================================================================

/**
 * Normalize a filesystem path.
 */
function normalizePath(path: string): string {
  if (path === '' || path === '/') return '/'
  let p = path.replace(/\/+/g, '/')
  if (p.endsWith('/') && p !== '/') {
    p = p.slice(0, -1)
  }
  return p
}

/**
 * Join path segments.
 */
function joinPath(base: string, name: string): string {
  if (base === '/') return `/${name}`
  return `${base}/${name}`
}

/**
 * Get parent path.
 */
function getParentPath(path: string): string {
  const normalized = normalizePath(path)
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash <= 0) return '/'
  return normalized.substring(0, lastSlash)
}

// =============================================================================
// Fs Binding Implementation
// =============================================================================

/**
 * Create an fs binding implementation backed by a storage backend.
 *
 * @param storage - Storage backend to use for operations
 * @param permissions - Optional permission restrictions
 * @returns Fs binding object
 */
export function createFsBinding(
  storage: ExtendedFsStorage,
  permissions?: FsPermissions
): FsBinding {
  // Permission check helper
  const checkWritePermission = () => {
    if (permissions?.allowWrite === false) {
      throw new Error('EACCES: write permission denied')
    }
  }

  const checkDeletePermission = () => {
    if (permissions?.allowDelete === false) {
      throw new Error('EACCES: delete permission denied')
    }
  }

  const checkPathAllowed = (path: string) => {
    if (permissions?.allowedPaths && permissions.allowedPaths.length > 0) {
      const normalizedPath = normalizePath(path)
      const allowed = permissions.allowedPaths.some(allowedPath => {
        const normalizedAllowed = normalizePath(allowedPath)
        return normalizedPath.startsWith(normalizedAllowed) ||
               normalizedPath === normalizedAllowed
      })
      if (!allowed) {
        throw new Error(`EACCES: path not allowed: ${path}`)
      }
    }
  }

  return {
    async read(path: string): Promise<string> {
      checkPathAllowed(path)
      const normalizedPath = normalizePath(path)

      if (!storage.has(normalizedPath)) {
        throw new Error(`ENOENT: no such file: ${path}`)
      }

      const entry = storage.get(normalizedPath)
      if (!entry) {
        throw new Error(`ENOENT: no such file: ${path}`)
      }

      if (entry.type === 'directory') {
        throw new Error(`EISDIR: is a directory: ${path}`)
      }

      return new TextDecoder().decode(entry.content)
    },

    async write(path: string, content: string): Promise<void> {
      checkWritePermission()
      checkPathAllowed(path)

      const parentPath = getParentPath(path)
      if (parentPath !== '/' && !storage.has(parentPath)) {
        throw new Error(`ENOENT: parent directory does not exist`)
      }

      storage.addFile(path, content)
    },

    async append(path: string, content: string): Promise<void> {
      checkWritePermission()
      checkPathAllowed(path)

      const normalizedPath = normalizePath(path)
      const entry = storage.get(normalizedPath)

      if (entry) {
        const existingContent = new TextDecoder().decode(entry.content)
        const newContent = existingContent + content

        if (storage.updateContent) {
          storage.updateContent(normalizedPath, newContent)
        } else {
          storage.addFile(normalizedPath, newContent)
        }
      } else {
        storage.addFile(path, content)
      }
    },

    async delete(path: string): Promise<void> {
      checkDeletePermission()
      checkPathAllowed(path)

      const normalizedPath = normalizePath(path)

      if (!storage.has(normalizedPath)) {
        throw new Error(`ENOENT: no such file or directory: ${path}`)
      }

      const entry = storage.get(normalizedPath)
      if (entry?.type === 'directory') {
        const children = storage.getChildren(normalizedPath)
        if (children.length > 0) {
          // Recursive delete
          if (storage.getAllPaths) {
            const allPaths = storage.getAllPaths()
            const toRemove = allPaths.filter((p) => p.startsWith(normalizedPath + '/') || p === normalizedPath)
            toRemove.sort((a, b) => b.length - a.length)
            for (const p of toRemove) {
              storage.remove(p)
            }
          } else {
            throw new Error(`ENOTEMPTY: directory not empty: ${path}`)
          }
        } else {
          storage.remove(normalizedPath)
        }
      } else {
        storage.remove(normalizedPath)
      }
    },

    async move(from: string, to: string): Promise<void> {
      checkWritePermission()
      checkPathAllowed(from)
      checkPathAllowed(to)

      const normalizedFrom = normalizePath(from)

      if (!storage.has(normalizedFrom)) {
        throw new Error(`ENOENT: no such file or directory: ${from}`)
      }

      const entry = storage.get(normalizedFrom)
      if (!entry) {
        throw new Error(`ENOENT: no such file or directory: ${from}`)
      }

      if (entry.type === 'file') {
        storage.addFile(to, entry.content)
      } else if (entry.type === 'directory') {
        storage.addDirectory(to)
      }

      storage.remove(normalizedFrom)
    },

    async copy(from: string, to: string): Promise<void> {
      checkWritePermission()
      checkPathAllowed(from)
      checkPathAllowed(to)

      const normalizedFrom = normalizePath(from)

      if (!storage.has(normalizedFrom)) {
        throw new Error(`ENOENT: no such file: ${from}`)
      }

      const entry = storage.get(normalizedFrom)
      if (!entry) {
        throw new Error(`ENOENT: no such file: ${from}`)
      }

      if (entry.type === 'directory') {
        throw new Error(`EISDIR: cannot copy directory: ${from}`)
      }

      storage.addFile(to, entry.content)
    },

    async mkdir(path: string, options?: FsMkdirOptions): Promise<void> {
      checkWritePermission()
      checkPathAllowed(path)

      const normalizedPath = normalizePath(path)
      const recursive = options?.recursive ?? false
      const mode = options?.mode ?? 0o755

      if (storage.has(normalizedPath)) {
        const entry = storage.get(normalizedPath)
        if (entry?.type === 'directory') {
          return // Directory already exists
        }
        throw new Error(`EEXIST: path already exists: ${path}`)
      }

      if (recursive) {
        // Create all parent directories
        const segments = normalizedPath.split('/').filter((s) => s !== '')
        let currentPath = ''
        for (const segment of segments) {
          currentPath += '/' + segment
          if (!storage.has(currentPath)) {
            storage.addDirectory(currentPath, { mode })
          }
        }
      } else {
        const parentPath = getParentPath(normalizedPath)
        if (parentPath !== '/' && !storage.has(parentPath)) {
          throw new Error(`ENOENT: parent directory does not exist`)
        }
        storage.addDirectory(normalizedPath, { mode })
      }
    },

    async stat(path: string): Promise<FsStatResult> {
      checkPathAllowed(path)

      const normalizedPath = normalizePath(path)

      if (!storage.has(normalizedPath)) {
        throw new Error(`ENOENT: no such file or directory: ${path}`)
      }

      const entry = storage.get(normalizedPath)
      if (!entry) {
        throw new Error(`ENOENT: no such file or directory: ${path}`)
      }

      // Cast entry to access optional mode property
      const entryWithMode = entry as typeof entry & { mode?: number }

      return {
        size: entry.content.length,
        isFile: entry.type === 'file',
        isDirectory: entry.type === 'directory',
        isSymbolicLink: entry.type === 'symlink',
        mtime: entry.mtime ?? Date.now(),
        birthtime: entry.birthtime ?? Date.now(),
        mode: entryWithMode.mode ?? (entry.type === 'directory' ? 0o755 : 0o644),
      }
    },

    async list(path: string, options?: FsListOptions): Promise<string[] | FsListEntry[]> {
      checkPathAllowed(path)

      const normalizedPath = normalizePath(path)

      if (!storage.has(normalizedPath)) {
        throw new Error(`ENOENT: no such directory: ${path}`)
      }

      if (!storage.isDirectory(normalizedPath)) {
        throw new Error(`ENOTDIR: not a directory: ${path}`)
      }

      const children = storage.getChildren(normalizedPath)
      const showHidden = options?.showHidden ?? false
      const withDetails = options?.withDetails ?? false

      let filteredChildren = children
      if (!showHidden) {
        filteredChildren = children.filter(name => !name.startsWith('.'))
      }

      if (withDetails) {
        return filteredChildren.map(name => {
          const childPath = joinPath(normalizedPath, name)
          const entry = storage.get(childPath)
          return {
            name,
            type: entry?.type ?? 'file',
            size: entry?.content.length ?? 0,
          } as FsListEntry
        })
      }

      return filteredChildren
    },

    async tree(path: string, options?: FsTreeOptions): Promise<string> {
      checkPathAllowed(path)

      const normalizedPath = normalizePath(path)

      if (!storage.has(normalizedPath)) {
        throw new Error(`ENOENT: no such directory: ${path}`)
      }

      if (!storage.isDirectory(normalizedPath)) {
        throw new Error(`ENOTDIR: not a directory: ${path}`)
      }

      const maxDepth = options?.maxDepth ?? Infinity
      const showHidden = options?.showHidden ?? false
      const showSize = options?.showSize ?? false

      // Build tree string
      const lines: string[] = []
      const dirName = storage.getFileName?.(normalizedPath) ?? normalizedPath.split('/').pop() ?? normalizedPath

      lines.push(dirName)
      buildTreeLines(storage, normalizedPath, '', 0, maxDepth, showHidden, showSize, lines)

      return lines.join('\n')
    },

    async search(pattern: string, options?: FsSearchOptions): Promise<string[]> {
      // Simple glob search implementation
      const results: string[] = []
      const allPaths = storage.getAllPaths?.() ?? []

      for (const entryPath of allPaths) {
        if (matchGlobPattern(pattern, entryPath, options)) {
          results.push(entryPath)
          if (options?.limit && results.length >= options.limit) {
            break
          }
        }
      }

      return results
    },

    async exists(path: string): Promise<boolean> {
      checkPathAllowed(path)
      return storage.has(normalizePath(path))
    },
  }
}

// =============================================================================
// Tree Building Helper
// =============================================================================

const TREE_BRANCH = '├── '
const TREE_LAST = '└── '
const TREE_VERTICAL = '│   '
const TREE_SPACE = '    '

function buildTreeLines(
  storage: ExtendedFsStorage,
  dirPath: string,
  prefix: string,
  currentDepth: number,
  maxDepth: number,
  showHidden: boolean,
  showSize: boolean,
  lines: string[]
): void {
  if (currentDepth >= maxDepth) return

  const children = storage.getChildren(dirPath)
  let filteredChildren = children

  if (!showHidden) {
    filteredChildren = children.filter(name => !name.startsWith('.'))
  }

  filteredChildren.sort()

  for (let i = 0; i < filteredChildren.length; i++) {
    const name = filteredChildren[i]
    const isLast = i === filteredChildren.length - 1
    const connector = isLast ? TREE_LAST : TREE_BRANCH
    const childPrefix = prefix + (isLast ? TREE_SPACE : TREE_VERTICAL)

    const childPath = joinPath(dirPath, name)
    const entry = storage.get(childPath)

    let line = prefix + connector + name
    if (showSize && entry?.type === 'file') {
      line += ` (${entry.content.length}B)`
    }
    lines.push(line)

    if (entry?.type === 'directory') {
      buildTreeLines(storage, childPath, childPrefix, currentDepth + 1, maxDepth, showHidden, showSize, lines)
    }
  }
}

// =============================================================================
// Glob Pattern Matching Helper
// =============================================================================

function matchGlobPattern(
  pattern: string,
  path: string,
  _options?: FsSearchOptions
): boolean {
  // Simple glob matching: convert * to regex
  const regexPattern = pattern
    .replace(/\*\*/g, '<<GLOBSTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<GLOBSTAR>>/g, '.*')
    .replace(/\?/g, '.')

  const regex = new RegExp(`^${regexPattern}$`)

  // Get the path relative to search options
  const relativePath = path.startsWith('/') ? path.slice(1) : path

  return regex.test(relativePath) || regex.test(path)
}

// =============================================================================
// Scope Creation
// =============================================================================

/**
 * TypeScript type definitions for the fs binding.
 *
 * This is provided to the LLM so it can generate correctly typed code.
 */
export const FS_BINDING_TYPES = `
interface FsStatResult {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mtime: number;
  birthtime: number;
  mode: number;
}

interface FsListEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size?: number;
}

interface FsListOptions {
  showHidden?: boolean;
  withDetails?: boolean;
}

interface FsTreeOptions {
  maxDepth?: number;
  showHidden?: boolean;
  showSize?: boolean;
}

interface FsSearchOptions {
  contentSearch?: string;
  caseSensitive?: boolean;
  maxDepth?: number;
  exclude?: string[];
  showHidden?: boolean;
  limit?: number;
}

interface FsMkdirOptions {
  recursive?: boolean;
  mode?: number;
}

declare const fs: {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  append(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  mkdir(path: string, options?: FsMkdirOptions): Promise<void>;
  stat(path: string): Promise<FsStatResult>;
  list(path: string, options?: FsListOptions): Promise<string[] | FsListEntry[]>;
  tree(path: string, options?: FsTreeOptions): Promise<string>;
  search(pattern: string, options?: FsSearchOptions): Promise<string[]>;
  exists(path: string): Promise<boolean>;
};
`

/**
 * Create a DoScope with fs bindings for filesystem operations.
 *
 * @param storage - Storage backend for filesystem operations
 * @param permissions - Optional permission restrictions
 * @param additionalBindings - Additional bindings to include in the scope
 * @returns FsDoScope with fs binding
 *
 * @example
 * ```typescript
 * const scope = createFsScope(storage)
 *
 * // Use with do tool
 * const result = await doHandler({
 *   code: `
 *     const content = await fs.read('/home/user/file.txt')
 *     await fs.write('/home/user/copy.txt', content)
 *   `
 * })
 * ```
 */
export function createFsScope(
  storage: ExtendedFsStorage,
  permissions?: FsPermissions,
  additionalBindings?: Record<string, unknown>
): FsDoScope {
  const fsBinding = createFsBinding(storage, permissions)

  return {
    bindings: {
      fs: fsBinding,
      ...additionalBindings,
    },
    types: FS_BINDING_TYPES,
    timeout: 30000, // 30 second default timeout
    permissions,
  }
}

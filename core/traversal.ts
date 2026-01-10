/**
 * File system traversal utilities for fsx
 *
 * Provides shared traversal logic used by glob, grep, and find utilities.
 * Includes support for:
 * - Timeout options for long-running operations
 * - AbortController cancellation
 * - Improved error handling with descriptive messages
 * - Progress callbacks for large traversals
 *
 * @module traversal
 */

import type { FsBackend } from './backend'

// =============================================================================
// Types
// =============================================================================

/**
 * File entry type for traversal results
 */
export type TraversalEntryType = 'file' | 'directory' | 'symlink'

/**
 * A traversed file system entry with metadata
 */
export interface TraversalEntry {
  /** Full absolute path to the entry */
  path: string
  /** Type of the entry */
  type: TraversalEntryType
  /** Name of the file/directory (basename) */
  name: string
  /** Depth relative to the starting path (0 = starting path itself) */
  depth: number
  /** File size in bytes (0 for directories) */
  size?: number
  /** Last modification time in milliseconds */
  mtimeMs?: number
  /** Creation time in milliseconds */
  ctimeMs?: number
  /** Last access time in milliseconds */
  atimeMs?: number
}

/**
 * Error thrown when a traversal operation times out
 */
export class TraversalTimeoutError extends Error {
  /** Path where the timeout occurred */
  path: string
  /** Timeout duration in milliseconds */
  timeout: number

  constructor(path: string, timeout: number) {
    super(`Traversal operation timed out after ${timeout}ms at path: ${path}`)
    this.name = 'TraversalTimeoutError'
    this.path = path
    this.timeout = timeout
  }
}

/**
 * Error thrown when a traversal operation is aborted
 */
export class TraversalAbortedError extends Error {
  /** Path where the abort was detected */
  path: string

  constructor(path: string) {
    super(`Traversal operation was aborted at path: ${path}`)
    this.name = 'TraversalAbortedError'
    this.path = path
  }
}

/**
 * Error thrown for invalid paths or filesystem errors during traversal
 */
export class TraversalError extends Error {
  /** The path that caused the error */
  path: string
  /** The underlying error code (e.g., 'ENOENT', 'EACCES') */
  code?: string
  /** The original error that caused this error */
  cause?: Error

  constructor(message: string, path: string, code?: string, cause?: Error) {
    super(message)
    this.name = 'TraversalError'
    this.path = path
    this.code = code
    this.cause = cause
  }
}

/**
 * Options for traversal operations
 */
export interface TraversalOptions {
  /** Starting path for traversal (default: '/') */
  startPath?: string

  /** Maximum depth to traverse (undefined = unlimited, 0 = only starting path) */
  maxDepth?: number

  /** Minimum depth before collecting entries (default: 0) */
  minDepth?: number

  /** Include dotfiles/dotdirs in traversal (default: false) */
  includeDotFiles?: boolean

  /** Follow symbolic links (default: true) */
  followSymlinks?: boolean

  /** Directory patterns to skip during traversal */
  prunePatterns?: string[]

  /**
   * Timeout in milliseconds for the entire traversal operation.
   * Set to 0 or undefined for no timeout.
   */
  timeout?: number

  /**
   * AbortSignal for cancelling the traversal.
   * When aborted, throws TraversalAbortedError.
   */
  signal?: AbortSignal

  /**
   * Callback invoked for each entry before it's added to results.
   * Return false to skip the entry, true to include it.
   * Can be used for filtering or progress reporting.
   */
  filter?: (entry: TraversalEntry) => boolean | Promise<boolean>

  /**
   * Callback invoked periodically during traversal for progress updates.
   * @param current - Number of entries processed so far
   * @param currentPath - Path currently being processed
   */
  onProgress?: (current: number, currentPath: string) => void

  /**
   * Whether to collect file stats (size, mtime, etc.) during traversal.
   * Enabling this adds overhead but provides more metadata.
   * Default: false
   */
  collectStats?: boolean

  /**
   * FsBackend to use for filesystem operations.
   * Required for real filesystem traversal.
   */
  backend: FsBackend
}

/**
 * Result of a traversal operation
 */
export interface TraversalResult {
  /** All collected entries */
  entries: TraversalEntry[]
  /** Total number of entries visited (including filtered) */
  visited: number
  /** Whether the traversal completed fully */
  complete: boolean
  /** Error that caused incomplete traversal, if any */
  error?: Error
  /** Duration of traversal in milliseconds */
  durationMs: number
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Normalize a path by removing trailing slashes and collapsing duplicates.
 *
 * @param path - Path to normalize
 * @returns Normalized path
 *
 * @example
 * ```typescript
 * normalizePath('/foo//bar/') // '/foo/bar'
 * normalizePath('/') // '/'
 * normalizePath('') // '/'
 * ```
 */
export function normalizePath(path: string): string {
  if (path === '' || path === '/') return '/'
  let p = path.replace(/\/+/g, '/')
  if (p.endsWith('/') && p !== '/') {
    p = p.slice(0, -1)
  }
  return p
}

/**
 * Join two path segments.
 *
 * @param base - Base path
 * @param segment - Segment to append
 * @returns Joined path
 *
 * @example
 * ```typescript
 * joinPath('/', 'foo') // '/foo'
 * joinPath('/bar', 'baz') // '/bar/baz'
 * ```
 */
export function joinPath(base: string, segment: string): string {
  if (base === '/') return '/' + segment
  return base + '/' + segment
}

/**
 * Get the basename (final component) of a path.
 *
 * @param path - Path to get basename of
 * @returns Basename
 *
 * @example
 * ```typescript
 * getBasename('/foo/bar/baz.txt') // 'baz.txt'
 * getBasename('/foo') // 'foo'
 * getBasename('/') // ''
 * ```
 */
export function getBasename(path: string): string {
  if (path === '/') return ''
  const lastSlash = path.lastIndexOf('/')
  return lastSlash >= 0 ? path.slice(lastSlash + 1) : path
}

/**
 * Get the parent directory of a path.
 *
 * @param path - Path to get parent of
 * @returns Parent path
 *
 * @example
 * ```typescript
 * getParentPath('/foo/bar') // '/foo'
 * getParentPath('/foo') // '/'
 * getParentPath('/') // '/'
 * ```
 */
export function getParentPath(path: string): string {
  if (path === '/') return '/'
  const lastSlash = path.lastIndexOf('/')
  if (lastSlash <= 0) return '/'
  return path.slice(0, lastSlash)
}

/**
 * Get the relative path from a base to a target.
 *
 * @param basePath - Base path
 * @param targetPath - Target path
 * @returns Relative path from base to target
 *
 * @example
 * ```typescript
 * getRelativePath('/', '/foo/bar') // 'foo/bar'
 * getRelativePath('/foo', '/foo/bar/baz') // 'bar/baz'
 * ```
 */
export function getRelativePath(basePath: string, targetPath: string): string {
  const normalizedBase = normalizePath(basePath)
  const normalizedTarget = normalizePath(targetPath)

  if (normalizedBase === '/') {
    return normalizedTarget.slice(1)
  }

  if (normalizedTarget === normalizedBase) {
    return ''
  }

  if (normalizedTarget.startsWith(normalizedBase + '/')) {
    return normalizedTarget.slice(normalizedBase.length + 1)
  }

  return normalizedTarget
}

/**
 * Calculate the depth of a path relative to a base path.
 *
 * @param path - Path to calculate depth of
 * @param basePath - Base path
 * @returns Depth (0 = same as base, 1 = direct child, etc.)
 *
 * @example
 * ```typescript
 * getDepth('/foo/bar', '/') // 2
 * getDepth('/foo/bar', '/foo') // 1
 * getDepth('/foo', '/foo') // 0
 * ```
 */
export function getDepth(path: string, basePath: string): number {
  const relativePath = getRelativePath(basePath, path)
  if (relativePath === '') return 0
  return relativePath.split('/').length
}

/**
 * Check if a name is a dotfile/dotdir (starts with .)
 *
 * @param name - Name to check
 * @returns True if name starts with .
 */
export function isDotEntry(name: string): boolean {
  return name.startsWith('.')
}

// =============================================================================
// Main Traversal Function
// =============================================================================

/**
 * Traverse a filesystem tree and collect entries.
 *
 * This function provides a flexible, cancellable, and timeout-aware
 * way to traverse filesystem trees. It supports:
 * - Depth limiting
 * - Dotfile filtering
 * - Directory pruning
 * - Timeout handling
 * - Abort signal cancellation
 * - Progress callbacks
 * - Optional stat collection
 *
 * @param options - Traversal options
 * @returns Traversal result with collected entries
 * @throws {TraversalTimeoutError} If timeout is exceeded
 * @throws {TraversalAbortedError} If abort signal is triggered
 * @throws {TraversalError} For filesystem errors
 *
 * @example
 * ```typescript
 * const result = await traverse({
 *   startPath: '/src',
 *   backend: myBackend,
 *   maxDepth: 3,
 *   timeout: 5000,
 *   filter: (entry) => entry.type === 'file' && entry.name.endsWith('.ts'),
 * })
 *
 * for (const entry of result.entries) {
 *   console.log(entry.path)
 * }
 * ```
 */
export async function traverse(options: TraversalOptions): Promise<TraversalResult> {
  const startTime = Date.now()
  const {
    startPath = '/',
    maxDepth,
    minDepth = 0,
    includeDotFiles = false,
    followSymlinks = true,
    prunePatterns = [],
    timeout,
    signal,
    filter,
    onProgress,
    collectStats = false,
    backend,
  } = options

  const normalizedStart = normalizePath(startPath)
  const entries: TraversalEntry[] = []
  const visited = new Set<string>()
  let visitedCount = 0
  let complete = true
  let error: Error | undefined

  // Helper to check for timeout
  const checkTimeout = (currentPath: string): void => {
    if (timeout && timeout > 0) {
      const elapsed = Date.now() - startTime
      if (elapsed > timeout) {
        throw new TraversalTimeoutError(currentPath, timeout)
      }
    }
  }

  // Helper to check for abort
  const checkAbort = (currentPath: string): void => {
    if (signal?.aborted) {
      throw new TraversalAbortedError(currentPath)
    }
  }

  // Helper to check if a name matches any prune pattern
  const shouldPrune = (name: string): boolean => {
    for (const pattern of prunePatterns) {
      // Simple pattern matching - exact match or glob-style *
      if (pattern === name) return true
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
        if (regex.test(name)) return true
      }
    }
    return false
  }

  // Recursive traversal function
  async function traverseDir(currentPath: string, currentDepth: number): Promise<void> {
    // Check for timeout/abort
    checkTimeout(currentPath)
    checkAbort(currentPath)

    // Prevent infinite loops with symlinks
    if (visited.has(currentPath)) {
      return
    }
    visited.add(currentPath)

    // Check depth limits for continuing traversal
    if (maxDepth !== undefined && currentDepth > maxDepth) {
      return
    }

    // Get directory entries
    let dirEntries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink?(): boolean }>
    try {
      dirEntries = await backend.readdir(currentPath, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink?(): boolean }>
    } catch (err) {
      const e = err as Error & { code?: string }
      // Handle permission denied gracefully - skip the directory
      if (e.code === 'EACCES' || e.message?.includes('EACCES')) {
        return
      }
      // For other errors, wrap and propagate
      throw new TraversalError(
        `Failed to read directory: ${currentPath}`,
        currentPath,
        e.code,
        e
      )
    }

    for (const dirEntry of dirEntries) {
      const entryName = dirEntry.name
      const entryPath = joinPath(currentPath, entryName)

      // Check for timeout/abort periodically
      checkTimeout(entryPath)
      checkAbort(entryPath)

      visitedCount++

      // Report progress
      if (onProgress && visitedCount % 100 === 0) {
        onProgress(visitedCount, entryPath)
      }

      // Skip dotfiles if not included
      if (!includeDotFiles && isDotEntry(entryName)) {
        continue
      }

      // Check prune patterns
      if (shouldPrune(entryName)) {
        continue
      }

      // Determine entry type
      let entryType: TraversalEntryType
      let isDir = false
      try {
        if (dirEntry.isSymbolicLink?.()) {
          if (!followSymlinks) {
            entryType = 'symlink'
          } else {
            // Follow symlink to determine actual type
            const stats = await backend.stat(entryPath)
            isDir = stats.isDirectory()
            entryType = isDir ? 'directory' : 'file'
          }
        } else {
          isDir = dirEntry.isDirectory()
          entryType = isDir ? 'directory' : 'file'
        }
      } catch {
        // If stat fails (e.g., broken symlink), treat as file
        entryType = 'file'
        isDir = false
      }

      // Build entry
      const entry: TraversalEntry = {
        path: entryPath,
        type: entryType,
        name: entryName,
        depth: currentDepth,
      }

      // Collect stats if requested
      if (collectStats) {
        try {
          const stats = await backend.stat(entryPath)
          entry.size = stats.size
          entry.mtimeMs = stats.mtimeMs
          entry.ctimeMs = stats.ctimeMs
          entry.atimeMs = stats.atimeMs
        } catch {
          // Stats collection is optional, continue without
        }
      }

      // Check depth before adding
      if (currentDepth >= minDepth) {
        // Apply filter if provided
        let include = true
        if (filter) {
          try {
            include = await filter(entry)
          } catch {
            include = false
          }
        }

        if (include) {
          entries.push(entry)
        }
      }

      // Recurse into directories
      if (isDir) {
        await traverseDir(entryPath, currentDepth + 1)
      }
    }
  }

  try {
    // Verify starting path exists
    const exists = await backend.exists(normalizedStart)
    if (!exists) {
      throw new TraversalError(
        `Starting path does not exist: ${normalizedStart}`,
        normalizedStart,
        'ENOENT'
      )
    }

    // Check if starting path is a directory
    const startStats = await backend.stat(normalizedStart)
    if (!startStats.isDirectory()) {
      // If it's a file, just return it as the only entry
      const entry: TraversalEntry = {
        path: normalizedStart,
        type: startStats.isSymbolicLink?.() ? 'symlink' : 'file',
        name: getBasename(normalizedStart),
        depth: 0,
      }

      if (collectStats) {
        entry.size = startStats.size
        entry.mtimeMs = startStats.mtimeMs
        entry.ctimeMs = startStats.ctimeMs
        entry.atimeMs = startStats.atimeMs
      }

      let include = true
      if (filter) {
        include = await filter(entry)
      }

      if (include && minDepth === 0) {
        entries.push(entry)
      }

      return {
        entries,
        visited: 1,
        complete: true,
        durationMs: Date.now() - startTime,
      }
    }

    // Start recursive traversal from the starting directory
    await traverseDir(normalizedStart, 0)
  } catch (err) {
    if (err instanceof TraversalTimeoutError || err instanceof TraversalAbortedError) {
      complete = false
      error = err
    } else if (err instanceof TraversalError) {
      complete = false
      error = err
    } else {
      const e = err as Error
      complete = false
      error = new TraversalError(e.message, normalizedStart, undefined, e)
    }
  }

  return {
    entries,
    visited: visitedCount,
    complete,
    error,
    durationMs: Date.now() - startTime,
  }
}

/**
 * Create a cancellable traversal that can be aborted.
 *
 * Returns an object with the traversal promise and an abort function.
 * Calling abort() will cause the traversal to stop and return partial results.
 *
 * @param options - Traversal options (signal option will be overridden)
 * @returns Object with promise and abort function
 *
 * @example
 * ```typescript
 * const { promise, abort } = createCancellableTraversal({
 *   startPath: '/large-dir',
 *   backend: myBackend,
 * })
 *
 * // Abort after 2 seconds
 * setTimeout(abort, 2000)
 *
 * const result = await promise
 * if (!result.complete) {
 *   console.log('Traversal was aborted')
 * }
 * ```
 */
export function createCancellableTraversal(
  options: Omit<TraversalOptions, 'signal'>
): { promise: Promise<TraversalResult>; abort: () => void } {
  const controller = new AbortController()

  const promise = traverse({
    ...options,
    signal: controller.signal,
  })

  return {
    promise,
    abort: () => controller.abort(),
  }
}

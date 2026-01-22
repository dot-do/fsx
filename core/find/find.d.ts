/**
 * Advanced file discovery for fsx
 *
 * Provides Unix find-like functionality for searching files in the virtual filesystem.
 * Supports filtering by name patterns, file type, size, timestamps, and more.
 * Includes timeout and cancellation support for long-running searches.
 *
 * ## Performance Optimizations
 *
 * This implementation is optimized for performance through:
 *
 * 1. **Predicate ordering** - Cheap predicates (type, name) are evaluated before expensive ones (size, time)
 * 2. **Early termination** - Walking stops immediately when maxdepth is reached
 * 3. **Directory pruning** - Pruned directories are skipped entirely without traversal
 * 4. **Lazy stat** - Stats are only fetched when size/time predicates require them
 * 5. **Memory efficiency** - Results are collected incrementally, visited set prevents cycles
 *
 * @module find
 */
import type { FsBackend } from '../backend';
/**
 * Error thrown when a find operation times out.
 *
 * @example
 * ```typescript
 * try {
 *   await find({ path: '/large-dir', timeout: 1000 })
 * } catch (err) {
 *   if (err instanceof FindTimeoutError) {
 *     console.log(`Search timed out after ${err.timeout}ms`)
 *   }
 * }
 * ```
 */
export declare class FindTimeoutError extends Error {
    /** Starting path that was being searched */
    readonly path: string;
    /** Timeout duration in milliseconds */
    readonly timeout: number;
    constructor(path: string, timeout: number);
}
/**
 * Error thrown when a find operation is aborted via AbortSignal.
 *
 * @example
 * ```typescript
 * const controller = new AbortController()
 * setTimeout(() => controller.abort(), 1000)
 *
 * try {
 *   await find({ path: '/', signal: controller.signal })
 * } catch (err) {
 *   if (err instanceof FindAbortedError) {
 *     console.log('Search was cancelled')
 *   }
 * }
 * ```
 */
export declare class FindAbortedError extends Error {
    /** Starting path that was being searched */
    readonly path: string;
    constructor(path: string);
}
/**
 * Options for the find() function.
 *
 * All options are optional. When multiple filters are specified, they are combined with AND logic.
 * Predicates are evaluated in order of cost: type and name (cheap) before size and time (expensive).
 *
 * @example
 * ```typescript
 * // Find TypeScript files in src, excluding node_modules
 * const options: FindOptions = {
 *   path: '/src',
 *   name: '*.ts',
 *   type: 'f',
 *   prune: ['node_modules'],
 *   timeout: 5000,
 * }
 *
 * // Find large files modified recently
 * const largeRecent: FindOptions = {
 *   size: '+1M',
 *   mtime: '-7d',
 *   type: 'f',
 * }
 * ```
 */
export interface FindOptions {
    /**
     * Starting path for the search.
     * @default '/'
     */
    path?: string;
    /**
     * Filename pattern filter.
     * - String: glob pattern (e.g., '*.ts', 'README.*', '[A-Z]*.tsx')
     * - RegExp: regular expression for filename matching
     *
     * @example
     * ```typescript
     * { name: '*.ts' }           // glob pattern
     * { name: /\.test\.ts$/ }    // RegExp
     * { name: '*.{ts,tsx}' }     // brace expansion
     * ```
     */
    name?: string | RegExp;
    /**
     * File type filter.
     * - 'f': regular files only
     * - 'd': directories only
     * - 'l': symbolic links only
     */
    type?: 'f' | 'd' | 'l';
    /**
     * Maximum traversal depth from starting path.
     * - 0: only the starting path itself
     * - 1: starting path and direct children
     * - n: up to n levels deep
     * @default Infinity
     */
    maxdepth?: number;
    /**
     * Minimum depth before including results.
     * - 0: include starting path
     * - 1: exclude starting path, include children
     * - n: only include entries n or more levels deep
     * @default 0
     */
    mindepth?: number;
    /**
     * Size filter with optional operator prefix.
     * - '+1M': larger than 1 megabyte
     * - '-100K': smaller than 100 kilobytes
     * - '500B': exactly 500 bytes
     *
     * Supported suffixes: B (bytes), K (kilobytes), M (megabytes), G (gigabytes)
     */
    size?: string;
    /**
     * Modified time filter.
     * - '-7d': modified within the last 7 days
     * - '+30d': modified more than 30 days ago
     * - '7d': modified approximately 7 days ago
     *
     * Supported suffixes: m (minutes), h (hours), d (days), w (weeks), M (months)
     */
    mtime?: string;
    /**
     * Created/changed time filter (same format as mtime).
     */
    ctime?: string;
    /**
     * Access time filter (same format as mtime).
     */
    atime?: string;
    /**
     * Filter for empty files/directories.
     * - true: only empty files (size 0) or directories (no children)
     * - false: only non-empty entries
     * - undefined: no empty filtering
     */
    empty?: boolean;
    /**
     * Directory patterns to skip during traversal.
     * Pruned directories are not entered, improving performance.
     *
     * @example
     * ```typescript
     * { prune: ['node_modules', '.git', 'dist'] }
     * { prune: ['.*'] }  // skip all hidden directories
     * ```
     */
    prune?: string[];
    /**
     * Filesystem backend for operations.
     * When not provided, uses internal mock filesystem (for testing).
     */
    backend?: FsBackend;
    /**
     * Timeout in milliseconds for the entire find operation.
     * @throws {FindTimeoutError} When timeout is exceeded
     * @default undefined (no timeout)
     */
    timeout?: number;
    /**
     * AbortSignal for cancelling the find operation.
     * @throws {FindAbortedError} When signal is aborted
     */
    signal?: AbortSignal;
}
/**
 * Result entry from find().
 *
 * Each result contains essential metadata about the matched filesystem entry.
 * Results are sorted by path for stable, predictable ordering.
 *
 * @example
 * ```typescript
 * const results = await find({ name: '*.ts', type: 'f' })
 * for (const result of results) {
 *   console.log(`${result.path}: ${result.size} bytes, modified ${result.mtime}`)
 * }
 * ```
 */
export interface FindResult {
    /** Full absolute path to the file/directory */
    readonly path: string;
    /** Type of the filesystem entry */
    readonly type: 'file' | 'directory' | 'symlink';
    /** Size in bytes (0 for directories) */
    readonly size: number;
    /** Last modification time */
    readonly mtime: Date;
}
/**
 * Find files in the filesystem matching the given criteria.
 *
 * This function provides Unix find-like file discovery with support for:
 * - Name pattern matching (glob and regex)
 * - File type filtering (file, directory, symlink)
 * - Depth control (maxdepth, mindepth)
 * - Size filtering (larger than, smaller than, exact)
 * - Time filtering (mtime, ctime, atime)
 * - Empty file/directory detection
 * - Directory pruning for performance
 * - Timeout and cancellation support
 *
 * ## Performance Optimizations
 *
 * Predicates are evaluated in order of cost for optimal performance:
 * 1. **Cheap predicates first**: type, name (string operations only)
 * 2. **Expensive predicates last**: size, time (may require stat calls)
 *
 * Additional optimizations:
 * - Early termination when maxdepth is reached
 * - Directory pruning skips entire subtrees
 * - Visited set prevents infinite loops from symlinks
 *
 * @param options - Search criteria (all optional)
 * @returns Promise resolving to array of matching entries, sorted by path
 * @throws {FindTimeoutError} When timeout is exceeded
 * @throws {FindAbortedError} When AbortSignal is triggered
 *
 * @example
 * ```typescript
 * // Find all TypeScript files
 * const tsFiles = await find({ name: '*.ts' })
 *
 * // Find large files (> 1MB)
 * const largeFiles = await find({ size: '+1M' })
 *
 * // Find recently modified files (within 7 days)
 * const recent = await find({ mtime: '-7d' })
 *
 * // Find empty directories
 * const emptyDirs = await find({ type: 'd', empty: true })
 *
 * // Complex query: TypeScript files in src, excluding node_modules
 * const srcTs = await find({
 *   path: '/src',
 *   name: '*.ts',
 *   type: 'f',
 *   prune: ['node_modules', '.git']
 * })
 *
 * // With timeout and cancellation
 * const controller = new AbortController()
 * const results = await find({
 *   path: '/',
 *   name: '*.log',
 *   timeout: 5000,
 *   signal: controller.signal
 * })
 * ```
 */
export declare function find(options?: FindOptions): Promise<FindResult[]>;
//# sourceMappingURL=find.d.ts.map
/**
 * SparseFS - Filtered filesystem wrapper with sparse checkout semantics
 *
 * Wraps an FSx instance with include/exclude pattern filtering,
 * providing sparse-checkout like behavior for efficient partial tree operations.
 *
 * @module sparse/sparse-fs
 */
import type { FSx } from '../fsx.js';
import type { Stats, Dirent, ReaddirOptions, BufferEncoding } from '../types.js';
/**
 * Options for creating a SparseFS instance
 */
export interface SparseFSOptions {
    /** Glob patterns to include (files matching any pattern are included) */
    patterns: string[];
    /** Glob patterns to exclude (files matching any pattern are excluded) */
    excludePatterns?: string[];
    /** Enable cone mode (directory-based patterns only) - future feature */
    cone?: boolean;
    /** Root path to strip from paths before pattern matching (default: '') */
    root?: string;
    /**
     * Load .gitignore file(s) as additional exclude patterns.
     *
     * When true, loads .gitignore from the root directory.
     * When a string, loads from the specified path.
     * When false or undefined, no .gitignore is loaded.
     *
     * The patterns from .gitignore are appended to excludePatterns.
     */
    gitignore?: boolean | string;
    /**
     * Custom path to .gitignore file (deprecated: use gitignore option instead)
     * @deprecated Use gitignore option with string path instead
     */
    gitignorePath?: string;
}
/**
 * Result of loading a .gitignore file
 */
export interface GitignoreLoadResult {
    /** Patterns parsed from the .gitignore file */
    patterns: string[];
    /** Path to the loaded .gitignore file */
    path: string;
    /** Whether the file existed */
    exists: boolean;
}
/**
 * Options for fromPreset factory method
 */
export interface PresetOptions {
    /** Additional patterns to include */
    include?: string[];
    /** Patterns to exclude (converted to excludePatterns) */
    exclude?: string[];
    /** Root path for pattern matching */
    root?: string;
}
/**
 * Built-in preset names
 */
export type PresetName = 'typescript' | 'javascript' | 'source' | 'web' | 'config';
/**
 * Entry returned by the walk method
 */
export interface WalkEntry {
    /** Full path to the entry */
    path: string;
    /** Entry name (basename) */
    name: string;
    /** Entry type: 'file', 'directory', or 'symlink' */
    type: 'file' | 'directory' | 'symlink';
    /** Depth relative to walk root */
    depth: number;
}
/**
 * Options for walk method
 */
export interface WalkOptions {
    /** Maximum depth to traverse (undefined = unlimited) */
    maxDepth?: number;
    /** Include dotfiles/dotdirs (default: false) */
    includeDotFiles?: boolean;
}
/**
 * Entry type filter for readdir
 */
export type EntryTypeFilter = 'file' | 'directory' | 'symlink';
/**
 * Extended options for filtered readdir operations
 */
export interface FilteredReaddirOptions extends Omit<ReaddirOptions, 'recursive'> {
    /** Glob pattern to filter entry names (e.g., '*.ts', '*.{js,jsx}') */
    filter?: string;
    /** Filter by entry type */
    type?: EntryTypeFilter;
    /** Include hidden files (starting with .) - default: true */
    includeHidden?: boolean;
}
/**
 * SparseFS - Filtered filesystem wrapper
 *
 * Wraps an FSx instance and filters all operations based on include/exclude patterns.
 * Provides efficient partial tree operations by:
 * - Filtering readdir results
 * - Blocking access to excluded files
 * - Skipping excluded directories during traversal
 */
export declare class SparseFS {
    /**
     * Built-in pattern presets for common use cases
     */
    static presets: Record<string, string[]>;
    /**
     * Create a SparseFS instance from a preset
     *
     * @param fs - The FSx instance to wrap
     * @param preset - Name of the preset to use
     * @param options - Additional options to customize the preset
     * @returns A new SparseFS instance configured with the preset patterns
     * @throws Error if preset name is unknown
     */
    static fromPreset(fs: FSx, preset: PresetName | string, options?: PresetOptions): SparseFS;
    /**
     * Register a custom preset
     *
     * @param name - Name for the preset
     * @param patterns - Array of glob patterns
     * @throws Error if patterns array is empty or contains invalid patterns
     */
    static registerPreset(name: string, patterns: string[]): void;
    /**
     * Load patterns from a .gitignore file
     *
     * Parses a .gitignore file and returns the patterns found.
     * Handles gitignore format:
     * - Lines starting with # are comments
     * - Blank lines are ignored
     * - Patterns can include negation (!) prefix
     * - Patterns can include glob wildcards
     *
     * @param fs - The FSx instance to read from
     * @param path - Path to the .gitignore file
     * @returns GitignoreLoadResult with patterns and metadata
     *
     * @example
     * ```typescript
     * const result = await SparseFS.loadGitignore(fs, '/project/.gitignore')
     * if (result.exists) {
     *   console.log('Loaded patterns:', result.patterns)
     * }
     * ```
     */
    static loadGitignore(fs: FSx, path: string): Promise<GitignoreLoadResult>;
    /**
     * Parse gitignore content string into an array of patterns
     *
     * @param content - Raw gitignore file content
     * @returns Array of pattern strings (comments and blank lines removed)
     */
    static parseGitignoreContent(content: string): string[];
    /**
     * Create a SparseFS instance with gitignore patterns loaded
     *
     * This is an async factory method that loads .gitignore patterns
     * before creating the SparseFS instance.
     *
     * @param fs - The FSx instance to wrap
     * @param options - Sparse options including gitignore loading
     * @returns Promise resolving to a new SparseFS instance
     *
     * @example
     * ```typescript
     * // Load .gitignore from root
     * const sparse = await SparseFS.withGitignore(fs, {
     *   patterns: ['src/**'],
     *   gitignore: true
     * })
     *
     * // Load from custom path
     * const sparse = await SparseFS.withGitignore(fs, {
     *   patterns: ['src/**'],
     *   gitignore: '/project/.gitignore'
     * })
     * ```
     */
    static withGitignore(fs: FSx, options: SparseFSOptions): Promise<SparseFS>;
    /** The underlying FSx instance */
    readonly fs: FSx;
    /** Pattern checker for include/exclude logic */
    private readonly checker;
    /** Original options - kept for future use (cone mode, etc.) */
    private readonly options;
    /** Root path to strip from paths before pattern matching */
    private readonly root;
    /**
     * Create a new SparseFS wrapper
     *
     * @param fs - The FSx instance to wrap
     * @param options - Sparse checkout options
     * @throws Error if configuration is invalid
     */
    constructor(fs: FSx, options: SparseFSOptions);
    /**
     * Validate configuration options
     * @throws Error with helpful message if validation fails
     */
    private validateOptions;
    /**
     * Normalize the root path
     */
    private normalizeRoot;
    /**
     * Check if a path should be included based on patterns
     *
     * @param path - Path to check (relative or absolute)
     * @returns true if the path matches include patterns and doesn't match exclude patterns
     */
    shouldInclude(path: string): boolean;
    /**
     * Check if a directory should be traversed
     *
     * Used for optimization during walks - allows skipping directories
     * that cannot contain any matching files.
     *
     * @param dir - Directory path to check
     * @returns true if the directory could contain matching files
     */
    shouldTraverseDirectory(dir: string): boolean;
    /**
     * Read directory contents, filtered by patterns
     *
     * Performance optimization: Always uses `withFileTypes: true` internally
     * to get dirent type information without additional stat() calls. This
     * is critical for efficient filtering since we need to distinguish between
     * files and directories for pattern matching.
     *
     * When the caller doesn't request `withFileTypes`, we extract just the
     * names from the filtered dirent results. This approach avoids the O(n)
     * stat() calls that would otherwise be needed to determine entry types.
     *
     * Supports additional filtering via FilteredReaddirOptions:
     * - `filter`: Glob pattern to match entry names (e.g., '*.ts', '*.{js,jsx}')
     * - `type`: Filter by entry type ('file', 'directory', 'symlink')
     * - `includeHidden`: Whether to include dotfiles (default: true)
     *
     * @param path - Path to the directory
     * @param options - Read options with optional filtering
     * @returns Filtered array of filenames or Dirent objects
     */
    readdir(path: string, options?: FilteredReaddirOptions): Promise<string[] | Dirent[]>;
    /**
     * Create a glob matcher function for filtering entry names
     *
     * Supports:
     * - Simple wildcards: *.ts, Button*, *test*
     * - Brace expansion: *.{ts,tsx,js}
     * - Character classes: [a-z]*.ts
     * - Exact matches: index.ts
     *
     * @param pattern - Glob pattern to match
     * @returns A function that tests whether a name matches the pattern
     */
    private createGlobMatcher;
    /**
     * Check if a pattern contains glob wildcards
     */
    private hasGlobWildcards;
    /**
     * Convert a glob pattern to a regular expression
     *
     * This is a simplified version for matching entry names (not full paths),
     * so it doesn't need to handle ** globstar patterns.
     */
    private globToRegex;
    /**
     * Find the matching closing brace
     */
    private findMatchingBrace;
    /**
     * Parse brace expansion content like "ts,tsx,js"
     */
    private parseBraceExpansion;
    /**
     * Escape regex special characters
     */
    private escapeRegexChars;
    /**
     * Read a file's contents, if it matches patterns
     *
     * @param path - Path to the file
     * @param encoding - Output encoding
     * @returns File contents
     * @throws Error if the file doesn't match patterns
     */
    readFile(path: string, encoding?: BufferEncoding): Promise<string | Uint8Array>;
    /**
     * Get file or directory stats, if it matches patterns
     *
     * @param path - Path to check
     * @returns Stats object
     * @throws Error if the path doesn't match patterns
     */
    stat(path: string): Promise<Stats>;
    /**
     * Check if a path exists and matches patterns
     *
     * @param path - Path to check
     * @returns true if path exists AND matches patterns
     */
    exists(path: string): Promise<boolean>;
    /**
     * Walk the filesystem tree with pattern filtering
     *
     * Efficiently traverses directories, skipping excluded paths entirely.
     * Yields WalkEntry objects for each matching file and directory.
     *
     * @param root - Starting path for walk
     * @param options - Walk options
     * @yields WalkEntry for each matching path
     */
    walk(root: string, options?: WalkOptions): AsyncGenerator<WalkEntry, void, undefined>;
    /**
     * Internal recursive walk implementation
     */
    private walkDirectory;
    /**
     * Check if an entry (file or directory) should be included
     */
    private shouldIncludeEntry;
    /**
     * Normalize a path by removing root prefix and leading slash for pattern matching
     */
    private normalizePath;
    /**
     * Join path segments
     */
    private joinPath;
}
//# sourceMappingURL=sparse-fs.d.ts.map
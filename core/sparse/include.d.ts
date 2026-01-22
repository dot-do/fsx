/**
 * Include/Exclude pattern matching for sparse checkout support
 *
 * This module provides functionality to determine whether a file path
 * should be included based on include and exclude glob patterns.
 *
 * ## Performance Optimizations
 *
 * - **LRU Cache**: Path decisions are cached with configurable size (default 10,000 entries)
 * - **Directory Prefix Tree**: Pre-computed directory prefixes for O(1) early termination
 * - **Compiled Patterns**: Regex patterns are pre-compiled at checker creation time
 * - **Early Termination**: Excluded directories are detected before full pattern matching
 *
 * ## Benchmarks
 *
 * Target performance: <1ms for 10,000 path checks with <1MB cache overhead
 *
 * @module sparse/include
 */
/**
 * Options for creating an include checker
 */
export interface IncludeCheckerOptions {
    /** Glob patterns to include (files matching any pattern are included) */
    patterns: string[];
    /** Glob patterns to exclude (files matching any pattern are excluded, takes priority over include) */
    excludePatterns?: string[];
    /**
     * Enable cone mode (git sparse-checkout compatible)
     *
     * In cone mode:
     * - Only directory patterns are allowed (no glob wildcards)
     * - Toplevel files are always included
     * - All files under specified directories are included
     * - Immediate files of ancestor directories are included
     * - Sibling directories are excluded
     */
    cone?: boolean;
    /**
     * Maximum number of path decisions to cache
     *
     * Higher values improve performance for repeated checks but use more memory.
     * Each cached entry uses approximately 50-100 bytes.
     *
     * @default 10000
     */
    cacheSize?: number;
}
/**
 * Interface for checking whether paths should be included
 */
export interface IncludeChecker {
    /**
     * Check if a file path should be included
     *
     * Results are cached for repeated calls with the same path.
     *
     * @param path - The file path to check (relative, no leading slash)
     * @returns true if the path should be included, false otherwise
     */
    shouldInclude(path: string): boolean;
    /**
     * Check if a directory should be traversed (optimization for tree walking)
     *
     * This method enables early pruning of directory trees that cannot
     * contain any matching files. Results are cached.
     *
     * @param dir - The directory path to check (relative, no leading slash)
     * @returns true if the directory might contain matching files
     */
    shouldTraverseDirectory(dir: string): boolean;
}
/**
 * Create an include checker with the given patterns
 *
 * This factory creates an optimized checker with:
 * - LRU cache for path decisions
 * - Pre-compiled regex patterns
 * - Directory prefix index for early termination
 * - **Negation pattern support** - patterns starting with ! negate previous matches
 *
 * ## Negation Pattern Semantics (gitignore-style)
 *
 * Patterns are processed in order, with later patterns overriding earlier ones:
 * - `!pattern` negates a previous match
 * - In `excludePatterns`: `!` re-includes previously excluded files
 * - In `patterns`: `!` excludes previously included files
 * - `\!pattern` escapes the ! to match literal ! in filenames
 *
 * @param options - Include and exclude patterns with optional cache configuration
 * @returns An IncludeChecker instance with cached decision making
 *
 * @example
 * ```typescript
 * // Basic usage
 * const checker = createIncludeChecker({
 *   patterns: ["src/**", "package.json"],
 *   excludePatterns: ["node_modules/**", "*.test.ts"]
 * })
 *
 * checker.shouldInclude("src/index.ts")  // true (cached after first call)
 * checker.shouldInclude("node_modules/lodash/index.js")  // false
 * ```
 *
 * @example
 * // With negation patterns
 * const checker2 = createIncludeChecker({
 *   patterns: ["**"],
 *   excludePatterns: [
 *     "** /test/**",           // Exclude all test directories (space added for JSDoc)
 *     "!** /test/fixtures/**"  // But re-include fixtures
 *   ]
 * })
 *
 * checker2.shouldInclude("src/test/helper.ts")          // false (excluded)
 * checker2.shouldInclude("src/test/fixtures/data.json") // true (re-included)
 *
 * @example
 * ```typescript
 * // Negation in include patterns
 * const checker = createIncludeChecker({
 *   patterns: [
 *     "src/**",          // Include all of src
 *     "!src/internal/**" // But exclude internal
 *   ]
 * })
 *
 * checker.shouldInclude("src/index.ts")          // true
 * checker.shouldInclude("src/internal/secret.ts") // false
 * ```
 */
export declare function createIncludeChecker(options: IncludeCheckerOptions): IncludeChecker;
//# sourceMappingURL=include.d.ts.map
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

// =============================================================================
// LRU Cache Implementation
// =============================================================================

/**
 * Simple LRU (Least Recently Used) cache for path decisions
 *
 * Uses a Map for O(1) access and maintains insertion order for eviction.
 * When the cache reaches maxSize, the oldest entries are evicted.
 *
 * @typeParam T - The type of values stored in the cache
 */
class LRUCache<T> {
  /** Internal storage using Map's insertion order */
  private cache: Map<string, T>

  /** Maximum number of entries before eviction */
  private readonly maxSize: number

  /**
   * Create a new LRU cache
   *
   * @param maxSize - Maximum number of entries (default: 10000)
   */
  constructor(maxSize: number = 10000) {
    this.cache = new Map()
    this.maxSize = maxSize
  }

  /**
   * Get a value from the cache
   *
   * Accessing a value moves it to the "most recently used" position.
   *
   * @param key - The cache key
   * @returns The cached value or undefined if not found
   */
  get(key: string): T | undefined {
    const value = this.cache.get(key)
    if (value !== undefined) {
      // Move to end (most recently used) by re-inserting
      this.cache.delete(key)
      this.cache.set(key, value)
    }
    return value
  }

  /**
   * Set a value in the cache
   *
   * If the cache is at capacity, the least recently used entry is evicted.
   *
   * @param key - The cache key
   * @param value - The value to cache
   */
  set(key: string, value: T): void {
    // If key exists, delete it first to update position
    if (this.cache.has(key)) {
      this.cache.delete(key)
    }

    // Evict oldest entry if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey)
      }
    }

    this.cache.set(key, value)
  }

  /**
   * Check if a key exists in the cache
   *
   * @param key - The cache key
   * @returns true if the key exists
   */
  has(key: string): boolean {
    return this.cache.has(key)
  }

  /**
   * Get the current number of entries in the cache
   */
  get size(): number {
    return this.cache.size
  }

  /**
   * Clear all entries from the cache
   */
  clear(): void {
    this.cache.clear()
  }
}

// =============================================================================
// Types and Interfaces
// =============================================================================

/**
 * Options for creating an include checker
 */
export interface IncludeCheckerOptions {
  /** Glob patterns to include (files matching any pattern are included) */
  patterns: string[]

  /** Glob patterns to exclude (files matching any pattern are excluded, takes priority over include) */
  excludePatterns?: string[]

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
  cone?: boolean

  /**
   * Maximum number of path decisions to cache
   *
   * Higher values improve performance for repeated checks but use more memory.
   * Each cached entry uses approximately 50-100 bytes.
   *
   * @default 10000
   */
  cacheSize?: number
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
  shouldInclude(path: string): boolean

  /**
   * Check if a directory should be traversed (optimization for tree walking)
   *
   * This method enables early pruning of directory trees that cannot
   * contain any matching files. Results are cached.
   *
   * @param dir - The directory path to check (relative, no leading slash)
   * @returns true if the directory might contain matching files
   */
  shouldTraverseDirectory(dir: string): boolean
}

// =============================================================================
// Directory Prefix Index
// =============================================================================

/**
 * Pre-computed directory prefix index for fast early termination
 *
 * Maps directory names to their exclusion status, enabling O(1) lookups
 * for common cases like node_modules exclusion.
 */
interface DirectoryPrefixIndex {
  /** Set of directory names that are fully excluded (e.g., 'node_modules') */
  excludedDirs: Set<string>

  /** Set of static directory prefixes from include patterns */
  includePrefixes: Set<string>

  /** Patterns that have globstar at start (match anywhere) */
  hasGlobstarPatterns: boolean
}

/**
 * Build a directory prefix index from patterns for fast lookups
 *
 * @param includePatterns - Patterns to include
 * @param excludePatterns - Patterns to exclude
 * @returns Pre-computed index for fast directory checks
 */
function buildDirectoryPrefixIndex(includePatterns: string[], excludePatterns: string[]): DirectoryPrefixIndex {
  const excludedDirs = new Set<string>()
  const includePrefixes = new Set<string>()
  let hasGlobstarPatterns = false

  // Extract excluded directory names from patterns like **/node_modules/**
  for (const pattern of excludePatterns) {
    // Match patterns like **/dirname/** or dirname/**
    const match = pattern.match(/^\*\*\/([^/*]+)\/\*\*$/)
    if (match) {
      excludedDirs.add(match[1])
    }
    // Also handle dirname/** at root
    const rootMatch = pattern.match(/^([^/*]+)\/\*\*$/)
    if (rootMatch) {
      excludedDirs.add(rootMatch[1])
    }
  }

  // Extract static prefixes from include patterns
  for (const pattern of includePatterns) {
    if (pattern.startsWith('**')) {
      hasGlobstarPatterns = true
    }
    const prefix = extractDirectoryPrefix(pattern)
    if (prefix) {
      includePrefixes.add(prefix)
      // Also add all parent directories
      const parts = prefix.split('/')
      for (let i = 1; i < parts.length; i++) {
        includePrefixes.add(parts.slice(0, i).join('/'))
      }
    }
  }

  return { excludedDirs, includePrefixes, hasGlobstarPatterns }
}

/**
 * Check if a directory is excluded by the prefix index
 *
 * @param dir - Directory path to check
 * @param index - Pre-computed prefix index
 * @returns true if the directory is definitely excluded
 */
function isExcludedByPrefixIndex(dir: string, index: DirectoryPrefixIndex): boolean {
  const dirName = dir.split('/').pop() || dir
  return index.excludedDirs.has(dirName)
}

// =============================================================================
// Main Factory Function
// =============================================================================

/**
 * Create an include checker with the given patterns
 *
 * This factory creates an optimized checker with:
 * - LRU cache for path decisions
 * - Pre-compiled regex patterns
 * - Directory prefix index for early termination
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
 * ```typescript
 * // With custom cache size
 * const checker = createIncludeChecker({
 *   patterns: ["**"],
 *   excludePatterns: ["node_modules/**"],
 *   cacheSize: 50000  // Larger cache for big projects
 * })
 * ```
 */
export function createIncludeChecker(options: IncludeCheckerOptions): IncludeChecker {
  const { patterns, excludePatterns = [], cone = false, cacheSize = 10000 } = options

  // Use cone mode implementation if enabled
  if (cone) {
    return createConeIncludeChecker(patterns, excludePatterns, cacheSize)
  }

  // Pre-compile patterns for efficiency
  const includeMatchers = patterns.map((p) => createMatcher(p))
  const excludeMatchers = excludePatterns.map((p) => createMatcher(p))

  // Build directory prefix index for fast lookups
  const prefixIndex = buildDirectoryPrefixIndex(patterns, excludePatterns)

  // LRU caches for decisions
  const includeCache = new LRUCache<boolean>(cacheSize)
  const traverseCache = new LRUCache<boolean>(cacheSize)

  /**
   * Internal implementation of shouldInclude without caching
   * @internal
   */
  function computeShouldInclude(path: string): boolean {
    // Empty path is never included
    if (path === '') {
      return false
    }

    // If no include patterns, nothing is included
    if (patterns.length === 0) {
      return false
    }

    // Fast path: check if any directory component is in excluded dirs
    const pathParts = path.split('/')
    for (const part of pathParts) {
      if (prefixIndex.excludedDirs.has(part)) {
        return false
      }
    }

    // Check if path matches any include pattern
    const matchesInclude = includeMatchers.some((matcher) => matcher(path))
    if (!matchesInclude) {
      return false
    }

    // Check if path matches any exclude pattern (exclude takes priority)
    const matchesExclude = excludeMatchers.some((matcher) => matcher(path))
    if (matchesExclude) {
      return false
    }

    return true
  }

  /**
   * Internal implementation of shouldTraverseDirectory without caching
   * @internal
   */
  function computeShouldTraverse(dir: string): boolean {
    // If no include patterns, don't traverse anything
    if (patterns.length === 0) {
      return false
    }

    // Fast path: check prefix index for excluded directories
    if (isExcludedByPrefixIndex(dir, prefixIndex)) {
      return false
    }

    // Check if directory matches any exclude pattern fully
    // For patterns like **/node_modules/**, we should not traverse node_modules
    for (const matcher of excludeMatchers) {
      // Check if directory itself is excluded
      if (matcher(dir) || matcher(dir + '/')) {
        return false
      }
      // Check if any file inside would be excluded by directory-style exclusion
      if (matcher(dir + '/anything')) {
        // Only skip if the pattern is a full directory exclusion
        const patternIndex = excludeMatchers.indexOf(matcher)
        const originalPattern = excludePatterns[patternIndex]
        if (isDirectoryExclusionPattern(originalPattern, dir)) {
          return false
        }
      }
    }

    // Fast path: if we have globstar patterns, traverse most directories
    if (prefixIndex.hasGlobstarPatterns) {
      return true
    }

    // Check if the directory could potentially contain included files
    // A directory should be traversed if:
    // 1. The directory path is a prefix of an include pattern
    // 2. The include pattern could match files inside this directory

    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i]
      const matcher = includeMatchers[i]

      // If pattern contains ** at the start or matches the directory, traverse
      if (pattern.startsWith('**') || pattern === '**') {
        return true
      }

      // Check if the directory path could lead to matches
      if (couldContainMatches(dir, pattern)) {
        return true
      }

      // Check if the directory itself matches (for patterns like 'src/**')
      if (matcher(dir) || matcher(dir + '/')) {
        return true
      }
    }

    return false
  }

  return {
    shouldInclude(path: string): boolean {
      // Check cache first
      const cached = includeCache.get(path)
      if (cached !== undefined) {
        return cached
      }

      // Compute and cache result
      const result = computeShouldInclude(path)
      includeCache.set(path, result)
      return result
    },

    shouldTraverseDirectory(dir: string): boolean {
      // Check cache first
      const cached = traverseCache.get(dir)
      if (cached !== undefined) {
        return cached
      }

      // Compute and cache result
      const result = computeShouldTraverse(dir)
      traverseCache.set(dir, result)
      return result
    },
  }
}

/**
 * Check if a pattern is a directory exclusion pattern that fully excludes a directory
 */
function isDirectoryExclusionPattern(pattern: string, dir: string): boolean {
  // Patterns like **/node_modules/** exclude the entire node_modules directory
  // and any nested occurrence
  const dirName = dir.split('/').pop() || dir

  // Check for patterns like **/dirname/** or dirname/**
  if (pattern.includes(`**/${dirName}/**`) || pattern.includes(`${dirName}/**`)) {
    return true
  }

  // Direct match patterns like **/node_modules/**
  if (pattern === `**/${dirName}/**`) {
    return true
  }

  return false
}

/**
 * Check if a directory could contain files matching the pattern
 */
function couldContainMatches(dir: string, pattern: string): boolean {
  const dirParts = dir.split('/').filter(Boolean)
  const patternParts = pattern.split('/').filter(Boolean)

  // Handle globstar patterns
  if (patternParts[0] === '**') {
    return true
  }

  // Check if dir is a prefix of the pattern's directory structure
  for (let i = 0; i < dirParts.length && i < patternParts.length; i++) {
    const dirPart = dirParts[i]
    const patternPart = patternParts[i]

    if (patternPart === '**') {
      return true
    }

    if (!segmentMatches(dirPart, patternPart)) {
      return false
    }
  }

  // If we've matched all dir parts, there could be matches inside
  return dirParts.length <= patternParts.length || patternParts.some((p) => p === '**')
}

/**
 * Check if a directory segment matches a pattern segment
 */
function segmentMatches(segment: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '**') {
    return true
  }

  // Handle brace expansion like {ts,tsx}
  if (pattern.includes('{') && pattern.includes('}')) {
    const matcher = createMatcher(pattern)
    return matcher(segment)
  }

  // Simple wildcard patterns
  if (pattern.includes('*')) {
    const regex = patternToRegex(pattern)
    return regex.test(segment)
  }

  return segment === pattern
}

/**
 * Extract the static directory prefix from a pattern
 * e.g., 'src/components/**' -> 'src/components'
 */
function extractDirectoryPrefix(pattern: string): string | null {
  const parts = pattern.split('/')
  const staticParts: string[] = []

  for (const part of parts) {
    if (part === '**' || part.includes('*') || part.includes('?') || part.includes('[')) {
      break
    }
    staticParts.push(part)
  }

  return staticParts.length > 0 ? staticParts.join('/') : null
}

/**
 * Create a matcher function for a glob pattern
 */
function createMatcher(pattern: string): (path: string) => boolean {
  const regex = patternToRegex(pattern)
  return (path: string) => regex.test(path)
}

/**
 * Convert a glob pattern to a regular expression
 */
function patternToRegex(pattern: string): RegExp {
  let regexStr = ''
  let i = 0

  while (i < pattern.length) {
    const char = pattern[i]
    const nextChar = pattern[i + 1]

    // Handle **
    if (char === '*' && nextChar === '*') {
      const afterGlobstar = pattern[i + 2]
      if (i === 0 || pattern[i - 1] === '/') {
        // ** at start or after /
        if (afterGlobstar === '/' || afterGlobstar === undefined) {
          // **/ or ** at end - matches any number of directories
          regexStr += '(?:.*?)?'
          i += afterGlobstar === '/' ? 3 : 2
          continue
        }
      }
      // ** not at boundary - treat as two single *
      regexStr += '.*'
      i += 2
      continue
    }

    // Handle *
    if (char === '*') {
      // * matches anything except /
      regexStr += '[^/]*'
      i++
      continue
    }

    // Handle ?
    if (char === '?') {
      regexStr += '[^/]'
      i++
      continue
    }

    // Handle character classes [...]
    if (char === '[') {
      const closeIndex = pattern.indexOf(']', i + 1)
      if (closeIndex !== -1) {
        const classContent = pattern.slice(i, closeIndex + 1)
        regexStr += classContent
        i = closeIndex + 1
        continue
      }
    }

    // Handle brace expansion {a,b,c}
    if (char === '{') {
      const closeIndex = findMatchingBrace(pattern, i)
      if (closeIndex !== -1) {
        const braceContent = pattern.slice(i + 1, closeIndex)
        const alternatives = parseBraceExpansion(braceContent)
        regexStr += '(?:' + alternatives.map(escapeRegexSpecials).join('|') + ')'
        i = closeIndex + 1
        continue
      }
    }

    // Handle dot files and special regex characters
    if (char === '.') {
      regexStr += '\\.'
      i++
      continue
    }

    // Escape other regex special characters
    if ('^$+|()'.includes(char)) {
      regexStr += '\\' + char
      i++
      continue
    }

    // Regular character
    regexStr += char
    i++
  }

  return new RegExp('^' + regexStr + '$')
}

/**
 * Find the matching closing brace
 */
function findMatchingBrace(pattern: string, start: number): number {
  let depth = 0
  for (let i = start; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++
    if (pattern[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Parse brace expansion content like "ts,tsx,js"
 */
function parseBraceExpansion(content: string): string[] {
  const alternatives: string[] = []
  let current = ''
  let depth = 0

  for (let i = 0; i < content.length; i++) {
    const char = content[i]
    if (char === '{') depth++
    if (char === '}') depth--
    if (char === ',' && depth === 0) {
      alternatives.push(current)
      current = ''
    } else {
      current += char
    }
  }
  alternatives.push(current)

  return alternatives
}

/**
 * Escape regex special characters except glob-specific ones
 */
function escapeRegexSpecials(str: string): string {
  return str.replace(/[.^$+|()]/g, '\\$&')
}

// =============================================================================
// Cone Mode Implementation
// =============================================================================
//
// Git sparse-checkout "cone mode" provides a simpler, directory-based pattern
// system that is more efficient than arbitrary glob patterns. When cone mode
// is enabled:
//
// 1. TOPLEVEL FILES - Files at the repository root are always included
//    (package.json, README.md, etc.)
//
// 2. CONE DIRECTORIES - Specified directories include ALL their contents
//    recursively (everything under src/ if src/ is a cone)
//
// 3. ANCESTOR DIRECTORIES - Directories on the path to a cone include only
//    their immediate files, not subdirectories. For example, if
//    packages/core/src/ is a cone:
//    - packages/core/index.ts is included (immediate file of ancestor)
//    - packages/index.ts is included (immediate file of ancestor)
//    - packages/shared/index.ts is NOT included (sibling directory)
//
// 4. SIBLING DIRECTORIES - Directories that are not on the path to any cone
//    are excluded entirely
//
// This matches git sparse-checkout cone behavior exactly.
// Reference: https://git-scm.com/docs/git-sparse-checkout#_cone_pattern_set
// =============================================================================

/**
 * Check if a pattern contains glob wildcards (* ? [ ] { })
 *
 * @param pattern - The pattern to check
 * @returns true if the pattern contains any glob wildcard characters
 */
function hasGlobWildcards(pattern: string): boolean {
  return /[*?\[\]{}]/.test(pattern)
}

/**
 * Normalize a cone directory pattern
 * - Strips trailing slash if present
 * - Returns the canonical directory path
 */
function normalizeConePattern(pattern: string): string {
  return pattern.endsWith('/') ? pattern.slice(0, -1) : pattern
}

/**
 * Check if a path is at the toplevel (no directory separator)
 */
function isToplevelPath(path: string): boolean {
  return !path.includes('/')
}

/**
 * Get all ancestor directories for a path
 * e.g., 'src/components/ui' -> ['src', 'src/components']
 */
function getAncestorDirectories(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  const ancestors: string[] = []

  for (let i = 1; i < parts.length; i++) {
    ancestors.push(parts.slice(0, i).join('/'))
  }

  return ancestors
}

/**
 * Check if a path is an immediate child of a directory
 * e.g., isImmediateChildOf('src/index.ts', 'src') -> true
 * e.g., isImmediateChildOf('src/utils/helper.ts', 'src') -> false
 */
function isImmediateChildOf(path: string, dir: string): boolean {
  if (!path.startsWith(dir + '/')) {
    return false
  }
  const relativePath = path.slice(dir.length + 1)
  return !relativePath.includes('/')
}

/**
 * Check if a path is under a directory (immediate or nested)
 */
function isUnderDirectory(path: string, dir: string): boolean {
  return path.startsWith(dir + '/') || path === dir
}

/**
 * Create a cone mode include checker that matches git sparse-checkout behavior
 *
 * Git sparse-checkout cone semantics:
 * 1. Toplevel files are always included (package.json, README.md, etc.)
 * 2. Specified directories include all their contents recursively
 * 3. Ancestor directories only include their immediate files (not subdirectories)
 * 4. Sibling directories of specified paths are excluded
 *
 * This implementation includes LRU caching for repeated path checks and
 * pre-computed Sets for O(1) directory lookups.
 *
 * @param patterns - Directory patterns (without glob wildcards)
 * @param _excludePatterns - Currently unused in cone mode (reserved for future use)
 * @param cacheSize - Maximum number of cached decisions (default: 10000)
 * @returns An IncludeChecker for cone-mode pattern matching with caching
 * @throws Error if patterns contain glob wildcards
 *
 * @example
 * ```typescript
 * // Include all files under src/ and lib/
 * const checker = createConeIncludeChecker(['src/', 'lib/'], [], 10000)
 * ```
 *
 * @example
 * ```typescript
 * // Include nested directory with ancestor file inclusion
 * const checker = createConeIncludeChecker(['packages/core/src/'], [], 10000)
 * // Includes: packages/core/src/**, packages/core/index.ts, packages/index.ts
 * // Excludes: packages/other/**, packages/core/test/**
 * ```
 */
function createConeIncludeChecker(
  patterns: string[],
  _excludePatterns: string[],
  cacheSize: number = 10000
): IncludeChecker {
  // Validate patterns - cone mode only accepts directory patterns
  for (const pattern of patterns) {
    if (hasGlobWildcards(pattern)) {
      throw new Error(`Cone mode only accepts directory patterns, but got glob pattern: '${pattern}'`)
    }
  }

  // Normalize patterns (remove trailing slashes)
  const coneDirectories = patterns.map(normalizeConePattern)

  // Build the set of all ancestor directories across all cones
  // This enables O(1) lookups vs O(n) for checking all cones
  const ancestorDirectories = new Set<string>()
  for (const dir of coneDirectories) {
    for (const ancestor of getAncestorDirectories(dir)) {
      ancestorDirectories.add(ancestor)
    }
  }

  // Pre-compute a Set for fast cone directory lookups
  const coneDirectorySet = new Set(coneDirectories)

  // LRU caches for decisions
  const includeCache = new LRUCache<boolean>(cacheSize)
  const traverseCache = new LRUCache<boolean>(cacheSize)

  /**
   * Internal implementation of shouldInclude without caching
   * @internal
   */
  function computeShouldInclude(path: string): boolean {
    // Empty path is never included
    if (path === '') {
      return false
    }

    // Rule 1: Toplevel files are always included
    if (isToplevelPath(path)) {
      return true
    }

    // Rule 2: Files under specified cone directories are included
    // Optimization: check if parent directory is a cone first (common case)
    const lastSlash = path.lastIndexOf('/')
    if (lastSlash > 0) {
      const parentDir = path.substring(0, lastSlash)
      if (coneDirectorySet.has(parentDir)) {
        return true
      }

      // Rule 3 optimization: check if parent is an ancestor
      if (ancestorDirectories.has(parentDir)) {
        return true
      }
    }

    // Check all cone directories
    for (const dir of coneDirectories) {
      if (isUnderDirectory(path, dir)) {
        return true
      }
    }

    // Rule 4: Everything else is excluded (sibling directories, etc.)
    return false
  }

  /**
   * Internal implementation of shouldTraverseDirectory without caching
   * @internal
   */
  function computeShouldTraverse(dir: string): boolean {
    // Always traverse toplevel
    if (dir === '' || dir === '/') {
      return true
    }

    // Fast path: check if it's a cone directory or ancestor (O(1) lookup)
    if (coneDirectorySet.has(dir) || ancestorDirectories.has(dir)) {
      return true
    }

    // Check if this directory is under a cone
    for (const coneDir of coneDirectories) {
      if (isUnderDirectory(dir, coneDir)) {
        return true
      }
    }

    // Check if this directory is on the path to a cone
    for (const coneDir of coneDirectories) {
      if (coneDir.startsWith(dir + '/')) {
        return true
      }
    }

    return false
  }

  return {
    shouldInclude(path: string): boolean {
      // Check cache first
      const cached = includeCache.get(path)
      if (cached !== undefined) {
        return cached
      }

      // Compute and cache result
      const result = computeShouldInclude(path)
      includeCache.set(path, result)
      return result
    },

    shouldTraverseDirectory(dir: string): boolean {
      // Check cache first
      const cached = traverseCache.get(dir)
      if (cached !== undefined) {
        return cached
      }

      // Compute and cache result
      const result = computeShouldTraverse(dir)
      traverseCache.set(dir, result)
      return result
    },
  }
}

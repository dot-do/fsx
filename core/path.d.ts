/**
 * Path utilities for fsx.do - POSIX-style path manipulation
 *
 * This module provides POSIX-compliant path manipulation functions similar to
 * Node.js `path.posix`. All functions use forward slash (/) as the separator
 * and follow POSIX semantics for path resolution.
 *
 * @module path
 * @example
 * ```typescript
 * import { normalize, join, resolve, dirname, basename, extname } from './path'
 *
 * normalize('/foo//bar/../baz')  // '/foo/baz'
 * join('foo', 'bar', 'baz')      // 'foo/bar/baz'
 * resolve('/foo', 'bar')         // '/foo/bar'
 * dirname('/foo/bar/baz.txt')    // '/foo/bar'
 * basename('/foo/bar/baz.txt')   // 'baz.txt'
 * extname('file.txt')            // '.txt'
 * ```
 */
/**
 * POSIX path separator character.
 *
 * @example
 * ```typescript
 * import { sep } from './path'
 * console.log(sep) // '/'
 * ```
 */
export declare const sep: "/";
/**
 * POSIX path delimiter for environment variables like PATH.
 *
 * @example
 * ```typescript
 * import { delimiter } from './path'
 * const paths = '/usr/bin:/bin:/usr/local/bin'
 * paths.split(delimiter) // ['/usr/bin', '/bin', '/usr/local/bin']
 * ```
 */
export declare const delimiter: ":";
/**
 * Parsed path object containing all components of a path.
 *
 * @example
 * ```typescript
 * // For path '/home/user/file.txt':
 * {
 *   root: '/',
 *   dir: '/home/user',
 *   base: 'file.txt',
 *   ext: '.txt',
 *   name: 'file'
 * }
 * ```
 */
export interface ParsedPath {
    /** The root of the path ('/' for absolute, '' for relative) */
    root: string;
    /** The full directory path */
    dir: string;
    /** The filename including extension */
    base: string;
    /** The file extension including the leading dot */
    ext: string;
    /** The filename without extension */
    name: string;
}
/**
 * Normalize a path by resolving `.` and `..` segments and collapsing slashes.
 *
 * This function:
 * - Collapses multiple consecutive slashes to one
 * - Removes trailing slashes (except for root `/`)
 * - Resolves `.` (current directory) segments
 * - Resolves `..` (parent directory) segments
 * - Preserves the absolute/relative nature of the path
 *
 * @param path - The path to normalize
 * @returns The normalized path, or '.' if path is empty
 *
 * @example Basic normalization
 * ```typescript
 * normalize('/foo/bar//baz')     // '/foo/bar/baz'
 * normalize('/foo/./bar')        // '/foo/bar'
 * normalize('/foo/bar/../baz')   // '/foo/baz'
 * ```
 *
 * @example Edge cases
 * ```typescript
 * normalize('')                  // '.'
 * normalize('.')                 // '.'
 * normalize('..')                // '..'
 * normalize('/')                 // '/'
 * normalize('///')               // '/'
 * ```
 *
 * @example Relative paths with ..
 * ```typescript
 * normalize('../foo/bar')        // '../foo/bar'
 * normalize('foo/../../bar')     // '../bar'
 * normalize('/foo/../..')        // '/'  (cannot go above root)
 * ```
 */
export declare function normalize(path: string): string;
/**
 * Join path segments and normalize the result.
 *
 * Joins all path segments using the POSIX separator (`/`) and then
 * normalizes the resulting path. Empty segments are ignored.
 *
 * @param paths - Path segments to join
 * @returns The joined and normalized path, or '.' if no segments
 *
 * @example Basic joining
 * ```typescript
 * join('foo', 'bar', 'baz')      // 'foo/bar/baz'
 * join('/foo', 'bar', 'baz')     // '/foo/bar/baz'
 * join('foo', '', 'bar')         // 'foo/bar'
 * ```
 *
 * @example Joining with dots
 * ```typescript
 * join('foo', '.', 'bar')        // 'foo/bar'
 * join('foo', '..', 'bar')       // 'bar'
 * join('foo', 'bar', '..', 'baz') // 'foo/baz'
 * ```
 *
 * @example Leading slashes in non-first segments
 * ```typescript
 * join('/foo', '/bar')           // '/foo/bar'  (strips leading / from bar)
 * join('foo', '/bar')            // 'foo/bar'
 * ```
 *
 * @example Edge cases
 * ```typescript
 * join()                         // '.'
 * join('')                       // '.'
 * join('', '')                   // '.'
 * ```
 */
export declare function join(...paths: string[]): string;
/**
 * Resolve path segments to an absolute path.
 *
 * Processes segments from left to right. Each absolute path encountered
 * resets the resolved path. The result is always an absolute path.
 *
 * @param paths - Path segments to resolve
 * @returns The resolved absolute path, or '/' if no segments
 *
 * @example Basic resolution
 * ```typescript
 * resolve('/foo', 'bar')         // '/foo/bar'
 * resolve('/foo', 'bar', 'baz')  // '/foo/bar/baz'
 * resolve('foo', 'bar')          // '/foo/bar'  (relative treated as from /)
 * ```
 *
 * @example Absolute path override
 * ```typescript
 * resolve('/foo', '/bar')        // '/bar'  (later absolute overrides)
 * resolve('/foo', '/bar', 'baz') // '/bar/baz'
 * ```
 *
 * @example Dot resolution
 * ```typescript
 * resolve('/foo', '.', 'bar')    // '/foo/bar'
 * resolve('/foo/bar', '..')      // '/foo'
 * resolve('/foo', '..', '..', 'bar') // '/bar'  (stops at root)
 * ```
 *
 * @example Edge cases
 * ```typescript
 * resolve()                      // '/'
 * resolve('/')                   // '/'
 * resolve('/', '..')             // '/'  (cannot go above root)
 * ```
 */
export declare function resolve(...paths: string[]): string;
/**
 * Get the directory portion of a path.
 *
 * Returns the path up to (but not including) the final component.
 * Trailing slashes are ignored when determining the final component.
 *
 * @param path - The path to extract the directory from
 * @returns The directory portion, '.' if no directory, or '/' for root children
 *
 * @example Basic directory extraction
 * ```typescript
 * dirname('/foo/bar/baz.txt')    // '/foo/bar'
 * dirname('/foo/bar/baz')        // '/foo/bar'
 * dirname('/foo')                // '/'
 * ```
 *
 * @example Relative paths
 * ```typescript
 * dirname('foo/bar')             // 'foo'
 * dirname('file.txt')            // '.'
 * dirname('foo')                 // '.'
 * ```
 *
 * @example Edge cases
 * ```typescript
 * dirname('')                    // '.'
 * dirname('/')                   // '/'
 * dirname('/foo/bar/')           // '/foo'  (trailing slash ignored)
 * dirname('.')                   // '.'
 * dirname('..')                  // '.'
 * ```
 */
export declare function dirname(path: string): string;
/**
 * Get the filename portion of a path.
 *
 * Returns the last component of the path. Optionally removes a
 * matching extension from the result.
 *
 * @param path - The path to extract the filename from
 * @param ext - Optional extension to remove from the result
 * @returns The filename, or '' for root/empty paths
 *
 * @example Basic filename extraction
 * ```typescript
 * basename('/foo/bar/baz.txt')   // 'baz.txt'
 * basename('/foo/bar/baz')       // 'baz'
 * basename('file.txt')           // 'file.txt'
 * ```
 *
 * @example Extension removal
 * ```typescript
 * basename('/foo/bar.txt', '.txt')  // 'bar'
 * basename('/foo/bar.txt', '.md')   // 'bar.txt'  (no match)
 * basename('file.test.ts', '.ts')   // 'file.test'
 * ```
 *
 * @example Edge cases
 * ```typescript
 * basename('')                   // ''
 * basename('/')                  // ''
 * basename('/foo/bar/')          // 'bar'  (trailing slash ignored)
 * basename('.txt', '.txt')       // '.txt'  (ext === name, not removed)
 * ```
 */
export declare function basename(path: string, ext?: string): string;
/**
 * Extract the extension from a path.
 *
 * Returns the portion from the last `.` to the end of the basename,
 * including the leading dot. Returns empty string for dotfiles
 * without a second dot.
 *
 * @param path - The path to extract the extension from
 * @returns The extension including leading dot, or '' if none
 *
 * @example Basic extension extraction
 * ```typescript
 * extname('file.txt')            // '.txt'
 * extname('/foo/bar.json')       // '.json'
 * extname('archive.tar.gz')      // '.gz'  (last extension only)
 * ```
 *
 * @example Dotfiles
 * ```typescript
 * extname('.gitignore')          // ''  (dotfile without extension)
 * extname('.gitignore.bak')      // '.bak'  (dotfile with extension)
 * ```
 *
 * @example No extension
 * ```typescript
 * extname('file')                // ''
 * extname('/foo/bar')            // ''
 * extname('')                    // ''
 * extname('/')                   // ''
 * ```
 *
 * @example Special cases
 * ```typescript
 * extname('file.')               // '.'  (trailing dot)
 * extname('file..txt')           // '.txt'
 * ```
 */
export declare function extname(path: string): string;
/**
 * Parse a path into its component parts.
 *
 * Splits a path into root, dir, base, ext, and name components.
 * Use with `format()` for path manipulation.
 *
 * @param path - The path to parse
 * @returns Object containing path components
 *
 * @example Absolute path
 * ```typescript
 * parse('/home/user/file.txt')
 * // {
 * //   root: '/',
 * //   dir: '/home/user',
 * //   base: 'file.txt',
 * //   ext: '.txt',
 * //   name: 'file'
 * // }
 * ```
 *
 * @example Relative path
 * ```typescript
 * parse('foo/bar/baz.js')
 * // {
 * //   root: '',
 * //   dir: 'foo/bar',
 * //   base: 'baz.js',
 * //   ext: '.js',
 * //   name: 'baz'
 * // }
 * ```
 *
 * @example Filename only
 * ```typescript
 * parse('file.txt')
 * // {
 * //   root: '',
 * //   dir: '',
 * //   base: 'file.txt',
 * //   ext: '.txt',
 * //   name: 'file'
 * // }
 * ```
 */
export declare function parse(path: string): ParsedPath;
/**
 * Format a parsed path object back to a path string.
 *
 * Constructs a path from components. Priority rules:
 * - `dir` overrides `root` for the directory portion
 * - `base` overrides `name + ext` for the filename portion
 *
 * @param pathObject - Object containing path components
 * @returns The formatted path string
 *
 * @example Full path object
 * ```typescript
 * format({
 *   root: '/',
 *   dir: '/home/user',
 *   base: 'file.txt',
 *   ext: '.txt',
 *   name: 'file'
 * }) // '/home/user/file.txt'
 * ```
 *
 * @example Partial objects
 * ```typescript
 * format({ dir: '/home/user', base: 'file.txt' })  // '/home/user/file.txt'
 * format({ root: '/', base: 'file.txt' })          // '/file.txt'
 * format({ dir: '/home', name: 'file', ext: '.txt' }) // '/home/file.txt'
 * ```
 *
 * @example Priority rules
 * ```typescript
 * // base overrides name+ext
 * format({ base: 'actual.js', name: 'ignored', ext: '.ts' }) // 'actual.js'
 *
 * // dir overrides root
 * format({ root: '/', dir: '/home', base: 'file' }) // '/home/file'
 * ```
 */
export declare function format(pathObject: Partial<ParsedPath>): string;
/**
 * Check if a path is absolute (starts with /).
 *
 * @param path - The path to check
 * @returns True if the path is absolute
 *
 * @example
 * ```typescript
 * isAbsolute('/foo/bar')         // true
 * isAbsolute('/')                // true
 * isAbsolute('//foo')            // true  (multiple slashes)
 * isAbsolute('foo/bar')          // false
 * isAbsolute('./foo')            // false
 * isAbsolute('')                 // false
 * ```
 */
export declare function isAbsolute(path: string): boolean;
/**
 * Compute the relative path from `from` to `to`.
 *
 * Both paths are normalized and resolved to absolute paths before
 * computing the relative path.
 *
 * @param from - The starting path
 * @param to - The destination path
 * @returns The relative path from `from` to `to`, or '' if same
 *
 * @example Basic relative paths
 * ```typescript
 * relative('/foo/bar', '/foo/baz')       // '../baz'
 * relative('/foo', '/foo/bar')           // 'bar'
 * relative('/foo/bar', '/foo')           // '..'
 * relative('/foo/bar', '/foo/bar')       // ''  (same path)
 * ```
 *
 * @example Distant paths
 * ```typescript
 * relative('/a/b/c', '/x/y/z')           // '../../../x/y/z'
 * relative('/', '/foo/bar')              // 'foo/bar'
 * relative('/foo/bar', '/')              // '../..'
 * ```
 *
 * @example Normalized input
 * ```typescript
 * relative('/foo/bar', '/foo/./bar')     // ''  (normalized to same)
 * relative('/foo//bar', '/foo/bar/baz')  // 'baz'
 * ```
 */
export declare function relative(from: string, to: string): string;
/**
 * Check if a path contains potentially dangerous traversal sequences.
 *
 * Detects `..` segments that could escape a base directory.
 * Use this for security validation before path operations.
 *
 * @param path - The path to check
 * @returns True if the path contains traversal sequences
 *
 * @example
 * ```typescript
 * hasTraversal('../foo')         // true
 * hasTraversal('foo/../bar')     // true (could escape depending on resolution)
 * hasTraversal('/foo/bar')       // false
 * hasTraversal('./foo')          // false
 * hasTraversal('foo..bar')       // false (not a segment)
 * ```
 */
export declare function hasTraversal(path: string): boolean;
/**
 * Ensure a path stays within a base directory after normalization.
 *
 * Joins the base and path, normalizes the result, and verifies
 * it starts with the normalized base path.
 *
 * @param base - The base directory that must contain the result
 * @param path - The path to validate
 * @returns True if the resolved path is within base
 *
 * @example
 * ```typescript
 * isWithin('/app', 'data/file.txt')     // true -> /app/data/file.txt
 * isWithin('/app', '../etc/passwd')     // false -> escapes /app
 * isWithin('/app', '/etc/passwd')       // false -> absolute path escapes
 * isWithin('/app', './safe/../file')    // true -> /app/file
 * ```
 */
export declare function isWithin(base: string, path: string): boolean;
//# sourceMappingURL=path.d.ts.map
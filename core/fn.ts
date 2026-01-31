/**
 * AsyncFn Pattern - Unified function types with three calling styles
 *
 * FSX supports all 3 calling styles:
 * 1. fsx('/path/to/file') - Direct call
 * 2. fsx`/path/to/${filename}` - Tagged template with interpolation
 * 3. fsx`/path/to/file`({ encoding: 'utf8' }) - Tagged template with named params
 *
 * Generic order (most to least important):
 * - Out: Return type (like Promise<T>)
 * - In: Input type (void = no input, any = flexible)
 * - Opts: Options for behavior (encoding, recursive, etc.)
 *
 * @module
 */

// =============================================================================
// Parameter Extraction from Template Strings
// =============================================================================

/**
 * Extract {param} names from a template string at compile time
 *
 * @example
 * ```ts
 * type Params = ExtractParams<'/path/to/{filename}'>
 * // => 'filename'
 * ```
 */
export type ExtractParams<S extends string> =
  S extends `${string}{${infer Param}}${infer Rest}`
    ? Param | ExtractParams<Rest>
    : never

/**
 * Check if a string contains any {param} placeholders
 */
export type HasNamedParams<S extends string> =
  S extends `${string}{${string}}${string}` ? true : false

/**
 * Get the parameter record type for a template string
 */
export type ParamsRecord<S extends string, TValue = unknown> =
  [ExtractParams<S>] extends [never]
    ? Record<string, never>
    : Record<ExtractParams<S>, TValue>

// =============================================================================
// Tagged Template Result Type
// =============================================================================

/**
 * Conditional result type for tagged template calls
 *
 * If template has {params}, returns a function accepting those params
 * Otherwise returns the result directly
 */
export type TaggedResult<TReturn, S extends string, TOpts = object> =
  [ExtractParams<S>] extends [never]
    ? TReturn
    : (params: Record<ExtractParams<S>, unknown> & Partial<TOpts>) => TReturn

// =============================================================================
// Core Function Type - Fn<Out, In, Opts>
// =============================================================================

/**
 * A callable supporting three invocation styles
 *
 * @typeParam Out - Return type (most important, like Promise<T>)
 * @typeParam In - Input type (default: any for flexible input)
 * @typeParam Opts - Options type (encoding, recursive, etc.)
 *
 * @example
 * ```ts
 * const fs: Fn<string, string, { encoding?: string }>
 * fs('/path/to/file')
 * fs`/path/to/${filename}`
 * fs`/path/to/{file}`({ file: 'test.txt', encoding: 'utf8' })
 * ```
 */
export interface Fn<Out, In = unknown, Opts extends Record<string, unknown> = Record<string, unknown>> {
  /** Style 1: Direct call with input and optional options */
  (input: In, opts?: Opts): Out

  /** Style 2: Tagged template with ${...} interpolation */
  (strings: TemplateStringsArray, ...values: unknown[]): Out

  /** Style 3: Tagged template with {name} placeholders */
  <S extends string>(
    strings: TemplateStringsArray & { raw: readonly S[] }
  ): TaggedResult<Out, S, Opts>
}

// =============================================================================
// Async Function Type - AsyncFn<Out, In, Opts>
// =============================================================================

/**
 * Async version of Fn - returns Promise<Out>
 *
 * This is the primary pattern used by FSX for filesystem operations.
 *
 * @example
 * ```ts
 * const fsx: AsyncFn<FSResult, string, FSOptions>
 *
 * // All 3 calling styles:
 * await fsx('/path/to/file')
 * await fsx`/path/to/${filename}`
 * await fsx`/path/to/{file}`({ file: 'test.txt', encoding: 'utf8' })
 * ```
 */
export interface AsyncFn<Out, In = unknown, Opts extends Record<string, unknown> = Record<string, unknown>> {
  (input: In, opts?: Opts): Promise<Out>
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Out>
  <S extends string>(
    strings: TemplateStringsArray & { raw: readonly S[] }
  ): TaggedResult<Promise<Out>, S, Opts>
}

// =============================================================================
// Function Type Utilities
// =============================================================================

/**
 * Extract output type from any Fn variant
 */
export type FnOut<F> = F extends Fn<infer O, infer _I, infer _Opts> ? O : never

/**
 * Extract input type from any Fn variant
 */
export type FnIn<F> = F extends Fn<infer _O, infer I, infer _Opts> ? I : never

/**
 * Extract options type from any Fn variant
 */
export type FnOpts<F> = F extends Fn<infer _O, infer _I, infer Opts> ? Opts : never

/**
 * Convert Fn to AsyncFn
 */
export type ToAsync<F> = F extends Fn<infer O, infer I, infer Opts>
  ? AsyncFn<O, I, Opts extends Record<string, unknown> ? Opts : Record<string, never>>
  : never

// =============================================================================
// FSX Types
// =============================================================================

/**
 * Options for FSX operations
 */
export interface FSOptions extends Record<string, unknown> {
  /** Text encoding for string content */
  encoding?: 'utf8' | 'utf-8' | 'binary' | BufferEncoding
  /** Create parent directories if they don't exist */
  recursive?: boolean
  /** File mode (permissions) */
  mode?: number
  /** Open flags (r, w, a, r+, w+, a+, etc.) */
  flag?: string
}

/**
 * Result of FSX operations
 */
export interface FSResult {
  /** File content (for read operations) */
  content?: string | Uint8Array
  /** File statistics */
  stats?: {
    size: number
    mtime: number
    ctime?: number
    atime?: number
    isFile: boolean
    isDirectory: boolean
  }
  /** Success indicator (for write/delete operations) */
  success?: boolean
  /** Error message (if operation failed) */
  error?: string
}

/**
 * Buffer encoding types (Node.js compatible)
 */
export type BufferEncoding =
  | 'ascii'
  | 'utf8'
  | 'utf-8'
  | 'utf16le'
  | 'ucs2'
  | 'ucs-2'
  | 'base64'
  | 'base64url'
  | 'latin1'
  | 'binary'
  | 'hex'

/**
 * FSX - Filesystem function with AsyncFn pattern
 *
 * Supports all 3 calling styles:
 * - fsx('/path/to/file')
 * - fsx`/path/to/${filename}`
 * - fsx`/path/to/{file}`({ encoding: 'utf8' })
 *
 * @example
 * ```ts
 * import { createFSX, type FSX } from '@dotdo/fsx'
 *
 * const fsx: FSX = createFSX(backend)
 *
 * // Read file with direct call
 * const result = await fsx('/path/to/file')
 *
 * // Read file with template literal
 * const dir = '/home/user'
 * const result2 = await fsx`${dir}/config.json`
 *
 * // Read file with named params and options
 * const result3 = await fsx`/path/to/{filename}`({
 *   filename: 'config.json',
 *   encoding: 'utf8'
 * })
 * ```
 */
export type FSX = AsyncFn<FSResult, string, FSOptions>

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create an FSX instance with AsyncFn pattern
 *
 * This is a placeholder - the actual implementation would connect to
 * the fsx.do service or a local backend.
 *
 * @example
 * ```ts
 * import { createFSX } from '@dotdo/fsx'
 * import { MemoryBackend } from '@dotdo/fsx/backend'
 *
 * const backend = new MemoryBackend()
 * const fsx = createFSX(backend)
 *
 * await fsx('/path/to/file')
 * ```
 */
export function createFSX(/* backend or config */): FSX {
  // Implementation placeholder
  // The actual implementation would:
  // 1. Parse the path from direct call or template
  // 2. Execute the operation via the backend
  // 3. Return the result as FSResult
  throw new Error('Not implemented - use fsx.do service or provide a backend')
}

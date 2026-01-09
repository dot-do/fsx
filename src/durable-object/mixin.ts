/**
 * withFs Mixin - Adds filesystem capability to Durable Objects
 *
 * This mixin adds the $.fs capability to a Durable Object class,
 * providing lazy-loaded filesystem operations backed by SQLite and R2.
 *
 * @example
 * ```typescript
 * import { withFs } from 'fsx/do'
 * import { DO } from 'dotdo'
 *
 * class MySite extends withFs(DO) {
 *   async loadContent() {
 *     // $.fs is now available with full filesystem API
 *     const config = await this.$.fs.read('/config.json', { encoding: 'utf-8' })
 *     const files = await this.$.fs.list('/content')
 *     await this.$.fs.write('/cache/index.html', renderedContent)
 *   }
 * }
 * ```
 */

import { FsModule, type FsModuleConfig } from './module.js'

// ============================================================================
// TYPES
// ============================================================================

/**
 * Constructor type for class mixins
 */
type Constructor<T = {}> = new (...args: any[]) => T

/**
 * Base interface for classes that have a WorkflowContext ($)
 */
interface HasWorkflowContext {
  $: {
    [key: string]: unknown
  }
}

/**
 * Base interface for classes that have a Durable Object context
 */
interface HasDurableObjectContext {
  ctx: {
    storage: {
      sql: SqlStorage
    }
  }
  env?: {
    R2?: R2Bucket
    ARCHIVE?: R2Bucket
    [key: string]: unknown
  }
}

/**
 * Extended WorkflowContext with fs capability
 */
export interface WithFsContext {
  fs: FsModule
  [key: string]: unknown
}

/**
 * Type for a class with the fs mixin applied
 */
export interface WithFsDO<TBase extends Constructor<HasWorkflowContext & HasDurableObjectContext>>
  extends InstanceType<TBase> {
  $: WithFsContext
}

/**
 * Options for configuring the fs mixin
 */
export interface WithFsOptions {
  /** Base path for all fs operations */
  basePath?: string
  /** Max file size for hot tier (SQLite) */
  hotMaxSize?: number
  /** Default file permissions */
  defaultMode?: number
  /** Default directory permissions */
  defaultDirMode?: number
  /** R2 bucket binding name (default: 'R2') */
  r2BindingName?: string
  /** Archive R2 bucket binding name (default: 'ARCHIVE') */
  archiveBindingName?: string
}

// Symbol for caching the fs capability instance
const FS_CAPABILITY_CACHE = Symbol('fsCapabilityCache')

// ============================================================================
// MIXIN FUNCTION
// ============================================================================

/**
 * withFs - Mixin that adds filesystem capability to a Durable Object
 *
 * This function creates a new class that extends the provided base class
 * with filesystem capabilities available through $.fs.
 *
 * @param Base - The base Durable Object class to extend
 * @param options - Optional configuration for the filesystem
 * @returns A new class with $.fs filesystem capability
 *
 * @example
 * ```typescript
 * // Basic usage
 * class MySite extends withFs(DO) {
 *   async readConfig() {
 *     return this.$.fs.read('/config.json', { encoding: 'utf-8' })
 *   }
 * }
 *
 * // With options
 * class MyApp extends withFs(DO, { hotMaxSize: 5 * 1024 * 1024 }) {
 *   async saveData(data: string) {
 *     await this.$.fs.write('/data.json', data)
 *   }
 * }
 * ```
 */
export function withFs<TBase extends Constructor<HasWorkflowContext & HasDurableObjectContext>>(
  Base: TBase,
  options: WithFsOptions = {}
) {
  return class WithFs extends Base {
    /**
     * Static capabilities array for introspection
     */
    static capabilities = [...((Base as any).capabilities || []), 'fs']

    /**
     * Cache for the FsModule instance
     */
    private [FS_CAPABILITY_CACHE]?: FsModule

    /**
     * Get the FsModule instance (lazy-loaded)
     */
    private get fsCapability(): FsModule {
      if (!this[FS_CAPABILITY_CACHE]) {
        // Get R2 bindings from env
        const r2BindingName = options.r2BindingName ?? 'R2'
        const archiveBindingName = options.archiveBindingName ?? 'ARCHIVE'

        const config: FsModuleConfig = {
          sql: this.ctx.storage.sql,
          r2: this.env?.[r2BindingName] as R2Bucket | undefined,
          archive: this.env?.[archiveBindingName] as R2Bucket | undefined,
          basePath: options.basePath,
          hotMaxSize: options.hotMaxSize,
          defaultMode: options.defaultMode,
          defaultDirMode: options.defaultDirMode,
        }

        this[FS_CAPABILITY_CACHE] = new FsModule(config)
      }
      return this[FS_CAPABILITY_CACHE]
    }

    /**
     * Check if this DO has a specific capability
     */
    hasCapability(name: string): boolean {
      if (name === 'fs') return true
      // Check parent class
      const baseProto = Base.prototype
      if (baseProto && typeof (baseProto as any).hasCapability === 'function') {
        return (baseProto as any).hasCapability.call(this, name)
      }
      return false
    }

    constructor(...args: any[]) {
      super(...args)

      // Extend $ to include fs capability
      const originalContext = this.$
      const self = this

      // Create a new proxy that extends the original $ with fs
      this.$ = new Proxy(originalContext as WithFsContext, {
        get(target, prop: string | symbol) {
          if (prop === 'fs') {
            return self.fsCapability
          }
          // Forward to original context
          const value = (target as any)[prop]
          if (typeof value === 'function') {
            return value.bind(target)
          }
          return value
        },
        has(target, prop) {
          if (prop === 'fs') return true
          return prop in target
        },
        ownKeys(target) {
          return [...Reflect.ownKeys(target), 'fs']
        },
        getOwnPropertyDescriptor(target, prop) {
          if (prop === 'fs') {
            return {
              configurable: true,
              enumerable: true,
              writable: false,
              value: self.fsCapability,
            }
          }
          return Reflect.getOwnPropertyDescriptor(target, prop)
        },
      })
    }
  }
}

// ============================================================================
// TYPE HELPERS
// ============================================================================

/**
 * Check if a context has the fs capability
 */
export function hasFs<T extends { $: { [key: string]: unknown } }>(
  obj: T
): obj is T & { $: WithFsContext } {
  return obj.$ != null && typeof (obj.$ as any).fs === 'object' && (obj.$ as any).fs !== null
}

/**
 * Get the fs capability from a context, throwing if not available
 */
export function getFs<T extends { $: { [key: string]: unknown } }>(obj: T): FsModule {
  if (!hasFs(obj)) {
    throw new Error("Filesystem capability is not available. Use withFs mixin to add it.")
  }
  return obj.$.fs
}

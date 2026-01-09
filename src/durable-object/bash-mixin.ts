/**
 * withBash Mixin - Adds bash command execution capability to Durable Objects
 *
 * This mixin adds the $.bash capability to a Durable Object class,
 * providing safe bash-like command execution backed by FsModule.
 *
 * IMPORTANT: withBash requires withFs to be applied first, as BashModule
 * depends on FsModule for file operations.
 *
 * @example
 * ```typescript
 * import { withBash, withFs } from 'fsx/do'
 * import { DO } from 'dotdo'
 *
 * // withFs must be applied before withBash
 * class MySite extends withBash(withFs(DO)) {
 *   async setup() {
 *     // $.bash is now available with bash command execution
 *     await this.$.bash.exec('mkdir -p /app/data')
 *     const result = await this.$.bash.exec('ls -la /app')
 *     console.log(result.stdout)
 *
 *     // Analyze command safety before execution
 *     const analysis = this.$.bash.analyze('rm -rf /')
 *     if (!analysis.safe) {
 *       console.log('Command blocked:', analysis.reasons)
 *     }
 *   }
 * }
 * ```
 */

import { BashModule, type BashModuleConfig } from './BashModule.js'
import type { FsModule } from './module.js'

// ============================================================================
// TYPES
// ============================================================================

/**
 * Constructor type for class mixins
 */
type Constructor<T = {}> = new (...args: any[]) => T

/**
 * Base interface for classes that have a WorkflowContext ($) with fs capability
 */
interface HasFsContext {
  $: {
    fs: FsModule
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
    [key: string]: unknown
  }
}

/**
 * Extended WorkflowContext with bash capability
 */
export interface WithBashContext {
  fs: FsModule
  bash: BashModule
  [key: string]: unknown
}

/**
 * Type for a class with the bash mixin applied
 */
export interface WithBashDO<TBase extends Constructor<HasFsContext & HasDurableObjectContext>>
  extends InstanceType<TBase> {
  $: WithBashContext
}

/**
 * Options for configuring the bash mixin
 */
export interface WithBashOptions {
  /** Initial working directory (default: '/') */
  cwd?: string
  /** Environment variables */
  env?: Record<string, string>
  /** Enable strict mode - fail on any error (default: false) */
  strict?: boolean
  /** Command timeout in milliseconds (default: 30000) */
  timeout?: number
  /** Allowed commands whitelist (default: all safe commands) */
  allowedCommands?: string[]
  /** Blocked commands blacklist (default: dangerous commands) */
  blockedCommands?: string[]
}

// Symbol for caching the bash capability instance
const BASH_CAPABILITY_CACHE = Symbol('bashCapabilityCache')

// ============================================================================
// MIXIN FUNCTION
// ============================================================================

/**
 * withBash - Mixin that adds bash command execution capability to a Durable Object
 *
 * This function creates a new class that extends the provided base class
 * with bash capabilities available through $.bash.
 *
 * IMPORTANT: The base class must have $.fs available (use withFs mixin first).
 *
 * @param Base - The base Durable Object class to extend (must have $.fs)
 * @param options - Optional configuration for the bash module
 * @returns A new class with $.bash bash capability
 *
 * @example
 * ```typescript
 * // Basic usage - withFs must be applied first
 * class MySite extends withBash(withFs(DO)) {
 *   async runSetup() {
 *     await this.$.bash.exec('mkdir -p /app/config')
 *     await this.$.bash.exec('touch /app/config/.env')
 *   }
 * }
 *
 * // With options
 * class MyApp extends withBash(withFs(DO), {
 *   cwd: '/app',
 *   strict: true,
 *   env: { NODE_ENV: 'production' }
 * }) {
 *   async deploy() {
 *     // Commands execute from /app directory
 *     await this.$.bash.exec('mkdir -p dist')
 *   }
 * }
 * ```
 */
export function withBash<TBase extends Constructor<HasFsContext & HasDurableObjectContext>>(
  Base: TBase,
  options: WithBashOptions = {}
) {
  return class WithBash extends Base {
    /**
     * Static capabilities array for introspection
     */
    static capabilities = [...((Base as any).capabilities || []), 'bash']

    /**
     * Cache for the BashModule instance
     */
    private [BASH_CAPABILITY_CACHE]?: BashModule

    /**
     * Get the BashModule instance (lazy-loaded)
     */
    private get bashCapability(): BashModule {
      if (!this[BASH_CAPABILITY_CACHE]) {
        // Get fs from context - withFs must be applied first
        const fs = (this.$ as any).fs as FsModule

        if (!fs) {
          throw new Error(
            'BashModule requires FsModule. Apply withFs mixin before withBash: ' +
            'class MyClass extends withBash(withFs(DO)) { ... }'
          )
        }

        const config: BashModuleConfig = {
          fs,
          cwd: options.cwd,
          env: options.env,
          strict: options.strict,
          timeout: options.timeout,
          allowedCommands: options.allowedCommands,
          blockedCommands: options.blockedCommands,
        }

        this[BASH_CAPABILITY_CACHE] = new BashModule(config)
      }
      return this[BASH_CAPABILITY_CACHE]
    }

    /**
     * Check if this DO has a specific capability
     */
    hasCapability(name: string): boolean {
      if (name === 'bash') return true
      // Check parent class
      const baseProto = Base.prototype
      if (baseProto && typeof (baseProto as any).hasCapability === 'function') {
        return (baseProto as any).hasCapability.call(this, name)
      }
      return false
    }

    constructor(...args: any[]) {
      super(...args)

      // Extend $ to include bash capability
      const originalContext = this.$
      const self = this

      // Create a new proxy that extends the original $ with bash
      this.$ = new Proxy(originalContext as WithBashContext, {
        get(target, prop: string | symbol) {
          if (prop === 'bash') {
            return self.bashCapability
          }
          // Forward to original context
          const value = (target as any)[prop]
          if (typeof value === 'function') {
            return value.bind(target)
          }
          return value
        },
        has(target, prop) {
          if (prop === 'bash') return true
          return prop in target
        },
        ownKeys(target) {
          return [...Reflect.ownKeys(target), 'bash']
        },
        getOwnPropertyDescriptor(target, prop) {
          if (prop === 'bash') {
            return {
              configurable: true,
              enumerable: true,
              writable: false,
              value: self.bashCapability,
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
 * Check if a context has the bash capability
 */
export function hasBash<T extends { $: { [key: string]: unknown } }>(
  obj: T
): obj is T & { $: WithBashContext } {
  return obj.$ != null && typeof (obj.$ as any).bash === 'object' && (obj.$ as any).bash !== null
}

/**
 * Get the bash capability from a context, throwing if not available
 */
export function getBash<T extends { $: { [key: string]: unknown } }>(obj: T): BashModule {
  if (!hasBash(obj)) {
    throw new Error("Bash capability is not available. Use withBash mixin to add it.")
  }
  return obj.$.bash
}

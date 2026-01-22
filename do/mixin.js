/**
 * withFs Mixin - Adds filesystem capability to Durable Objects
 *
 * This mixin adds the $.fs capability to a Durable Object class,
 * providing lazy-loaded filesystem operations backed by SQLite and R2.
 *
 * @category Application
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
import { FsModule } from './module.js';
// WeakMap for caching the fs capability instance
// Using WeakMap instead of private class members to avoid TypeScript export issues
const fsCapabilityCache = new WeakMap();
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
export function withFs(Base, options = {}) {
    return class WithFs extends Base {
        /**
         * Static capabilities array for introspection
         */
        static capabilities = [...(Base.capabilities || []), 'fs'];
        /**
         * Get the FsModule instance (lazy-loaded)
         * @internal
         */
        get _fsCapability() {
            let cached = fsCapabilityCache.get(this);
            if (!cached) {
                // Get R2 bindings from env
                const r2BindingName = options.r2BindingName ?? 'R2';
                const archiveBindingName = options.archiveBindingName ?? 'ARCHIVE';
                const config = {
                    sql: this.ctx.storage.sql,
                    r2: this.env?.[r2BindingName],
                    archive: this.env?.[archiveBindingName],
                    basePath: options.basePath,
                    hotMaxSize: options.hotMaxSize,
                    defaultMode: options.defaultMode,
                    defaultDirMode: options.defaultDirMode,
                };
                cached = new FsModule(config);
                fsCapabilityCache.set(this, cached);
            }
            return cached;
        }
        /**
         * Check if this DO has a specific capability
         */
        hasCapability(name) {
            if (name === 'fs')
                return true;
            // Check parent class
            const baseProto = Base.prototype;
            if (baseProto && typeof baseProto.hasCapability === 'function') {
                return baseProto.hasCapability.call(this, name);
            }
            return false;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        constructor(...args) {
            super(...args);
            // Extend $ to include fs capability
            const originalContext = this.$;
            const self = this;
            // Create a new proxy that extends the original $ with fs
            this.$ = new Proxy(originalContext, {
                get(target, prop) {
                    if (prop === 'fs') {
                        return self._fsCapability;
                    }
                    // Forward to original context
                    const value = target[prop];
                    if (typeof value === 'function') {
                        return value.bind(target);
                    }
                    return value;
                },
                has(target, prop) {
                    if (prop === 'fs')
                        return true;
                    return prop in target;
                },
                ownKeys(target) {
                    return [...Reflect.ownKeys(target), 'fs'];
                },
                getOwnPropertyDescriptor(target, prop) {
                    if (prop === 'fs') {
                        return {
                            configurable: true,
                            enumerable: true,
                            writable: false,
                            value: self._fsCapability,
                        };
                    }
                    return Reflect.getOwnPropertyDescriptor(target, prop);
                },
            });
        }
    };
}
// ============================================================================
// TYPE HELPERS
// ============================================================================
/**
 * Check if a context has the fs capability
 */
export function hasFs(obj) {
    return obj.$ != null && typeof obj.$.fs === 'object' && obj.$.fs !== null;
}
/**
 * Get the fs capability from a context, throwing if not available
 */
export function getFs(obj) {
    if (!hasFs(obj)) {
        throw new Error("Filesystem capability is not available. Use withFs mixin to add it.");
    }
    return obj.$.fs;
}
//# sourceMappingURL=mixin.js.map
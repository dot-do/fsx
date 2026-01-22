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
/**
 * Constructor type for class mixins.
 * Using `unknown[]` instead of `any[]` would break mixin patterns,
 * so `any[]` is the standard TypeScript pattern here.
 */
type Constructor<T = object> = new (...args: any[]) => T;
/**
 * Base interface for classes that have a WorkflowContext ($)
 */
interface HasWorkflowContext {
    $: {
        [key: string]: unknown;
    };
}
/**
 * Base interface for classes that have a Durable Object context
 */
interface HasDurableObjectContext {
    ctx: {
        storage: {
            sql: SqlStorage;
        };
    };
    env?: {
        R2?: R2Bucket;
        ARCHIVE?: R2Bucket;
        [key: string]: unknown;
    };
}
/**
 * Extended WorkflowContext with fs capability
 */
export interface WithFsContext {
    fs: FsModule;
    [key: string]: unknown;
}
/**
 * Type for a class with the fs mixin applied.
 */
export type WithFsDO<TBase extends Constructor<HasWorkflowContext & HasDurableObjectContext>> = {
    $: WithFsContext;
} & InstanceType<TBase>;
/**
 * Options for configuring the fs mixin
 */
export interface WithFsOptions {
    /** Base path for all fs operations */
    basePath?: string;
    /** Max file size for hot tier (SQLite) */
    hotMaxSize?: number;
    /** Default file permissions */
    defaultMode?: number;
    /** Default directory permissions */
    defaultDirMode?: number;
    /** R2 bucket binding name (default: 'R2') */
    r2BindingName?: string;
    /** Archive R2 bucket binding name (default: 'ARCHIVE') */
    archiveBindingName?: string;
}
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
export declare function withFs<TBase extends Constructor<HasWorkflowContext & HasDurableObjectContext>>(Base: TBase, options?: WithFsOptions): {
    new (...args: any[]): {
        /**
         * Get the FsModule instance (lazy-loaded)
         * @internal
         */
        get _fsCapability(): FsModule;
        /**
         * Check if this DO has a specific capability
         */
        hasCapability(name: string): boolean;
        $: {
            [key: string]: unknown;
        };
        ctx: {
            storage: {
                sql: SqlStorage;
            };
        };
        env?: {
            R2?: R2Bucket;
            ARCHIVE?: R2Bucket;
            [key: string]: unknown;
        };
    };
    /**
     * Static capabilities array for introspection
     */
    capabilities: any[];
} & TBase;
/**
 * Check if a context has the fs capability
 */
export declare function hasFs<T extends {
    $: {
        [key: string]: unknown;
    };
}>(obj: T): obj is T & {
    $: WithFsContext;
};
/**
 * Get the fs capability from a context, throwing if not available
 */
export declare function getFs<T extends {
    $: {
        [key: string]: unknown;
    };
}>(obj: T): FsModule;
export {};
//# sourceMappingURL=mixin.d.ts.map
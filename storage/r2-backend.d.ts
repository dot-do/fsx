/**
 * R2Backend - Cloudflare R2 implementation of FsBackend
 *
 * This is the production backend for fsx that stores files in Cloudflare R2
 * with metadata in SQLite (via Durable Objects).
 *
 * Architecture:
 * - Metadata (paths, permissions, timestamps) -> SQLite
 * - File content -> R2 (warm/cold tier) or SQLite blobs (hot tier)
 *
 * @module storage/r2-backend
 */
import type { WriteOptions, MkdirOptions, RmdirOptions, ReaddirOptions, Stats, Dirent, StorageTier } from '../core/index.js';
import type { FsBackend, BackendWriteResult, FileHandle } from '../core/backend.js';
/**
 * Configuration options for R2Backend.
 */
export interface R2BackendConfig {
    /** SQLite storage instance from Durable Object context */
    sql: SqlStorage;
    /** R2 bucket for warm tier storage (required for production) */
    r2: R2Bucket;
    /** Optional R2 bucket for cold/archive tier storage */
    archive?: R2Bucket;
    /** Hot tier max size in bytes (default: 1MB) - files smaller than this go to SQLite */
    hotMaxSize?: number;
    /** Default file mode (default: 0o644) */
    defaultMode?: number;
    /** Default directory mode (default: 0o755) */
    defaultDirMode?: number;
    /** Key prefix for R2 objects (default: '') */
    prefix?: string;
}
/**
 * R2Backend - Production filesystem backend using R2 + SQLite.
 *
 * Implements the FsBackend interface for use with FSx. Stores metadata in
 * SQLite and file content in R2, with automatic tiering based on file size.
 *
 * @example
 * ```typescript
 * import { FSx } from '@dotdo/fsx'
 * import { R2Backend } from 'fsx/storage'
 *
 * const backend = new R2Backend({
 *   sql: ctx.storage.sql,
 *   r2: env.MY_BUCKET,
 *   hotMaxSize: 512 * 1024, // 512KB
 * })
 *
 * const fs = new FSx(backend)
 * await fs.write('/config.json', JSON.stringify(config))
 * ```
 */
export declare class R2Backend implements FsBackend {
    private sql;
    private metadata;
    private r2Storage;
    private archive?;
    private hotMaxSize;
    private defaultMode;
    private defaultDirMode;
    private initialized;
    constructor(config: R2BackendConfig);
    private initialize;
    private normalizePath;
    private getParentPath;
    private getFileName;
    private selectTier;
    private storeBlob;
    private getBlob;
    private deleteBlob;
    /**
     * Get the tier for a blob ID by looking it up
     */
    private getBlobTier;
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array, options?: WriteOptions): Promise<BackendWriteResult>;
    unlink(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    copyFile(src: string, dest: string): Promise<void>;
    mkdir(path: string, options?: MkdirOptions): Promise<void>;
    rmdir(path: string, options?: RmdirOptions): Promise<void>;
    private deleteRecursive;
    readdir(path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]>;
    stat(path: string): Promise<Stats>;
    lstat(path: string): Promise<Stats>;
    private entryToStats;
    exists(path: string): Promise<boolean>;
    chmod(path: string, mode: number): Promise<void>;
    chown(path: string, uid: number, gid: number): Promise<void>;
    utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void>;
    symlink(target: string, path: string): Promise<void>;
    link(existingPath: string, newPath: string): Promise<void>;
    readlink(path: string): Promise<string>;
    appendFile(path: string, data: Uint8Array): Promise<void>;
    access(path: string, _mode?: number): Promise<void>;
    realpath(path: string): Promise<string>;
    mkdtemp(prefix: string): Promise<string>;
    open(path: string, flags?: string, mode?: number): Promise<FileHandle>;
    getTier(path: string): Promise<StorageTier>;
    promote(path: string, tier: 'hot' | 'warm'): Promise<void>;
    demote(path: string, tier: 'warm' | 'cold'): Promise<void>;
}
//# sourceMappingURL=r2-backend.d.ts.map
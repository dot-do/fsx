/**
 * COWHandler - Copy-on-Write Handler for Branchable Filesystem
 *
 * Implements copy-on-write (COW) semantics for branch-based filesystems.
 * When a write occurs to a block/path that exists in a parent branch (inherited),
 * this handler creates a new version specific to the current branch while
 * preserving the original in the parent branch.
 *
 * Key features:
 * - Tracks which paths have been modified in the current branch (dirty paths)
 * - Intercepts writes to implement COW semantics
 * - Provides commit mechanism to finalize dirty blocks
 * - Integrates with CAS for content-addressable storage
 *
 * @example
 * ```typescript
 * const handler = new COWHandler({
 *   currentBranch: 'feature-x',
 *   parentBranch: 'main',
 *   storage: casStorage,
 * })
 *
 * // Write to a file that exists in parent branch
 * const result = await handler.interceptWrite('/config.json', newData)
 * // result.copiedFromParent === true if this was an inherited block
 *
 * // Get list of uncommitted changes
 * const dirty = handler.getDirtyPaths()
 * // ['/config.json']
 *
 * // Commit changes to finalize this branch's state
 * await handler.commit()
 * ```
 */
/**
 * Metadata about a block in the branch
 */
export interface BlockInfo {
    /** Content hash (SHA-1 or SHA-256) */
    hash: string;
    /** Size in bytes */
    size: number;
    /** Whether this block exists in the current branch vs inherited from parent */
    isOwned: boolean;
    /** Timestamp of last modification (if owned) */
    modifiedAt?: number;
}
/**
 * Branch state tracking
 */
export interface BranchState {
    /** Branch identifier */
    branchId: string;
    /** Parent branch (null for root/main) */
    parentBranch: string | null;
    /** Map of path -> block info for this branch's overrides */
    blocks: Map<string, BlockInfo>;
    /** Tree hash representing the current state */
    treeHash?: string;
    /** Creation timestamp */
    createdAt: number;
    /** Last modification timestamp */
    modifiedAt: number;
}
/**
 * Result of an intercepted write operation
 */
export interface WriteInterceptResult {
    /** Content hash of the written data */
    hash: string;
    /** Number of bytes written */
    bytesWritten: number;
    /** Whether this write involved copying from a parent branch */
    copiedFromParent: boolean;
    /** The path that was written */
    path: string;
    /** Previous hash (if overwriting existing content) */
    previousHash?: string;
}
/**
 * Options for COWHandler initialization
 */
export interface COWHandlerOptions {
    /** Current branch ID */
    currentBranch: string;
    /** Parent branch ID (null for root branches like main) */
    parentBranch: string | null;
    /**
     * Resolver to check if a path exists in a parent branch and get its hash
     * This is called when a write targets a path not yet in the current branch
     */
    resolveParentBlock: (path: string, branchId: string) => Promise<BlockInfo | null>;
    /**
     * Writer function to persist content to storage
     * Returns the content hash
     */
    writeContent: (path: string, data: Uint8Array) => Promise<string>;
    /**
     * Reader function to get content from storage by hash
     */
    readContent?: (hash: string) => Promise<Uint8Array | null>;
    /**
     * Initial branch state (if resuming from persisted state)
     */
    initialState?: BranchState;
}
/**
 * Commit result containing summary of changes
 */
export interface CommitResult {
    /** Branch that was committed */
    branchId: string;
    /** Number of paths that were committed */
    pathCount: number;
    /** List of paths that were committed */
    paths: string[];
    /** Total bytes in committed content */
    totalBytes: number;
    /** Timestamp of commit */
    committedAt: number;
    /** New tree hash after commit */
    treeHash?: string;
}
/**
 * Information about a dirty path
 */
export interface DirtyPathInfo {
    /** The path */
    path: string;
    /** Block info for this path */
    block: BlockInfo;
    /** Whether this is a new file (vs modification of existing) */
    isNew: boolean;
    /** Previous hash (if modification) */
    previousHash?: string;
}
/**
 * COWHandler - Copy-on-Write Handler
 *
 * Manages copy-on-write semantics for a branch-based filesystem.
 * Tracks modifications, ensures parent data is preserved, and
 * provides commit functionality.
 */
export declare class COWHandler {
    private currentBranch;
    private parentBranch;
    private resolveParentBlock;
    private writeContent;
    private _readContent?;
    /** Map of path -> block info for current branch's owned blocks */
    private ownedBlocks;
    /** Set of paths that have been modified but not committed */
    private dirtyPaths;
    /** Map tracking previous hashes for modified paths (for diffing) */
    private previousHashes;
    /** Timestamp of handler creation */
    private createdAt;
    /** Timestamp of last modification */
    private modifiedAt;
    /** Whether the handler has uncommitted changes */
    private _isDirty;
    constructor(options: COWHandlerOptions);
    /**
     * Get the current branch ID
     */
    getCurrentBranch(): string;
    /**
     * Get the parent branch ID
     */
    getParentBranch(): string | null;
    /**
     * Check if the handler has uncommitted changes
     */
    isDirty(): boolean;
    /**
     * Intercept a write operation and apply COW semantics
     *
     * This is the core method that implements copy-on-write:
     * 1. Check if the path exists in the current branch (owned)
     * 2. If not owned, check if it exists in parent branch (inherited)
     * 3. Write the new content
     * 4. Track the path as dirty for this branch
     *
     * @param path - The path being written to
     * @param data - The data to write
     * @returns Result of the write operation
     */
    interceptWrite(path: string, data: Uint8Array): Promise<WriteInterceptResult>;
    /**
     * Read content for a path by resolving block info and using readContent
     *
     * @param path - The path to read
     * @returns Content data if exists and readContent is configured, null otherwise
     */
    readBlockContent(path: string): Promise<Uint8Array | null>;
    /**
     * Check if a path exists in the current branch (owned or inherited)
     *
     * @param path - The path to check
     * @returns Block info if exists, null otherwise
     */
    getBlockInfo(path: string): Promise<BlockInfo | null>;
    /**
     * Check if a path is owned by the current branch (not inherited)
     *
     * @param path - The path to check
     * @returns true if path has been written in this branch
     */
    isOwned(path: string): boolean;
    /**
     * Check if a path has uncommitted changes
     *
     * @param path - The path to check
     * @returns true if path has been modified but not committed
     */
    isPathDirty(path: string): boolean;
    /**
     * Get list of paths with uncommitted changes
     *
     * @returns Array of dirty paths
     */
    getDirtyPaths(): string[];
    /**
     * Get detailed info about all dirty paths
     *
     * @returns Array of dirty path info including whether it's new or modified
     */
    getDirtyPathsInfo(): DirtyPathInfo[];
    /**
     * Get count of dirty paths
     *
     * @returns Number of uncommitted changes
     */
    getDirtyCount(): number;
    /**
     * Commit all dirty blocks, finalizing them for this branch
     *
     * After commit:
     * - Dirty paths are cleared
     * - Blocks remain owned by this branch
     * - Previous hashes are cleared
     *
     * @returns Commit result with summary
     */
    commit(): Promise<CommitResult>;
    /**
     * Discard uncommitted changes for a specific path
     *
     * @param path - The path to discard changes for
     * @returns true if changes were discarded, false if path wasn't dirty
     */
    discardPath(path: string): boolean;
    /**
     * Discard all uncommitted changes
     *
     * @returns Number of paths that were discarded
     */
    discardAll(): number;
    /**
     * Mark a path as deleted in this branch
     *
     * This creates a tombstone marker so the path appears deleted
     * even though it may exist in a parent branch.
     *
     * @param path - The path to mark as deleted
     * @returns true if path was marked deleted, false if it didn't exist
     */
    markDeleted(path: string): Promise<boolean>;
    /**
     * Check if a path is marked as deleted (tombstoned)
     *
     * @param path - The path to check
     * @returns true if path is explicitly deleted in this branch
     */
    isDeleted(path: string): boolean;
    /**
     * Get all owned blocks (written in this branch)
     *
     * @returns Map of path to block info
     */
    getOwnedBlocks(): Map<string, BlockInfo>;
    /**
     * Get the current branch state for persistence
     *
     * @returns Branch state that can be serialized
     */
    getState(): BranchState;
    /**
     * Restore state from a persisted branch state
     *
     * @param state - Previously saved branch state
     */
    private restoreState;
    /**
     * Set an owned block (for restoring from persisted state)
     * This does NOT mark the path as dirty.
     *
     * @param path - The path to set
     * @param block - The block info
     */
    setOwnedBlock(path: string, block: BlockInfo): void;
    /**
     * Normalize a path to ensure consistent format
     */
    private normalizePath;
}
/**
 * Create a COWHandler for a branch
 *
 * @param options - Handler configuration
 * @returns Configured COWHandler instance
 *
 * @example
 * ```typescript
 * const handler = createCOWHandler({
 *   currentBranch: 'feature-x',
 *   parentBranch: 'main',
 *   resolveParentBlock: async (path, branchId) => {
 *     // Look up block in parent branch
 *     return branchStorage.getBlock(path, branchId)
 *   },
 *   writeContent: async (path, data) => {
 *     // Write to CAS and return hash
 *     return cas.putObject(data, 'blob')
 *   }
 * })
 * ```
 */
export declare function createCOWHandler(options: COWHandlerOptions): COWHandler;
import { ContentAddressableFS } from './cas/content-addressable-fs.js';
/**
 * Branch metadata storage interface
 * Responsible for persisting branch state (path -> hash mappings)
 */
export interface BranchMetadataStorage {
    /**
     * Get all block mappings for a branch
     */
    getBlocks(branchId: string): Promise<Map<string, BlockInfo>>;
    /**
     * Set a block mapping for a branch
     */
    setBlock(branchId: string, path: string, block: BlockInfo): Promise<void>;
    /**
     * Delete a block mapping for a branch
     */
    deleteBlock(branchId: string, path: string): Promise<void>;
    /**
     * Get the parent branch ID
     */
    getParentBranch(branchId: string): Promise<string | null>;
    /**
     * Set branch metadata
     */
    setBranchMeta(branchId: string, meta: {
        parentBranch: string | null;
        createdAt: number;
    }): Promise<void>;
}
/**
 * In-memory branch metadata storage for testing
 */
export declare class InMemoryBranchMetadataStorage implements BranchMetadataStorage {
    private branches;
    private blocks;
    getBlocks(branchId: string): Promise<Map<string, BlockInfo>>;
    setBlock(branchId: string, path: string, block: BlockInfo): Promise<void>;
    deleteBlock(branchId: string, path: string): Promise<void>;
    getParentBranch(branchId: string): Promise<string | null>;
    setBranchMeta(branchId: string, meta: {
        parentBranch: string | null;
        createdAt: number;
    }): Promise<void>;
    /**
     * Initialize the main branch
     */
    initMain(): void;
}
/**
 * Options for CASCOWHandler
 */
export interface CASCOWHandlerOptions {
    /** Content-addressable storage instance */
    cas: ContentAddressableFS;
    /** Branch metadata storage */
    branchStorage: BranchMetadataStorage;
    /** Current branch ID */
    currentBranch: string;
}
/**
 * CASCOWHandler - COW Handler integrated with ContentAddressableFS
 *
 * This class provides a higher-level API that directly integrates
 * COW semantics with the CAS layer. It handles:
 * - Writing content to CAS and tracking hashes
 * - Resolving parent branch content
 * - Persisting branch metadata
 *
 * @example
 * ```typescript
 * const cas = new ContentAddressableFS(storage)
 * const branchStorage = new InMemoryBranchMetadataStorage()
 *
 * const handler = new CASCOWHandler({
 *   cas,
 *   branchStorage,
 *   currentBranch: 'feature-x',
 * })
 *
 * // Write with COW semantics
 * await handler.write('/config.json', configData)
 *
 * // Get dirty paths
 * const dirty = handler.getDirtyPaths()
 *
 * // Commit changes
 * await handler.commit()
 * ```
 */
export declare class CASCOWHandler {
    private cas;
    private branchStorage;
    private cowHandler;
    private currentBranch;
    constructor(options: CASCOWHandlerOptions);
    /**
     * Initialize the handler by loading branch metadata
     */
    init(): Promise<void>;
    /**
     * Resolve a block from a parent branch
     */
    private resolveParentBlock;
    /**
     * Write content to CAS and return hash
     */
    private writeContent;
    /**
     * Read content from CAS by hash
     */
    private readContent;
    /**
     * Write data to a path with COW semantics
     */
    write(path: string, data: Uint8Array): Promise<WriteInterceptResult>;
    /**
     * Read data from a path, resolving through branch hierarchy
     */
    read(path: string): Promise<Uint8Array | null>;
    /**
     * Check if a path exists (owned or inherited)
     */
    exists(path: string): Promise<boolean>;
    /**
     * Delete a path
     */
    delete(path: string): Promise<boolean>;
    /**
     * Get list of dirty paths
     */
    getDirtyPaths(): string[];
    /**
     * Get detailed dirty path info
     */
    getDirtyPathsInfo(): DirtyPathInfo[];
    /**
     * Check if there are uncommitted changes
     */
    isDirty(): boolean;
    /**
     * Commit changes and persist to branch storage
     */
    commit(): Promise<CommitResult>;
    /**
     * Discard all uncommitted changes
     */
    discardAll(): number;
    /**
     * Get the current branch ID
     */
    getCurrentBranch(): string;
    /**
     * Get the underlying COW handler for advanced operations
     */
    getHandler(): COWHandler;
}
//# sourceMappingURL=cow-handler.d.ts.map
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

// Note: CASStorage type is re-imported below for the CAS-integrated handler

/**
 * Metadata about a block in the branch
 */
export interface BlockInfo {
  /** Content hash (SHA-1 or SHA-256) */
  hash: string
  /** Size in bytes */
  size: number
  /** Whether this block exists in the current branch vs inherited from parent */
  isOwned: boolean
  /** Timestamp of last modification (if owned) */
  modifiedAt?: number
}

/**
 * Branch state tracking
 */
export interface BranchState {
  /** Branch identifier */
  branchId: string
  /** Parent branch (null for root/main) */
  parentBranch: string | null
  /** Map of path -> block info for this branch's overrides */
  blocks: Map<string, BlockInfo>
  /** Tree hash representing the current state */
  treeHash?: string
  /** Creation timestamp */
  createdAt: number
  /** Last modification timestamp */
  modifiedAt: number
}

/**
 * Result of an intercepted write operation
 */
export interface WriteInterceptResult {
  /** Content hash of the written data */
  hash: string
  /** Number of bytes written */
  bytesWritten: number
  /** Whether this write involved copying from a parent branch */
  copiedFromParent: boolean
  /** The path that was written */
  path: string
  /** Previous hash (if overwriting existing content) */
  previousHash?: string
}

/**
 * Options for COWHandler initialization
 */
export interface COWHandlerOptions {
  /** Current branch ID */
  currentBranch: string
  /** Parent branch ID (null for root branches like main) */
  parentBranch: string | null
  /**
   * Resolver to check if a path exists in a parent branch and get its hash
   * This is called when a write targets a path not yet in the current branch
   */
  resolveParentBlock: (path: string, branchId: string) => Promise<BlockInfo | null>
  /**
   * Writer function to persist content to storage
   * Returns the content hash
   */
  writeContent: (path: string, data: Uint8Array) => Promise<string>
  /**
   * Reader function to get content from storage by hash
   */
  readContent?: (hash: string) => Promise<Uint8Array | null>
  /**
   * Initial branch state (if resuming from persisted state)
   */
  initialState?: BranchState
}

/**
 * Commit result containing summary of changes
 */
export interface CommitResult {
  /** Branch that was committed */
  branchId: string
  /** Number of paths that were committed */
  pathCount: number
  /** List of paths that were committed */
  paths: string[]
  /** Total bytes in committed content */
  totalBytes: number
  /** Timestamp of commit */
  committedAt: number
  /** New tree hash after commit */
  treeHash?: string
}

/**
 * Information about a dirty path
 */
export interface DirtyPathInfo {
  /** The path */
  path: string
  /** Block info for this path */
  block: BlockInfo
  /** Whether this is a new file (vs modification of existing) */
  isNew: boolean
  /** Previous hash (if modification) */
  previousHash?: string
}

/**
 * COWHandler - Copy-on-Write Handler
 *
 * Manages copy-on-write semantics for a branch-based filesystem.
 * Tracks modifications, ensures parent data is preserved, and
 * provides commit functionality.
 */
export class COWHandler {
  private currentBranch: string
  private parentBranch: string | null
  private resolveParentBlock: (path: string, branchId: string) => Promise<BlockInfo | null>
  private writeContent: (path: string, data: Uint8Array) => Promise<string>
  private _readContent?: (hash: string) => Promise<Uint8Array | null>

  /** Map of path -> block info for current branch's owned blocks */
  private ownedBlocks: Map<string, BlockInfo> = new Map()

  /** Set of paths that have been modified but not committed */
  private dirtyPaths: Set<string> = new Set()

  /** Map tracking previous hashes for modified paths (for diffing) */
  private previousHashes: Map<string, string> = new Map()

  /** Timestamp of handler creation */
  private createdAt: number

  /** Timestamp of last modification */
  private modifiedAt: number

  /** Whether the handler has uncommitted changes */
  private _isDirty: boolean = false

  constructor(options: COWHandlerOptions) {
    this.currentBranch = options.currentBranch
    this.parentBranch = options.parentBranch
    this.resolveParentBlock = options.resolveParentBlock
    this.writeContent = options.writeContent
    this._readContent = options.readContent

    this.createdAt = Date.now()
    this.modifiedAt = this.createdAt

    // Restore from initial state if provided
    if (options.initialState) {
      this.restoreState(options.initialState)
    }
  }

  /**
   * Get the current branch ID
   */
  getCurrentBranch(): string {
    return this.currentBranch
  }

  /**
   * Get the parent branch ID
   */
  getParentBranch(): string | null {
    return this.parentBranch
  }

  /**
   * Check if the handler has uncommitted changes
   */
  isDirty(): boolean {
    return this._isDirty
  }

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
  async interceptWrite(path: string, data: Uint8Array): Promise<WriteInterceptResult> {
    const normalizedPath = this.normalizePath(path)

    // Check if this path is already owned by current branch
    const existingBlock = this.ownedBlocks.get(normalizedPath)
    let copiedFromParent = false
    let previousHash: string | undefined

    if (existingBlock) {
      // Already owned - just update
      previousHash = existingBlock.hash
    } else if (this.parentBranch) {
      // Not owned - check if it exists in parent (inherited)
      const parentBlock = await this.resolveParentBlock(normalizedPath, this.parentBranch)

      if (parentBlock) {
        // Path exists in parent - this is a COW operation
        copiedFromParent = true
        previousHash = parentBlock.hash
        this.previousHashes.set(normalizedPath, parentBlock.hash)
      }
    }

    // Write the new content
    const hash = await this.writeContent(normalizedPath, data)

    // Create block info for this branch's owned copy
    const blockInfo: BlockInfo = {
      hash,
      size: data.length,
      isOwned: true,
      modifiedAt: Date.now(),
    }

    // Track the block as owned by this branch
    this.ownedBlocks.set(normalizedPath, blockInfo)

    // Mark as dirty (uncommitted)
    this.dirtyPaths.add(normalizedPath)
    this._isDirty = true
    this.modifiedAt = Date.now()

    return {
      hash,
      bytesWritten: data.length,
      copiedFromParent,
      path: normalizedPath,
      previousHash,
    }
  }

  /**
   * Read content for a path by resolving block info and using readContent
   *
   * @param path - The path to read
   * @returns Content data if exists and readContent is configured, null otherwise
   */
  async readBlockContent(path: string): Promise<Uint8Array | null> {
    if (!this._readContent) {
      return null
    }

    const blockInfo = await this.getBlockInfo(path)
    if (!blockInfo || blockInfo.hash === '') {
      return null
    }

    return this._readContent(blockInfo.hash)
  }

  /**
   * Check if a path exists in the current branch (owned or inherited)
   *
   * @param path - The path to check
   * @returns Block info if exists, null otherwise
   */
  async getBlockInfo(path: string): Promise<BlockInfo | null> {
    const normalizedPath = this.normalizePath(path)

    // Check owned blocks first
    const owned = this.ownedBlocks.get(normalizedPath)
    if (owned) {
      return owned
    }

    // Check parent branch if we have one
    if (this.parentBranch) {
      const parentBlock = await this.resolveParentBlock(normalizedPath, this.parentBranch)
      if (parentBlock) {
        // Return as non-owned (inherited)
        return {
          ...parentBlock,
          isOwned: false,
        }
      }
    }

    return null
  }

  /**
   * Check if a path is owned by the current branch (not inherited)
   *
   * @param path - The path to check
   * @returns true if path has been written in this branch
   */
  isOwned(path: string): boolean {
    return this.ownedBlocks.has(this.normalizePath(path))
  }

  /**
   * Check if a path has uncommitted changes
   *
   * @param path - The path to check
   * @returns true if path has been modified but not committed
   */
  isPathDirty(path: string): boolean {
    return this.dirtyPaths.has(this.normalizePath(path))
  }

  /**
   * Get list of paths with uncommitted changes
   *
   * @returns Array of dirty paths
   */
  getDirtyPaths(): string[] {
    return Array.from(this.dirtyPaths)
  }

  /**
   * Get detailed info about all dirty paths
   *
   * @returns Array of dirty path info including whether it's new or modified
   */
  getDirtyPathsInfo(): DirtyPathInfo[] {
    const result: DirtyPathInfo[] = []

    for (const path of this.dirtyPaths) {
      const block = this.ownedBlocks.get(path)
      if (block) {
        const previousHash = this.previousHashes.get(path)
        result.push({
          path,
          block,
          isNew: previousHash === undefined,
          previousHash,
        })
      }
    }

    return result
  }

  /**
   * Get count of dirty paths
   *
   * @returns Number of uncommitted changes
   */
  getDirtyCount(): number {
    return this.dirtyPaths.size
  }

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
  async commit(): Promise<CommitResult> {
    const paths = Array.from(this.dirtyPaths)
    let totalBytes = 0

    for (const path of paths) {
      const block = this.ownedBlocks.get(path)
      if (block) {
        totalBytes += block.size
      }
    }

    const committedAt = Date.now()

    // Clear dirty state
    this.dirtyPaths.clear()
    this.previousHashes.clear()
    this._isDirty = false
    this.modifiedAt = committedAt

    return {
      branchId: this.currentBranch,
      pathCount: paths.length,
      paths,
      totalBytes,
      committedAt,
    }
  }

  /**
   * Discard uncommitted changes for a specific path
   *
   * @param path - The path to discard changes for
   * @returns true if changes were discarded, false if path wasn't dirty
   */
  discardPath(path: string): boolean {
    const normalizedPath = this.normalizePath(path)

    if (!this.dirtyPaths.has(normalizedPath)) {
      return false
    }

    // Remove from dirty tracking
    this.dirtyPaths.delete(normalizedPath)

    // If we have a previous hash, we need to restore the parent's block
    // For now, we just remove our owned version
    const previousHash = this.previousHashes.get(normalizedPath)
    if (previousHash) {
      // Had a parent version - remove our override
      this.ownedBlocks.delete(normalizedPath)
      this.previousHashes.delete(normalizedPath)
    } else {
      // Was a new file - remove completely
      this.ownedBlocks.delete(normalizedPath)
    }

    // Update dirty flag
    this._isDirty = this.dirtyPaths.size > 0

    return true
  }

  /**
   * Discard all uncommitted changes
   *
   * @returns Number of paths that were discarded
   */
  discardAll(): number {
    const count = this.dirtyPaths.size

    // Remove all owned blocks that were dirty
    for (const path of this.dirtyPaths) {
      const previousHash = this.previousHashes.get(path)
      if (!previousHash) {
        // New file - remove completely
        this.ownedBlocks.delete(path)
      } else {
        // Modified file - remove our override
        this.ownedBlocks.delete(path)
      }
    }

    // Clear tracking
    this.dirtyPaths.clear()
    this.previousHashes.clear()
    this._isDirty = false

    return count
  }

  /**
   * Mark a path as deleted in this branch
   *
   * This creates a tombstone marker so the path appears deleted
   * even though it may exist in a parent branch.
   *
   * @param path - The path to mark as deleted
   * @returns true if path was marked deleted, false if it didn't exist
   */
  async markDeleted(path: string): Promise<boolean> {
    const normalizedPath = this.normalizePath(path)

    // Check if the path exists (owned or inherited)
    const blockInfo = await this.getBlockInfo(normalizedPath)
    if (!blockInfo) {
      return false
    }

    // Track the previous hash if it existed
    if (blockInfo.hash) {
      this.previousHashes.set(normalizedPath, blockInfo.hash)
    }

    // Create a tombstone marker (empty block with special flag)
    const tombstone: BlockInfo = {
      hash: '', // Empty hash indicates tombstone
      size: 0,
      isOwned: true,
      modifiedAt: Date.now(),
    }

    this.ownedBlocks.set(normalizedPath, tombstone)
    this.dirtyPaths.add(normalizedPath)
    this._isDirty = true
    this.modifiedAt = Date.now()

    return true
  }

  /**
   * Check if a path is marked as deleted (tombstoned)
   *
   * @param path - The path to check
   * @returns true if path is explicitly deleted in this branch
   */
  isDeleted(path: string): boolean {
    const normalizedPath = this.normalizePath(path)
    const block = this.ownedBlocks.get(normalizedPath)
    return block !== undefined && block.hash === ''
  }

  /**
   * Get all owned blocks (written in this branch)
   *
   * @returns Map of path to block info
   */
  getOwnedBlocks(): Map<string, BlockInfo> {
    return new Map(this.ownedBlocks)
  }

  /**
   * Get the current branch state for persistence
   *
   * @returns Branch state that can be serialized
   */
  getState(): BranchState {
    return {
      branchId: this.currentBranch,
      parentBranch: this.parentBranch,
      blocks: new Map(this.ownedBlocks),
      createdAt: this.createdAt,
      modifiedAt: this.modifiedAt,
    }
  }

  /**
   * Restore state from a persisted branch state
   *
   * @param state - Previously saved branch state
   */
  private restoreState(state: BranchState): void {
    this.ownedBlocks = new Map(state.blocks)
    this.createdAt = state.createdAt
    this.modifiedAt = state.modifiedAt
    // Note: dirty paths are cleared on restore since commit clears them
  }

  /**
   * Set an owned block (for restoring from persisted state)
   * This does NOT mark the path as dirty.
   *
   * @param path - The path to set
   * @param block - The block info
   */
  setOwnedBlock(path: string, block: BlockInfo): void {
    const normalizedPath = this.normalizePath(path)
    this.ownedBlocks.set(normalizedPath, { ...block, isOwned: true })
  }

  /**
   * Normalize a path to ensure consistent format
   */
  private normalizePath(path: string): string {
    if (!path) {
      throw new Error('Path cannot be empty')
    }

    // Ensure path starts with /
    let normalized = path.startsWith('/') ? path : '/' + path

    // Remove duplicate slashes
    normalized = normalized.replace(/\/+/g, '/')

    // Remove trailing slash (except for root)
    if (normalized !== '/' && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1)
    }

    return normalized
  }
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
export function createCOWHandler(options: COWHandlerOptions): COWHandler {
  return new COWHandler(options)
}

// =============================================================================
// CAS-Integrated COW Handler
// =============================================================================

import { ContentAddressableFS } from './cas/content-addressable-fs.js'

/**
 * Branch metadata storage interface
 * Responsible for persisting branch state (path -> hash mappings)
 */
export interface BranchMetadataStorage {
  /**
   * Get all block mappings for a branch
   */
  getBlocks(branchId: string): Promise<Map<string, BlockInfo>>

  /**
   * Set a block mapping for a branch
   */
  setBlock(branchId: string, path: string, block: BlockInfo): Promise<void>

  /**
   * Delete a block mapping for a branch
   */
  deleteBlock(branchId: string, path: string): Promise<void>

  /**
   * Get the parent branch ID
   */
  getParentBranch(branchId: string): Promise<string | null>

  /**
   * Set branch metadata
   */
  setBranchMeta(branchId: string, meta: { parentBranch: string | null; createdAt: number }): Promise<void>
}

/**
 * In-memory branch metadata storage for testing
 */
export class InMemoryBranchMetadataStorage implements BranchMetadataStorage {
  private branches: Map<string, { parentBranch: string | null; createdAt: number }> = new Map()
  private blocks: Map<string, Map<string, BlockInfo>> = new Map()

  async getBlocks(branchId: string): Promise<Map<string, BlockInfo>> {
    return new Map(this.blocks.get(branchId) || new Map())
  }

  async setBlock(branchId: string, path: string, block: BlockInfo): Promise<void> {
    if (!this.blocks.has(branchId)) {
      this.blocks.set(branchId, new Map())
    }
    this.blocks.get(branchId)!.set(path, block)
  }

  async deleteBlock(branchId: string, path: string): Promise<void> {
    this.blocks.get(branchId)?.delete(path)
  }

  async getParentBranch(branchId: string): Promise<string | null> {
    return this.branches.get(branchId)?.parentBranch ?? null
  }

  async setBranchMeta(branchId: string, meta: { parentBranch: string | null; createdAt: number }): Promise<void> {
    this.branches.set(branchId, meta)
  }

  /**
   * Initialize the main branch
   */
  initMain(): void {
    this.branches.set('main', { parentBranch: null, createdAt: Date.now() })
    this.blocks.set('main', new Map())
  }
}

/**
 * Options for CASCOWHandler
 */
export interface CASCOWHandlerOptions {
  /** Content-addressable storage instance */
  cas: ContentAddressableFS
  /** Branch metadata storage */
  branchStorage: BranchMetadataStorage
  /** Current branch ID */
  currentBranch: string
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
export class CASCOWHandler {
  private cas: ContentAddressableFS
  private branchStorage: BranchMetadataStorage
  private cowHandler: COWHandler
  private currentBranch: string

  constructor(options: CASCOWHandlerOptions) {
    this.cas = options.cas
    this.branchStorage = options.branchStorage
    this.currentBranch = options.currentBranch

    // Create the underlying COW handler
    this.cowHandler = new COWHandler({
      currentBranch: options.currentBranch,
      parentBranch: null, // Will be resolved lazily
      resolveParentBlock: this.resolveParentBlock.bind(this),
      writeContent: this.writeContent.bind(this),
      readContent: this.readContent.bind(this),
    })
  }

  /**
   * Initialize the handler by loading branch metadata
   */
  async init(): Promise<void> {
    const parentBranch = await this.branchStorage.getParentBranch(this.currentBranch)

    // Recreate handler with correct parent
    this.cowHandler = new COWHandler({
      currentBranch: this.currentBranch,
      parentBranch,
      resolveParentBlock: this.resolveParentBlock.bind(this),
      writeContent: this.writeContent.bind(this),
      readContent: this.readContent.bind(this),
    })

    // Load existing blocks for this branch
    const blocks = await this.branchStorage.getBlocks(this.currentBranch)
    for (const [path, block] of blocks) {
      // These are already committed, not dirty
      this.cowHandler.setOwnedBlock(path, block)
    }
  }

  /**
   * Resolve a block from a parent branch
   */
  private async resolveParentBlock(path: string, branchId: string): Promise<BlockInfo | null> {
    // Get the block from the specified branch
    const blocks = await this.branchStorage.getBlocks(branchId)
    const block = blocks.get(path)

    if (block) {
      return block
    }

    // If not found, check the branch's parent recursively
    const parentBranch = await this.branchStorage.getParentBranch(branchId)
    if (parentBranch) {
      return this.resolveParentBlock(path, parentBranch)
    }

    return null
  }

  /**
   * Write content to CAS and return hash
   */
  private async writeContent(_path: string, data: Uint8Array): Promise<string> {
    return this.cas.putObject(data, 'blob')
  }

  /**
   * Read content from CAS by hash
   */
  private async readContent(hash: string): Promise<Uint8Array | null> {
    const obj = await this.cas.getObject(hash)
    return obj?.data ?? null
  }

  /**
   * Write data to a path with COW semantics
   */
  async write(path: string, data: Uint8Array): Promise<WriteInterceptResult> {
    const result = await this.cowHandler.interceptWrite(path, data)
    return result
  }

  /**
   * Read data from a path, resolving through branch hierarchy
   */
  async read(path: string): Promise<Uint8Array | null> {
    const blockInfo = await this.cowHandler.getBlockInfo(path)
    if (!blockInfo || blockInfo.hash === '') {
      return null
    }

    return this.readContent(blockInfo.hash)
  }

  /**
   * Check if a path exists (owned or inherited)
   */
  async exists(path: string): Promise<boolean> {
    const blockInfo = await this.cowHandler.getBlockInfo(path)
    return blockInfo !== null && blockInfo.hash !== ''
  }

  /**
   * Delete a path
   */
  async delete(path: string): Promise<boolean> {
    return this.cowHandler.markDeleted(path)
  }

  /**
   * Get list of dirty paths
   */
  getDirtyPaths(): string[] {
    return this.cowHandler.getDirtyPaths()
  }

  /**
   * Get detailed dirty path info
   */
  getDirtyPathsInfo(): DirtyPathInfo[] {
    return this.cowHandler.getDirtyPathsInfo()
  }

  /**
   * Check if there are uncommitted changes
   */
  isDirty(): boolean {
    return this.cowHandler.isDirty()
  }

  /**
   * Commit changes and persist to branch storage
   */
  async commit(): Promise<CommitResult> {
    // Get dirty paths before clearing
    const dirtyInfo = this.cowHandler.getDirtyPathsInfo()

    // Persist all dirty blocks to branch storage
    for (const info of dirtyInfo) {
      await this.branchStorage.setBlock(this.currentBranch, info.path, info.block)
    }

    // Call underlying commit
    return this.cowHandler.commit()
  }

  /**
   * Discard all uncommitted changes
   */
  discardAll(): number {
    return this.cowHandler.discardAll()
  }

  /**
   * Get the current branch ID
   */
  getCurrentBranch(): string {
    return this.currentBranch
  }

  /**
   * Get the underlying COW handler for advanced operations
   */
  getHandler(): COWHandler {
    return this.cowHandler
  }
}

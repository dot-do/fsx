/**
 * COWHandler Tests
 *
 * Tests for copy-on-write semantics in the branch-based filesystem.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  COWHandler,
  createCOWHandler,
  CASCOWHandler,
  InMemoryBranchMetadataStorage,
  type BlockInfo,
  type COWHandlerOptions,
} from './cow-handler.js'
import { ContentAddressableFS, type CASStorage } from './cas/content-addressable-fs.js'

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * In-memory CAS storage for testing
 */
class InMemoryCASStorage implements CASStorage {
  private storage = new Map<string, Uint8Array>()

  async write(path: string, data: Uint8Array): Promise<void> {
    this.storage.set(path, new Uint8Array(data))
  }

  async get(path: string): Promise<{ data: Uint8Array } | null> {
    const data = this.storage.get(path)
    return data ? { data } : null
  }

  async exists(path: string): Promise<boolean> {
    return this.storage.has(path)
  }

  async delete(path: string): Promise<void> {
    this.storage.delete(path)
  }
}

/**
 * Simple content hasher for testing (not cryptographically secure)
 */
function simpleHash(data: Uint8Array): string {
  let hash = 0
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data[i]!) | 0
  }
  // Convert to hex and pad to 40 chars (SHA-1 length)
  const hex = Math.abs(hash).toString(16)
  return hex.padStart(40, '0')
}

/**
 * Create a mock COW handler for testing
 */
function createMockCOWHandler(options: {
  currentBranch?: string
  parentBranch?: string | null
  parentBlocks?: Map<string, BlockInfo>
}): {
  handler: COWHandler
  writtenContent: Map<string, Uint8Array>
  writtenHashes: Map<string, string>
} {
  const parentBlocks = options.parentBlocks || new Map()
  const writtenContent = new Map<string, Uint8Array>()
  const writtenHashes = new Map<string, string>()

  const handler = createCOWHandler({
    currentBranch: options.currentBranch || 'feature-branch',
    parentBranch: options.parentBranch ?? 'main',
    resolveParentBlock: async (path, _branchId) => {
      return parentBlocks.get(path) || null
    },
    writeContent: async (path, data) => {
      const hash = simpleHash(data)
      writtenContent.set(path, new Uint8Array(data))
      writtenHashes.set(path, hash)
      return hash
    },
    readContent: async (hash) => {
      for (const [path, h] of writtenHashes) {
        if (h === hash) {
          return writtenContent.get(path) || null
        }
      }
      return null
    },
  })

  return { handler, writtenContent, writtenHashes }
}

// =============================================================================
// COWHandler Basic Tests
// =============================================================================

describe('COWHandler', () => {
  describe('constructor and basic properties', () => {
    it('should create handler with correct branch IDs', () => {
      const { handler } = createMockCOWHandler({
        currentBranch: 'feature-x',
        parentBranch: 'main',
      })

      expect(handler.getCurrentBranch()).toBe('feature-x')
      expect(handler.getParentBranch()).toBe('main')
    })

    it('should allow null parent branch for root branches', () => {
      // Create handler directly to avoid mock's default parent
      const handler = createCOWHandler({
        currentBranch: 'main',
        parentBranch: null,
        resolveParentBlock: async () => null,
        writeContent: async (_path, data) => simpleHash(data),
      })

      expect(handler.getCurrentBranch()).toBe('main')
      expect(handler.getParentBranch()).toBeNull()
    })

    it('should start with no dirty paths', () => {
      const { handler } = createMockCOWHandler({})

      expect(handler.isDirty()).toBe(false)
      expect(handler.getDirtyPaths()).toEqual([])
      expect(handler.getDirtyCount()).toBe(0)
    })
  })

  describe('interceptWrite - new files', () => {
    it('should write new file and track as dirty', async () => {
      const { handler, writtenContent } = createMockCOWHandler({})
      const data = new TextEncoder().encode('hello world')

      const result = await handler.interceptWrite('/test.txt', data)

      expect(result.bytesWritten).toBe(data.length)
      expect(result.copiedFromParent).toBe(false)
      expect(result.path).toBe('/test.txt')
      expect(result.previousHash).toBeUndefined()
      expect(writtenContent.has('/test.txt')).toBe(true)
      expect(handler.isDirty()).toBe(true)
      expect(handler.getDirtyPaths()).toContain('/test.txt')
    })

    it('should normalize paths', async () => {
      const { handler } = createMockCOWHandler({})
      const data = new TextEncoder().encode('test')

      // Without leading slash
      await handler.interceptWrite('test.txt', data)
      expect(handler.getDirtyPaths()).toContain('/test.txt')

      // With trailing slash
      await handler.interceptWrite('/dir/', data)
      expect(handler.getDirtyPaths()).toContain('/dir')

      // With double slashes
      await handler.interceptWrite('//path//to//file.txt', data)
      expect(handler.getDirtyPaths()).toContain('/path/to/file.txt')
    })

    it('should throw on empty path', async () => {
      const { handler } = createMockCOWHandler({})
      const data = new TextEncoder().encode('test')

      await expect(handler.interceptWrite('', data)).rejects.toThrow('Path cannot be empty')
    })
  })

  describe('interceptWrite - copy-on-write', () => {
    it('should detect inherited block and mark as copied from parent', async () => {
      const parentBlocks = new Map<string, BlockInfo>([
        ['/config.json', { hash: 'parent-hash-123', size: 100, isOwned: true }],
      ])

      const { handler } = createMockCOWHandler({ parentBlocks })
      const data = new TextEncoder().encode('new config content')

      const result = await handler.interceptWrite('/config.json', data)

      expect(result.copiedFromParent).toBe(true)
      expect(result.previousHash).toBe('parent-hash-123')
    })

    it('should not report copy on subsequent writes to owned path', async () => {
      const parentBlocks = new Map<string, BlockInfo>([
        ['/config.json', { hash: 'parent-hash-123', size: 100, isOwned: true }],
      ])

      const { handler } = createMockCOWHandler({ parentBlocks })
      const data1 = new TextEncoder().encode('first write')
      const data2 = new TextEncoder().encode('second write')

      const result1 = await handler.interceptWrite('/config.json', data1)
      const result2 = await handler.interceptWrite('/config.json', data2)

      expect(result1.copiedFromParent).toBe(true)
      expect(result2.copiedFromParent).toBe(false)
      expect(result2.previousHash).toBe(result1.hash)
    })

    it('should handle write to non-existent path in parent', async () => {
      const parentBlocks = new Map<string, BlockInfo>([
        ['/existing.txt', { hash: 'exists', size: 50, isOwned: true }],
      ])

      const { handler } = createMockCOWHandler({ parentBlocks })
      const data = new TextEncoder().encode('new file')

      const result = await handler.interceptWrite('/new-file.txt', data)

      expect(result.copiedFromParent).toBe(false)
      expect(result.previousHash).toBeUndefined()
    })
  })

  describe('getBlockInfo', () => {
    it('should return owned block info', async () => {
      const { handler } = createMockCOWHandler({})
      const data = new TextEncoder().encode('test content')

      await handler.interceptWrite('/test.txt', data)
      const info = await handler.getBlockInfo('/test.txt')

      expect(info).not.toBeNull()
      expect(info!.isOwned).toBe(true)
      expect(info!.size).toBe(data.length)
    })

    it('should return inherited block info with isOwned=false', async () => {
      const parentBlocks = new Map<string, BlockInfo>([
        ['/parent-file.txt', { hash: 'parent-hash', size: 42, isOwned: true }],
      ])

      const { handler } = createMockCOWHandler({ parentBlocks })
      const info = await handler.getBlockInfo('/parent-file.txt')

      expect(info).not.toBeNull()
      expect(info!.isOwned).toBe(false)
      expect(info!.hash).toBe('parent-hash')
      expect(info!.size).toBe(42)
    })

    it('should return null for non-existent path', async () => {
      const { handler } = createMockCOWHandler({})
      const info = await handler.getBlockInfo('/does-not-exist.txt')

      expect(info).toBeNull()
    })
  })

  describe('isOwned', () => {
    it('should return true for written paths', async () => {
      const { handler } = createMockCOWHandler({})
      const data = new TextEncoder().encode('test')

      await handler.interceptWrite('/test.txt', data)

      expect(handler.isOwned('/test.txt')).toBe(true)
      expect(handler.isOwned('/other.txt')).toBe(false)
    })
  })

  describe('getDirtyPaths and getDirtyPathsInfo', () => {
    it('should return all dirty paths', async () => {
      const { handler } = createMockCOWHandler({})
      const data = new TextEncoder().encode('test')

      await handler.interceptWrite('/a.txt', data)
      await handler.interceptWrite('/b.txt', data)
      await handler.interceptWrite('/c.txt', data)

      const paths = handler.getDirtyPaths()
      expect(paths).toHaveLength(3)
      expect(paths).toContain('/a.txt')
      expect(paths).toContain('/b.txt')
      expect(paths).toContain('/c.txt')
    })

    it('should return detailed info for dirty paths', async () => {
      const parentBlocks = new Map<string, BlockInfo>([
        ['/existing.txt', { hash: 'old-hash', size: 10, isOwned: true }],
      ])

      const { handler } = createMockCOWHandler({ parentBlocks })
      const data = new TextEncoder().encode('test content')

      await handler.interceptWrite('/new.txt', data)
      await handler.interceptWrite('/existing.txt', data)

      const info = handler.getDirtyPathsInfo()
      expect(info).toHaveLength(2)

      const newFile = info.find((i) => i.path === '/new.txt')
      const modifiedFile = info.find((i) => i.path === '/existing.txt')

      expect(newFile?.isNew).toBe(true)
      expect(newFile?.previousHash).toBeUndefined()

      expect(modifiedFile?.isNew).toBe(false)
      expect(modifiedFile?.previousHash).toBe('old-hash')
    })
  })

  describe('commit', () => {
    it('should clear dirty state on commit', async () => {
      const { handler } = createMockCOWHandler({})
      const data = new TextEncoder().encode('test')

      await handler.interceptWrite('/test.txt', data)
      expect(handler.isDirty()).toBe(true)

      const result = await handler.commit()

      expect(handler.isDirty()).toBe(false)
      expect(handler.getDirtyPaths()).toHaveLength(0)
      expect(result.pathCount).toBe(1)
      expect(result.paths).toContain('/test.txt')
    })

    it('should return correct commit statistics', async () => {
      const { handler } = createMockCOWHandler({ currentBranch: 'feature-x' })
      const data1 = new TextEncoder().encode('content one')
      const data2 = new TextEncoder().encode('longer content two')

      await handler.interceptWrite('/a.txt', data1)
      await handler.interceptWrite('/b.txt', data2)

      const result = await handler.commit()

      expect(result.branchId).toBe('feature-x')
      expect(result.pathCount).toBe(2)
      expect(result.totalBytes).toBe(data1.length + data2.length)
      expect(result.committedAt).toBeGreaterThan(0)
    })

    it('should preserve owned blocks after commit', async () => {
      const { handler } = createMockCOWHandler({})
      const data = new TextEncoder().encode('test')

      await handler.interceptWrite('/test.txt', data)
      await handler.commit()

      expect(handler.isOwned('/test.txt')).toBe(true)
      const info = await handler.getBlockInfo('/test.txt')
      expect(info).not.toBeNull()
    })
  })

  describe('discardPath', () => {
    it('should discard changes for a specific path', async () => {
      const { handler } = createMockCOWHandler({})
      const data = new TextEncoder().encode('test')

      await handler.interceptWrite('/keep.txt', data)
      await handler.interceptWrite('/discard.txt', data)

      const discarded = handler.discardPath('/discard.txt')

      expect(discarded).toBe(true)
      expect(handler.getDirtyPaths()).toContain('/keep.txt')
      expect(handler.getDirtyPaths()).not.toContain('/discard.txt')
      expect(handler.isOwned('/discard.txt')).toBe(false)
    })

    it('should return false for non-dirty path', () => {
      const { handler } = createMockCOWHandler({})

      const discarded = handler.discardPath('/not-dirty.txt')

      expect(discarded).toBe(false)
    })
  })

  describe('discardAll', () => {
    it('should discard all dirty changes', async () => {
      const { handler } = createMockCOWHandler({})
      const data = new TextEncoder().encode('test')

      await handler.interceptWrite('/a.txt', data)
      await handler.interceptWrite('/b.txt', data)
      await handler.interceptWrite('/c.txt', data)

      const count = handler.discardAll()

      expect(count).toBe(3)
      expect(handler.isDirty()).toBe(false)
      expect(handler.getDirtyPaths()).toHaveLength(0)
    })
  })

  describe('markDeleted and isDeleted', () => {
    it('should mark existing file as deleted', async () => {
      const parentBlocks = new Map<string, BlockInfo>([
        ['/to-delete.txt', { hash: 'some-hash', size: 100, isOwned: true }],
      ])

      const { handler } = createMockCOWHandler({ parentBlocks })

      const deleted = await handler.markDeleted('/to-delete.txt')

      expect(deleted).toBe(true)
      expect(handler.isDeleted('/to-delete.txt')).toBe(true)
      expect(handler.isDirty()).toBe(true)
    })

    it('should return false for non-existent file', async () => {
      const { handler } = createMockCOWHandler({})

      const deleted = await handler.markDeleted('/does-not-exist.txt')

      expect(deleted).toBe(false)
    })

    it('should allow marking owned file as deleted', async () => {
      const { handler } = createMockCOWHandler({})
      const data = new TextEncoder().encode('test')

      await handler.interceptWrite('/test.txt', data)
      const deleted = await handler.markDeleted('/test.txt')

      expect(deleted).toBe(true)
      expect(handler.isDeleted('/test.txt')).toBe(true)
    })
  })

  describe('getState', () => {
    it('should return serializable state', async () => {
      const { handler } = createMockCOWHandler({
        currentBranch: 'feature-x',
        parentBranch: 'main',
      })
      const data = new TextEncoder().encode('test')

      await handler.interceptWrite('/test.txt', data)
      const state = handler.getState()

      expect(state.branchId).toBe('feature-x')
      expect(state.parentBranch).toBe('main')
      expect(state.blocks.size).toBe(1)
      expect(state.blocks.has('/test.txt')).toBe(true)
      expect(state.createdAt).toBeGreaterThan(0)
      expect(state.modifiedAt).toBeGreaterThan(0)
    })
  })
})

// =============================================================================
// CASCOWHandler Tests
// =============================================================================

describe('CASCOWHandler', () => {
  let casStorage: InMemoryCASStorage
  let cas: ContentAddressableFS
  let branchStorage: InMemoryBranchMetadataStorage

  beforeEach(() => {
    casStorage = new InMemoryCASStorage()
    cas = new ContentAddressableFS(casStorage)
    branchStorage = new InMemoryBranchMetadataStorage()
    branchStorage.initMain()
  })

  describe('basic operations', () => {
    it('should write and read content', async () => {
      const handler = new CASCOWHandler({
        cas,
        branchStorage,
        currentBranch: 'main',
      })
      await handler.init()

      const data = new TextEncoder().encode('hello world')
      await handler.write('/test.txt', data)

      const readData = await handler.read('/test.txt')
      expect(readData).not.toBeNull()
      expect(new TextDecoder().decode(readData!)).toBe('hello world')
    })

    it('should check existence', async () => {
      const handler = new CASCOWHandler({
        cas,
        branchStorage,
        currentBranch: 'main',
      })
      await handler.init()

      expect(await handler.exists('/test.txt')).toBe(false)

      await handler.write('/test.txt', new TextEncoder().encode('test'))

      expect(await handler.exists('/test.txt')).toBe(true)
    })

    it('should track dirty paths', async () => {
      const handler = new CASCOWHandler({
        cas,
        branchStorage,
        currentBranch: 'main',
      })
      await handler.init()

      expect(handler.isDirty()).toBe(false)

      await handler.write('/test.txt', new TextEncoder().encode('test'))

      expect(handler.isDirty()).toBe(true)
      expect(handler.getDirtyPaths()).toContain('/test.txt')
    })

    it('should commit and persist to branch storage', async () => {
      const handler = new CASCOWHandler({
        cas,
        branchStorage,
        currentBranch: 'main',
      })
      await handler.init()

      await handler.write('/test.txt', new TextEncoder().encode('test content'))
      await handler.commit()

      // Verify persisted to branch storage
      const blocks = await branchStorage.getBlocks('main')
      expect(blocks.has('/test.txt')).toBe(true)
    })
  })

  describe('delete operations', () => {
    it('should delete existing file', async () => {
      const handler = new CASCOWHandler({
        cas,
        branchStorage,
        currentBranch: 'main',
      })
      await handler.init()

      await handler.write('/test.txt', new TextEncoder().encode('test'))
      expect(await handler.exists('/test.txt')).toBe(true)

      await handler.delete('/test.txt')
      expect(await handler.exists('/test.txt')).toBe(false)
    })
  })

  describe('discard operations', () => {
    it('should discard all uncommitted changes', async () => {
      const handler = new CASCOWHandler({
        cas,
        branchStorage,
        currentBranch: 'main',
      })
      await handler.init()

      await handler.write('/a.txt', new TextEncoder().encode('a'))
      await handler.write('/b.txt', new TextEncoder().encode('b'))

      const count = handler.discardAll()

      expect(count).toBe(2)
      expect(handler.isDirty()).toBe(false)
    })
  })

  describe('branch inheritance', () => {
    it('should resolve content from parent branch', async () => {
      // Setup main branch with content
      const mainHandler = new CASCOWHandler({
        cas,
        branchStorage,
        currentBranch: 'main',
      })
      await mainHandler.init()

      await mainHandler.write('/config.json', new TextEncoder().encode('{"version": 1}'))
      await mainHandler.commit()

      // Create feature branch
      await branchStorage.setBranchMeta('feature-x', {
        parentBranch: 'main',
        createdAt: Date.now(),
      })

      const featureHandler = new CASCOWHandler({
        cas,
        branchStorage,
        currentBranch: 'feature-x',
      })
      await featureHandler.init()

      // Feature branch should see parent's content
      const content = await featureHandler.read('/config.json')
      expect(content).not.toBeNull()
      expect(new TextDecoder().decode(content!)).toBe('{"version": 1}')
    })

    it('should override parent content with COW', async () => {
      // Setup main branch with content
      const mainHandler = new CASCOWHandler({
        cas,
        branchStorage,
        currentBranch: 'main',
      })
      await mainHandler.init()

      await mainHandler.write('/config.json', new TextEncoder().encode('{"version": 1}'))
      await mainHandler.commit()

      // Create feature branch
      await branchStorage.setBranchMeta('feature-x', {
        parentBranch: 'main',
        createdAt: Date.now(),
      })

      const featureHandler = new CASCOWHandler({
        cas,
        branchStorage,
        currentBranch: 'feature-x',
      })
      await featureHandler.init()

      // Override in feature branch
      await featureHandler.write('/config.json', new TextEncoder().encode('{"version": 2}'))

      // Feature branch sees new content
      const featureContent = await featureHandler.read('/config.json')
      expect(new TextDecoder().decode(featureContent!)).toBe('{"version": 2}')

      // Main branch still has original content
      const mainContent = await mainHandler.read('/config.json')
      expect(new TextDecoder().decode(mainContent!)).toBe('{"version": 1}')
    })
  })
})

// =============================================================================
// InMemoryBranchMetadataStorage Tests
// =============================================================================

describe('InMemoryBranchMetadataStorage', () => {
  it('should store and retrieve blocks', async () => {
    const storage = new InMemoryBranchMetadataStorage()
    storage.initMain()

    const block: BlockInfo = {
      hash: 'test-hash',
      size: 100,
      isOwned: true,
    }

    await storage.setBlock('main', '/test.txt', block)
    const blocks = await storage.getBlocks('main')

    expect(blocks.has('/test.txt')).toBe(true)
    expect(blocks.get('/test.txt')?.hash).toBe('test-hash')
  })

  it('should delete blocks', async () => {
    const storage = new InMemoryBranchMetadataStorage()
    storage.initMain()

    const block: BlockInfo = { hash: 'hash', size: 50, isOwned: true }
    await storage.setBlock('main', '/test.txt', block)
    await storage.deleteBlock('main', '/test.txt')

    const blocks = await storage.getBlocks('main')
    expect(blocks.has('/test.txt')).toBe(false)
  })

  it('should track parent branches', async () => {
    const storage = new InMemoryBranchMetadataStorage()
    storage.initMain()

    await storage.setBranchMeta('feature-x', {
      parentBranch: 'main',
      createdAt: Date.now(),
    })

    expect(await storage.getParentBranch('main')).toBeNull()
    expect(await storage.getParentBranch('feature-x')).toBe('main')
  })
})

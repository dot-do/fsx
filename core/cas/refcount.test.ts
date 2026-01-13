import { describe, it, expect, beforeEach } from 'vitest'
import {
  InMemoryRefCountStorage,
  calculateStats,
  type RefCountStorage,
  type DeduplicationStats,
} from './refcount'

describe('InMemoryRefCountStorage', () => {
  let storage: InMemoryRefCountStorage

  beforeEach(() => {
    storage = new InMemoryRefCountStorage()
  })

  describe('getRefCount', () => {
    it('should return 0 for non-existent hash', async () => {
      const count = await storage.getRefCount('abc123')
      expect(count).toBe(0)
    })

    it('should return correct count after setRefCount', async () => {
      await storage.setRefCount('abc123', 5)
      const count = await storage.getRefCount('abc123')
      expect(count).toBe(5)
    })

    it('should normalize hash to lowercase', async () => {
      await storage.setRefCount('ABC123', 3)
      const count = await storage.getRefCount('abc123')
      expect(count).toBe(3)
    })
  })

  describe('setRefCount', () => {
    it('should set refcount', async () => {
      await storage.setRefCount('hash1', 10)
      expect(await storage.getRefCount('hash1')).toBe(10)
    })

    it('should delete entry when setting to 0', async () => {
      await storage.setRefCount('hash1', 5)
      await storage.setRefCount('hash1', 0)
      expect(await storage.getRefCount('hash1')).toBe(0)
    })

    it('should delete entry when setting to negative', async () => {
      await storage.setRefCount('hash1', 5)
      await storage.setRefCount('hash1', -1)
      expect(await storage.getRefCount('hash1')).toBe(0)
    })
  })

  describe('incrementRefCount', () => {
    it('should increment from 0 to 1', async () => {
      const newCount = await storage.incrementRefCount('hash1')
      expect(newCount).toBe(1)
      expect(await storage.getRefCount('hash1')).toBe(1)
    })

    it('should increment existing count', async () => {
      await storage.setRefCount('hash1', 5)
      const newCount = await storage.incrementRefCount('hash1')
      expect(newCount).toBe(6)
    })

    it('should return the new count', async () => {
      await storage.incrementRefCount('hash1')
      await storage.incrementRefCount('hash1')
      const newCount = await storage.incrementRefCount('hash1')
      expect(newCount).toBe(3)
    })
  })

  describe('decrementRefCount', () => {
    it('should decrement count', async () => {
      await storage.setRefCount('hash1', 5)
      const newCount = await storage.decrementRefCount('hash1')
      expect(newCount).toBe(4)
    })

    it('should not go below 0', async () => {
      await storage.setRefCount('hash1', 1)
      await storage.decrementRefCount('hash1')
      const newCount = await storage.decrementRefCount('hash1')
      expect(newCount).toBe(0)
    })

    it('should delete entry when reaching 0', async () => {
      await storage.setRefCount('hash1', 1)
      await storage.decrementRefCount('hash1')

      // getAllRefCounts should not include this hash
      const all = await storage.getAllRefCounts()
      expect(all.has('hash1')).toBe(false)
    })

    it('should handle decrement on non-existent hash', async () => {
      const newCount = await storage.decrementRefCount('nonexistent')
      expect(newCount).toBe(0)
    })
  })

  describe('deleteRefCount', () => {
    it('should delete refcount entry', async () => {
      await storage.setRefCount('hash1', 5)
      await storage.setSize('hash1', 100)

      await storage.deleteRefCount('hash1')

      expect(await storage.getRefCount('hash1')).toBe(0)
      expect(await storage.getSize('hash1')).toBe(0)
    })

    it('should handle deleting non-existent entry', async () => {
      // Should not throw
      await storage.deleteRefCount('nonexistent')
    })
  })

  describe('setSize / getSize', () => {
    it('should store and retrieve size', async () => {
      await storage.setSize('hash1', 1024)
      expect(await storage.getSize('hash1')).toBe(1024)
    })

    it('should return 0 for non-existent hash', async () => {
      expect(await storage.getSize('nonexistent')).toBe(0)
    })

    it('should normalize hash to lowercase', async () => {
      await storage.setSize('ABC123', 500)
      expect(await storage.getSize('abc123')).toBe(500)
    })
  })

  describe('getAllRefCounts', () => {
    it('should return empty map for empty storage', async () => {
      const all = await storage.getAllRefCounts()
      expect(all.size).toBe(0)
    })

    it('should return all entries with refcount and size', async () => {
      await storage.setRefCount('hash1', 3)
      await storage.setSize('hash1', 100)
      await storage.setRefCount('hash2', 1)
      await storage.setSize('hash2', 200)

      const all = await storage.getAllRefCounts()

      expect(all.size).toBe(2)
      expect(all.get('hash1')).toEqual({ refCount: 3, size: 100 })
      expect(all.get('hash2')).toEqual({ refCount: 1, size: 200 })
    })

    it('should return 0 size for entries without size set', async () => {
      await storage.setRefCount('hash1', 2)

      const all = await storage.getAllRefCounts()

      expect(all.get('hash1')).toEqual({ refCount: 2, size: 0 })
    })
  })

  describe('clear', () => {
    it('should clear all data', async () => {
      await storage.setRefCount('hash1', 5)
      await storage.setSize('hash1', 100)
      await storage.setRefCount('hash2', 3)

      storage.clear()

      expect(await storage.getRefCount('hash1')).toBe(0)
      expect(await storage.getSize('hash1')).toBe(0)
      expect((await storage.getAllRefCounts()).size).toBe(0)
    })
  })
})

describe('calculateStats', () => {
  it('should return zeros for empty map', () => {
    const stats = calculateStats(new Map())

    expect(stats.totalObjects).toBe(0)
    expect(stats.totalReferences).toBe(0)
    expect(stats.deduplicatedBytes).toBe(0)
    expect(stats.averageRefCount).toBe(0)
  })

  it('should count total objects', () => {
    const refCounts = new Map([
      ['hash1', { refCount: 1, size: 100 }],
      ['hash2', { refCount: 1, size: 200 }],
      ['hash3', { refCount: 1, size: 300 }],
    ])

    const stats = calculateStats(refCounts)

    expect(stats.totalObjects).toBe(3)
  })

  it('should count total references', () => {
    const refCounts = new Map([
      ['hash1', { refCount: 3, size: 100 }],
      ['hash2', { refCount: 2, size: 200 }],
      ['hash3', { refCount: 1, size: 300 }],
    ])

    const stats = calculateStats(refCounts)

    expect(stats.totalReferences).toBe(6) // 3 + 2 + 1
  })

  it('should calculate deduplicated bytes', () => {
    const refCounts = new Map([
      ['hash1', { refCount: 3, size: 100 }], // saves (3-1) * 100 = 200
      ['hash2', { refCount: 2, size: 200 }], // saves (2-1) * 200 = 200
      ['hash3', { refCount: 1, size: 300 }], // saves 0 (only 1 ref)
    ])

    const stats = calculateStats(refCounts)

    expect(stats.deduplicatedBytes).toBe(400) // 200 + 200
  })

  it('should calculate average refcount', () => {
    const refCounts = new Map([
      ['hash1', { refCount: 4, size: 100 }],
      ['hash2', { refCount: 2, size: 200 }],
    ])

    const stats = calculateStats(refCounts)

    expect(stats.averageRefCount).toBe(3) // (4 + 2) / 2
  })

  it('should handle single object with multiple refs', () => {
    const refCounts = new Map([['hash1', { refCount: 5, size: 1000 }]])

    const stats = calculateStats(refCounts)

    expect(stats.totalObjects).toBe(1)
    expect(stats.totalReferences).toBe(5)
    expect(stats.deduplicatedBytes).toBe(4000) // (5-1) * 1000
    expect(stats.averageRefCount).toBe(5)
  })
})

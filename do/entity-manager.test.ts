/**
 * Tests for EntityManager - Deferred store initialization
 *
 * These tests verify that EntityManager properly handles:
 * - Deferred store creation until state context is available
 * - Lazy initialization of individual stores
 * - Proper error handling when context is missing
 * - Type-safe store operations
 *
 * @module durable-object/entity-manager.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EntityManager, type EntityStore, type EntityManagerConfig } from './entity-manager.js'

// ============================================================================
// Mock SqlStorage
// ============================================================================

/**
 * Mock SQL result interface
 */
interface MockSqlResult<T> {
  toArray: () => T[]
}

/**
 * Mock SQLite storage that simulates Cloudflare DO SQLite behavior
 */
class MockSqlStorage {
  private tables: Map<string, Map<string, { key: string; value: string; created_at: number; updated_at: number }>> =
    new Map()
  public execCalls: { sql: string; params: unknown[] }[] = []

  exec<T = unknown>(sql: string, ...params: unknown[]): MockSqlResult<T> {
    this.execCalls.push({ sql, params })
    const normalizedSql = sql.trim().toLowerCase()

    // Handle CREATE TABLE
    if (normalizedSql.includes('create table')) {
      const tableMatch = sql.match(/create table if not exists (\w+)/i)
      if (tableMatch) {
        const tableName = tableMatch[1]!
        if (!this.tables.has(tableName)) {
          this.tables.set(tableName, new Map())
        }
      }
      return this.emptyResult<T>()
    }

    // Handle INSERT with ON CONFLICT
    if (normalizedSql.includes('insert into') && normalizedSql.includes('on conflict')) {
      const tableMatch = sql.match(/insert into (\w+)/i)
      if (tableMatch) {
        const tableName = tableMatch[1]!
        const table = this.tables.get(tableName) ?? new Map()
        this.tables.set(tableName, table)

        const key = params[0] as string
        const value = params[1] as string
        const createdAt = params[2] as number
        const updatedAt = params[3] as number

        const existing = table.get(key)
        if (existing) {
          // Update existing
          table.set(key, {
            key,
            value: params[4] as string, // Updated value
            created_at: existing.created_at,
            updated_at: params[5] as number, // Updated timestamp
          })
        } else {
          // Insert new
          table.set(key, { key, value, created_at: createdAt, updated_at: updatedAt })
        }
      }
      return this.emptyResult<T>()
    }

    // Handle SELECT value FROM table WHERE key = ?
    if (normalizedSql.includes('select value from') && normalizedSql.includes('where key')) {
      const tableMatch = sql.match(/from (\w+)/i)
      if (tableMatch) {
        const tableName = tableMatch[1]!
        const table = this.tables.get(tableName)
        const key = params[0] as string

        if (table) {
          const entry = table.get(key)
          if (entry) {
            return { toArray: () => [{ value: entry.value } as T] }
          }
        }
      }
      return this.emptyResult<T>()
    }

    // Handle SELECT COUNT(*) WHERE key = ?
    if (normalizedSql.includes('select count(*)') && normalizedSql.includes('where key')) {
      const tableMatch = sql.match(/from (\w+)/i)
      if (tableMatch) {
        const tableName = tableMatch[1]!
        const table = this.tables.get(tableName)
        const key = params[0] as string

        if (table && table.has(key)) {
          return { toArray: () => [{ count: 1 } as T] }
        }
      }
      return { toArray: () => [{ count: 0 } as T] }
    }

    // Handle SELECT COUNT(*) (without WHERE)
    if (normalizedSql.includes('select count(*)') && !normalizedSql.includes('where')) {
      const tableMatch = sql.match(/from (\w+)/i)
      if (tableMatch) {
        const tableName = tableMatch[1]!
        const table = this.tables.get(tableName)
        return { toArray: () => [{ count: table?.size ?? 0 } as T] }
      }
      return { toArray: () => [{ count: 0 } as T] }
    }

    // Handle SELECT key FROM table
    if (normalizedSql.includes('select key from')) {
      const tableMatch = sql.match(/from (\w+)/i)
      if (tableMatch) {
        const tableName = tableMatch[1]!
        const table = this.tables.get(tableName)
        if (table) {
          return { toArray: () => Array.from(table.values()).map((e) => ({ key: e.key }) as T) }
        }
      }
      return this.emptyResult<T>()
    }

    // Handle SELECT key, value FROM table
    if (normalizedSql.includes('select key, value from')) {
      const tableMatch = sql.match(/from (\w+)/i)
      if (tableMatch) {
        const tableName = tableMatch[1]!
        const table = this.tables.get(tableName)
        if (table) {
          return {
            toArray: () => Array.from(table.values()).map((e) => ({ key: e.key, value: e.value }) as T),
          }
        }
      }
      return this.emptyResult<T>()
    }

    // Handle DELETE FROM table WHERE key = ?
    if (normalizedSql.includes('delete from') && normalizedSql.includes('where key')) {
      const tableMatch = sql.match(/from (\w+)/i)
      if (tableMatch) {
        const tableName = tableMatch[1]!
        const table = this.tables.get(tableName)
        const key = params[0] as string

        if (table) {
          table.delete(key)
        }
      }
      return this.emptyResult<T>()
    }

    // Handle DELETE FROM table (clear all)
    if (normalizedSql.includes('delete from') && !normalizedSql.includes('where')) {
      const tableMatch = sql.match(/from (\w+)/i)
      if (tableMatch) {
        const tableName = tableMatch[1]!
        const table = this.tables.get(tableName)
        if (table) {
          table.clear()
        }
      }
      return this.emptyResult<T>()
    }

    return this.emptyResult<T>()
  }

  private emptyResult<T>(): MockSqlResult<T> {
    return { toArray: () => [] }
  }

  // Helper for testing
  getTable(name: string): Map<string, any> | undefined {
    return this.tables.get(name)
  }
}

/**
 * Create a mock Durable Object state context
 */
function createMockContext(): { storage: { sql: MockSqlStorage } } {
  return {
    storage: {
      sql: new MockSqlStorage(),
    },
  }
}

// ============================================================================
// Test Suites
// ============================================================================

describe('EntityManager', () => {
  // ==========================================================================
  // Construction Tests
  // ==========================================================================

  describe('construction', () => {
    it('should create EntityManager without state context', () => {
      const manager = new EntityManager()

      expect(manager).toBeDefined()
      expect(manager.isInitialized()).toBe(false)
    })

    it('should create EntityManager with config', () => {
      const manager = new EntityManager({
        tablePrefix: 'custom_',
        autoCreateTables: false,
      })

      expect(manager).toBeDefined()
      expect(manager.isInitialized()).toBe(false)
    })

    it('should create EntityManager with SQL storage in config', () => {
      const ctx = createMockContext()
      const manager = new EntityManager({ sql: ctx.storage.sql })

      expect(manager).toBeDefined()
      // Not initialized until initialize() is called
      expect(manager.isInitialized()).toBe(false)
    })

    it('should NOT create any stores during construction', () => {
      const ctx = createMockContext()
      const manager = new EntityManager({ sql: ctx.storage.sql })

      // No SQL calls should have been made
      expect(ctx.storage.sql.execCalls.length).toBe(0)
    })
  })

  // ==========================================================================
  // Factory Method Tests
  // ==========================================================================

  describe('factory method', () => {
    it('should create EntityManager with state context using factory', () => {
      const ctx = createMockContext()
      const manager = EntityManager.create(ctx)

      expect(manager).toBeDefined()
      expect(manager.isInitialized()).toBe(false)
    })

    it('should accept additional config in factory', () => {
      const ctx = createMockContext()
      const manager = EntityManager.create(ctx, { tablePrefix: 'app_' })

      expect(manager).toBeDefined()
    })
  })

  // ==========================================================================
  // Initialization Tests
  // ==========================================================================

  describe('initialization', () => {
    it('should initialize with state context', async () => {
      const manager = new EntityManager()
      const ctx = createMockContext()

      await manager.initialize(ctx)

      expect(manager.isInitialized()).toBe(true)
    })

    it('should allow multiple initialize calls with same context', async () => {
      const ctx = createMockContext()
      const manager = new EntityManager({ sql: ctx.storage.sql })

      await manager.initialize(ctx)
      await manager.initialize(ctx) // Should not throw

      expect(manager.isInitialized()).toBe(true)
    })

    it('should throw if initialized with different context', async () => {
      const ctx1 = createMockContext()
      const ctx2 = createMockContext()
      const manager = new EntityManager({ sql: ctx1.storage.sql })

      await manager.initialize(ctx1)

      await expect(manager.initialize(ctx2)).rejects.toThrow(
        'EntityManager already initialized with different SQL storage'
      )
    })

    it('should throw if initialized without context', async () => {
      const manager = new EntityManager()

      await expect(manager.initialize()).rejects.toThrow(
        'EntityManager requires SQL storage context'
      )
    })

    it('should initialize when SQL was provided in constructor', async () => {
      const ctx = createMockContext()
      const manager = new EntityManager({ sql: ctx.storage.sql })

      await manager.initialize()

      expect(manager.isInitialized()).toBe(true)
    })
  })

  // ==========================================================================
  // Store Registration Tests
  // ==========================================================================

  describe('store registration', () => {
    it('should register a store without creating it', () => {
      const manager = new EntityManager()

      manager.registerStore('users')

      expect(manager.hasStore('users')).toBe(true)
      expect(manager.getStoreNames()).toContain('users')
    })

    it('should allow registering multiple stores', () => {
      const manager = new EntityManager()

      manager.registerStore('users')
      manager.registerStore('posts')
      manager.registerStore('comments')

      expect(manager.getStoreNames()).toEqual(['users', 'posts', 'comments'])
    })

    it('should not duplicate store registration', () => {
      const manager = new EntityManager()

      manager.registerStore('users')
      manager.registerStore('users')

      expect(manager.getStoreNames().filter((n) => n === 'users').length).toBe(1)
    })
  })

  // ==========================================================================
  // Store Access Tests
  // ==========================================================================

  describe('store access', () => {
    it('should throw when accessing store without initialization', async () => {
      const manager = new EntityManager()

      await expect(manager.getStore('users')).rejects.toThrow(
        'EntityManager not initialized'
      )
    })

    it('should create store lazily on first access', async () => {
      const ctx = createMockContext()
      const manager = EntityManager.create(ctx)
      await manager.initialize()

      const store = await manager.getStore('users')

      expect(store).toBeDefined()
      expect(store.name).toBe('users')

      // Should have created the table
      const createCalls = ctx.storage.sql.execCalls.filter((c) =>
        c.sql.toLowerCase().includes('create table')
      )
      expect(createCalls.length).toBe(1)
      expect(createCalls[0]!.sql).toContain('entity_users')
    })

    it('should return same store instance on multiple accesses', async () => {
      const ctx = createMockContext()
      const manager = EntityManager.create(ctx)
      await manager.initialize()

      const store1 = await manager.getStore('users')
      const store2 = await manager.getStore('users')

      expect(store1).toBe(store2)
    })

    it('should use custom table prefix', async () => {
      const ctx = createMockContext()
      const manager = EntityManager.create(ctx, { tablePrefix: 'app_' })
      await manager.initialize()

      await manager.getStore('users')

      const createCalls = ctx.storage.sql.execCalls.filter((c) =>
        c.sql.toLowerCase().includes('create table')
      )
      expect(createCalls[0]!.sql).toContain('app_users')
    })
  })

  // ==========================================================================
  // Store Operations Tests
  // ==========================================================================

  describe('store operations', () => {
    let manager: EntityManager
    let ctx: ReturnType<typeof createMockContext>
    let store: EntityStore<{ id: string; name: string }>

    beforeEach(async () => {
      ctx = createMockContext()
      manager = EntityManager.create(ctx)
      await manager.initialize()
      store = await manager.getStore<{ id: string; name: string }>('users')
    })

    it('should set and get an entity', async () => {
      const user = { id: 'user-1', name: 'Alice' }

      await store.set('user-1', user)
      const retrieved = await store.get('user-1')

      expect(retrieved).toEqual(user)
    })

    it('should return null for non-existent entity', async () => {
      const retrieved = await store.get('non-existent')

      expect(retrieved).toBeNull()
    })

    it('should update existing entity', async () => {
      await store.set('user-1', { id: 'user-1', name: 'Alice' })
      await store.set('user-1', { id: 'user-1', name: 'Alice Updated' })

      const retrieved = await store.get('user-1')

      expect(retrieved?.name).toBe('Alice Updated')
    })

    it('should check entity existence', async () => {
      expect(await store.has('user-1')).toBe(false)

      await store.set('user-1', { id: 'user-1', name: 'Alice' })

      expect(await store.has('user-1')).toBe(true)
    })

    it('should delete entity', async () => {
      await store.set('user-1', { id: 'user-1', name: 'Alice' })

      const deleted = await store.delete('user-1')

      expect(deleted).toBe(true)
      expect(await store.has('user-1')).toBe(false)
    })

    it('should return false when deleting non-existent entity', async () => {
      const deleted = await store.delete('non-existent')

      expect(deleted).toBe(false)
    })

    it('should list all keys', async () => {
      await store.set('user-1', { id: 'user-1', name: 'Alice' })
      await store.set('user-2', { id: 'user-2', name: 'Bob' })

      const keys = await store.keys()

      expect(keys).toContain('user-1')
      expect(keys).toContain('user-2')
      expect(keys.length).toBe(2)
    })

    it('should list all entries', async () => {
      await store.set('user-1', { id: 'user-1', name: 'Alice' })
      await store.set('user-2', { id: 'user-2', name: 'Bob' })

      const entries = await store.entries()

      expect(entries.length).toBe(2)
      expect(entries.find(([k]) => k === 'user-1')?.[1]).toEqual({ id: 'user-1', name: 'Alice' })
      expect(entries.find(([k]) => k === 'user-2')?.[1]).toEqual({ id: 'user-2', name: 'Bob' })
    })

    it('should count entities', async () => {
      expect(await store.count()).toBe(0)

      await store.set('user-1', { id: 'user-1', name: 'Alice' })
      expect(await store.count()).toBe(1)

      await store.set('user-2', { id: 'user-2', name: 'Bob' })
      expect(await store.count()).toBe(2)
    })

    it('should clear all entities', async () => {
      await store.set('user-1', { id: 'user-1', name: 'Alice' })
      await store.set('user-2', { id: 'user-2', name: 'Bob' })

      await store.clear()

      expect(await store.count()).toBe(0)
      expect(await store.keys()).toEqual([])
    })
  })

  // ==========================================================================
  // Multiple Stores Tests
  // ==========================================================================

  describe('multiple stores', () => {
    it('should manage multiple independent stores', async () => {
      const ctx = createMockContext()
      const manager = EntityManager.create(ctx)
      await manager.initialize()

      const usersStore = await manager.getStore<{ name: string }>('users')
      const postsStore = await manager.getStore<{ title: string }>('posts')

      await usersStore.set('user-1', { name: 'Alice' })
      await postsStore.set('post-1', { title: 'Hello World' })

      expect(await usersStore.get('user-1')).toEqual({ name: 'Alice' })
      expect(await postsStore.get('post-1')).toEqual({ title: 'Hello World' })

      // Stores should be independent
      expect(await usersStore.get('post-1')).toBeNull()
      expect(await postsStore.get('user-1')).toBeNull()
    })
  })

  // ==========================================================================
  // Dispose Tests
  // ==========================================================================

  describe('dispose', () => {
    it('should clear stores on dispose', async () => {
      const ctx = createMockContext()
      const manager = EntityManager.create(ctx)
      await manager.initialize()

      await manager.getStore('users')
      await manager.getStore('posts')

      expect(manager.getStoreNames().length).toBe(2)

      await manager.dispose()

      expect(manager.getStoreNames().length).toBe(0)
      expect(manager.isInitialized()).toBe(false)
    })
  })

  // ==========================================================================
  // Edge Cases Tests
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle special characters in keys', async () => {
      const ctx = createMockContext()
      const manager = EntityManager.create(ctx)
      await manager.initialize()
      const store = await manager.getStore<string>('data')

      await store.set('key/with/slashes', 'value1')
      await store.set('key:with:colons', 'value2')
      await store.set('key with spaces', 'value3')

      expect(await store.get('key/with/slashes')).toBe('value1')
      expect(await store.get('key:with:colons')).toBe('value2')
      expect(await store.get('key with spaces')).toBe('value3')
    })

    it('should handle complex JSON values', async () => {
      const ctx = createMockContext()
      const manager = EntityManager.create(ctx)
      await manager.initialize()
      const store = await manager.getStore<any>('data')

      const complexValue = {
        nested: { deeply: { value: 42 } },
        array: [1, 2, 3],
        date: '2024-01-01T00:00:00Z',
        nullable: null,
      }

      await store.set('complex', complexValue)
      const retrieved = await store.get('complex')

      expect(retrieved).toEqual(complexValue)
    })

    it('should handle empty string values', async () => {
      const ctx = createMockContext()
      const manager = EntityManager.create(ctx)
      await manager.initialize()
      const store = await manager.getStore<string>('data')

      await store.set('empty', '')
      const retrieved = await store.get('empty')

      expect(retrieved).toBe('')
    })
  })

  // ==========================================================================
  // Deferred Initialization Pattern Tests
  // ==========================================================================

  describe('deferred initialization pattern', () => {
    it('should support typical DO lifecycle pattern', async () => {
      // Simulate DO constructor - no ctx available yet
      const manager = new EntityManager()

      // Later, in fetch/alarm handler - ctx is now available
      const ctx = createMockContext()
      await manager.initialize(ctx)

      // Now stores can be accessed
      const store = await manager.getStore('sessions')
      await store.set('session-1', { userId: 'user-1' })

      expect(await store.get('session-1')).toEqual({ userId: 'user-1' })
    })

    it('should NOT make SQL calls until store is accessed', async () => {
      const ctx = createMockContext()
      const manager = new EntityManager()

      // Register stores without SQL access
      manager.registerStore('users')
      manager.registerStore('posts')

      // Initialize - still no SQL calls
      await manager.initialize(ctx)

      expect(ctx.storage.sql.execCalls.length).toBe(0)

      // Only when store is accessed, SQL calls are made
      await manager.getStore('users')

      expect(ctx.storage.sql.execCalls.length).toBeGreaterThan(0)
      expect(ctx.storage.sql.execCalls[0]!.sql).toContain('CREATE TABLE')
    })
  })
})

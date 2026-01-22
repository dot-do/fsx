/**
 * Tests for Branch Metadata Storage
 *
 * This test file covers:
 * - Schema initialization and default branch creation
 * - Branch CRUD operations (create, read, update, delete)
 * - Branch listing with filters and pagination
 * - Branch renaming
 * - Default branch management
 * - Protection settings
 * - Archive operations (R2)
 *
 * @module storage/branch-metadata.test
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  SQLiteBranchMetadata,
  R2BranchMetadata,
  type BranchMetadata,
  type ArchivedBranch,
} from './branch-metadata.js'

// ============================================================================
// Mock SqlStorage Implementation
// ============================================================================

/**
 * Mock SQL result interface matching Cloudflare's SqlStorage
 */
interface MockSqlResult<T> {
  one: () => T | null
  toArray: () => T[]
}

/**
 * Mock SQLite storage that simulates Cloudflare DO SqlStorage behavior
 */
class MockSqlStorage {
  private branches: Map<string, Record<string, unknown>> = new Map()
  private nextId = 1
  public execCalls: { sql: string; params: unknown[] }[] = []
  public schemaCreated = false

  exec<T = unknown>(sql: string, ...params: unknown[]): MockSqlResult<T> {
    this.execCalls.push({ sql, params })
    const normalizedSql = sql.trim().toLowerCase()

    // Handle CREATE TABLE
    if (normalizedSql.includes('create table')) {
      this.schemaCreated = true
      return this.emptyResult<T>()
    }

    // Handle CREATE INDEX
    if (normalizedSql.includes('create index')) {
      return this.emptyResult<T>()
    }

    // Handle INSERT into branches
    if (normalizedSql.includes('insert into branches')) {
      const id = this.nextId++
      const entry = this.parseInsert(params, id)
      this.branches.set(entry.name as string, entry)
      return this.emptyResult<T>()
    }

    // Handle SELECT from branches WHERE name = ?
    if (
      normalizedSql.includes('select') &&
      normalizedSql.includes('from branches') &&
      normalizedSql.includes('where name = ?')
    ) {
      const name = params[0] as string
      const entry = this.branches.get(name)
      return {
        one: () => (entry as T) || null,
        toArray: () => (entry ? [entry as T] : []),
      }
    }

    // Handle SELECT 1 FROM branches WHERE name = ?
    if (normalizedSql.includes('select 1 from branches') && normalizedSql.includes('where name = ?')) {
      const name = params[0] as string
      const exists = this.branches.has(name)
      return {
        one: () => (exists ? ({ '1': 1 } as T) : null),
        toArray: () => (exists ? [{ '1': 1 } as T] : []),
      }
    }

    // Handle SELECT from branches WHERE is_default = 1
    if (
      normalizedSql.includes('select') &&
      normalizedSql.includes('from branches') &&
      normalizedSql.includes('where is_default = 1')
    ) {
      for (const entry of this.branches.values()) {
        if (entry.is_default === 1) {
          return {
            one: () => entry as T,
            toArray: () => [entry as T],
          }
        }
      }
      return this.emptyResult<T>()
    }

    // Handle SELECT from branches with optional filters (list)
    if (
      normalizedSql.includes('select * from branches') &&
      !normalizedSql.includes('where name =') &&
      !normalizedSql.includes('where is_default =')
    ) {
      let results = Array.from(this.branches.values())

      // Apply filters
      if (normalizedSql.includes('is_archived = 0')) {
        results = results.filter((b) => b.is_archived === 0)
      }

      if (normalizedSql.includes('parent_branch = ?')) {
        const parentBranch = params[0] as string
        results = results.filter((b) => b.parent_branch === parentBranch)
      }

      // Sort by updated_at desc
      results.sort((a, b) => (b.updated_at as number) - (a.updated_at as number))

      // Handle LIMIT
      const limitMatch = normalizedSql.match(/limit\s+\?/)
      if (limitMatch) {
        const limitParamIndex = params.length - (normalizedSql.includes('offset') ? 2 : 1)
        const limit = params[limitParamIndex] as number
        results = results.slice(0, limit)
      }

      return {
        one: () => (results.length > 0 ? (results[0] as T) : null),
        toArray: () => results as T[],
      }
    }

    // Handle UPDATE branches SET ... WHERE name = ?
    if (normalizedSql.includes('update branches set')) {
      const name = params[params.length - 1] as string
      const entry = this.branches.get(name)
      if (entry) {
        const oldName = entry.name as string
        this.applyUpdate(entry, sql, params)
        // If name was updated, move the entry to the new key
        const newName = entry.name as string
        if (oldName !== newName) {
          this.branches.delete(oldName)
          this.branches.set(newName, entry)
        }
      }
      return this.emptyResult<T>()
    }

    // Handle DELETE FROM branches WHERE name = ?
    if (normalizedSql.includes('delete from branches') && normalizedSql.includes('where name = ?')) {
      const name = params[0] as string
      this.branches.delete(name)
      return this.emptyResult<T>()
    }

    return this.emptyResult<T>()
  }

  private parseInsert(params: unknown[], id: number): Record<string, unknown> {
    // INSERT order: name, parent_branch, fork_point, head_commit, created_at, updated_at, is_default, is_protected, is_archived, commit_count
    return {
      id,
      name: params[0] as string,
      parent_branch: params[1] as string | null,
      fork_point: params[2] as string | null,
      head_commit: params[3] as string,
      created_at: params[4] as number,
      updated_at: params[5] as number,
      is_default: params[6] as number,
      is_protected: params[7] as number,
      is_archived: params[8] as number,
      commit_count: params[9] as number,
    }
  }

  private applyUpdate(entry: Record<string, unknown>, sql: string, params: unknown[]): void {
    const setClause = sql.match(/set\s+(.+)\s+where/i)?.[1] || ''
    const assignments = setClause.split(',').map((a) => a.trim())
    let paramIndex = 0

    for (const assignment of assignments) {
      const [column] = assignment.split('=').map((s) => s.trim())
      if (column && params[paramIndex] !== undefined) {
        entry[column] = params[paramIndex]
        paramIndex++
      }
    }
  }

  private emptyResult<T>(): MockSqlResult<T> {
    return {
      one: () => null,
      toArray: () => [],
    }
  }

  // Test helpers
  getBranches(): Map<string, Record<string, unknown>> {
    return this.branches
  }

  clear(): void {
    this.branches.clear()
    this.nextId = 1
    this.execCalls = []
    this.schemaCreated = false
  }
}

// ============================================================================
// Mock R2 Bucket Implementation
// ============================================================================

class MockR2Bucket {
  private objects: Map<string, { content: string; metadata: Record<string, string> }> = new Map()

  async put(
    key: string,
    value: string,
    options?: { customMetadata?: Record<string, string> }
  ): Promise<unknown> {
    this.objects.set(key, {
      content: value,
      metadata: options?.customMetadata ?? {},
    })
    return {}
  }

  async get(
    key: string
  ): Promise<{ text(): Promise<string>; customMetadata?: Record<string, string> } | null> {
    const obj = this.objects.get(key)
    if (!obj) {
      return null
    }
    return {
      text: async () => obj.content,
      customMetadata: obj.metadata,
    }
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    objects: Array<{ key: string; customMetadata?: Record<string, string> }>
    truncated: boolean
    cursor?: string
  }> {
    let keys = Array.from(this.objects.keys())
    if (options?.prefix) {
      keys = keys.filter((k) => k.startsWith(options.prefix!))
    }

    const limit = options?.limit ?? keys.length
    const truncated = keys.length > limit
    const resultKeys = keys.slice(0, limit)

    return {
      objects: resultKeys.map((key) => ({
        key,
        customMetadata: this.objects.get(key)?.metadata,
      })),
      truncated,
      cursor: truncated ? String(limit) : undefined,
    }
  }

  // Test helper
  clear(): void {
    this.objects.clear()
  }
}

// ============================================================================
// SQLiteBranchMetadata Tests
// ============================================================================

describe('SQLiteBranchMetadata', () => {
  let sql: MockSqlStorage
  let storage: SQLiteBranchMetadata

  beforeEach(() => {
    sql = new MockSqlStorage()
    storage = new SQLiteBranchMetadata(sql as unknown as Parameters<typeof SQLiteBranchMetadata['prototype']['constructor']>[0])
  })

  describe('init()', () => {
    it('should create branches table with correct schema', async () => {
      await storage.init()

      const createTableCall = sql.execCalls.find((c) =>
        c.sql.toLowerCase().includes('create table if not exists branches')
      )
      expect(createTableCall).toBeDefined()
      expect(createTableCall!.sql).toContain('id INTEGER PRIMARY KEY AUTOINCREMENT')
      expect(createTableCall!.sql).toContain('name TEXT UNIQUE NOT NULL')
      expect(createTableCall!.sql).toContain('parent_branch TEXT')
      expect(createTableCall!.sql).toContain('fork_point TEXT')
      expect(createTableCall!.sql).toContain('head_commit TEXT NOT NULL')
      expect(createTableCall!.sql).toContain('is_default INTEGER NOT NULL DEFAULT 0')
      expect(createTableCall!.sql).toContain('is_protected INTEGER NOT NULL DEFAULT 0')
      expect(createTableCall!.sql).toContain('is_archived INTEGER NOT NULL DEFAULT 0')
    })

    it('should create required indexes', async () => {
      await storage.init()

      const indexCalls = sql.execCalls.filter((c) => c.sql.toLowerCase().includes('create index'))
      expect(indexCalls.length).toBeGreaterThanOrEqual(4)

      const indexNames = indexCalls.map((c) => {
        const match = c.sql.match(/create index if not exists\s+(\w+)/i)
        return match?.[1]
      })

      expect(indexNames).toContain('idx_branches_name')
      expect(indexNames).toContain('idx_branches_parent')
      expect(indexNames).toContain('idx_branches_default')
      expect(indexNames).toContain('idx_branches_archived')
    })

    it('should create default "main" branch', async () => {
      await storage.init()

      const main = await storage.get('main')
      expect(main).not.toBeNull()
      expect(main?.name).toBe('main')
      expect(main?.isDefault).toBe(true)
      expect(main?.isProtected).toBe(true)
      expect(main?.parentBranch).toBeNull()
    })

    it('should be idempotent', async () => {
      await storage.init()
      await storage.init()
      await storage.init()

      // Should not throw and schema should be consistent
      const main = await storage.get('main')
      expect(main).not.toBeNull()
    })
  })

  describe('create()', () => {
    beforeEach(async () => {
      await storage.init()
    })

    it('should create a new branch', async () => {
      const branch = await storage.create({
        name: 'feature-test',
        parentBranch: 'main',
        forkPoint: 'abc123',
        headCommit: 'abc123',
      })

      expect(branch.name).toBe('feature-test')
      expect(branch.parentBranch).toBe('main')
      expect(branch.forkPoint).toBe('abc123')
      expect(branch.headCommit).toBe('abc123')
      expect(branch.isDefault).toBe(false)
      expect(branch.isProtected).toBe(false)
      expect(branch.isArchived).toBe(false)
      expect(branch.commitCount).toBe(0)
    })

    it('should set timestamps on creation', async () => {
      const before = Date.now()
      const branch = await storage.create({
        name: 'timestamped',
        headCommit: 'xyz789',
      })
      const after = Date.now()

      expect(branch.createdAt).toBeGreaterThanOrEqual(before)
      expect(branch.createdAt).toBeLessThanOrEqual(after)
      expect(branch.updatedAt).toBe(branch.createdAt)
    })

    it('should allow creating protected branch', async () => {
      const branch = await storage.create({
        name: 'protected-branch',
        headCommit: 'def456',
        isProtected: true,
      })

      expect(branch.isProtected).toBe(true)
    })

    it('should throw if branch already exists', async () => {
      await storage.create({
        name: 'existing',
        headCommit: 'abc123',
      })

      await expect(
        storage.create({
          name: 'existing',
          headCommit: 'xyz789',
        })
      ).rejects.toThrow('Branch already exists: existing')
    })

    it('should allow null parent branch', async () => {
      const branch = await storage.create({
        name: 'orphan',
        headCommit: 'orphan-commit',
      })

      expect(branch.parentBranch).toBeNull()
    })
  })

  describe('get()', () => {
    beforeEach(async () => {
      await storage.init()
    })

    it('should return branch by name', async () => {
      await storage.create({
        name: 'feature-get',
        parentBranch: 'main',
        forkPoint: 'getpoint',
        headCommit: 'gethead',
      })

      const branch = await storage.get('feature-get')
      expect(branch).not.toBeNull()
      expect(branch?.name).toBe('feature-get')
      expect(branch?.parentBranch).toBe('main')
    })

    it('should return null for non-existent branch', async () => {
      const branch = await storage.get('does-not-exist')
      expect(branch).toBeNull()
    })

    it('should return main branch', async () => {
      const main = await storage.get('main')
      expect(main).not.toBeNull()
      expect(main?.name).toBe('main')
    })
  })

  describe('update()', () => {
    beforeEach(async () => {
      await storage.init()
      await storage.create({
        name: 'update-test',
        headCommit: 'original',
      })
    })

    it('should update head commit', async () => {
      await storage.update('update-test', { headCommit: 'new-commit' })

      const branch = await storage.get('update-test')
      expect(branch?.headCommit).toBe('new-commit')
    })

    it('should update protection status', async () => {
      await storage.update('update-test', { isProtected: true })

      const branch = await storage.get('update-test')
      expect(branch?.isProtected).toBe(true)
    })

    it('should update archived status', async () => {
      await storage.update('update-test', { isArchived: true })

      const branch = await storage.get('update-test')
      expect(branch?.isArchived).toBe(true)
    })

    it('should update commit count', async () => {
      await storage.update('update-test', { commitCount: 5 })

      const branch = await storage.get('update-test')
      expect(branch?.commitCount).toBe(5)
    })

    it('should update timestamp on any update', async () => {
      const before = await storage.get('update-test')
      await new Promise((resolve) => setTimeout(resolve, 10))

      await storage.update('update-test', { headCommit: 'newer' })

      const updateCall = sql.execCalls.find(
        (c) => c.sql.toLowerCase().includes('update branches') && c.sql.toLowerCase().includes('updated_at')
      )
      expect(updateCall).toBeDefined()
    })

    it('should throw for non-existent branch', async () => {
      await expect(storage.update('no-branch', { headCommit: 'x' })).rejects.toThrow(
        'Branch not found: no-branch'
      )
    })
  })

  describe('delete()', () => {
    beforeEach(async () => {
      await storage.init()
    })

    it('should delete existing branch', async () => {
      await storage.create({
        name: 'to-delete',
        headCommit: 'del123',
      })

      await storage.delete('to-delete')

      const branch = await storage.get('to-delete')
      expect(branch).toBeNull()
    })

    it('should throw for non-existent branch', async () => {
      await expect(storage.delete('not-found')).rejects.toThrow('Branch not found: not-found')
    })

    it('should throw when deleting default branch', async () => {
      await expect(storage.delete('main')).rejects.toThrow('Cannot delete default branch: main')
    })

    it('should throw when deleting protected branch', async () => {
      await storage.create({
        name: 'protected',
        headCommit: 'prot123',
        isProtected: true,
      })

      await expect(storage.delete('protected')).rejects.toThrow('Cannot delete protected branch: protected')
    })
  })

  describe('list()', () => {
    beforeEach(async () => {
      await storage.init()
      await storage.create({ name: 'feature-a', headCommit: 'a', parentBranch: 'main' })
      await storage.create({ name: 'feature-b', headCommit: 'b', parentBranch: 'main' })
      await storage.create({ name: 'hotfix', headCommit: 'h', parentBranch: 'main' })
    })

    it('should list all active branches', async () => {
      const branches = await storage.list()

      expect(branches.length).toBeGreaterThanOrEqual(3)
      const names = branches.map((b) => b.name)
      expect(names).toContain('main')
      expect(names).toContain('feature-a')
      expect(names).toContain('feature-b')
    })

    it('should exclude archived branches by default', async () => {
      await storage.update('feature-a', { isArchived: true })

      const branches = await storage.list()
      const names = branches.map((b) => b.name)

      expect(names).not.toContain('feature-a')
    })

    it('should include archived branches when specified', async () => {
      await storage.update('feature-a', { isArchived: true })

      const branches = await storage.list({ includeArchived: true })
      const names = branches.map((b) => b.name)

      expect(names).toContain('feature-a')
    })

    it('should filter by parent branch', async () => {
      const branches = await storage.list({ parentBranch: 'main' })

      for (const branch of branches) {
        expect(branch.parentBranch).toBe('main')
      }
    })

    it('should respect limit option', async () => {
      const branches = await storage.list({ limit: 2 })
      expect(branches.length).toBeLessThanOrEqual(2)
    })
  })

  describe('exists()', () => {
    beforeEach(async () => {
      await storage.init()
    })

    it('should return true for existing branch', async () => {
      const exists = await storage.exists('main')
      expect(exists).toBe(true)
    })

    it('should return false for non-existent branch', async () => {
      const exists = await storage.exists('not-here')
      expect(exists).toBe(false)
    })
  })

  describe('rename()', () => {
    beforeEach(async () => {
      await storage.init()
      await storage.create({ name: 'old-name', headCommit: 'r123' })
    })

    it('should rename branch', async () => {
      await storage.rename('old-name', 'new-name')

      const oldBranch = await storage.get('old-name')
      const newBranch = await storage.get('new-name')

      expect(oldBranch).toBeNull()
      expect(newBranch).not.toBeNull()
      expect(newBranch?.name).toBe('new-name')
    })

    it('should throw for non-existent source', async () => {
      await expect(storage.rename('missing', 'new')).rejects.toThrow('Branch not found: missing')
    })

    it('should throw if target already exists', async () => {
      await storage.create({ name: 'target', headCommit: 't123' })

      await expect(storage.rename('old-name', 'target')).rejects.toThrow('Branch already exists: target')
    })

    it('should update child branches parent reference', async () => {
      await storage.create({ name: 'child', headCommit: 'c123', parentBranch: 'old-name' })

      await storage.rename('old-name', 'new-name')

      const updateCall = sql.execCalls.find(
        (c) =>
          c.sql.toLowerCase().includes('update branches set parent_branch') &&
          c.params.includes('new-name') &&
          c.params.includes('old-name')
      )
      expect(updateCall).toBeDefined()
    })
  })

  describe('getDefault()', () => {
    beforeEach(async () => {
      await storage.init()
    })

    it('should return main as default', async () => {
      const defaultBranch = await storage.getDefault()
      expect(defaultBranch).not.toBeNull()
      expect(defaultBranch?.name).toBe('main')
      expect(defaultBranch?.isDefault).toBe(true)
    })
  })

  describe('setDefault()', () => {
    beforeEach(async () => {
      await storage.init()
      await storage.create({ name: 'new-default', headCommit: 'nd123' })
    })

    it('should set new default branch', async () => {
      await storage.setDefault('new-default')

      // Check that UNSET and SET were called
      const unsetCall = sql.execCalls.find(
        (c) =>
          c.sql.toLowerCase().includes('update branches set is_default = 0') &&
          c.sql.toLowerCase().includes('is_default = 1')
      )
      const setCall = sql.execCalls.find(
        (c) =>
          c.sql.toLowerCase().includes('update branches set is_default = 1') &&
          c.params.includes('new-default')
      )

      expect(unsetCall).toBeDefined()
      expect(setCall).toBeDefined()
    })

    it('should throw for non-existent branch', async () => {
      await expect(storage.setDefault('missing')).rejects.toThrow('Branch not found: missing')
    })
  })

  describe('getStatementStats()', () => {
    beforeEach(async () => {
      await storage.init()
    })

    it('should return execution statistics', async () => {
      await storage.get('main')
      await storage.get('main')

      const stats = storage.getStatementStats()
      expect(stats.size).toBeGreaterThan(0)

      // getByName should have been called at least twice
      const getByNameStats = stats.get('getByName')
      expect(getByNameStats).toBeDefined()
      expect(getByNameStats?.executionCount).toBeGreaterThanOrEqual(2)
    })
  })
})

// ============================================================================
// R2BranchMetadata Tests
// ============================================================================

describe('R2BranchMetadata', () => {
  let bucket: MockR2Bucket
  let archive: R2BranchMetadata

  beforeEach(() => {
    bucket = new MockR2Bucket()
    archive = new R2BranchMetadata(bucket as unknown as Parameters<typeof R2BranchMetadata['prototype']['constructor']>[0])
  })

  const createTestBranch = (): BranchMetadata => ({
    name: 'test-branch',
    parentBranch: 'main',
    forkPoint: 'fork123',
    headCommit: 'head456',
    createdAt: Date.now() - 10000,
    updatedAt: Date.now(),
    isDefault: false,
    isProtected: false,
    isArchived: false,
    commitCount: 5,
  })

  describe('archive()', () => {
    it('should archive a branch', async () => {
      const branch = createTestBranch()
      const archived = await archive.archive(branch, 'Merged into main')

      expect(archived.name).toBe(branch.name)
      expect(archived.isArchived).toBe(true)
      expect(archived.archivedAt).toBeDefined()
      expect(archived.archiveReason).toBe('Merged into main')
    })

    it('should set archived timestamp', async () => {
      const before = Date.now()
      const branch = createTestBranch()
      const archived = await archive.archive(branch)
      const after = Date.now()

      expect(archived.archivedAt).toBeGreaterThanOrEqual(before)
      expect(archived.archivedAt).toBeLessThanOrEqual(after)
    })

    it('should store archivedBy', async () => {
      const branch = createTestBranch()
      const archived = await archive.archive(branch, 'cleanup', 'admin')

      expect(archived.archivedBy).toBe('admin')
    })
  })

  describe('get()', () => {
    it('should retrieve archived branch', async () => {
      const branch = createTestBranch()
      await archive.archive(branch)

      const retrieved = await archive.get('test-branch')
      expect(retrieved).not.toBeNull()
      expect(retrieved?.name).toBe('test-branch')
      expect(retrieved?.isArchived).toBe(true)
    })

    it('should return null for non-existent archived branch', async () => {
      const retrieved = await archive.get('not-archived')
      expect(retrieved).toBeNull()
    })

    it('should preserve all branch metadata', async () => {
      const branch = createTestBranch()
      await archive.archive(branch)

      const retrieved = await archive.get('test-branch')
      expect(retrieved?.parentBranch).toBe(branch.parentBranch)
      expect(retrieved?.forkPoint).toBe(branch.forkPoint)
      expect(retrieved?.headCommit).toBe(branch.headCommit)
      expect(retrieved?.commitCount).toBe(branch.commitCount)
    })
  })

  describe('delete()', () => {
    it('should delete archived branch', async () => {
      const branch = createTestBranch()
      await archive.archive(branch)

      await archive.delete('test-branch')

      const retrieved = await archive.get('test-branch')
      expect(retrieved).toBeNull()
    })

    it('should not throw when deleting non-existent', async () => {
      // Should not throw
      await archive.delete('not-exists')
    })
  })

  describe('list()', () => {
    beforeEach(async () => {
      await archive.archive({ ...createTestBranch(), name: 'archived-1' })
      await archive.archive({ ...createTestBranch(), name: 'archived-2' })
      await archive.archive({ ...createTestBranch(), name: 'archived-3' })
    })

    it('should list all archived branches', async () => {
      const result = await archive.list()

      expect(result.names.length).toBe(3)
      expect(result.names).toContain('archived-1')
      expect(result.names).toContain('archived-2')
      expect(result.names).toContain('archived-3')
    })

    it('should respect limit option', async () => {
      const result = await archive.list({ limit: 2 })

      expect(result.names.length).toBe(2)
      expect(result.cursor).toBeDefined()
    })
  })

  describe('exists()', () => {
    it('should return true for archived branch', async () => {
      const branch = createTestBranch()
      await archive.archive(branch)

      const exists = await archive.exists('test-branch')
      expect(exists).toBe(true)
    })

    it('should return false for non-existent', async () => {
      const exists = await archive.exists('not-archived')
      expect(exists).toBe(false)
    })
  })
})

// ============================================================================
// Edge Cases and Error Handling Tests
// ============================================================================

describe('Branch Metadata Edge Cases', () => {
  let sql: MockSqlStorage
  let storage: SQLiteBranchMetadata

  beforeEach(async () => {
    sql = new MockSqlStorage()
    storage = new SQLiteBranchMetadata(sql as unknown as Parameters<typeof SQLiteBranchMetadata['prototype']['constructor']>[0])
    await storage.init()
  })

  describe('branch naming', () => {
    it('should handle branch names with special characters', async () => {
      const branch = await storage.create({
        name: 'feature/auth-login',
        headCommit: 'special123',
      })

      expect(branch.name).toBe('feature/auth-login')

      const retrieved = await storage.get('feature/auth-login')
      expect(retrieved).not.toBeNull()
    })

    it('should handle branch names with unicode', async () => {
      const branch = await storage.create({
        name: 'feature-',
        headCommit: 'unicode123',
      })

      expect(branch.name).toBe('feature-')
    })

    it('should handle very long branch names', async () => {
      const longName = 'a'.repeat(255)
      const branch = await storage.create({
        name: longName,
        headCommit: 'long123',
      })

      expect(branch.name.length).toBe(255)
    })
  })

  describe('concurrent operations', () => {
    it('should handle multiple simultaneous creates', async () => {
      const promises = []
      for (let i = 0; i < 10; i++) {
        promises.push(
          storage.create({
            name: `concurrent-${i}`,
            headCommit: `commit-${i}`,
          })
        )
      }

      const branches = await Promise.all(promises)
      const names = branches.map((b) => b.name)
      expect(new Set(names).size).toBe(10) // All unique
    })
  })

  describe('timestamp handling', () => {
    it('should preserve createdAt across updates', async () => {
      const branch = await storage.create({
        name: 'timestamp-test',
        headCommit: 'ts123',
      })
      const originalCreatedAt = branch.createdAt

      await new Promise((resolve) => setTimeout(resolve, 10))
      await storage.update('timestamp-test', { headCommit: 'ts456' })

      const updated = await storage.get('timestamp-test')
      expect(updated?.createdAt).toBe(originalCreatedAt)
    })
  })
})

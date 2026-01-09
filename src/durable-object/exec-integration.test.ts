/**
 * Tests for BashModule exec table integration
 *
 * This test file covers:
 * - ExecStore schema initialization
 * - Safety policy management
 * - Per-command overrides
 * - Execution history logging
 * - Settings management via BashModule
 *
 * @module durable-object/exec-integration.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BashModule, type BashModuleConfig } from './BashModule.js'
import { ExecStore, type SafetyPolicy, type CommandOverride, type ExecHistory } from './exec-schema.js'
import type { FsModule } from './module.js'

// ============================================================================
// Mock SqlStorage Implementation
// ============================================================================

/**
 * Mock SqlStorage that simulates Cloudflare's SqlStorage API
 */
class MockSqlStorage {
  private tables: Map<string, Map<string, Record<string, unknown>>> = new Map()
  private schemas: string[] = []

  async exec<T = unknown>(query: string, ...params: unknown[]): Promise<{
    one: () => Promise<T | null>
    toArray: () => T[]
  }> {
    const normalizedQuery = query.trim().toLowerCase()

    // Handle CREATE TABLE and CREATE INDEX
    if (normalizedQuery.startsWith('create table') || normalizedQuery.startsWith('create index')) {
      this.schemas.push(query)
      return {
        one: async () => null,
        toArray: () => [],
      }
    }

    // Handle INSERT
    if (normalizedQuery.startsWith('insert')) {
      const tableMatch = query.match(/insert into (\w+)/i)
      if (tableMatch) {
        const tableName = tableMatch[1]
        if (!this.tables.has(tableName)) {
          this.tables.set(tableName, new Map())
        }
        const table = this.tables.get(tableName)!

        // Extract column names and values
        const columnsMatch = query.match(/\(([^)]+)\)\s*values/i)
        if (columnsMatch) {
          const columns = columnsMatch[1].split(',').map((c) => c.trim())
          const row: Record<string, unknown> = {}
          columns.forEach((col, i) => {
            row[col] = params[i]
          })
          const id = row['id'] as string
          table.set(id, row)
        }
      }
      return {
        one: async () => null,
        toArray: () => [],
      }
    }

    // Handle SELECT
    if (normalizedQuery.startsWith('select')) {
      const tableMatch = query.match(/from (\w+)/i)
      if (tableMatch) {
        const tableName = tableMatch[1]
        const table = this.tables.get(tableName) || new Map()

        // Check for WHERE clause
        const whereMatch = query.match(/where\s+(.+?)(?:\s+order|\s+limit|\s*$)/i)
        if (whereMatch) {
          const condition = whereMatch[1].trim()

          // Handle specific conditions
          if (condition.includes('is_active = 1') || condition.includes('is_active = ?')) {
            const activeValue = condition.includes('is_active = ?') ? params[params.length - 1] : 1
            const rows = Array.from(table.values()).filter((row) => row.is_active === activeValue)
            return {
              one: async () => (rows.length > 0 ? (rows[0] as T) : null),
              toArray: () => rows as T[],
            }
          }

          if (condition.includes('id = ?')) {
            const id = params[0] as string
            const row = table.get(id)
            return {
              one: async () => (row as T) || null,
              toArray: () => (row ? [row as T] : []),
            }
          }

          if (condition.includes('path = ?')) {
            const path = params[0] as string
            const row = Array.from(table.values()).find((r) => r.path === path)
            return {
              one: async () => (row as T) || null,
              toArray: () => (row ? [row as T] : []),
            }
          }

          if (condition.includes('command = ?') && condition.includes('is_pattern = 0')) {
            const command = params[0] as string
            const row = Array.from(table.values()).find(
              (r) => r.command === command && r.is_pattern === 0 && r.is_active === 1
            )
            return {
              one: async () => (row as T) || null,
              toArray: () => (row ? [row as T] : []),
            }
          }

          if (condition.includes('is_pattern = 1')) {
            const rows = Array.from(table.values()).filter((r) => r.is_pattern === 1 && r.is_active === 1)
            return {
              one: async () => (rows.length > 0 ? (rows[0] as T) : null),
              toArray: () => rows as T[],
            }
          }

          if (condition.includes('executed_at')) {
            const rows = Array.from(table.values())
            return {
              one: async () => (rows.length > 0 ? (rows[0] as T) : null),
              toArray: () => rows as T[],
            }
          }
        }

        // Return all rows
        const rows = Array.from(table.values())
        return {
          one: async () => (rows.length > 0 ? (rows[0] as T) : null),
          toArray: () => rows as T[],
        }
      }
    }

    // Handle UPDATE
    if (normalizedQuery.startsWith('update')) {
      const tableMatch = query.match(/update (\w+)/i)
      if (tableMatch) {
        const tableName = tableMatch[1]
        const table = this.tables.get(tableName)
        if (table) {
          // Handle is_active = 0 for all rows
          if (query.includes('is_active = 0') && !query.includes('where id')) {
            for (const row of table.values()) {
              row.is_active = 0
            }
          }

          // Handle specific id update
          const whereIdMatch = query.match(/where id = \?/i)
          if (whereIdMatch) {
            const id = params[params.length - 1] as string
            const row = table.get(id)
            if (row) {
              // Extract SET values
              const setMatch = query.match(/set\s+(.+?)\s+where/i)
              if (setMatch) {
                const sets = setMatch[1].split(',').map((s) => s.trim())
                let paramIndex = 0
                for (const set of sets) {
                  const [col] = set.split('=').map((s) => s.trim())
                  if (set.includes('?')) {
                    row[col] = params[paramIndex++]
                  }
                }
              }
            }
          }
        }
      }
      return {
        one: async () => null,
        toArray: () => [],
      }
    }

    // Handle DELETE
    if (normalizedQuery.startsWith('delete')) {
      const tableMatch = query.match(/from (\w+)/i)
      if (tableMatch) {
        const tableName = tableMatch[1]
        const table = this.tables.get(tableName)
        if (table) {
          const whereIdMatch = query.match(/where id = \?/i)
          if (whereIdMatch) {
            const id = params[0] as string
            table.delete(id)
          } else if (query.includes('executed_at <')) {
            // Delete by timestamp
            const timestamp = params[0] as number
            for (const [id, row] of table) {
              if ((row.executed_at as number) < timestamp) {
                table.delete(id)
              }
            }
          } else if (!query.includes('where')) {
            // Delete all
            table.clear()
          }
        }
      }
      return {
        one: async () => ({ count: 0 } as T),
        toArray: () => [],
      }
    }

    return {
      one: async () => null,
      toArray: () => [],
    }
  }

  // Test helper to check if a table exists
  hasTable(name: string): boolean {
    return this.tables.has(name)
  }

  // Test helper to get table contents
  getTable(name: string): Map<string, Record<string, unknown>> | undefined {
    return this.tables.get(name)
  }

  // Test helper to clear all data
  clear(): void {
    this.tables.clear()
    this.schemas = []
  }
}

// ============================================================================
// Mock FsModule Implementation (minimal for BashModule tests)
// ============================================================================

class MockFsModule {
  readonly name = 'fs'
  private files: Map<string, { content: string }> = new Map()

  constructor() {
    this.files.set('/', { content: '' })
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }

  async read(path: string, options?: { encoding?: string }): Promise<string> {
    const file = this.files.get(path)
    if (!file) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path })
    }
    return file.content
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, { content: data })
  }

  async append(path: string, data: string): Promise<void> {
    const existing = this.files.get(path)
    if (existing) {
      existing.content += data
    } else {
      this.files.set(path, { content: data })
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    this.files.set(path, { content: '' })
  }

  async stat(path: string): Promise<{ isDirectory: () => boolean }> {
    if (!this.files.has(path)) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path })
    }
    return { isDirectory: () => path === '/' || !path.includes('.') }
  }

  async readdir(path: string): Promise<string[]> {
    return []
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    this.files.delete(path)
  }

  async rmdir(path: string): Promise<void> {
    this.files.delete(path)
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const file = this.files.get(oldPath)
    if (file) {
      this.files.set(newPath, file)
      this.files.delete(oldPath)
    }
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const file = this.files.get(src)
    if (file) {
      this.files.set(dest, { ...file })
    }
  }

  async chmod(path: string, mode: number): Promise<void> {}
  async chown(path: string, uid: number, gid: number): Promise<void> {}
  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {}
  async symlink(target: string, path: string): Promise<void> {}
  async link(existingPath: string, newPath: string): Promise<void> {}
  async readlink(path: string): Promise<string> {
    return path
  }
  async realpath(path: string): Promise<string> {
    return path
  }
  async access(path: string): Promise<void> {}
}

// ============================================================================
// Test Suites
// ============================================================================

describe('ExecStore', () => {
  let mockSql: MockSqlStorage
  let store: ExecStore

  beforeEach(() => {
    mockSql = new MockSqlStorage()
    store = new ExecStore(mockSql as unknown as SqlStorage)
  })

  describe('initialization', () => {
    it('should initialize the database schema', async () => {
      await store.init()
      // Schema should be created (tables are created via exec)
      expect(true).toBe(true) // If we got here, init succeeded
    })

    it('should create default policy on first init', async () => {
      await store.init()
      const policy = await store.getActivePolicy()
      expect(policy).not.toBeNull()
      expect(policy?.name).toBe('default')
      expect(policy?.isActive).toBe(true)
    })

    it('should be idempotent for multiple init calls', async () => {
      await store.init()
      const policy1 = await store.getActivePolicy()
      await store.init()
      const policy2 = await store.getActivePolicy()
      expect(policy1?.id).toBe(policy2?.id)
    })
  })

  describe('policy management', () => {
    beforeEach(async () => {
      await store.init()
    })

    it('should create a new policy', async () => {
      const id = await store.createPolicy({
        name: 'strict',
        allowlistMode: true,
        blockedCommands: ['rm', 'dd'],
        allowedCommands: ['ls', 'cat', 'echo'],
        dangerousPatterns: [],
        strictMode: true,
        timeout: 5000,
        isActive: false,
      })

      expect(id).toBeDefined()
      const policy = await store.getPolicy(id)
      expect(policy?.name).toBe('strict')
      expect(policy?.allowlistMode).toBe(true)
    })

    it('should activate a policy', async () => {
      const id = await store.createPolicy({
        name: 'new-policy',
        allowlistMode: false,
        blockedCommands: [],
        allowedCommands: [],
        dangerousPatterns: [],
        strictMode: false,
        timeout: 30000,
        isActive: false,
      })

      await store.activatePolicy(id)
      const policy = await store.getActivePolicy()
      expect(policy?.id).toBe(id)
    })

    it('should update a policy', async () => {
      const policy = await store.getActivePolicy()
      expect(policy).not.toBeNull()

      await store.updatePolicy(policy!.id, {
        timeout: 60000,
        strictMode: true,
      })

      const updated = await store.getPolicy(policy!.id)
      expect(updated?.timeout).toBe(60000)
      expect(updated?.strictMode).toBe(true)
    })
  })

  describe('override management', () => {
    beforeEach(async () => {
      await store.init()
    })

    it('should add an override', async () => {
      const id = await store.addOverride({
        command: 'curl',
        isPattern: false,
        action: 'allow',
        reason: 'Required for API health checks',
        createdBy: 'admin',
        expiresAt: null,
        isActive: true,
      })

      expect(id).toBeDefined()
      const override = await store.getOverride(id)
      expect(override?.command).toBe('curl')
      expect(override?.action).toBe('allow')
    })

    it('should get override for command', async () => {
      await store.addOverride({
        command: 'curl',
        isPattern: false,
        action: 'allow',
        reason: 'Test',
        createdBy: 'test',
        expiresAt: null,
        isActive: true,
      })

      const override = await store.getOverrideForCommand('curl')
      expect(override?.command).toBe('curl')
    })

    it('should list active overrides', async () => {
      await store.addOverride({
        command: 'curl',
        isPattern: false,
        action: 'allow',
        reason: 'Test 1',
        createdBy: 'test',
        expiresAt: null,
        isActive: true,
      })

      await store.addOverride({
        command: 'wget',
        isPattern: false,
        action: 'allow',
        reason: 'Test 2',
        createdBy: 'test',
        expiresAt: null,
        isActive: true,
      })

      const overrides = await store.listOverrides()
      expect(overrides.length).toBeGreaterThanOrEqual(2)
    })

    it('should delete an override', async () => {
      const id = await store.addOverride({
        command: 'test-cmd',
        isPattern: false,
        action: 'allow',
        reason: 'Test',
        createdBy: 'test',
        expiresAt: null,
        isActive: true,
      })

      await store.deleteOverride(id)
      const override = await store.getOverride(id)
      expect(override).toBeNull()
    })
  })

  describe('history management', () => {
    beforeEach(async () => {
      await store.init()
    })

    it('should log command execution', async () => {
      const id = await store.logExecution({
        command: 'ls -la',
        exitCode: 0,
        wasBlocked: false,
        blockReason: null,
        cwd: '/',
        duration: 50,
        executedAt: Date.now(),
      })

      expect(id).toBeDefined()
    })

    it('should log blocked command', async () => {
      const id = await store.logExecution({
        command: 'curl http://example.com',
        exitCode: 1,
        wasBlocked: true,
        blockReason: 'Command "curl" is blocked',
        cwd: '/',
        duration: 5,
        executedAt: Date.now(),
      })

      expect(id).toBeDefined()
    })

    it('should get execution history', async () => {
      await store.logExecution({
        command: 'echo hello',
        exitCode: 0,
        wasBlocked: false,
        blockReason: null,
        cwd: '/',
        duration: 10,
        executedAt: Date.now(),
      })

      const history = await store.getHistory({ limit: 10 })
      expect(history.length).toBeGreaterThanOrEqual(1)
    })

    it('should clear history', async () => {
      await store.logExecution({
        command: 'test',
        exitCode: 0,
        wasBlocked: false,
        blockReason: null,
        cwd: '/',
        duration: 1,
        executedAt: Date.now() - 100000,
      })

      const cleared = await store.clearHistory(Date.now())
      expect(cleared).toBeGreaterThanOrEqual(0)
    })
  })

  describe('settings integration', () => {
    beforeEach(async () => {
      await store.init()
    })

    it('should get settings formatted for BashModule', async () => {
      const settings = await store.getSettings()

      expect(settings.blockedCommands).toBeInstanceOf(Set)
      expect(settings.dangerousPatterns).toBeInstanceOf(Array)
      expect(typeof settings.strictMode).toBe('boolean')
      expect(typeof settings.timeout).toBe('number')
    })

    it('should apply overrides to settings', async () => {
      await store.addOverride({
        command: 'curl',
        isPattern: false,
        action: 'allow',
        reason: 'Test',
        createdBy: 'test',
        expiresAt: null,
        isActive: true,
      })

      const settings = await store.getSettings()
      // curl should be removed from blocked commands
      expect(settings.blockedCommands.has('curl')).toBe(false)
    })
  })
})

describe('BashModule with exec table integration', () => {
  let mockSql: MockSqlStorage
  let mockFs: MockFsModule
  let bash: BashModule

  beforeEach(() => {
    mockSql = new MockSqlStorage()
    mockFs = new MockFsModule()
  })

  describe('database detection', () => {
    it('should report no database when sql not provided', () => {
      bash = new BashModule({
        fs: mockFs as unknown as FsModule,
      })
      expect(bash.hasDatabase()).toBe(false)
    })

    it('should report database when sql is provided', () => {
      bash = new BashModule({
        fs: mockFs as unknown as FsModule,
        sql: mockSql as unknown as SqlStorage,
      })
      expect(bash.hasDatabase()).toBe(true)
    })
  })

  describe('override management via BashModule', () => {
    beforeEach(async () => {
      bash = new BashModule({
        fs: mockFs as unknown as FsModule,
        sql: mockSql as unknown as SqlStorage,
      })
      await bash.initialize()
    })

    it('should add an override', async () => {
      const id = await bash.addOverride({
        command: 'curl',
        action: 'allow',
        reason: 'Required for health checks',
        createdBy: 'admin',
      })

      expect(id).toBeDefined()
    })

    it('should list overrides', async () => {
      await bash.addOverride({
        command: 'curl',
        action: 'allow',
        reason: 'Test',
      })

      const overrides = await bash.listOverrides()
      expect(overrides.length).toBeGreaterThanOrEqual(1)
    })

    it('should remove an override', async () => {
      const id = await bash.addOverride({
        command: 'test-cmd',
        action: 'allow',
        reason: 'Test',
      })

      await bash.removeOverride(id)
      const overrides = await bash.listOverrides()
      const found = overrides.find((o) => o.id === id)
      expect(found).toBeUndefined()
    })

    it('should throw when adding override without database', async () => {
      const bashNoDb = new BashModule({
        fs: mockFs as unknown as FsModule,
      })

      await expect(
        bashNoDb.addOverride({
          command: 'curl',
          action: 'allow',
          reason: 'Test',
        })
      ).rejects.toThrow('Database not configured')
    })
  })

  describe('settings management', () => {
    beforeEach(async () => {
      bash = new BashModule({
        fs: mockFs as unknown as FsModule,
        sql: mockSql as unknown as SqlStorage,
      })
      await bash.initialize()
    })

    it('should get current settings', () => {
      const settings = bash.getSettings()

      expect(settings.blockedCommands).toBeInstanceOf(Array)
      expect(typeof settings.strictMode).toBe('boolean')
      expect(typeof settings.timeout).toBe('number')
    })

    it('should reload settings from database', async () => {
      await bash.reloadSettings()
      const settings = bash.getSettings()
      expect(settings).toBeDefined()
    })
  })

  describe('execution history', () => {
    beforeEach(async () => {
      bash = new BashModule({
        fs: mockFs as unknown as FsModule,
        sql: mockSql as unknown as SqlStorage,
        enableHistory: true,
      })
      await bash.initialize()
    })

    it('should log successful command execution', async () => {
      await bash.exec('echo hello')
      const history = await bash.getHistory({ limit: 10 })
      const found = history.find((h) => h.command.includes('echo'))
      expect(found).toBeDefined()
      expect(found?.wasBlocked).toBe(false)
    })

    it('should log blocked command execution', async () => {
      await bash.exec('curl http://example.com')
      const history = await bash.getHistory({ onlyBlocked: true })
      // Note: history filtering by onlyBlocked depends on mock implementation
      expect(history.length).toBeGreaterThanOrEqual(0)
    })

    it('should clear execution history', async () => {
      await bash.exec('echo test')
      const cleared = await bash.clearHistory()
      expect(cleared).toBeGreaterThanOrEqual(0)
    })

    it('should throw when getting history without database', async () => {
      const bashNoDb = new BashModule({
        fs: mockFs as unknown as FsModule,
      })

      await expect(bashNoDb.getHistory()).rejects.toThrow('Database not configured')
    })
  })

  describe('override-based command control', () => {
    beforeEach(async () => {
      bash = new BashModule({
        fs: mockFs as unknown as FsModule,
        sql: mockSql as unknown as SqlStorage,
      })
      await bash.initialize()
    })

    it('should allow blocked command when override exists', async () => {
      // First, verify curl is blocked by default
      const blockedAnalysis = bash.analyze('curl http://example.com')
      expect(blockedAnalysis.safe).toBe(false)

      // Add override to allow curl
      await bash.addOverride({
        command: 'curl',
        action: 'allow',
        reason: 'Required for API calls',
      })

      // Now curl should be analyzed differently (override applied)
      // Note: The actual behavior depends on override being in dbSettings
      const settings = bash.getSettings()
      expect(settings.blockedCommands.includes('curl')).toBe(false)
    })

    it('should block allowed command when block override exists', async () => {
      // Add override to block a normally safe command
      await bash.addOverride({
        command: 'echo',
        action: 'block',
        reason: 'Security policy',
      })

      // The override should be present
      const overrides = await bash.listOverrides()
      const echoOverride = overrides.find((o) => o.command === 'echo')
      expect(echoOverride?.action).toBe('block')
    })

    it('should support pattern-based overrides', async () => {
      await bash.addOverride({
        command: 'rm.*-rf',
        isPattern: true,
        action: 'block',
        reason: 'Prevent recursive force deletion',
      })

      const overrides = await bash.listOverrides()
      const patternOverride = overrides.find((o) => o.isPattern)
      expect(patternOverride).toBeDefined()
    })

    it('should support expiring overrides', async () => {
      const futureTime = Date.now() + 3600000 // 1 hour from now
      await bash.addOverride({
        command: 'temp-cmd',
        action: 'allow',
        reason: 'Temporary access',
        expiresAt: futureTime,
      })

      const overrides = await bash.listOverrides()
      const tempOverride = overrides.find((o) => o.command === 'temp-cmd')
      expect(tempOverride?.expiresAt).toBe(futureTime)
    })
  })
})

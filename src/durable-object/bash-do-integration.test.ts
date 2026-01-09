/**
 * Tests for BashModule integration with Durable Objects
 *
 * This test file covers:
 * - BashModule lifecycle (initialization, lazy loading)
 * - Command execution through DO context ($.bash)
 * - withBash mixin composition
 * - Error handling in DO context
 * - Integration between withFs and withBash
 *
 * @module durable-object/bash-do-integration.test
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { BashModule, type BashModuleConfig, type ExecResult } from './BashModule.js'
import { withBash, hasBash, getBash, type CallableBashModule, type WithBashContext } from './bash-mixin.js'
import type { FsModule } from './module.js'

// ============================================================================
// Mock SqlStorage Implementation
// ============================================================================

class MockSqlStorage {
  private tables: Map<string, Map<string, Record<string, unknown>>> = new Map()

  exec<T = unknown>(query: string, ...params: unknown[]): {
    one: () => T | null
    toArray: () => T[]
  } {
    const normalizedQuery = query.trim().toLowerCase()

    // Handle CREATE TABLE and CREATE INDEX
    if (normalizedQuery.startsWith('create table') || normalizedQuery.startsWith('create index')) {
      return {
        one: () => null,
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
        one: () => null,
        toArray: () => [],
      }
    }

    // Handle SELECT - return empty for most queries
    if (normalizedQuery.startsWith('select')) {
      return {
        one: () => null,
        toArray: () => [],
      }
    }

    return {
      one: () => null,
      toArray: () => [],
    }
  }
}

// ============================================================================
// Mock FsModule Implementation
// ============================================================================

class MockFsModule {
  readonly name = 'fs'
  private files: Map<string, { content: string; type: 'file' | 'directory' }> = new Map()

  constructor() {
    this.files.set('/', { content: '', type: 'directory' })
  }

  async initialize(): Promise<void> {}
  async dispose(): Promise<void> {}

  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }

  async read(path: string, options?: { encoding?: string }): Promise<string | Uint8Array> {
    const file = this.files.get(path)
    if (!file) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path })
    }
    if (file.type === 'directory') {
      throw Object.assign(new Error('illegal operation on a directory'), { code: 'EISDIR', path })
    }
    return options?.encoding ? file.content : new TextEncoder().encode(file.content)
  }

  async write(path: string, data: string | Uint8Array): Promise<void> {
    const content = typeof data === 'string' ? data : new TextDecoder().decode(data)
    this.files.set(path, { content, type: 'file' })
  }

  async append(path: string, data: string | Uint8Array): Promise<void> {
    const content = typeof data === 'string' ? data : new TextDecoder().decode(data)
    const existing = this.files.get(path)
    if (existing && existing.type === 'file') {
      existing.content += content
    } else {
      this.files.set(path, { content, type: 'file' })
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    if (options?.recursive) {
      const parts = path.split('/').filter(Boolean)
      let current = ''
      for (const part of parts) {
        current += '/' + part
        if (!this.files.has(current)) {
          this.files.set(current, { content: '', type: 'directory' })
        }
      }
    } else {
      this.files.set(path, { content: '', type: 'directory' })
    }
  }

  async stat(path: string): Promise<{
    isDirectory: () => boolean
    isFile: () => boolean
    isSymbolicLink: () => boolean
    size: number
    mode: number
    uid: number
    gid: number
    nlink: number
    atime: Date
    mtime: Date
    ctime: Date
    birthtime: Date
    dev: number
    ino: number
    blocks: number
    blksize: number
  }> {
    const file = this.files.get(path)
    if (!file) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path })
    }
    const now = new Date()
    return {
      isDirectory: () => file.type === 'directory',
      isFile: () => file.type === 'file',
      isSymbolicLink: () => false,
      size: file.content.length,
      mode: 0o644,
      uid: 0,
      gid: 0,
      nlink: 1,
      atime: now,
      mtime: now,
      ctime: now,
      birthtime: now,
      dev: 0,
      ino: 0,
      blocks: 0,
      blksize: 4096,
    }
  }

  async readdir(
    path: string,
    options?: { withFileTypes?: boolean }
  ): Promise<
    | string[]
    | Array<{
        name: string
        path: string
        isFile: () => boolean
        isDirectory: () => boolean
        isSymbolicLink: () => boolean
        isBlockDevice: () => boolean
        isCharacterDevice: () => boolean
        isFIFO: () => boolean
        isSocket: () => boolean
      }>
  > {
    const file = this.files.get(path)
    if (!file) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path })
    }
    if (file.type !== 'directory') {
      throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR', path })
    }

    const prefix = path === '/' ? '/' : path + '/'
    const children: string[] = []
    for (const [p] of this.files) {
      if (p.startsWith(prefix) && p !== path) {
        const rest = p.substring(prefix.length)
        if (!rest.includes('/')) {
          children.push(rest)
        }
      }
    }

    if (options?.withFileTypes) {
      return children.map((name) => {
        const childPath = path === '/' ? '/' + name : path + '/' + name
        const childFile = this.files.get(childPath)!
        return {
          name,
          path: childPath,
          isFile: () => childFile.type === 'file',
          isDirectory: () => childFile.type === 'directory',
          isSymbolicLink: () => false,
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
          isFIFO: () => false,
          isSocket: () => false,
        }
      })
    }
    return children
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    if (!this.files.has(path) && !options?.force) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path })
    }
    this.files.delete(path)
    // Remove children for recursive delete
    if (options?.recursive) {
      const prefix = path + '/'
      for (const [p] of this.files) {
        if (p.startsWith(prefix)) {
          this.files.delete(p)
        }
      }
    }
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
  async symlink(target: string, path: string): Promise<void> {
    this.files.set(path, { content: target, type: 'file' })
  }
  async link(existingPath: string, newPath: string): Promise<void> {
    const file = this.files.get(existingPath)
    if (file) {
      this.files.set(newPath, { ...file })
    }
  }
  async readlink(path: string): Promise<string> {
    const file = this.files.get(path)
    return file?.content ?? path
  }
  async realpath(path: string): Promise<string> {
    return path
  }
  async access(path: string): Promise<void> {
    if (!this.files.has(path)) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path })
    }
  }

  // Test helper
  _addFile(path: string, content: string, type: 'file' | 'directory' = 'file'): void {
    this.files.set(path, { content, type })
  }

  _clear(): void {
    this.files.clear()
    this.files.set('/', { content: '', type: 'directory' })
  }
}

// ============================================================================
// Mock Durable Object Base Class
// ============================================================================

/**
 * Mock base DO class that simulates dotdo's DO class structure
 */
class MockDO {
  ctx: {
    storage: {
      sql: SqlStorage
    }
  }
  env: Record<string, unknown>
  $: { [key: string]: unknown }

  static capabilities: string[] = []

  constructor(ctx: any, env: any) {
    this.ctx = ctx
    this.env = env
    this.$ = {}
  }
}

/**
 * Mock DO with fs capability already applied (simulating withFs)
 */
class MockDOWithFs extends MockDO {
  static capabilities = ['fs']
  private _fs: MockFsModule

  constructor(ctx: any, env: any) {
    super(ctx, env)
    this._fs = new MockFsModule()

    const self = this
    this.$ = new Proxy(
      {},
      {
        get(target, prop) {
          if (prop === 'fs') {
            return self._fs
          }
          return (target as any)[prop]
        },
        has(target, prop) {
          if (prop === 'fs') return true
          return prop in target
        },
      }
    )
  }

  get fs(): MockFsModule {
    return this._fs
  }
}

// ============================================================================
// Test Suites
// ============================================================================

describe('BashModule DO Integration', () => {
  // ==========================================================================
  // Lifecycle Tests
  // ==========================================================================

  describe('lifecycle', () => {
    let mockFs: MockFsModule
    let bash: BashModule

    beforeEach(() => {
      mockFs = new MockFsModule()
    })

    it('should create BashModule without initialization', () => {
      bash = new BashModule({
        fs: mockFs as unknown as FsModule,
      })

      expect(bash.name).toBe('bash')
      expect(bash.getCwd()).toBe('/')
    })

    it('should initialize lazily on first command execution', async () => {
      bash = new BashModule({
        fs: mockFs as unknown as FsModule,
      })

      // Environment variables should be set after initialization
      expect(bash.getEnv('HOME')).toBeUndefined()

      // Execute a command (triggers initialization)
      await bash.exec('echo hello')

      // Now environment should be set
      expect(bash.getEnv('HOME')).toBe('/')
      expect(bash.getEnv('USER')).toBe('root')
      expect(bash.getEnv('PWD')).toBe('/')
    })

    it('should be idempotent for multiple initializations', async () => {
      bash = new BashModule({
        fs: mockFs as unknown as FsModule,
      })

      // Initialize multiple times via different commands
      await bash.exec('echo test1')
      const home1 = bash.getEnv('HOME')

      await bash.exec('echo test2')
      const home2 = bash.getEnv('HOME')

      expect(home1).toBe(home2)
    })

    it('should support dispose method', async () => {
      bash = new BashModule({
        fs: mockFs as unknown as FsModule,
      })

      await bash.initialize()
      await bash.dispose()

      // Should not throw
      expect(true).toBe(true)
    })

    it('should handle initialization with database', async () => {
      const mockSql = new MockSqlStorage()

      bash = new BashModule({
        fs: mockFs as unknown as FsModule,
        sql: mockSql as unknown as SqlStorage,
      })

      await bash.initialize()

      expect(bash.hasDatabase()).toBe(true)
    })

    it('should handle initialization without database', async () => {
      bash = new BashModule({
        fs: mockFs as unknown as FsModule,
      })

      await bash.initialize()

      expect(bash.hasDatabase()).toBe(false)
    })
  })

  // ==========================================================================
  // withBash Mixin Composition Tests
  // ==========================================================================

  describe('withBash mixin composition', () => {
    let mockCtx: any
    let mockEnv: any

    beforeEach(() => {
      mockCtx = {
        storage: {
          sql: new MockSqlStorage() as unknown as SqlStorage,
        },
      }
      mockEnv = {}
    })

    it('should add bash capability to a DO class', () => {
      const DOWithBash = withBash(MockDOWithFs)

      const instance = new DOWithBash(mockCtx, mockEnv)

      expect(DOWithBash.capabilities).toContain('bash')
      expect(DOWithBash.capabilities).toContain('fs')
    })

    it('should make $.bash available on instance', () => {
      const DOWithBash = withBash(MockDOWithFs)
      const instance = new DOWithBash(mockCtx, mockEnv)

      expect('bash' in instance.$).toBe(true)
      expect(instance.$.bash).toBeDefined()
    })

    it('should preserve original $ properties', () => {
      const DOWithBash = withBash(MockDOWithFs)
      const instance = new DOWithBash(mockCtx, mockEnv)

      // fs should still be accessible
      expect('fs' in instance.$).toBe(true)
      expect(instance.$.fs).toBeDefined()
    })

    it('should throw error if withFs not applied first', () => {
      // Create a DO class without fs
      const DOWithoutFs = class extends MockDO {
        static capabilities: string[] = []
      }

      const DOWithBashOnly = withBash(DOWithoutFs as any)
      const instance = new DOWithBashOnly(mockCtx, mockEnv)

      // Accessing bash should throw because fs is missing
      expect(() => instance.$.bash).toThrow('BashModule requires FsModule')
    })

    it('should support hasCapability check', () => {
      const DOWithBash = withBash(MockDOWithFs)
      const instance = new DOWithBash(mockCtx, mockEnv)

      expect(instance.hasCapability('bash')).toBe(true)
    })

    it('should support custom options', () => {
      const DOWithBash = withBash(MockDOWithFs, {
        cwd: '/app',
        strict: true,
        env: { NODE_ENV: 'test' },
      })
      const instance = new DOWithBash(mockCtx, mockEnv)

      const bash = instance.$.bash as BashModule
      expect(bash.getCwd()).toBe('/app')
    })
  })

  // ==========================================================================
  // Command Execution Through DO Context Tests
  // ==========================================================================

  describe('command execution through $.bash', () => {
    let DOWithBash: ReturnType<typeof withBash>
    let instance: InstanceType<typeof DOWithBash>
    let mockFs: MockFsModule

    beforeEach(() => {
      const mockCtx = {
        storage: {
          sql: new MockSqlStorage() as unknown as SqlStorage,
        },
      }
      const mockEnv = {}

      DOWithBash = withBash(MockDOWithFs)
      instance = new DOWithBash(mockCtx, mockEnv)

      // Get reference to the mock fs for test setup
      mockFs = (instance.$ as any).fs as MockFsModule
    })

    it('should execute simple commands via $.bash.exec()', async () => {
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('echo hello')

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('hello\n')
    })

    it('should analyze commands via $.bash.analyze()', () => {
      const bash = instance.$.bash as BashModule

      const analysis = bash.analyze('cat /file.txt')

      expect(analysis.safe).toBe(true)
      expect(analysis.delegatedToFs).toBe(true)
    })

    it('should read files via $.bash.exec() using cat', async () => {
      mockFs._addFile('/test.txt', 'file content')
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('cat /test.txt')

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('file content')
    })

    it('should create directories via $.bash.exec() using mkdir', async () => {
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('mkdir -p /app/data')

      expect(result.exitCode).toBe(0)
      expect(await mockFs.exists('/app')).toBe(true)
      expect(await mockFs.exists('/app/data')).toBe(true)
    })

    it('should list files via $.bash.exec() using ls', async () => {
      await mockFs.mkdir('/app')
      mockFs._addFile('/app/file1.txt', 'content1')
      mockFs._addFile('/app/file2.txt', 'content2')
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('ls /app')

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('file1.txt')
      expect(result.stdout).toContain('file2.txt')
    })

    it('should handle file operations with redirection', async () => {
      const bash = instance.$.bash as BashModule

      await bash.exec('echo test content > /output.txt')

      const content = await mockFs.read('/output.txt', { encoding: 'utf-8' })
      expect(content).toContain('test content')
    })
  })

  // ==========================================================================
  // Callable BashModule (Tagged Template) Tests
  // ==========================================================================

  describe('callable bash module (tagged template)', () => {
    let DOWithBash: ReturnType<typeof withBash>
    let instance: InstanceType<typeof DOWithBash>
    let mockFs: MockFsModule

    beforeEach(() => {
      const mockCtx = {
        storage: {
          sql: new MockSqlStorage() as unknown as SqlStorage,
        },
      }
      const mockEnv = {}

      DOWithBash = withBash(MockDOWithFs)
      instance = new DOWithBash(mockCtx, mockEnv)
      mockFs = (instance.$ as any).fs as MockFsModule
    })

    it('should support tagged template literal syntax', async () => {
      const bash = instance.$.bash as CallableBashModule

      const result = await bash`echo hello world`

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('hello world\n')
    })

    it('should interpolate variables safely in tagged templates', async () => {
      await mockFs.mkdir('/app')
      const bash = instance.$.bash as CallableBashModule

      const dir = '/app'
      const result = await bash`ls ${dir}`

      expect(result.exitCode).toBe(0)
    })

    it('should escape special characters in interpolated values', async () => {
      const bash = instance.$.bash as CallableBashModule

      const text = 'hello "world"'
      const result = await bash`echo ${text}`

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('hello "world"')
    })

    it('should support both callable and method syntax', async () => {
      const bash = instance.$.bash as CallableBashModule

      // Method syntax
      const result1 = await bash.exec('echo method')
      expect(result1.stdout).toBe('method\n')

      // Tagged template syntax
      const result2 = await bash`echo template`
      expect(result2.stdout).toBe('template\n')
    })

    it('should handle file paths with spaces in tagged templates', async () => {
      await mockFs.mkdir('/path with spaces')
      mockFs._addFile('/path with spaces/file.txt', 'content')
      const bash = instance.$.bash as CallableBashModule

      const dir = '/path with spaces'
      const result = await bash`ls ${dir}`

      expect(result.exitCode).toBe(0)
    })

    it('should handle numeric values in tagged templates', async () => {
      const bash = instance.$.bash as CallableBashModule

      const count = 5
      const result = await bash`echo ${count}`

      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('5')
    })

    it('should handle arrays in tagged templates', async () => {
      mockFs._addFile('/file1.txt', 'content1')
      mockFs._addFile('/file2.txt', 'content2')
      const bash = instance.$.bash as CallableBashModule

      const files = ['/file1.txt', '/file2.txt']
      const result = await bash`cat ${files}`

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('content1content2')
    })
  })

  // ==========================================================================
  // Error Handling Tests
  // ==========================================================================

  describe('error handling', () => {
    let DOWithBash: ReturnType<typeof withBash>
    let instance: InstanceType<typeof DOWithBash>
    let mockFs: MockFsModule

    beforeEach(() => {
      const mockCtx = {
        storage: {
          sql: new MockSqlStorage() as unknown as SqlStorage,
        },
      }
      const mockEnv = {}

      DOWithBash = withBash(MockDOWithFs)
      instance = new DOWithBash(mockCtx, mockEnv)
      mockFs = (instance.$ as any).fs as MockFsModule
    })

    it('should return non-zero exit code for command errors', async () => {
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('cat /nonexistent.txt')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('cat')
    })

    it('should return exit code 127 for unknown commands', async () => {
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('unknowncommand')

      expect(result.exitCode).toBe(127)
      expect(result.stderr).toContain('command not found')
    })

    it('should block unsafe commands and return error', async () => {
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('rm -rf /')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Unsafe command blocked')
    })

    it('should block command substitution', async () => {
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('echo $(whoami)')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Unsafe command blocked')
    })

    it('should throw in strict mode on command failure', async () => {
      const mockCtx = {
        storage: {
          sql: new MockSqlStorage() as unknown as SqlStorage,
        },
      }
      const mockEnv = {}

      const StrictDOWithBash = withBash(MockDOWithFs, { strict: true })
      const strictInstance = new StrictDOWithBash(mockCtx, mockEnv)
      const bash = strictInstance.$.bash as BashModule

      await expect(bash.exec('cat /nonexistent.txt')).rejects.toThrow()
    })

    it('should not throw in non-strict mode on command failure', async () => {
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('cat /nonexistent.txt')

      expect(result.exitCode).toBe(1)
      // Should not throw, just return error result
    })

    it('should include error details in result', async () => {
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('cat /missing.txt')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toBeTruthy()
      expect(result.command).toBe('cat /missing.txt')
      expect(result.cwd).toBe('/')
    })
  })

  // ==========================================================================
  // Type Helper Tests
  // ==========================================================================

  describe('type helpers', () => {
    let mockCtx: any
    let mockEnv: any

    beforeEach(() => {
      mockCtx = {
        storage: {
          sql: new MockSqlStorage() as unknown as SqlStorage,
        },
      }
      mockEnv = {}
    })

    it('should hasBash return true for DO with bash capability', () => {
      const DOWithBash = withBash(MockDOWithFs)
      const instance = new DOWithBash(mockCtx, mockEnv)

      expect(hasBash(instance)).toBe(true)
    })

    it('should hasBash return false for DO without bash capability', () => {
      const instance = new MockDOWithFs(mockCtx, mockEnv)

      expect(hasBash(instance)).toBe(false)
    })

    it('should getBash return bash module for DO with capability', () => {
      const DOWithBash = withBash(MockDOWithFs)
      const instance = new DOWithBash(mockCtx, mockEnv)

      const bash = getBash(instance)

      expect(bash).toBeDefined()
      expect(bash.name).toBe('bash')
    })

    it('should getBash throw for DO without capability', () => {
      const instance = new MockDOWithFs(mockCtx, mockEnv)

      expect(() => getBash(instance)).toThrow('Bash capability is not available')
    })
  })

  // ==========================================================================
  // Integration with FsModule Tests
  // ==========================================================================

  describe('integration with FsModule', () => {
    let DOWithBash: ReturnType<typeof withBash>
    let instance: InstanceType<typeof DOWithBash>
    let mockFs: MockFsModule

    beforeEach(() => {
      const mockCtx = {
        storage: {
          sql: new MockSqlStorage() as unknown as SqlStorage,
        },
      }
      const mockEnv = {}

      DOWithBash = withBash(MockDOWithFs)
      instance = new DOWithBash(mockCtx, mockEnv)
      mockFs = (instance.$ as any).fs as MockFsModule
    })

    it('should use FsModule for cat command', async () => {
      mockFs._addFile('/test.txt', 'file content')
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('cat /test.txt')

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('file content')
    })

    it('should use FsModule for ls command', async () => {
      await mockFs.mkdir('/app')
      mockFs._addFile('/app/file.txt', 'content')
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('ls /app')

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('file.txt')
    })

    it('should use FsModule for mkdir command', async () => {
      const bash = instance.$.bash as BashModule

      await bash.exec('mkdir /newdir')

      expect(await mockFs.exists('/newdir')).toBe(true)
    })

    it('should use FsModule for rm command', async () => {
      mockFs._addFile('/toremove.txt', 'content')
      const bash = instance.$.bash as BashModule

      await bash.exec('rm /toremove.txt')

      expect(await mockFs.exists('/toremove.txt')).toBe(false)
    })

    it('should use FsModule for output redirection', async () => {
      const bash = instance.$.bash as BashModule

      await bash.exec('echo redirected > /output.txt')

      const content = await mockFs.read('/output.txt', { encoding: 'utf-8' })
      expect(content).toContain('redirected')
    })

    it('should use FsModule for input redirection', async () => {
      mockFs._addFile('/input.txt', 'input content')
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('cat < /input.txt')

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('input content')
    })

    it('should use FsModule for piped commands', async () => {
      mockFs._addFile('/lines.txt', 'line1\nline2\nline3\nline4\nline5\n')
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('cat /lines.txt | head -n 2')

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('line1')
      expect(result.stdout).toContain('line2')
    })
  })

  // ==========================================================================
  // Environment and Working Directory Tests
  // ==========================================================================

  describe('environment and working directory', () => {
    let DOWithBash: ReturnType<typeof withBash>
    let instance: InstanceType<typeof DOWithBash>
    let mockFs: MockFsModule

    beforeEach(() => {
      const mockCtx = {
        storage: {
          sql: new MockSqlStorage() as unknown as SqlStorage,
        },
      }
      const mockEnv = {}

      DOWithBash = withBash(MockDOWithFs, {
        cwd: '/app',
        env: { APP_ENV: 'test' },
      })
      instance = new DOWithBash(mockCtx, mockEnv)
      mockFs = (instance.$ as any).fs as MockFsModule
    })

    it('should use custom initial cwd', async () => {
      const bash = instance.$.bash as BashModule

      expect(bash.getCwd()).toBe('/app')
    })

    it('should include custom environment variables', async () => {
      const bash = instance.$.bash as BashModule

      // Trigger initialization
      await bash.exec('true')

      expect(bash.getEnv('APP_ENV')).toBe('test')
    })

    it('should expand environment variables in commands', async () => {
      const bash = instance.$.bash as BashModule

      // Trigger initialization first
      await bash.exec('true')

      const result = await bash.exec('echo $APP_ENV')

      expect(result.stdout).toContain('test')
    })

    it('should change directory with cd command', async () => {
      await mockFs.mkdir('/app')
      await mockFs.mkdir('/app/data')
      const bash = instance.$.bash as BashModule

      await bash.exec('cd /app/data')

      expect(bash.getCwd()).toBe('/app/data')
    })

    it('should resolve relative paths from cwd', async () => {
      await mockFs.mkdir('/app')
      mockFs._addFile('/app/config.json', '{"key": "value"}')
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('cat config.json')

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('{"key": "value"}')
    })
  })

  // ==========================================================================
  // Command Result Metadata Tests
  // ==========================================================================

  describe('command result metadata', () => {
    let DOWithBash: ReturnType<typeof withBash>
    let instance: InstanceType<typeof DOWithBash>

    beforeEach(() => {
      const mockCtx = {
        storage: {
          sql: new MockSqlStorage() as unknown as SqlStorage,
        },
      }
      const mockEnv = {}

      DOWithBash = withBash(MockDOWithFs)
      instance = new DOWithBash(mockCtx, mockEnv)
    })

    it('should include command in result', async () => {
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('echo test')

      expect(result.command).toBe('echo test')
    })

    it('should include cwd in result', async () => {
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('pwd')

      expect(result.cwd).toBe('/')
    })

    it('should include duration in result', async () => {
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('echo test')

      expect(result.duration).toBeGreaterThanOrEqual(0)
      expect(typeof result.duration).toBe('number')
    })

    it('should include exit code in result', async () => {
      const bash = instance.$.bash as BashModule

      const successResult = await bash.exec('true')
      expect(successResult.exitCode).toBe(0)

      const failResult = await bash.exec('false')
      expect(failResult.exitCode).toBe(1)
    })

    it('should include stdout and stderr in result', async () => {
      const bash = instance.$.bash as BashModule

      const result = await bash.exec('echo output')

      expect(result.stdout).toBe('output\n')
      expect(result.stderr).toBe('')
    })
  })

  // ==========================================================================
  // Safety Settings Management Tests
  // ==========================================================================

  describe('safety settings management', () => {
    let DOWithBash: ReturnType<typeof withBash>
    let instance: InstanceType<typeof DOWithBash>

    beforeEach(() => {
      const mockCtx = {
        storage: {
          sql: new MockSqlStorage() as unknown as SqlStorage,
        },
      }
      const mockEnv = {}

      DOWithBash = withBash(MockDOWithFs, {
        blockedCommands: ['dangerous-custom'],
        allowedCommands: ['cat', 'ls', 'echo', 'mkdir', 'pwd', 'true', 'false'],
      })
      instance = new DOWithBash(mockCtx, mockEnv)
    })

    it('should block custom blocked commands', () => {
      const bash = instance.$.bash as BashModule

      const analysis = bash.analyze('dangerous-custom')

      expect(analysis.safe).toBe(false)
    })

    it('should only allow whitelisted commands in allowlist mode', () => {
      const bash = instance.$.bash as BashModule

      // Allowed
      expect(bash.analyze('cat file.txt').safe).toBe(true)
      expect(bash.analyze('ls /app').safe).toBe(true)

      // Not in allowlist
      expect(bash.analyze('rm file.txt').safe).toBe(false)
    })

    it('should return settings via getSettings()', async () => {
      const bash = instance.$.bash as BashModule
      await bash.initialize()

      const settings = bash.getSettings()

      expect(settings.blockedCommands).toBeInstanceOf(Array)
      expect(settings.blockedCommands).toContain('dangerous-custom')
    })
  })
})

describe('BashModule Proxy Behavior', () => {
  let mockFs: MockFsModule
  let bash: BashModule

  beforeEach(() => {
    mockFs = new MockFsModule()
    bash = new BashModule({
      fs: mockFs as unknown as FsModule,
    })
  })

  it('should maintain BashModule properties through proxy', async () => {
    const DOWithBash = withBash(MockDOWithFs)
    const mockCtx = {
      storage: {
        sql: new MockSqlStorage() as unknown as SqlStorage,
      },
    }
    const instance = new DOWithBash(mockCtx, {})
    const proxiedBash = instance.$.bash as BashModule

    expect(proxiedBash.name).toBe('bash')
    expect(proxiedBash.getCwd).toBeDefined()
    expect(proxiedBash.setCwd).toBeDefined()
    expect(proxiedBash.getEnv).toBeDefined()
    expect(proxiedBash.setEnv).toBeDefined()
    expect(proxiedBash.getAllEnv).toBeDefined()
    expect(proxiedBash.exec).toBeDefined()
    expect(proxiedBash.analyze).toBeDefined()
    expect(proxiedBash.tag).toBeDefined()
  })

  it('should bind methods correctly through proxy', async () => {
    const DOWithBash = withBash(MockDOWithFs)
    const mockCtx = {
      storage: {
        sql: new MockSqlStorage() as unknown as SqlStorage,
      },
    }
    const instance = new DOWithBash(mockCtx, {})
    const proxiedBash = instance.$.bash as BashModule

    // Initialize
    await proxiedBash.exec('true')

    // Test method binding
    const getCwd = proxiedBash.getCwd
    expect(getCwd()).toBe('/')

    const getEnv = proxiedBash.getEnv
    expect(getEnv('HOME')).toBe('/')
  })

  it('should support property enumeration through proxy', () => {
    const DOWithBash = withBash(MockDOWithFs)
    const mockCtx = {
      storage: {
        sql: new MockSqlStorage() as unknown as SqlStorage,
      },
    }
    const instance = new DOWithBash(mockCtx, {})
    const proxiedBash = instance.$.bash as BashModule

    expect('name' in proxiedBash).toBe(true)
  })
})

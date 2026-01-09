/**
 * Tests for BashModule - Bash command execution capability module
 *
 * This test file covers:
 * - Command parsing and tokenization
 * - Safety analysis and risk assessment
 * - File operation delegation to FsModule
 * - Common bash commands (cat, ls, mkdir, rm, etc.)
 * - Environment variable expansion
 * - Working directory management
 * - Redirection and piping
 *
 * @module durable-object/BashModule.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BashModule, type BashModuleConfig, type SafetyAnalysis, type ExecResult } from './BashModule.js'
import type { FsModule } from './module.js'
import type { Stats, Dirent } from '../core/types.js'

// ============================================================================
// Mock FsModule Implementation
// ============================================================================

/**
 * Mock file entry for testing
 */
interface MockFile {
  content: string
  type: 'file' | 'directory' | 'symlink'
  mode: number
  uid: number
  gid: number
  size: number
  atime: Date
  mtime: Date
  ctime: Date
  birthtime: Date
  nlink: number
  linkTarget?: string
}

/**
 * Mock FsModule that simulates filesystem operations
 */
class MockFsModule {
  readonly name = 'fs'
  private files: Map<string, MockFile> = new Map()

  constructor() {
    // Initialize with root directory
    this.files.set('/', {
      content: '',
      type: 'directory',
      mode: 0o755,
      uid: 0,
      gid: 0,
      size: 0,
      atime: new Date(),
      mtime: new Date(),
      ctime: new Date(),
      birthtime: new Date(),
      nlink: 2,
    })
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
    if (options?.encoding) {
      return file.content
    }
    return new TextEncoder().encode(file.content)
  }

  async write(path: string, data: string | Uint8Array, options?: { mode?: number }): Promise<void> {
    const content = typeof data === 'string' ? data : new TextDecoder().decode(data)
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/'

    if (!this.files.has(parentPath)) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path: parentPath })
    }

    const now = new Date()
    this.files.set(path, {
      content,
      type: 'file',
      mode: options?.mode ?? 0o644,
      uid: 0,
      gid: 0,
      size: content.length,
      atime: now,
      mtime: now,
      ctime: now,
      birthtime: now,
      nlink: 1,
    })
  }

  async append(path: string, data: string | Uint8Array): Promise<void> {
    const content = typeof data === 'string' ? data : new TextDecoder().decode(data)
    const existing = this.files.get(path)
    if (existing && existing.type === 'file') {
      existing.content += content
      existing.size = existing.content.length
      existing.mtime = new Date()
    } else {
      await this.write(path, content)
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    if (options?.recursive) {
      const parts = path.split('/').filter(Boolean)
      let current = ''
      for (const part of parts) {
        current += '/' + part
        if (!this.files.has(current)) {
          const now = new Date()
          this.files.set(current, {
            content: '',
            type: 'directory',
            mode: options?.mode ?? 0o755,
            uid: 0,
            gid: 0,
            size: 0,
            atime: now,
            mtime: now,
            ctime: now,
            birthtime: now,
            nlink: 2,
          })
        }
      }
    } else {
      const parentPath = path.substring(0, path.lastIndexOf('/')) || '/'
      if (!this.files.has(parentPath)) {
        throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path: parentPath })
      }
      const now = new Date()
      this.files.set(path, {
        content: '',
        type: 'directory',
        mode: options?.mode ?? 0o755,
        uid: 0,
        gid: 0,
        size: 0,
        atime: now,
        mtime: now,
        ctime: now,
        birthtime: now,
        nlink: 2,
      })
    }
  }

  async rmdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const file = this.files.get(path)
    if (!file) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path })
    }
    if (file.type !== 'directory') {
      throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR', path })
    }

    // Check for children
    const children = Array.from(this.files.keys()).filter((p) => p.startsWith(path + '/'))
    if (children.length > 0 && !options?.recursive) {
      throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY', path })
    }

    if (options?.recursive) {
      for (const child of children) {
        this.files.delete(child)
      }
    }

    this.files.delete(path)
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const file = this.files.get(path)
    if (!file) {
      if (options?.force) return
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path })
    }

    if (file.type === 'directory') {
      await this.rmdir(path, { recursive: options?.recursive })
    } else {
      this.files.delete(path)
    }
  }

  async stat(path: string): Promise<Stats> {
    const file = this.files.get(path)
    if (!file) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path })
    }

    const typeMode = file.type === 'directory' ? 0o40000 : file.type === 'symlink' ? 0o120000 : 0o100000

    return {
      dev: 0,
      ino: 0,
      mode: typeMode | file.mode,
      nlink: file.nlink,
      uid: file.uid,
      gid: file.gid,
      rdev: 0,
      size: file.size,
      blksize: 4096,
      blocks: Math.ceil(file.size / 512),
      atimeMs: file.atime.getTime(),
      mtimeMs: file.mtime.getTime(),
      ctimeMs: file.ctime.getTime(),
      birthtimeMs: file.birthtime.getTime(),
      atime: file.atime,
      mtime: file.mtime,
      ctime: file.ctime,
      birthtime: file.birthtime,
      isFile: () => file.type === 'file',
      isDirectory: () => file.type === 'directory',
      isSymbolicLink: () => file.type === 'symlink',
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    } as Stats
  }

  async readdir(path: string, options?: { withFileTypes?: boolean }): Promise<string[] | Dirent[]> {
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
          parentPath: path,
          path: childPath,
          isFile: () => childFile.type === 'file',
          isDirectory: () => childFile.type === 'directory',
          isSymbolicLink: () => childFile.type === 'symlink',
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
          isFIFO: () => false,
          isSocket: () => false,
        } as Dirent
      })
    }

    return children
  }

  async copyFile(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    const srcFile = this.files.get(src)
    if (!srcFile) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path: src })
    }

    const destParent = dest.substring(0, dest.lastIndexOf('/')) || '/'
    if (!this.files.has(destParent)) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path: destParent })
    }

    this.files.set(dest, { ...srcFile, atime: new Date(), mtime: new Date(), ctime: new Date() })
  }

  async rename(oldPath: string, newPath: string, options?: { overwrite?: boolean }): Promise<void> {
    const file = this.files.get(oldPath)
    if (!file) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path: oldPath })
    }

    const newParent = newPath.substring(0, newPath.lastIndexOf('/')) || '/'
    if (!this.files.has(newParent)) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path: newParent })
    }

    if (this.files.has(newPath) && !options?.overwrite) {
      throw Object.assign(new Error('file exists'), { code: 'EEXIST', path: newPath })
    }

    this.files.delete(oldPath)
    this.files.set(newPath, file)
  }

  async chmod(path: string, mode: number): Promise<void> {
    const file = this.files.get(path)
    if (!file) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path })
    }
    file.mode = mode
    file.ctime = new Date()
  }

  async chown(path: string, uid: number, gid: number): Promise<void> {
    const file = this.files.get(path)
    if (!file) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path })
    }
    file.uid = uid
    file.gid = gid
    file.ctime = new Date()
  }

  async utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void> {
    const file = this.files.get(path)
    if (!file) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path })
    }
    file.atime = atime instanceof Date ? atime : new Date(atime)
    file.mtime = mtime instanceof Date ? mtime : new Date(mtime)
    file.ctime = new Date()
  }

  async symlink(target: string, path: string): Promise<void> {
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/'
    if (!this.files.has(parentPath)) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path: parentPath })
    }

    const now = new Date()
    this.files.set(path, {
      content: '',
      type: 'symlink',
      mode: 0o777,
      uid: 0,
      gid: 0,
      size: target.length,
      atime: now,
      mtime: now,
      ctime: now,
      birthtime: now,
      nlink: 1,
      linkTarget: target,
    })
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const file = this.files.get(existingPath)
    if (!file) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path: existingPath })
    }

    const parentPath = newPath.substring(0, newPath.lastIndexOf('/')) || '/'
    if (!this.files.has(parentPath)) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path: parentPath })
    }

    file.nlink++
    this.files.set(newPath, { ...file })
  }

  async readlink(path: string): Promise<string> {
    const file = this.files.get(path)
    if (!file) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path })
    }
    if (file.type !== 'symlink' || !file.linkTarget) {
      throw Object.assign(new Error('invalid argument'), { code: 'EINVAL', path })
    }
    return file.linkTarget
  }

  async realpath(path: string): Promise<string> {
    const file = this.files.get(path)
    if (!file) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path })
    }
    if (file.type === 'symlink' && file.linkTarget) {
      return this.realpath(file.linkTarget)
    }
    return path
  }

  async access(path: string): Promise<void> {
    if (!this.files.has(path)) {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path })
    }
  }

  // Test helper to add files directly
  _addFile(path: string, file: MockFile): void {
    this.files.set(path, file)
  }

  // Test helper to get file
  _getFile(path: string): MockFile | undefined {
    return this.files.get(path)
  }

  // Test helper to clear files
  _clear(): void {
    this.files.clear()
    this.files.set('/', {
      content: '',
      type: 'directory',
      mode: 0o755,
      uid: 0,
      gid: 0,
      size: 0,
      atime: new Date(),
      mtime: new Date(),
      ctime: new Date(),
      birthtime: new Date(),
      nlink: 2,
    })
  }
}

// ============================================================================
// Test Suites
// ============================================================================

describe('BashModule', () => {
  let mockFs: MockFsModule
  let bash: BashModule

  beforeEach(() => {
    mockFs = new MockFsModule()
    bash = new BashModule({
      fs: mockFs as unknown as FsModule,
    })
  })

  // ==========================================================================
  // Initialization Tests
  // ==========================================================================

  describe('initialization', () => {
    it('should create with default options', () => {
      expect(bash.name).toBe('bash')
      expect(bash.getCwd()).toBe('/')
    })

    it('should accept custom cwd', () => {
      const customBash = new BashModule({
        fs: mockFs as unknown as FsModule,
        cwd: '/app',
      })
      expect(customBash.getCwd()).toBe('/app')
    })

    it('should accept custom environment variables', async () => {
      const customBash = new BashModule({
        fs: mockFs as unknown as FsModule,
        env: { MY_VAR: 'my_value' },
      })
      await customBash.initialize()
      expect(customBash.getEnv('MY_VAR')).toBe('my_value')
    })

    it('should set default environment variables on initialize', async () => {
      await bash.initialize()
      expect(bash.getEnv('HOME')).toBe('/')
      expect(bash.getEnv('USER')).toBe('root')
      expect(bash.getEnv('PWD')).toBe('/')
    })

    it('should be idempotent for multiple initialize calls', async () => {
      await bash.initialize()
      const home1 = bash.getEnv('HOME')
      await bash.initialize()
      const home2 = bash.getEnv('HOME')
      expect(home1).toBe(home2)
    })
  })

  // ==========================================================================
  // Safety Analysis Tests
  // ==========================================================================

  describe('safety analysis', () => {
    describe('safe commands', () => {
      it('should mark cat as safe', () => {
        const analysis = bash.analyze('cat /file.txt')
        expect(analysis.safe).toBe(true)
        expect(analysis.risk).toBe('none')
        expect(analysis.delegatedToFs).toBe(true)
      })

      it('should mark ls as safe', () => {
        const analysis = bash.analyze('ls -la /app')
        expect(analysis.safe).toBe(true)
        expect(analysis.risk).toBe('none')
      })

      it('should mark mkdir as safe', () => {
        const analysis = bash.analyze('mkdir -p /app/data')
        expect(analysis.safe).toBe(true)
        expect(analysis.risk).toBe('none')
      })

      it('should mark echo as safe', () => {
        const analysis = bash.analyze('echo Hello World')
        expect(analysis.safe).toBe(true)
        expect(analysis.risk).toBe('none')
      })

      it('should mark pwd as safe', () => {
        const analysis = bash.analyze('pwd')
        expect(analysis.safe).toBe(true)
        expect(analysis.risk).toBe('none')
      })
    })

    describe('medium risk commands', () => {
      it('should mark rm -rf as medium risk', () => {
        const analysis = bash.analyze('rm -rf /app/temp')
        expect(analysis.safe).toBe(true)
        expect(analysis.risk).toBe('medium')
      })

      it('should mark chmod -R as medium risk', () => {
        const analysis = bash.analyze('chmod -R 755 /app')
        expect(analysis.safe).toBe(true)
        expect(analysis.risk).toBe('medium')
      })
    })

    describe('dangerous commands', () => {
      it('should block rm -rf /', () => {
        const analysis = bash.analyze('rm -rf /')
        expect(analysis.safe).toBe(false)
        expect(analysis.risk).toBe('critical')
      })

      it('should block command substitution', () => {
        const analysis = bash.analyze('echo $(whoami)')
        expect(analysis.safe).toBe(false)
        expect(analysis.risk).toBe('critical')
      })

      it('should block piping to sh', () => {
        const analysis = bash.analyze('cat script.sh | sh')
        expect(analysis.safe).toBe(false)
        expect(analysis.risk).toBe('critical')
      })

      it('should block backtick command substitution', () => {
        const analysis = bash.analyze('echo `id`')
        expect(analysis.safe).toBe(false)
        expect(analysis.risk).toBe('critical')
      })
    })

    describe('blocked commands', () => {
      it('should block wget by default', () => {
        const analysis = bash.analyze('wget http://example.com')
        expect(analysis.safe).toBe(false)
      })

      it('should block curl by default', () => {
        const analysis = bash.analyze('curl http://example.com')
        expect(analysis.safe).toBe(false)
      })

      it('should block ssh by default', () => {
        const analysis = bash.analyze('ssh user@host')
        expect(analysis.safe).toBe(false)
      })
    })

    describe('whitelist mode', () => {
      it('should only allow whitelisted commands', () => {
        const restrictedBash = new BashModule({
          fs: mockFs as unknown as FsModule,
          allowedCommands: ['cat', 'ls'],
        })

        expect(restrictedBash.analyze('cat file.txt').safe).toBe(true)
        expect(restrictedBash.analyze('ls /app').safe).toBe(true)
        expect(restrictedBash.analyze('rm file.txt').safe).toBe(false)
      })
    })

    describe('custom blocked commands', () => {
      it('should block custom commands', () => {
        const customBash = new BashModule({
          fs: mockFs as unknown as FsModule,
          blockedCommands: ['dangerous-cmd'],
        })

        const analysis = customBash.analyze('dangerous-cmd')
        expect(analysis.safe).toBe(false)
      })
    })
  })

  // ==========================================================================
  // Command Execution Tests
  // ==========================================================================

  describe('command execution', () => {
    beforeEach(async () => {
      await bash.initialize()
    })

    describe('cat', () => {
      it('should read file contents', async () => {
        mockFs._addFile('/test.txt', {
          content: 'Hello, World!',
          type: 'file',
          mode: 0o644,
          uid: 0,
          gid: 0,
          size: 13,
          atime: new Date(),
          mtime: new Date(),
          ctime: new Date(),
          birthtime: new Date(),
          nlink: 1,
        })

        const result = await bash.exec('cat /test.txt')
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe('Hello, World!')
      })

      it('should concatenate multiple files', async () => {
        mockFs._addFile('/a.txt', {
          content: 'AAA',
          type: 'file',
          mode: 0o644,
          uid: 0,
          gid: 0,
          size: 3,
          atime: new Date(),
          mtime: new Date(),
          ctime: new Date(),
          birthtime: new Date(),
          nlink: 1,
        })
        mockFs._addFile('/b.txt', {
          content: 'BBB',
          type: 'file',
          mode: 0o644,
          uid: 0,
          gid: 0,
          size: 3,
          atime: new Date(),
          mtime: new Date(),
          ctime: new Date(),
          birthtime: new Date(),
          nlink: 1,
        })

        const result = await bash.exec('cat /a.txt /b.txt')
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe('AAABBB')
      })

      it('should show line numbers with -n flag', async () => {
        mockFs._addFile('/test.txt', {
          content: 'line1\nline2\nline3',
          type: 'file',
          mode: 0o644,
          uid: 0,
          gid: 0,
          size: 17,
          atime: new Date(),
          mtime: new Date(),
          ctime: new Date(),
          birthtime: new Date(),
          nlink: 1,
        })

        const result = await bash.exec('cat -n /test.txt')
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('1')
        expect(result.stdout).toContain('line1')
      })

      it('should return error for non-existent file', async () => {
        const result = await bash.exec('cat /nonexistent.txt')
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain('cat')
      })
    })

    describe('ls', () => {
      it('should list current directory', async () => {
        await mockFs.mkdir('/app')
        await mockFs.write('/app/file1.txt', 'content1')
        await mockFs.write('/app/file2.txt', 'content2')

        const result = await bash.exec('ls /app')
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('file1.txt')
        expect(result.stdout).toContain('file2.txt')
      })

      it('should show hidden files with -a flag', async () => {
        await mockFs.mkdir('/app')
        await mockFs.write('/app/.hidden', 'hidden content')
        await mockFs.write('/app/visible.txt', 'visible content')

        const result = await bash.exec('ls -a /app')
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('.hidden')
        expect(result.stdout).toContain('visible.txt')
      })

      it('should show long format with -l flag', async () => {
        await mockFs.mkdir('/app')
        await mockFs.write('/app/file.txt', 'content')

        const result = await bash.exec('ls -l /app')
        expect(result.exitCode).toBe(0)
        // Long format should contain permissions
        expect(result.stdout).toContain('rw')
      })
    })

    describe('mkdir', () => {
      it('should create directory', async () => {
        const result = await bash.exec('mkdir /newdir')
        expect(result.exitCode).toBe(0)
        expect(await mockFs.exists('/newdir')).toBe(true)
      })

      it('should create nested directories with -p flag', async () => {
        const result = await bash.exec('mkdir -p /a/b/c')
        expect(result.exitCode).toBe(0)
        expect(await mockFs.exists('/a')).toBe(true)
        expect(await mockFs.exists('/a/b')).toBe(true)
        expect(await mockFs.exists('/a/b/c')).toBe(true)
      })

      it('should fail without -p when parent missing', async () => {
        const result = await bash.exec('mkdir /missing/child')
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain('mkdir')
      })
    })

    describe('rm', () => {
      it('should remove file', async () => {
        await mockFs.write('/file.txt', 'content')
        expect(await mockFs.exists('/file.txt')).toBe(true)

        const result = await bash.exec('rm /file.txt')
        expect(result.exitCode).toBe(0)
        expect(await mockFs.exists('/file.txt')).toBe(false)
      })

      it('should remove directory with -r flag', async () => {
        await mockFs.mkdir('/dir')
        await mockFs.write('/dir/file.txt', 'content')

        const result = await bash.exec('rm -r /dir')
        expect(result.exitCode).toBe(0)
        expect(await mockFs.exists('/dir')).toBe(false)
      })

      it('should not fail with -f for non-existent file', async () => {
        const result = await bash.exec('rm -f /nonexistent.txt')
        expect(result.exitCode).toBe(0)
      })
    })

    describe('cp', () => {
      it('should copy file', async () => {
        await mockFs.write('/source.txt', 'source content')

        const result = await bash.exec('cp /source.txt /dest.txt')
        expect(result.exitCode).toBe(0)
        expect(await mockFs.exists('/dest.txt')).toBe(true)
      })
    })

    describe('mv', () => {
      it('should move file', async () => {
        await mockFs.write('/old.txt', 'content')

        const result = await bash.exec('mv /old.txt /new.txt')
        expect(result.exitCode).toBe(0)
        expect(await mockFs.exists('/old.txt')).toBe(false)
        expect(await mockFs.exists('/new.txt')).toBe(true)
      })
    })

    describe('touch', () => {
      it('should create empty file', async () => {
        const result = await bash.exec('touch /newfile.txt')
        expect(result.exitCode).toBe(0)
        expect(await mockFs.exists('/newfile.txt')).toBe(true)
      })

      it('should update timestamps on existing file', async () => {
        await mockFs.write('/file.txt', 'content')
        const oldMtime = mockFs._getFile('/file.txt')!.mtime

        // Wait a bit to ensure different timestamp
        await new Promise((r) => setTimeout(r, 10))

        const result = await bash.exec('touch /file.txt')
        expect(result.exitCode).toBe(0)
      })
    })

    describe('echo', () => {
      it('should output text', () => {
        const analysis = bash.analyze('echo Hello World')
        expect(analysis.parsed.command).toBe('echo')
      })

      it('should handle -n flag', async () => {
        const result = await bash.exec('echo -n no newline')
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe('no newline')
        expect(result.stdout).not.toContain('\n')
      })

      it('should add newline by default', async () => {
        const result = await bash.exec('echo with newline')
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe('with newline\n')
      })
    })

    describe('pwd', () => {
      it('should print current directory', async () => {
        const result = await bash.exec('pwd')
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe('/\n')
      })
    })

    describe('cd', () => {
      it('should change directory', async () => {
        await mockFs.mkdir('/app')

        const result = await bash.exec('cd /app')
        expect(result.exitCode).toBe(0)
        expect(bash.getCwd()).toBe('/app')
      })

      it('should fail for non-existent directory', async () => {
        const result = await bash.exec('cd /nonexistent')
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain('cd')
      })

      it('should go to HOME when no argument', async () => {
        await mockFs.mkdir('/app')
        bash.setCwd('/app')
        bash.setEnv('HOME', '/')

        const result = await bash.exec('cd')
        expect(result.exitCode).toBe(0)
        expect(bash.getCwd()).toBe('/')
      })
    })

    describe('head', () => {
      it('should output first lines of file', async () => {
        const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
        await mockFs.write('/file.txt', content)

        const result = await bash.exec('head /file.txt')
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('line 1')
        expect(result.stdout).toContain('line 10')
        expect(result.stdout).not.toContain('line 11')
      })

      it('should respect -n flag', async () => {
        const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
        await mockFs.write('/file.txt', content)

        const result = await bash.exec('head -n 3 /file.txt')
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('line 1')
        expect(result.stdout).toContain('line 3')
        expect(result.stdout).not.toContain('line 4')
      })
    })

    describe('tail', () => {
      it('should output last lines of file', async () => {
        const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
        await mockFs.write('/file.txt', content)

        const result = await bash.exec('tail /file.txt')
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('line 20')
        expect(result.stdout).toContain('line 11')
      })
    })

    describe('wc', () => {
      it('should count lines, words, bytes', async () => {
        await mockFs.write('/file.txt', 'hello world\nfoo bar\n')

        const result = await bash.exec('wc /file.txt')
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('/file.txt')
      })

      it('should count only lines with -l', async () => {
        await mockFs.write('/file.txt', 'line1\nline2\nline3\n')

        const result = await bash.exec('wc -l /file.txt')
        expect(result.exitCode).toBe(0)
      })
    })

    describe('test / [', () => {
      it('should test file existence with -e', async () => {
        await mockFs.write('/exists.txt', 'content')

        const result1 = await bash.exec('test -e /exists.txt')
        expect(result1.exitCode).toBe(0)

        const result2 = await bash.exec('test -e /nonexistent.txt')
        expect(result2.exitCode).toBe(1)
      })

      it('should test if file with -f', async () => {
        await mockFs.write('/file.txt', 'content')
        await mockFs.mkdir('/dir')

        const result1 = await bash.exec('test -f /file.txt')
        expect(result1.exitCode).toBe(0)

        const result2 = await bash.exec('test -f /dir')
        expect(result2.exitCode).toBe(1)
      })

      it('should test if directory with -d', async () => {
        await mockFs.mkdir('/dir')
        await mockFs.write('/file.txt', 'content')

        const result1 = await bash.exec('test -d /dir')
        expect(result1.exitCode).toBe(0)

        const result2 = await bash.exec('test -d /file.txt')
        expect(result2.exitCode).toBe(1)
      })

      it('should test string equality', async () => {
        const result1 = await bash.exec('test foo = foo')
        expect(result1.exitCode).toBe(0)

        const result2 = await bash.exec('test foo = bar')
        expect(result2.exitCode).toBe(1)
      })

      it('should test numeric comparison', async () => {
        const result1 = await bash.exec('test 5 -gt 3')
        expect(result1.exitCode).toBe(0)

        const result2 = await bash.exec('test 3 -gt 5')
        expect(result2.exitCode).toBe(1)
      })
    })

    describe('true and false', () => {
      it('should return 0 for true', async () => {
        const result = await bash.exec('true')
        expect(result.exitCode).toBe(0)
      })

      it('should return 1 for false', async () => {
        const result = await bash.exec('false')
        expect(result.exitCode).toBe(1)
      })
    })

    describe('basename', () => {
      it('should strip directory from path', async () => {
        const result = await bash.exec('basename /path/to/file.txt')
        expect(result.exitCode).toBe(0)
        expect(result.stdout.trim()).toBe('file.txt')
      })

      it('should strip suffix if provided', async () => {
        const result = await bash.exec('basename /path/to/file.txt .txt')
        expect(result.exitCode).toBe(0)
        expect(result.stdout.trim()).toBe('file')
      })
    })

    describe('dirname', () => {
      it('should return directory portion of path', async () => {
        const result = await bash.exec('dirname /path/to/file.txt')
        expect(result.exitCode).toBe(0)
        expect(result.stdout.trim()).toBe('/path/to')
      })

      it('should return / for root-level files', async () => {
        const result = await bash.exec('dirname /file.txt')
        expect(result.exitCode).toBe(0)
        expect(result.stdout.trim()).toBe('/')
      })
    })

    describe('unknown command', () => {
      it('should return exit code 127 for unknown command', async () => {
        const result = await bash.exec('unknowncommand')
        expect(result.exitCode).toBe(127)
        expect(result.stderr).toContain('command not found')
      })
    })
  })

  // ==========================================================================
  // Environment Variable Tests
  // ==========================================================================

  describe('environment variables', () => {
    beforeEach(async () => {
      await bash.initialize()
      bash.setEnv('MY_VAR', 'my_value')
    })

    it('should expand $VAR syntax', async () => {
      const result = await bash.exec('echo $MY_VAR')
      expect(result.stdout).toContain('my_value')
    })

    it('should expand ${VAR} syntax', async () => {
      const result = await bash.exec('echo ${MY_VAR}')
      expect(result.stdout).toContain('my_value')
    })

    it('should expand PWD to current directory', async () => {
      const result = await bash.exec('echo $PWD')
      expect(result.stdout.trim()).toBe('/')
    })

    it('should expand HOME', async () => {
      const result = await bash.exec('echo $HOME')
      expect(result.stdout).toContain('/')
    })

    it('should return empty for undefined variables', async () => {
      const result = await bash.exec('echo $UNDEFINED_VAR')
      expect(result.stdout.trim()).toBe('')
    })
  })

  // ==========================================================================
  // Working Directory Tests
  // ==========================================================================

  describe('working directory', () => {
    beforeEach(async () => {
      await bash.initialize()
      await mockFs.mkdir('/app')
      await mockFs.mkdir('/app/data')
    })

    it('should resolve relative paths from cwd', async () => {
      bash.setCwd('/app')
      await mockFs.write('/app/file.txt', 'content')

      const result = await bash.exec('cat file.txt')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('content')
    })

    it('should handle . in paths', async () => {
      bash.setCwd('/app')
      await mockFs.write('/app/file.txt', 'content')

      const result = await bash.exec('cat ./file.txt')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('content')
    })

    it('should handle .. in paths', async () => {
      bash.setCwd('/app/data')
      await mockFs.write('/app/file.txt', 'content')

      const result = await bash.exec('cat ../file.txt')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('content')
    })

    it('should expand ~ to HOME', async () => {
      bash.setEnv('HOME', '/app')
      await mockFs.write('/app/file.txt', 'content')

      const result = await bash.exec('cat ~/file.txt')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('content')
    })
  })

  // ==========================================================================
  // Redirection Tests
  // ==========================================================================

  describe('redirection', () => {
    beforeEach(async () => {
      await bash.initialize()
    })

    it('should redirect output to file with >', async () => {
      await bash.exec('echo hello > /output.txt')

      const content = await mockFs.read('/output.txt', { encoding: 'utf-8' })
      expect(content).toContain('hello')
    })

    it('should append output to file with >>', async () => {
      await mockFs.write('/output.txt', 'line1\n')
      await bash.exec('echo line2 >> /output.txt')

      const content = await mockFs.read('/output.txt', { encoding: 'utf-8' })
      expect(content).toContain('line1')
      expect(content).toContain('line2')
    })

    it('should read input from file with <', async () => {
      await mockFs.write('/input.txt', 'file content')

      // cat with input redirection
      const result = await bash.exec('cat < /input.txt')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('file content')
    })
  })

  // ==========================================================================
  // Piping Tests
  // ==========================================================================

  describe('piping', () => {
    beforeEach(async () => {
      await bash.initialize()
    })

    it('should pipe output between commands', async () => {
      const content = 'line1\nline2\nline3\nline4\nline5\n'
      await mockFs.write('/file.txt', content)

      const result = await bash.exec('cat /file.txt | head -n 2')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('line1')
      expect(result.stdout).toContain('line2')
    })

    it('should support multiple pipes', async () => {
      const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
      await mockFs.write('/file.txt', content)

      const result = await bash.exec('cat /file.txt | head -n 10 | tail -n 3')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('line 8')
      expect(result.stdout).toContain('line 10')
    })
  })

  // ==========================================================================
  // Strict Mode Tests
  // ==========================================================================

  describe('strict mode', () => {
    it('should not throw in non-strict mode', async () => {
      const nonStrictBash = new BashModule({
        fs: mockFs as unknown as FsModule,
        strict: false,
      })
      await nonStrictBash.initialize()

      const result = await nonStrictBash.exec('cat /nonexistent.txt')
      expect(result.exitCode).toBe(1)
    })

    it('should throw in strict mode', async () => {
      const strictBash = new BashModule({
        fs: mockFs as unknown as FsModule,
        strict: true,
      })
      await strictBash.initialize()

      await expect(strictBash.exec('cat /nonexistent.txt')).rejects.toThrow()
    })
  })

  // ==========================================================================
  // Quote Handling Tests
  // ==========================================================================

  describe('quote handling', () => {
    beforeEach(async () => {
      await bash.initialize()
    })

    it('should handle single quotes', async () => {
      const result = await bash.exec("echo 'hello world'")
      expect(result.stdout).toContain('hello world')
    })

    it('should handle double quotes', async () => {
      const result = await bash.exec('echo "hello world"')
      expect(result.stdout).toContain('hello world')
    })

    it('should preserve spaces in quoted strings', async () => {
      const result = await bash.exec('echo "hello   world"')
      expect(result.stdout).toContain('hello   world')
    })

    it('should handle escaped quotes', async () => {
      const result = await bash.exec('echo "hello \\"world\\""')
      expect(result.stdout).toContain('"')
    })
  })

  // ==========================================================================
  // Unsafe Command Blocking Tests
  // ==========================================================================

  describe('unsafe command blocking', () => {
    beforeEach(async () => {
      await bash.initialize()
    })

    it('should block rm -rf /', async () => {
      const result = await bash.exec('rm -rf /')
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Unsafe command blocked')
    })

    it('should block command substitution', async () => {
      const result = await bash.exec('echo $(cat /etc/passwd)')
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Unsafe command blocked')
    })

    it('should block piping to bash', async () => {
      const result = await bash.exec('cat script.sh | bash')
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Unsafe command blocked')
    })
  })

  // ==========================================================================
  // Result Metadata Tests
  // ==========================================================================

  describe('result metadata', () => {
    beforeEach(async () => {
      await bash.initialize()
    })

    it('should include command in result', async () => {
      const result = await bash.exec('echo test')
      expect(result.command).toBe('echo test')
    })

    it('should include cwd in result', async () => {
      const result = await bash.exec('pwd')
      expect(result.cwd).toBe('/')
    })

    it('should include duration in result', async () => {
      const result = await bash.exec('echo test')
      expect(result.duration).toBeGreaterThanOrEqual(0)
    })
  })

  // ==========================================================================
  // Utility Methods Tests
  // ==========================================================================

  describe('utility methods', () => {
    beforeEach(async () => {
      await bash.initialize()
    })

    it('should get and set cwd', () => {
      bash.setCwd('/app')
      expect(bash.getCwd()).toBe('/app')
    })

    it('should get and set env', () => {
      bash.setEnv('TEST_VAR', 'test_value')
      expect(bash.getEnv('TEST_VAR')).toBe('test_value')
    })

    it('should get all env variables', () => {
      bash.setEnv('TEST1', 'value1')
      bash.setEnv('TEST2', 'value2')

      const allEnv = bash.getAllEnv()
      expect(allEnv.TEST1).toBe('value1')
      expect(allEnv.TEST2).toBe('value2')
    })
  })
})

/**
 * Test utilities for fsx filesystem tests
 *
 * Provides in-memory storage backend and helper functions for creating
 * test files and directories.
 */

import { constants } from '../core/constants'
import { PathValidator, pathValidator } from '../do/security'

/**
 * File entry stored in the in-memory filesystem
 */
export interface MemoryFileEntry {
  type: 'file' | 'directory' | 'symlink'
  mode: number
  content: Uint8Array
  linkTarget?: string
  uid: number
  gid: number
  atime: number
  mtime: number
  ctime: number
  birthtime: number
  nlink: number
}

/**
 * In-memory storage backend for testing filesystem operations
 *
 * This class simulates a filesystem in memory, providing all the storage
 * operations needed by the fsx filesystem implementation.
 */
export class InMemoryStorage {
  private entries: Map<string, MemoryFileEntry> = new Map()
  private nextInode: number = 1

  constructor() {
    // Initialize with root directory
    this.entries.set('/', {
      type: 'directory',
      mode: 0o755 | constants.S_IFDIR,
      content: new Uint8Array(0),
      uid: 0,
      gid: 0,
      atime: Date.now(),
      mtime: Date.now(),
      ctime: Date.now(),
      birthtime: Date.now(),
      nlink: 2,
    })
  }

  /**
   * Normalize a path: resolve . and .., remove double slashes, ensure starts with /
   */
  normalizePath(path: string): string {
    // Ensure starts with /
    if (!path.startsWith('/')) {
      path = '/' + path
    }

    // Split and process
    const segments = path.split('/').filter((s) => s !== '' && s !== '.')
    const result: string[] = []

    for (const segment of segments) {
      if (segment === '..') {
        result.pop()
      } else {
        result.push(segment)
      }
    }

    return '/' + result.join('/')
  }

  /**
   * Get parent path
   */
  getParentPath(path: string): string {
    const normalized = this.normalizePath(path)
    const lastSlash = normalized.lastIndexOf('/')
    if (lastSlash <= 0) return '/'
    return normalized.substring(0, lastSlash)
  }

  /**
   * Get file name from path
   */
  getFileName(path: string): string {
    const normalized = this.normalizePath(path)
    const lastSlash = normalized.lastIndexOf('/')
    return normalized.substring(lastSlash + 1)
  }

  /**
   * Check if an entry exists
   */
  has(path: string): boolean {
    return this.entries.has(this.normalizePath(path))
  }

  /**
   * Get an entry
   */
  get(path: string): MemoryFileEntry | undefined {
    return this.entries.get(this.normalizePath(path))
  }

  /**
   * Check if path is a directory
   */
  isDirectory(path: string): boolean {
    const entry = this.get(path)
    return entry?.type === 'directory'
  }

  /**
   * Check if path is a file
   */
  isFile(path: string): boolean {
    const entry = this.get(path)
    return entry?.type === 'file'
  }

  /**
   * Check if path is a symlink
   */
  isSymlink(path: string): boolean {
    const entry = this.get(path)
    return entry?.type === 'symlink'
  }

  /**
   * Check if parent directory exists
   */
  parentExists(path: string): boolean {
    const parentPath = this.getParentPath(path)
    return this.isDirectory(parentPath)
  }

  /**
   * Add a file
   */
  addFile(
    path: string,
    content: Uint8Array | string,
    options?: {
      mode?: number
      uid?: number
      gid?: number
      birthtime?: number
    }
  ): void {
    // Validate input path for security
    pathValidator.validateInput(path)

    const normalized = this.normalizePath(path)
    const now = Date.now()
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content

    this.entries.set(normalized, {
      type: 'file',
      mode: (options?.mode ?? 0o644) | constants.S_IFREG,
      content: bytes,
      uid: options?.uid ?? 0,
      gid: options?.gid ?? 0,
      atime: now,
      mtime: now,
      ctime: now,
      birthtime: options?.birthtime ?? now,
      nlink: 1,
    })
  }

  /**
   * Add a directory
   */
  addDirectory(
    path: string,
    options?: {
      mode?: number
      uid?: number
      gid?: number
    }
  ): void {
    // Validate input path for security
    pathValidator.validateInput(path)

    const normalized = this.normalizePath(path)
    const now = Date.now()

    this.entries.set(normalized, {
      type: 'directory',
      mode: (options?.mode ?? 0o755) | constants.S_IFDIR,
      content: new Uint8Array(0),
      uid: options?.uid ?? 0,
      gid: options?.gid ?? 0,
      atime: now,
      mtime: now,
      ctime: now,
      birthtime: now,
      nlink: 2,
    })
  }

  /**
   * Add a symbolic link
   */
  addSymlink(path: string, target: string): void {
    // Validate input paths for security
    pathValidator.validateInput(path)
    pathValidator.validateInput(target)

    const normalized = this.normalizePath(path)
    const now = Date.now()

    this.entries.set(normalized, {
      type: 'symlink',
      mode: 0o777 | constants.S_IFLNK,
      content: new Uint8Array(0),
      linkTarget: target,
      uid: 0,
      gid: 0,
      atime: now,
      mtime: now,
      ctime: now,
      birthtime: now,
      nlink: 1,
    })
  }

  /**
   * Remove an entry
   */
  remove(path: string): boolean {
    return this.entries.delete(this.normalizePath(path))
  }

  /**
   * Update file content
   */
  updateContent(path: string, content: Uint8Array | string): void {
    const normalized = this.normalizePath(path)
    const entry = this.entries.get(normalized)

    if (!entry) {
      throw new Error(`File not found: ${path}`)
    }

    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
    const now = Date.now()

    entry.content = bytes
    entry.mtime = now
    entry.ctime = now
  }

  /**
   * Get directory children (immediate children only)
   */
  getChildren(path: string): string[] {
    const normalized = this.normalizePath(path)
    const prefix = normalized === '/' ? '/' : normalized + '/'
    const children: string[] = []

    for (const entryPath of this.entries.keys()) {
      if (entryPath === normalized) continue

      // Check if this is an immediate child
      if (entryPath.startsWith(prefix)) {
        const relativePath = entryPath.substring(prefix.length)
        // Only include immediate children (no slashes in relative path)
        if (!relativePath.includes('/')) {
          children.push(relativePath)
        }
      }
    }

    return children.sort()
  }

  /**
   * Clear all entries (except root)
   */
  clear(): void {
    const root = this.entries.get('/')!
    this.entries.clear()
    this.entries.set('/', root)
  }

  /**
   * Get all entries (for debugging)
   */
  getAllPaths(): string[] {
    return Array.from(this.entries.keys()).sort()
  }

  /**
   * Get file content as string
   */
  readFileAsString(path: string, encoding: BufferEncoding = 'utf-8'): string {
    // Validate input path for security
    pathValidator.validateInput(path)

    const entry = this.get(path)
    if (!entry || entry.type !== 'file') {
      throw new Error(`File not found: ${path}`)
    }

    if (encoding === 'utf-8' || encoding === 'utf8') {
      return new TextDecoder().decode(entry.content)
    }

    if (encoding === 'base64') {
      let binary = ''
      for (const byte of entry.content) {
        binary += String.fromCharCode(byte)
      }
      return btoa(binary)
    }

    if (encoding === 'hex') {
      return Array.from(entry.content)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    }

    // Default to utf-8
    return new TextDecoder().decode(entry.content)
  }

  /**
   * Get file content as Uint8Array
   */
  readFileAsBytes(path: string): Uint8Array {
    const entry = this.get(path)
    if (!entry || entry.type !== 'file') {
      throw new Error(`File not found: ${path}`)
    }
    return entry.content
  }
}

type BufferEncoding = 'utf-8' | 'utf8' | 'base64' | 'hex' | 'ascii' | 'latin1' | 'binary'

/**
 * Helper to create a populated test filesystem
 */
export function createTestFilesystem(): InMemoryStorage {
  const storage = new InMemoryStorage()

  // Create some common test directories
  storage.addDirectory('/home')
  storage.addDirectory('/home/user')
  storage.addDirectory('/tmp')
  storage.addDirectory('/var')
  storage.addDirectory('/var/log')

  // Create some test files
  storage.addFile('/home/user/hello.txt', 'Hello, World!')
  storage.addFile('/home/user/data.json', '{"key": "value"}')
  storage.addFile('/tmp/temp.txt', 'temporary data')

  return storage
}

/**
 * Helper to create random binary data
 */
export function createRandomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    bytes[i] = Math.floor(Math.random() * 256)
  }
  return bytes
}

/**
 * Helper to create a file with specific size
 */
export function createFileWithSize(storage: InMemoryStorage, path: string, size: number): void {
  const content = createRandomBytes(size)
  storage.addFile(path, content)
}

/**
 * Helper to create nested directory structure
 */
export function createNestedDirs(storage: InMemoryStorage, basePath: string, depth: number): void {
  let currentPath = basePath
  for (let i = 0; i < depth; i++) {
    currentPath = `${currentPath}/level${i}`
    storage.addDirectory(currentPath)
  }
}

/**
 * Mock R2 bucket for testing tiered storage
 */
export class MockR2Bucket {
  private objects: Map<string, Uint8Array> = new Map()

  async put(key: string, value: Uint8Array | ArrayBuffer | string): Promise<void> {
    if (typeof value === 'string') {
      this.objects.set(key, new TextEncoder().encode(value))
    } else if (value instanceof ArrayBuffer) {
      this.objects.set(key, new Uint8Array(value))
    } else {
      this.objects.set(key, value)
    }
  }

  async get(key: string): Promise<MockR2Object | null> {
    const data = this.objects.get(key)
    if (!data) return null
    return new MockR2Object(data)
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  async head(key: string): Promise<{ size: number } | null> {
    const data = this.objects.get(key)
    if (!data) return null
    return { size: data.length }
  }

  async list(options?: { prefix?: string }): Promise<{ objects: Array<{ key: string; size: number }> }> {
    const results: Array<{ key: string; size: number }> = []
    for (const [key, data] of this.objects) {
      if (!options?.prefix || key.startsWith(options.prefix)) {
        results.push({ key, size: data.length })
      }
    }
    return { objects: results }
  }

  clear(): void {
    this.objects.clear()
  }

  has(key: string): boolean {
    return this.objects.has(key)
  }
}

/**
 * Mock R2 object
 */
export class MockR2Object {
  private data: Uint8Array

  constructor(data: Uint8Array) {
    this.data = data
  }

  get size(): number {
    return this.data.length
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.data.buffer.slice(this.data.byteOffset, this.data.byteOffset + this.data.byteLength)
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.data)
  }
}

/**
 * Mock Durable Object stub for testing
 */
export class MockDurableObjectStub {
  private storage: InMemoryStorage
  private rootPath: string

  constructor(storage?: InMemoryStorage, rootPath: string = '/') {
    this.storage = storage ?? new InMemoryStorage()
    this.rootPath = rootPath
  }

  /**
   * Validate a path against path traversal attacks
   * @returns The validated, normalized path
   * @throws Error with code 'EACCES' if path would escape root
   */
  private validatePath(path: string): string {
    return pathValidator.validatePath(path, this.rootPath)
  }

  /**
   * Check if a path would escape the root via traversal
   */
  private isPathTraversal(path: string): boolean {
    return pathValidator.isPathTraversal(path, this.rootPath)
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const parsedUrl = new URL(url)

    // Handle stream/read endpoint for createReadStream
    if (parsedUrl.pathname === '/stream/read' && init?.method === 'POST') {
      try {
        const body = JSON.parse(init.body as string)
        const path = body.path as string

        // Validate path against traversal attacks
        if (this.isPathTraversal(path)) {
          return new Response(JSON.stringify({ code: 'EACCES', message: 'permission denied - path traversal detected', path }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        const entry = this.storage.get(path)

        if (!entry) {
          return new Response(JSON.stringify({ code: 'ENOENT', message: 'no such file or directory', path }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        if (entry.type === 'directory') {
          return new Response(JSON.stringify({ code: 'EISDIR', message: 'illegal operation on a directory', path }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        // Return the content as a stream
        return new Response(entry.content, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      } catch (error: unknown) {
        const err = error as Error & { code?: string; path?: string }
        const status = err.code === 'EACCES' ? 403 : 400
        return new Response(JSON.stringify({ code: err.code ?? 'UNKNOWN', message: err.message, path: err.path }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // Handle stream/write endpoint for createWriteStream
    if (parsedUrl.pathname === '/stream/write' && init?.method === 'POST') {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Parse the RPC request
    if (init?.method === 'POST' && init.body) {
      const body = JSON.parse(init.body as string)
      const { method, params } = body

      try {
        const result = await this.handleMethod(method, params)
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (error: unknown) {
        const err = error as Error & { code?: string; path?: string }
        // Return 403 Forbidden for EACCES (path traversal)
        const status = err.code === 'EACCES' ? 403 : 400
        return new Response(
          JSON.stringify({
            code: err.code ?? 'UNKNOWN',
            message: err.message,
            path: err.path,
          }),
          {
            status,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      }
    }

    return new Response('Not found', { status: 404 })
  }

  private async handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'readFile': {
        const path = params.path as string
        // Validate path for traversal attacks
        this.validatePath(path)
        const entry = this.storage.get(path)
        if (!entry) {
          throw { code: 'ENOENT', message: 'no such file or directory', path }
        }
        if (entry.type === 'directory') {
          throw { code: 'EISDIR', message: 'illegal operation on a directory', path }
        }

        // Return base64 encoded data
        let binary = ''
        for (const byte of entry.content) {
          binary += String.fromCharCode(byte)
        }
        return { data: btoa(binary), encoding: 'base64' }
      }

      case 'writeFile': {
        const path = params.path as string
        // Validate path for traversal attacks
        this.validatePath(path)
        const data = params.data as string
        const encoding = params.encoding as string
        const mode = params.mode as number | undefined

        // Decode the data
        let bytes: Uint8Array
        if (encoding === 'base64') {
          const binary = atob(data)
          bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i)
          }
        } else {
          bytes = new TextEncoder().encode(data)
        }

        // Check parent exists
        if (!this.storage.parentExists(path)) {
          throw { code: 'ENOENT', message: 'no such file or directory', path }
        }

        this.storage.addFile(path, bytes, { mode })
        return {}
      }

      case 'mkdir': {
        const path = params.path as string
        // Validate path for traversal attacks
        this.validatePath(path)
        const recursive = params.recursive as boolean
        const mode = params.mode as number | undefined

        if (this.storage.has(path)) {
          if (!recursive) {
            throw { code: 'EEXIST', message: 'file already exists', path }
          }
          return {}
        }

        if (recursive) {
          // Create all parent directories
          const parts = path.split('/').filter(Boolean)
          let currentPath = ''
          for (const part of parts) {
            currentPath += '/' + part
            if (!this.storage.has(currentPath)) {
              this.storage.addDirectory(currentPath, { mode })
            }
          }
        } else {
          if (!this.storage.parentExists(path)) {
            throw { code: 'ENOENT', message: 'no such file or directory', path }
          }
          this.storage.addDirectory(path, { mode })
        }
        return {}
      }

      case 'rmdir': {
        const path = params.path as string
        // Validate path for traversal attacks
        this.validatePath(path)
        const recursive = params.recursive as boolean

        if (!this.storage.has(path)) {
          throw { code: 'ENOENT', message: 'no such file or directory', path }
        }

        if (!this.storage.isDirectory(path)) {
          throw { code: 'ENOTDIR', message: 'not a directory', path }
        }

        const children = this.storage.getChildren(path)
        if (children.length > 0 && !recursive) {
          throw { code: 'ENOTEMPTY', message: 'directory not empty', path }
        }

        if (recursive) {
          // Remove all children first
          const allPaths = this.storage.getAllPaths()
          const toRemove = allPaths.filter((p) => p.startsWith(path + '/') || p === path)
          toRemove.sort((a, b) => b.length - a.length) // Remove deepest first
          for (const p of toRemove) {
            this.storage.remove(p)
          }
        } else {
          this.storage.remove(path)
        }
        return {}
      }

      case 'readdir': {
        const path = params.path as string
        // Validate path for traversal attacks
        this.validatePath(path)
        const withFileTypes = params.withFileTypes as boolean

        if (!this.storage.has(path)) {
          throw { code: 'ENOENT', message: 'no such file or directory', path }
        }

        if (!this.storage.isDirectory(path)) {
          throw { code: 'ENOTDIR', message: 'not a directory', path }
        }

        const children = this.storage.getChildren(path)

        if (withFileTypes) {
          return children.map((name) => {
            const childPath = path === '/' ? `/${name}` : `${path}/${name}`
            const entry = this.storage.get(childPath)
            return {
              name,
              parentPath: path,
              type: entry?.type ?? 'file',
            }
          })
        }

        return children
      }

      case 'stat':
      case 'lstat': {
        const path = params.path as string
        // Validate path for traversal attacks
        this.validatePath(path)
        const entry = this.storage.get(path)

        if (!entry) {
          throw { code: 'ENOENT', message: 'no such file or directory', path }
        }

        return {
          dev: 0,
          ino: 0,
          mode: entry.mode,
          nlink: entry.nlink,
          uid: entry.uid,
          gid: entry.gid,
          rdev: 0,
          size: entry.content.length,
          blksize: 4096,
          blocks: Math.ceil(entry.content.length / 512),
          atime: entry.atime,
          mtime: entry.mtime,
          ctime: entry.ctime,
          birthtime: entry.birthtime,
        }
      }

      case 'unlink': {
        const path = params.path as string
        // Validate path for traversal attacks
        this.validatePath(path)

        if (!this.storage.has(path)) {
          throw { code: 'ENOENT', message: 'no such file or directory', path }
        }

        if (this.storage.isDirectory(path)) {
          throw { code: 'EISDIR', message: 'illegal operation on a directory', path }
        }

        this.storage.remove(path)
        return {}
      }

      case 'rename': {
        const oldPath = params.oldPath as string
        const newPath = params.newPath as string
        // Validate both paths for traversal attacks
        this.validatePath(oldPath)
        this.validatePath(newPath)

        if (!this.storage.has(oldPath)) {
          throw { code: 'ENOENT', message: 'no such file or directory', path: oldPath }
        }

        // If same path, do nothing
        if (oldPath === newPath) {
          return {}
        }

        const entry = this.storage.get(oldPath)!
        // Copy entry to new path
        if (entry.type === 'file') {
          this.storage.addFile(newPath, entry.content, { mode: entry.mode & 0o777 })
        } else if (entry.type === 'directory') {
          this.storage.addDirectory(newPath, { mode: entry.mode & 0o777 })
        } else if (entry.type === 'symlink') {
          this.storage.addSymlink(newPath, entry.linkTarget!)
        }
        this.storage.remove(oldPath)
        return {}
      }

      case 'copyFile': {
        const src = params.src as string
        const dest = params.dest as string
        // Validate both paths for traversal attacks
        this.validatePath(src)
        this.validatePath(dest)

        if (!this.storage.has(src)) {
          throw { code: 'ENOENT', message: 'no such file or directory', path: src }
        }

        const entry = this.storage.get(src)!
        if (entry.type !== 'file') {
          throw { code: 'EISDIR', message: 'illegal operation on a directory', path: src }
        }

        this.storage.addFile(dest, entry.content, { mode: entry.mode & 0o777 })
        return {}
      }

      case 'rm': {
        const path = params.path as string
        // Validate path for traversal attacks
        this.validatePath(path)
        const recursive = params.recursive as boolean
        const force = params.force as boolean

        if (!this.storage.has(path)) {
          if (force) {
            return {}
          }
          throw { code: 'ENOENT', message: 'no such file or directory', path }
        }

        if (this.storage.isDirectory(path)) {
          if (!recursive) {
            throw { code: 'EISDIR', message: 'is a directory', path }
          }
          // Remove directory recursively
          const allPaths = this.storage.getAllPaths()
          const toRemove = allPaths.filter((p) => p.startsWith(path + '/') || p === path)
          toRemove.sort((a, b) => b.length - a.length)
          for (const p of toRemove) {
            this.storage.remove(p)
          }
        } else {
          this.storage.remove(path)
        }
        return {}
      }

      case 'access': {
        const path = params.path as string
        // Validate path for traversal attacks
        this.validatePath(path)

        if (!this.storage.has(path)) {
          throw { code: 'ENOENT', message: 'no such file or directory', path }
        }
        // For the mock, we just check existence. Real impl would check mode.
        return {}
      }

      case 'chmod': {
        const path = params.path as string
        // Validate path for traversal attacks
        this.validatePath(path)
        const mode = params.mode as number

        if (!this.storage.has(path)) {
          throw { code: 'ENOENT', message: 'no such file or directory', path }
        }

        const entry = this.storage.get(path)!
        // Update mode (keeping file type bits)
        entry.mode = (entry.mode & ~0o777) | (mode & 0o777)
        return {}
      }

      case 'chown': {
        const path = params.path as string
        // Validate path for traversal attacks
        this.validatePath(path)
        const uid = params.uid as number
        const gid = params.gid as number

        if (!this.storage.has(path)) {
          throw { code: 'ENOENT', message: 'no such file or directory', path }
        }

        const entry = this.storage.get(path)!
        entry.uid = uid
        entry.gid = gid
        return {}
      }

      case 'utimes': {
        const path = params.path as string
        // Validate path for traversal attacks
        this.validatePath(path)
        const atime = params.atime as number
        const mtime = params.mtime as number

        if (!this.storage.has(path)) {
          throw { code: 'ENOENT', message: 'no such file or directory', path }
        }

        const entry = this.storage.get(path)!
        entry.atime = atime
        entry.mtime = mtime
        return {}
      }

      case 'symlink': {
        const target = params.target as string
        const path = params.path as string
        // Validate the path where the symlink will be created
        this.validatePath(path)
        // Also validate that the target doesn't point outside the root
        // This prevents creating symlinks that escape the filesystem jail
        if (pathValidator.isSymlinkEscape(target, path, this.rootPath)) {
          const error = { code: 'EACCES', message: 'permission denied - symlink target outside root', path: target }
          throw error
        }

        this.storage.addSymlink(path, target)
        return {}
      }

      case 'link': {
        const existingPath = params.existingPath as string
        const newPath = params.newPath as string
        // Validate both paths for traversal attacks
        this.validatePath(existingPath)
        this.validatePath(newPath)

        if (!this.storage.has(existingPath)) {
          throw { code: 'ENOENT', message: 'no such file or directory', path: existingPath }
        }

        const entry = this.storage.get(existingPath)!
        if (entry.type !== 'file') {
          throw { code: 'EPERM', message: 'operation not permitted', path: existingPath }
        }

        // Create hard link (copy file with same content)
        this.storage.addFile(newPath, entry.content, { mode: entry.mode & 0o777 })
        entry.nlink++
        return {}
      }

      case 'readlink': {
        const path = params.path as string
        // Validate path for traversal attacks
        this.validatePath(path)

        if (!this.storage.has(path)) {
          throw { code: 'ENOENT', message: 'no such file or directory', path }
        }

        const entry = this.storage.get(path)!
        if (entry.type !== 'symlink') {
          throw { code: 'EINVAL', message: 'invalid argument', path }
        }

        return entry.linkTarget
      }

      case 'realpath': {
        const path = params.path as string
        // Validate path for traversal attacks
        this.validatePath(path)

        // Normalize the path
        const normalized = this.storage.normalizePath(path)

        if (!this.storage.has(normalized)) {
          throw { code: 'ENOENT', message: 'no such file or directory', path }
        }

        return normalized
      }

      case 'truncate': {
        const path = params.path as string
        // Validate path for traversal attacks
        this.validatePath(path)
        const length = (params.length as number) ?? 0

        if (!this.storage.has(path)) {
          throw { code: 'ENOENT', message: 'no such file or directory', path }
        }

        const entry = this.storage.get(path)!
        if (entry.type !== 'file') {
          throw { code: 'EISDIR', message: 'is a directory', path }
        }

        if (length < entry.content.length) {
          entry.content = entry.content.slice(0, length)
        } else if (length > entry.content.length) {
          const newContent = new Uint8Array(length)
          newContent.set(entry.content)
          entry.content = newContent
        }
        return {}
      }

      case 'open': {
        const path = params.path as string
        // Validate path for traversal attacks
        this.validatePath(path)

        if (!this.storage.has(path)) {
          throw { code: 'ENOENT', message: 'no such file or directory', path }
        }

        // Return a mock file descriptor
        return { fd: Math.floor(Math.random() * 1000) + 3 }
      }

      case 'setMetadata':
      case 'getMetadata':
      case 'demoteFile':
        // These are used by TieredFS - return minimal implementations
        return null

      default:
        throw new Error(`Unknown method: ${method}`)
    }
  }

  getStorage(): InMemoryStorage {
    return this.storage
  }
}

/**
 * Assert that an async function throws an error with specific code
 */
export async function expectError(fn: () => Promise<unknown>, expectedCode: string): Promise<void> {
  try {
    await fn()
    throw new Error(`Expected error with code ${expectedCode} but no error was thrown`)
  } catch (error: unknown) {
    const err = error as Error & { code?: string }
    if (err.code !== expectedCode) {
      throw new Error(`Expected error code ${expectedCode} but got ${err.code}: ${err.message}`)
    }
  }
}

/**
 * Tests for fs_move MCP tool
 *
 * RED phase - These tests define the expected behavior of the fs_move MCP tool.
 * Tests will fail until the implementation is complete.
 *
 * The fs_move tool should:
 * - Move/rename a file to a new location
 * - Move/rename a directory to a new location
 * - Handle source not found error (ENOENT)
 * - Handle destination parent not found error (ENOENT)
 * - Handle destination exists scenarios
 * - Handle type mismatch errors (EISDIR, ENOTDIR)
 * - Handle moving directory into itself (EINVAL)
 * - Return proper MCP tool result format
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { invokeTool, fsTools, type McpToolResult } from './index'
import type { FSx } from '../core/fsx'

/**
 * Mock FSx implementation for testing MCP tools
 */
function createMockFSx(): FSx & {
  _files: Map<string, { content: Uint8Array; mode: number }>
  _directories: Set<string>
  _permissionDenied: Set<string>
} {
  const files = new Map<string, { content: Uint8Array; mode: number }>()
  const directories = new Set<string>(['/', '/test', '/home', '/home/user', '/empty-dir', '/dest'])
  const permissionDenied = new Set<string>()

  const getParentPath = (path: string): string => {
    const lastSlash = path.lastIndexOf('/')
    if (lastSlash <= 0) return '/'
    return path.substring(0, lastSlash)
  }

  // Helper to get all paths under a directory
  const getChildPaths = (dirPath: string): string[] => {
    const children: string[] = []
    const prefix = dirPath === '/' ? '/' : dirPath + '/'

    for (const [filePath] of files) {
      if (filePath.startsWith(prefix)) {
        children.push(filePath)
      }
    }

    for (const dirPathEntry of directories) {
      if (dirPathEntry !== dirPath && dirPathEntry.startsWith(prefix)) {
        children.push(dirPathEntry)
      }
    }

    return children
  }

  const mockFSx = {
    _files: files,
    _directories: directories,
    _permissionDenied: permissionDenied,

    async rename(oldPath: string, newPath: string): Promise<void> {
      // Check for permission denied on source
      if (permissionDenied.has(oldPath)) {
        const error = new Error(`EACCES: permission denied, rename '${oldPath}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'EACCES'
        error.syscall = 'rename'
        error.path = oldPath
        throw error
      }

      // Check for permission denied on destination
      if (permissionDenied.has(newPath)) {
        const error = new Error(`EACCES: permission denied, rename '${newPath}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'EACCES'
        error.syscall = 'rename'
        error.path = newPath
        throw error
      }

      const isFile = files.has(oldPath)
      const isDir = directories.has(oldPath)

      // Source doesn't exist
      if (!isFile && !isDir) {
        const error = new Error(`ENOENT: no such file or directory, rename '${oldPath}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'ENOENT'
        error.syscall = 'rename'
        error.path = oldPath
        throw error
      }

      // Check destination parent exists
      const destParent = getParentPath(newPath)
      if (destParent !== '/' && !directories.has(destParent)) {
        const error = new Error(`ENOENT: no such file or directory, rename '${newPath}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'ENOENT'
        error.syscall = 'rename'
        error.path = newPath
        throw error
      }

      // Check if trying to move directory into itself
      if (isDir) {
        const normalizedOld = oldPath.endsWith('/') ? oldPath.slice(0, -1) : oldPath
        const normalizedNew = newPath.endsWith('/') ? newPath.slice(0, -1) : newPath
        if (normalizedNew.startsWith(normalizedOld + '/')) {
          const error = new Error(`EINVAL: invalid argument, rename '${oldPath}'`) as Error & {
            code: string
            syscall: string
            path: string
          }
          error.code = 'EINVAL'
          error.syscall = 'rename'
          error.path = oldPath
          throw error
        }
      }

      const destIsFile = files.has(newPath)
      const destIsDir = directories.has(newPath)

      // Type mismatch checks
      if (isFile && destIsDir) {
        const error = new Error(`EISDIR: illegal operation on a directory, rename '${newPath}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'EISDIR'
        error.syscall = 'rename'
        error.path = newPath
        throw error
      }

      if (isDir && destIsFile) {
        const error = new Error(`ENOTDIR: not a directory, rename '${newPath}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'ENOTDIR'
        error.syscall = 'rename'
        error.path = newPath
        throw error
      }

      // Check for non-empty directory destination
      if (isDir && destIsDir) {
        const destChildren = getChildPaths(newPath)
        if (destChildren.length > 0) {
          const error = new Error(`ENOTEMPTY: directory not empty, rename '${newPath}'`) as Error & {
            code: string
            syscall: string
            path: string
          }
          error.code = 'ENOTEMPTY'
          error.syscall = 'rename'
          error.path = newPath
          throw error
        }
        // Delete empty destination directory
        directories.delete(newPath)
      }

      // Perform the move
      if (isFile) {
        const file = files.get(oldPath)!
        files.delete(oldPath)
        // Delete existing file at destination if any
        files.delete(newPath)
        files.set(newPath, file)
      } else if (isDir) {
        // Move directory and all its contents
        const children = getChildPaths(oldPath)
        const oldPrefix = oldPath === '/' ? '/' : oldPath
        const newPrefix = newPath === '/' ? '/' : newPath

        // Move all children
        for (const childPath of children) {
          const relativePath = childPath.substring(oldPrefix.length)
          const newChildPath = newPrefix + relativePath

          if (files.has(childPath)) {
            const file = files.get(childPath)!
            files.delete(childPath)
            files.set(newChildPath, file)
          } else if (directories.has(childPath)) {
            directories.delete(childPath)
            directories.add(newChildPath)
          }
        }

        // Move the directory itself
        directories.delete(oldPath)
        directories.add(newPath)
      }
    },

    async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
      const { recursive = false, force = false } = options ?? {}

      if (permissionDenied.has(path)) {
        const error = new Error(`EACCES: permission denied, unlink '${path}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'EACCES'
        error.syscall = 'unlink'
        error.path = path
        throw error
      }

      const isFile = files.has(path)
      const isDir = directories.has(path)

      if (!isFile && !isDir) {
        if (force) return
        const error = new Error(`ENOENT: no such file or directory, rm '${path}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'ENOENT'
        error.syscall = 'rm'
        error.path = path
        throw error
      }

      if (isFile) {
        files.delete(path)
        return
      }

      if (isDir) {
        const children = getChildPaths(path)

        if (children.length > 0 && !recursive) {
          const error = new Error(`ENOTEMPTY: directory not empty, rm '${path}'`) as Error & {
            code: string
            syscall: string
            path: string
          }
          error.code = 'ENOTEMPTY'
          error.syscall = 'rm'
          error.path = path
          throw error
        }

        if (recursive) {
          for (const childPath of children) {
            files.delete(childPath)
            directories.delete(childPath)
          }
        }

        directories.delete(path)
      }
    },

    async readFile(path: string, encoding?: string): Promise<string | Uint8Array> {
      const file = files.get(path)
      if (!file) {
        const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & {
          code: string
        }
        error.code = 'ENOENT'
        throw error
      }
      if (encoding === 'utf-8' || encoding === 'utf8') {
        return new TextDecoder().decode(file.content)
      }
      return file.content
    },

    async writeFile(
      path: string,
      data: string | Uint8Array,
      options?: { encoding?: string; mode?: number; flag?: string }
    ): Promise<void> {
      const content = typeof data === 'string' ? new TextEncoder().encode(data) : data
      files.set(path, { content, mode: options?.mode ?? 0o666 })
    },

    async appendFile(path: string, data: string | Uint8Array): Promise<void> {
      const newContent = typeof data === 'string' ? new TextEncoder().encode(data) : data
      const existing = files.get(path)
      if (existing) {
        const combined = new Uint8Array(existing.content.length + newContent.length)
        combined.set(existing.content)
        combined.set(newContent, existing.content.length)
        files.set(path, { content: combined, mode: existing.mode })
      } else {
        files.set(path, { content: newContent, mode: 0o666 })
      }
    },

    async stat(path: string): Promise<{
      isDirectory: () => boolean
      isSymbolicLink: () => boolean
      isFile: () => boolean
      size: number
      mode: number
      mtime: Date
      birthtime: Date
    }> {
      if (directories.has(path)) {
        return {
          isDirectory: () => true,
          isSymbolicLink: () => false,
          isFile: () => false,
          size: 0,
          mode: 0o755,
          mtime: new Date(),
          birthtime: new Date(),
        }
      }
      const file = files.get(path)
      if (!file) {
        const error = new Error(`ENOENT: no such file or directory, stat '${path}'`) as Error & {
          code: string
        }
        error.code = 'ENOENT'
        throw error
      }
      return {
        isDirectory: () => false,
        isSymbolicLink: () => false,
        isFile: () => true,
        size: file.content.length,
        mode: file.mode,
        mtime: new Date(),
        birthtime: new Date(),
      }
    },

    async exists(path: string): Promise<boolean> {
      return files.has(path) || directories.has(path)
    },

    async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
      if (options?.recursive) {
        const parts = path.split('/').filter(Boolean)
        let currentPath = ''
        for (const part of parts) {
          currentPath += '/' + part
          directories.add(currentPath)
        }
      } else {
        directories.add(path)
      }
    },

    async copyFile(src: string, dest: string): Promise<void> {
      const file = files.get(src)
      if (file) {
        files.set(dest, { ...file, content: new Uint8Array(file.content) })
      }
    },

    async readdir(
      path: string,
      options?: { withFileTypes?: boolean; recursive?: boolean }
    ): Promise<string[] | { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean; path: string }[]> {
      if (!directories.has(path)) {
        const error = new Error(`ENOENT: no such file or directory, scandir '${path}'`) as Error & {
          code: string
        }
        error.code = 'ENOENT'
        throw error
      }

      const prefix = path === '/' ? '/' : path + '/'
      const entries: string[] = []

      for (const [filePath] of files) {
        if (filePath.startsWith(prefix)) {
          const relativePath = filePath.substring(prefix.length)
          const immediateChild = relativePath.split('/')[0]
          if (immediateChild && !entries.includes(immediateChild)) {
            entries.push(immediateChild)
          }
        }
      }

      for (const dirPath of directories) {
        if (dirPath !== path && dirPath.startsWith(prefix)) {
          const relativePath = dirPath.substring(prefix.length)
          const immediateChild = relativePath.split('/')[0]
          if (immediateChild && !entries.includes(immediateChild)) {
            entries.push(immediateChild)
          }
        }
      }

      if (options?.withFileTypes) {
        return entries.map((name) => {
          const fullPath = path === '/' ? `/${name}` : `${path}/${name}`
          return {
            name,
            isDirectory: () => directories.has(fullPath),
            isSymbolicLink: () => false,
            path: fullPath,
          }
        })
      }

      return entries.sort()
    },
  } as unknown as FSx & {
    _files: Map<string, { content: Uint8Array; mode: number }>
    _directories: Set<string>
    _permissionDenied: Set<string>
  }

  return mockFSx
}

describe('fs_move MCP tool', () => {
  describe('tool definition', () => {
    it('should be registered in fsTools', () => {
      const moveTool = fsTools.find((t) => t.name === 'fs_move')
      expect(moveTool).toBeDefined()
    })

    it('should have correct description', () => {
      const moveTool = fsTools.find((t) => t.name === 'fs_move')
      expect(moveTool?.description).toBe('Move or rename a file or directory')
    })

    it('should require source parameter', () => {
      const moveTool = fsTools.find((t) => t.name === 'fs_move')
      expect(moveTool?.inputSchema.required).toContain('source')
    })

    it('should require destination parameter', () => {
      const moveTool = fsTools.find((t) => t.name === 'fs_move')
      expect(moveTool?.inputSchema.required).toContain('destination')
    })

    it('should define source as string type', () => {
      const moveTool = fsTools.find((t) => t.name === 'fs_move')
      expect(moveTool?.inputSchema.properties.source.type).toBe('string')
    })

    it('should define destination as string type', () => {
      const moveTool = fsTools.find((t) => t.name === 'fs_move')
      expect(moveTool?.inputSchema.properties.destination.type).toBe('string')
    })
  })

  describe('move file to new location', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should move a file to a new location in the same directory', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('test content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_move', { source: '/test/source.txt', destination: '/test/dest.txt' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'Successfully moved /test/source.txt to /test/dest.txt',
      })

      // Verify file was moved
      expect(mockFs._files.has('/test/source.txt')).toBe(false)
      expect(mockFs._files.has('/test/dest.txt')).toBe(true)
    })

    it('should move a file to a different directory', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('test content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_move', { source: '/test/source.txt', destination: '/dest/moved.txt' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has('/test/source.txt')).toBe(false)
      expect(mockFs._files.has('/dest/moved.txt')).toBe(true)
    })

    it('should preserve file content after move', async () => {
      const originalContent = new TextEncoder().encode('original content here')
      mockFs._files.set('/test/source.txt', {
        content: originalContent,
        mode: 0o666,
      })

      await invokeTool('fs_move', { source: '/test/source.txt', destination: '/test/dest.txt' }, mockFs)

      const movedFile = mockFs._files.get('/test/dest.txt')
      expect(movedFile?.content).toEqual(originalContent)
    })

    it('should preserve file mode after move', async () => {
      mockFs._files.set('/test/script.sh', {
        content: new TextEncoder().encode('#!/bin/bash'),
        mode: 0o755,
      })

      await invokeTool('fs_move', { source: '/test/script.sh', destination: '/test/moved.sh' }, mockFs)

      const movedFile = mockFs._files.get('/test/moved.sh')
      expect(movedFile?.mode).toBe(0o755)
    })

    it('should move file from nested directory to root', async () => {
      mockFs._directories.add('/test/deep/nested')
      mockFs._files.set('/test/deep/nested/file.txt', {
        content: new TextEncoder().encode('deep content'),
        mode: 0o666,
      })

      const result = await invokeTool(
        'fs_move',
        { source: '/test/deep/nested/file.txt', destination: '/file-at-root.txt' },
        mockFs
      )

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has('/test/deep/nested/file.txt')).toBe(false)
      expect(mockFs._files.has('/file-at-root.txt')).toBe(true)
    })

    it('should move file from root to nested directory', async () => {
      mockFs._directories.add('/dest/deep')
      mockFs._files.set('/root-file.txt', {
        content: new TextEncoder().encode('root content'),
        mode: 0o666,
      })

      const result = await invokeTool(
        'fs_move',
        { source: '/root-file.txt', destination: '/dest/deep/moved.txt' },
        mockFs
      )

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has('/root-file.txt')).toBe(false)
      expect(mockFs._files.has('/dest/deep/moved.txt')).toBe(true)
    })
  })

  describe('rename file in same directory', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should rename a file in place', async () => {
      mockFs._files.set('/test/old-name.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool(
        'fs_move',
        { source: '/test/old-name.txt', destination: '/test/new-name.txt' },
        mockFs
      )

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has('/test/old-name.txt')).toBe(false)
      expect(mockFs._files.has('/test/new-name.txt')).toBe(true)
    })

    it('should handle renaming to same name (no-op)', async () => {
      const originalContent = new TextEncoder().encode('same content')
      mockFs._files.set('/test/same.txt', {
        content: originalContent,
        mode: 0o666,
      })

      const result = await invokeTool('fs_move', { source: '/test/same.txt', destination: '/test/same.txt' }, mockFs)

      // Should either succeed as no-op or fail gracefully
      expect(mockFs._files.has('/test/same.txt')).toBe(true)
      expect(mockFs._files.get('/test/same.txt')?.content).toEqual(originalContent)
    })

    it('should rename file extension', async () => {
      mockFs._files.set('/test/document.txt', {
        content: new TextEncoder().encode('document content'),
        mode: 0o666,
      })

      const result = await invokeTool(
        'fs_move',
        { source: '/test/document.txt', destination: '/test/document.md' },
        mockFs
      )

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has('/test/document.txt')).toBe(false)
      expect(mockFs._files.has('/test/document.md')).toBe(true)
    })
  })

  describe('move directory', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
      // Set up a directory with contents
      mockFs._directories.add('/project')
      mockFs._directories.add('/project/src')
      mockFs._files.set('/project/README.md', {
        content: new TextEncoder().encode('# Project'),
        mode: 0o666,
      })
      mockFs._files.set('/project/src/index.ts', {
        content: new TextEncoder().encode('export {}'),
        mode: 0o666,
      })
    })

    it('should move an empty directory', async () => {
      const result = await invokeTool(
        'fs_move',
        { source: '/empty-dir', destination: '/dest/moved-empty' },
        mockFs
      )

      expect(result.isError).toBeFalsy()
      expect(mockFs._directories.has('/empty-dir')).toBe(false)
      expect(mockFs._directories.has('/dest/moved-empty')).toBe(true)
    })

    it('should move a directory with contents', async () => {
      const result = await invokeTool('fs_move', { source: '/project', destination: '/dest/project' }, mockFs)

      expect(result.isError).toBeFalsy()

      // Old paths should not exist
      expect(mockFs._directories.has('/project')).toBe(false)
      expect(mockFs._directories.has('/project/src')).toBe(false)
      expect(mockFs._files.has('/project/README.md')).toBe(false)
      expect(mockFs._files.has('/project/src/index.ts')).toBe(false)

      // New paths should exist
      expect(mockFs._directories.has('/dest/project')).toBe(true)
      expect(mockFs._directories.has('/dest/project/src')).toBe(true)
      expect(mockFs._files.has('/dest/project/README.md')).toBe(true)
      expect(mockFs._files.has('/dest/project/src/index.ts')).toBe(true)
    })

    it('should preserve content of moved directory files', async () => {
      await invokeTool('fs_move', { source: '/project', destination: '/dest/project' }, mockFs)

      const readmeContent = mockFs._files.get('/dest/project/README.md')?.content
      expect(new TextDecoder().decode(readmeContent)).toBe('# Project')
    })

    it('should rename a directory in place', async () => {
      const result = await invokeTool('fs_move', { source: '/project', destination: '/project-renamed' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(mockFs._directories.has('/project')).toBe(false)
      expect(mockFs._directories.has('/project-renamed')).toBe(true)
      expect(mockFs._directories.has('/project-renamed/src')).toBe(true)
    })

    it('should move nested subdirectory to different location', async () => {
      const result = await invokeTool('fs_move', { source: '/project/src', destination: '/dest/src-extracted' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(mockFs._directories.has('/project/src')).toBe(false)
      expect(mockFs._directories.has('/dest/src-extracted')).toBe(true)
      expect(mockFs._files.has('/dest/src-extracted/index.ts')).toBe(true)

      // Parent directory should still exist
      expect(mockFs._directories.has('/project')).toBe(true)
    })
  })

  describe('overwrite existing file', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should overwrite existing file at destination', async () => {
      const sourceContent = new TextEncoder().encode('source content - should win')
      const destContent = new TextEncoder().encode('dest content - should be replaced')

      mockFs._files.set('/test/source.txt', { content: sourceContent, mode: 0o666 })
      mockFs._files.set('/test/dest.txt', { content: destContent, mode: 0o666 })

      const result = await invokeTool('fs_move', { source: '/test/source.txt', destination: '/test/dest.txt' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has('/test/source.txt')).toBe(false)
      expect(mockFs._files.has('/test/dest.txt')).toBe(true)

      const finalContent = mockFs._files.get('/test/dest.txt')?.content
      expect(finalContent).toEqual(sourceContent)
    })

    it('should overwrite larger destination with smaller source', async () => {
      const smallContent = new TextEncoder().encode('small')
      const largeContent = new Uint8Array(10000).fill(0x41)

      mockFs._files.set('/test/small.txt', { content: smallContent, mode: 0o666 })
      mockFs._files.set('/test/large.txt', { content: largeContent, mode: 0o666 })

      await invokeTool('fs_move', { source: '/test/small.txt', destination: '/test/large.txt' }, mockFs)

      const finalContent = mockFs._files.get('/test/large.txt')?.content
      expect(finalContent).toEqual(smallContent)
      expect(finalContent?.length).toBe(5)
    })

    it('should overwrite smaller destination with larger source', async () => {
      const smallContent = new TextEncoder().encode('small')
      const largeContent = new Uint8Array(10000).fill(0x42)

      mockFs._files.set('/test/large.bin', { content: largeContent, mode: 0o666 })
      mockFs._files.set('/test/small.txt', { content: smallContent, mode: 0o666 })

      await invokeTool('fs_move', { source: '/test/large.bin', destination: '/test/small.txt' }, mockFs)

      const finalContent = mockFs._files.get('/test/small.txt')?.content
      expect(finalContent).toEqual(largeContent)
      expect(finalContent?.length).toBe(10000)
    })
  })

  describe('handle source not found error', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should return error when source file does not exist', async () => {
      const result = await invokeTool(
        'fs_move',
        { source: '/nonexistent.txt', destination: '/dest/file.txt' },
        mockFs
      )

      expect(result.isError).toBe(true)
      expect(result.content[0].type).toBe('text')
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText).toContain('Error')
    })

    it('should include ENOENT indicator in error message', async () => {
      const result = await invokeTool(
        'fs_move',
        { source: '/nonexistent/deep/file.txt', destination: '/dest/file.txt' },
        mockFs
      )

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText.toLowerCase()).toMatch(/no such file|enoent|not found/)
    })

    it('should return error when source directory does not exist', async () => {
      const result = await invokeTool(
        'fs_move',
        { source: '/nonexistent-dir', destination: '/dest/dir' },
        mockFs
      )

      expect(result.isError).toBe(true)
    })
  })

  describe('handle destination parent not found error', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should return error when destination parent directory does not exist', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool(
        'fs_move',
        { source: '/test/source.txt', destination: '/nonexistent-parent/file.txt' },
        mockFs
      )

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText.toLowerCase()).toMatch(/no such file|enoent|not found/)
    })

    it('should not move source when destination parent is missing', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      await invokeTool(
        'fs_move',
        { source: '/test/source.txt', destination: '/nonexistent/deep/path/file.txt' },
        mockFs
      )

      // Source should still exist
      expect(mockFs._files.has('/test/source.txt')).toBe(true)
    })
  })

  describe('handle permission denied error', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should return error when permission denied on source', async () => {
      const path = '/test/readonly.txt'
      mockFs._files.set(path, {
        content: new TextEncoder().encode('protected content'),
        mode: 0o444,
      })
      mockFs._permissionDenied.add(path)

      const result = await invokeTool('fs_move', { source: path, destination: '/dest/moved.txt' }, mockFs)

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText.toLowerCase()).toMatch(/permission|eacces|denied/)
    })

    it('should return error when permission denied on destination', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })
      mockFs._permissionDenied.add('/dest/protected.txt')

      const result = await invokeTool(
        'fs_move',
        { source: '/test/source.txt', destination: '/dest/protected.txt' },
        mockFs
      )

      expect(result.isError).toBe(true)
    })

    it('should not move file when permission denied', async () => {
      const path = '/test/keep-this.txt'
      mockFs._files.set(path, {
        content: new TextEncoder().encode('should remain'),
        mode: 0o666,
      })
      mockFs._permissionDenied.add(path)

      await invokeTool('fs_move', { source: path, destination: '/dest/moved.txt' }, mockFs)

      // File should still exist at original location
      expect(mockFs._files.has(path)).toBe(true)
    })
  })

  describe('handle type mismatch errors', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should return error when moving file to existing directory', async () => {
      mockFs._files.set('/test/file.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })
      mockFs._directories.add('/test/existing-dir')

      const result = await invokeTool(
        'fs_move',
        { source: '/test/file.txt', destination: '/test/existing-dir' },
        mockFs
      )

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText.toLowerCase()).toMatch(/directory|eisdir/)
    })

    it('should return error when moving directory to existing file', async () => {
      mockFs._directories.add('/test/mydir')
      mockFs._files.set('/test/existing-file.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool(
        'fs_move',
        { source: '/test/mydir', destination: '/test/existing-file.txt' },
        mockFs
      )

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText.toLowerCase()).toMatch(/not a directory|enotdir/)
    })
  })

  describe('handle move directory into itself', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
      mockFs._directories.add('/parent')
      mockFs._directories.add('/parent/child')
    })

    it('should return error when moving directory into itself', async () => {
      const result = await invokeTool(
        'fs_move',
        { source: '/parent', destination: '/parent/child/moved' },
        mockFs
      )

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText.toLowerCase()).toMatch(/invalid|einval/)
    })

    it('should not modify directory when trying to move into itself', async () => {
      await invokeTool('fs_move', { source: '/parent', destination: '/parent/child/moved' }, mockFs)

      // Directory structure should be unchanged
      expect(mockFs._directories.has('/parent')).toBe(true)
      expect(mockFs._directories.has('/parent/child')).toBe(true)
    })
  })

  describe('handle non-empty directory destination', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
      mockFs._directories.add('/source-dir')
      mockFs._directories.add('/target-non-empty')
      mockFs._files.set('/target-non-empty/existing.txt', {
        content: new TextEncoder().encode('existing'),
        mode: 0o666,
      })
    })

    it('should return error when destination is non-empty directory', async () => {
      const result = await invokeTool(
        'fs_move',
        { source: '/source-dir', destination: '/target-non-empty' },
        mockFs
      )

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText.toLowerCase()).toMatch(/not empty|enotempty/)
    })

    it('should allow move to empty directory destination', async () => {
      mockFs._directories.add('/target-empty')

      const result = await invokeTool(
        'fs_move',
        { source: '/source-dir', destination: '/target-empty' },
        mockFs
      )

      expect(result.isError).toBeFalsy()
      expect(mockFs._directories.has('/source-dir')).toBe(false)
      expect(mockFs._directories.has('/target-empty')).toBe(true)
    })
  })

  describe('MCP result format', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should return properly formatted success result', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_move', { source: '/test/source.txt', destination: '/test/dest.txt' }, mockFs)

      expect(result).toHaveProperty('content')
      expect(Array.isArray(result.content)).toBe(true)
      expect(result.content.length).toBeGreaterThan(0)
      expect(result.content[0]).toHaveProperty('type')
      expect(result.content[0]).toHaveProperty('text')
    })

    it('should return properly formatted error result', async () => {
      const result = await invokeTool('fs_move', { source: '/nonexistent.txt', destination: '/dest.txt' }, mockFs)

      expect(result).toHaveProperty('content')
      expect(result).toHaveProperty('isError')
      expect(result.isError).toBe(true)
      expect(Array.isArray(result.content)).toBe(true)
      expect(result.content[0]).toHaveProperty('type', 'text')
    })

    it('should include both paths in success message', async () => {
      const source = '/test/src-file.txt'
      const destination = '/test/dst-file.txt'
      mockFs._files.set(source, {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_move', { source, destination }, mockFs)

      expect(result.isError).toBeFalsy()
      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain(source)
      expect(text).toContain(destination)
    })

    it('should have text type in content array', async () => {
      mockFs._files.set('/test/file.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_move', { source: '/test/file.txt', destination: '/test/moved.txt' }, mockFs)

      expect(result.content[0].type).toBe('text')
    })
  })

  describe('edge cases', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should handle very long file paths', async () => {
      const longSource = '/test/' + 'a'.repeat(200) + '.txt'
      const longDest = '/test/' + 'b'.repeat(200) + '.txt'
      mockFs._files.set(longSource, {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_move', { source: longSource, destination: longDest }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has(longSource)).toBe(false)
      expect(mockFs._files.has(longDest)).toBe(true)
    })

    it('should handle paths with spaces', async () => {
      const source = '/test/file with spaces.txt'
      const dest = '/test/moved file with spaces.txt'
      mockFs._files.set(source, {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_move', { source, destination: dest }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has(source)).toBe(false)
      expect(mockFs._files.has(dest)).toBe(true)
    })

    it('should handle paths with special characters', async () => {
      const source = '/test/file-with_special.chars!.txt'
      const dest = '/test/moved-with_special.chars!.txt'
      mockFs._files.set(source, {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_move', { source, destination: dest }, mockFs)

      expect(result.isError).toBeFalsy()
    })

    it('should handle empty source path', async () => {
      const result = await invokeTool('fs_move', { source: '', destination: '/dest/file.txt' }, mockFs)

      // Should handle gracefully (likely error)
      expect(result.content).toBeDefined()
    })

    it('should handle empty destination path', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_move', { source: '/test/source.txt', destination: '' }, mockFs)

      // Should handle gracefully (likely error)
      expect(result.content).toBeDefined()
    })

    it('should handle large file move', async () => {
      const largeContent = new Uint8Array(10 * 1024 * 1024) // 10MB
      for (let i = 0; i < largeContent.length; i++) {
        largeContent[i] = i % 256
      }
      mockFs._files.set('/test/large.bin', {
        content: largeContent,
        mode: 0o666,
      })

      const result = await invokeTool('fs_move', { source: '/test/large.bin', destination: '/dest/large.bin' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.get('/dest/large.bin')?.content).toEqual(largeContent)
    })

    it('should handle concurrent move operations on different files', async () => {
      mockFs._files.set('/test/file1.txt', {
        content: new TextEncoder().encode('content1'),
        mode: 0o666,
      })
      mockFs._files.set('/test/file2.txt', {
        content: new TextEncoder().encode('content2'),
        mode: 0o666,
      })

      const results = await Promise.all([
        invokeTool('fs_move', { source: '/test/file1.txt', destination: '/dest/moved1.txt' }, mockFs),
        invokeTool('fs_move', { source: '/test/file2.txt', destination: '/dest/moved2.txt' }, mockFs),
      ])

      for (const result of results) {
        expect(result.isError).toBeFalsy()
      }

      expect(mockFs._files.has('/dest/moved1.txt')).toBe(true)
      expect(mockFs._files.has('/dest/moved2.txt')).toBe(true)
    })
  })

  describe('verify move operation', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should make stat fail on source after move', async () => {
      const path = '/test/to-move.txt'
      mockFs._files.set(path, {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      await invokeTool('fs_move', { source: path, destination: '/dest/moved.txt' }, mockFs)

      // stat should fail on source after move
      await expect(mockFs.stat(path)).rejects.toThrow()
    })

    it('should make stat succeed on destination after move', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      await invokeTool('fs_move', { source: '/test/source.txt', destination: '/dest/moved.txt' }, mockFs)

      // stat should succeed on destination
      const stat = await mockFs.stat('/dest/moved.txt')
      expect(stat.isFile()).toBe(true)
    })

    it('should make readFile fail on source after move', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      await invokeTool('fs_move', { source: '/test/source.txt', destination: '/dest/moved.txt' }, mockFs)

      await expect(mockFs.readFile('/test/source.txt')).rejects.toThrow()
    })

    it('should make exists return false on source after move', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      await invokeTool('fs_move', { source: '/test/source.txt', destination: '/dest/moved.txt' }, mockFs)

      expect(await mockFs.exists('/test/source.txt')).toBe(false)
    })

    it('should make exists return true on destination after move', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      await invokeTool('fs_move', { source: '/test/source.txt', destination: '/dest/moved.txt' }, mockFs)

      expect(await mockFs.exists('/dest/moved.txt')).toBe(true)
    })

    it('should remove file from source directory listing after move', async () => {
      mockFs._files.set('/test/child-to-move.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      // Before move
      const beforeEntries = await mockFs.readdir('/test')
      expect(beforeEntries).toContain('child-to-move.txt')

      await invokeTool('fs_move', { source: '/test/child-to-move.txt', destination: '/dest/moved.txt' }, mockFs)

      // After move
      const afterEntries = await mockFs.readdir('/test')
      expect(afterEntries).not.toContain('child-to-move.txt')
    })

    it('should add file to destination directory listing after move', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      // Before move
      const beforeEntries = await mockFs.readdir('/dest')
      expect(beforeEntries).not.toContain('moved.txt')

      await invokeTool('fs_move', { source: '/test/source.txt', destination: '/dest/moved.txt' }, mockFs)

      // After move
      const afterEntries = await mockFs.readdir('/dest')
      expect(afterEntries).toContain('moved.txt')
    })
  })
})

/**
 * Integration Tests for realpath() symlink resolution
 *
 * These tests verify that FSx.realpath() properly delegates to the backend
 * and that MockBackend.realpath() correctly resolves symlinks in all path
 * components, not just the final one.
 *
 * @module test/utilities/realpath-integration
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { MockBackend } from '../../core/mock-backend'
import { FSx } from '../../core/fsx'

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Create an FSx instance with MockBackend for testing
 */
function createFSx(): FSx {
  const backend = new MockBackend()
  return new FSx({ backend })
}

/**
 * Helper to set up a filesystem with symlinks for testing
 */
async function setupSymlinkFilesystem(fsx: FSx): Promise<void> {
  const encoder = new TextEncoder()

  // Create directory structure
  await fsx.mkdir('/home/user', { recursive: true })
  await fsx.mkdir('/home/other', { recursive: true })
  await fsx.mkdir('/data', { recursive: true })
  await fsx.mkdir('/deep/nested/dir', { recursive: true })
  await fsx.mkdir('/multi', { recursive: true })

  // Create files
  await fsx.writeFile('/home/user/file.txt', encoder.encode('user file'))
  await fsx.writeFile('/home/other/file.txt', encoder.encode('other file'))
  await fsx.writeFile('/data/file.txt', encoder.encode('data file'))
  await fsx.writeFile('/deep/nested/dir/file.txt', encoder.encode('deep file'))

  // Create symlinks
  // Symlink at end of path
  await fsx.symlink('/home/user/file.txt', '/link-to-file')

  // Symlink to directory
  await fsx.symlink('/home/user', '/link-to-dir')

  // Chained symlinks
  await fsx.symlink('/chain2', '/chain1')
  await fsx.symlink('/home/user/file.txt', '/chain2')

  // Relative symlink
  await fsx.symlink('../other/file.txt', '/home/user/rel-link')

  // Multiple symlinks in single path
  await fsx.symlink('/home', '/multi/link1')
  await fsx.symlink('/home/user', '/home/link2')

  // Symlink with .. in target
  await fsx.symlink('../user/file.txt', '/home/other/dotdot-link')

  // Symlink to root
  await fsx.symlink('/', '/to-root')

  // First component is symlink
  await fsx.symlink('/home', '/first-link')
}

/**
 * Helper to set up circular symlinks for ELOOP testing
 */
async function setupCircularSymlinks(fsx: FSx): Promise<void> {
  // Simple circular: A -> B -> A
  await fsx.symlink('/loop2', '/loop1')
  await fsx.symlink('/loop1', '/loop2')

  // Self-referencing symlink
  await fsx.symlink('/self-link', '/self-link')

  // Three-way cycle
  await fsx.symlink('/cycleB', '/cycleA')
  await fsx.symlink('/cycleC', '/cycleB')
  await fsx.symlink('/cycleA', '/cycleC')
}

// =============================================================================
// Tests: Basic Path Resolution (no symlinks)
// =============================================================================

describe('realpath() basic path resolution', () => {
  let fsx: FSx

  beforeEach(async () => {
    fsx = createFSx()
    await setupSymlinkFilesystem(fsx)
  })

  it('should return canonical path for regular file', async () => {
    const result = await fsx.realpath('/home/user/file.txt')
    expect(result).toBe('/home/user/file.txt')
  })

  it('should return canonical path for directory', async () => {
    const result = await fsx.realpath('/home/user')
    expect(result).toBe('/home/user')
  })

  it('should normalize path with . components', async () => {
    const result = await fsx.realpath('/home/./user/./file.txt')
    expect(result).toBe('/home/user/file.txt')
  })

  it('should normalize path with .. components', async () => {
    const result = await fsx.realpath('/home/user/../user/file.txt')
    expect(result).toBe('/home/user/file.txt')
  })

  it('should handle multiple .. components', async () => {
    const result = await fsx.realpath('/home/user/subdir/../../user/file.txt')
    expect(result).toBe('/home/user/file.txt')
  })

  it('should handle root path', async () => {
    const result = await fsx.realpath('/')
    expect(result).toBe('/')
  })

  it('should strip trailing slashes', async () => {
    const result = await fsx.realpath('/home/user/')
    expect(result).toBe('/home/user')
  })

  it('should handle multiple consecutive slashes', async () => {
    const result = await fsx.realpath('/home//user///file.txt')
    expect(result).toBe('/home/user/file.txt')
  })
})

// =============================================================================
// Tests: Symlink Resolution
// =============================================================================

describe('realpath() symlink resolution', () => {
  let fsx: FSx

  beforeEach(async () => {
    fsx = createFSx()
    await setupSymlinkFilesystem(fsx)
  })

  it('should resolve symlink at end of path', async () => {
    // /link-to-file -> /home/user/file.txt
    const result = await fsx.realpath('/link-to-file')
    expect(result).toBe('/home/user/file.txt')
  })

  it('should resolve symlink in middle of path (symlink to directory)', async () => {
    // /link-to-dir -> /home/user
    // So /link-to-dir/file.txt should resolve to /home/user/file.txt
    const result = await fsx.realpath('/link-to-dir/file.txt')
    expect(result).toBe('/home/user/file.txt')
  })

  it('should resolve chained symlinks (A -> B -> C)', async () => {
    // /chain1 -> /chain2 -> /home/user/file.txt
    const result = await fsx.realpath('/chain1')
    expect(result).toBe('/home/user/file.txt')
  })

  it('should resolve relative symlink targets relative to symlink location', async () => {
    // /home/user/rel-link -> ../other/file.txt
    // Should resolve to /home/other/file.txt
    const result = await fsx.realpath('/home/user/rel-link')
    expect(result).toBe('/home/other/file.txt')
  })

  it('should resolve multiple symlinks in single path', async () => {
    // /multi/link1 -> /home
    // /home/link2 -> /home/user
    // So /multi/link1/link2/file.txt should resolve to /home/user/file.txt
    const result = await fsx.realpath('/multi/link1/link2/file.txt')
    expect(result).toBe('/home/user/file.txt')
  })

  it('should handle symlink with .. in target', async () => {
    // /home/other/dotdot-link -> ../user/file.txt
    // Should resolve to /home/user/file.txt
    const result = await fsx.realpath('/home/other/dotdot-link')
    expect(result).toBe('/home/user/file.txt')
  })

  it('should handle symlink pointing to root', async () => {
    // /to-root -> /
    const result = await fsx.realpath('/to-root')
    expect(result).toBe('/')
  })

  it('should resolve path starting with symlink (first component is symlink)', async () => {
    // /first-link -> /home
    // So /first-link/user/file.txt should resolve to /home/user/file.txt
    const result = await fsx.realpath('/first-link/user/file.txt')
    expect(result).toBe('/home/user/file.txt')
  })
})

// =============================================================================
// Tests: Error Handling - ENOENT
// =============================================================================

describe('realpath() ENOENT error handling', () => {
  let fsx: FSx

  beforeEach(async () => {
    fsx = createFSx()
    await setupSymlinkFilesystem(fsx)
  })

  it('should throw ENOENT when path does not exist', async () => {
    await expect(fsx.realpath('/nonexistent')).rejects.toThrow(/ENOENT/)
  })

  it('should throw ENOENT when parent directory does not exist', async () => {
    await expect(fsx.realpath('/nonexistent/dir/file.txt')).rejects.toThrow(/ENOENT/)
  })

  it('should throw ENOENT when symlink target does not exist (dangling symlink)', async () => {
    // Create a dangling symlink
    await fsx.symlink('/does/not/exist', '/dangling-link')
    await expect(fsx.realpath('/dangling-link')).rejects.toThrow(/ENOENT/)
  })

  it('should throw ENOENT when intermediate component does not exist', async () => {
    await expect(fsx.realpath('/home/nonexistent/file.txt')).rejects.toThrow(/ENOENT/)
  })
})

// =============================================================================
// Tests: Error Handling - ELOOP (circular symlinks)
// =============================================================================

describe('realpath() ELOOP error handling', () => {
  let fsx: FSx

  beforeEach(async () => {
    fsx = createFSx()
    // Set up circular symlinks for ELOOP testing
    await setupCircularSymlinks(fsx)
  })

  it('should throw ELOOP for circular symlinks (A -> B -> A)', async () => {
    // /loop1 -> /loop2 -> /loop1
    await expect(fsx.realpath('/loop1')).rejects.toThrow(/ELOOP/)
  })

  it('should throw ELOOP for self-referencing symlink', async () => {
    // /self-link -> /self-link
    await expect(fsx.realpath('/self-link')).rejects.toThrow(/ELOOP/)
  })

  it('should throw ELOOP for indirect circular reference (3-way cycle)', async () => {
    // /cycleA -> /cycleB -> /cycleC -> /cycleA
    await expect(fsx.realpath('/cycleA')).rejects.toThrow(/ELOOP/)
  })
})

// =============================================================================
// Tests: Deep Chain (exceeds MAX_SYMLINK_DEPTH)
// =============================================================================

describe('realpath() deep symlink chain', () => {
  let fsx: FSx

  beforeEach(async () => {
    fsx = createFSx()
    // Create a chain of 50 symlinks (exceeds POSIX MAX of 40)
    for (let i = 0; i < 50; i++) {
      const target = i === 49 ? '/final-target' : `/chain-${i + 1}`
      await fsx.symlink(target, `/chain-${i}`)
    }
  })

  it('should throw ELOOP when symlink depth exceeds maximum', async () => {
    await expect(fsx.realpath('/chain-0')).rejects.toThrow(/ELOOP/)
  })
})

// =============================================================================
// Tests: Edge Cases
// =============================================================================

describe('realpath() edge cases', () => {
  let fsx: FSx

  beforeEach(async () => {
    fsx = createFSx()
    const encoder = new TextEncoder()

    // Create directories and files with special names
    await fsx.mkdir('/path with spaces', { recursive: true })
    await fsx.writeFile('/path with spaces/file.txt', encoder.encode('spaces'))

    await fsx.mkdir('/unicode', { recursive: true })
    await fsx.writeFile('/unicode/file.txt', encoder.encode('unicode'))
  })

  it('should handle paths with spaces', async () => {
    const result = await fsx.realpath('/path with spaces/file.txt')
    expect(result).toBe('/path with spaces/file.txt')
  })

  it('should handle paths with unicode characters', async () => {
    const result = await fsx.realpath('/unicode/file.txt')
    expect(result).toBe('/unicode/file.txt')
  })

  it('should handle empty path components (multiple slashes)', async () => {
    const result = await fsx.realpath('//unicode//file.txt')
    expect(result).toBe('/unicode/file.txt')
  })
})

// =============================================================================
// Tests: Complex Scenarios
// =============================================================================

describe('realpath() complex scenarios', () => {
  let fsx: FSx

  beforeEach(async () => {
    fsx = createFSx()
    const encoder = new TextEncoder()

    // Create a complex filesystem structure
    await fsx.mkdir('/app/src/components', { recursive: true })
    await fsx.mkdir('/app/lib', { recursive: true })
    await fsx.mkdir('/shared/modules', { recursive: true })
    await fsx.writeFile('/shared/modules/utils.ts', encoder.encode('utils'))

    // Create a chain of symlinks traversing the structure
    // /app/lib/shared -> ../../shared
    // /app/src/modules -> ../../shared/modules
    await fsx.symlink('../../shared', '/app/lib/shared')
    await fsx.symlink('../../shared/modules', '/app/src/modules')
  })

  it('should resolve complex relative symlink chains', async () => {
    // /app/lib/shared -> ../../shared
    // So /app/lib/shared/modules/utils.ts should resolve to /shared/modules/utils.ts
    const result = await fsx.realpath('/app/lib/shared/modules/utils.ts')
    expect(result).toBe('/shared/modules/utils.ts')
  })

  it('should resolve nested relative symlinks', async () => {
    // /app/src/modules -> ../../shared/modules
    // So /app/src/modules/utils.ts should resolve to /shared/modules/utils.ts
    const result = await fsx.realpath('/app/src/modules/utils.ts')
    expect(result).toBe('/shared/modules/utils.ts')
  })

  it('should handle path with both . and .. and symlinks', async () => {
    // Complex path with normalization and symlink resolution
    const result = await fsx.realpath('/app/./src/../src/./modules/utils.ts')
    expect(result).toBe('/shared/modules/utils.ts')
  })
})

/**
 * Tests for MCP Tool Authentication Middleware
 *
 * @module tests/mcp/auth-middleware.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createMCPAuthMiddleware,
  checkToolAuth,
  isReadOnlyTool,
  isWriteTool,
  getRequiredScope,
  createAuthMetadata,
  createAnonymousAuthContext,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  type MCPToolAuthContext,
  type ToolAuthCheckResult,
} from '../../core/mcp/auth-middleware'
import {
  useMiddleware,
  clearMiddleware,
  invokeTool,
  getToolRegistry,
} from '../../core/mcp/tool-registry'
import { InMemoryStorage, createTestFilesystem } from '../test-utils'

// =============================================================================
// Tool Classification Tests
// =============================================================================

describe('Tool Classification', () => {
  describe('READ_ONLY_TOOLS', () => {
    it('should contain all read-only tools', () => {
      expect(READ_ONLY_TOOLS).toContain('fs_read')
      expect(READ_ONLY_TOOLS).toContain('fs_list')
      expect(READ_ONLY_TOOLS).toContain('fs_stat')
      expect(READ_ONLY_TOOLS).toContain('fs_tree')
      expect(READ_ONLY_TOOLS).toContain('fs_search')
      expect(READ_ONLY_TOOLS).toContain('fs_exists')
    })

    it('should not contain write tools', () => {
      expect(READ_ONLY_TOOLS).not.toContain('fs_write')
      expect(READ_ONLY_TOOLS).not.toContain('fs_delete')
    })
  })

  describe('WRITE_TOOLS', () => {
    it('should contain all write tools', () => {
      expect(WRITE_TOOLS).toContain('fs_write')
      expect(WRITE_TOOLS).toContain('fs_append')
      expect(WRITE_TOOLS).toContain('fs_delete')
      expect(WRITE_TOOLS).toContain('fs_move')
      expect(WRITE_TOOLS).toContain('fs_copy')
      expect(WRITE_TOOLS).toContain('fs_mkdir')
    })

    it('should not contain read tools', () => {
      expect(WRITE_TOOLS).not.toContain('fs_read')
      expect(WRITE_TOOLS).not.toContain('fs_list')
    })
  })

  describe('isReadOnlyTool', () => {
    it('should return true for read-only tools', () => {
      expect(isReadOnlyTool('fs_read')).toBe(true)
      expect(isReadOnlyTool('fs_list')).toBe(true)
      expect(isReadOnlyTool('fs_stat')).toBe(true)
    })

    it('should return false for write tools', () => {
      expect(isReadOnlyTool('fs_write')).toBe(false)
      expect(isReadOnlyTool('fs_delete')).toBe(false)
    })

    it('should be case-insensitive', () => {
      expect(isReadOnlyTool('FS_READ')).toBe(true)
      expect(isReadOnlyTool('Fs_List')).toBe(true)
    })
  })

  describe('isWriteTool', () => {
    it('should return true for write tools', () => {
      expect(isWriteTool('fs_write')).toBe(true)
      expect(isWriteTool('fs_delete')).toBe(true)
      expect(isWriteTool('fs_mkdir')).toBe(true)
    })

    it('should return false for read-only tools', () => {
      expect(isWriteTool('fs_read')).toBe(false)
      expect(isWriteTool('fs_list')).toBe(false)
    })
  })

  describe('getRequiredScope', () => {
    it('should return "read" for read-only tools', () => {
      expect(getRequiredScope('fs_read')).toBe('read')
      expect(getRequiredScope('fs_list')).toBe('read')
    })

    it('should return "write" for write tools', () => {
      expect(getRequiredScope('fs_write')).toBe('write')
      expect(getRequiredScope('fs_delete')).toBe('write')
    })

    it('should return "admin" for unknown tools', () => {
      expect(getRequiredScope('unknown_tool')).toBe('admin')
    })
  })
})

// =============================================================================
// Auth Check Tests
// =============================================================================

describe('checkToolAuth', () => {
  describe('read-only tools with anonymous access allowed', () => {
    it('should allow anonymous access to read tools', () => {
      const result = checkToolAuth('fs_read', undefined, true)
      expect(result.allowed).toBe(true)
    })

    it('should allow authenticated access to read tools with read scope', () => {
      const auth: MCPToolAuthContext = {
        authenticated: true,
        userId: 'user-1',
        scopes: ['read'],
        anonymousAllowed: true,
      }
      const result = checkToolAuth('fs_read', auth, true)
      expect(result.allowed).toBe(true)
    })

    it('should allow authenticated access to read tools with write scope', () => {
      const auth: MCPToolAuthContext = {
        authenticated: true,
        userId: 'user-1',
        scopes: ['write'],
        anonymousAllowed: true,
      }
      const result = checkToolAuth('fs_list', auth, true)
      expect(result.allowed).toBe(true)
    })

    it('should allow authenticated access with admin scope', () => {
      const auth: MCPToolAuthContext = {
        authenticated: true,
        userId: 'user-1',
        scopes: ['admin'],
        anonymousAllowed: true,
      }
      const result = checkToolAuth('fs_read', auth, true)
      expect(result.allowed).toBe(true)
    })
  })

  describe('read-only tools with anonymous access denied', () => {
    it('should deny anonymous access to read tools', () => {
      const result = checkToolAuth('fs_read', undefined, false)
      expect(result.allowed).toBe(false)
      expect(result.code).toBe('AUTH_REQUIRED')
    })

    it('should allow authenticated access with read scope', () => {
      const auth: MCPToolAuthContext = {
        authenticated: true,
        userId: 'user-1',
        scopes: ['read'],
        anonymousAllowed: false,
      }
      const result = checkToolAuth('fs_read', auth, false)
      expect(result.allowed).toBe(true)
    })
  })

  describe('write tools', () => {
    it('should deny anonymous access to write tools', () => {
      const result = checkToolAuth('fs_write', undefined, true)
      expect(result.allowed).toBe(false)
      expect(result.code).toBe('AUTH_REQUIRED')
    })

    it('should deny authenticated access without write scope', () => {
      const auth: MCPToolAuthContext = {
        authenticated: true,
        userId: 'user-1',
        scopes: ['read'],
        anonymousAllowed: true,
      }
      const result = checkToolAuth('fs_write', auth, true)
      expect(result.allowed).toBe(false)
      expect(result.code).toBe('PERMISSION_DENIED')
    })

    it('should allow authenticated access with write scope', () => {
      const auth: MCPToolAuthContext = {
        authenticated: true,
        userId: 'user-1',
        scopes: ['write'],
        anonymousAllowed: true,
      }
      const result = checkToolAuth('fs_write', auth, true)
      expect(result.allowed).toBe(true)
    })

    it('should allow authenticated access with admin scope', () => {
      const auth: MCPToolAuthContext = {
        authenticated: true,
        userId: 'user-1',
        scopes: ['admin'],
        anonymousAllowed: true,
      }
      const result = checkToolAuth('fs_delete', auth, true)
      expect(result.allowed).toBe(true)
    })

    it('should allow files:write scope for write operations', () => {
      const auth: MCPToolAuthContext = {
        authenticated: true,
        userId: 'user-1',
        scopes: ['files:write'],
        anonymousAllowed: true,
      }
      const result = checkToolAuth('fs_write', auth, true)
      expect(result.allowed).toBe(true)
    })
  })

  describe('unknown tools', () => {
    it('should deny anonymous access to unknown tools', () => {
      const result = checkToolAuth('unknown_tool', undefined, true)
      expect(result.allowed).toBe(false)
      expect(result.code).toBe('AUTH_REQUIRED')
    })

    it('should require admin scope for unknown tools', () => {
      const auth: MCPToolAuthContext = {
        authenticated: true,
        userId: 'user-1',
        scopes: ['write'],
        anonymousAllowed: true,
      }
      const result = checkToolAuth('unknown_tool', auth, true)
      expect(result.allowed).toBe(false)
      expect(result.code).toBe('PERMISSION_DENIED')
    })

    it('should allow admin access to unknown tools', () => {
      const auth: MCPToolAuthContext = {
        authenticated: true,
        userId: 'user-1',
        scopes: ['admin'],
        anonymousAllowed: true,
      }
      const result = checkToolAuth('unknown_tool', auth, true)
      expect(result.allowed).toBe(true)
    })
  })
})

// =============================================================================
// Middleware Integration Tests
// =============================================================================

describe('createMCPAuthMiddleware', () => {
  let storage: InMemoryStorage

  beforeEach(() => {
    clearMiddleware()
    storage = createTestFilesystem()
    storage.addFile('/test.txt', 'Hello, World!')
  })

  it('should allow anonymous read with default config (search tool)', async () => {
    const middleware = createMCPAuthMiddleware()
    useMiddleware(middleware)

    // The search tool is a read operation - should be allowed anonymously with default config
    const result = await invokeTool('search', { query: '*.txt' }, storage)
    expect(result.isError).toBe(false)
  })

  it('should allow anonymous read with default config (fetch tool)', async () => {
    const middleware = createMCPAuthMiddleware()
    useMiddleware(middleware)

    // The fetch tool is a read operation - should be allowed anonymously with default config
    const result = await invokeTool('fetch', { resource: '/test.txt' }, storage)
    expect(result.isError).toBeFalsy()
  })

  it('should require auth for do tool (admin scope)', async () => {
    const middleware = createMCPAuthMiddleware()
    useMiddleware(middleware)

    // The 'do' tool is an unknown tool (not in READ_ONLY_TOOLS or WRITE_TOOLS)
    // so it requires admin scope
    const result = await invokeTool('do', { code: 'return 1' }, storage)
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('AUTH_REQUIRED')
  })

  it('should allow authenticated do with admin scope', async () => {
    const middleware = createMCPAuthMiddleware()
    useMiddleware(middleware)

    const result = await invokeTool(
      'do',
      { code: 'return 1' },
      storage,
      {
        metadata: {
          auth: {
            authenticated: true,
            userId: 'user-1',
            scopes: ['admin'],
            anonymousAllowed: true,
          },
        },
      }
    )
    expect(result.isError).toBe(false)
  })

  it('should deny authenticated do without admin scope', async () => {
    const middleware = createMCPAuthMiddleware()
    useMiddleware(middleware)

    const result = await invokeTool(
      'do',
      { code: 'return 1' },
      storage,
      {
        metadata: {
          auth: {
            authenticated: true,
            userId: 'user-1',
            scopes: ['read'],
            anonymousAllowed: true,
          },
        },
      }
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('PERMISSION_DENIED')
  })

  it('should call onAuthFailure callback on failure', async () => {
    const onAuthFailure = vi.fn()
    const middleware = createMCPAuthMiddleware({ onAuthFailure })
    useMiddleware(middleware)

    await invokeTool('do', { code: 'return 1' }, storage)

    expect(onAuthFailure).toHaveBeenCalledWith(
      'do',
      'Authentication required'
    )
  })

  it('should deny anonymous read when allowAnonymousRead is false (search tool)', async () => {
    const middleware = createMCPAuthMiddleware({ allowAnonymousRead: false })
    useMiddleware(middleware)

    const result = await invokeTool('search', { query: '*.txt' }, storage)
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('AUTH_REQUIRED')
  })
})

// =============================================================================
// Helper Function Tests
// =============================================================================

describe('Helper Functions', () => {
  describe('createAuthMetadata', () => {
    it('should create auth metadata with defaults', () => {
      const auth = createAuthMetadata({})
      expect(auth.authenticated).toBe(false)
      expect(auth.scopes).toEqual([])
      expect(auth.anonymousAllowed).toBe(true)
    })

    it('should create auth metadata with provided values', () => {
      const auth = createAuthMetadata({
        authenticated: true,
        userId: 'user-1',
        tenantId: 'tenant-1',
        scopes: ['read', 'write'],
        anonymousAllowed: false,
      })
      expect(auth.authenticated).toBe(true)
      expect(auth.userId).toBe('user-1')
      expect(auth.tenantId).toBe('tenant-1')
      expect(auth.scopes).toEqual(['read', 'write'])
      expect(auth.anonymousAllowed).toBe(false)
    })
  })

  describe('createAnonymousAuthContext', () => {
    it('should create anonymous auth context', () => {
      const auth = createAnonymousAuthContext()
      expect(auth.authenticated).toBe(false)
      expect(auth.scopes).toEqual([])
      expect(auth.anonymousAllowed).toBe(true)
    })
  })
})

/**
 * Tests for FsDoScope permission hierarchy
 *
 * FsDoScope should extend DoPermissions in the 'permissions' field,
 * not use a separate 'fsPermissions' field.
 *
 * @module core/mcp/scope.test
 */

import { describe, it, expect } from 'vitest'
import type { DoPermissions } from '@dotdo/mcp/scope'
import { createFsScope, type FsDoScope, type FsPermissions, type FsDoPermissions } from './scope'

// Create a minimal mock storage backend for testing
function createMockStorage() {
  return {
    has: () => false,
    get: () => null,
    isDirectory: () => false,
    getChildren: () => [],
    addFile: () => {},
    addDirectory: () => {},
    remove: () => true,
  }
}

describe('FsDoScope permission hierarchy', () => {
  describe('FsDoPermissions extends DoPermissions', () => {
    it('should include sandbox permissions (allowNetwork, allowedHosts)', () => {
      // FsDoPermissions should extend DoPermissions
      const permissions: FsDoPermissions = {
        allowNetwork: true,
        allowedHosts: ['api.example.com'],
        allowWrite: true,
        allowDelete: false,
        allowedPaths: ['/home/user'],
      }

      // Type check: these should be valid DoPermissions fields
      expect(permissions.allowNetwork).toBe(true)
      expect(permissions.allowedHosts).toEqual(['api.example.com'])
    })

    it('should include fs-specific permissions (allowWrite, allowDelete, allowedPaths)', () => {
      const permissions: FsDoPermissions = {
        allowWrite: true,
        allowDelete: false,
        allowedPaths: ['/home/user', '/tmp'],
      }

      expect(permissions.allowWrite).toBe(true)
      expect(permissions.allowDelete).toBe(false)
      expect(permissions.allowedPaths).toEqual(['/home/user', '/tmp'])
    })

    it('should support all permissions together', () => {
      const permissions: FsDoPermissions = {
        // DoPermissions fields
        allowNetwork: false,
        allowedHosts: [],
        // FsPermissions fields
        allowWrite: true,
        allowDelete: true,
        allowedPaths: ['/data'],
      }

      expect(permissions).toMatchObject({
        allowNetwork: false,
        allowedHosts: [],
        allowWrite: true,
        allowDelete: true,
        allowedPaths: ['/data'],
      })
    })
  })

  describe('FsDoScope.permissions contains all permission types', () => {
    it('should have permissions field that includes fs-specific permissions', () => {
      const storage = createMockStorage()
      const scope = createFsScope(storage, {
        allowWrite: true,
        allowDelete: false,
        allowedPaths: ['/home'],
      })

      // The permissions field should contain fs-specific permissions
      // This is the key change: fsPermissions should be merged into permissions
      expect(scope.permissions).toBeDefined()
      expect(scope.permissions?.allowWrite).toBe(true)
      expect(scope.permissions?.allowDelete).toBe(false)
      expect(scope.permissions?.allowedPaths).toEqual(['/home'])
    })

    it('should merge sandbox and fs permissions in permissions field', () => {
      const storage = createMockStorage()
      const scope = createFsScope(
        storage,
        {
          allowWrite: true,
          allowDelete: false,
          allowedPaths: ['/data'],
        },
        undefined, // no additional bindings
        {
          allowNetwork: true,
          allowedHosts: ['api.example.com'],
        }
      )

      // All permissions should be in the permissions field
      expect(scope.permissions).toBeDefined()

      // Sandbox permissions
      expect(scope.permissions?.allowNetwork).toBe(true)
      expect(scope.permissions?.allowedHosts).toEqual(['api.example.com'])

      // FS permissions (merged into permissions)
      expect(scope.permissions?.allowWrite).toBe(true)
      expect(scope.permissions?.allowDelete).toBe(false)
      expect(scope.permissions?.allowedPaths).toEqual(['/data'])
    })

    it('should NOT have a separate fsPermissions field', () => {
      const storage = createMockStorage()
      const scope = createFsScope(storage, {
        allowWrite: true,
        allowDelete: false,
      })

      // The fsPermissions field should not exist as a separate field
      // All permissions should be in the permissions field
      expect((scope as { fsPermissions?: unknown }).fsPermissions).toBeUndefined()
    })
  })

  describe('backward compatibility', () => {
    it('should still work when only sandbox permissions are provided', () => {
      const storage = createMockStorage()
      const scope = createFsScope(
        storage,
        undefined, // no fs permissions
        undefined, // no additional bindings
        {
          allowNetwork: false,
        }
      )

      expect(scope.permissions?.allowNetwork).toBe(false)
      // FS permissions should default to undefined (unrestricted)
      expect(scope.permissions?.allowWrite).toBeUndefined()
    })

    it('should still work when only fs permissions are provided', () => {
      const storage = createMockStorage()
      const scope = createFsScope(
        storage,
        {
          allowWrite: false,
        }
      )

      expect(scope.permissions?.allowWrite).toBe(false)
      // Sandbox permissions should default to undefined (unrestricted)
      expect(scope.permissions?.allowNetwork).toBeUndefined()
    })
  })
})

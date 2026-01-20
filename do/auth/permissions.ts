/**
 * @fileoverview Permission checking for fsx authorization
 *
 * Provides path-based permission checking with support for:
 * - Glob pattern matching (** for recursive, * for single level)
 * - Read/write/delete/admin permission types
 * - Tenant-scoped path validation
 *
 * @category Application
 * @module do/auth/permissions
 */

import {
  AuthError,
  type Permission,
  type PermissionType,
  type PermissionCheckResult,
  type PathCheckOptions,
  type AuthContext,
  ROLE_PERMISSIONS,
} from './types.js'

// ============================================================================
// PATH MATCHING
// ============================================================================

/**
 * Match a path against a glob pattern
 *
 * Supports:
 * - ** for recursive matching (any depth)
 * - * for single-level matching (within one directory)
 * - Literal path segments
 *
 * @param path - The path to check
 * @param pattern - The glob pattern
 * @returns True if the path matches the pattern
 */
export function matchPath(path: string, pattern: string): boolean {
  // Normalize paths
  const normalizedPath = normalizePath(path)
  const normalizedPattern = normalizePath(pattern)

  // Exact match
  if (normalizedPath === normalizedPattern) {
    return true
  }

  // Convert glob pattern to regex
  const regexPattern = patternToRegex(normalizedPattern)
  return regexPattern.test(normalizedPath)
}

/**
 * Normalize a path for comparison
 */
function normalizePath(path: string): string {
  // Ensure leading slash
  let normalized = path.startsWith('/') ? path : '/' + path

  // Remove trailing slash (except for root)
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }

  // Collapse multiple slashes
  normalized = normalized.replace(/\/+/g, '/')

  return normalized
}

/**
 * Convert a glob pattern to a regex
 */
function patternToRegex(pattern: string): RegExp {
  // Escape special regex characters except * and **
  let regex = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')

  // Replace ** with a placeholder to avoid double processing
  regex = regex.replace(/\*\*/g, '__DOUBLE_STAR__')

  // Replace single * with pattern that matches within a single path segment
  regex = regex.replace(/\*/g, '[^/]*')

  // Replace ** placeholder with pattern that matches any depth
  regex = regex.replace(/__DOUBLE_STAR__/g, '.*')

  // Anchor the pattern
  return new RegExp(`^${regex}$`)
}

// ============================================================================
// PERMISSION CHECKING
// ============================================================================

/**
 * Check if a permission allows access to a path
 */
function permissionMatchesPath(permission: Permission, path: string): boolean {
  return matchPath(path, permission.scope.path)
}

/**
 * Get effective permissions for a context
 *
 * Combines role-based permissions with explicit permissions.
 */
export function getEffectivePermissions(context: AuthContext): Permission[] {
  const permissions: Permission[] = [...context.permissions]

  // Add role-based permissions
  if (context.role && ROLE_PERMISSIONS[context.role]) {
    permissions.push(...ROLE_PERMISSIONS[context.role])
  }

  return permissions
}

/**
 * Check if a user has permission for a specific operation
 *
 * @param context - The authentication context
 * @param options - Path check options
 * @returns Permission check result
 *
 * @example
 * ```typescript
 * const result = checkPermission(authContext, {
 *   path: '/data/users/file.json',
 *   type: 'write',
 *   tenantId: 'tenant-123'
 * })
 *
 * if (!result.allowed) {
 *   throw new AuthError('PERMISSION_DENIED', result.reason)
 * }
 * ```
 */
export function checkPermission(context: AuthContext, options: PathCheckOptions): PermissionCheckResult {
  const { path, type, tenantId } = options

  // Check tenant isolation if tenant context provided
  if (tenantId && context.tenantId && tenantId !== context.tenantId) {
    return {
      allowed: false,
      reason: `Access denied: tenant mismatch (expected ${context.tenantId}, got ${tenantId})`,
    }
  }

  // Get all effective permissions
  const permissions = getEffectivePermissions(context)

  // Find a matching permission
  for (const permission of permissions) {
    if (permissionMatchesType(permission.type, type) && permissionMatchesPath(permission, path)) {
      return {
        allowed: true,
        matchedPermission: permission,
      }
    }
  }

  return {
    allowed: false,
    reason: `Permission denied: no ${type} access to path ${path}`,
  }
}

/**
 * Check if a permission type grants access for the requested type
 *
 * Permission hierarchy:
 * - admin grants all
 * - write grants write and read (implicitly)
 * - read grants only read
 * - delete grants only delete
 */
function permissionMatchesType(grantedType: PermissionType, requestedType: PermissionType): boolean {
  // Admin grants everything
  if (grantedType === 'admin') {
    return true
  }

  // Exact match
  if (grantedType === requestedType) {
    return true
  }

  // Write implicitly grants read
  if (grantedType === 'write' && requestedType === 'read') {
    return true
  }

  return false
}

/**
 * Require a specific permission, throwing if not granted
 *
 * @param context - The authentication context
 * @param options - Path check options
 * @throws AuthError if permission is denied
 *
 * @example
 * ```typescript
 * // Will throw if permission denied
 * requirePermission(authContext, { path: '/data/file.txt', type: 'write' })
 * ```
 */
export function requirePermission(context: AuthContext, options: PathCheckOptions): void {
  const result = checkPermission(context, options)
  if (!result.allowed) {
    throw new AuthError('PERMISSION_DENIED', result.reason ?? 'Permission denied', 403)
  }
}

// ============================================================================
// TENANT PATH ISOLATION
// ============================================================================

/**
 * Resolve a path within a tenant's namespace
 *
 * Ensures all paths are scoped to the tenant's root directory.
 *
 * @param path - The requested path
 * @param tenantRootPath - The tenant's root path (e.g., /tenants/abc123)
 * @returns The resolved absolute path within the tenant namespace
 */
export function resolveTenantPath(path: string, tenantRootPath: string): string {
  const normalizedPath = normalizePath(path)
  const normalizedRoot = normalizePath(tenantRootPath)

  // If path is already under tenant root, return as-is
  if (normalizedPath.startsWith(normalizedRoot)) {
    return normalizedPath
  }

  // Otherwise, join the path to the tenant root
  if (normalizedPath === '/') {
    return normalizedRoot
  }

  return `${normalizedRoot}${normalizedPath}`
}

/**
 * Validate that a path is within a tenant's namespace
 *
 * @param path - The path to validate
 * @param tenantRootPath - The tenant's root path
 * @returns True if the path is within the tenant namespace
 */
export function isPathInTenantNamespace(path: string, tenantRootPath: string): boolean {
  const normalizedPath = normalizePath(path)
  const normalizedRoot = normalizePath(tenantRootPath)

  return normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot + '/')
}

/**
 * Convert an absolute path to a tenant-relative path
 *
 * @param absolutePath - The absolute path
 * @param tenantRootPath - The tenant's root path
 * @returns The path relative to the tenant root, or null if not in namespace
 */
export function toTenantRelativePath(absolutePath: string, tenantRootPath: string): string | null {
  const normalizedPath = normalizePath(absolutePath)
  const normalizedRoot = normalizePath(tenantRootPath)

  if (normalizedPath === normalizedRoot) {
    return '/'
  }

  if (!normalizedPath.startsWith(normalizedRoot + '/')) {
    return null
  }

  return normalizedPath.slice(normalizedRoot.length) || '/'
}

// ============================================================================
// PERMISSION BUILDERS
// ============================================================================

/**
 * Create a read permission for a path
 */
export function readPermission(path: string, recursive = true): Permission {
  return {
    type: 'read',
    scope: { path, recursive },
  }
}

/**
 * Create a write permission for a path
 */
export function writePermission(path: string, recursive = true): Permission {
  return {
    type: 'write',
    scope: { path, recursive },
  }
}

/**
 * Create a delete permission for a path
 */
export function deletePermission(path: string, recursive = true): Permission {
  return {
    type: 'delete',
    scope: { path, recursive },
  }
}

/**
 * Create an admin permission for a path
 */
export function adminPermission(path: string, recursive = true): Permission {
  return {
    type: 'admin',
    scope: { path, recursive },
  }
}

/**
 * Create full access permissions for a path
 */
export function fullAccessPermissions(path: string): Permission[] {
  return [readPermission(path), writePermission(path), deletePermission(path), adminPermission(path)]
}

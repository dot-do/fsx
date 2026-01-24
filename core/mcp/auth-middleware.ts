/**
 * MCP Tool Authentication Middleware
 *
 * Provides authentication middleware for MCP tools that:
 * - Protects write operations (write, delete, move, etc.) with auth-required
 * - Allows read operations (read, list, stat, etc.) with anon+auth mode
 * - Passes auth context to MCP tools via ToolContext.metadata
 *
 * This middleware integrates with the tool registry's useMiddleware() function.
 *
 * @module core/mcp/auth-middleware
 */

import type { ToolContext, ToolMiddleware } from './tool-registry'
import type { McpToolResult } from './shared'

// =============================================================================
// Types
// =============================================================================

/**
 * OAuth scope types for file operations
 */
export type FileScope = 'read' | 'write' | 'admin' | 'files:read' | 'files:write' | 'files:delete'

/**
 * Authentication context for MCP tools
 */
export interface MCPToolAuthContext {
  /** Whether the user is authenticated */
  authenticated: boolean
  /** User ID from token */
  userId?: string
  /** Tenant ID for multi-tenancy */
  tenantId?: string
  /** Permission scopes */
  scopes: FileScope[]
  /** Anonymous access allowed for this operation */
  anonymousAllowed: boolean
}

/**
 * Configuration for the auth middleware
 */
export interface AuthMiddlewareConfig {
  /**
   * Allow anonymous access to read operations
   * @default true
   */
  allowAnonymousRead?: boolean

  /**
   * Function to get the auth context from the tool context
   * If not provided, looks for 'auth' in context.metadata
   */
  getAuthContext?: (context: ToolContext) => MCPToolAuthContext | undefined

  /**
   * Callback when authentication fails
   */
  onAuthFailure?: (toolName: string, reason: string) => void
}

// =============================================================================
// Tool Classification
// =============================================================================

/**
 * MCP tools that only require read access
 * These can be accessed anonymously or with authentication
 *
 * Includes both:
 * - Core 3 tools: search, fetch (do requires admin)
 * - Legacy fs_* tool names (for backward compatibility in auth checks)
 */
export const READ_ONLY_TOOLS = new Set([
  // Core read-only tools
  'search',
  'fetch',
  // Legacy fs_* tools (for backward compatibility in auth classification)
  'fs_read',
  'fs_list',
  'fs_stat',
  'fs_lstat',
  'fs_tree',
  'fs_search',
  'fs_exists',
])

/**
 * MCP tools that require write access
 * These require authentication with write scope
 */
export const WRITE_TOOLS = new Set([
  'fs_write',
  'fs_append',
  'fs_delete',
  'fs_move',
  'fs_copy',
  'fs_mkdir',
])

/**
 * Check if a tool is a read-only tool
 */
export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName.toLowerCase())
}

/**
 * Check if a tool is a write tool
 */
export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName.toLowerCase())
}

/**
 * Get required scope for a tool
 */
export function getRequiredScope(toolName: string): FileScope | null {
  const name = toolName.toLowerCase()

  if (READ_ONLY_TOOLS.has(name)) {
    return 'read'
  }

  if (WRITE_TOOLS.has(name)) {
    return 'write'
  }

  // Unknown tool - require admin
  return 'admin'
}

// =============================================================================
// Scope Checking
// =============================================================================

/**
 * Check if scopes include the required scope
 */
function hasRequiredScope(scopes: FileScope[], required: FileScope): boolean {
  // Admin has all permissions
  if (scopes.includes('admin')) {
    return true
  }

  // Write implies read
  if (required === 'read' && scopes.includes('write')) {
    return true
  }

  // files:write implies files:read
  if (required === 'read' && scopes.includes('files:write')) {
    return true
  }

  // files:read is equivalent to read
  if (required === 'read' && scopes.includes('files:read')) {
    return true
  }

  // files:write is equivalent to write
  if (required === 'write' && scopes.includes('files:write')) {
    return true
  }

  return scopes.includes(required)
}

// =============================================================================
// Auth Check Result
// =============================================================================

/**
 * Result of checking if a tool invocation is authorized
 */
export interface ToolAuthCheckResult {
  /** Whether the tool invocation is allowed */
  allowed: boolean
  /** Error code if not allowed */
  code?: 'AUTH_REQUIRED' | 'PERMISSION_DENIED'
  /** Human-readable message */
  message?: string
}

/**
 * Check if a tool invocation is authorized
 *
 * @param toolName - Name of the MCP tool being invoked
 * @param auth - MCP auth context (can be undefined for anonymous)
 * @param allowAnonymousRead - Whether anonymous read is allowed
 * @returns Authorization check result
 */
export function checkToolAuth(
  toolName: string,
  auth: MCPToolAuthContext | undefined,
  allowAnonymousRead: boolean
): ToolAuthCheckResult {
  // Read-only tools
  if (isReadOnlyTool(toolName)) {
    // Anonymous allowed for read tools if configured
    if (allowAnonymousRead && (!auth || !auth.authenticated)) {
      return { allowed: true }
    }

    // Authenticated - check read scope
    if (auth?.authenticated) {
      if (hasRequiredScope(auth.scopes, 'read')) {
        return { allowed: true }
      }
      return {
        allowed: false,
        code: 'PERMISSION_DENIED',
        message: 'Missing required scope: read',
      }
    }

    // Not authenticated and anonymous not allowed
    return {
      allowed: false,
      code: 'AUTH_REQUIRED',
      message: 'Authentication required for read operations',
    }
  }

  // Write tools - require authentication
  if (isWriteTool(toolName)) {
    if (!auth?.authenticated) {
      return {
        allowed: false,
        code: 'AUTH_REQUIRED',
        message: 'Authentication required for write operations',
      }
    }

    // Check write scope
    if (!hasRequiredScope(auth.scopes, 'write')) {
      return {
        allowed: false,
        code: 'PERMISSION_DENIED',
        message: 'Missing required scope: write',
      }
    }

    return { allowed: true }
  }

  // Unknown tool - require admin
  if (!auth?.authenticated) {
    return {
      allowed: false,
      code: 'AUTH_REQUIRED',
      message: 'Authentication required',
    }
  }

  if (!hasRequiredScope(auth.scopes, 'admin')) {
    return {
      allowed: false,
      code: 'PERMISSION_DENIED',
      message: 'Admin scope required for this operation',
    }
  }

  return { allowed: true }
}

// =============================================================================
// Middleware Factory
// =============================================================================

/**
 * Create error result for auth failures
 */
function authErrorResult(code: string, message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    isError: true,
  }
}

/**
 * Create MCP tool authentication middleware
 *
 * This middleware integrates with the tool registry's useMiddleware() function
 * to enforce authentication on tool invocations.
 *
 * @param config - Middleware configuration
 * @returns Tool middleware function
 *
 * @example
 * ```typescript
 * import { useMiddleware } from './tool-registry'
 * import { createMCPAuthMiddleware } from './auth-middleware'
 *
 * // Register auth middleware
 * useMiddleware(createMCPAuthMiddleware({
 *   allowAnonymousRead: true,
 *   onAuthFailure: (tool, reason) => {
 *     console.log(`Auth failed for ${tool}: ${reason}`)
 *   },
 * }))
 *
 * // Later, invoke a tool with auth context in metadata
 * const result = await invokeTool('fs_write', params, storage, {
 *   metadata: {
 *     auth: {
 *       authenticated: true,
 *       userId: 'user-123',
 *       scopes: ['write'],
 *       anonymousAllowed: true,
 *     }
 *   }
 * })
 * ```
 */
export function createMCPAuthMiddleware(config: AuthMiddlewareConfig = {}): ToolMiddleware {
  const {
    allowAnonymousRead = true,
    getAuthContext = (ctx) => ctx.metadata?.auth as MCPToolAuthContext | undefined,
    onAuthFailure,
  } = config

  return async (
    context: ToolContext,
    _params: Record<string, unknown>,
    next: () => Promise<McpToolResult>
  ): Promise<McpToolResult> => {
    // Get auth context from tool context metadata
    const auth = getAuthContext(context)

    // Check authorization
    const result = checkToolAuth(context.toolName, auth, allowAnonymousRead)

    if (!result.allowed) {
      // Report auth failure
      onAuthFailure?.(context.toolName, result.message || 'Unknown error')

      // Return error result
      return authErrorResult(result.code || 'AUTH_REQUIRED', result.message || 'Authentication required')
    }

    // Continue to next middleware or handler
    return next()
  }
}

/**
 * Default instance of the auth middleware with default configuration
 *
 * Allows anonymous read, requires auth for write operations.
 */
export const defaultAuthMiddleware = createMCPAuthMiddleware()

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create auth metadata for tool invocation
 *
 * Helper function to create the auth metadata object that should be
 * passed to invokeTool via options.metadata.auth
 *
 * @param auth - Auth context or partial auth info
 * @returns Auth metadata object
 *
 * @example
 * ```typescript
 * // From Hono context
 * const authMeta = createAuthMetadata({
 *   authenticated: true,
 *   userId: 'user-123',
 *   scopes: ['read', 'write'],
 * })
 *
 * const result = await invokeTool('fs_write', params, storage, {
 *   metadata: { auth: authMeta }
 * })
 * ```
 */
export function createAuthMetadata(
  auth: Partial<MCPToolAuthContext> & { authenticated?: boolean }
): MCPToolAuthContext {
  return {
    authenticated: auth.authenticated ?? false,
    userId: auth.userId,
    tenantId: auth.tenantId,
    scopes: auth.scopes ?? [],
    anonymousAllowed: auth.anonymousAllowed ?? true,
  }
}

/**
 * Create anonymous auth context
 *
 * Helper for creating an anonymous (unauthenticated) auth context
 */
export function createAnonymousAuthContext(): MCPToolAuthContext {
  return {
    authenticated: false,
    scopes: [],
    anonymousAllowed: true,
  }
}

/**
 * @fileoverview MCP Tool Authentication Middleware
 *
 * Provides authentication middleware specifically for MCP filesystem tools:
 * - Read operations: Allow anonymous + authenticated (anon+auth mode)
 * - Write operations: Require authentication (auth-required mode)
 * - Auth context passed to MCP tools
 *
 * @category Application
 * @module do/auth/mcp-middleware
 */

import type { Context, MiddlewareHandler, Next } from 'hono'
import {
  extractToken,
  verifyJWT,
  OAuthSessionCache,
  type OAuthJWTPayload,
  type OAuthScope,
  type VerifyJWTOptions,
  type JWTVerifyResult,
  type CachedVerifyResult,
} from './oauth.js'
import { AuthError } from './types.js'

// ============================================================================
// MCP TOOL CLASSIFICATION
// ============================================================================

/**
 * MCP tools that only require read access
 * These can be accessed anonymously or with authentication
 */
export const READ_ONLY_TOOLS = new Set([
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
export function getRequiredScope(toolName: string): OAuthScope | null {
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

// ============================================================================
// MCP AUTH CONTEXT
// ============================================================================

/**
 * MCP authentication context
 */
export interface MCPAuthContext {
  /** Whether the user is authenticated */
  authenticated: boolean
  /** User ID from token */
  userId?: string
  /** Tenant ID for multi-tenancy */
  tenantId?: string
  /** Session ID */
  sessionId?: string
  /** Permission scopes */
  scopes: OAuthScope[]
  /** Full OAuth payload (if authenticated) */
  payload?: OAuthJWTPayload
  /** Anonymous access allowed for this operation */
  anonymousAllowed: boolean
}

const MCP_AUTH_CONTEXT_KEY = 'mcpAuth'

/**
 * Get MCP auth context from Hono context
 */
export function getMCPAuthContext(c: Context): MCPAuthContext | undefined {
  return c.get(MCP_AUTH_CONTEXT_KEY) as MCPAuthContext | undefined
}

/**
 * Require MCP auth context
 */
export function requireMCPAuthContext(c: Context): MCPAuthContext {
  const ctx = getMCPAuthContext(c)
  if (!ctx) {
    throw new AuthError('AUTH_REQUIRED', 'Authentication context not initialized')
  }
  return ctx
}

// ============================================================================
// MCP AUTH MIDDLEWARE
// ============================================================================

/**
 * MCP auth middleware configuration
 */
export interface MCPAuthMiddlewareOptions {
  /** JWKS URL for token verification */
  jwksUrl: string
  /** Session cache for reducing verification overhead */
  sessionCache?: OAuthSessionCache
  /** Cookie name for token extraction (optional) */
  cookieName?: string
  /** Allow anonymous access to read operations (default: true) */
  allowAnonymousRead?: boolean
  /** Expected issuer (optional) */
  issuer?: string
  /** Expected audience (optional) */
  audience?: string | string[]
}

/**
 * Create MCP auth middleware for Hono
 *
 * This middleware:
 * - Extracts and validates OAuth tokens from requests
 * - Sets up MCP auth context for tool handlers
 * - Allows anonymous access to read operations (configurable)
 * - Requires authentication for write operations
 *
 * @param options - Middleware configuration
 * @returns Hono middleware handler
 *
 * @example
 * ```typescript
 * const app = new Hono()
 *
 * // Apply MCP auth middleware
 * app.use('/mcp/*', createMCPAuthMiddleware({
 *   jwksUrl: 'https://oauth.do/.well-known/jwks.json',
 *   allowAnonymousRead: true,
 * }))
 *
 * // In your MCP handler
 * app.post('/mcp/tools/:tool', (c) => {
 *   const auth = getMCPAuthContext(c)
 *   const toolName = c.req.param('tool')
 *
 *   // Check if write tool requires auth
 *   if (isWriteTool(toolName) && !auth.authenticated) {
 *     return c.json({ error: 'Authentication required' }, 401)
 *   }
 *
 *   // Pass auth context to tool
 *   return invokeTool(toolName, params, storage, { auth })
 * })
 * ```
 */
export function createMCPAuthMiddleware(options: MCPAuthMiddlewareOptions): MiddlewareHandler {
  const {
    jwksUrl,
    sessionCache,
    cookieName,
    allowAnonymousRead = true,
    issuer,
    audience,
  } = options

  return async (c: Context, next: Next) => {
    // Extract token from request
    const token = extractToken(c.req.raw.headers, cookieName)

    // If no token, set up anonymous context
    if (!token) {
      const anonContext: MCPAuthContext = {
        authenticated: false,
        scopes: [],
        anonymousAllowed: allowAnonymousRead,
      }
      c.set(MCP_AUTH_CONTEXT_KEY, anonContext)
      return next()
    }

    // Verify token
    const verifyOptions: VerifyJWTOptions = { jwksUrl, issuer, audience }
    let result: JWTVerifyResult | CachedVerifyResult

    if (sessionCache) {
      result = await sessionCache.getOrVerify(token, verifyOptions)
    } else {
      result = await verifyJWT(token, verifyOptions)
    }

    // If token is invalid, still allow anonymous read if configured
    if (!result.valid) {
      if (allowAnonymousRead) {
        const anonContext: MCPAuthContext = {
          authenticated: false,
          scopes: [],
          anonymousAllowed: true,
        }
        c.set(MCP_AUTH_CONTEXT_KEY, anonContext)
        return next()
      }

      return c.json(
        { code: result.code ?? 'INVALID_TOKEN', message: result.error ?? 'Invalid token' },
        401
      )
    }

    // Set up authenticated context
    const payload = result.payload!
    const authContext: MCPAuthContext = {
      authenticated: true,
      userId: payload.sub,
      tenantId: payload.tenant_id,
      sessionId: payload.session_id,
      scopes: payload.scopes,
      payload,
      anonymousAllowed: allowAnonymousRead,
    }
    c.set(MCP_AUTH_CONTEXT_KEY, authContext)

    return next()
  }
}

// ============================================================================
// TOOL-LEVEL AUTH CHECK
// ============================================================================

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
 * @param auth - MCP auth context
 * @returns Authorization check result
 *
 * @example
 * ```typescript
 * const auth = getMCPAuthContext(c)
 * const result = checkToolAuth('fs_write', auth)
 *
 * if (!result.allowed) {
 *   return c.json({ error: result.message }, result.code === 'AUTH_REQUIRED' ? 401 : 403)
 * }
 * ```
 */
export function checkToolAuth(toolName: string, auth: MCPAuthContext): ToolAuthCheckResult {
  // Note: requiredScope is used implicitly via isReadOnlyTool/isWriteTool

  // Read-only tools - check if anonymous is allowed
  if (isReadOnlyTool(toolName)) {
    // Anonymous allowed for read tools
    if (auth.anonymousAllowed && !auth.authenticated) {
      return { allowed: true }
    }

    // Authenticated - check read scope
    if (auth.authenticated) {
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
    if (!auth.authenticated) {
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
  if (!auth.authenticated) {
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

/**
 * Check if scopes include the required scope
 */
function hasRequiredScope(scopes: OAuthScope[], required: OAuthScope): boolean {
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

// ============================================================================
// MCP TOOL MIDDLEWARE
// ============================================================================

/**
 * Create middleware that enforces auth for specific tools
 *
 * @param toolNameExtractor - Function to extract tool name from request
 * @returns Hono middleware handler
 *
 * @example
 * ```typescript
 * app.post('/mcp/tools/:tool', enforceMCPToolAuth((c) => c.req.param('tool')))
 * ```
 */
export function enforceMCPToolAuth(
  toolNameExtractor: (c: Context) => string
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const auth = getMCPAuthContext(c)
    if (!auth) {
      return c.json({ code: 'AUTH_REQUIRED', message: 'Authentication context missing' }, 401)
    }

    const toolName = toolNameExtractor(c)
    const result = checkToolAuth(toolName, auth)

    if (!result.allowed) {
      const status = result.code === 'AUTH_REQUIRED' ? 401 : 403
      return c.json({ code: result.code, message: result.message }, status)
    }

    return next()
  }
}

// ============================================================================
// AUTH CONTEXT FOR TOOL HANDLERS
// ============================================================================

/**
 * Tool handler auth context
 * Passed to tool handlers via ToolContext.metadata
 */
export interface ToolHandlerAuthContext {
  /** Whether the user is authenticated */
  authenticated: boolean
  /** User ID from token */
  userId?: string
  /** Tenant ID for multi-tenancy */
  tenantId?: string
  /** Permission scopes */
  scopes: OAuthScope[]
}

/**
 * Convert MCP auth context to tool handler auth context
 */
export function toToolHandlerAuthContext(auth: MCPAuthContext): ToolHandlerAuthContext {
  return {
    authenticated: auth.authenticated,
    userId: auth.userId,
    tenantId: auth.tenantId,
    scopes: auth.scopes,
  }
}

/**
 * Get auth context from tool context metadata
 */
export function getToolAuthFromContext(
  context?: { metadata?: Record<string, unknown> }
): ToolHandlerAuthContext | undefined {
  return context?.metadata?.auth as ToolHandlerAuthContext | undefined
}

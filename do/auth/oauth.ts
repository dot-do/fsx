/**
 * @fileoverview OAuth.do Integration for fsx.do
 *
 * Provides oauth.do integration for fsx authentication:
 * - Session caching to reduce verification overhead
 * - Scope-based permission checking
 * - Hono middleware integration
 * - Bridge functions to convert between oauth.do and fsx auth formats
 *
 * @category Application
 * @module do/auth/oauth
 */

import type { Context, MiddlewareHandler, Next } from 'hono'
import {
  extractToken as oauthExtractToken,
  extractBearerToken as oauthExtractBearerToken,
  verifyJWT as oauthVerifyJWT,
  type OAuthJWTPayload,
  type OAuthScope,
  type JWTVerifyResult,
} from 'oauth.do/server'
import { AuthError, type AuthContext, type Permission, type AuthErrorCode } from './types.js'

// Re-export from oauth.do/server for convenience
export { extractToken, extractBearerToken } from 'oauth.do/server'
export type { OAuthJWTPayload, OAuthScope, JWTVerifyResult } from 'oauth.do/server'

// ============================================================================
// OAUTH ERROR CLASS
// ============================================================================

/**
 * OAuth-specific error class
 *
 * Compatible with AuthError but specific to OAuth flows
 */
export class OAuthError extends Error {
  readonly code: AuthErrorCode
  readonly statusCode: number

  constructor(code: AuthErrorCode, message: string, statusCode?: number) {
    super(message)
    this.name = 'OAuthError'
    this.code = code
    this.statusCode = statusCode ?? (code === 'PERMISSION_DENIED' ? 403 : 401)
  }
}

/**
 * Map oauth.do error codes to fsx auth error codes
 */
export function mapOAuthError(
  oauthCode: 'INVALID_TOKEN' | 'TOKEN_EXPIRED' | 'INVALID_SIGNATURE' | 'JWKS_ERROR'
): AuthErrorCode {
  switch (oauthCode) {
    case 'INVALID_TOKEN':
      return 'INVALID_TOKEN'
    case 'TOKEN_EXPIRED':
      return 'TOKEN_EXPIRED'
    case 'INVALID_SIGNATURE':
      return 'INVALID_SIGNATURE'
    case 'JWKS_ERROR':
      return 'INVALID_TOKEN' // Map JWKS errors to INVALID_TOKEN
    default:
      return 'INVALID_TOKEN'
  }
}

// ============================================================================
// SESSION CACHING
// ============================================================================

/**
 * Session cache entry
 */
interface SessionCacheEntry {
  /** Cached payload */
  payload: OAuthJWTPayload
  /** Cache expiration timestamp */
  expiresAt: number
  /** Original token hash (for invalidation) */
  tokenHash: string
}

/**
 * Session cache verification result
 */
export interface CachedVerifyResult extends JWTVerifyResult {
  /** Whether the result came from cache */
  fromCache: boolean
}

/**
 * OAuth session cache configuration
 */
export interface OAuthSessionCacheOptions {
  /** Cache TTL in seconds (default: 300 = 5 minutes) */
  ttlSeconds?: number
  /** Maximum cache entries (default: 1000) */
  maxEntries?: number
}

/**
 * Compute a hash of the token for cache key
 */
async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(token)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * OAuth session cache for reducing verification overhead
 *
 * Caches verified JWT payloads by session_id to avoid hitting oauth.do
 * on every request. Respects TTL and token changes.
 *
 * @example
 * ```typescript
 * const cache = new OAuthSessionCache({ ttlSeconds: 300 })
 *
 * const result = await cache.getOrVerify(token, { jwksUrl: 'https://oauth.do/.well-known/jwks.json' })
 * if (result.valid) {
 *   console.log('User:', result.payload.sub)
 *   console.log('From cache:', result.fromCache)
 * }
 * ```
 */
export class OAuthSessionCache {
  private cache: Map<string, SessionCacheEntry> = new Map()
  private readonly ttlMs: number
  private readonly maxEntries: number

  constructor(options: OAuthSessionCacheOptions = {}) {
    this.ttlMs = (options.ttlSeconds ?? 300) * 1000
    this.maxEntries = options.maxEntries ?? 1000
  }

  /**
   * Get current cache size
   */
  get size(): number {
    return this.cache.size
  }

  /**
   * Get cached payload or verify the token
   *
   * @param token - JWT token to verify
   * @param options - Verification options
   * @returns Verification result with cache indicator
   */
  async getOrVerify(
    token: string,
    options: { jwksUrl: string }
  ): Promise<CachedVerifyResult> {
    const tokenHash = await hashToken(token)

    // Try to decode the token to get session_id without full verification
    let sessionId: string | undefined
    try {
      const parts = token.split('.')
      if (parts.length === 3) {
        const payloadB64 = parts[1]!
        let base64 = payloadB64.replace(/-/g, '+').replace(/_/g, '/')
        const paddingNeeded = (4 - (base64.length % 4)) % 4
        base64 += '='.repeat(paddingNeeded)
        const payload = JSON.parse(atob(base64))
        sessionId = payload.session_id
      }
    } catch {
      // Continue without session_id
    }

    // Check cache if we have a session_id
    if (sessionId) {
      const cached = this.cache.get(sessionId)
      if (cached) {
        const now = Date.now()
        if (now < cached.expiresAt && cached.tokenHash === tokenHash) {
          return {
            valid: true,
            payload: cached.payload,
            fromCache: true,
          }
        }
        // Cache expired or token changed, remove entry
        this.cache.delete(sessionId)
      }
    }

    // Verify the token
    const result = await oauthVerifyJWT(token, options)

    // Cache successful verifications
    if (result.valid && result.payload?.session_id) {
      this.setCacheEntry(result.payload.session_id, result.payload, tokenHash)
    }

    return {
      ...result,
      fromCache: false,
    }
  }

  /**
   * Set a cache entry, respecting max size
   */
  private setCacheEntry(sessionId: string, payload: OAuthJWTPayload, tokenHash: string): void {
    // Evict oldest entries if at max size
    if (this.cache.size >= this.maxEntries) {
      const keysToDelete: string[] = []
      let count = 0
      for (const key of this.cache.keys()) {
        keysToDelete.push(key)
        count++
        // Delete about 10% to avoid frequent evictions
        if (count >= Math.ceil(this.maxEntries * 0.1)) break
      }
      for (const key of keysToDelete) {
        this.cache.delete(key)
      }
    }

    this.cache.set(sessionId, {
      payload,
      expiresAt: Date.now() + this.ttlMs,
      tokenHash,
    })
  }

  /**
   * Invalidate a specific session from the cache
   */
  invalidate(sessionId: string): void {
    this.cache.delete(sessionId)
  }

  /**
   * Clear all cached sessions
   */
  clear(): void {
    this.cache.clear()
  }
}

// ============================================================================
// SCOPE VALIDATION
// ============================================================================

/**
 * Check if a payload has a specific scope
 *
 * Admin scope implies all other scopes.
 *
 * @param payload - JWT payload with scopes
 * @param scope - Scope to check for
 * @returns true if the scope is present (directly or implied)
 */
export function hasScope(payload: OAuthJWTPayload, scope: OAuthScope): boolean {
  // Admin has all permissions
  if (payload.scopes.includes('admin')) {
    return true
  }

  // Write implies read
  if (scope === 'read' && payload.scopes.includes('write')) {
    return true
  }

  return payload.scopes.includes(scope)
}

/**
 * Scope check result
 */
export interface ScopeCheckResult {
  allowed: boolean
  reason?: string
}

/**
 * Check if a scope is allowed for a specific operation
 *
 * @param payload - JWT payload with scopes
 * @param requiredScope - Required scope for the operation
 * @param path - Path being accessed (for logging/auditing)
 * @returns Check result
 */
export function checkScopeForOperation(
  payload: OAuthJWTPayload,
  requiredScope: OAuthScope,
  _path: string
): ScopeCheckResult {
  if (hasScope(payload, requiredScope)) {
    return { allowed: true }
  }

  return {
    allowed: false,
    reason: `Missing required scope: ${requiredScope}`,
  }
}

// ============================================================================
// OAUTH CONTEXT
// ============================================================================

/**
 * OAuth context stored in Hono context
 */
export interface OAuthContext {
  /** Whether the user is authenticated */
  authenticated: boolean
  /** User ID (from sub claim) */
  userId?: string
  /** Tenant ID */
  tenantId?: string
  /** Session ID */
  sessionId?: string
  /** Permission scopes */
  scopes?: OAuthScope[]
  /** Full JWT payload */
  payload?: OAuthJWTPayload
}

const OAUTH_CONTEXT_KEY = 'oauth'

/**
 * Get OAuth context from Hono context
 */
export function getOAuthContext(c: Context): OAuthContext | undefined {
  return c.get(OAUTH_CONTEXT_KEY) as OAuthContext | undefined
}

/**
 * Require OAuth context, throwing if not authenticated
 */
export function requireOAuthContext(c: Context): OAuthContext {
  const ctx = getOAuthContext(c)
  if (!ctx || !ctx.authenticated) {
    throw new OAuthError('AUTH_REQUIRED', 'Authentication required')
  }
  return ctx
}

// ============================================================================
// MIDDLEWARE
// ============================================================================

/**
 * OAuth middleware configuration
 */
export interface OAuthMiddlewareOptions {
  /** JWKS URL for token verification */
  jwksUrl: string
  /** Whether authentication is required (default: true) */
  required?: boolean
  /** Session cache instance */
  sessionCache?: OAuthSessionCache
  /** Cookie name for token extraction */
  cookieName?: string
  /** Public paths that don't require authentication */
  publicPaths?: string[]
}

/**
 * Match a path against a pattern
 */
function matchPath(path: string, pattern: string): boolean {
  if (pattern.endsWith('/*')) {
    return path.startsWith(pattern.slice(0, -2)) || path === pattern.slice(0, -2)
  }
  if (pattern.endsWith('*')) {
    return path.startsWith(pattern.slice(0, -1))
  }
  return path === pattern
}

/**
 * Create OAuth middleware for Hono
 *
 * @param options - Middleware configuration
 * @returns Hono middleware handler
 *
 * @example
 * ```typescript
 * const app = new Hono()
 *
 * app.use('*', createOAuthMiddleware({
 *   jwksUrl: 'https://oauth.do/.well-known/jwks.json',
 *   required: true,
 *   publicPaths: ['/health', '/public/*'],
 * }))
 * ```
 */
export function createOAuthMiddleware(options: OAuthMiddlewareOptions): MiddlewareHandler {
  const {
    jwksUrl,
    required = true,
    sessionCache,
    publicPaths,
  } = options

  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname

    // Check if path is public
    if (publicPaths?.some((p) => matchPath(path, p))) {
      c.set(OAUTH_CONTEXT_KEY, { authenticated: false } as OAuthContext)
      return next()
    }

    // Extract token
    const token = oauthExtractToken(c.req.raw.headers)

    if (!token) {
      if (required) {
        return c.json({ code: 'AUTH_REQUIRED', message: 'Authentication required' }, 401)
      }
      c.set(OAUTH_CONTEXT_KEY, { authenticated: false } as OAuthContext)
      return next()
    }

    // Verify token
    let result: JWTVerifyResult | CachedVerifyResult
    if (sessionCache) {
      result = await sessionCache.getOrVerify(token, { jwksUrl })
    } else {
      result = await oauthVerifyJWT(token, { jwksUrl })
    }

    if (!result.valid) {
      return c.json(
        { code: result.code ?? 'INVALID_TOKEN', message: result.error ?? 'Invalid token' },
        401
      )
    }

    // Set OAuth context
    const payload = result.payload!
    const oauthCtx: OAuthContext = {
      authenticated: true,
      userId: payload.sub,
      tenantId: payload.tenant_id,
      sessionId: payload.session_id,
      scopes: payload.scopes,
      payload,
    }
    c.set(OAUTH_CONTEXT_KEY, oauthCtx)

    return next()
  }
}

/**
 * Create middleware that requires specific OAuth scopes
 *
 * @param requiredScopes - Single scope or array of scopes (AND logic)
 * @returns Hono middleware handler
 */
export function requireOAuthScope(
  requiredScopes: OAuthScope | OAuthScope[]
): MiddlewareHandler {
  const scopes = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes]

  return async (c: Context, next: Next) => {
    const ctx = getOAuthContext(c)

    if (!ctx?.authenticated) {
      return c.json({ code: 'AUTH_REQUIRED', message: 'Authentication required' }, 401)
    }

    // Check all required scopes
    const userScopes = ctx.scopes ?? []
    const isAdmin = userScopes.includes('admin')

    for (const scope of scopes) {
      let hasRequiredScope = isAdmin || userScopes.includes(scope)

      // Write implies read
      if (scope === 'read' && userScopes.includes('write')) {
        hasRequiredScope = true
      }

      if (!hasRequiredScope) {
        return c.json(
          { code: 'PERMISSION_DENIED', message: `Missing required scope: ${scope}` },
          403
        )
      }
    }

    return next()
  }
}

// ============================================================================
// BRIDGE FUNCTIONS
// ============================================================================

/**
 * Convert OAuth scopes to fsx Permission format
 */
export function scopesToPermissions(scopes: OAuthScope[]): Permission[] {
  const permissions: Permission[] = []

  for (const scope of scopes) {
    switch (scope) {
      case 'read':
      case 'files:read':
        permissions.push({ type: 'read', scope: { path: '/**', recursive: true } })
        break
      case 'write':
      case 'files:write':
        permissions.push({ type: 'write', scope: { path: '/**', recursive: true } })
        break
      case 'files:delete':
        permissions.push({ type: 'delete', scope: { path: '/**', recursive: true } })
        break
      case 'admin':
        permissions.push(
          { type: 'read', scope: { path: '/**', recursive: true } },
          { type: 'write', scope: { path: '/**', recursive: true } },
          { type: 'delete', scope: { path: '/**', recursive: true } },
          { type: 'admin', scope: { path: '/**', recursive: true } }
        )
        break
    }
  }

  return permissions
}

/**
 * Convert OAuth payload to fsx AuthContext format
 */
export function oauthToAuthContext(payload: OAuthJWTPayload): AuthContext {
  return {
    method: 'jwt',
    authenticated: true,
    userId: payload.sub,
    tenantId: payload.tenant_id,
    permissions: scopesToPermissions(payload.scopes),
  }
}

// ============================================================================
// VERIFY JWT WRAPPER
// ============================================================================

/**
 * Wrapper for verifyJWT that uses oauth.do/server
 *
 * This is a convenience re-export that allows importing verifyJWT
 * directly from this module.
 */
export { oauthVerifyJWT as verifyJWT }

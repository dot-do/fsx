/**
 * @fileoverview OAuth.do Integration for fsx.do
 *
 * Provides OAuth 2.1 integration for fsx authentication:
 * - JWT verification using JWKS
 * - Session caching to reduce verification overhead
 * - Scope-based permission checking
 * - Hono middleware integration
 * - Bridge functions to convert between oauth.do and fsx auth formats
 *
 * @category Application
 * @module do/auth/oauth
 */

import type { Context, MiddlewareHandler, Next } from 'hono'
import type { AuthContext, Permission, AuthErrorCode } from './types.js'

// ============================================================================
// JWT TYPES
// ============================================================================

/**
 * OAuth JWT payload structure
 */
export interface OAuthJWTPayload {
  /** Subject - user ID */
  sub: string
  /** Issuer */
  iss?: string
  /** Audience */
  aud?: string | string[]
  /** Expiration time (Unix timestamp) */
  exp: number
  /** Issued at time (Unix timestamp) */
  iat?: number
  /** Not before (Unix timestamp) */
  nbf?: number
  /** JWT ID - unique identifier */
  jti?: string
  /** Session ID */
  session_id?: string
  /** Tenant ID for multi-tenancy */
  tenant_id?: string
  /** Permission scopes */
  scopes: OAuthScope[]
}

/**
 * OAuth permission scopes for fsx
 */
export type OAuthScope =
  | 'read'
  | 'write'
  | 'admin'
  | 'files:read'
  | 'files:write'
  | 'files:delete'

/**
 * JWT verification result
 */
export interface JWTVerifyResult {
  /** Whether the token is valid */
  valid: boolean
  /** Decoded payload if valid */
  payload?: OAuthJWTPayload
  /** Error code if invalid */
  code?: 'INVALID_TOKEN' | 'TOKEN_EXPIRED' | 'INVALID_SIGNATURE' | 'JWKS_ERROR'
  /** Error message if invalid */
  error?: string
}

// ============================================================================
// JWT UTILITIES
// ============================================================================

/**
 * Base64URL decode (RFC 4648)
 */
function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const paddingNeeded = (4 - (base64.length % 4)) % 4
  base64 += '='.repeat(paddingNeeded)

  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * Parse a JWT token into its parts
 */
function parseJWT(token: string): { header: string; payload: string; signature: string; signedInput: string } | null {
  const parts = token.split('.')
  if (parts.length !== 3) {
    return null
  }
  return {
    header: parts[0]!,
    payload: parts[1]!,
    signature: parts[2]!,
    signedInput: `${parts[0]}.${parts[1]}`,
  }
}

/**
 * Decode JWT header
 */
function decodeHeader(headerB64: string): { alg: string; typ?: string; kid?: string } | null {
  try {
    const headerJson = new TextDecoder().decode(base64UrlDecode(headerB64))
    return JSON.parse(headerJson)
  } catch {
    return null
  }
}

/**
 * Decode JWT payload
 */
function decodePayload(payloadB64: string): OAuthJWTPayload | null {
  try {
    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64))
    const payload = JSON.parse(payloadJson)
    // Ensure scopes is always an array
    if (!payload.scopes) {
      payload.scopes = []
    } else if (typeof payload.scopes === 'string') {
      payload.scopes = payload.scopes.split(' ')
    }
    return payload
  } catch {
    return null
  }
}

// ============================================================================
// JWKS TYPES
// ============================================================================

interface JWK {
  kty: string
  kid?: string
  use?: string
  n?: string
  e?: string
  alg?: string
}

interface JWKS {
  keys: JWK[]
}

/**
 * JWKS cache entry
 */
interface JWKSCacheEntry {
  keys: Map<string, CryptoKey>
  fetchedAt: number
  expiresAt: number
}

/** JWKS cache - maps URL to cache entry */
const jwksCache = new Map<string, JWKSCacheEntry>()

/** JWKS cache TTL in milliseconds (5 minutes) */
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000

/**
 * Fetch and cache JWKS from URL
 */
async function fetchJWKS(jwksUrl: string): Promise<Map<string, CryptoKey>> {
  const now = Date.now()

  // Check cache
  const cached = jwksCache.get(jwksUrl)
  if (cached && now < cached.expiresAt) {
    return cached.keys
  }

  // Fetch JWKS
  const response = await fetch(jwksUrl)
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS: ${response.status}`)
  }

  const jwks: JWKS = await response.json()
  const keys = new Map<string, CryptoKey>()

  // Import each key
  for (const jwk of jwks.keys) {
    if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) continue
    if (jwk.use && jwk.use !== 'sig') continue

    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        {
          kty: jwk.kty,
          n: jwk.n,
          e: jwk.e,
          alg: jwk.alg || 'RS256',
          use: 'sig',
        },
        {
          name: 'RSASSA-PKCS1-v1_5',
          hash: { name: 'SHA-256' },
        },
        false,
        ['verify']
      )

      if (jwk.kid) {
        keys.set(jwk.kid, key)
      }
      // Also store without kid for single-key scenarios
      if (jwks.keys.length === 1) {
        keys.set('default', key)
      }
    } catch {
      // Skip invalid keys
    }
  }

  // Cache the keys
  jwksCache.set(jwksUrl, {
    keys,
    fetchedAt: now,
    expiresAt: now + JWKS_CACHE_TTL_MS,
  })

  return keys
}

// ============================================================================
// TOKEN EXTRACTION
// ============================================================================

/**
 * Extract token from request headers
 *
 * Checks Authorization header first (Bearer token), then falls back to cookie.
 */
export function extractToken(headers: Headers, cookieName?: string): string | null {
  // Try Authorization header first
  const authHeader = headers.get('Authorization')
  if (authHeader) {
    const token = extractBearerToken(authHeader)
    if (token) return token
  }

  // Try cookie if cookieName is provided
  if (cookieName) {
    const cookieHeader = headers.get('Cookie')
    if (cookieHeader) {
      const cookies = parseCookies(cookieHeader)
      const cookieValue = cookies[cookieName]
      if (cookieValue) {
        try {
          return decodeURIComponent(cookieValue)
        } catch {
          return cookieValue
        }
      }
    }
  }

  return null
}

/**
 * Extract Bearer token from Authorization header
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null

  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0]!.toLowerCase() !== 'bearer') {
    return null
  }

  return parts[1] || null
}

/**
 * Parse a cookie header into key-value pairs
 */
function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {}
  const pairs = cookieHeader.split(';')

  for (const pair of pairs) {
    const [name, ...valueParts] = pair.trim().split('=')
    if (name) {
      cookies[name.trim()] = valueParts.join('=').trim()
    }
  }

  return cookies
}

// ============================================================================
// JWT VERIFICATION
// ============================================================================

/**
 * Verify JWT options
 */
export interface VerifyJWTOptions {
  /** JWKS URL for signature verification */
  jwksUrl: string
  /** Expected issuer (optional) */
  issuer?: string
  /** Expected audience (optional) */
  audience?: string | string[]
  /** Clock tolerance in seconds (default: 60) */
  clockTolerance?: number
}

/**
 * Verify a JWT token
 *
 * @param token - The JWT token string
 * @param options - Verification options
 * @returns Verification result
 */
export async function verifyJWT(token: string, options: VerifyJWTOptions): Promise<JWTVerifyResult> {
  // Parse the token
  const parsed = parseJWT(token)
  if (!parsed) {
    return { valid: false, code: 'INVALID_TOKEN', error: 'Invalid JWT format' }
  }

  // Decode header
  const header = decodeHeader(parsed.header)
  if (!header) {
    return { valid: false, code: 'INVALID_TOKEN', error: 'Invalid JWT header' }
  }

  // Decode payload
  const payload = decodePayload(parsed.payload)
  if (!payload) {
    return { valid: false, code: 'INVALID_TOKEN', error: 'Invalid JWT payload' }
  }

  // Validate claims
  const now = Math.floor(Date.now() / 1000)
  const clockTolerance = options.clockTolerance ?? 60

  // Check expiration
  if (payload.exp && now > payload.exp + clockTolerance) {
    return { valid: false, code: 'TOKEN_EXPIRED', error: 'Token has expired' }
  }

  // Check not before
  if (payload.nbf && now < payload.nbf - clockTolerance) {
    return { valid: false, code: 'INVALID_TOKEN', error: 'Token not yet valid' }
  }

  // Check issuer
  if (options.issuer && payload.iss !== options.issuer) {
    return { valid: false, code: 'INVALID_TOKEN', error: 'Invalid issuer' }
  }

  // Check audience
  if (options.audience) {
    const audiences = Array.isArray(options.audience) ? options.audience : [options.audience]
    const payloadAud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : []
    if (!payloadAud.some((aud) => audiences.includes(aud))) {
      return { valid: false, code: 'INVALID_TOKEN', error: 'Invalid audience' }
    }
  }

  // Verify signature
  try {
    const keys = await fetchJWKS(options.jwksUrl)
    const kid = header.kid || 'default'
    const key = keys.get(kid)

    if (!key) {
      return { valid: false, code: 'JWKS_ERROR', error: 'No matching key found in JWKS' }
    }

    const signedData = new TextEncoder().encode(parsed.signedInput)
    const signatureBytes = base64UrlDecode(parsed.signature)

    const isValid = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      signatureBytes,
      signedData
    )

    if (!isValid) {
      return { valid: false, code: 'INVALID_SIGNATURE', error: 'Signature verification failed' }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { valid: false, code: 'JWKS_ERROR', error: `JWKS error: ${message}` }
  }

  return { valid: true, payload }
}

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
      return 'INVALID_TOKEN'
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
   */
  async getOrVerify(
    token: string,
    options: VerifyJWTOptions
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
    const result = await verifyJWT(token, options)

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

  // files:write implies files:read
  if (scope === 'files:read' && payload.scopes.includes('files:write')) {
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
 */
export function createOAuthMiddleware(options: OAuthMiddlewareOptions): MiddlewareHandler {
  const { jwksUrl, required = true, sessionCache, publicPaths } = options

  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname

    // Check if path is public
    if (publicPaths?.some((p) => matchPath(path, p))) {
      c.set(OAUTH_CONTEXT_KEY, { authenticated: false } as OAuthContext)
      return next()
    }

    // Extract token
    const token = extractToken(c.req.raw.headers, options.cookieName)

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
      result = await verifyJWT(token, { jwksUrl })
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

      // files:write implies files:read
      if (scope === 'files:read' && userScopes.includes('files:write')) {
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

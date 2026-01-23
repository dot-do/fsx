/**
 * @fileoverview OAuth.do Integration Tests (RED - Failing Tests)
 *
 * Tests for oauth.do integration with fsx.do authentication layer.
 * These tests define the expected behavior for:
 * - Token extraction from Authorization header (Bearer token)
 * - Token extraction from Cookie
 * - JWT verification using verifyJWT() from oauth.do/server
 * - Session validation caching (don't hit oauth.do on every request)
 * - Permission scopes: read, write, admin
 * - Rejection of invalid/expired tokens
 * - Integration with existing Hono middleware
 *
 * @category Application
 * @module do/auth/oauth.test
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type { Context } from 'hono'

// ============================================================================
// MOCK TYPES FOR oauth.do/server (to be implemented)
// ============================================================================

/**
 * JWT verification result from oauth.do
 */
interface JWTVerifyResult {
  /** Whether the token is valid */
  valid: boolean
  /** Decoded payload (if valid) */
  payload?: OAuthJWTPayload
  /** Error message (if invalid) */
  error?: string
  /** Error code */
  code?: 'INVALID_TOKEN' | 'TOKEN_EXPIRED' | 'INVALID_SIGNATURE' | 'JWKS_ERROR'
}

/**
 * OAuth JWT payload structure from oauth.do
 */
interface OAuthJWTPayload {
  /** Subject - unique user identifier */
  sub: string
  /** Issuer */
  iss: string
  /** Audience */
  aud: string | string[]
  /** Expiration time */
  exp: number
  /** Issued at */
  iat: number
  /** Tenant ID */
  tenant_id: string
  /** Permission scopes */
  scopes: OAuthScope[]
  /** Session ID for caching */
  session_id: string
  /** User email (optional) */
  email?: string
  /** User name (optional) */
  name?: string
}

/**
 * OAuth permission scopes
 */
type OAuthScope = 'read' | 'write' | 'admin' | 'files:read' | 'files:write' | 'files:delete'

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

// ============================================================================
// IMPORTS TO BE IMPLEMENTED
// These imports will fail until oauth.do integration is implemented
// ============================================================================

// The following will be implemented:
// import { extractToken, extractBearerToken, verifyJWT } from 'oauth.do/server'
// import { createOAuthMiddleware, OAuthSessionCache } from './oauth.js'

// Placeholder types for the implementation
type ExtractTokenFn = (headers: Headers) => string | null
type ExtractBearerTokenFn = (headers: Headers) => string | null
type VerifyJWTFn = (token: string, options: { jwksUrl: string }) => Promise<JWTVerifyResult>

// ============================================================================
// TEST UTILITIES
// ============================================================================

/**
 * Create a mock Headers object
 */
function createMockHeaders(init?: Record<string, string>): Headers {
  const headers = new Headers()
  if (init) {
    for (const [key, value] of Object.entries(init)) {
      headers.set(key, value)
    }
  }
  return headers
}

/**
 * Create a valid test JWT token (mock)
 */
// Counter for generating unique JWT IDs
let jwtIdCounter = 0

function createTestJWT(payload: Partial<OAuthJWTPayload>, expiresIn = 3600): string {
  const now = Math.floor(Date.now() / 1000)
  // Generate a unique jti (JWT ID) to ensure each token is unique
  const jti = `jwt_${now}_${++jwtIdCounter}_${Math.random().toString(36).substring(2, 8)}`
  const fullPayload: OAuthJWTPayload & { jti?: string } = {
    sub: 'user_123',
    iss: 'https://oauth.do',
    aud: 'fsx.do',
    exp: now + expiresIn,
    iat: now,
    tenant_id: 'tenant_abc',
    scopes: ['read'],
    session_id: 'session_xyz',
    jti, // Add unique JWT ID to make each token unique
    ...payload,
  }

  // Create a mock JWT structure (header.payload.signature)
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  const payloadB64 = btoa(JSON.stringify(fullPayload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  const signature = 'mock_signature_for_testing'

  return `${header}.${payloadB64}.${signature}`
}

/**
 * Create an expired JWT token
 */
function createExpiredJWT(payload?: Partial<OAuthJWTPayload>): string {
  return createTestJWT({ ...payload }, -3600) // Expired 1 hour ago
}

/**
 * Create a mock Hono context
 */
function createMockContext(options: {
  headers?: Record<string, string>
  cookies?: Record<string, string>
  path?: string
  method?: string
}): Context {
  const headers = createMockHeaders(options.headers)
  const cookies = options.cookies ?? {}

  return {
    req: {
      header: (name: string) => headers.get(name),
      raw: {
        headers,
      },
      url: `https://fsx.do${options.path ?? '/'}`,
      method: options.method ?? 'GET',
    },
    get: vi.fn(),
    set: vi.fn(),
    json: vi.fn((data, status) => new Response(JSON.stringify(data), { status })),
    // Mock cookie access
    cookie: (name: string) => cookies[name],
  } as unknown as Context
}

// ============================================================================
// TOKEN EXTRACTION TESTS
// ============================================================================

describe('OAuth Token Extraction', () => {
  describe('extractToken()', () => {
    it('should extract Bearer token from Authorization header', async () => {
      // This test expects extractToken from oauth.do/server
      const { extractToken } = await import('oauth.do/server')

      const headers = createMockHeaders({
        Authorization: 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test.signature',
      })

      const token = extractToken(headers)

      expect(token).toBe('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test.signature')
    })

    it('should extract token from Cookie when Authorization header is absent', async () => {
      const { extractToken } = await import('oauth.do/server')

      const headers = createMockHeaders({
        Cookie: 'oauth_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.cookie.signature',
      })

      const token = extractToken(headers)

      expect(token).toBe('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.cookie.signature')
    })

    it('should prefer Authorization header over Cookie', async () => {
      const { extractToken } = await import('oauth.do/server')

      const headers = createMockHeaders({
        Authorization: 'Bearer header_token',
        Cookie: 'oauth_token=cookie_token',
      })

      const token = extractToken(headers)

      expect(token).toBe('header_token')
    })

    it('should return null when no token is present', async () => {
      const { extractToken } = await import('oauth.do/server')

      const headers = createMockHeaders({})

      const token = extractToken(headers)

      expect(token).toBeNull()
    })

    it('should return null for malformed Authorization header', async () => {
      const { extractToken } = await import('oauth.do/server')

      const headers = createMockHeaders({
        Authorization: 'Basic dXNlcjpwYXNz', // Basic auth, not Bearer
      })

      const token = extractToken(headers)

      expect(token).toBeNull()
    })

    it('should handle multiple cookies and extract oauth_token', async () => {
      const { extractToken } = await import('oauth.do/server')

      const headers = createMockHeaders({
        Cookie: 'session=abc; oauth_token=the_jwt_token; other=xyz',
      })

      const token = extractToken(headers)

      expect(token).toBe('the_jwt_token')
    })

    it('should handle __Host- prefixed cookie for security', async () => {
      const { extractToken } = await import('oauth.do/server')

      const headers = createMockHeaders({
        Cookie: '__Host-oauth_token=secure_jwt_token',
      })

      const token = extractToken(headers)

      expect(token).toBe('secure_jwt_token')
    })
  })

  describe('extractBearerToken()', () => {
    it('should extract token from valid Bearer header', async () => {
      const { extractBearerToken } = await import('oauth.do/server')

      const headers = createMockHeaders({
        Authorization: 'Bearer my_jwt_token',
      })

      const token = extractBearerToken(headers)

      expect(token).toBe('my_jwt_token')
    })

    it('should be case-insensitive for Bearer keyword', async () => {
      const { extractBearerToken } = await import('oauth.do/server')

      const headers = createMockHeaders({
        Authorization: 'bearer my_jwt_token',
      })

      const token = extractBearerToken(headers)

      expect(token).toBe('my_jwt_token')
    })

    it('should return null for non-Bearer auth schemes', async () => {
      const { extractBearerToken } = await import('oauth.do/server')

      const headers = createMockHeaders({
        Authorization: 'Basic dXNlcjpwYXNz',
      })

      const token = extractBearerToken(headers)

      expect(token).toBeNull()
    })

    it('should return null when Authorization header is missing', async () => {
      const { extractBearerToken } = await import('oauth.do/server')

      const headers = createMockHeaders({})

      const token = extractBearerToken(headers)

      expect(token).toBeNull()
    })

    it('should handle whitespace correctly', async () => {
      const { extractBearerToken } = await import('oauth.do/server')

      const headers = createMockHeaders({
        Authorization: 'Bearer   token_with_spaces  ',
      })

      const token = extractBearerToken(headers)

      // Should trim or handle gracefully
      expect(token).toBeTruthy()
    })
  })
})

// ============================================================================
// JWT VERIFICATION TESTS
// ============================================================================

describe('OAuth JWT Verification', () => {
  const JWKS_URL = 'https://oauth.do/.well-known/jwks.json'

  describe('verifyJWT()', () => {
    it('should verify a valid JWT token', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      const token = createTestJWT({
        sub: 'user_123',
        tenant_id: 'tenant_abc',
        scopes: ['read', 'write'],
      })

      const result = await verifyJWT(token, { jwksUrl: JWKS_URL })

      expect(result.valid).toBe(true)
      expect(result.payload).toBeDefined()
      expect(result.payload?.sub).toBe('user_123')
      expect(result.payload?.tenant_id).toBe('tenant_abc')
      expect(result.payload?.scopes).toContain('read')
      expect(result.payload?.scopes).toContain('write')
    })

    it('should reject an expired token', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      const token = createExpiredJWT({
        sub: 'user_123',
        tenant_id: 'tenant_abc',
      })

      const result = await verifyJWT(token, { jwksUrl: JWKS_URL })

      expect(result.valid).toBe(false)
      expect(result.code).toBe('TOKEN_EXPIRED')
      expect(result.error).toContain('expired')
    })

    it('should reject a token with invalid signature', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      // Tamper with the signature
      const validToken = createTestJWT({ sub: 'user_123' })
      const [header, payload] = validToken.split('.')
      const tamperedToken = `${header}.${payload}.tampered_signature`

      const result = await verifyJWT(tamperedToken, { jwksUrl: JWKS_URL })

      expect(result.valid).toBe(false)
      expect(result.code).toBe('INVALID_SIGNATURE')
    })

    it('should reject a malformed token', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      const result = await verifyJWT('not.a.valid.jwt.token', { jwksUrl: JWKS_URL })

      expect(result.valid).toBe(false)
      expect(result.code).toBe('INVALID_TOKEN')
    })

    it('should reject an empty token', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      const result = await verifyJWT('', { jwksUrl: JWKS_URL })

      expect(result.valid).toBe(false)
      expect(result.code).toBe('INVALID_TOKEN')
    })

    it('should handle JWKS fetch errors gracefully', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      const token = createTestJWT({ sub: 'user_123' })

      // Use an invalid JWKS URL
      const result = await verifyJWT(token, { jwksUrl: 'https://invalid.url/jwks' })

      expect(result.valid).toBe(false)
      expect(result.code).toBe('JWKS_ERROR')
    })

    it('should validate required claims (tenant_id)', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      // Create a token without tenant_id (manually construct)
      const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
      const payload = btoa(
        JSON.stringify({
          sub: 'user_123',
          iss: 'https://oauth.do',
          exp: Math.floor(Date.now() / 1000) + 3600,
          // Missing tenant_id
        })
      )
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
      const token = `${header}.${payload}.signature`

      const result = await verifyJWT(token, { jwksUrl: JWKS_URL })

      expect(result.valid).toBe(false)
      expect(result.error).toContain('tenant_id')
    })

    it('should support RS256 algorithm', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      const token = createTestJWT({ sub: 'user_123' })

      const result = await verifyJWT(token, { jwksUrl: JWKS_URL })

      expect(result.valid).toBe(true)
    })

    it('should extract session_id for caching', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      const token = createTestJWT({
        sub: 'user_123',
        session_id: 'session_xyz_123',
      })

      const result = await verifyJWT(token, { jwksUrl: JWKS_URL })

      expect(result.valid).toBe(true)
      expect(result.payload?.session_id).toBe('session_xyz_123')
    })
  })
})

// ============================================================================
// SESSION CACHING TESTS
// ============================================================================

describe('OAuth Session Caching', () => {
  describe('OAuthSessionCache', () => {
    it('should cache valid session after first verification', async () => {
      // Import the cache implementation (to be created)
      const { OAuthSessionCache } = await import('./oauth.js')

      const cache = new OAuthSessionCache({ ttlSeconds: 300 })
      const token = createTestJWT({
        sub: 'user_123',
        session_id: 'session_cache_test',
      })

      // First call should verify
      const result1 = await cache.getOrVerify(token, { jwksUrl: 'https://oauth.do/.well-known/jwks.json' })
      expect(result1.valid).toBe(true)
      expect(result1.fromCache).toBe(false)

      // Second call should use cache
      const result2 = await cache.getOrVerify(token, { jwksUrl: 'https://oauth.do/.well-known/jwks.json' })
      expect(result2.valid).toBe(true)
      expect(result2.fromCache).toBe(true)
    })

    it('should not cache invalid sessions', async () => {
      const { OAuthSessionCache } = await import('./oauth.js')

      const cache = new OAuthSessionCache({ ttlSeconds: 300 })
      const expiredToken = createExpiredJWT({ session_id: 'expired_session' })

      const result1 = await cache.getOrVerify(expiredToken, { jwksUrl: 'https://oauth.do/.well-known/jwks.json' })
      expect(result1.valid).toBe(false)
      expect(result1.fromCache).toBe(false)

      // Should re-verify, not use cache
      const result2 = await cache.getOrVerify(expiredToken, { jwksUrl: 'https://oauth.do/.well-known/jwks.json' })
      expect(result2.fromCache).toBe(false)
    })

    it('should expire cached sessions after TTL', async () => {
      const { OAuthSessionCache } = await import('./oauth.js')

      // Use a very short TTL for testing
      const cache = new OAuthSessionCache({ ttlSeconds: 1 })
      const token = createTestJWT({ session_id: 'ttl_test_session' })

      // Cache the session
      await cache.getOrVerify(token, { jwksUrl: 'https://oauth.do/.well-known/jwks.json' })

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 1100))

      // Should re-verify after TTL
      const result = await cache.getOrVerify(token, { jwksUrl: 'https://oauth.do/.well-known/jwks.json' })
      expect(result.fromCache).toBe(false)
    })

    it('should invalidate cache when token changes', async () => {
      const { OAuthSessionCache } = await import('./oauth.js')

      const cache = new OAuthSessionCache({ ttlSeconds: 300 })

      // Cache with first token
      const token1 = createTestJWT({ session_id: 'same_session', sub: 'user_1' })
      await cache.getOrVerify(token1, { jwksUrl: 'https://oauth.do/.well-known/jwks.json' })

      // Different token for same session (e.g., refreshed token)
      const token2 = createTestJWT({ session_id: 'same_session', sub: 'user_1' })
      const result = await cache.getOrVerify(token2, { jwksUrl: 'https://oauth.do/.well-known/jwks.json' })

      // Should not use cache because token hash differs
      expect(result.fromCache).toBe(false)
    })

    it('should support manual cache invalidation', async () => {
      const { OAuthSessionCache } = await import('./oauth.js')

      const cache = new OAuthSessionCache({ ttlSeconds: 300 })
      const token = createTestJWT({ session_id: 'invalidation_test' })

      // Cache the session
      await cache.getOrVerify(token, { jwksUrl: 'https://oauth.do/.well-known/jwks.json' })

      // Invalidate
      cache.invalidate('invalidation_test')

      // Should re-verify
      const result = await cache.getOrVerify(token, { jwksUrl: 'https://oauth.do/.well-known/jwks.json' })
      expect(result.fromCache).toBe(false)
    })

    it('should support cache clear all', async () => {
      const { OAuthSessionCache } = await import('./oauth.js')

      const cache = new OAuthSessionCache({ ttlSeconds: 300 })

      // Cache multiple sessions
      const token1 = createTestJWT({ session_id: 'session_1' })
      const token2 = createTestJWT({ session_id: 'session_2' })

      await cache.getOrVerify(token1, { jwksUrl: 'https://oauth.do/.well-known/jwks.json' })
      await cache.getOrVerify(token2, { jwksUrl: 'https://oauth.do/.well-known/jwks.json' })

      // Clear all
      cache.clear()

      // Both should re-verify
      const result1 = await cache.getOrVerify(token1, { jwksUrl: 'https://oauth.do/.well-known/jwks.json' })
      const result2 = await cache.getOrVerify(token2, { jwksUrl: 'https://oauth.do/.well-known/jwks.json' })

      expect(result1.fromCache).toBe(false)
      expect(result2.fromCache).toBe(false)
    })

    it('should limit cache size to prevent memory issues', async () => {
      const { OAuthSessionCache } = await import('./oauth.js')

      const cache = new OAuthSessionCache({ ttlSeconds: 300, maxEntries: 10 })

      // Add more entries than max
      for (let i = 0; i < 15; i++) {
        const token = createTestJWT({ session_id: `session_${i}` })
        await cache.getOrVerify(token, { jwksUrl: 'https://oauth.do/.well-known/jwks.json' })
      }

      // Check cache size doesn't exceed max
      expect(cache.size).toBeLessThanOrEqual(10)
    })
  })
})

// ============================================================================
// PERMISSION SCOPES TESTS
// ============================================================================

describe('OAuth Permission Scopes', () => {
  describe('scope validation', () => {
    it('should grant read access with read scope', async () => {
      const { hasScope, checkScopeForOperation } = await import('./oauth.js')

      const payload: OAuthJWTPayload = {
        sub: 'user_123',
        iss: 'https://oauth.do',
        aud: 'fsx.do',
        exp: Date.now() / 1000 + 3600,
        iat: Date.now() / 1000,
        tenant_id: 'tenant_abc',
        scopes: ['read'],
        session_id: 'session_xyz',
      }

      expect(hasScope(payload, 'read')).toBe(true)
      expect(checkScopeForOperation(payload, 'read', '/some/path')).toEqual({
        allowed: true,
      })
    })

    it('should deny write access with only read scope', async () => {
      const { hasScope, checkScopeForOperation } = await import('./oauth.js')

      const payload: OAuthJWTPayload = {
        sub: 'user_123',
        iss: 'https://oauth.do',
        aud: 'fsx.do',
        exp: Date.now() / 1000 + 3600,
        iat: Date.now() / 1000,
        tenant_id: 'tenant_abc',
        scopes: ['read'],
        session_id: 'session_xyz',
      }

      expect(hasScope(payload, 'write')).toBe(false)
      expect(checkScopeForOperation(payload, 'write', '/some/path')).toEqual({
        allowed: false,
        reason: 'Missing required scope: write',
      })
    })

    it('should grant write access with write scope', async () => {
      const { hasScope, checkScopeForOperation } = await import('./oauth.js')

      const payload: OAuthJWTPayload = {
        sub: 'user_123',
        iss: 'https://oauth.do',
        aud: 'fsx.do',
        exp: Date.now() / 1000 + 3600,
        iat: Date.now() / 1000,
        tenant_id: 'tenant_abc',
        scopes: ['read', 'write'],
        session_id: 'session_xyz',
      }

      expect(hasScope(payload, 'write')).toBe(true)
      expect(checkScopeForOperation(payload, 'write', '/some/path')).toEqual({
        allowed: true,
      })
    })

    it('should grant all access with admin scope', async () => {
      const { hasScope, checkScopeForOperation } = await import('./oauth.js')

      const payload: OAuthJWTPayload = {
        sub: 'admin_user',
        iss: 'https://oauth.do',
        aud: 'fsx.do',
        exp: Date.now() / 1000 + 3600,
        iat: Date.now() / 1000,
        tenant_id: 'tenant_abc',
        scopes: ['admin'],
        session_id: 'session_xyz',
      }

      // Admin should have all permissions
      expect(hasScope(payload, 'read')).toBe(true)
      expect(hasScope(payload, 'write')).toBe(true)
      expect(hasScope(payload, 'admin')).toBe(true)
      expect(checkScopeForOperation(payload, 'admin', '/admin/settings')).toEqual({
        allowed: true,
      })
    })

    it('should support fine-grained file scopes', async () => {
      const { hasScope, checkScopeForOperation } = await import('./oauth.js')

      const payload: OAuthJWTPayload = {
        sub: 'user_123',
        iss: 'https://oauth.do',
        aud: 'fsx.do',
        exp: Date.now() / 1000 + 3600,
        iat: Date.now() / 1000,
        tenant_id: 'tenant_abc',
        scopes: ['files:read', 'files:write'],
        session_id: 'session_xyz',
      }

      expect(hasScope(payload, 'files:read')).toBe(true)
      expect(hasScope(payload, 'files:write')).toBe(true)
      expect(hasScope(payload, 'files:delete')).toBe(false)
    })

    it('should deny access with empty scopes', async () => {
      const { checkScopeForOperation } = await import('./oauth.js')

      const payload: OAuthJWTPayload = {
        sub: 'user_123',
        iss: 'https://oauth.do',
        aud: 'fsx.do',
        exp: Date.now() / 1000 + 3600,
        iat: Date.now() / 1000,
        tenant_id: 'tenant_abc',
        scopes: [],
        session_id: 'session_xyz',
      }

      expect(checkScopeForOperation(payload, 'read', '/some/path')).toEqual({
        allowed: false,
        reason: 'Missing required scope: read',
      })
    })
  })

  describe('scope inheritance', () => {
    it('should allow write scope to imply read access', async () => {
      const { checkScopeForOperation } = await import('./oauth.js')

      const payload: OAuthJWTPayload = {
        sub: 'user_123',
        iss: 'https://oauth.do',
        aud: 'fsx.do',
        exp: Date.now() / 1000 + 3600,
        iat: Date.now() / 1000,
        tenant_id: 'tenant_abc',
        scopes: ['write'], // Only write scope
        session_id: 'session_xyz',
      }

      // Write should imply read
      expect(checkScopeForOperation(payload, 'read', '/some/path')).toEqual({
        allowed: true,
      })
    })

    it('should allow admin scope to imply all access', async () => {
      const { checkScopeForOperation } = await import('./oauth.js')

      const payload: OAuthJWTPayload = {
        sub: 'admin_user',
        iss: 'https://oauth.do',
        aud: 'fsx.do',
        exp: Date.now() / 1000 + 3600,
        iat: Date.now() / 1000,
        tenant_id: 'tenant_abc',
        scopes: ['admin'], // Only admin scope
        session_id: 'session_xyz',
      }

      expect(checkScopeForOperation(payload, 'read', '/path')).toEqual({ allowed: true })
      expect(checkScopeForOperation(payload, 'write', '/path')).toEqual({ allowed: true })
      expect(checkScopeForOperation(payload, 'admin', '/path')).toEqual({ allowed: true })
    })
  })
})

// ============================================================================
// INVALID/EXPIRED TOKEN REJECTION TESTS
// ============================================================================

describe('OAuth Invalid Token Rejection', () => {
  describe('token format validation', () => {
    it('should reject token with invalid format (no dots)', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      const result = await verifyJWT('invalid_token_no_dots', {
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      expect(result.valid).toBe(false)
      expect(result.code).toBe('INVALID_TOKEN')
    })

    it('should reject token with too many parts', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      const result = await verifyJWT('a.b.c.d.e', {
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      expect(result.valid).toBe(false)
      expect(result.code).toBe('INVALID_TOKEN')
    })

    it('should reject token with invalid base64 encoding', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      const result = await verifyJWT('!!!.@@@.###', {
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      expect(result.valid).toBe(false)
      expect(result.code).toBe('INVALID_TOKEN')
    })

    it('should reject token with invalid JSON in payload', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      const invalidPayload = btoa('not valid json')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
      const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')

      const result = await verifyJWT(`${header}.${invalidPayload}.signature`, {
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      expect(result.valid).toBe(false)
      expect(result.code).toBe('INVALID_TOKEN')
    })
  })

  describe('expiration validation', () => {
    it('should reject token expired beyond tolerance window', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      // Token expired 90 seconds ago - beyond the 60 second tolerance window
      const token = createTestJWT({}, -90)

      const result = await verifyJWT(token, {
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      expect(result.valid).toBe(false)
      expect(result.code).toBe('TOKEN_EXPIRED')
    })

    it('should reject token expired by 1 hour', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      const token = createExpiredJWT()

      const result = await verifyJWT(token, {
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      expect(result.valid).toBe(false)
      expect(result.code).toBe('TOKEN_EXPIRED')
    })

    it('should accept token with clock skew tolerance', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      // Token that expired 30 seconds ago (within typical 60s tolerance)
      const token = createTestJWT({}, -30)

      const result = await verifyJWT(token, {
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      // Should be valid with default clock tolerance
      expect(result.valid).toBe(true)
    })

    it('should reject not-yet-valid tokens (nbf claim)', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      const now = Math.floor(Date.now() / 1000)
      const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
      const payload = btoa(
        JSON.stringify({
          sub: 'user_123',
          iss: 'https://oauth.do',
          aud: 'fsx.do',
          exp: now + 7200,
          iat: now,
          nbf: now + 3600, // Not valid for another hour
          tenant_id: 'tenant_abc',
          scopes: ['read'],
          session_id: 'session_xyz',
        })
      )
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')

      const result = await verifyJWT(`${header}.${payload}.signature`, {
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      expect(result.valid).toBe(false)
      expect(result.error).toContain('not yet valid')
    })
  })

  describe('signature validation', () => {
    it('should reject token with wrong algorithm', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      // Create token with HS256 but server expects RS256
      const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
      const payload = btoa(
        JSON.stringify({
          sub: 'user_123',
          tenant_id: 'tenant_abc',
          exp: Math.floor(Date.now() / 1000) + 3600,
        })
      )
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')

      const result = await verifyJWT(`${header}.${payload}.signature`, {
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      expect(result.valid).toBe(false)
    })

    it('should reject token with none algorithm', async () => {
      const { verifyJWT } = await import('oauth.do/server')

      // "none" algorithm attack
      const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
      const payload = btoa(
        JSON.stringify({
          sub: 'attacker',
          tenant_id: 'victim_tenant',
          exp: Math.floor(Date.now() / 1000) + 3600,
        })
      )
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')

      const result = await verifyJWT(`${header}.${payload}.`, {
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
      })

      expect(result.valid).toBe(false)
    })
  })
})

// ============================================================================
// HONO MIDDLEWARE INTEGRATION TESTS
// ============================================================================

describe('OAuth Hono Middleware Integration', () => {
  describe('createOAuthMiddleware()', () => {
    it('should create middleware that authenticates valid tokens', async () => {
      const { createOAuthMiddleware } = await import('./oauth.js')

      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
        required: true,
      })

      const token = createTestJWT({ sub: 'user_123', scopes: ['read'] })
      const ctx = createMockContext({
        headers: { Authorization: `Bearer ${token}` },
      })

      let nextCalled = false
      const next = async () => {
        nextCalled = true
      }

      await middleware(ctx, next)

      expect(nextCalled).toBe(true)
      expect(ctx.set).toHaveBeenCalledWith('oauth', expect.objectContaining({
        authenticated: true,
        userId: 'user_123',
      }))
    })

    it('should reject requests without token when required', async () => {
      const { createOAuthMiddleware } = await import('./oauth.js')

      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
        required: true,
      })

      const ctx = createMockContext({
        headers: {}, // No Authorization header
      })

      let nextCalled = false
      const next = async () => {
        nextCalled = true
      }

      const response = await middleware(ctx, next)

      expect(nextCalled).toBe(false)
      expect(ctx.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'AUTH_REQUIRED' }),
        401
      )
    })

    it('should allow requests without token when not required', async () => {
      const { createOAuthMiddleware } = await import('./oauth.js')

      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
        required: false,
      })

      const ctx = createMockContext({
        headers: {},
      })

      let nextCalled = false
      const next = async () => {
        nextCalled = true
      }

      await middleware(ctx, next)

      expect(nextCalled).toBe(true)
      expect(ctx.set).toHaveBeenCalledWith('oauth', expect.objectContaining({
        authenticated: false,
      }))
    })

    it('should reject expired tokens', async () => {
      const { createOAuthMiddleware } = await import('./oauth.js')

      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
        required: true,
      })

      const token = createExpiredJWT({ sub: 'user_123' })
      const ctx = createMockContext({
        headers: { Authorization: `Bearer ${token}` },
      })

      let nextCalled = false
      const next = async () => {
        nextCalled = true
      }

      await middleware(ctx, next)

      expect(nextCalled).toBe(false)
      expect(ctx.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'TOKEN_EXPIRED' }),
        401
      )
    })

    it('should use session cache to avoid repeated verification', async () => {
      const { createOAuthMiddleware, OAuthSessionCache } = await import('./oauth.js')

      const cache = new OAuthSessionCache({ ttlSeconds: 300 })
      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
        required: true,
        sessionCache: cache,
      })

      const token = createTestJWT({ sub: 'user_123', session_id: 'cache_test' })

      // First request
      const ctx1 = createMockContext({
        headers: { Authorization: `Bearer ${token}` },
      })
      await middleware(ctx1, async () => {})

      // Second request with same token
      const ctx2 = createMockContext({
        headers: { Authorization: `Bearer ${token}` },
      })
      await middleware(ctx2, async () => {})

      // Verify cache was used (second request should be from cache)
      // This would require spying on the verifyJWT function
      expect(cache.size).toBeGreaterThan(0)
    })

    it('should extract token from Cookie when header is absent', async () => {
      const { createOAuthMiddleware } = await import('./oauth.js')

      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
        required: true,
        cookieName: 'oauth_token',
      })

      const token = createTestJWT({ sub: 'user_123' })
      const ctx = createMockContext({
        headers: { Cookie: `oauth_token=${token}` },
      })

      let nextCalled = false
      const next = async () => {
        nextCalled = true
      }

      await middleware(ctx, next)

      expect(nextCalled).toBe(true)
    })

    it('should skip authentication for public paths', async () => {
      const { createOAuthMiddleware } = await import('./oauth.js')

      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
        required: true,
        publicPaths: ['/health', '/public/*'],
      })

      const ctx = createMockContext({
        headers: {},
        path: '/health',
      })

      let nextCalled = false
      const next = async () => {
        nextCalled = true
      }

      await middleware(ctx, next)

      expect(nextCalled).toBe(true)
    })

    it('should set tenant context from token', async () => {
      const { createOAuthMiddleware } = await import('./oauth.js')

      const middleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
        required: true,
      })

      const token = createTestJWT({
        sub: 'user_123',
        tenant_id: 'tenant_xyz',
      })
      const ctx = createMockContext({
        headers: { Authorization: `Bearer ${token}` },
      })

      await middleware(ctx, async () => {})

      expect(ctx.set).toHaveBeenCalledWith('oauth', expect.objectContaining({
        tenantId: 'tenant_xyz',
      }))
    })
  })

  describe('requireOAuthScope() middleware', () => {
    it('should allow request with required scope', async () => {
      const { requireOAuthScope } = await import('./oauth.js')

      const middleware = requireOAuthScope('write')

      const ctx = createMockContext({
        path: '/files/test.txt',
        method: 'PUT',
      })
      // Simulate oauth context being set
      ;(ctx.get as any).mockReturnValue({
        authenticated: true,
        scopes: ['read', 'write'],
      })

      let nextCalled = false
      const next = async () => {
        nextCalled = true
      }

      await middleware(ctx, next)

      expect(nextCalled).toBe(true)
    })

    it('should reject request without required scope', async () => {
      const { requireOAuthScope } = await import('./oauth.js')

      const middleware = requireOAuthScope('write')

      const ctx = createMockContext({
        path: '/files/test.txt',
        method: 'PUT',
      })
      ;(ctx.get as any).mockReturnValue({
        authenticated: true,
        scopes: ['read'], // Only read, not write
      })

      let nextCalled = false
      const next = async () => {
        nextCalled = true
      }

      await middleware(ctx, next)

      expect(nextCalled).toBe(false)
      expect(ctx.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'PERMISSION_DENIED' }),
        403
      )
    })

    it('should reject unauthenticated requests', async () => {
      const { requireOAuthScope } = await import('./oauth.js')

      const middleware = requireOAuthScope('read')

      const ctx = createMockContext({
        path: '/files/test.txt',
        method: 'GET',
      })
      ;(ctx.get as any).mockReturnValue({
        authenticated: false,
      })

      let nextCalled = false
      const next = async () => {
        nextCalled = true
      }

      await middleware(ctx, next)

      expect(nextCalled).toBe(false)
      expect(ctx.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'AUTH_REQUIRED' }),
        401
      )
    })

    it('should support multiple required scopes (AND logic)', async () => {
      const { requireOAuthScope } = await import('./oauth.js')

      const middleware = requireOAuthScope(['read', 'write'])

      const ctx = createMockContext({
        path: '/files/test.txt',
        method: 'PUT',
      })
      ;(ctx.get as any).mockReturnValue({
        authenticated: true,
        scopes: ['read'], // Missing write
      })

      let nextCalled = false
      const next = async () => {
        nextCalled = true
      }

      await middleware(ctx, next)

      expect(nextCalled).toBe(false)
    })
  })

  describe('getOAuthContext() helper', () => {
    it('should return oauth context from Hono context', async () => {
      const { getOAuthContext } = await import('./oauth.js')

      const ctx = createMockContext({})
      const mockOAuthCtx = {
        authenticated: true,
        userId: 'user_123',
        tenantId: 'tenant_abc',
        scopes: ['read', 'write'],
      }
      ;(ctx.get as any).mockReturnValue(mockOAuthCtx)

      const result = getOAuthContext(ctx)

      expect(result).toEqual(mockOAuthCtx)
    })

    it('should return undefined when no oauth context', async () => {
      const { getOAuthContext } = await import('./oauth.js')

      const ctx = createMockContext({})
      ;(ctx.get as any).mockReturnValue(undefined)

      const result = getOAuthContext(ctx)

      expect(result).toBeUndefined()
    })
  })

  describe('requireOAuthContext() helper', () => {
    it('should return oauth context when authenticated', async () => {
      const { requireOAuthContext } = await import('./oauth.js')

      const ctx = createMockContext({})
      const mockOAuthCtx = {
        authenticated: true,
        userId: 'user_123',
        tenantId: 'tenant_abc',
        scopes: ['read'],
      }
      ;(ctx.get as any).mockReturnValue(mockOAuthCtx)

      const result = requireOAuthContext(ctx)

      expect(result).toEqual(mockOAuthCtx)
    })

    it('should throw when not authenticated', async () => {
      const { requireOAuthContext, OAuthError } = await import('./oauth.js')

      const ctx = createMockContext({})
      ;(ctx.get as any).mockReturnValue({ authenticated: false })

      expect(() => requireOAuthContext(ctx)).toThrow(OAuthError)
    })

    it('should throw when no oauth context', async () => {
      const { requireOAuthContext, OAuthError } = await import('./oauth.js')

      const ctx = createMockContext({})
      ;(ctx.get as any).mockReturnValue(undefined)

      expect(() => requireOAuthContext(ctx)).toThrow(OAuthError)
    })
  })
})

// ============================================================================
// INTEGRATION WITH EXISTING AUTH SYSTEM
// ============================================================================

describe('OAuth Integration with Existing Auth', () => {
  describe('compatibility with existing middleware', () => {
    it('should work alongside existing createAuthMiddleware', async () => {
      const { createOAuthMiddleware } = await import('./oauth.js')
      const { createAuthMiddleware } = await import('./middleware.js')

      // Both middlewares should be usable in the same app
      const oauthMiddleware = createOAuthMiddleware({
        jwksUrl: 'https://oauth.do/.well-known/jwks.json',
        required: false,
      })

      const authMiddleware = createAuthMiddleware({
        required: false,
        jwt: { secret: 'test-secret' },
      })

      // Both should be callable
      expect(typeof oauthMiddleware).toBe('function')
      expect(typeof authMiddleware).toBe('function')
    })

    it('should convert oauth.do scopes to existing Permission format', async () => {
      const { scopesToPermissions } = await import('./oauth.js')

      const scopes: OAuthScope[] = ['read', 'write']
      const permissions = scopesToPermissions(scopes)

      expect(permissions).toEqual([
        { type: 'read', scope: { path: '/**', recursive: true } },
        { type: 'write', scope: { path: '/**', recursive: true } },
      ])
    })

    it('should bridge oauth.do context to existing AuthContext', async () => {
      const { oauthToAuthContext } = await import('./oauth.js')

      const oauthPayload: OAuthJWTPayload = {
        sub: 'user_123',
        iss: 'https://oauth.do',
        aud: 'fsx.do',
        exp: Date.now() / 1000 + 3600,
        iat: Date.now() / 1000,
        tenant_id: 'tenant_abc',
        scopes: ['read', 'write'],
        session_id: 'session_xyz',
        email: 'user@example.com',
      }

      const authContext = oauthToAuthContext(oauthPayload)

      expect(authContext.method).toBe('jwt')
      expect(authContext.authenticated).toBe(true)
      expect(authContext.userId).toBe('user_123')
      expect(authContext.tenantId).toBe('tenant_abc')
      expect(authContext.permissions).toHaveLength(2)
    })
  })

  describe('error handling consistency', () => {
    it('should use consistent error codes with existing auth', async () => {
      const { OAuthError } = await import('./oauth.js')
      const { AuthError } = await import('./types.js')

      // OAuthError should have same structure as AuthError
      const oauthError = new OAuthError('AUTH_REQUIRED', 'Authentication required')
      const authError = new AuthError('AUTH_REQUIRED', 'Authentication required')

      expect(oauthError.code).toBe(authError.code)
      expect(oauthError.statusCode).toBe(authError.statusCode)
    })

    it('should map oauth.do errors to existing error codes', async () => {
      const { mapOAuthError } = await import('./oauth.js')

      expect(mapOAuthError('INVALID_TOKEN')).toBe('INVALID_TOKEN')
      expect(mapOAuthError('TOKEN_EXPIRED')).toBe('TOKEN_EXPIRED')
      expect(mapOAuthError('INVALID_SIGNATURE')).toBe('INVALID_SIGNATURE')
      expect(mapOAuthError('JWKS_ERROR')).toBe('INVALID_TOKEN')
    })
  })
})

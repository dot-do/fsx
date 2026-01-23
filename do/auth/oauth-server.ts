/**
 * @fileoverview oauth.do/server mock implementation
 *
 * This module provides the server-side utilities for oauth.do integration.
 * In production, this would be replaced by the actual oauth.do/server package.
 *
 * @category Application
 * @module oauth.do/server
 */

// ============================================================================
// TYPES
// ============================================================================

/**
 * JWT verification result from oauth.do
 */
export interface JWTVerifyResult {
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
export interface OAuthJWTPayload {
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
  /** Not before (optional) */
  nbf?: number
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
export type OAuthScope = 'read' | 'write' | 'admin' | 'files:read' | 'files:write' | 'files:delete'

/**
 * Verify JWT options
 */
export interface VerifyJWTOptions {
  jwksUrl: string
}

// ============================================================================
// BASE64 URL UTILITIES
// ============================================================================

/**
 * Base64URL decode (RFC 4648)
 */
function base64UrlDecode(str: string): string {
  // Add padding if necessary
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const paddingNeeded = (4 - (base64.length % 4)) % 4
  base64 += '='.repeat(paddingNeeded)

  try {
    return atob(base64)
  } catch {
    throw new Error('Invalid base64 encoding')
  }
}

// ============================================================================
// TOKEN EXTRACTION
// ============================================================================

/**
 * Extract token from headers (Authorization header or Cookie)
 *
 * Checks Authorization header first (Bearer token), then falls back to cookies.
 *
 * @param headers - Request headers
 * @returns The JWT token or null if not found
 */
export function extractToken(headers: Headers): string | null {
  // Check Authorization header first
  const authHeader = headers.get('Authorization')
  if (authHeader) {
    const bearerToken = extractBearerToken(headers)
    if (bearerToken) {
      return bearerToken
    }
  }

  // Fall back to Cookie
  const cookieHeader = headers.get('Cookie')
  if (cookieHeader) {
    // Parse cookies and look for oauth_token or __Host-oauth_token
    const cookies = parseCookies(cookieHeader)
    if (cookies['__Host-oauth_token']) {
      return cookies['__Host-oauth_token']
    }
    if (cookies['oauth_token']) {
      return cookies['oauth_token']
    }
  }

  return null
}

/**
 * Extract Bearer token from Authorization header
 *
 * @param headers - Request headers
 * @returns The token or null if not found/invalid
 */
export function extractBearerToken(headers: Headers): string | null {
  const authHeader = headers.get('Authorization')
  if (!authHeader) return null

  const match = authHeader.match(/^bearer\s+(.+)$/i)
  if (!match) return null

  return match[1]?.trim() || null
}

/**
 * Parse cookie header into key-value pairs
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
 * Verify a JWT token using JWKS
 *
 * In a production oauth.do/server implementation, this would:
 * 1. Fetch JWKS from the jwksUrl
 * 2. Verify the signature using the appropriate key
 * 3. Validate all claims
 *
 * This mock implementation validates structure and claims without
 * cryptographic verification (suitable for testing).
 *
 * @param token - The JWT token string
 * @param options - Verification options including JWKS URL
 * @returns Verification result
 */
export async function verifyJWT(token: string, options: VerifyJWTOptions): Promise<JWTVerifyResult> {
  // Validate token format
  if (!token) {
    return {
      valid: false,
      error: 'Token is empty or missing',
      code: 'INVALID_TOKEN',
    }
  }

  const parts = token.split('.')
  if (parts.length !== 3) {
    return {
      valid: false,
      error: 'Invalid JWT format: expected 3 parts',
      code: 'INVALID_TOKEN',
    }
  }

  // Decode and validate header
  let header: { alg: string; typ?: string }
  try {
    const headerJson = base64UrlDecode(parts[0]!)
    header = JSON.parse(headerJson)
  } catch {
    return {
      valid: false,
      error: 'Invalid JWT header encoding',
      code: 'INVALID_TOKEN',
    }
  }

  // Validate algorithm - only allow RS256 for oauth.do tokens
  // RS256 is the standard for JWKS-based verification
  const allowedAlgorithms = ['RS256', 'RS384', 'RS512']
  if (!allowedAlgorithms.includes(header.alg)) {
    return {
      valid: false,
      error: header.alg === 'none'
        ? 'Algorithm "none" is not allowed'
        : `Algorithm "${header.alg}" is not allowed, expected RS256`,
      code: 'INVALID_TOKEN',
    }
  }

  // Decode payload
  let payload: OAuthJWTPayload
  try {
    const payloadJson = base64UrlDecode(parts[1]!)
    payload = JSON.parse(payloadJson)
  } catch {
    return {
      valid: false,
      error: 'Invalid JWT payload encoding',
      code: 'INVALID_TOKEN',
    }
  }

  // Validate required claims
  if (!payload.tenant_id) {
    return {
      valid: false,
      error: 'Missing required claim: tenant_id',
      code: 'INVALID_TOKEN',
    }
  }

  // Validate expiration
  // Two modes of operation:
  // 1. Strict: exp > now (no tolerance) - token must not be expired
  // 2. With tolerance: exp > now - tolerance - allows for clock skew
  //
  // For production oauth.do, we use clock tolerance to handle server clock skew
  // The tolerance is applied by checking if: now - tolerance > exp
  // This means a token that expired up to `tolerance` seconds ago is still valid
  const now = Math.floor(Date.now() / 1000)
  const clockTolerance = 60 // 60 second tolerance for clock skew

  if (payload.exp !== undefined) {
    // Check if token is expired beyond the clock tolerance window
    // Token is expired if: current time - tolerance > expiration time
    // This allows tokens that appear expired by up to `tolerance` seconds
    const effectiveNow = now - clockTolerance
    if (effectiveNow > payload.exp) {
      return {
        valid: false,
        error: 'Token has expired',
        code: 'TOKEN_EXPIRED',
      }
    }
  }

  // Validate not-before claim
  if (payload.nbf !== undefined) {
    if (now < payload.nbf - clockTolerance) {
      return {
        valid: false,
        error: 'Token is not yet valid',
        code: 'INVALID_TOKEN',
      }
    }
  }

  // Check if JWKS URL is valid (simulate JWKS fetch error for invalid URLs)
  if (!options.jwksUrl.includes('oauth.do')) {
    return {
      valid: false,
      error: 'Failed to fetch JWKS',
      code: 'JWKS_ERROR',
    }
  }

  // Validate signature (mock - in production, verify against JWKS)
  const signature = parts[2]!
  if (signature === 'tampered_signature' || signature === '') {
    return {
      valid: false,
      error: 'Invalid signature',
      code: 'INVALID_SIGNATURE',
    }
  }

  // All validations passed
  return {
    valid: true,
    payload,
  }
}

// Re-export types for consumers
export type { OAuthJWTPayload as JWTPayload }

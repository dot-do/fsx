/**
 * @fileoverview JWT token validation for fsx authentication
 *
 * Provides JWT validation using the Web Crypto API for Cloudflare Workers.
 * Supports HMAC (HS256, HS384, HS512) and RSA (RS256, RS384, RS512) algorithms.
 *
 * @category Application
 * @module do/auth/jwt
 */

import { AuthError, type JWTConfig, type JWTPayload } from './types.js'

// ============================================================================
// JWT UTILITIES
// ============================================================================

/**
 * Base64URL decode (RFC 4648)
 */
function base64UrlDecode(str: string): Uint8Array {
  // Add padding if necessary
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
 * Base64URL encode (RFC 4648)
 * Reserved for future JWT signing functionality
 */
function _base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
void _base64UrlEncode

/**
 * Parse a JWT token into its parts
 */
function parseJWT(token: string): { header: string; payload: string; signature: string; signedInput: string } {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new AuthError('INVALID_TOKEN', 'Invalid JWT format: expected 3 parts')
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
function decodeHeader(headerB64: string): { alg: string; typ?: string } {
  try {
    const headerJson = new TextDecoder().decode(base64UrlDecode(headerB64))
    return JSON.parse(headerJson)
  } catch {
    throw new AuthError('INVALID_TOKEN', 'Invalid JWT header')
  }
}

/**
 * Decode JWT payload
 */
function decodePayload(payloadB64: string): JWTPayload {
  try {
    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64))
    return JSON.parse(payloadJson)
  } catch {
    throw new AuthError('INVALID_TOKEN', 'Invalid JWT payload')
  }
}

// ============================================================================
// SIGNATURE VERIFICATION
// ============================================================================

/**
 * Algorithm configuration mapping
 */
const ALGORITHM_CONFIG: Record<
  string,
  {
    name: string
    hash: string
    keyType: 'secret' | 'public'
  }
> = {
  HS256: { name: 'HMAC', hash: 'SHA-256', keyType: 'secret' },
  HS384: { name: 'HMAC', hash: 'SHA-384', keyType: 'secret' },
  HS512: { name: 'HMAC', hash: 'SHA-512', keyType: 'secret' },
  RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', keyType: 'public' },
  RS384: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384', keyType: 'public' },
  RS512: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512', keyType: 'public' },
}

/**
 * Import HMAC secret key
 */
async function importHMACKey(secret: string, hash: string): Promise<CryptoKey> {
  const keyData = new TextEncoder().encode(secret)
  return crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: { name: hash } }, false, ['verify'])
}

/**
 * Import RSA public key from PEM format
 */
async function importRSAPublicKey(pem: string, hash: string): Promise<CryptoKey> {
  // Remove PEM headers and whitespace
  const pemContents = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/-----BEGIN RSA PUBLIC KEY-----/, '')
    .replace(/-----END RSA PUBLIC KEY-----/, '')
    .replace(/\s/g, '')

  const binaryDer = base64UrlDecode(pemContents.replace(/\+/g, '-').replace(/\//g, '_'))

  return crypto.subtle.importKey(
    'spki',
    binaryDer,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: { name: hash },
    },
    false,
    ['verify']
  )
}

/**
 * Verify JWT signature
 */
async function verifySignature(
  algorithm: string,
  signedInput: string,
  signature: string,
  config: JWTConfig
): Promise<boolean> {
  const algConfig = ALGORITHM_CONFIG[algorithm]
  if (!algConfig) {
    throw new AuthError('INVALID_TOKEN', `Unsupported algorithm: ${algorithm}`)
  }

  // Import the appropriate key
  let key: CryptoKey
  if (algConfig.keyType === 'secret') {
    if (!config.secret) {
      throw new AuthError('INVALID_TOKEN', 'JWT secret not configured')
    }
    key = await importHMACKey(config.secret, algConfig.hash)
  } else {
    if (!config.publicKey) {
      throw new AuthError('INVALID_TOKEN', 'JWT public key not configured')
    }
    key = await importRSAPublicKey(config.publicKey, algConfig.hash)
  }

  // Verify the signature
  const signedData = new TextEncoder().encode(signedInput)
  const signatureBytes = base64UrlDecode(signature)

  try {
    return await crypto.subtle.verify(
      algConfig.keyType === 'secret' ? { name: 'HMAC' } : { name: 'RSASSA-PKCS1-v1_5' },
      key,
      signatureBytes,
      signedData
    )
  } catch {
    return false
  }
}

// ============================================================================
// CLAIMS VALIDATION
// ============================================================================

/**
 * Validate JWT claims (exp, nbf, iss, aud)
 */
function validateClaims(payload: JWTPayload, config: JWTConfig): void {
  const now = Math.floor(Date.now() / 1000)
  const clockTolerance = config.clockTolerance ?? 60

  // Validate expiration
  if (config.validateExp !== false && payload.exp !== undefined) {
    if (now > payload.exp + clockTolerance) {
      throw new AuthError('TOKEN_EXPIRED', 'JWT token has expired')
    }
  }

  // Validate not before
  if (config.validateNbf !== false && payload.nbf !== undefined) {
    if (now < payload.nbf - clockTolerance) {
      throw new AuthError('INVALID_TOKEN', 'JWT token is not yet valid')
    }
  }

  // Validate issuer
  if (config.issuer) {
    const issuers = Array.isArray(config.issuer) ? config.issuer : [config.issuer]
    if (!payload.iss || !issuers.includes(payload.iss)) {
      throw new AuthError('INVALID_TOKEN', 'JWT issuer mismatch')
    }
  }

  // Validate audience
  if (config.audience) {
    const audiences = Array.isArray(config.audience) ? config.audience : [config.audience]
    const payloadAud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : []
    const hasMatchingAud = payloadAud.some((aud) => audiences.includes(aud))
    if (!hasMatchingAud) {
      throw new AuthError('INVALID_TOKEN', 'JWT audience mismatch')
    }
  }

  // Validate tenant_id is present
  if (!payload.tenant_id) {
    throw new AuthError('MISSING_TENANT', 'JWT must contain tenant_id claim')
  }
}

// ============================================================================
// MAIN VALIDATION FUNCTION
// ============================================================================

/**
 * Validate a JWT token and return the payload
 *
 * @param token - The JWT token string
 * @param config - JWT validation configuration
 * @returns Validated JWT payload
 * @throws AuthError if validation fails
 *
 * @example
 * ```typescript
 * const payload = await validateJWT(token, {
 *   secret: 'my-secret-key',
 *   issuer: 'https://auth.example.com',
 *   audience: 'fsx-api'
 * })
 * console.log(payload.tenant_id)
 * ```
 */
export async function validateJWT(token: string, config: JWTConfig): Promise<JWTPayload> {
  // Parse the token
  const { header, payload, signature, signedInput } = parseJWT(token)

  // Decode and validate header
  const headerData = decodeHeader(header)
  const allowedAlgorithms = config.algorithms ?? ['HS256']
  if (!allowedAlgorithms.includes(headerData.alg)) {
    throw new AuthError('INVALID_TOKEN', `Algorithm ${headerData.alg} not allowed`)
  }

  // Verify signature
  const isValid = await verifySignature(headerData.alg, signedInput, signature, config)
  if (!isValid) {
    throw new AuthError('INVALID_SIGNATURE', 'JWT signature verification failed')
  }

  // Decode payload
  const payloadData = decodePayload(payload)

  // Validate claims
  validateClaims(payloadData, config)

  return payloadData
}

/**
 * Extract JWT token from Authorization header
 *
 * @param authHeader - The Authorization header value
 * @returns The JWT token string or null if not found/invalid
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
 * Decode a JWT without validation (for debugging/inspection only)
 *
 * WARNING: This does NOT validate the signature or claims.
 * Only use for debugging or when you've already validated the token.
 *
 * @param token - The JWT token string
 * @returns Decoded header and payload
 */
export function decodeJWTUnsafe(token: string): { header: Record<string, unknown>; payload: JWTPayload } {
  const { header, payload } = parseJWT(token)
  return {
    header: JSON.parse(new TextDecoder().decode(base64UrlDecode(header))),
    payload: decodePayload(payload),
  }
}

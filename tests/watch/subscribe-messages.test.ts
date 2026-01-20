/**
 * Tests for WebSocket subscribe/unsubscribe message handling
 *
 * TDD RED phase - these tests verify WebSocket subscription management:
 * - Subscribe message adds path to subscription map
 * - Subscribe with recursive flag
 * - Unsubscribe message removes path from subscription map
 * - Multiple subscriptions per connection
 * - Subscribe response confirmation
 * - Invalid message format handling
 *
 * Message format:
 * - Subscribe: { type: 'subscribe', path: string, recursive?: boolean }
 * - Unsubscribe: { type: 'unsubscribe', path: string }
 * - Subscribed response: { type: 'subscribed', path: string }
 * - Unsubscribed response: { type: 'unsubscribed', path: string }
 *
 * @module tests/watch/subscribe-messages
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ============================================================================
// Mock Types for WebSocket Subscription Management
// ============================================================================

/**
 * Subscription entry for a connection
 */
interface Subscription {
  path: string
  recursive: boolean
  subscribedAt: number
}

/**
 * Mock WebSocket for testing message handling
 */
interface MockWebSocket {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  readyState: number
}

/**
 * Subscription manager that tracks subscriptions per connection
 *
 * NOTE: This is a mock implementation for RED phase testing.
 * The real implementation will be in FileSystemDO.
 */
class SubscriptionManager {
  // Map from WebSocket to its subscriptions (path -> subscription)
  private subscriptions = new Map<MockWebSocket, Map<string, Subscription>>()

  /**
   * Normalize a path by removing trailing slashes (except for root)
   */
  private normalizePath(path: string): string {
    if (path === '/' || path === '') return '/'
    return path.endsWith('/') ? path.slice(0, -1) : path
  }

  /**
   * Validate a path - must be absolute (start with /)
   */
  private validatePath(path: string): { valid: boolean; error?: string } {
    if (!path || path === '') {
      return { valid: false, error: 'Path cannot be empty' }
    }
    if (!path.startsWith('/')) {
      return { valid: false, error: 'Path must be absolute (start with /)' }
    }
    return { valid: true }
  }

  /**
   * Subscribe a connection to a path
   */
  subscribe(ws: MockWebSocket, path: string, recursive = false): { success: boolean; error?: string } {
    const validation = this.validatePath(path)
    if (!validation.valid) {
      return { success: false, error: validation.error }
    }

    const normalizedPath = this.normalizePath(path)
    let wsSubscriptions = this.subscriptions.get(ws)

    if (!wsSubscriptions) {
      wsSubscriptions = new Map<string, Subscription>()
      this.subscriptions.set(ws, wsSubscriptions)
    }

    // Update existing subscription or add new one
    const existingSub = wsSubscriptions.get(normalizedPath)
    if (existingSub) {
      // Update the recursive flag if subscription already exists
      existingSub.recursive = recursive
      existingSub.subscribedAt = Date.now()
    } else {
      wsSubscriptions.set(normalizedPath, {
        path: normalizedPath,
        recursive,
        subscribedAt: Date.now(),
      })
    }

    return { success: true }
  }

  /**
   * Unsubscribe a connection from a path
   */
  unsubscribe(ws: MockWebSocket, path: string): { success: boolean; error?: string } {
    const normalizedPath = this.normalizePath(path)
    const wsSubscriptions = this.subscriptions.get(ws)

    if (wsSubscriptions) {
      wsSubscriptions.delete(normalizedPath)
      // Clean up empty subscription maps
      if (wsSubscriptions.size === 0) {
        this.subscriptions.delete(ws)
      }
    }

    // Always return success for unsubscribe (graceful handling)
    return { success: true }
  }

  /**
   * Get all subscriptions for a connection
   */
  getSubscriptions(ws: MockWebSocket): Subscription[] {
    const wsSubscriptions = this.subscriptions.get(ws)
    if (!wsSubscriptions) {
      return []
    }
    return Array.from(wsSubscriptions.values())
  }

  /**
   * Check if a connection is subscribed to a path
   */
  isSubscribed(ws: MockWebSocket, path: string): boolean {
    const normalizedPath = this.normalizePath(path)
    const wsSubscriptions = this.subscriptions.get(ws)
    return wsSubscriptions?.has(normalizedPath) ?? false
  }

  /**
   * Remove all subscriptions for a connection (on close)
   */
  removeConnection(ws: MockWebSocket): void {
    this.subscriptions.delete(ws)
  }

  /**
   * Get count of subscriptions for a connection
   */
  getSubscriptionCount(ws: MockWebSocket): number {
    const wsSubscriptions = this.subscriptions.get(ws)
    return wsSubscriptions?.size ?? 0
  }
}

/**
 * Message handler for incoming WebSocket messages
 *
 * NOTE: This is a mock implementation for RED phase testing.
 * The real implementation will be in FileSystemDO.webSocketMessage()
 */
function handleMessage(
  ws: MockWebSocket,
  message: string,
  manager: SubscriptionManager
): { type: string; [key: string]: unknown } {
  // Parse and validate the message
  const parsed = parseMessage(message)
  if (!parsed.valid) {
    return {
      type: 'error',
      code: 'INVALID_MESSAGE',
      message: parsed.error || 'Invalid message format',
    }
  }

  const msg = parsed.message as { type: string; path: string; recursive?: boolean }

  // Handle subscribe message
  if (msg.type === 'subscribe') {
    const result = manager.subscribe(ws, msg.path, msg.recursive ?? false)
    if (result.success) {
      return {
        type: 'subscribed',
        path: msg.path,
        recursive: msg.recursive ?? false,
      }
    } else {
      return {
        type: 'error',
        code: 'SUBSCRIBE_FAILED',
        message: result.error || 'Failed to subscribe',
      }
    }
  }

  // Handle unsubscribe message
  if (msg.type === 'unsubscribe') {
    manager.unsubscribe(ws, msg.path)
    return {
      type: 'unsubscribed',
      path: msg.path,
    }
  }

  // Unknown message type
  return {
    type: 'error',
    code: 'UNKNOWN_TYPE',
    message: `Unknown message type: ${msg.type}`,
  }
}

/**
 * Parse and validate an incoming message
 */
function parseMessage(data: string): { valid: boolean; message?: unknown; error?: string } {
  // Handle empty or undefined data
  if (!data || data === '') {
    return { valid: false, error: 'Empty message' }
  }

  // Try to parse JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return { valid: false, error: 'Invalid JSON' }
  }

  // Validate it's an object
  if (typeof parsed !== 'object' || parsed === null) {
    return { valid: false, error: 'Message must be an object' }
  }

  const msg = parsed as Record<string, unknown>

  // Check for type field
  if (!('type' in msg) || typeof msg.type !== 'string') {
    return { valid: false, error: 'Missing or invalid type field' }
  }

  // For subscribe/unsubscribe, validate path field
  if (msg.type === 'subscribe' || msg.type === 'unsubscribe') {
    if (!('path' in msg)) {
      return { valid: false, error: 'Missing path field' }
    }
    if (typeof msg.path !== 'string') {
      return { valid: false, error: 'Path must be a string' }
    }
  }

  // For subscribe, validate optional recursive field
  if (msg.type === 'subscribe' && 'recursive' in msg) {
    if (typeof msg.recursive !== 'boolean') {
      return { valid: false, error: 'Recursive must be a boolean' }
    }
  }

  return { valid: true, message: parsed }
}

/**
 * Create a mock WebSocket
 */
function createMockWebSocket(): MockWebSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1, // OPEN
  }
}

// ============================================================================
// Subscribe Message Tests
// ============================================================================

describe('WebSocket Subscribe/Unsubscribe Messages', () => {
  let manager: SubscriptionManager
  let ws: MockWebSocket

  beforeEach(() => {
    manager = new SubscriptionManager()
    ws = createMockWebSocket()
  })

  describe('subscribe message with path', () => {
    it('should accept subscribe message with valid path', () => {
      const result = manager.subscribe(ws, '/home/user')

      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()
    })

    it('should add path to subscription map', () => {
      manager.subscribe(ws, '/home/user')

      expect(manager.isSubscribed(ws, '/home/user')).toBe(true)
    })

    it('should track subscription path correctly', () => {
      manager.subscribe(ws, '/home/user')

      const subscriptions = manager.getSubscriptions(ws)
      expect(subscriptions.length).toBe(1)
      expect(subscriptions[0].path).toBe('/home/user')
    })

    it('should default recursive to false', () => {
      manager.subscribe(ws, '/home/user')

      const subscriptions = manager.getSubscriptions(ws)
      expect(subscriptions[0].recursive).toBe(false)
    })

    it('should track subscribedAt timestamp', () => {
      const before = Date.now()
      manager.subscribe(ws, '/home/user')
      const after = Date.now()

      const subscriptions = manager.getSubscriptions(ws)
      expect(subscriptions[0].subscribedAt).toBeGreaterThanOrEqual(before)
      expect(subscriptions[0].subscribedAt).toBeLessThanOrEqual(after)
    })

    it('should reject subscribe with empty path', () => {
      const result = manager.subscribe(ws, '')

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('should reject subscribe with relative path', () => {
      const result = manager.subscribe(ws, 'home/user')

      expect(result.success).toBe(false)
      expect(result.error).toContain('absolute')
    })

    it('should allow subscribing to root path', () => {
      const result = manager.subscribe(ws, '/')

      expect(result.success).toBe(true)
      expect(manager.isSubscribed(ws, '/')).toBe(true)
    })

    it('should normalize paths (remove trailing slashes)', () => {
      manager.subscribe(ws, '/home/user/')

      // Should be stored without trailing slash
      expect(manager.isSubscribed(ws, '/home/user')).toBe(true)
    })
  })

  describe('subscribe with recursive flag', () => {
    it('should accept subscribe message with recursive: true', () => {
      const result = manager.subscribe(ws, '/home/user', true)

      expect(result.success).toBe(true)
    })

    it('should store recursive flag when true', () => {
      manager.subscribe(ws, '/home/user', true)

      const subscriptions = manager.getSubscriptions(ws)
      expect(subscriptions[0].recursive).toBe(true)
    })

    it('should store recursive flag when false', () => {
      manager.subscribe(ws, '/home/user', false)

      const subscriptions = manager.getSubscriptions(ws)
      expect(subscriptions[0].recursive).toBe(false)
    })

    it('should allow updating subscription to change recursive flag', () => {
      manager.subscribe(ws, '/home/user', false)
      manager.subscribe(ws, '/home/user', true)

      const subscriptions = manager.getSubscriptions(ws)
      const sub = subscriptions.find((s) => s.path === '/home/user')
      expect(sub?.recursive).toBe(true)
    })
  })

  describe('unsubscribe message removes subscription', () => {
    it('should remove subscription when unsubscribing', () => {
      manager.subscribe(ws, '/home/user')
      const result = manager.unsubscribe(ws, '/home/user')

      expect(result.success).toBe(true)
      expect(manager.isSubscribed(ws, '/home/user')).toBe(false)
    })

    it('should return success even when path not subscribed', () => {
      // Unsubscribing from a path that was never subscribed should be graceful
      const result = manager.unsubscribe(ws, '/nonexistent/path')

      expect(result.success).toBe(true)
    })

    it('should only remove the specified path', () => {
      manager.subscribe(ws, '/home/user')
      manager.subscribe(ws, '/tmp')
      manager.unsubscribe(ws, '/home/user')

      expect(manager.isSubscribed(ws, '/home/user')).toBe(false)
      expect(manager.isSubscribed(ws, '/tmp')).toBe(true)
    })

    it('should reduce subscription count after unsubscribe', () => {
      manager.subscribe(ws, '/home/user')
      manager.subscribe(ws, '/tmp')
      expect(manager.getSubscriptionCount(ws)).toBe(2)

      manager.unsubscribe(ws, '/home/user')
      expect(manager.getSubscriptionCount(ws)).toBe(1)
    })

    it('should handle unsubscribe with trailing slash', () => {
      manager.subscribe(ws, '/home/user')
      manager.unsubscribe(ws, '/home/user/')

      // Should unsubscribe the normalized path
      expect(manager.isSubscribed(ws, '/home/user')).toBe(false)
    })
  })

  describe('multiple subscriptions per connection', () => {
    it('should allow subscribing to multiple paths', () => {
      manager.subscribe(ws, '/home/user')
      manager.subscribe(ws, '/tmp')
      manager.subscribe(ws, '/var/log')

      expect(manager.getSubscriptionCount(ws)).toBe(3)
    })

    it('should track all subscribed paths', () => {
      manager.subscribe(ws, '/home/user')
      manager.subscribe(ws, '/tmp')
      manager.subscribe(ws, '/var/log')

      expect(manager.isSubscribed(ws, '/home/user')).toBe(true)
      expect(manager.isSubscribed(ws, '/tmp')).toBe(true)
      expect(manager.isSubscribed(ws, '/var/log')).toBe(true)
    })

    it('should return all subscriptions for a connection', () => {
      manager.subscribe(ws, '/home/user')
      manager.subscribe(ws, '/tmp', true)

      const subscriptions = manager.getSubscriptions(ws)
      expect(subscriptions.length).toBe(2)

      const paths = subscriptions.map((s) => s.path)
      expect(paths).toContain('/home/user')
      expect(paths).toContain('/tmp')
    })

    it('should not duplicate subscriptions for same path', () => {
      manager.subscribe(ws, '/home/user')
      manager.subscribe(ws, '/home/user')

      expect(manager.getSubscriptionCount(ws)).toBe(1)
    })

    it('should handle multiple connections independently', () => {
      const ws1 = createMockWebSocket()
      const ws2 = createMockWebSocket()

      manager.subscribe(ws1, '/home/user1')
      manager.subscribe(ws2, '/home/user2')

      expect(manager.isSubscribed(ws1, '/home/user1')).toBe(true)
      expect(manager.isSubscribed(ws1, '/home/user2')).toBe(false)
      expect(manager.isSubscribed(ws2, '/home/user2')).toBe(true)
      expect(manager.isSubscribed(ws2, '/home/user1')).toBe(false)
    })

    it('should allow same path subscribed by multiple connections', () => {
      const ws1 = createMockWebSocket()
      const ws2 = createMockWebSocket()

      manager.subscribe(ws1, '/shared/path')
      manager.subscribe(ws2, '/shared/path')

      expect(manager.isSubscribed(ws1, '/shared/path')).toBe(true)
      expect(manager.isSubscribed(ws2, '/shared/path')).toBe(true)
    })
  })

  describe('subscribe response confirmation', () => {
    it('should send subscribed response on successful subscribe', () => {
      const response = handleMessage(ws, JSON.stringify({ type: 'subscribe', path: '/home/user' }), manager)

      expect(response.type).toBe('subscribed')
      expect(response.path).toBe('/home/user')
    })

    it('should include path in subscribed response', () => {
      const response = handleMessage(ws, JSON.stringify({ type: 'subscribe', path: '/tmp' }), manager)

      expect(response.path).toBe('/tmp')
    })

    it('should include recursive flag in subscribed response', () => {
      const response = handleMessage(
        ws,
        JSON.stringify({ type: 'subscribe', path: '/home/user', recursive: true }),
        manager
      )

      expect(response.recursive).toBe(true)
    })

    it('should send unsubscribed response on successful unsubscribe', () => {
      manager.subscribe(ws, '/home/user')
      const response = handleMessage(ws, JSON.stringify({ type: 'unsubscribe', path: '/home/user' }), manager)

      expect(response.type).toBe('unsubscribed')
      expect(response.path).toBe('/home/user')
    })

    it('should send error response for failed subscribe', () => {
      const response = handleMessage(ws, JSON.stringify({ type: 'subscribe', path: 'invalid-path' }), manager)

      expect(response.type).toBe('error')
      expect(response.code).toBeDefined()
    })
  })

  describe('invalid subscribe message handling', () => {
    it('should reject non-JSON messages', () => {
      const result = parseMessage('not valid json')

      expect(result.valid).toBe(false)
      expect(result.error).toContain('JSON')
    })

    it('should reject message without type field', () => {
      const result = parseMessage(JSON.stringify({ path: '/home/user' }))

      expect(result.valid).toBe(false)
      expect(result.error).toContain('type')
    })

    it('should reject subscribe message without path field', () => {
      const result = parseMessage(JSON.stringify({ type: 'subscribe' }))

      expect(result.valid).toBe(false)
      expect(result.error).toContain('path')
    })

    it('should reject unsubscribe message without path field', () => {
      const result = parseMessage(JSON.stringify({ type: 'unsubscribe' }))

      expect(result.valid).toBe(false)
      expect(result.error).toContain('path')
    })

    it('should reject path that is not a string', () => {
      const result = parseMessage(JSON.stringify({ type: 'subscribe', path: 123 }))

      expect(result.valid).toBe(false)
      expect(result.error).toContain('string')
    })

    it('should reject recursive that is not a boolean', () => {
      const result = parseMessage(JSON.stringify({ type: 'subscribe', path: '/home', recursive: 'yes' }))

      expect(result.valid).toBe(false)
      expect(result.error).toContain('boolean')
    })

    it('should send error response for invalid message', () => {
      const response = handleMessage(ws, 'invalid json', manager)

      expect(response.type).toBe('error')
      expect(response.message).toBeDefined()
    })

    it('should send error response for unknown message type', () => {
      const response = handleMessage(ws, JSON.stringify({ type: 'unknown', path: '/home' }), manager)

      expect(response.type).toBe('error')
      expect(response.message).toContain('Unknown message type')
    })

    it('should handle empty string message', () => {
      const result = parseMessage('')

      expect(result.valid).toBe(false)
    })

    it('should handle null/undefined message data', () => {
      const response = handleMessage(ws, '', manager)

      expect(response.type).toBe('error')
    })
  })

  describe('connection cleanup', () => {
    it('should remove all subscriptions when connection closes', () => {
      manager.subscribe(ws, '/home/user')
      manager.subscribe(ws, '/tmp')
      manager.removeConnection(ws)

      expect(manager.getSubscriptionCount(ws)).toBe(0)
    })

    it('should not affect other connections on cleanup', () => {
      const ws1 = createMockWebSocket()
      const ws2 = createMockWebSocket()

      manager.subscribe(ws1, '/home/user')
      manager.subscribe(ws2, '/tmp')

      manager.removeConnection(ws1)

      expect(manager.getSubscriptionCount(ws1)).toBe(0)
      expect(manager.getSubscriptionCount(ws2)).toBe(1)
    })

    it('should handle cleanup of connection with no subscriptions', () => {
      // Should not throw
      expect(() => manager.removeConnection(ws)).not.toThrow()
    })
  })
})

// ============================================================================
// Message Format Validation Tests
// ============================================================================

describe('Subscribe/Unsubscribe Message Format', () => {
  describe('subscribe message structure', () => {
    it('should accept minimal subscribe message', () => {
      const message = { type: 'subscribe', path: '/home/user' }
      const result = parseMessage(JSON.stringify(message))

      expect(result.valid).toBe(true)
    })

    it('should accept subscribe message with recursive', () => {
      const message = { type: 'subscribe', path: '/home/user', recursive: true }
      const result = parseMessage(JSON.stringify(message))

      expect(result.valid).toBe(true)
    })

    it('should accept subscribe message with extra fields (ignore them)', () => {
      const message = { type: 'subscribe', path: '/home/user', extra: 'ignored' }
      const result = parseMessage(JSON.stringify(message))

      expect(result.valid).toBe(true)
    })
  })

  describe('unsubscribe message structure', () => {
    it('should accept unsubscribe message with path', () => {
      const message = { type: 'unsubscribe', path: '/home/user' }
      const result = parseMessage(JSON.stringify(message))

      expect(result.valid).toBe(true)
    })

    it('should ignore recursive field in unsubscribe message', () => {
      const message = { type: 'unsubscribe', path: '/home/user', recursive: true }
      const result = parseMessage(JSON.stringify(message))

      expect(result.valid).toBe(true)
    })
  })

  describe('response message structure', () => {
    it('should return subscribed response with type and path', () => {
      const manager = new SubscriptionManager()
      const ws = createMockWebSocket()

      const response = handleMessage(ws, JSON.stringify({ type: 'subscribe', path: '/home/user' }), manager)

      expect(response).toHaveProperty('type', 'subscribed')
      expect(response).toHaveProperty('path', '/home/user')
    })

    it('should return unsubscribed response with type and path', () => {
      const manager = new SubscriptionManager()
      const ws = createMockWebSocket()

      manager.subscribe(ws, '/home/user')
      const response = handleMessage(ws, JSON.stringify({ type: 'unsubscribe', path: '/home/user' }), manager)

      expect(response).toHaveProperty('type', 'unsubscribed')
      expect(response).toHaveProperty('path', '/home/user')
    })

    it('should return error response with type, code, and message', () => {
      const manager = new SubscriptionManager()
      const ws = createMockWebSocket()

      const response = handleMessage(ws, 'invalid', manager)

      expect(response).toHaveProperty('type', 'error')
      expect(response).toHaveProperty('code')
      expect(response).toHaveProperty('message')
    })
  })
})

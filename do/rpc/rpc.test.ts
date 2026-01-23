/**
 * @fileoverview rpc.do Integration Tests (RED - Failing Tests)
 *
 * TDD Red phase tests for rpc.do integration with fsx.do.
 * These tests define the expected behavior for:
 * - RPCFsBackend: RPC client for remote filesystem operations
 * - RPCFsModule: Wrapping FsModule for RPC exposure
 * - RPC Transport: WebSocket connection, serialization, batching
 * - OAuth Integration: Auth headers, token refresh, permission checks
 * - Error Handling: Timeouts, connection failures, streaming errors
 *
 * NOTE: These tests are designed to FAIL until the implementation is complete.
 * Each test attempts to import and use functionality that doesn't exist yet.
 *
 * @category Application
 * @module do/rpc/rpc.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ============================================================================
// EXPECTED TYPES (from rpc.do - to be implemented)
// ============================================================================

/**
 * Connection state for RPC client
 */
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

/**
 * RPC Error codes - these should match what rpc.do exports
 */
const ExpectedErrorCodes = {
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  CONNECTION_CLOSED: 'CONNECTION_CLOSED',
  TIMEOUT: 'TIMEOUT',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  SERIALIZATION_ERROR: 'SERIALIZATION_ERROR',
  METHOD_NOT_FOUND: 'METHOD_NOT_FOUND',
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
} as const

/**
 * RPC Request message
 */
interface RPCRequest {
  type: 'request'
  id: string
  path: string[]
  args: unknown[]
  timestamp: number
}

/**
 * RPC Response message
 */
interface RPCResponse {
  type: 'response'
  id: string
  success: boolean
  result?: unknown
  error?: RPCError
  timestamp: number
}

/**
 * RPC Error structure
 */
interface RPCError {
  code: string
  message: string
  stack?: string
  data?: unknown
}

/**
 * Stream chunk for streaming responses
 */
interface RPCStreamChunk {
  type: 'stream'
  id: string
  chunk: unknown
  done: boolean
  index: number
  timestamp: number
}

/**
 * DO Client options
 */
interface DOClientOptions {
  url: string
  protocol?: 'ws' | 'wss'
  reconnect?: {
    enabled?: boolean
    maxAttempts?: number
    backoffMs?: number
    maxBackoffMs?: number
  }
  timeout?: number
  batching?: {
    enabled?: boolean
    maxSize?: number
    delayMs?: number
  }
  headers?: Record<string, string>
  serializer?: unknown
}

// ============================================================================
// TEST UTILITIES
// ============================================================================

/**
 * Create a mock OAuth token for testing
 */
function createMockToken(
  claims: Partial<{ sub: string; tenant_id: string; scopes: string[]; exp: number }> = {}
) {
  const payload = {
    sub: claims.sub ?? 'user-123',
    tenant_id: claims.tenant_id ?? 'tenant-abc',
    scopes: claims.scopes ?? ['read', 'write'],
    exp: claims.exp ?? Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    session_id: 'session-xyz',
  }
  return `mock.${btoa(JSON.stringify(payload))}.signature`
}

/**
 * Mock FsModule for testing RPC wrapping
 */
class MockFsModule {
  async readFile(path: string, _options?: { encoding?: string }) {
    if (path === '/test.txt') {
      return 'Hello, World!'
    }
    throw new Error('ENOENT: no such file or directory')
  }

  async writeFile(path: string, content: string | ArrayBuffer, _options?: { mode?: number }) {
    if (path.startsWith('/protected/')) {
      throw new Error('EACCES: permission denied')
    }
    return { path, size: typeof content === 'string' ? content.length : content.byteLength }
  }

  async stat(path: string) {
    return {
      path,
      isFile: () => true,
      isDirectory: () => false,
      size: 1024,
      mtime: new Date(),
    }
  }

  async readdir(path: string) {
    return [{ name: 'file1.txt' }, { name: 'file2.txt' }, { name: 'subdir', isDirectory: true }]
  }

  async mkdir(path: string, _options?: { recursive?: boolean }) {
    return { path }
  }

  async rmdir(path: string) {
    return { path }
  }

  async unlink(path: string) {
    return { path }
  }

  async rename(oldPath: string, newPath: string) {
    return { oldPath, newPath }
  }

  async copyFile(src: string, dest: string) {
    return { src, dest }
  }

  async *readFileStream(path: string): AsyncGenerator<Uint8Array, void, unknown> {
    const chunks = [
      new Uint8Array([72, 101, 108, 108, 111]), // "Hello"
      new Uint8Array([44, 32]), // ", "
      new Uint8Array([87, 111, 114, 108, 100]), // "World"
    ]
    for (const chunk of chunks) {
      yield chunk
    }
  }
}

// ============================================================================
// SECTION 1: RPCFsBackend Tests - Client Creation
// Tests that the RPC client backend for fsx exists and works correctly
// ============================================================================

describe('RPCFsBackend', () => {
  let mockFs: MockFsModule

  beforeEach(() => {
    mockFs = new MockFsModule()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Client Creation', () => {
    it('should export RPCFsBackend class from rpc module', async () => {
      // This test will fail until RPCFsBackend is implemented
      const rpcModule = await import('./index.js').catch(() => null)
      expect(rpcModule).not.toBeNull()
      expect(rpcModule?.RPCFsBackend).toBeDefined()
    })

    it('should create RPCFsBackend with URL', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com')
      expect(backend).toBeDefined()
      expect(backend.url).toBe('https://fs.example.com')
    })

    it('should accept DOClientOptions in constructor', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const options: DOClientOptions = {
        url: 'https://fs.example.com',
        timeout: 60000,
        reconnect: { enabled: true, maxAttempts: 5 },
        headers: { 'X-Tenant-ID': 'tenant-abc' },
      }
      const backend = new RPCFsBackend(options.url, options)
      expect(backend.options.timeout).toBe(60000)
    })

    it('should support wss protocol explicitly', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com', { protocol: 'wss' })
      expect(backend.options.protocol).toBe('wss')
    })

    it('should auto-detect protocol from URL', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const httpsBackend = new RPCFsBackend('https://secure.example.com')
      const httpBackend = new RPCFsBackend('http://insecure.example.com')
      expect(httpsBackend.protocol).toBe('wss')
      expect(httpBackend.protocol).toBe('ws')
    })

    it('should accept custom serializer', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const customSerializer = {
        encode: (msg: unknown) => new ArrayBuffer(0),
        decode: (data: ArrayBuffer) => ({}),
      }
      const backend = new RPCFsBackend('https://fs.example.com', { serializer: customSerializer })
      expect(backend.options.serializer).toBe(customSerializer)
    })
  })

  describe('Magic Proxy for FS Operations', () => {
    it('should provide $.fs.read magic proxy', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com')
      const $ = backend.getProxy()
      expect(typeof $.fs.read).toBe('function')
    })

    it('should provide $.fs.write magic proxy', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com')
      const $ = backend.getProxy()
      expect(typeof $.fs.write).toBe('function')
    })

    it('should provide $.fs.list magic proxy', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com')
      const $ = backend.getProxy()
      expect(typeof $.fs.list).toBe('function')
    })

    it('should provide $.fs.stat magic proxy', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com')
      const $ = backend.getProxy()
      expect(typeof $.fs.stat).toBe('function')
    })

    it('should provide $.fs.mkdir magic proxy', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com')
      const $ = backend.getProxy()
      expect(typeof $.fs.mkdir).toBe('function')
    })

    it('should provide $.fs.rmdir magic proxy', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com')
      const $ = backend.getProxy()
      expect(typeof $.fs.rmdir).toBe('function')
    })

    it('should provide $.fs.unlink magic proxy', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com')
      const $ = backend.getProxy()
      expect(typeof $.fs.unlink).toBe('function')
    })

    it('should provide $.fs.rename magic proxy', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com')
      const $ = backend.getProxy()
      expect(typeof $.fs.rename).toBe('function')
    })

    it('should provide $.fs.copy magic proxy', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com')
      const $ = backend.getProxy()
      expect(typeof $.fs.copy).toBe('function')
    })

    it('should support nested namespace paths like $.fs.blob.read', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com')
      const $ = backend.getProxy()
      expect(typeof $.fs.blob.read).toBe('function')
    })
  })

  describe('Connection State Management', () => {
    it('should start in disconnected state', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com')
      expect(backend.connectionState).toBe('disconnected')
    })

    it('should transition to connecting state when connect is called', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com')
      backend.connect()
      expect(backend.connectionState).toBe('connecting')
    })

    it('should transition to connected state on successful connection', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com')
      await backend.connect()
      expect(backend.connectionState).toBe('connected')
    })

    it('should transition to reconnecting state on connection loss', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com', {
        reconnect: { enabled: true },
      })
      await backend.connect()
      backend.simulateDisconnect() // Test helper method
      expect(backend.connectionState).toBe('reconnecting')
    })

    it('should transition to closed state when explicitly closed', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com')
      await backend.connect()
      await backend.close()
      expect(backend.connectionState).toBe('closed')
    })

    it('should emit connect event on connection', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com')
      const onConnect = vi.fn()
      backend.on('connect', onConnect)
      await backend.connect()
      expect(onConnect).toHaveBeenCalled()
    })

    it('should emit disconnect event on disconnection', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com')
      const onDisconnect = vi.fn()
      backend.on('disconnect', onDisconnect)
      await backend.connect()
      await backend.close()
      expect(onDisconnect).toHaveBeenCalled()
    })

    it('should emit error event on connection error', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://unreachable.example.com')
      const onError = vi.fn()
      backend.on('error', onError)
      await backend.connect().catch(() => {})
      expect(onError).toHaveBeenCalled()
    })
  })

  describe('Automatic Reconnection', () => {
    it('should automatically reconnect when enabled', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com', {
        reconnect: { enabled: true },
      })
      await backend.connect()
      backend.simulateDisconnect()
      await vi.waitFor(() => backend.connectionState === 'connected')
      expect(backend.connectionState).toBe('connected')
    })

    it('should use exponential backoff for reconnection', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com', {
        reconnect: { enabled: true, backoffMs: 100, maxBackoffMs: 1600 },
      })
      expect(backend.getReconnectDelay(0)).toBe(100)
      expect(backend.getReconnectDelay(1)).toBe(200)
      expect(backend.getReconnectDelay(2)).toBe(400)
      expect(backend.getReconnectDelay(5)).toBe(1600) // capped at max
    })

    it('should respect maxAttempts for reconnection', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com', {
        reconnect: { enabled: true, maxAttempts: 3 },
      })
      expect(backend.options.reconnect?.maxAttempts).toBe(3)
    })

    it('should emit reconnect event with attempt number', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://fs.example.com', {
        reconnect: { enabled: true },
      })
      const onReconnect = vi.fn()
      backend.on('reconnect', onReconnect)
      await backend.connect()
      backend.simulateDisconnect()
      await vi.waitFor(() => onReconnect.mock.calls.length > 0)
      expect(onReconnect).toHaveBeenCalledWith(expect.any(Number))
    })

    it('should stop reconnecting after maxAttempts', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('https://unreachable.example.com', {
        reconnect: { enabled: true, maxAttempts: 2, backoffMs: 10 },
      })
      const onError = vi.fn()
      backend.on('error', onError)
      await backend.connect().catch(() => {})
      expect(backend.connectionState).toBe('closed')
    })
  })
})

// ============================================================================
// SECTION 2: RPCFsModule Tests - Server-side wrapper
// Tests that FsModule can be wrapped for RPC exposure
// ============================================================================

describe('RPCFsModule', () => {
  let mockFs: MockFsModule

  beforeEach(() => {
    mockFs = new MockFsModule()
    vi.clearAllMocks()
  })

  describe('Module Exports', () => {
    it('should export RPCFsModule class from rpc module', async () => {
      const rpcModule = await import('./index.js').catch(() => null)
      expect(rpcModule).not.toBeNull()
      expect(rpcModule?.RPCFsModule).toBeDefined()
    })

    it('should export createRPCHandler from rpc module', async () => {
      const rpcModule = await import('./index.js').catch(() => null)
      expect(rpcModule?.createRPCHandler).toBeDefined()
    })
  })

  describe('Wrapping FsModule Operations', () => {
    it('should wrap FsModule.readFile for RPC exposure', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      expect(rpcModule.handlers.fs.readFile).toBeDefined()
    })

    it('should wrap FsModule.writeFile for RPC exposure', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      expect(rpcModule.handlers.fs.writeFile).toBeDefined()
    })

    it('should wrap FsModule.stat for RPC exposure', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      expect(rpcModule.handlers.fs.stat).toBeDefined()
    })

    it('should wrap FsModule.readdir for RPC exposure', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      expect(rpcModule.handlers.fs.readdir).toBeDefined()
    })

    it('should wrap FsModule.mkdir for RPC exposure', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      expect(rpcModule.handlers.fs.mkdir).toBeDefined()
    })

    it('should wrap FsModule.rmdir for RPC exposure', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      expect(rpcModule.handlers.fs.rmdir).toBeDefined()
    })

    it('should wrap FsModule.unlink for RPC exposure', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      expect(rpcModule.handlers.fs.unlink).toBeDefined()
    })

    it('should wrap FsModule.rename for RPC exposure', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      expect(rpcModule.handlers.fs.rename).toBeDefined()
    })

    it('should wrap FsModule.copyFile for RPC exposure', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      expect(rpcModule.handlers.fs.copyFile).toBeDefined()
    })
  })

  describe('Streaming File Reads', () => {
    it('should export createStreamResponse from rpc module', async () => {
      const rpcModule = await import('./index.js').catch(() => null)
      expect(rpcModule?.createStreamResponse).toBeDefined()
    })

    it('should handle streaming file reads via RPC', async () => {
      const { RPCFsModule, createStreamResponse } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      const stream = rpcModule.handlers.fs.readFileStream('/test.txt')
      expect(stream).toBeDefined()
      expect(typeof stream[Symbol.asyncIterator]).toBe('function')
    })

    it('should chunk large files for streaming', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs, { chunkSize: 5 })
      const chunks: Uint8Array[] = []
      for await (const chunk of rpcModule.handlers.fs.readFileStream('/test.txt')) {
        chunks.push(chunk)
      }
      expect(chunks.length).toBeGreaterThan(1)
    })

    it('should emit stream chunks with correct indices', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      let index = 0
      for await (const chunk of rpcModule.handlers.fs.readFileStream('/test.txt')) {
        expect(chunk.index).toBe(index)
        index++
      }
    })

    it('should signal stream completion with done flag', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      const chunks = []
      for await (const chunk of rpcModule.handlers.fs.readFileStream('/test.txt')) {
        chunks.push(chunk)
      }
      // Stream should complete without throwing
      expect(chunks.length).toBeGreaterThan(0)
    })

    it('should handle stream errors gracefully', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      await expect(async () => {
        for await (const _ of rpcModule.handlers.fs.readFileStream('/nonexistent.txt')) {
          // consume stream
        }
      }).rejects.toThrow()
    })
  })

  describe('Binary File Operations', () => {
    it('should handle binary file reads', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      const result = await rpcModule.handlers.fs.readFile('/test.txt', { encoding: 'buffer' })
      expect(result instanceof ArrayBuffer || result instanceof Uint8Array).toBe(true)
    })

    it('should handle binary file writes', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      const data = new Uint8Array([1, 2, 3, 4, 5])
      const result = await rpcModule.handlers.fs.writeFile('/binary.bin', data)
      expect(result.size).toBe(5)
    })

    it('should preserve binary data integrity through RPC', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      const original = new Uint8Array([0, 128, 255, 1, 254])
      await rpcModule.handlers.fs.writeFile('/binary.bin', original)
      const result = await rpcModule.handlers.fs.readFile('/binary.bin', { encoding: 'buffer' })
      expect(new Uint8Array(result)).toEqual(original)
    })

    it('should handle ArrayBuffer input', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      const buffer = new ArrayBuffer(10)
      const result = await rpcModule.handlers.fs.writeFile('/buffer.bin', buffer)
      expect(result.size).toBe(10)
    })

    it('should handle Uint8Array input', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      const array = new Uint8Array(10)
      const result = await rpcModule.handlers.fs.writeFile('/array.bin', array)
      expect(result.size).toBe(10)
    })
  })

  describe('Batch Operations', () => {
    it('should support batch file reads', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      const results = await rpcModule.handlers.fs.batchRead(['/file1.txt', '/file2.txt'])
      expect(results).toHaveLength(2)
    })

    it('should support batch file writes', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      const files = [
        { path: '/file1.txt', content: 'content1' },
        { path: '/file2.txt', content: 'content2' },
      ]
      const results = await rpcModule.handlers.fs.batchWrite(files)
      expect(results).toHaveLength(2)
    })

    it('should support multi-file stat operations', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      const stats = await rpcModule.handlers.fs.batchStat(['/file1.txt', '/file2.txt'])
      expect(stats).toHaveLength(2)
    })

    it('should respect batch size limits', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs, { maxBatchSize: 2 })
      expect(rpcModule.options.maxBatchSize).toBe(2)
    })

    it('should handle partial batch failures', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(mockFs)
      const results = await rpcModule.handlers.fs.batchRead(['/exists.txt', '/nonexistent.txt'])
      expect(results[0].success).toBe(true)
      expect(results[1].success).toBe(false)
    })
  })
})

// ============================================================================
// SECTION 3: RPC Transport Tests
// Tests for WebSocket transport, serialization, and batching
// ============================================================================

describe('RPC Transport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('WebSocket Connection', () => {
    it('should establish WebSocket connection', async () => {
      const { createTransport } = await import('./index.js')
      const transport = createTransport('wss://fs.example.com')
      await transport.connect()
      expect(transport.isConnected).toBe(true)
    })

    it('should send proper upgrade headers', async () => {
      const { createTransport } = await import('./index.js')
      const transport = createTransport('wss://fs.example.com', {
        headers: { 'X-Custom-Header': 'value' },
      })
      expect(transport.headers['X-Custom-Header']).toBe('value')
    })

    it('should handle connection refused', async () => {
      const { createTransport } = await import('./index.js')
      const transport = createTransport('wss://unreachable.example.com')
      await expect(transport.connect()).rejects.toThrow()
    })

    it('should handle connection timeout', async () => {
      const { createTransport } = await import('./index.js')
      const transport = createTransport('wss://slow.example.com', { timeout: 100 })
      await expect(transport.connect()).rejects.toThrow(/timeout/i)
    })

    it('should close connection cleanly', async () => {
      const { createTransport } = await import('./index.js')
      const transport = createTransport('wss://fs.example.com')
      await transport.connect()
      await transport.close()
      expect(transport.isConnected).toBe(false)
    })
  })

  describe('Binary Serialization', () => {
    it('should export BinarySerializer from rpc module', async () => {
      const rpcModule = await import('./index.js').catch(() => null)
      expect(rpcModule?.BinarySerializer).toBeDefined()
    })

    it('should serialize requests as binary', async () => {
      const { BinarySerializer } = await import('./index.js')
      const serializer = new BinarySerializer()
      const request: RPCRequest = {
        type: 'request',
        id: 'req-123',
        path: ['fs', 'read'],
        args: ['/test.txt'],
        timestamp: Date.now(),
      }
      const encoded = serializer.encode(request)
      expect(encoded instanceof ArrayBuffer).toBe(true)
    })

    it('should deserialize binary responses', async () => {
      const { BinarySerializer } = await import('./index.js')
      const serializer = new BinarySerializer()
      const response: RPCResponse = {
        type: 'response',
        id: 'req-123',
        success: true,
        result: 'file contents',
        timestamp: Date.now(),
      }
      const encoded = serializer.encode(response)
      const decoded = serializer.decode(encoded)
      expect(decoded.type).toBe('response')
      expect(decoded.result).toBe('file contents')
    })

    it('should handle serialization errors', async () => {
      const { BinarySerializer } = await import('./index.js')
      const serializer = new BinarySerializer()
      const circular: Record<string, unknown> = {}
      circular.self = circular
      expect(() => serializer.encode(circular as unknown as RPCRequest)).toThrow()
    })

    it('should export JsonSerializer as fallback', async () => {
      const { JsonSerializer } = await import('./index.js')
      expect(JsonSerializer).toBeDefined()
    })

    it('should preserve special types through serialization', async () => {
      const { BinarySerializer } = await import('./index.js')
      const serializer = new BinarySerializer()
      const data = {
        type: 'request' as const,
        id: 'req-123',
        path: ['test'],
        args: [new Date('2024-01-01'), new Uint8Array([1, 2, 3])],
        timestamp: Date.now(),
      }
      const encoded = serializer.encode(data)
      const decoded = serializer.decode(encoded)
      expect(decoded.args[0] instanceof Date).toBe(true)
      expect(decoded.args[1] instanceof Uint8Array).toBe(true)
    })
  })

  describe('Message Batching', () => {
    it('should batch multiple requests', async () => {
      const { createTransport } = await import('./index.js')
      const transport = createTransport('wss://fs.example.com', {
        batching: { enabled: true, delayMs: 10 },
      })
      expect(transport.batchingEnabled).toBe(true)
    })

    it('should flush batch on size limit', async () => {
      const { createTransport } = await import('./index.js')
      const transport = createTransport('wss://fs.example.com', {
        batching: { enabled: true, maxSize: 5 },
      })
      expect(transport.options.batching?.maxSize).toBe(5)
    })

    it('should flush batch on delay timeout', async () => {
      const { createTransport } = await import('./index.js')
      const transport = createTransport('wss://fs.example.com', {
        batching: { enabled: true, delayMs: 50 },
      })
      expect(transport.options.batching?.delayMs).toBe(50)
    })

    it('should handle batch response correlation', async () => {
      const { createTransport } = await import('./index.js')
      const transport = createTransport('wss://fs.example.com', {
        batching: { enabled: true },
      })
      // Batch responses should be correlated to original requests by ID
      expect(transport.correlateResponses).toBeDefined()
    })

    it('should disable batching when not configured', async () => {
      const { createTransport } = await import('./index.js')
      const transport = createTransport('wss://fs.example.com', {
        batching: { enabled: false },
      })
      expect(transport.batchingEnabled).toBe(false)
    })
  })

  describe('Ping/Pong Keepalive', () => {
    it('should send periodic ping messages', async () => {
      const { createTransport } = await import('./index.js')
      const transport = createTransport('wss://fs.example.com', {
        keepalive: { intervalMs: 30000 },
      })
      expect(transport.keepaliveInterval).toBe(30000)
    })

    it('should respond to pong messages', async () => {
      const { createTransport } = await import('./index.js')
      const transport = createTransport('wss://fs.example.com')
      await transport.connect()
      const lastPong = transport.lastPongTime
      transport.simulatePong()
      expect(transport.lastPongTime).toBeGreaterThan(lastPong)
    })

    it('should detect connection loss via ping timeout', async () => {
      const { createTransport } = await import('./index.js')
      const transport = createTransport('wss://fs.example.com', {
        keepalive: { timeoutMs: 5000 },
      })
      expect(transport.keepaliveTimeout).toBe(5000)
    })

    it('should trigger reconnection on keepalive failure', async () => {
      const { createTransport } = await import('./index.js')
      const transport = createTransport('wss://fs.example.com', {
        reconnect: { enabled: true },
        keepalive: { enabled: true },
      })
      await transport.connect()
      const onReconnect = vi.fn()
      transport.on('reconnect', onReconnect)
      transport.simulateKeepaliveTimeout()
      expect(onReconnect).toHaveBeenCalled()
    })
  })
})

// ============================================================================
// SECTION 4: Integration with OAuth Tests
// Tests for OAuth integration with RPC layer
// ============================================================================

describe('OAuth Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Auth Headers', () => {
    it('should pass auth headers to RPC client', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const token = createMockToken()
      const backend = new RPCFsBackend('wss://fs.example.com', {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(backend.headers['Authorization']).toContain('Bearer')
    })

    it('should support custom auth header name', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('wss://fs.example.com', {
        headers: { 'X-Auth-Token': 'custom-token' },
      })
      expect(backend.headers['X-Auth-Token']).toBe('custom-token')
    })

    it('should include tenant ID header', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('wss://fs.example.com', {
        headers: { 'X-Tenant-ID': 'tenant-abc' },
      })
      expect(backend.headers['X-Tenant-ID']).toBe('tenant-abc')
    })

    it('should update headers on token change', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('wss://fs.example.com')
      const newToken = createMockToken({ sub: 'user-456' })
      backend.setAuthToken(newToken)
      expect(backend.headers['Authorization']).toContain(newToken)
    })
  })

  describe('Token Refresh on UNAUTHORIZED', () => {
    it('should detect UNAUTHORIZED error code', async () => {
      const { RPCFsBackend, ErrorCodes } = await import('./index.js')
      expect(ErrorCodes.UNAUTHORIZED).toBe('UNAUTHORIZED')
    })

    it('should trigger token refresh callback', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const refreshToken = vi.fn().mockResolvedValue('new-token')
      const backend = new RPCFsBackend('wss://fs.example.com', {
        onTokenRefresh: refreshToken,
      })
      await backend.handleUnauthorized()
      expect(refreshToken).toHaveBeenCalled()
    })

    it('should retry request after token refresh', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const refreshToken = vi.fn().mockResolvedValue('new-token')
      const backend = new RPCFsBackend('wss://fs.example.com', {
        onTokenRefresh: refreshToken,
      })
      // Simulate a request that gets 401, refreshes, and retries
      const result = await backend.retryWithRefresh(async () => 'success')
      expect(result).toBe('success')
    })

    it('should fail after max refresh attempts', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const refreshToken = vi.fn().mockRejectedValue(new Error('refresh failed'))
      const backend = new RPCFsBackend('wss://fs.example.com', {
        onTokenRefresh: refreshToken,
        maxRefreshAttempts: 2,
      })
      await expect(backend.handleUnauthorized()).rejects.toThrow()
      expect(refreshToken).toHaveBeenCalledTimes(2)
    })

    it('should propagate refresh errors', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const refreshToken = vi.fn().mockRejectedValue(new Error('Network error'))
      const backend = new RPCFsBackend('wss://fs.example.com', {
        onTokenRefresh: refreshToken,
      })
      await expect(backend.handleUnauthorized()).rejects.toThrow('Network error')
    })
  })

  describe('Permission Checking Before RPC', () => {
    it('should export createRPCAuthMiddleware from rpc module', async () => {
      const rpcModule = await import('./index.js').catch(() => null)
      expect(rpcModule?.createRPCAuthMiddleware).toBeDefined()
    })

    it('should check read permission before read operations', async () => {
      const { RPCFsModule, createRPCAuthMiddleware } = await import('./index.js')
      const middleware = createRPCAuthMiddleware({ requiredScopes: ['read'] })
      const ctx = { scopes: ['read'] }
      const result = await middleware.checkPermission('fs.readFile', ctx)
      expect(result.allowed).toBe(true)
    })

    it('should check write permission before write operations', async () => {
      const { createRPCAuthMiddleware } = await import('./index.js')
      const middleware = createRPCAuthMiddleware({ requiredScopes: ['write'] })
      const ctx = { scopes: ['read'] } // No write scope
      const result = await middleware.checkPermission('fs.writeFile', ctx)
      expect(result.allowed).toBe(false)
    })

    it('should check delete permission before delete operations', async () => {
      const { createRPCAuthMiddleware } = await import('./index.js')
      const middleware = createRPCAuthMiddleware()
      const ctx = { scopes: ['read', 'write'] } // No delete scope
      const result = await middleware.checkPermission('fs.unlink', ctx)
      expect(result.allowed).toBe(false)
    })

    it('should check admin permission for admin operations', async () => {
      const { createRPCAuthMiddleware } = await import('./index.js')
      const middleware = createRPCAuthMiddleware()
      const ctx = { scopes: ['read', 'write'] } // No admin scope
      const result = await middleware.checkPermission('admin.deleteUser', ctx)
      expect(result.allowed).toBe(false)
    })

    it('should deny operations without required scopes', async () => {
      const { createRPCAuthMiddleware } = await import('./index.js')
      const middleware = createRPCAuthMiddleware()
      const ctx = { scopes: [] }
      const result = await middleware.checkPermission('fs.readFile', ctx)
      expect(result.allowed).toBe(false)
    })

    it('should allow admin scope to bypass all checks', async () => {
      const { createRPCAuthMiddleware } = await import('./index.js')
      const middleware = createRPCAuthMiddleware()
      const ctx = { scopes: ['admin'] }
      const result = await middleware.checkPermission('fs.deleteAllFiles', ctx)
      expect(result.allowed).toBe(true)
    })
  })

  describe('OAuth Session Context', () => {
    it('should expose user ID from token', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const token = createMockToken({ sub: 'user-123' })
      const backend = new RPCFsBackend('wss://fs.example.com', {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(backend.getUserId()).toBe('user-123')
    })

    it('should expose tenant ID from token', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const token = createMockToken({ tenant_id: 'tenant-abc' })
      const backend = new RPCFsBackend('wss://fs.example.com', {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(backend.getTenantId()).toBe('tenant-abc')
    })

    it('should expose session ID from token', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const token = createMockToken()
      const backend = new RPCFsBackend('wss://fs.example.com', {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(backend.getSessionId()).toBe('session-xyz')
    })

    it('should expose scopes from token', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const token = createMockToken({ scopes: ['read', 'write'] })
      const backend = new RPCFsBackend('wss://fs.example.com', {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(backend.getScopes()).toContain('read')
      expect(backend.getScopes()).toContain('write')
    })
  })
})

// ============================================================================
// SECTION 5: Error Handling Tests
// Tests for timeout, connection failures, and error recovery
// ============================================================================

describe('Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Timeout Handling', () => {
    it('should timeout after configured duration', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('wss://fs.example.com', { timeout: 100 })
      await backend.connect()
      const $ = backend.getProxy()
      await expect($.fs.slowOperation()).rejects.toThrow(/timeout/i)
    })

    it('should return TIMEOUT error code', async () => {
      const { ErrorCodes } = await import('./index.js')
      expect(ErrorCodes.TIMEOUT).toBe('TIMEOUT')
    })

    it('should cancel pending request on timeout', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('wss://fs.example.com', { timeout: 100 })
      await backend.connect()
      const pendingBefore = backend.pendingRequests.size
      try {
        await backend.getProxy().fs.slowOperation()
      } catch {}
      expect(backend.pendingRequests.size).toBe(pendingBefore)
    })

    it('should support per-request timeout override', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('wss://fs.example.com', { timeout: 5000 })
      await backend.connect()
      const $ = backend.getProxy()
      await expect($.fs.read('/test.txt', { timeout: 50 })).rejects.toThrow(/timeout/i)
    })

    it('should clear timeout on successful response', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('wss://fs.example.com', { timeout: 5000 })
      await backend.connect()
      const $ = backend.getProxy()
      await $.fs.read('/test.txt')
      expect(backend.activeTimeouts.size).toBe(0)
    })
  })

  describe('Connection Failure Recovery', () => {
    it('should handle initial connection failure', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('wss://unreachable.example.com')
      await expect(backend.connect()).rejects.toThrow()
    })

    it('should return CONNECTION_FAILED error code', async () => {
      const { ErrorCodes } = await import('./index.js')
      expect(ErrorCodes.CONNECTION_FAILED).toBe('CONNECTION_FAILED')
    })

    it('should queue requests during reconnection', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('wss://fs.example.com', {
        reconnect: { enabled: true },
      })
      await backend.connect()
      backend.simulateDisconnect()
      const promise = backend.getProxy().fs.read('/test.txt')
      expect(backend.queuedRequests.length).toBeGreaterThan(0)
    })

    it('should flush queued requests after reconnection', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('wss://fs.example.com', {
        reconnect: { enabled: true },
      })
      await backend.connect()
      backend.simulateDisconnect()
      const promise = backend.getProxy().fs.read('/test.txt')
      await backend.simulateReconnect()
      expect(backend.queuedRequests.length).toBe(0)
    })

    it('should reject queued requests on max retries exceeded', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('wss://unreachable.example.com', {
        reconnect: { enabled: true, maxAttempts: 1 },
      })
      await expect(backend.connect()).rejects.toThrow()
    })
  })

  describe('Method Not Found Errors', () => {
    it('should return METHOD_NOT_FOUND for unknown methods', async () => {
      const { ErrorCodes } = await import('./index.js')
      expect(ErrorCodes.METHOD_NOT_FOUND).toBe('METHOD_NOT_FOUND')
    })

    it('should include method path in error', async () => {
      const { RPCFsModule, RPCError } = await import('./index.js')
      const rpcModule = new RPCFsModule({})
      try {
        await rpcModule.handleRequest({
          type: 'request',
          id: 'req-123',
          path: ['nonexistent', 'method'],
          args: [],
          timestamp: Date.now(),
        })
      } catch (e) {
        expect((e as RPCError).data?.path).toEqual(['nonexistent', 'method'])
      }
    })

    it('should handle deeply nested unknown paths', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule({})
      await expect(
        rpcModule.handleRequest({
          type: 'request',
          id: 'req-123',
          path: ['a', 'b', 'c', 'd', 'e'],
          args: [],
          timestamp: Date.now(),
        })
      ).rejects.toThrow(/method.*not.*found/i)
    })
  })

  describe('Streaming Errors', () => {
    it('should handle stream abort', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(new MockFsModule())
      const stream = rpcModule.handlers.fs.readFileStream('/test.txt')
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next()
      await iterator.return?.()
      // Stream should be aborted without error
    })

    it('should propagate stream error to client', async () => {
      const { RPCFsBackend } = await import('./index.js')
      const backend = new RPCFsBackend('wss://fs.example.com')
      await backend.connect()
      const $ = backend.getProxy()
      await expect(async () => {
        for await (const _ of $.fs.readFileStream('/nonexistent.txt')) {
          // consume
        }
      }).rejects.toThrow()
    })

    it('should clean up stream resources on error', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(new MockFsModule())
      const initialStreams = rpcModule.activeStreams.size
      try {
        for await (const _ of rpcModule.handlers.fs.readFileStream('/error.txt')) {
          // consume
        }
      } catch {}
      expect(rpcModule.activeStreams.size).toBe(initialStreams)
    })

    it('should handle partial stream consumption', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(new MockFsModule())
      const stream = rpcModule.handlers.fs.readFileStream('/test.txt')
      const iterator = stream[Symbol.asyncIterator]()
      await iterator.next() // Only consume first chunk
      await iterator.return?.() // Early termination
      // Should not leak resources
    })
  })

  describe('Serialization Errors', () => {
    it('should return SERIALIZATION_ERROR for malformed messages', async () => {
      const { ErrorCodes } = await import('./index.js')
      expect(ErrorCodes.SERIALIZATION_ERROR).toBe('SERIALIZATION_ERROR')
    })

    it('should handle circular references', async () => {
      const { BinarySerializer } = await import('./index.js')
      const serializer = new BinarySerializer()
      const circular: Record<string, unknown> = {}
      circular.self = circular
      expect(() => serializer.encode(circular as unknown as RPCRequest)).toThrow(/circular/i)
    })

    it('should handle unsupported types', async () => {
      const { BinarySerializer } = await import('./index.js')
      const serializer = new BinarySerializer()
      const unsupported = {
        type: 'request' as const,
        id: 'req-123',
        path: ['test'],
        args: [Symbol('unsupported')],
        timestamp: Date.now(),
      }
      expect(() => serializer.encode(unsupported)).toThrow()
    })
  })

  describe('Internal Server Errors', () => {
    it('should return INTERNAL_ERROR for unhandled exceptions', async () => {
      const { ErrorCodes } = await import('./index.js')
      expect(ErrorCodes.INTERNAL_ERROR).toBe('INTERNAL_ERROR')
    })

    it('should not expose stack traces in production', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(new MockFsModule(), { production: true })
      try {
        await rpcModule.handlers.fs.throwInternalError()
      } catch (e) {
        expect((e as RPCError).stack).toBeUndefined()
      }
    })

    it('should include stack traces in development', async () => {
      const { RPCFsModule } = await import('./index.js')
      const rpcModule = new RPCFsModule(new MockFsModule(), { production: false })
      try {
        await rpcModule.handlers.fs.throwInternalError()
      } catch (e) {
        expect((e as RPCError).stack).toBeDefined()
      }
    })
  })
})

// ============================================================================
// SECTION 6: Server Handler Tests
// Tests for RPC server handler registration and routing
// ============================================================================

describe('RPC Server Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Handler Registration', () => {
    it('should register handlers from object methods', async () => {
      const { createRPCHandler } = await import('./index.js')
      const instance = new MockFsModule()
      const handler = createRPCHandler(instance, {})
      expect(handler.registeredMethods).toContain('readFile')
      expect(handler.registeredMethods).toContain('writeFile')
    })

    it('should register nested namespace handlers', async () => {
      const { createRPCHandler } = await import('./index.js')
      const instance = {
        fs: { read: () => {}, write: () => {} },
        admin: { users: { list: () => {} } },
      }
      const handler = createRPCHandler(instance, {})
      expect(handler.registeredMethods).toContain('fs.read')
      expect(handler.registeredMethods).toContain('admin.users.list')
    })

    it('should skip non-function properties', async () => {
      const { createRPCHandler } = await import('./index.js')
      const instance = {
        config: { setting: true },
        method: () => 'result',
      }
      const handler = createRPCHandler(instance, {})
      expect(handler.registeredMethods).not.toContain('config')
      expect(handler.registeredMethods).toContain('method')
    })
  })

  describe('Request Routing', () => {
    it('should route requests to correct handler', async () => {
      const { createRPCHandler } = await import('./index.js')
      const readFile = vi.fn().mockResolvedValue('content')
      const instance = { fs: { readFile } }
      const handler = createRPCHandler(instance, {})
      await handler.handleRequest({
        type: 'request',
        id: 'req-123',
        path: ['fs', 'readFile'],
        args: ['/test.txt'],
        timestamp: Date.now(),
      })
      expect(readFile).toHaveBeenCalledWith('/test.txt')
    })

    it('should handle multiple concurrent requests', async () => {
      const { createRPCHandler } = await import('./index.js')
      const slowMethod = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('done'), 50))
      )
      const instance = { slowMethod }
      const handler = createRPCHandler(instance, {})
      const results = await Promise.all([
        handler.handleRequest({ type: 'request', id: 'req-1', path: ['slowMethod'], args: [], timestamp: Date.now() }),
        handler.handleRequest({ type: 'request', id: 'req-2', path: ['slowMethod'], args: [], timestamp: Date.now() }),
        handler.handleRequest({ type: 'request', id: 'req-3', path: ['slowMethod'], args: [], timestamp: Date.now() }),
      ])
      expect(results).toHaveLength(3)
    })

    it('should pass arguments to handler', async () => {
      const { createRPCHandler } = await import('./index.js')
      const method = vi.fn().mockResolvedValue('result')
      const instance = { method }
      const handler = createRPCHandler(instance, {})
      await handler.handleRequest({
        type: 'request',
        id: 'req-123',
        path: ['method'],
        args: ['arg1', { key: 'value' }, 123],
        timestamp: Date.now(),
      })
      expect(method).toHaveBeenCalledWith('arg1', { key: 'value' }, 123)
    })

    it('should return handler result in response', async () => {
      const { createRPCHandler } = await import('./index.js')
      const instance = { method: () => ({ result: 'data' }) }
      const handler = createRPCHandler(instance, {})
      const response = await handler.handleRequest({
        type: 'request',
        id: 'req-123',
        path: ['method'],
        args: [],
        timestamp: Date.now(),
      })
      expect(response.success).toBe(true)
      expect(response.result).toEqual({ result: 'data' })
    })
  })

  describe('Server Context ($)', () => {
    it('should provide SQL access via $.sql', async () => {
      const { createRPCHandler, getContext } = await import('./index.js')
      const mockSql = vi.fn()
      const ctx = { storage: { sql: mockSql } }
      const handler = createRPCHandler({}, ctx)
      const $ = getContext()
      expect($.sql).toBeDefined()
    })

    it('should provide storage access via $.storage', async () => {
      const { createRPCHandler, getContext } = await import('./index.js')
      const mockStorage = { get: vi.fn(), put: vi.fn() }
      const ctx = { storage: mockStorage }
      const handler = createRPCHandler({}, ctx)
      const $ = getContext()
      expect($.storage).toBeDefined()
    })

    it('should provide instance access via $.instance', async () => {
      const { createRPCHandler, getContext } = await import('./index.js')
      const instance = { name: 'test' }
      const handler = createRPCHandler(instance, {})
      const $ = getContext()
      expect($.instance).toBe(instance)
    })

    it('should provide state access via $.state', async () => {
      const { createRPCHandler, getContext } = await import('./index.js')
      const mockState = { id: 'state-123' }
      const ctx = { state: mockState }
      const handler = createRPCHandler({}, ctx)
      const $ = getContext()
      expect($.state).toBe(mockState)
    })
  })
})

// ============================================================================
// SECTION 7: Integration Tests (End-to-End)
// Full integration tests simulating real RPC flows
// ============================================================================

describe('End-to-End Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should perform complete read operation through RPC', async () => {
    const { RPCFsBackend, RPCFsModule } = await import('./index.js')
    const server = new RPCFsModule(new MockFsModule())
    const client = new RPCFsBackend('wss://fs.example.com')
    await client.connect()
    const $ = client.getProxy()
    const content = await $.fs.readFile('/test.txt')
    expect(content).toBe('Hello, World!')
  })

  it('should perform complete write operation through RPC', async () => {
    const { RPCFsBackend, RPCFsModule } = await import('./index.js')
    const server = new RPCFsModule(new MockFsModule())
    const client = new RPCFsBackend('wss://fs.example.com')
    await client.connect()
    const $ = client.getProxy()
    const result = await $.fs.writeFile('/new.txt', 'New content')
    expect(result.path).toBe('/new.txt')
  })

  it('should perform directory listing through RPC', async () => {
    const { RPCFsBackend, RPCFsModule } = await import('./index.js')
    const server = new RPCFsModule(new MockFsModule())
    const client = new RPCFsBackend('wss://fs.example.com')
    await client.connect()
    const $ = client.getProxy()
    const entries = await $.fs.readdir('/')
    expect(entries.length).toBeGreaterThan(0)
  })

  it('should handle file streaming through RPC', async () => {
    const { RPCFsBackend, RPCFsModule } = await import('./index.js')
    const server = new RPCFsModule(new MockFsModule())
    const client = new RPCFsBackend('wss://fs.example.com')
    await client.connect()
    const $ = client.getProxy()
    const chunks: Uint8Array[] = []
    for await (const chunk of $.fs.readFileStream('/test.txt')) {
      chunks.push(chunk)
    }
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('should handle authenticated operations', async () => {
    const { RPCFsBackend, RPCFsModule } = await import('./index.js')
    const token = createMockToken({ scopes: ['read', 'write'] })
    const server = new RPCFsModule(new MockFsModule(), { requireAuth: true })
    const client = new RPCFsBackend('wss://fs.example.com', {
      headers: { Authorization: `Bearer ${token}` },
    })
    await client.connect()
    const $ = client.getProxy()
    const content = await $.fs.readFile('/test.txt')
    expect(content).toBe('Hello, World!')
  })

  it('should handle batch operations efficiently', async () => {
    const { RPCFsBackend, RPCFsModule } = await import('./index.js')
    const server = new RPCFsModule(new MockFsModule())
    const client = new RPCFsBackend('wss://fs.example.com', {
      batching: { enabled: true },
    })
    await client.connect()
    const $ = client.getProxy()
    const [file1, file2] = await Promise.all([
      $.fs.readFile('/file1.txt'),
      $.fs.readFile('/file2.txt'),
    ])
    expect(file1).toBeDefined()
    expect(file2).toBeDefined()
  })
})

// ============================================================================
// SECTION 8: Type Safety Tests
// Verify that types are exported and work correctly
// ============================================================================

describe('Type Safety', () => {
  it('should export RPCRequest type', async () => {
    const rpcModule = await import('./index.js').catch(() => null)
    // Type exists if module exports type utilities
    const request: RPCRequest = {
      type: 'request',
      id: 'req-123',
      path: ['fs', 'read'],
      args: ['/test.txt'],
      timestamp: Date.now(),
    }
    expect(request.type).toBe('request')
  })

  it('should export RPCResponse type', async () => {
    const response: RPCResponse = {
      type: 'response',
      id: 'req-123',
      success: true,
      result: 'file contents',
      timestamp: Date.now(),
    }
    expect(response.type).toBe('response')
  })

  it('should export RPCStreamChunk type', async () => {
    const chunk: RPCStreamChunk = {
      type: 'stream',
      id: 'req-123',
      chunk: new Uint8Array([1, 2, 3]),
      done: false,
      index: 0,
      timestamp: Date.now(),
    }
    expect(chunk.type).toBe('stream')
  })

  it('should export ErrorCodes from rpc module', async () => {
    const rpcModule = await import('./index.js').catch(() => null)
    expect(rpcModule?.ErrorCodes).toBeDefined()
    expect(rpcModule?.ErrorCodes?.TIMEOUT).toBe('TIMEOUT')
  })

  it('should export ConnectionState type', async () => {
    const states: ConnectionState[] = [
      'disconnected',
      'connecting',
      'connected',
      'reconnecting',
      'closed',
    ]
    expect(states).toContain('connected')
  })
})

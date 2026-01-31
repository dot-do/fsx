/**
 * @fileoverview Mock rpc.do Module
 *
 * Mock implementation of the rpc.do module for testing fsx.do RPC integration.
 * Provides mocked versions of:
 * - DO (Durable Object base)
 * - createClient, RPCError
 * - $, createRPCHandler, rpc, createStreamResponse
 * - BinarySerializer, JsonSerializer, createTransport
 * - ErrorCodes, types
 *
 * @category Application
 * @module do/rpc/rpc-mock
 */

// ============================================================================
// ERROR CODES
// ============================================================================

/**
 * RPC Error codes
 */
export const ErrorCodes = {
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

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

// ============================================================================
// TYPES
// ============================================================================

/**
 * Connection state for RPC client
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

/**
 * RPC Request message
 */
export interface RPCRequest {
  type: 'request'
  id: string
  path: string[]
  args: unknown[]
  timestamp: number
}

/**
 * RPC Response message
 */
export interface RPCResponse {
  type: 'response'
  id: string
  success: boolean
  result?: unknown
  error?: RPCErrorData
  timestamp: number
}

/**
 * RPC Error structure
 */
export interface RPCErrorData {
  code: string
  message: string
  stack?: string
  data?: unknown
}

/**
 * Stream chunk for streaming responses
 */
export interface RPCStreamChunk {
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
export interface DOClientOptions {
  url?: string
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
  serializer?: Serializer
  keepalive?: {
    enabled?: boolean
    intervalMs?: number
    timeoutMs?: number
  }
  onTokenRefresh?: () => Promise<string>
  maxRefreshAttempts?: number
}

/**
 * Serializer interface
 */
export interface Serializer {
  encode(msg: unknown): ArrayBuffer
  decode(data: ArrayBuffer): unknown
}

// ============================================================================
// RPC ERROR CLASS
// ============================================================================

/**
 * RPC Error class
 */
export class RPCError extends Error {
  code: string
  data?: unknown
  override stack?: string

  constructor(code: string, message: string, data?: unknown) {
    super(message)
    this.name = 'RPCError'
    this.code = code
    this.data = data
  }
}

// ============================================================================
// SERIALIZERS
// ============================================================================

/**
 * Binary serializer (mock capnproto with JSON fallback)
 */
export class BinarySerializer implements Serializer {
  encode(msg: unknown): ArrayBuffer {
    // Check for circular references and symbols
    const seen = new WeakSet()
    const checkCircular = (obj: unknown, path: string = ''): void => {
      if (obj === null || typeof obj !== 'object') {
        if (typeof obj === 'symbol') {
          throw new RPCError(ErrorCodes.SERIALIZATION_ERROR, 'Symbols are not serializable')
        }
        return
      }
      if (seen.has(obj as object)) {
        throw new RPCError(ErrorCodes.SERIALIZATION_ERROR, `circular reference detected at ${path}`)
      }
      seen.add(obj as object)
      if (Array.isArray(obj)) {
        obj.forEach((item, i) => checkCircular(item, `${path}[${i}]`))
      } else {
        for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
          if (typeof value === 'symbol') {
            throw new RPCError(ErrorCodes.SERIALIZATION_ERROR, 'Symbols are not serializable')
          }
          checkCircular(value, `${path}.${key}`)
        }
      }
    }

    checkCircular(msg)

    // Pre-process to convert special types before JSON.stringify
    // (Date.toJSON is called before replacer, so we need to convert first)
    const preprocess = (obj: unknown): unknown => {
      if (obj instanceof Date) {
        return { __type: 'Date', value: obj.toISOString() }
      }
      if (obj instanceof Uint8Array) {
        return { __type: 'Uint8Array', value: Array.from(obj) }
      }
      if (obj instanceof ArrayBuffer) {
        return { __type: 'ArrayBuffer', value: Array.from(new Uint8Array(obj)) }
      }
      if (Array.isArray(obj)) {
        return obj.map(preprocess)
      }
      if (obj && typeof obj === 'object') {
        const result: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(obj)) {
          result[key] = preprocess(value)
        }
        return result
      }
      return obj
    }

    const processed = preprocess(msg)
    const json = JSON.stringify(processed)
    const encoder = new TextEncoder()
    return encoder.encode(json).buffer as ArrayBuffer
  }

  decode(data: ArrayBuffer): unknown {
    const decoder = new TextDecoder()
    const json = decoder.decode(data)

    // Custom reviver to restore special types
    const reviver = (_key: string, value: unknown): unknown => {
      if (value && typeof value === 'object' && '__type' in value) {
        const typed = value as { __type: string; value: unknown }
        if (typed.__type === 'Date') {
          return new Date(typed.value as string)
        }
        if (typed.__type === 'Uint8Array') {
          return new Uint8Array(typed.value as number[])
        }
        if (typed.__type === 'ArrayBuffer') {
          return new Uint8Array(typed.value as number[]).buffer
        }
      }
      return value
    }

    return JSON.parse(json, reviver)
  }
}

/**
 * JSON serializer (simple fallback)
 */
export class JsonSerializer implements Serializer {
  encode(msg: unknown): ArrayBuffer {
    const json = JSON.stringify(msg)
    const encoder = new TextEncoder()
    return encoder.encode(json).buffer as ArrayBuffer
  }

  decode(data: ArrayBuffer): unknown {
    const decoder = new TextDecoder()
    const json = decoder.decode(data)
    return JSON.parse(json)
  }
}

// ============================================================================
// TRANSPORT
// ============================================================================

type TransportEventType = 'connect' | 'disconnect' | 'error' | 'message' | 'reconnect'
type TransportEventHandler = (...args: unknown[]) => void

/**
 * Create transport for RPC communication
 */
export function createTransport(url: string, options: DOClientOptions = {}) {
  const handlers = new Map<TransportEventType, Set<TransportEventHandler>>()
  let connected = false
  let lastPong = Date.now()
  const reconnectEnabled = options.reconnect?.enabled ?? false

  const transport = {
    url,
    options,
    headers: options.headers ?? {},

    get isConnected() {
      return connected
    },

    get batchingEnabled() {
      return options.batching?.enabled ?? false
    },

    get keepaliveInterval() {
      return options.keepalive?.intervalMs ?? 30000
    },

    get keepaliveTimeout() {
      return options.keepalive?.timeoutMs ?? 5000
    },

    get lastPongTime() {
      return lastPong
    },

    async connect() {
      if (url.includes('unreachable') || url.includes('slow')) {
        // Small delay to simulate async behavior
        await Promise.resolve()
        const error = new RPCError(
          ErrorCodes.CONNECTION_FAILED,
          url.includes('slow') ? 'Connection timeout' : 'Connection refused'
        )
        transport.emit('error', error)
        throw error
      }
      // Simulate async connection with microtask delay
      await Promise.resolve()
      connected = true
      transport.emit('connect')
    },

    async close() {
      connected = false
      transport.emit('disconnect')
    },

    on(event: TransportEventType, handler: TransportEventHandler) {
      if (!handlers.has(event)) {
        handlers.set(event, new Set())
      }
      handlers.get(event)!.add(handler)
    },

    off(event: TransportEventType, handler: TransportEventHandler) {
      handlers.get(event)?.delete(handler)
    },

    emit(event: TransportEventType, ...args: unknown[]) {
      handlers.get(event)?.forEach((h) => h(...args))
    },

    simulatePong() {
      // Add 1ms to ensure the timestamp increases
      lastPong = Date.now() + 1
    },

    simulateKeepaliveTimeout() {
      if (reconnectEnabled) {
        transport.emit('reconnect', 1)
      }
    },

    correlateResponses(responses: RPCResponse[]) {
      return responses
    },
  }

  return transport
}

// ============================================================================
// DURABLE OBJECT BASE
// ============================================================================

/**
 * Mock Durable Object base class
 */
export class DO {
  state: unknown
  env: unknown

  constructor(state: unknown, env: unknown) {
    this.state = state
    this.env = env
  }
}

// ============================================================================
// CLIENT
// ============================================================================

/**
 * Create RPC client
 */
export function createClient(url: string, options: DOClientOptions = {}) {
  return createTransport(url, options)
}

// ============================================================================
// SERVER HANDLER
// ============================================================================

interface RPCHandlerContext {
  storage?: {
    sql?: unknown
    get?: unknown
    put?: unknown
  }
  state?: unknown
}

let currentContext: { instance?: unknown; storage?: unknown; state?: unknown; sql?: unknown } = {}

/**
 * Get current RPC context
 */
export function getContext() {
  return {
    get instance() {
      return currentContext.instance
    },
    get storage() {
      return currentContext.storage
    },
    get state() {
      return currentContext.state
    },
    get sql() {
      return currentContext.storage && typeof currentContext.storage === 'object' && 'sql' in currentContext.storage
        ? (currentContext.storage as { sql: unknown }).sql
        : undefined
    },
  }
}

/**
 * Create RPC handler from instance
 */
export function createRPCHandler(instance: unknown, ctx: RPCHandlerContext = {}) {
  const registeredMethods: string[] = []

  // Register methods from instance (including prototype methods for class instances)
  const registerMethods = (obj: unknown, prefix: string = '') => {
    if (!obj || typeof obj !== 'object') return

    // Get own properties
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (typeof value === 'function') {
        registeredMethods.push(path)
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        registerMethods(value, path)
      }
    }

    // Get prototype methods for class instances
    const proto = Object.getPrototypeOf(obj)
    if (proto && proto !== Object.prototype) {
      const protoMethods = Object.getOwnPropertyNames(proto).filter(
        (name) => name !== 'constructor' && typeof (obj as Record<string, unknown>)[name] === 'function'
      )
      for (const name of protoMethods) {
        const path = prefix ? `${prefix}.${name}` : name
        if (!registeredMethods.includes(path)) {
          registeredMethods.push(path)
        }
      }
    }
  }

  registerMethods(instance)

  // Set context
  currentContext = {
    instance,
    storage: ctx.storage,
    state: ctx.state,
  }

  const handler = {
    registeredMethods,

    async handleRequest(request: RPCRequest): Promise<RPCResponse> {
      const { id, path, args, timestamp: _timestamp } = request

      // Resolve method from path
      let target: unknown = instance
      for (const segment of path) {
        if (!target || typeof target !== 'object') {
          throw new RPCError(ErrorCodes.METHOD_NOT_FOUND, `Method not found: ${path.join('.')}`, { path })
        }
        target = (target as Record<string, unknown>)[segment]
      }

      if (typeof target !== 'function') {
        throw new RPCError(ErrorCodes.METHOD_NOT_FOUND, `Method not found: ${path.join('.')}`, { path })
      }

      const method = target as (...args: unknown[]) => unknown
      const result = await method(...args)

      return {
        type: 'response',
        id,
        success: true,
        result,
        timestamp: Date.now(),
      }
    },
  }

  return handler
}

/**
 * RPC decorator (no-op for now)
 */
export function rpc(_target: unknown, _propertyKey: string, descriptor: PropertyDescriptor) {
  return descriptor
}

/**
 * Create stream response helper
 */
export function createStreamResponse(generator: AsyncGenerator<unknown>) {
  return generator
}

// ============================================================================
// $ SYMBOL
// ============================================================================

/**
 * Server context symbol
 */
export const $ = Symbol('rpc.do.$')

// ============================================================================
// TYPES RE-EXPORT
// ============================================================================

export const types = {
  RPCRequest: {} as RPCRequest,
  RPCResponse: {} as RPCResponse,
  RPCStreamChunk: {} as RPCStreamChunk,
  DOClientOptions: {} as DOClientOptions,
  ConnectionState: '' as ConnectionState,
}

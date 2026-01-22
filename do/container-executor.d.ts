/**
 * CloudflareContainerExecutor - External executor integration for Cloudflare Containers
 *
 * This module provides an executor interface for running commands in Cloudflare Containers,
 * enabling:
 * - HTTP-based command execution via exec endpoint
 * - WebSocket streaming for real-time output
 * - Session isolation for multi-tenant workloads
 * - Integration with FsModule for filesystem operations
 *
 * The executor acts as a bridge between the BashModule and external Cloudflare Containers,
 * allowing heavy or long-running operations to be offloaded to container instances.
 *
 * @example
 * ```typescript
 * // Using as external executor for BashModule
 * const executor = new CloudflareContainerExecutor({
 *   container: env.CONTAINER,
 *   sessionId: 'user-123',
 * })
 *
 * // Execute a command
 * const result = await executor.exec('npm install')
 *
 * // Stream output via WebSocket
 * const ws = executor.createStreamingExec('npm run build')
 * ```
 *
 * @module durable-object/container-executor
 */
/**
 * Container binding interface from @cloudflare/containers
 * This represents the binding exposed in wrangler.toml/jsonc
 */
export interface ContainerBinding {
    /** Get a container instance by ID or name */
    get(id: string | DurableObjectId): ContainerInstance;
    /** Get ID from name */
    idFromName(name: string): DurableObjectId;
    /** Create a new unique ID */
    newUniqueId(): DurableObjectId;
}
/**
 * Container instance interface
 * Represents a running container that can receive requests
 */
export interface ContainerInstance {
    /** Fetch method for HTTP requests (supports WebSocket upgrade) */
    fetch(request: Request): Promise<Response>;
    /** Container-specific fetch with port targeting */
    containerFetch(request: Request, port?: number): Promise<Response>;
    containerFetch(url: string | URL, init?: RequestInit, port?: number): Promise<Response>;
}
/**
 * Configuration for CloudflareContainerExecutor
 */
export interface ContainerExecutorConfig {
    /** Container binding from environment */
    container: ContainerBinding;
    /** Session ID for container instance isolation */
    sessionId?: string;
    /** Port for exec HTTP endpoint (default: 8080) */
    execPort?: number;
    /** Port for WebSocket streaming (default: 8081) */
    wsPort?: number;
    /** Timeout for exec operations in milliseconds (default: 300000 = 5 min) */
    timeout?: number;
    /** Base URL path for exec endpoint (default: '/exec') */
    execPath?: string;
    /** Base URL path for WebSocket streaming (default: '/ws') */
    wsPath?: string;
    /** Environment variables to pass to commands */
    env?: Record<string, string>;
    /** Working directory for command execution */
    cwd?: string;
    /** Enable command logging */
    enableLogging?: boolean;
}
/**
 * Result of a command execution
 */
export interface ContainerExecResult {
    /** Exit code of the command (0 = success) */
    exitCode: number;
    /** Standard output */
    stdout: string;
    /** Standard error */
    stderr: string;
    /** Whether the command succeeded */
    success: boolean;
    /** Command that was executed */
    command: string;
    /** Session ID used */
    sessionId: string;
    /** Execution duration in milliseconds */
    duration: number;
    /** Whether the command was killed (timeout, signal) */
    killed: boolean;
    /** Signal that killed the command (if any) */
    signal?: string;
}
/**
 * Options for exec operations
 */
export interface ExecOptions {
    /** Timeout in milliseconds */
    timeout?: number;
    /** Working directory */
    cwd?: string;
    /** Environment variables */
    env?: Record<string, string>;
    /** Input to send to stdin */
    stdin?: string;
    /** Whether to combine stdout and stderr */
    combineOutput?: boolean;
    /** Abort signal for cancellation */
    signal?: AbortSignal;
}
/**
 * Streaming exec event types
 */
export type StreamingExecEvent = {
    type: 'stdout';
    data: string;
} | {
    type: 'stderr';
    data: string;
} | {
    type: 'exit';
    exitCode: number;
    signal?: string;
} | {
    type: 'error';
    message: string;
};
/**
 * Streaming exec session handle
 */
export interface StreamingExecSession {
    /** Session ID */
    sessionId: string;
    /** WebSocket connection (if using WebSocket transport) */
    websocket?: WebSocket;
    /** Async iterator for events */
    events: AsyncIterable<StreamingExecEvent>;
    /** Send input to stdin */
    write(data: string): Promise<void>;
    /** Send signal to process */
    kill(signal?: string): Promise<void>;
    /** Close the session */
    close(): void;
    /** Promise that resolves when execution completes */
    done: Promise<ContainerExecResult>;
}
/**
 * Container state information
 */
export interface ContainerState {
    /** Current status */
    status: 'running' | 'stopped' | 'starting' | 'stopping' | 'unknown';
    /** Last state change timestamp */
    lastChange: number;
    /** Exit code if stopped */
    exitCode?: number;
}
/**
 * CloudflareContainerExecutor - External executor for Cloudflare Containers
 *
 * This class provides command execution capabilities by communicating with
 * Cloudflare Container instances via HTTP and WebSocket.
 *
 * Architecture:
 * - Each session gets its own container instance for isolation
 * - Commands are sent via HTTP POST to the exec endpoint
 * - Real-time output can be streamed via WebSocket
 * - The container should run a compatible exec server (see ExecServer)
 */
export declare class CloudflareContainerExecutor {
    private container;
    private sessionId;
    private execPort;
    private wsPort;
    private timeout;
    private execPath;
    private wsPath;
    private defaultEnv;
    private defaultCwd;
    private _enableLogging;
    private instance;
    constructor(config: ContainerExecutorConfig);
    /**
     * Get or create the container instance for this session
     */
    private getContainerInstance;
    /**
     * Get the current session ID
     */
    getSessionId(): string;
    /**
     * Change the session ID (creates new container instance)
     */
    setSessionId(sessionId: string): void;
    /**
     * Create a new isolated session
     * @returns New session ID
     */
    createSession(): string;
    /**
     * Execute a command in the container via HTTP
     *
     * @param command - Command to execute
     * @param options - Execution options
     * @returns Execution result
     */
    exec(command: string, options?: ExecOptions): Promise<ContainerExecResult>;
    /**
     * Execute multiple commands in sequence
     *
     * @param commands - Array of commands to execute
     * @param options - Execution options (shared across all commands)
     * @returns Array of execution results
     */
    execAll(commands: string[], options?: ExecOptions): Promise<ContainerExecResult[]>;
    /**
     * Execute a command and return only stdout (throws on error)
     */
    execStdout(command: string, options?: ExecOptions): Promise<string>;
    /**
     * Create a streaming exec session via WebSocket
     *
     * This allows real-time streaming of stdout/stderr and interactive input.
     *
     * @param command - Command to execute
     * @param options - Execution options
     * @returns Streaming session handle
     */
    createStreamingExec(command: string, options?: ExecOptions): StreamingExecSession;
    /**
     * Get the current state of the container
     */
    getState(): Promise<ContainerState>;
    /**
     * Check if the container is ready to accept commands
     */
    isReady(): Promise<boolean>;
    /**
     * Wait for the container to be ready
     */
    waitUntilReady(timeoutMs?: number): Promise<boolean>;
    /**
     * Set the default working directory
     */
    setCwd(cwd: string): void;
    /**
     * Get the default working directory
     */
    getCwd(): string;
    /**
     * Set an environment variable
     */
    setEnv(key: string, value: string): void;
    /**
     * Get an environment variable
     */
    getEnv(key: string): string | undefined;
    /**
     * Get all environment variables
     */
    getAllEnv(): Record<string, string>;
    /**
     * Clear all environment variables
     */
    clearEnv(): void;
}
/**
 * Protocol definition for the exec server that runs inside the container.
 *
 * The container should expose:
 * 1. HTTP POST /exec - Execute a command and return result
 * 2. WebSocket /ws - Streaming command execution
 * 3. GET /health - Health check endpoint
 *
 * HTTP Exec Request:
 * ```json
 * {
 *   "command": "ls -la",
 *   "cwd": "/app",
 *   "env": {"NODE_ENV": "production"},
 *   "stdin": "input data",
 *   "combineOutput": false,
 *   "timeout": 30000
 * }
 * ```
 *
 * HTTP Exec Response:
 * ```json
 * {
 *   "exitCode": 0,
 *   "stdout": "file1.txt\nfile2.txt",
 *   "stderr": "",
 *   "killed": false,
 *   "signal": null
 * }
 * ```
 *
 * WebSocket Messages (server -> client):
 * - { type: "stdout", data: "..." }
 * - { type: "stderr", data: "..." }
 * - { type: "exit", exitCode: 0, signal?: "SIGTERM" }
 * - { type: "error", message: "..." }
 *
 * WebSocket Messages (client -> server):
 * - { type: "stdin", data: "..." }
 * - { type: "signal", signal: "SIGTERM" }
 */
/**
 * Create a CloudflareContainerExecutor from environment bindings
 *
 * @example
 * ```typescript
 * const executor = createContainerExecutor(env.CONTAINER, 'user-session-123')
 * const result = await executor.exec('echo hello')
 * ```
 */
export declare function createContainerExecutor(container: ContainerBinding, sessionId?: string, options?: Partial<ContainerExecutorConfig>): CloudflareContainerExecutor;
/**
 * Create an isolated container executor with a new session
 */
export declare function createIsolatedExecutor(container: ContainerBinding, options?: Partial<ContainerExecutorConfig>): CloudflareContainerExecutor;
/**
 * Interface for classes that have container executor capability
 */
export interface HasContainerExecutor {
    $: {
        exec: CloudflareContainerExecutor;
        [key: string]: unknown;
    };
}
/**
 * Extended WorkflowContext with exec capability
 */
export interface WithExecContext {
    exec: CloudflareContainerExecutor;
    [key: string]: unknown;
}
//# sourceMappingURL=container-executor.d.ts.map
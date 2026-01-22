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
// ============================================================================
// CLOUDFLARE CONTAINER EXECUTOR
// ============================================================================
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
export class CloudflareContainerExecutor {
    container;
    sessionId;
    execPort;
    wsPort;
    timeout;
    execPath;
    wsPath;
    defaultEnv;
    defaultCwd;
    // Reserved for future logging implementation
    _enableLogging;
    instance = null;
    constructor(config) {
        this.container = config.container;
        this.sessionId = config.sessionId ?? crypto.randomUUID();
        this.execPort = config.execPort ?? 8080;
        this.wsPort = config.wsPort ?? 8081;
        this.timeout = config.timeout ?? 300000; // 5 minutes
        this.execPath = config.execPath ?? '/exec';
        this.wsPath = config.wsPath ?? '/ws';
        this.defaultEnv = config.env ?? {};
        this.defaultCwd = config.cwd ?? '/';
        this._enableLogging = config.enableLogging ?? false;
    }
    // ===========================================================================
    // INSTANCE MANAGEMENT
    // ===========================================================================
    /**
     * Get or create the container instance for this session
     */
    getContainerInstance() {
        if (!this.instance) {
            const id = this.container.idFromName(this.sessionId);
            this.instance = this.container.get(id);
        }
        return this.instance;
    }
    /**
     * Get the current session ID
     */
    getSessionId() {
        return this.sessionId;
    }
    /**
     * Change the session ID (creates new container instance)
     */
    setSessionId(sessionId) {
        this.sessionId = sessionId;
        this.instance = null; // Reset instance to create new one
    }
    /**
     * Create a new isolated session
     * @returns New session ID
     */
    createSession() {
        const newSessionId = crypto.randomUUID();
        this.setSessionId(newSessionId);
        return newSessionId;
    }
    // ===========================================================================
    // HTTP EXEC OPERATIONS
    // ===========================================================================
    /**
     * Execute a command in the container via HTTP
     *
     * @param command - Command to execute
     * @param options - Execution options
     * @returns Execution result
     */
    async exec(command, options = {}) {
        const startTime = Date.now();
        const instance = this.getContainerInstance();
        const timeout = options.timeout ?? this.timeout;
        const cwd = options.cwd ?? this.defaultCwd;
        const env = { ...this.defaultEnv, ...options.env };
        // Build request body
        const body = JSON.stringify({
            command,
            cwd,
            env,
            stdin: options.stdin,
            combineOutput: options.combineOutput ?? false,
            timeout,
        });
        // Create request
        const url = `http://localhost:${this.execPort}${this.execPath}`;
        const request = new Request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Id': this.sessionId,
            },
            body,
            signal: options.signal,
        });
        try {
            // Execute via containerFetch
            const response = await instance.containerFetch(request, this.execPort);
            if (!response.ok) {
                const errorText = await response.text();
                return {
                    exitCode: 1,
                    stdout: '',
                    stderr: `Container exec failed: ${response.status} ${errorText}`,
                    success: false,
                    command,
                    sessionId: this.sessionId,
                    duration: Date.now() - startTime,
                    killed: false,
                };
            }
            const result = (await response.json());
            return {
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
                success: result.exitCode === 0,
                command,
                sessionId: this.sessionId,
                duration: Date.now() - startTime,
                killed: result.killed ?? false,
                signal: result.signal,
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const isAborted = error instanceof Error && error.name === 'AbortError';
            return {
                exitCode: isAborted ? 130 : 1,
                stdout: '',
                stderr: `Exec error: ${message}`,
                success: false,
                command,
                sessionId: this.sessionId,
                duration: Date.now() - startTime,
                killed: isAborted,
                signal: isAborted ? 'SIGINT' : undefined,
            };
        }
    }
    /**
     * Execute multiple commands in sequence
     *
     * @param commands - Array of commands to execute
     * @param options - Execution options (shared across all commands)
     * @returns Array of execution results
     */
    async execAll(commands, options = {}) {
        const results = [];
        for (const command of commands) {
            const result = await this.exec(command, options);
            results.push(result);
            // Stop on first failure unless we add a flag to continue
            if (!result.success) {
                break;
            }
        }
        return results;
    }
    /**
     * Execute a command and return only stdout (throws on error)
     */
    async execStdout(command, options = {}) {
        const result = await this.exec(command, options);
        if (!result.success) {
            throw new Error(result.stderr || `Command failed with exit code ${result.exitCode}`);
        }
        return result.stdout;
    }
    // ===========================================================================
    // WEBSOCKET STREAMING
    // ===========================================================================
    /**
     * Create a streaming exec session via WebSocket
     *
     * This allows real-time streaming of stdout/stderr and interactive input.
     *
     * @param command - Command to execute
     * @param options - Execution options
     * @returns Streaming session handle
     */
    createStreamingExec(command, options = {}) {
        const instance = this.getContainerInstance();
        const cwd = options.cwd ?? this.defaultCwd;
        const env = { ...this.defaultEnv, ...options.env };
        // Create WebSocket upgrade request
        const wsUrl = `ws://localhost:${this.wsPort}${this.wsPath}`;
        const params = new URLSearchParams({
            command,
            cwd,
            sessionId: this.sessionId,
        });
        // Add env as JSON
        if (Object.keys(env).length > 0) {
            params.set('env', JSON.stringify(env));
        }
        const fullUrl = `${wsUrl}?${params.toString()}`;
        // Create event queue for async iteration
        const eventQueue = [];
        let resolveNextEvent = null;
        let closed = false;
        let doneResolver = null;
        let doneRejecter = null;
        const startTime = Date.now();
        let stdout = '';
        let stderr = '';
        let exitCode = 0;
        let killed = false;
        let signal;
        // Create done promise
        const donePromise = new Promise((resolve, reject) => {
            doneResolver = resolve;
            doneRejecter = reject;
        });
        // We need to use fetch for WebSocket upgrade through the container
        const upgradeRequest = new Request(fullUrl, {
            headers: {
                Upgrade: 'websocket',
                Connection: 'Upgrade',
                'X-Session-Id': this.sessionId,
            },
        });
        // Note: The actual WebSocket connection happens through container.fetch()
        // The container proxies the WebSocket connection to the exec server
        // Create async iterator for events
        const events = {
            [Symbol.asyncIterator]() {
                return {
                    async next() {
                        if (closed && eventQueue.length === 0) {
                            return { done: true, value: undefined };
                        }
                        if (eventQueue.length > 0) {
                            return { done: false, value: eventQueue.shift() };
                        }
                        // Wait for next event
                        return new Promise((resolve) => {
                            resolveNextEvent = resolve;
                        });
                    },
                };
            },
        };
        // Process incoming WebSocket message
        const processMessage = (data) => {
            try {
                const event = JSON.parse(data);
                // Accumulate output
                if (event.type === 'stdout') {
                    stdout += event.data;
                }
                else if (event.type === 'stderr') {
                    stderr += event.data;
                }
                else if (event.type === 'exit') {
                    exitCode = event.exitCode;
                    signal = event.signal;
                    killed = !!event.signal;
                }
                // Push to queue or resolve waiting iterator
                if (resolveNextEvent) {
                    resolveNextEvent({ done: false, value: event });
                    resolveNextEvent = null;
                }
                else {
                    eventQueue.push(event);
                }
                // Resolve done promise on exit
                if (event.type === 'exit' && doneResolver) {
                    doneResolver({
                        exitCode,
                        stdout,
                        stderr,
                        success: exitCode === 0,
                        command,
                        sessionId: this.sessionId,
                        duration: Date.now() - startTime,
                        killed,
                        signal,
                    });
                }
            }
            catch {
                // Ignore parse errors
            }
        };
        // Note: In a real implementation, we would initiate the WebSocket connection
        // through container.fetch() with the upgrade request. The container handles
        // proxying the WebSocket to the internal exec server.
        //
        // For now, we return a session object that the caller can use to
        // interact with the WebSocket connection.
        let websocket;
        // Initiate connection (async, will be handled by caller)
        const initConnection = async () => {
            try {
                const response = await instance.fetch(upgradeRequest);
                // The response should be a WebSocket upgrade response in CF Workers runtime
                // The webSocket property exists on upgraded responses in Cloudflare Workers
                websocket = response.webSocket;
                if (websocket) {
                    websocket.accept();
                    websocket.addEventListener('message', (event) => {
                        processMessage(String(event.data));
                    });
                    websocket.addEventListener('close', () => {
                        closed = true;
                        if (resolveNextEvent) {
                            resolveNextEvent({ done: true, value: undefined });
                        }
                    });
                    websocket.addEventListener('error', (_event) => {
                        const errorEvent = {
                            type: 'error',
                            message: 'WebSocket error',
                        };
                        if (resolveNextEvent) {
                            resolveNextEvent({ done: false, value: errorEvent });
                            resolveNextEvent = null;
                        }
                        else {
                            eventQueue.push(errorEvent);
                        }
                        if (doneRejecter) {
                            doneRejecter(new Error('WebSocket error'));
                        }
                    });
                }
            }
            catch (error) {
                closed = true;
                if (doneRejecter) {
                    doneRejecter(error instanceof Error ? error : new Error(String(error)));
                }
            }
        };
        // Start connection in background
        initConnection();
        return {
            sessionId: this.sessionId,
            get websocket() {
                return websocket;
            },
            events,
            async write(data) {
                if (websocket && websocket.readyState === WebSocket.OPEN) {
                    websocket.send(JSON.stringify({ type: 'stdin', data }));
                }
            },
            async kill(sig = 'SIGTERM') {
                if (websocket && websocket.readyState === WebSocket.OPEN) {
                    websocket.send(JSON.stringify({ type: 'signal', signal: sig }));
                }
            },
            close() {
                if (websocket) {
                    websocket.close();
                }
                closed = true;
            },
            done: donePromise,
        };
    }
    // ===========================================================================
    // CONTAINER STATE
    // ===========================================================================
    /**
     * Get the current state of the container
     */
    async getState() {
        const instance = this.getContainerInstance();
        try {
            const request = new Request(`http://localhost:${this.execPort}/health`, {
                method: 'GET',
                headers: {
                    'X-Session-Id': this.sessionId,
                },
            });
            const response = await instance.containerFetch(request, this.execPort);
            if (response.ok) {
                const state = (await response.json());
                return state;
            }
            return {
                status: 'unknown',
                lastChange: Date.now(),
            };
        }
        catch {
            return {
                status: 'stopped',
                lastChange: Date.now(),
            };
        }
    }
    /**
     * Check if the container is ready to accept commands
     */
    async isReady() {
        const state = await this.getState();
        return state.status === 'running';
    }
    /**
     * Wait for the container to be ready
     */
    async waitUntilReady(timeoutMs = 30000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            if (await this.isReady()) {
                return true;
            }
            // Wait 500ms before retry
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return false;
    }
    // ===========================================================================
    // UTILITY METHODS
    // ===========================================================================
    /**
     * Set the default working directory
     */
    setCwd(cwd) {
        this.defaultCwd = cwd;
    }
    /**
     * Get the default working directory
     */
    getCwd() {
        return this.defaultCwd;
    }
    /**
     * Set an environment variable
     */
    setEnv(key, value) {
        this.defaultEnv[key] = value;
    }
    /**
     * Get an environment variable
     */
    getEnv(key) {
        return this.defaultEnv[key];
    }
    /**
     * Get all environment variables
     */
    getAllEnv() {
        return { ...this.defaultEnv };
    }
    /**
     * Clear all environment variables
     */
    clearEnv() {
        this.defaultEnv = {};
    }
}
// ============================================================================
// EXEC SERVER PROTOCOL
// ============================================================================
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
// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================
/**
 * Create a CloudflareContainerExecutor from environment bindings
 *
 * @example
 * ```typescript
 * const executor = createContainerExecutor(env.CONTAINER, 'user-session-123')
 * const result = await executor.exec('echo hello')
 * ```
 */
export function createContainerExecutor(container, sessionId, options = {}) {
    return new CloudflareContainerExecutor({
        container,
        sessionId,
        ...options,
    });
}
/**
 * Create an isolated container executor with a new session
 */
export function createIsolatedExecutor(container, options = {}) {
    return new CloudflareContainerExecutor({
        container,
        sessionId: crypto.randomUUID(),
        ...options,
    });
}
//# sourceMappingURL=container-executor.js.map
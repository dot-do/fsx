/**
 * Storage Backend Interfaces
 *
 * Common interfaces for storage backends in fsx. These interfaces define
 * the contract that storage implementations must fulfill, enabling:
 *
 * - Consistent API across R2Storage, SQLiteMetadata, and TieredFS
 * - Type-safe storage operations with proper error handling
 * - Optional instrumentation hooks for metrics and logging
 * - Interchangeable storage backends for testing and flexibility
 *
 * @module storage/interfaces
 */
/**
 * Storage operation error with structured metadata.
 *
 * Provides consistent error information across all storage backends,
 * enabling proper error handling and logging.
 *
 * @example
 * ```typescript
 * try {
 *   await storage.get('/nonexistent')
 * } catch (e) {
 *   if (e instanceof StorageError && e.code === 'ENOENT') {
 *     // Handle missing file
 *   }
 * }
 * ```
 */
export class StorageError extends Error {
    /** Error code for programmatic handling */
    code;
    /** Path/key that caused the error (if applicable) */
    path;
    /** Original cause of the error (for debugging) */
    cause;
    /** Storage operation that failed */
    operation;
    constructor(code, message, options) {
        super(message);
        this.name = 'StorageError';
        this.code = code;
        this.path = options?.path;
        this.cause = options?.cause;
        this.operation = options?.operation;
        // Maintains proper stack trace for where error was thrown
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, StorageError);
        }
    }
    /**
     * Create a "not found" error.
     */
    static notFound(path, operation) {
        return new StorageError('ENOENT', `Not found: ${path}`, { path, operation });
    }
    /**
     * Create an "already exists" error.
     */
    static exists(path, operation) {
        return new StorageError('EEXIST', `Already exists: ${path}`, { path, operation });
    }
    /**
     * Create an "invalid argument" error.
     */
    static invalidArg(message, path, operation) {
        return new StorageError('EINVAL', message, { path, operation });
    }
    /**
     * Create an I/O error from an underlying cause.
     */
    static io(cause, path, operation) {
        return new StorageError('EIO', `I/O error: ${cause.message}`, { path, cause, operation });
    }
    /**
     * Convert to a plain object for logging/serialization.
     */
    toJSON() {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            path: this.path,
            operation: this.operation,
        };
    }
}
// =============================================================================
// Helper Functions
// =============================================================================
/**
 * Create a storage operation context for instrumentation.
 *
 * @param operation - Operation name
 * @param path - Target path
 * @param options - Additional context
 * @returns Operation context
 */
export function createOperationContext(operation, path, options) {
    return {
        operation,
        path,
        tier: options?.tier,
        size: options?.size,
        startTime: Date.now(),
    };
}
/**
 * Create a storage operation result for instrumentation.
 *
 * @param ctx - Operation context
 * @param options - Result options
 * @returns Operation result
 */
export function createOperationResult(ctx, options) {
    return {
        success: options.success,
        durationMs: Date.now() - ctx.startTime,
        error: options.error,
        size: options.size,
        tier: options.tier,
        migrated: options.migrated,
    };
}
/**
 * Wrap a storage operation with instrumentation hooks.
 *
 * @param hooks - Optional instrumentation hooks
 * @param operation - Operation name
 * @param path - Target path
 * @param fn - Operation function to execute
 * @returns Operation result
 */
export async function withInstrumentation(hooks, operation, path, fn) {
    const ctx = createOperationContext(operation, path);
    hooks?.onOperationStart?.(ctx);
    try {
        const result = await fn();
        hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: true }));
        return result;
    }
    catch (error) {
        const storageError = error instanceof StorageError ? error : StorageError.io(error, path, operation);
        hooks?.onOperationEnd?.(ctx, createOperationResult(ctx, { success: false, error: storageError }));
        throw error;
    }
}
//# sourceMappingURL=interfaces.js.map
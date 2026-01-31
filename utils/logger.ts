/**
 * Logger utility for fsx
 *
 * Provides a simple logger factory that creates namespaced loggers
 * for different components of the fsx system.
 */

export interface Logger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

/**
 * Create a namespaced logger instance.
 *
 * @param prefix - Prefix to prepend to all log messages (e.g., '[fsx-cli]')
 * @returns Logger instance with info, warn, error, and debug methods
 *
 * @example
 * ```typescript
 * const logger = createLogger('[fsx-cli]')
 * logger.info('Starting up...')  // [fsx-cli] Starting up...
 * logger.error('Fatal error:', err)
 * ```
 */
export function createLogger(prefix: string): Logger {
  return {
    info: (...args: unknown[]) => console.info(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
    debug: (...args: unknown[]) => {
      // Debug logging is disabled in production
      // Enable by setting FSX_DEBUG=1 environment variable
      if (typeof process !== 'undefined' && process.env?.FSX_DEBUG) {
        console.debug(prefix, ...args)
      }
    },
  }
}

/**
 * Default logger instance with [fsx] prefix
 */
export const logger: Logger = createLogger('[fsx]')

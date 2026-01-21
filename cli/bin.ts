#!/usr/bin/env node
/**
 * fsx CLI entry point
 *
 * This is the main executable for the fsx CLI.
 * It provides filesystem operations using an in-memory backend for local testing
 * and demonstration purposes.
 *
 * Usage:
 *   npx fsx ls /
 *   npx fsx cat /hello.txt
 *   npx fsx mkdir /data
 */

import { runCLI } from './index.js'
import { FSx } from '../core/fsx.js'
import { MemoryBackend } from '../core/backend.js'
import type { Dirent } from '../core/types.js'
import { createLogger } from '../../utils/logger'

const logger = createLogger('[fsx-cli]')

// Create a shared filesystem instance
const backend = new MemoryBackend()
const fs = new FSx(backend)

// Adapter to make FSx compatible with the CLI's MockFS interface
const cliFs = {
  readFile: async (path: string): Promise<string> => {
    const result = await fs.readFile(path, 'utf-8')
    return typeof result === 'string' ? result : new TextDecoder().decode(result)
  },
  readFileBytes: async (path: string): Promise<Uint8Array> => {
    const result = await fs.readFile(path)
    return typeof result === 'string' ? new TextEncoder().encode(result) : result
  },
  writeFile: async (path: string, content: string | Uint8Array): Promise<void> => {
    await fs.writeFile(path, content)
  },
  readdir: async (path: string): Promise<string[]> => {
    const entries = await fs.readdir(path)
    // Handle both string[] and Dirent[] returns
    return entries.map((e: string | Dirent) => typeof e === 'string' ? e : e.name)
  },
  readdirWithTypes: async (path: string): Promise<Array<{ name: string; type: 'file' | 'directory' | 'symlink' }>> => {
    const entries = await fs.readdir(path, { withFileTypes: true }) as Dirent[]
    return entries.map((e: Dirent) => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' as const : e.isSymbolicLink() ? 'symlink' as const : 'file' as const
    }))
  },
  stat: async (path: string): Promise<{ size: number; mode: number; mtime: number; type: 'file' | 'directory' | 'symlink' }> => {
    const stats = await fs.stat(path)
    return {
      size: stats.size,
      mode: stats.mode,
      mtime: stats.mtimeMs,
      type: stats.isDirectory() ? 'directory' as const : stats.isSymbolicLink() ? 'symlink' as const : 'file' as const
    }
  },
  mkdir: async (path: string, options?: { recursive?: boolean }): Promise<void> => {
    await fs.mkdir(path, options)
  },
  rm: async (path: string, options?: { recursive?: boolean | undefined; force?: boolean | undefined }): Promise<void> => {
    await fs.rm(path, {
      ...(options?.recursive !== undefined && { recursive: options.recursive }),
      ...(options?.force !== undefined && { force: options.force }),
    })
  },
  cp: async (src: string, dest: string, _options?: { recursive?: boolean | undefined }): Promise<void> => {
    await fs.copyFile(src, dest)
  },
  exists: async (path: string): Promise<boolean> => {
    return fs.exists(path)
  }
}

// CLI context
const context = {
  fs: cliFs,
  stdout: (text: string) => process.stdout.write(text + '\n'),
  stderr: (text: string) => process.stderr.write(text + '\n'),
  exit: (code: number) => process.exit(code)
}

// Run the CLI
const args = process.argv.slice(2)
runCLI(args, context)
  .then(result => {
    process.exit(result.exitCode)
  })
  .catch(err => {
    logger.error('Fatal error:', err)
    process.exit(1)
  })

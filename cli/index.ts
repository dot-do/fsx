/**
 * CLI for fsx - Filesystem operations
 *
 * Commands:
 * - ls [path]     - list directory contents
 * - cat <path>    - read file contents
 * - mkdir <path>  - create directory
 * - rm <path>     - remove file/directory
 * - cp <src> <dest> - copy file
 */

import cac from 'cac'
import type { CommandResult, LsEntry, LsFormatOptions } from './types'

/**
 * Mock filesystem interface for dependency injection
 */
interface MockFS {
  readFile: (path: string) => Promise<string>
  readFileBytes: (path: string) => Promise<Uint8Array>
  writeFile: (path: string, content: string | Uint8Array) => Promise<void>
  readdir: (path: string) => Promise<string[]>
  readdirWithTypes: (path: string) => Promise<Array<{ name: string; type: 'file' | 'directory' | 'symlink' }>>
  stat: (path: string) => Promise<{ size: number; mode: number; mtime: number; type: 'file' | 'directory' | 'symlink' }>
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>
  rm: (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>
  cp: (src: string, dest: string, options?: { recursive?: boolean }) => Promise<void>
  exists: (path: string) => Promise<boolean>
}

/**
 * CLI context for dependency injection
 */
interface CLIContext {
  fs: MockFS
  stdout: (text: string) => void
  stderr: (text: string) => void
  exit: (code: number) => void
}

const VERSION = '0.1.0'

/**
 * Normalize a path by removing trailing slashes (except for root)
 * and handling double slashes
 */
function normalizePath(p: string): string {
  // Handle relative paths
  if (p === '.') return '/'
  // Replace double slashes with single
  let normalized = p.replace(/\/+/g, '/')
  // Remove trailing slash unless it's root
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

/**
 * Format permission mode to string (e.g., -rw-r--r--)
 */
function formatMode(mode: number, type: 'file' | 'directory' | 'symlink'): string {
  const prefix = type === 'directory' ? 'd' : type === 'symlink' ? 'l' : '-'
  const perms = [
    (mode & 0o400) ? 'r' : '-',
    (mode & 0o200) ? 'w' : '-',
    (mode & 0o100) ? 'x' : '-',
    (mode & 0o040) ? 'r' : '-',
    (mode & 0o020) ? 'w' : '-',
    (mode & 0o010) ? 'x' : '-',
    (mode & 0o004) ? 'r' : '-',
    (mode & 0o002) ? 'w' : '-',
    (mode & 0o001) ? 'x' : '-',
  ].join('')
  return prefix + perms
}

/**
 * Format date for ls -l output
 */
function formatDate(mtime: number): string {
  const date = new Date(mtime)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const month = months[date.getMonth()]
  const day = date.getDate().toString().padStart(2, ' ')
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  return `${month} ${day} ${hours}:${minutes}`
}

/**
 * Format ls output with support for long format and showAll
 */
export function formatLsOutput(entries: LsEntry[], options: LsFormatOptions = {}): string {
  const { long = false, showAll = false } = options

  // Add . and .. if showAll is true
  let allEntries = [...entries]
  if (showAll) {
    const now = Date.now()
    allEntries = [
      { name: '.', type: 'directory' as const, size: 0, mode: 0o755, mtime: now },
      { name: '..', type: 'directory' as const, size: 0, mode: 0o755, mtime: now },
      ...allEntries
    ]
  }

  if (!long) {
    return allEntries.map(e => e.name).join('\n')
  }

  // Long format: permissions, size, date, name
  return allEntries.map(entry => {
    const perms = formatMode(entry.mode, entry.type)
    const size = entry.size.toString().padStart(8, ' ')
    const date = formatDate(entry.mtime)
    return `${perms} ${size} ${date} ${entry.name}`
  }).join('\n')
}

/**
 * Create and return the CLI instance with all commands registered
 */
export function createCLI() {
  const cli = cac('fsx')

  cli.version(VERSION)
  cli.help()

  // ls command
  cli.command('ls [path]', 'list directory contents')
    .option('-l, --long', 'Use long listing format')
    .option('-a, --all', 'Show hidden files (including . and ..)')
    .action(() => {}) // Placeholder - actual execution happens in runCLI

  // cat command
  cli.command('cat <files...>', 'read and concatenate file contents')
    .action(() => {})

  // mkdir command
  cli.command('mkdir <paths...>', 'create directories')
    .option('-p, --parents', 'Create parent directories as needed (recursive)')
    .action(() => {})

  // rm command
  cli.command('rm <paths...>', 'remove files or directories')
    .option('-r, -R, --recursive', 'Remove directories and their contents recursively')
    .option('-f, --force', 'Ignore nonexistent files, never prompt')
    .action(() => {})

  // cp command
  cli.command('cp <source> <dest>', 'copy files')
    .option('-r, -R, --recursive', 'Copy directories recursively')
    .action(() => {})

  // Return object with name, parse function, and commands list
  return {
    name: 'fsx',
    parse: cli.parse.bind(cli),
    commands: ['ls', 'cat', 'mkdir', 'rm', 'cp'],
    cli
  }
}

/**
 * Execute a CLI command with the given arguments and context
 */
export async function runCLI(args: string[], context: CLIContext): Promise<CommandResult> {
  const { fs, stdout, stderr } = context

  // Handle --version and -v
  if (args.includes('--version') || args.includes('-v')) {
    stdout(VERSION)
    return { exitCode: 0 }
  }

  // Handle --help and -h at root level
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    if (args.length === 0 || (args.length === 1 && (args[0] === '--help' || args[0] === '-h'))) {
      stdout(`fsx/${VERSION}

Usage:
  $ fsx <command> [options]

Commands:
  ls [path]         list directory contents
  cat <files...>    read and concatenate file contents
  mkdir <paths...>  create directories
  rm <paths...>     remove files or directories
  cp <src> <dest>   copy files

For more info, run any command with the --help flag:
  $ fsx ls --help
  $ fsx cat --help
  $ fsx mkdir --help
  $ fsx rm --help
  $ fsx cp --help

Options:
  -v, --version  Display version number
  -h, --help     Display this message
`)
      return { exitCode: 0 }
    }
  }

  // Parse command
  const command = args[0]
  const restArgs = args.slice(1)

  // Handle command-specific help
  if (restArgs.includes('--help') || restArgs.includes('-h')) {
    switch (command) {
      case 'ls':
        stdout(`fsx/${VERSION}

Usage:
  $ fsx ls [path]

Options:
  -l, --long  Use long listing format
  -a, --all   Show hidden files (including . and ..)
  -h, --help  Display this message

Description:
  list directory contents
`)
        return { exitCode: 0 }

      case 'cat':
        stdout(`fsx/${VERSION}

Usage:
  $ fsx cat <files...>

Options:
  -h, --help  Display this message

Description:
  read and concatenate file contents
`)
        return { exitCode: 0 }

      case 'mkdir':
        stdout(`fsx/${VERSION}

Usage:
  $ fsx mkdir <paths...>

Options:
  -p, --parents  Create parent directories as needed (recursive)
  -h, --help     Display this message

Description:
  create directories
`)
        return { exitCode: 0 }

      case 'rm':
        stdout(`fsx/${VERSION}

Usage:
  $ fsx rm <paths...>

Options:
  -r, -R, --recursive  Remove directories and their contents recursively
  -f, --force          Ignore nonexistent files, never prompt
  -h, --help           Display this message

Description:
  remove files or directories
`)
        return { exitCode: 0 }

      case 'cp':
        stdout(`fsx/${VERSION}

Usage:
  $ fsx cp <source> <dest>

Options:
  -r, -R, --recursive  Copy directories recursively
  -h, --help           Display this message

Description:
  copy files
`)
        return { exitCode: 0 }
    }
  }

  // Parse options
  const parseOptions = (cmdArgs: string[]) => {
    const options: Record<string, boolean> = {}
    const paths: string[] = []
    let stopFlags = false

    for (const arg of cmdArgs) {
      if (arg === '--') {
        stopFlags = true
        continue
      }

      if (!stopFlags && arg.startsWith('-')) {
        // Handle combined flags like -la, -rf
        if (arg.startsWith('--')) {
          // Long options
          const opt = arg.slice(2)
          if (opt === 'long') options.long = true
          else if (opt === 'all') options.all = true
          else if (opt === 'parents') options.parents = true
          else if (opt === 'recursive') options.recursive = true
          else if (opt === 'force') options.force = true
        } else {
          // Short options - can be combined
          const flags = arg.slice(1)
          for (const f of flags) {
            if (f === 'l') options.long = true
            else if (f === 'a') options.all = true
            else if (f === 'p') options.parents = true
            else if (f === 'r' || f === 'R') options.recursive = true
            else if (f === 'f') options.force = true
          }
        }
      } else {
        paths.push(arg)
      }
    }

    return { options, paths }
  }

  try {
    switch (command) {
      case 'ls': {
        const { options, paths } = parseOptions(restArgs)
        const targetPath = normalizePath(paths[0] || '/')

        try {
          // Check if path is a file
          const stat = await fs.stat(targetPath)

          if (stat.type === 'file') {
            // ls on a file just shows the file
            const name = targetPath.split('/').pop() || targetPath
            const entry: LsEntry = {
              name,
              type: stat.type,
              size: stat.size,
              mode: stat.mode,
              mtime: stat.mtime
            }
            stdout(formatLsOutput([entry], { long: options.long, showAll: options.all }))
            return { exitCode: 0 }
          }

          // It's a directory
          const entries = await fs.readdirWithTypes(targetPath)
          const detailedEntries: LsEntry[] = await Promise.all(
            entries.map(async (e) => {
              const fullPath = targetPath === '/' ? `/${e.name}` : `${targetPath}/${e.name}`
              try {
                const stat = await fs.stat(fullPath)
                return {
                  name: e.name,
                  type: e.type,
                  size: stat.size,
                  mode: stat.mode,
                  mtime: stat.mtime
                }
              } catch {
                return {
                  name: e.name,
                  type: e.type,
                  size: 0,
                  mode: 0o644,
                  mtime: Date.now()
                }
              }
            })
          )

          stdout(formatLsOutput(detailedEntries, { long: options.long, showAll: options.all }))
          return { exitCode: 0 }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          stderr(`fsx ls: ${message}`)
          return { exitCode: 1, error: message }
        }
      }

      case 'cat': {
        const { paths } = parseOptions(restArgs)

        if (paths.length === 0) {
          stderr('fsx cat: missing file argument')
          return { exitCode: 1, error: 'missing file argument' }
        }

        try {
          const contents: string[] = []
          for (const p of paths) {
            const normalizedPath = normalizePath(p)
            const content = await fs.readFile(normalizedPath)
            contents.push(content)
          }
          stdout(contents.join(''))
          return { exitCode: 0 }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          stderr(`fsx cat: ${message}`)
          return { exitCode: 1, error: message }
        }
      }

      case 'mkdir': {
        const { options, paths } = parseOptions(restArgs)

        if (paths.length === 0) {
          stderr('fsx mkdir: missing directory argument')
          return { exitCode: 1, error: 'missing directory argument' }
        }

        try {
          for (const p of paths) {
            const normalizedPath = normalizePath(p)
            if (options.parents) {
              // With -p, don't error if exists
              try {
                await fs.mkdir(normalizedPath, { recursive: true })
              } catch (err: unknown) {
                const e = err as { code?: string }
                if (e.code !== 'EEXIST') throw err
              }
            } else {
              await fs.mkdir(normalizedPath)
            }
          }
          return { exitCode: 0 }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          stderr(`fsx mkdir: ${message}`)
          return { exitCode: 1, error: message }
        }
      }

      case 'rm': {
        const { options, paths } = parseOptions(restArgs)

        if (paths.length === 0) {
          stderr('fsx rm: missing file argument')
          return { exitCode: 1, error: 'missing file argument' }
        }

        try {
          for (const p of paths) {
            const normalizedPath = normalizePath(p)
            await fs.rm(normalizedPath, {
              recursive: options.recursive,
              force: options.force
            })
          }
          return { exitCode: 0 }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          stderr(`fsx rm: ${message}`)
          return { exitCode: 1, error: message }
        }
      }

      case 'cp': {
        const { options, paths } = parseOptions(restArgs)

        if (paths.length === 0) {
          stderr('fsx cp: missing source argument')
          return { exitCode: 1, error: 'missing source argument' }
        }

        if (paths.length === 1) {
          stderr('fsx cp: missing destination argument')
          return { exitCode: 1, error: 'missing destination argument' }
        }

        const src = normalizePath(paths[0])
        const dest = normalizePath(paths[1])

        try {
          await fs.cp(src, dest, { recursive: options.recursive })
          return { exitCode: 0 }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          stderr(`fsx cp: ${message}`)
          return { exitCode: 1, error: message }
        }
      }

      default:
        stderr(`fsx: unknown command '${command}'`)
        return { exitCode: 1, error: `unknown command '${command}'` }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    stderr(`fsx: ${message}`)
    return { exitCode: 1, error: message }
  }
}

/**
 * BashModule - Bash command execution capability module for dotdo integration
 *
 * Provides bash-like command execution that integrates with the FsModule
 * for native file operations (cat, ls, mkdir, rm, etc.).
 *
 * Key features:
 * - Command safety analysis before execution
 * - Native file operation delegation to FsModule
 * - Support for common shell commands
 * - Environment variable support
 * - Working directory tracking
 *
 * @example
 * ```typescript
 * // Using with withBash mixin
 * class MySite extends withBash(withFs(DO)) {
 *   async setup() {
 *     await this.$.bash.exec('mkdir -p /app/data')
 *     await this.$.bash.exec('cat /app/config.json')
 *   }
 * }
 *
 * // Using BashModule directly
 * const bash = new BashModule({ fs: fsModule })
 * await bash.initialize()
 * const result = await bash.exec('ls -la /app')
 * ```
 */

import type { FsModule } from './module.js'
import type { Stats, Dirent } from '../core/types.js'

// ============================================================================
// TYPES
// ============================================================================

/**
 * Configuration options for BashModule
 */
export interface BashModuleConfig {
  /** FsModule instance for file operations */
  fs: FsModule
  /** Initial working directory (default: '/') */
  cwd?: string
  /** Environment variables */
  env?: Record<string, string>
  /** Enable strict mode - fail on any error (default: false) */
  strict?: boolean
  /** Command timeout in milliseconds (default: 30000) */
  timeout?: number
  /** Allowed commands whitelist (default: all safe commands) */
  allowedCommands?: string[]
  /** Blocked commands blacklist (default: dangerous commands) */
  blockedCommands?: string[]
}

/**
 * Result of command execution
 */
export interface ExecResult {
  /** Exit code (0 = success) */
  exitCode: number
  /** Standard output */
  stdout: string
  /** Standard error */
  stderr: string
  /** Command that was executed */
  command: string
  /** Working directory at execution time */
  cwd: string
  /** Execution duration in milliseconds */
  duration: number
}

/**
 * Safety analysis result
 */
export interface SafetyAnalysis {
  /** Whether the command is considered safe */
  safe: boolean
  /** Risk level: 'none', 'low', 'medium', 'high', 'critical' */
  risk: 'none' | 'low' | 'medium' | 'high' | 'critical'
  /** Detailed reasons for the safety assessment */
  reasons: string[]
  /** Suggested alternatives if command is unsafe */
  alternatives?: string[]
  /** Whether the command will be delegated to FsModule */
  delegatedToFs: boolean
  /** Parsed command info */
  parsed: ParsedCommand
}

/**
 * Parsed command structure
 */
export interface ParsedCommand {
  /** Base command name */
  command: string
  /** Command arguments */
  args: string[]
  /** Parsed flags/options */
  flags: Record<string, string | boolean>
  /** Input redirection file */
  stdin?: string
  /** Output redirection file */
  stdout?: string
  /** Error redirection file */
  stderr?: string
  /** Append mode for output redirection */
  appendMode: boolean
  /** Piped commands */
  pipes: ParsedCommand[]
  /** Background execution */
  background: boolean
}

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Command-specific flags that expect a value
 * Maps flag character to set of commands where it takes a value
 */
const VALUE_FLAGS_BY_COMMAND: Record<string, Set<string>> = {
  'n': new Set(['head', 'tail']),  // -n takes value for head/tail but not echo/cat
  'c': new Set(['head', 'tail']),  // -c bytes for head/tail
  'm': new Set(['chmod']),         // -m mode for mkdir
}

/**
 * Commands that are natively supported via FsModule
 */
const FS_NATIVE_COMMANDS = new Set([
  'cat',
  'ls',
  'mkdir',
  'rm',
  'rmdir',
  'cp',
  'mv',
  'touch',
  'head',
  'tail',
  'wc',
  'pwd',
  'cd',
  'echo',
  'stat',
  'chmod',
  'chown',
  'ln',
  'readlink',
  'realpath',
  'test',
  '[',
  'true',
  'false',
  'basename',
  'dirname',
])

/**
 * Commands that are blocked by default (dangerous)
 */
const DEFAULT_BLOCKED_COMMANDS = new Set([
  'rm -rf /',
  'dd',
  'mkfs',
  'fdisk',
  'parted',
  'mount',
  'umount',
  ':(){:|:&};:',  // Fork bomb
  'wget',
  'curl',
  'nc',
  'netcat',
  'telnet',
  'ssh',
  'scp',
  'rsync',
  'ftp',
])

/**
 * Patterns that indicate potentially dangerous commands
 */
const DANGEROUS_PATTERNS = [
  /rm\s+(-[rf]+\s+)*\/($|\s)/,  // rm -rf / or rm /
  />\s*\/dev\//,  // Writing to devices
  /\/dev\/sd[a-z]/,  // Disk device access
  /\/dev\/null.*</,  // Reading from /dev/null
  /\$\(.*\)/,  // Command substitution
  /`.*`/,  // Backtick command substitution
  /;\s*rm/,  // Command chaining with rm
  /\|\s*sh/,  // Piping to shell
  /\|\s*bash/,  // Piping to bash
  /eval\s/,  // eval command
  /exec\s/,  // exec command
  /source\s/,  // source command
  /\.\s+\//,  // Sourcing files
]

// ============================================================================
// BASHMODULE CLASS
// ============================================================================

/**
 * BashModule - Bash command execution capability for Durable Object integration
 *
 * Implements a safe bash-like command execution environment that delegates
 * file operations to FsModule for native performance.
 */
export class BashModule {
  readonly name = 'bash'

  private fs: FsModule
  private cwd: string
  private env: Record<string, string>
  private strict: boolean
  private timeout: number
  private allowedCommands: Set<string> | null
  private blockedCommands: Set<string>
  private initialized = false

  constructor(config: BashModuleConfig) {
    this.fs = config.fs
    this.cwd = config.cwd ?? '/'
    this.env = config.env ?? {}
    this.strict = config.strict ?? false
    this.timeout = config.timeout ?? 30000
    this.allowedCommands = config.allowedCommands ? new Set(config.allowedCommands) : null
    this.blockedCommands = new Set([
      ...DEFAULT_BLOCKED_COMMANDS,
      ...(config.blockedCommands ?? []),
    ])
  }

  /**
   * Initialize the module
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    // Ensure FsModule is initialized
    await this.fs.exists('/')

    // Set default environment variables
    this.env.HOME = this.env.HOME ?? '/'
    this.env.USER = this.env.USER ?? 'root'
    this.env.PATH = this.env.PATH ?? '/bin:/usr/bin'
    this.env.PWD = this.cwd

    this.initialized = true
  }

  /**
   * Cleanup hook for capability disposal
   */
  async dispose(): Promise<void> {
    // No cleanup needed
  }

  // ===========================================================================
  // COMMAND PARSING
  // ===========================================================================

  /**
   * Parse a command string into structured form
   */
  private parseCommand(commandStr: string): ParsedCommand {
    const trimmed = commandStr.trim()

    // Check for background execution
    const background = trimmed.endsWith('&')
    const withoutBg = background ? trimmed.slice(0, -1).trim() : trimmed

    // Handle pipes
    const pipeSegments = this.splitByPipes(withoutBg)

    if (pipeSegments.length > 1) {
      const first = this.parseSimpleCommand(pipeSegments[0])
      first.pipes = pipeSegments.slice(1).map((seg) => this.parseSimpleCommand(seg))
      first.background = background
      return first
    }

    const result = this.parseSimpleCommand(withoutBg)
    result.background = background
    return result
  }

  /**
   * Split command by pipes, respecting quotes
   */
  private splitByPipes(command: string): string[] {
    const segments: string[] = []
    let current = ''
    let inSingleQuote = false
    let inDoubleQuote = false
    let escaped = false

    for (let i = 0; i < command.length; i++) {
      const char = command[i]

      if (escaped) {
        current += char
        escaped = false
        continue
      }

      if (char === '\\') {
        escaped = true
        current += char
        continue
      }

      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote
        current += char
        continue
      }

      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote
        current += char
        continue
      }

      if (char === '|' && !inSingleQuote && !inDoubleQuote) {
        segments.push(current.trim())
        current = ''
        continue
      }

      current += char
    }

    if (current.trim()) {
      segments.push(current.trim())
    }

    return segments
  }

  /**
   * Parse a simple command (no pipes)
   */
  private parseSimpleCommand(commandStr: string): ParsedCommand {
    const tokens = this.tokenize(commandStr)
    const result: ParsedCommand = {
      command: '',
      args: [],
      flags: {},
      appendMode: false,
      pipes: [],
      background: false,
    }

    let i = 0

    // Skip leading whitespace tokens
    while (i < tokens.length && tokens[i] === '') {
      i++
    }

    // First non-empty token is the command
    if (i < tokens.length) {
      result.command = tokens[i++]
    }

    // Parse remaining tokens
    while (i < tokens.length) {
      const token = tokens[i]

      // Output redirection
      if (token === '>' || token === '>>') {
        result.appendMode = token === '>>'
        if (i + 1 < tokens.length) {
          result.stdout = tokens[++i]
        }
        i++
        continue
      }

      // Error redirection
      if (token === '2>' || token === '2>>') {
        if (i + 1 < tokens.length) {
          result.stderr = tokens[++i]
        }
        i++
        continue
      }

      // Input redirection
      if (token === '<') {
        if (i + 1 < tokens.length) {
          result.stdin = tokens[++i]
        }
        i++
        continue
      }

      // Flags
      if (token.startsWith('-') && token.length > 1 && !/^-?\d+$/.test(token)) {
        if (token.startsWith('--')) {
          // Long flag
          const eqIndex = token.indexOf('=')
          if (eqIndex !== -1) {
            const key = token.substring(2, eqIndex)
            const value = token.substring(eqIndex + 1)
            result.flags[key] = value
          } else {
            result.flags[token.substring(2)] = true
          }
        } else {
          // Short flags - handle flags that take values (like -n 10)
          const flagChars = token.substring(1)

          // Check if this is a single-char flag that might take a value for this command
          const valueCommands = VALUE_FLAGS_BY_COMMAND[flagChars]
          if (flagChars.length === 1 && valueCommands && valueCommands.has(result.command)) {
            // Peek at next token to see if it's a value
            if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
              result.flags[flagChars] = tokens[++i]
            } else {
              result.flags[flagChars] = true
            }
          } else {
            // Handle combined flags or flags without values
            for (const char of flagChars) {
              result.flags[char] = true
            }
          }
        }
        result.args.push(token)
      } else {
        result.args.push(token)
      }

      i++
    }

    return result
  }

  /**
   * Tokenize command string, handling quotes
   */
  private tokenize(command: string): string[] {
    const tokens: string[] = []
    let current = ''
    let inSingleQuote = false
    let inDoubleQuote = false
    let escaped = false

    for (let i = 0; i < command.length; i++) {
      const char = command[i]

      if (escaped) {
        current += char
        escaped = false
        continue
      }

      if (char === '\\' && !inSingleQuote) {
        escaped = true
        continue
      }

      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote
        continue
      }

      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote
        continue
      }

      if ((char === ' ' || char === '\t') && !inSingleQuote && !inDoubleQuote) {
        if (current) {
          tokens.push(current)
          current = ''
        }
        continue
      }

      current += char
    }

    if (current) {
      tokens.push(current)
    }

    return tokens
  }

  /**
   * Expand environment variables in a string
   */
  private expandVars(str: string): string {
    return str.replace(/\$(\w+)|\$\{(\w+)\}/g, (_, name1, name2) => {
      const name = name1 || name2
      return this.env[name] ?? ''
    })
  }

  /**
   * Resolve a path relative to cwd
   */
  private resolvePath(path: string): string {
    if (path.startsWith('/')) {
      return path
    }

    if (path.startsWith('~')) {
      return this.env.HOME + path.substring(1)
    }

    // Handle . and ..
    const parts = (this.cwd + '/' + path).split('/').filter(Boolean)
    const resolved: string[] = []

    for (const part of parts) {
      if (part === '.') continue
      if (part === '..') {
        resolved.pop()
      } else {
        resolved.push(part)
      }
    }

    return '/' + resolved.join('/')
  }

  // ===========================================================================
  // SAFETY ANALYSIS
  // ===========================================================================

  /**
   * Analyze a command for safety before execution
   */
  analyze(command: string): SafetyAnalysis {
    const parsed = this.parseCommand(command)
    const expandedCommand = this.expandVars(command)

    // Check if command is blocked
    if (this.blockedCommands.has(parsed.command)) {
      return {
        safe: false,
        risk: 'critical',
        reasons: [`Command "${parsed.command}" is blocked`],
        alternatives: this.getSafeAlternatives(parsed.command),
        delegatedToFs: false,
        parsed,
      }
    }

    // Check if command is in whitelist (if whitelist is set)
    if (this.allowedCommands && !this.allowedCommands.has(parsed.command)) {
      return {
        safe: false,
        risk: 'high',
        reasons: [`Command "${parsed.command}" is not in allowed list`],
        delegatedToFs: false,
        parsed,
      }
    }

    // Check for dangerous patterns
    const dangerousReasons: string[] = []
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(expandedCommand)) {
        dangerousReasons.push(`Matches dangerous pattern: ${pattern.source}`)
      }
    }

    if (dangerousReasons.length > 0) {
      return {
        safe: false,
        risk: 'critical',
        reasons: dangerousReasons,
        delegatedToFs: false,
        parsed,
      }
    }

    // Check if command can be delegated to FsModule
    const delegatedToFs = FS_NATIVE_COMMANDS.has(parsed.command)

    // Determine risk level based on command
    const risk = this.assessRisk(parsed)

    return {
      safe: risk !== 'critical' && risk !== 'high',
      risk,
      reasons: [],
      delegatedToFs,
      parsed,
    }
  }

  /**
   * Assess the risk level of a parsed command
   */
  private assessRisk(parsed: ParsedCommand): SafetyAnalysis['risk'] {
    const { command, args, flags } = parsed

    // rm with -rf is medium risk
    if (command === 'rm' && (flags['r'] || flags['f'])) {
      // Check if targeting root or important paths
      const targets = args.filter((a) => !a.startsWith('-'))
      if (targets.some((t) => t === '/' || t === '/*' || t.startsWith('/bin') || t.startsWith('/usr'))) {
        return 'critical'
      }
      return 'medium'
    }

    // chmod/chown with recursive could be risky
    if ((command === 'chmod' || command === 'chown') && flags['R']) {
      return 'medium'
    }

    // Commands that modify files
    if (['mv', 'cp', 'touch', 'ln'].includes(command)) {
      return 'low'
    }

    // Read-only commands
    if (['cat', 'ls', 'head', 'tail', 'wc', 'pwd', 'stat', 'readlink', 'realpath', 'basename', 'dirname', 'echo', 'test', '[', 'true', 'false'].includes(command)) {
      return 'none'
    }

    // Directory creation is generally safe
    if (command === 'mkdir') {
      return 'none'
    }

    // Unknown commands
    return 'medium'
  }

  /**
   * Get safe alternatives for a blocked command
   */
  private getSafeAlternatives(command: string): string[] {
    const alternatives: Record<string, string[]> = {
      'wget': ['Use fs.write() to create files'],
      'curl': ['Use fs.write() to create files'],
      'dd': ['Use fs.write() for file operations'],
    }
    return alternatives[command] ?? []
  }

  // ===========================================================================
  // COMMAND EXECUTION
  // ===========================================================================

  /**
   * Execute a bash command
   */
  async exec(command: string): Promise<ExecResult> {
    await this.initialize()

    const startTime = Date.now()
    const expandedCommand = this.expandVars(command)
    const analysis = this.analyze(expandedCommand)

    if (!analysis.safe) {
      const errorMsg = `Unsafe command blocked: ${analysis.reasons.join(', ')}`
      return {
        exitCode: 1,
        stdout: '',
        stderr: errorMsg,
        command: expandedCommand,
        cwd: this.cwd,
        duration: Date.now() - startTime,
      }
    }

    try {
      // Execute command
      const result = await this.executeCommand(analysis.parsed)

      // In strict mode, throw if command failed
      if (this.strict && result.exitCode !== 0) {
        throw new Error(result.stderr || `Command exited with code ${result.exitCode}`)
      }

      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        command: expandedCommand,
        cwd: this.cwd,
        duration: Date.now() - startTime,
      }
    } catch (error: any) {
      const stderr = error.message || String(error)
      if (this.strict) {
        throw error
      }
      return {
        exitCode: 1,
        stdout: '',
        stderr,
        command: expandedCommand,
        cwd: this.cwd,
        duration: Date.now() - startTime,
      }
    }
  }

  /**
   * Execute a parsed command
   */
  private async executeCommand(parsed: ParsedCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    // Handle piped commands
    if (parsed.pipes.length > 0) {
      return this.executePipeline([parsed, ...parsed.pipes])
    }

    // Execute single command
    let result = await this.executeSingleCommand(parsed)

    // Handle output redirection
    if (parsed.stdout) {
      const path = this.resolvePath(parsed.stdout)
      if (parsed.appendMode) {
        await this.fs.append(path, result.stdout)
      } else {
        await this.fs.write(path, result.stdout)
      }
      result = { ...result, stdout: '' }
    }

    // Handle stderr redirection
    if (parsed.stderr) {
      const path = this.resolvePath(parsed.stderr)
      await this.fs.write(path, result.stderr)
      result = { ...result, stderr: '' }
    }

    return result
  }

  /**
   * Execute a pipeline of commands
   */
  private async executePipeline(commands: ParsedCommand[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    let stdin = ''
    let lastResult = { exitCode: 0, stdout: '', stderr: '' }

    for (const cmd of commands) {
      // Set stdin for this command
      const result = await this.executeSingleCommand(cmd, stdin)
      stdin = result.stdout
      lastResult = result

      // If command fails in strict mode, stop pipeline
      if (result.exitCode !== 0 && this.strict) {
        return result
      }
    }

    return lastResult
  }

  /**
   * Execute a single command
   */
  private async executeSingleCommand(parsed: ParsedCommand, stdin?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    // Handle input redirection
    if (parsed.stdin) {
      const path = this.resolvePath(parsed.stdin)
      stdin = await this.fs.read(path, { encoding: 'utf-8' }) as string
    }

    // Dispatch to appropriate handler
    switch (parsed.command) {
      case 'cat':
        return this.execCat(parsed, stdin)
      case 'ls':
        return this.execLs(parsed)
      case 'mkdir':
        return this.execMkdir(parsed)
      case 'rm':
        return this.execRm(parsed)
      case 'rmdir':
        return this.execRmdir(parsed)
      case 'cp':
        return this.execCp(parsed)
      case 'mv':
        return this.execMv(parsed)
      case 'touch':
        return this.execTouch(parsed)
      case 'pwd':
        return this.execPwd()
      case 'cd':
        return this.execCd(parsed)
      case 'echo':
        return this.execEcho(parsed)
      case 'head':
        return this.execHead(parsed, stdin)
      case 'tail':
        return this.execTail(parsed, stdin)
      case 'wc':
        return this.execWc(parsed, stdin)
      case 'stat':
        return this.execStat(parsed)
      case 'chmod':
        return this.execChmod(parsed)
      case 'chown':
        return this.execChown(parsed)
      case 'ln':
        return this.execLn(parsed)
      case 'readlink':
        return this.execReadlink(parsed)
      case 'realpath':
        return this.execRealpath(parsed)
      case 'basename':
        return this.execBasename(parsed)
      case 'dirname':
        return this.execDirname(parsed)
      case 'test':
      case '[':
        return this.execTest(parsed)
      case 'true':
        return { exitCode: 0, stdout: '', stderr: '' }
      case 'false':
        return { exitCode: 1, stdout: '', stderr: '' }
      default:
        return {
          exitCode: 127,
          stdout: '',
          stderr: `bash: ${parsed.command}: command not found`,
        }
    }
  }

  // ===========================================================================
  // COMMAND IMPLEMENTATIONS
  // ===========================================================================

  /**
   * cat - concatenate and print files
   */
  private async execCat(parsed: ParsedCommand, stdin?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const files = parsed.args.filter((a) => !a.startsWith('-'))

    // If no files and stdin provided, output stdin
    if (files.length === 0 && stdin !== undefined) {
      return { exitCode: 0, stdout: stdin, stderr: '' }
    }

    if (files.length === 0) {
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    let output = ''
    const showLineNumbers = parsed.flags['n'] === true

    for (const file of files) {
      try {
        const path = this.resolvePath(file)
        let content = await this.fs.read(path, { encoding: 'utf-8' }) as string

        if (showLineNumbers) {
          const lines = content.split('\n')
          content = lines.map((line, i) => `${String(i + 1).padStart(6)}  ${line}`).join('\n')
        }

        output += content
      } catch (error: any) {
        return { exitCode: 1, stdout: '', stderr: `cat: ${file}: ${error.message}` }
      }
    }

    return { exitCode: 0, stdout: output, stderr: '' }
  }

  /**
   * ls - list directory contents
   */
  private async execLs(parsed: ParsedCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const paths = parsed.args.filter((a) => !a.startsWith('-'))
    const targetPath = paths[0] ?? '.'

    const showAll = parsed.flags['a'] === true
    const longFormat = parsed.flags['l'] === true
    const recursive = parsed.flags['R'] === true
    const humanReadable = parsed.flags['h'] === true

    try {
      const resolvedPath = this.resolvePath(targetPath)
      const output = await this.listDirectory(resolvedPath, { showAll, longFormat, recursive, humanReadable })
      return { exitCode: 0, stdout: output, stderr: '' }
    } catch (error: any) {
      return { exitCode: 1, stdout: '', stderr: `ls: ${targetPath}: ${error.message}` }
    }
  }

  /**
   * Helper to list a directory
   */
  private async listDirectory(
    path: string,
    options: { showAll: boolean; longFormat: boolean; recursive: boolean; humanReadable: boolean }
  ): Promise<string> {
    const entries = await this.fs.readdir(path, { withFileTypes: true }) as Dirent[]
    let output = ''

    if (options.recursive) {
      output += `${path}:\n`
    }

    const filtered = options.showAll
      ? entries
      : entries.filter((e) => !e.name.startsWith('.'))

    if (options.longFormat) {
      for (const entry of filtered) {
        const stats = await this.fs.stat(entry.path)
        const line = this.formatLongListing(entry, stats, options.humanReadable)
        output += line + '\n'
      }
    } else {
      output += filtered.map((e) => e.name).join('  ') + '\n'
    }

    if (options.recursive) {
      for (const entry of filtered) {
        if (entry.isDirectory()) {
          output += '\n' + await this.listDirectory(entry.path, options)
        }
      }
    }

    return output
  }

  /**
   * Format a long listing entry
   */
  private formatLongListing(entry: Dirent, stats: Stats, humanReadable: boolean): string {
    const type = entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : '-'
    const perms = this.formatPermissions(stats.mode)
    const size = humanReadable ? this.formatSize(stats.size) : String(stats.size).padStart(8)
    const date = this.formatDate(stats.mtime)
    return `${type}${perms} ${String(stats.nlink).padStart(2)} ${String(stats.uid).padStart(4)} ${String(stats.gid).padStart(4)} ${size} ${date} ${entry.name}`
  }

  /**
   * Format file permissions
   */
  private formatPermissions(mode: number): string {
    const perms = mode & 0o777
    let str = ''
    str += (perms & 0o400) ? 'r' : '-'
    str += (perms & 0o200) ? 'w' : '-'
    str += (perms & 0o100) ? 'x' : '-'
    str += (perms & 0o040) ? 'r' : '-'
    str += (perms & 0o020) ? 'w' : '-'
    str += (perms & 0o010) ? 'x' : '-'
    str += (perms & 0o004) ? 'r' : '-'
    str += (perms & 0o002) ? 'w' : '-'
    str += (perms & 0o001) ? 'x' : '-'
    return str
  }

  /**
   * Format file size for human-readable output
   */
  private formatSize(bytes: number): string {
    const units = ['B', 'K', 'M', 'G', 'T']
    let i = 0
    let size = bytes
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024
      i++
    }
    return `${Math.round(size)}${units[i]}`.padStart(5)
  }

  /**
   * Format a date for ls output
   */
  private formatDate(date: Date): string {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const now = new Date()
    const month = months[date.getMonth()]
    const day = String(date.getDate()).padStart(2)

    // If within last 6 months, show time; otherwise show year
    const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000)
    if (date > sixMonthsAgo) {
      const hour = String(date.getHours()).padStart(2, '0')
      const min = String(date.getMinutes()).padStart(2, '0')
      return `${month} ${day} ${hour}:${min}`
    } else {
      const year = date.getFullYear()
      return `${month} ${day}  ${year}`
    }
  }

  /**
   * mkdir - create directories
   */
  private async execMkdir(parsed: ParsedCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const dirs = parsed.args.filter((a) => !a.startsWith('-'))
    const recursive = parsed.flags['p'] === true
    const modeStr = parsed.flags['m']
    const mode = typeof modeStr === 'string' ? parseInt(modeStr, 8) : undefined

    for (const dir of dirs) {
      try {
        const path = this.resolvePath(dir)
        await this.fs.mkdir(path, { recursive, mode })
      } catch (error: any) {
        return { exitCode: 1, stdout: '', stderr: `mkdir: ${dir}: ${error.message}` }
      }
    }

    return { exitCode: 0, stdout: '', stderr: '' }
  }

  /**
   * rm - remove files or directories
   */
  private async execRm(parsed: ParsedCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const files = parsed.args.filter((a) => !a.startsWith('-'))
    const recursive = parsed.flags['r'] === true || parsed.flags['R'] === true
    const force = parsed.flags['f'] === true

    for (const file of files) {
      try {
        const path = this.resolvePath(file)
        await this.fs.rm(path, { recursive, force })
      } catch (error: any) {
        if (!force) {
          return { exitCode: 1, stdout: '', stderr: `rm: ${file}: ${error.message}` }
        }
      }
    }

    return { exitCode: 0, stdout: '', stderr: '' }
  }

  /**
   * rmdir - remove empty directories
   */
  private async execRmdir(parsed: ParsedCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const dirs = parsed.args.filter((a) => !a.startsWith('-'))

    for (const dir of dirs) {
      try {
        const path = this.resolvePath(dir)
        await this.fs.rmdir(path)
      } catch (error: any) {
        return { exitCode: 1, stdout: '', stderr: `rmdir: ${dir}: ${error.message}` }
      }
    }

    return { exitCode: 0, stdout: '', stderr: '' }
  }

  /**
   * cp - copy files
   */
  private async execCp(parsed: ParsedCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const args = parsed.args.filter((a) => !a.startsWith('-'))
    const recursive = parsed.flags['r'] === true || parsed.flags['R'] === true

    if (args.length < 2) {
      return { exitCode: 1, stdout: '', stderr: 'cp: missing destination file operand' }
    }

    const dest = this.resolvePath(args[args.length - 1])
    const sources = args.slice(0, -1).map((s) => this.resolvePath(s))

    for (const src of sources) {
      try {
        await this.fs.copyFile(src, dest, { recursive })
      } catch (error: any) {
        return { exitCode: 1, stdout: '', stderr: `cp: ${src}: ${error.message}` }
      }
    }

    return { exitCode: 0, stdout: '', stderr: '' }
  }

  /**
   * mv - move/rename files
   */
  private async execMv(parsed: ParsedCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const args = parsed.args.filter((a) => !a.startsWith('-'))
    const force = parsed.flags['f'] === true

    if (args.length < 2) {
      return { exitCode: 1, stdout: '', stderr: 'mv: missing destination file operand' }
    }

    const dest = this.resolvePath(args[args.length - 1])
    const sources = args.slice(0, -1).map((s) => this.resolvePath(s))

    for (const src of sources) {
      try {
        await this.fs.rename(src, dest, { overwrite: force })
      } catch (error: any) {
        return { exitCode: 1, stdout: '', stderr: `mv: ${src}: ${error.message}` }
      }
    }

    return { exitCode: 0, stdout: '', stderr: '' }
  }

  /**
   * touch - create empty file or update timestamps
   */
  private async execTouch(parsed: ParsedCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const files = parsed.args.filter((a) => !a.startsWith('-'))

    for (const file of files) {
      try {
        const path = this.resolvePath(file)
        const exists = await this.fs.exists(path)

        if (exists) {
          // Update timestamps
          const now = new Date()
          await this.fs.utimes(path, now, now)
        } else {
          // Create empty file
          await this.fs.write(path, '')
        }
      } catch (error: any) {
        return { exitCode: 1, stdout: '', stderr: `touch: ${file}: ${error.message}` }
      }
    }

    return { exitCode: 0, stdout: '', stderr: '' }
  }

  /**
   * pwd - print working directory
   */
  private execPwd(): { exitCode: number; stdout: string; stderr: string } {
    return { exitCode: 0, stdout: this.cwd + '\n', stderr: '' }
  }

  /**
   * cd - change directory
   */
  private async execCd(parsed: ParsedCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const args = parsed.args.filter((a) => !a.startsWith('-'))
    const target = args[0] ?? this.env.HOME

    try {
      const path = this.resolvePath(target)
      const stats = await this.fs.stat(path)

      if (!stats.isDirectory()) {
        return { exitCode: 1, stdout: '', stderr: `cd: ${target}: Not a directory` }
      }

      this.cwd = path
      this.env.PWD = path
      return { exitCode: 0, stdout: '', stderr: '' }
    } catch (error: any) {
      return { exitCode: 1, stdout: '', stderr: `cd: ${target}: ${error.message}` }
    }
  }

  /**
   * echo - display text
   */
  private execEcho(parsed: ParsedCommand): { exitCode: number; stdout: string; stderr: string } {
    const noNewline = parsed.flags['n'] === true
    const text = parsed.args.filter((a) => !a.startsWith('-')).join(' ')
    const output = noNewline ? text : text + '\n'
    return { exitCode: 0, stdout: output, stderr: '' }
  }

  /**
   * head - output first part of files
   */
  private async execHead(parsed: ParsedCommand, stdin?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const files = parsed.args.filter((a) => !a.startsWith('-'))
    const numLines = typeof parsed.flags['n'] === 'string' ? parseInt(parsed.flags['n'], 10) : 10

    // Handle stdin
    if (files.length === 0 && stdin !== undefined) {
      // Remove trailing newline before splitting to get accurate line count
      const trimmed = stdin.endsWith('\n') ? stdin.slice(0, -1) : stdin
      const lines = trimmed.split('\n').slice(0, numLines)
      return { exitCode: 0, stdout: lines.join('\n') + '\n', stderr: '' }
    }

    let output = ''
    for (const file of files) {
      try {
        const path = this.resolvePath(file)
        const content = await this.fs.read(path, { encoding: 'utf-8' }) as string
        // Remove trailing newline before splitting to get accurate line count
        const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content
        const lines = trimmed.split('\n').slice(0, numLines)

        if (files.length > 1) {
          output += `==> ${file} <==\n`
        }
        output += lines.join('\n') + '\n'
      } catch (error: any) {
        return { exitCode: 1, stdout: '', stderr: `head: ${file}: ${error.message}` }
      }
    }

    return { exitCode: 0, stdout: output, stderr: '' }
  }

  /**
   * tail - output last part of files
   */
  private async execTail(parsed: ParsedCommand, stdin?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const files = parsed.args.filter((a) => !a.startsWith('-'))
    const numLines = typeof parsed.flags['n'] === 'string' ? parseInt(parsed.flags['n'], 10) : 10

    // Handle stdin
    if (files.length === 0 && stdin !== undefined) {
      // Remove trailing newline before splitting to get accurate line count
      const trimmed = stdin.endsWith('\n') ? stdin.slice(0, -1) : stdin
      const lines = trimmed.split('\n')
      const lastLines = lines.slice(-numLines)
      return { exitCode: 0, stdout: lastLines.join('\n') + '\n', stderr: '' }
    }

    let output = ''
    for (const file of files) {
      try {
        const path = this.resolvePath(file)
        const content = await this.fs.read(path, { encoding: 'utf-8' }) as string
        // Remove trailing newline before splitting to get accurate line count
        const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content
        const lines = trimmed.split('\n')
        const lastLines = lines.slice(-numLines)

        if (files.length > 1) {
          output += `==> ${file} <==\n`
        }
        output += lastLines.join('\n') + '\n'
      } catch (error: any) {
        return { exitCode: 1, stdout: '', stderr: `tail: ${file}: ${error.message}` }
      }
    }

    return { exitCode: 0, stdout: output, stderr: '' }
  }

  /**
   * wc - word, line, character, and byte count
   */
  private async execWc(parsed: ParsedCommand, stdin?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const files = parsed.args.filter((a) => !a.startsWith('-'))
    const countLines = parsed.flags['l'] === true
    const countWords = parsed.flags['w'] === true
    const countBytes = parsed.flags['c'] === true
    const countChars = parsed.flags['m'] === true

    // If no specific flag, count all
    const countAll = !countLines && !countWords && !countBytes && !countChars

    const formatCount = (content: string, filename?: string): string => {
      const lines = content.split('\n').length - 1
      const words = content.split(/\s+/).filter(Boolean).length
      const chars = content.length
      const bytes = new TextEncoder().encode(content).length

      let result = ''
      if (countAll || countLines) result += String(lines).padStart(8)
      if (countAll || countWords) result += String(words).padStart(8)
      if (countAll || countBytes) result += String(bytes).padStart(8)
      if (countChars && !countBytes) result += String(chars).padStart(8)
      if (filename) result += ' ' + filename
      return result
    }

    // Handle stdin
    if (files.length === 0 && stdin !== undefined) {
      return { exitCode: 0, stdout: formatCount(stdin) + '\n', stderr: '' }
    }

    let output = ''
    for (const file of files) {
      try {
        const path = this.resolvePath(file)
        const content = await this.fs.read(path, { encoding: 'utf-8' }) as string
        output += formatCount(content, file) + '\n'
      } catch (error: any) {
        return { exitCode: 1, stdout: '', stderr: `wc: ${file}: ${error.message}` }
      }
    }

    return { exitCode: 0, stdout: output, stderr: '' }
  }

  /**
   * stat - display file status
   */
  private async execStat(parsed: ParsedCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const files = parsed.args.filter((a) => !a.startsWith('-'))

    let output = ''
    for (const file of files) {
      try {
        const path = this.resolvePath(file)
        const stats = await this.fs.stat(path)

        output += `  File: ${file}\n`
        output += `  Size: ${stats.size}\t\tBlocks: ${stats.blocks}\t\tIO Block: ${stats.blksize}\n`
        output += `Device: ${stats.dev}\t\tInode: ${stats.ino}\t\tLinks: ${stats.nlink}\n`
        output += `Access: (${stats.mode.toString(8)})\tUid: ${stats.uid}\tGid: ${stats.gid}\n`
        output += `Access: ${stats.atime.toISOString()}\n`
        output += `Modify: ${stats.mtime.toISOString()}\n`
        output += `Change: ${stats.ctime.toISOString()}\n`
        output += ` Birth: ${stats.birthtime.toISOString()}\n`
      } catch (error: any) {
        return { exitCode: 1, stdout: '', stderr: `stat: ${file}: ${error.message}` }
      }
    }

    return { exitCode: 0, stdout: output, stderr: '' }
  }

  /**
   * chmod - change file mode
   */
  private async execChmod(parsed: ParsedCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const args = parsed.args.filter((a) => !a.startsWith('-'))

    if (args.length < 2) {
      return { exitCode: 1, stdout: '', stderr: 'chmod: missing operand' }
    }

    const modeStr = args[0]
    const mode = parseInt(modeStr, 8)

    if (isNaN(mode)) {
      return { exitCode: 1, stdout: '', stderr: `chmod: invalid mode: '${modeStr}'` }
    }

    const files = args.slice(1)

    for (const file of files) {
      try {
        const path = this.resolvePath(file)
        await this.fs.chmod(path, mode)
      } catch (error: any) {
        return { exitCode: 1, stdout: '', stderr: `chmod: ${file}: ${error.message}` }
      }
    }

    return { exitCode: 0, stdout: '', stderr: '' }
  }

  /**
   * chown - change file owner
   */
  private async execChown(parsed: ParsedCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const args = parsed.args.filter((a) => !a.startsWith('-'))

    if (args.length < 2) {
      return { exitCode: 1, stdout: '', stderr: 'chown: missing operand' }
    }

    const ownerStr = args[0]
    const [uidStr, gidStr] = ownerStr.split(':')
    const uid = parseInt(uidStr, 10)
    const gid = gidStr ? parseInt(gidStr, 10) : uid

    if (isNaN(uid)) {
      return { exitCode: 1, stdout: '', stderr: `chown: invalid user: '${uidStr}'` }
    }

    const files = args.slice(1)

    for (const file of files) {
      try {
        const path = this.resolvePath(file)
        await this.fs.chown(path, uid, gid)
      } catch (error: any) {
        return { exitCode: 1, stdout: '', stderr: `chown: ${file}: ${error.message}` }
      }
    }

    return { exitCode: 0, stdout: '', stderr: '' }
  }

  /**
   * ln - create links
   */
  private async execLn(parsed: ParsedCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const args = parsed.args.filter((a) => !a.startsWith('-'))
    const symbolic = parsed.flags['s'] === true

    if (args.length < 2) {
      return { exitCode: 1, stdout: '', stderr: 'ln: missing destination file operand' }
    }

    const target = this.resolvePath(args[0])
    const linkPath = this.resolvePath(args[1])

    try {
      if (symbolic) {
        await this.fs.symlink(target, linkPath)
      } else {
        await this.fs.link(target, linkPath)
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    } catch (error: any) {
      return { exitCode: 1, stdout: '', stderr: `ln: ${error.message}` }
    }
  }

  /**
   * readlink - print resolved symbolic links
   */
  private async execReadlink(parsed: ParsedCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const files = parsed.args.filter((a) => !a.startsWith('-'))

    let output = ''
    for (const file of files) {
      try {
        const path = this.resolvePath(file)
        const target = await this.fs.readlink(path)
        output += target + '\n'
      } catch (error: any) {
        return { exitCode: 1, stdout: '', stderr: `readlink: ${file}: ${error.message}` }
      }
    }

    return { exitCode: 0, stdout: output, stderr: '' }
  }

  /**
   * realpath - print resolved path
   */
  private async execRealpath(parsed: ParsedCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const files = parsed.args.filter((a) => !a.startsWith('-'))

    let output = ''
    for (const file of files) {
      try {
        const path = this.resolvePath(file)
        const real = await this.fs.realpath(path)
        output += real + '\n'
      } catch (error: any) {
        return { exitCode: 1, stdout: '', stderr: `realpath: ${file}: ${error.message}` }
      }
    }

    return { exitCode: 0, stdout: output, stderr: '' }
  }

  /**
   * basename - strip directory from filenames
   */
  private execBasename(parsed: ParsedCommand): { exitCode: number; stdout: string; stderr: string } {
    const args = parsed.args.filter((a) => !a.startsWith('-'))

    if (args.length === 0) {
      return { exitCode: 1, stdout: '', stderr: 'basename: missing operand' }
    }

    const path = args[0]
    const suffix = args[1]
    let name = path.split('/').filter(Boolean).pop() ?? ''

    if (suffix && name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length)
    }

    return { exitCode: 0, stdout: name + '\n', stderr: '' }
  }

  /**
   * dirname - strip last component from file name
   */
  private execDirname(parsed: ParsedCommand): { exitCode: number; stdout: string; stderr: string } {
    const args = parsed.args.filter((a) => !a.startsWith('-'))

    if (args.length === 0) {
      return { exitCode: 1, stdout: '', stderr: 'dirname: missing operand' }
    }

    const path = args[0]
    const parts = path.split('/').filter(Boolean)
    parts.pop()

    const dir = parts.length > 0 ? '/' + parts.join('/') : (path.startsWith('/') ? '/' : '.')

    return { exitCode: 0, stdout: dir + '\n', stderr: '' }
  }

  /**
   * test / [ - evaluate conditional expression
   */
  private async execTest(parsed: ParsedCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    // For test command, we want all args including operators like -gt, -lt, etc.
    // Filter only applies to standard flags like -n (which for test is a test operator, not a flag)
    const args = [...parsed.args]

    // Remove trailing ] if present
    if (args.length > 0 && args[args.length - 1] === ']') {
      args.pop()
    }

    if (args.length === 0) {
      return { exitCode: 1, stdout: '', stderr: '' }
    }

    // Single argument: true if non-empty string
    if (args.length === 1) {
      return { exitCode: args[0] ? 0 : 1, stdout: '', stderr: '' }
    }

    // File tests
    if (args.length === 2) {
      const operator = args[0]
      const operand = args[1]

      switch (operator) {
        case '-e': {
          const exists = await this.fs.exists(this.resolvePath(operand))
          return { exitCode: exists ? 0 : 1, stdout: '', stderr: '' }
        }
        case '-f': {
          try {
            const stats = await this.fs.stat(this.resolvePath(operand))
            return { exitCode: stats.isFile() ? 0 : 1, stdout: '', stderr: '' }
          } catch {
            return { exitCode: 1, stdout: '', stderr: '' }
          }
        }
        case '-d': {
          try {
            const stats = await this.fs.stat(this.resolvePath(operand))
            return { exitCode: stats.isDirectory() ? 0 : 1, stdout: '', stderr: '' }
          } catch {
            return { exitCode: 1, stdout: '', stderr: '' }
          }
        }
        case '-r':
        case '-w':
        case '-x': {
          try {
            await this.fs.access(this.resolvePath(operand))
            return { exitCode: 0, stdout: '', stderr: '' }
          } catch {
            return { exitCode: 1, stdout: '', stderr: '' }
          }
        }
        case '-s': {
          try {
            const stats = await this.fs.stat(this.resolvePath(operand))
            return { exitCode: stats.size > 0 ? 0 : 1, stdout: '', stderr: '' }
          } catch {
            return { exitCode: 1, stdout: '', stderr: '' }
          }
        }
        case '-z': {
          return { exitCode: operand === '' ? 0 : 1, stdout: '', stderr: '' }
        }
        case '-n': {
          return { exitCode: operand !== '' ? 0 : 1, stdout: '', stderr: '' }
        }
      }
    }

    // String/number comparisons
    if (args.length === 3) {
      const left = args[0]
      const op = args[1]
      const right = args[2]

      switch (op) {
        case '=':
        case '==':
          return { exitCode: left === right ? 0 : 1, stdout: '', stderr: '' }
        case '!=':
          return { exitCode: left !== right ? 0 : 1, stdout: '', stderr: '' }
        case '-eq':
          return { exitCode: parseInt(left, 10) === parseInt(right, 10) ? 0 : 1, stdout: '', stderr: '' }
        case '-ne':
          return { exitCode: parseInt(left, 10) !== parseInt(right, 10) ? 0 : 1, stdout: '', stderr: '' }
        case '-lt':
          return { exitCode: parseInt(left, 10) < parseInt(right, 10) ? 0 : 1, stdout: '', stderr: '' }
        case '-le':
          return { exitCode: parseInt(left, 10) <= parseInt(right, 10) ? 0 : 1, stdout: '', stderr: '' }
        case '-gt':
          return { exitCode: parseInt(left, 10) > parseInt(right, 10) ? 0 : 1, stdout: '', stderr: '' }
        case '-ge':
          return { exitCode: parseInt(left, 10) >= parseInt(right, 10) ? 0 : 1, stdout: '', stderr: '' }
      }
    }

    return { exitCode: 2, stdout: '', stderr: 'test: invalid expression' }
  }

  // ===========================================================================
  // PUBLIC UTILITIES
  // ===========================================================================

  /**
   * Get current working directory
   */
  getCwd(): string {
    return this.cwd
  }

  /**
   * Set current working directory
   */
  setCwd(path: string): void {
    this.cwd = this.resolvePath(path)
    this.env.PWD = this.cwd
  }

  /**
   * Get environment variable
   */
  getEnv(name: string): string | undefined {
    return this.env[name]
  }

  /**
   * Set environment variable
   */
  setEnv(name: string, value: string): void {
    this.env[name] = value
  }

  /**
   * Get all environment variables
   */
  getAllEnv(): Record<string, string> {
    return { ...this.env }
  }
}

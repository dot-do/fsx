/**
 * Tool Execution and Output Management
 *
 * Handles running agent tools and storing their outputs
 * in the filesystem for later reference.
 */

import { FSx, ENOENT } from 'fsx.do'

const OUTPUTS_PATH = '/agent/outputs'

export interface ToolResult {
  toolName: string
  success: boolean
  output: unknown
  error?: string
  executedAt: number
  duration: number
}

interface ToolDefinition {
  name: string
  description: string
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

/**
 * Manages tool execution and output storage
 */
export class ToolRunner {
  private fs: FSx
  private tools: Map<string, ToolDefinition>

  constructor(fs: FSx) {
    this.fs = fs
    this.tools = new Map()

    // Register built-in tools
    this.registerBuiltInTools()
  }

  /**
   * Register built-in tools
   */
  private registerBuiltInTools(): void {
    // File reading tool
    this.register({
      name: 'readFile',
      description: 'Read the contents of a file',
      execute: async (args) => {
        const path = args.path as string
        return await this.fs.readFile(path, 'utf-8')
      },
    })

    // File writing tool
    this.register({
      name: 'writeFile',
      description: 'Write content to a file',
      execute: async (args) => {
        const path = args.path as string
        const content = args.content as string
        await this.fs.writeFile(path, content)
        return { written: true, path }
      },
    })

    // Directory listing tool
    this.register({
      name: 'listDirectory',
      description: 'List contents of a directory',
      execute: async (args) => {
        const path = args.path as string
        return await this.fs.readdir(path)
      },
    })

    // Code analysis tool (simulated)
    this.register({
      name: 'codeAnalysis',
      description: 'Analyze code files',
      execute: async (args) => {
        const language = args.language as string
        const files = args.files as string[]
        // Simulated analysis
        return {
          language,
          filesAnalyzed: files.length,
          issues: [],
          suggestions: [
            'Consider adding type annotations',
            'Add error handling for edge cases',
          ],
          metrics: {
            complexity: 'low',
            maintainability: 'high',
          },
        }
      },
    })

    // Data processing tool (simulated)
    this.register({
      name: 'processData',
      description: 'Process and transform data',
      execute: async (args) => {
        const data = args.data as unknown[]
        const operation = args.operation as string

        switch (operation) {
          case 'count':
            return { count: Array.isArray(data) ? data.length : 0 }
          case 'sum':
            return {
              sum: Array.isArray(data)
                ? data.reduce((a: number, b) => a + (typeof b === 'number' ? b : 0), 0)
                : 0,
            }
          case 'unique':
            return { unique: [...new Set(data)] }
          default:
            return { data }
        }
      },
    })

    // Web search tool (simulated)
    this.register({
      name: 'webSearch',
      description: 'Search the web for information',
      execute: async (args) => {
        const query = args.query as string
        // Simulated search results
        return {
          query,
          results: [
            {
              title: `Result 1 for "${query}"`,
              url: 'https://example.com/1',
              snippet: 'This is a simulated search result...',
            },
            {
              title: `Result 2 for "${query}"`,
              url: 'https://example.com/2',
              snippet: 'Another simulated search result...',
            },
          ],
        }
      },
    })
  }

  /**
   * Register a new tool
   */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool)
  }

  /**
   * Execute a tool by name
   */
  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(toolName)
    const startTime = Date.now()

    if (!tool) {
      return {
        toolName,
        success: false,
        output: null,
        error: `Unknown tool: ${toolName}`,
        executedAt: startTime,
        duration: 0,
      }
    }

    try {
      const output = await tool.execute(args)
      const duration = Date.now() - startTime

      const result: ToolResult = {
        toolName,
        success: true,
        output,
        executedAt: startTime,
        duration,
      }

      // Save result to outputs directory
      await this.saveResult(result)

      return result
    } catch (error) {
      const duration = Date.now() - startTime

      const result: ToolResult = {
        toolName,
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        executedAt: startTime,
        duration,
      }

      await this.saveResult(result)

      return result
    }
  }

  /**
   * Save a tool result to the outputs directory
   */
  private async saveResult(result: ToolResult): Promise<string> {
    const filename = `${result.toolName}-${result.executedAt}.json`
    const path = `${OUTPUTS_PATH}/${filename}`
    await this.fs.writeFile(path, JSON.stringify(result, null, 2))
    return path
  }

  /**
   * Get all available tools
   */
  listTools(): Array<{ name: string; description: string }> {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
    }))
  }

  /**
   * Get recent tool outputs
   */
  async getRecentOutputs(limit: number = 10): Promise<ToolResult[]> {
    try {
      const files = await this.fs.readdir(OUTPUTS_PATH)
      const jsonFiles = (files as string[])
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, limit)

      const results: ToolResult[] = []
      for (const file of jsonFiles) {
        try {
          const content = await this.fs.readFile(`${OUTPUTS_PATH}/${file}`, 'utf-8')
          results.push(JSON.parse(content as string))
        } catch {
          // Skip files that can't be read
        }
      }

      return results
    } catch (error) {
      if (error instanceof ENOENT) {
        return []
      }
      throw error
    }
  }

  /**
   * Clear all tool outputs
   */
  async clearOutputs(): Promise<void> {
    try {
      const files = await this.fs.readdir(OUTPUTS_PATH)
      for (const file of files as string[]) {
        await this.fs.unlink(`${OUTPUTS_PATH}/${file}`)
      }
    } catch (error) {
      if (!(error instanceof ENOENT)) {
        throw error
      }
    }
  }

  /**
   * Get tool execution statistics
   */
  async getStats(): Promise<{
    totalExecutions: number
    successRate: number
    averageDuration: number
    toolUsage: Record<string, number>
  }> {
    const outputs = await this.getRecentOutputs(1000)

    if (outputs.length === 0) {
      return {
        totalExecutions: 0,
        successRate: 0,
        averageDuration: 0,
        toolUsage: {},
      }
    }

    const successful = outputs.filter(r => r.success).length
    const totalDuration = outputs.reduce((sum, r) => sum + r.duration, 0)
    const toolUsage: Record<string, number> = {}

    for (const output of outputs) {
      toolUsage[output.toolName] = (toolUsage[output.toolName] || 0) + 1
    }

    return {
      totalExecutions: outputs.length,
      successRate: successful / outputs.length,
      averageDuration: totalDuration / outputs.length,
      toolUsage,
    }
  }
}

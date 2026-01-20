/**
 * AI Agent Example using fsx for persistent storage
 *
 * This example demonstrates an AI agent that uses fsx to:
 * - Store and retrieve conversation history
 * - Manage a workspace with context files
 * - Save tool execution outputs
 * - Maintain persistent memory across sessions
 */

import { createFs, FSx, ENOENT } from 'fsx.do'
import { ConversationMemory, Message } from './memory.js'
import { Workspace } from './workspace.js'
import { ToolRunner, ToolResult } from './tools.js'

// Agent configuration
interface AgentConfig {
  name: string
  systemPrompt: string
  maxHistoryLength: number
}

/**
 * AI Agent with filesystem-backed storage
 */
export class Agent {
  private fs: FSx
  private memory: ConversationMemory
  private workspace: Workspace
  private tools: ToolRunner
  private config: AgentConfig

  constructor(config: Partial<AgentConfig> = {}) {
    // Create in-memory filesystem (use TieredFS for production)
    this.fs = createFs()

    this.config = {
      name: config.name ?? 'Assistant',
      systemPrompt: config.systemPrompt ?? 'You are a helpful AI assistant.',
      maxHistoryLength: config.maxHistoryLength ?? 100,
    }

    // Initialize components with shared filesystem
    this.memory = new ConversationMemory(this.fs)
    this.workspace = new Workspace(this.fs)
    this.tools = new ToolRunner(this.fs)
  }

  /**
   * Initialize the agent's filesystem structure
   */
  async initialize(): Promise<void> {
    console.log(`Initializing agent: ${this.config.name}`)

    // Create directory structure
    await this.fs.mkdir('/agent/memory', { recursive: true })
    await this.fs.mkdir('/agent/workspace', { recursive: true })
    await this.fs.mkdir('/agent/outputs', { recursive: true })
    await this.fs.mkdir('/agent/config', { recursive: true })

    // Save agent configuration
    await this.fs.writeFile(
      '/agent/config/settings.json',
      JSON.stringify(this.config, null, 2)
    )

    // Initialize components
    await this.memory.initialize()
    await this.workspace.initialize()

    console.log('Agent initialized successfully')
  }

  /**
   * Process a user message and generate a response
   */
  async chat(userMessage: string): Promise<string> {
    // Add user message to history
    await this.memory.addMessage({
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
    })

    // Get conversation context
    const history = await this.memory.getHistory(10)
    const context = await this.workspace.getContext()

    // Simulate AI response (in production, call an LLM API)
    const response = await this.generateResponse(userMessage, history, context)

    // Save assistant response
    await this.memory.addMessage({
      role: 'assistant',
      content: response,
      timestamp: Date.now(),
    })

    return response
  }

  /**
   * Execute a tool and save the results
   */
  async executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    console.log(`Executing tool: ${toolName}`)

    const result = await this.tools.execute(toolName, args)

    // Save tool result to outputs
    const outputPath = `/agent/outputs/${toolName}-${Date.now()}.json`
    await this.fs.writeFile(outputPath, JSON.stringify(result, null, 2))

    console.log(`Tool output saved to: ${outputPath}`)
    return result
  }

  /**
   * Add a file to the agent's workspace
   */
  async addToWorkspace(filename: string, content: string): Promise<void> {
    await this.workspace.addFile(filename, content)
    console.log(`Added to workspace: ${filename}`)
  }

  /**
   * List files in the workspace
   */
  async listWorkspace(): Promise<string[]> {
    return this.workspace.listFiles()
  }

  /**
   * Get the agent's conversation history
   */
  async getHistory(): Promise<Message[]> {
    return this.memory.getHistory()
  }

  /**
   * Clear the agent's memory
   */
  async clearMemory(): Promise<void> {
    await this.memory.clear()
    console.log('Memory cleared')
  }

  /**
   * Generate a response based on message, history, and context
   * In production, this would call an LLM API
   */
  private async generateResponse(
    message: string,
    history: Message[],
    context: string
  ): Promise<string> {
    // Simulate response generation
    // In production: call OpenAI, Anthropic, or other LLM API

    if (message.toLowerCase().includes('list files')) {
      const files = await this.listWorkspace()
      return `Here are the files in your workspace:\n${files.map(f => `- ${f}`).join('\n')}`
    }

    if (message.toLowerCase().includes('save')) {
      return 'I can help you save files. What content would you like to save and what filename?'
    }

    if (message.toLowerCase().includes('history')) {
      return `You have ${history.length} messages in your conversation history.`
    }

    return `I received your message: "${message}". I have access to ${history.length} previous messages and context from your workspace.`
  }
}

// Main execution
async function main() {
  const agent = new Agent({
    name: 'CodeAssistant',
    systemPrompt: 'You are a helpful coding assistant with access to a filesystem.',
  })

  await agent.initialize()

  // Add some context files to the workspace
  await agent.addToWorkspace('project.md', `# Project Overview
This is a demonstration project showing fsx usage with AI agents.
`)

  await agent.addToWorkspace('requirements.txt', `fsx.do>=0.1.0
typescript>=5.0.0
`)

  // Simulate a conversation
  console.log('\n--- Starting conversation ---\n')

  const response1 = await agent.chat('Hello! Can you list the files in my workspace?')
  console.log(`Assistant: ${response1}\n`)

  const response2 = await agent.chat("What's in my conversation history?")
  console.log(`Assistant: ${response2}\n`)

  // Execute a tool
  const toolResult = await agent.executeTool('codeAnalysis', {
    language: 'typescript',
    files: ['agent.ts'],
  })
  console.log('Tool result:', toolResult)

  // Show final history
  const history = await agent.getHistory()
  console.log(`\nConversation has ${history.length} messages`)
}

main().catch(console.error)

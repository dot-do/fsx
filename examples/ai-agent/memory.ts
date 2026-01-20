/**
 * Conversation Memory Management
 *
 * Stores and retrieves conversation history using fsx.
 * Messages are persisted to a JSON file for durability.
 */

import { FSx, ENOENT } from 'fsx.do'

export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  metadata?: Record<string, unknown>
}

interface MemoryState {
  messages: Message[]
  createdAt: number
  updatedAt: number
}

const MEMORY_PATH = '/agent/memory/history.json'
const MAX_MESSAGES = 1000

/**
 * Manages conversation history with persistent storage
 */
export class ConversationMemory {
  private fs: FSx
  private state: MemoryState | null = null

  constructor(fs: FSx) {
    this.fs = fs
  }

  /**
   * Initialize memory, loading existing history if present
   */
  async initialize(): Promise<void> {
    try {
      const data = await this.fs.readFile(MEMORY_PATH, 'utf-8')
      this.state = JSON.parse(data as string)
      console.log(`Loaded ${this.state?.messages.length ?? 0} messages from memory`)
    } catch (error) {
      if (error instanceof ENOENT) {
        // No existing history, create new state
        this.state = {
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        await this.save()
        console.log('Created new conversation memory')
      } else {
        throw error
      }
    }
  }

  /**
   * Add a message to the conversation history
   */
  async addMessage(message: Message): Promise<void> {
    if (!this.state) {
      throw new Error('Memory not initialized')
    }

    this.state.messages.push(message)
    this.state.updatedAt = Date.now()

    // Trim old messages if exceeding limit
    if (this.state.messages.length > MAX_MESSAGES) {
      this.state.messages = this.state.messages.slice(-MAX_MESSAGES)
    }

    await this.save()
  }

  /**
   * Get recent conversation history
   */
  async getHistory(limit?: number): Promise<Message[]> {
    if (!this.state) {
      throw new Error('Memory not initialized')
    }

    const messages = this.state.messages
    if (limit && limit < messages.length) {
      return messages.slice(-limit)
    }
    return [...messages]
  }

  /**
   * Search messages by content
   */
  async search(query: string): Promise<Message[]> {
    if (!this.state) {
      throw new Error('Memory not initialized')
    }

    const lowerQuery = query.toLowerCase()
    return this.state.messages.filter(
      msg => msg.content.toLowerCase().includes(lowerQuery)
    )
  }

  /**
   * Get messages by role
   */
  async getByRole(role: Message['role']): Promise<Message[]> {
    if (!this.state) {
      throw new Error('Memory not initialized')
    }

    return this.state.messages.filter(msg => msg.role === role)
  }

  /**
   * Clear all conversation history
   */
  async clear(): Promise<void> {
    if (!this.state) {
      throw new Error('Memory not initialized')
    }

    this.state.messages = []
    this.state.updatedAt = Date.now()
    await this.save()
  }

  /**
   * Export memory to a backup file
   */
  async export(path: string): Promise<void> {
    if (!this.state) {
      throw new Error('Memory not initialized')
    }

    await this.fs.writeFile(path, JSON.stringify(this.state, null, 2))
  }

  /**
   * Import memory from a backup file
   */
  async import(path: string): Promise<void> {
    const data = await this.fs.readFile(path, 'utf-8')
    this.state = JSON.parse(data as string)
    await this.save()
  }

  /**
   * Get memory statistics
   */
  getStats(): { messageCount: number; createdAt: number; updatedAt: number } {
    if (!this.state) {
      throw new Error('Memory not initialized')
    }

    return {
      messageCount: this.state.messages.length,
      createdAt: this.state.createdAt,
      updatedAt: this.state.updatedAt,
    }
  }

  /**
   * Save state to filesystem
   */
  private async save(): Promise<void> {
    if (!this.state) return
    await this.fs.writeFile(MEMORY_PATH, JSON.stringify(this.state, null, 2))
  }
}

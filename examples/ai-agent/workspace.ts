/**
 * Workspace File Operations
 *
 * Manages the agent's workspace directory where context files,
 * user uploads, and working documents are stored.
 */

import { FSx, ENOENT, Dirent } from 'fsx.do'

const WORKSPACE_PATH = '/agent/workspace'
const CONTEXT_FILE = '/agent/workspace/.context.md'

interface FileInfo {
  name: string
  path: string
  size: number
  modifiedAt: Date
  isDirectory: boolean
}

/**
 * Manages the agent's workspace for context files
 */
export class Workspace {
  private fs: FSx

  constructor(fs: FSx) {
    this.fs = fs
  }

  /**
   * Initialize the workspace
   */
  async initialize(): Promise<void> {
    try {
      await this.fs.stat(WORKSPACE_PATH)
    } catch (error) {
      if (error instanceof ENOENT) {
        await this.fs.mkdir(WORKSPACE_PATH, { recursive: true })
      } else {
        throw error
      }
    }

    // Create default context file if it doesn't exist
    try {
      await this.fs.stat(CONTEXT_FILE)
    } catch (error) {
      if (error instanceof ENOENT) {
        await this.fs.writeFile(CONTEXT_FILE, '# Workspace Context\n\nNo context set.\n')
      } else {
        throw error
      }
    }
  }

  /**
   * Add a file to the workspace
   */
  async addFile(filename: string, content: string): Promise<string> {
    const path = `${WORKSPACE_PATH}/${filename}`
    await this.fs.writeFile(path, content)
    await this.updateContext()
    return path
  }

  /**
   * Read a file from the workspace
   */
  async readFile(filename: string): Promise<string> {
    const path = `${WORKSPACE_PATH}/${filename}`
    return await this.fs.readFile(path, 'utf-8') as string
  }

  /**
   * Delete a file from the workspace
   */
  async deleteFile(filename: string): Promise<void> {
    const path = `${WORKSPACE_PATH}/${filename}`
    await this.fs.unlink(path)
    await this.updateContext()
  }

  /**
   * List all files in the workspace
   */
  async listFiles(): Promise<string[]> {
    const entries = await this.fs.readdir(WORKSPACE_PATH)
    return (entries as string[]).filter(name => !name.startsWith('.'))
  }

  /**
   * Get detailed file information
   */
  async getFileInfo(filename: string): Promise<FileInfo> {
    const path = `${WORKSPACE_PATH}/${filename}`
    const stats = await this.fs.stat(path)
    return {
      name: filename,
      path,
      size: stats.size,
      modifiedAt: stats.mtime,
      isDirectory: stats.isDirectory(),
    }
  }

  /**
   * Get all file information in the workspace
   */
  async getAllFileInfo(): Promise<FileInfo[]> {
    const files = await this.listFiles()
    const infos: FileInfo[] = []

    for (const file of files) {
      try {
        const info = await this.getFileInfo(file)
        infos.push(info)
      } catch {
        // Skip files that can't be read
      }
    }

    return infos
  }

  /**
   * Get the compiled context from all workspace files
   */
  async getContext(): Promise<string> {
    try {
      return await this.fs.readFile(CONTEXT_FILE, 'utf-8') as string
    } catch (error) {
      if (error instanceof ENOENT) {
        return ''
      }
      throw error
    }
  }

  /**
   * Set custom context content
   */
  async setContext(content: string): Promise<void> {
    await this.fs.writeFile(CONTEXT_FILE, content)
  }

  /**
   * Search for files matching a pattern
   */
  async searchFiles(pattern: string): Promise<string[]> {
    const files = await this.listFiles()
    const regex = new RegExp(pattern, 'i')
    return files.filter(file => regex.test(file))
  }

  /**
   * Search file contents
   */
  async searchContent(query: string): Promise<Array<{ file: string; matches: string[] }>> {
    const files = await this.listFiles()
    const results: Array<{ file: string; matches: string[] }> = []

    for (const file of files) {
      try {
        const content = await this.readFile(file)
        const lines = content.split('\n')
        const matches = lines.filter(line =>
          line.toLowerCase().includes(query.toLowerCase())
        )

        if (matches.length > 0) {
          results.push({ file, matches })
        }
      } catch {
        // Skip files that can't be read
      }
    }

    return results
  }

  /**
   * Create a subdirectory in the workspace
   */
  async createDirectory(dirname: string): Promise<string> {
    const path = `${WORKSPACE_PATH}/${dirname}`
    await this.fs.mkdir(path, { recursive: true })
    return path
  }

  /**
   * Copy a file within the workspace
   */
  async copyFile(source: string, destination: string): Promise<void> {
    const sourcePath = `${WORKSPACE_PATH}/${source}`
    const destPath = `${WORKSPACE_PATH}/${destination}`
    await this.fs.copyFile(sourcePath, destPath)
  }

  /**
   * Move/rename a file in the workspace
   */
  async moveFile(source: string, destination: string): Promise<void> {
    const sourcePath = `${WORKSPACE_PATH}/${source}`
    const destPath = `${WORKSPACE_PATH}/${destination}`
    await this.fs.rename(sourcePath, destPath)
    await this.updateContext()
  }

  /**
   * Update the context file with workspace summary
   */
  private async updateContext(): Promise<void> {
    const files = await this.getAllFileInfo()

    let context = '# Workspace Context\n\n'
    context += `Last updated: ${new Date().toISOString()}\n\n`
    context += '## Files\n\n'

    for (const file of files) {
      context += `- **${file.name}** (${file.size} bytes, modified ${file.modifiedAt.toISOString()})\n`
    }

    if (files.length === 0) {
      context += 'No files in workspace.\n'
    }

    await this.fs.writeFile(CONTEXT_FILE, context)
  }

  /**
   * Get workspace statistics
   */
  async getStats(): Promise<{
    fileCount: number
    totalSize: number
    lastModified: Date | null
  }> {
    const files = await this.getAllFileInfo()

    return {
      fileCount: files.length,
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
      lastModified: files.length > 0
        ? new Date(Math.max(...files.map(f => f.modifiedAt.getTime())))
        : null,
    }
  }
}

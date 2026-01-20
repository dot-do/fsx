# AI Agent with fsx Storage

This example demonstrates how to build an AI agent that uses fsx for persistent file storage. The agent can read and write files, maintain conversation history, and store tool outputs.

## Use Case

AI agents often need to:
- Store conversation history across sessions
- Save and retrieve context files
- Write tool outputs (code, data, reports)
- Maintain a workspace with multiple files and directories

fsx provides a familiar POSIX filesystem API that makes these operations straightforward.

## Features

- **Persistent Memory**: Store conversation history and context in files
- **Workspace Management**: Create directories, organize files
- **Tool Integration**: Save outputs from code execution, data analysis, etc.
- **File Watching**: React to changes in watched files

## Quick Start

```bash
# Install dependencies
npm install

# Run the example
npm start
```

## Code Overview

### agent.ts

The main agent implementation that demonstrates:

```typescript
import { createFs, FSx } from 'fsx.do'

// Create a filesystem for the agent
const fs = createFs()

// Initialize agent workspace
await fs.mkdir('/agent/memory', { recursive: true })
await fs.mkdir('/agent/workspace', { recursive: true })
await fs.mkdir('/agent/outputs', { recursive: true })

// Store conversation history
await fs.writeFile('/agent/memory/history.json', JSON.stringify(messages))

// Read context files
const context = await fs.readFile('/agent/workspace/context.md', 'utf-8')

// Save tool outputs
await fs.writeFile('/agent/outputs/analysis.json', JSON.stringify(results))
```

### Key APIs Used

| API | Purpose |
|-----|---------|
| `mkdir(path, { recursive: true })` | Create agent directories |
| `writeFile(path, data)` | Save conversation history and outputs |
| `readFile(path, encoding)` | Load context and configuration |
| `readdir(path)` | List files in workspace |
| `stat(path)` | Get file metadata |
| `watch(path, callback)` | React to file changes |

## Project Structure

```
ai-agent/
├── README.md           # This file
├── package.json        # Dependencies
├── agent.ts            # Main agent implementation
├── memory.ts           # Conversation memory management
├── workspace.ts        # Workspace file operations
└── tools.ts            # Tool output handling
```

## Example Output

```
Agent initialized with workspace at /agent
Loaded 5 previous conversations from memory
Context file updated: /agent/workspace/project.md
Executing code analysis tool...
Results saved to /agent/outputs/analysis-2024-01-15.json
```

## Production Deployment

In production, connect to Cloudflare Durable Objects for persistent storage:

```typescript
import { FileSystemDO } from 'fsx.do'

export { FileSystemDO }

export default {
  async fetch(request, env) {
    // Each agent gets its own isolated filesystem
    const agentId = env.FSX.idFromName(`agent-${userId}`)
    const stub = env.FSX.get(agentId)
    return stub.fetch(request)
  }
}
```

## Related

- [fsx.do Documentation](https://fsx.do)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [AI Agent Patterns](https://agents.do)

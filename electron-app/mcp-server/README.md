# TaskSpace MCP Server

Model Context Protocol (MCP) server for managing VSCode taskspaces through AI agents.

## Overview

This MCP server enables AI agents to:
- Create new taskspaces with AI agents for focused development work
- Log progress with visual indicators and categories
- Signal users when help is needed

**Important**: The MCP server must be running from within a taskspace directory (containing a UUID in the path) to offer any tools. When run from outside a taskspace, it returns zero tools.

## Tools

### `new_taskspace`
Create a new taskspace with an AI agent for focused development work. The taskspace will start with an AI agent that can optionally be given an initial prompt to begin performing research, coding, or other tasks.

**Parameters:**
- `name` (string, required): Name for the taskspace
- `short_description` (string, required): Brief description of the work to be done  
- `initial_prompt` (string, optional): Initial prompt or context for the AI agent to get started with the task

### `log_progress`
Log progress on the current task with visual indicators.

**Parameters:**
- `message` (string, required): Progress message to log
- `category` (enum, required): Category of progress
  - `info` ℹ️ - General information
  - `warn` ⚠️ - Warnings or concerns
  - `error` ❌ - Errors or failures
  - `milestone` ✅ - Completed milestones
  - `question` ❓ - Questions or uncertainties

### `signal_user`
Signal the user for help or attention.

**Parameters:**
- `message` (string, required): Message requesting user help or attention

## Usage

### Installation
```bash
cd electron-app/mcp-server
npm install
npm run build
```

### Running
```bash
npm start
```

### Configuration
The server connects to the theoldswitcheroo daemon via Unix socket. Configure the socket path with:
```bash
export THEOLDSWITCHEROO_SOCKET=/path/to/daemon.sock
```

Default: `~/.socratic-shell/theoldswitcheroo/daemon.sock`

## Architecture

```
AI Agent → MCP Client → MCP Server → Unix Socket → Daemon → Electron App
```

The MCP server translates MCP tool calls into daemon messages that flow through the existing theoldswitcheroo communication infrastructure.

## Taskspace Synchronization

The MCP server automatically detects which taskspace it's running in by:

1. **UUID Detection**: Extracts UUID from current working directory path
2. **Tool Availability**: Only offers tools when running within a taskspace directory
3. **Message Routing**: Includes taskspace UUID in all messages for proper routing

**Example paths that work:**
- `/path/to/taskspaces/12345678-1234-1234-1234-123456789abc/clone`
- `/Users/name/work/uuid-here/project`

**Behavior:**
- **In taskspace**: All 3 tools available (new_taskspace, log_progress, signal_user)
- **Outside taskspace**: Zero tools available, tool calls return error

## Testing

```bash
npm test
```

Or test manually:
```bash
node test-mcp.js
```

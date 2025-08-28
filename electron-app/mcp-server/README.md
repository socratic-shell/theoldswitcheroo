# TaskSpace MCP Server

Model Context Protocol (MCP) server for managing VSCode taskspaces through AI agents.

## Overview

This MCP server enables AI agents to:
- Create new taskspaces for focused development work
- Log progress with visual indicators and categories
- Signal users when help is needed

## Tools

### `new_taskspace`
Create a new taskspace for focused development work.

**Parameters:**
- `name` (string, required): Name for the taskspace
- `short_description` (string, required): Brief description of the work to be done  
- `initial_prompt` (string, required): Initial prompt or context for the taskspace

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

## Testing

```bash
npm test
```

Or test manually:
```bash
node test-mcp.js
```

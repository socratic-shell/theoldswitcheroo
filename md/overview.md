# Overview

A VSCode multiplexer for managing multiple AI agent workspaces.

## Vision

Enable parallel AI collaboration by providing:
- Multiple isolated VSCode sessions
- Visual indicators for agent attention states
- MCP server integration for workspace spawning

## Prototype Goals

1. **Setup Tool**: Rust CLI to deploy openvscode-server remotely
2. **Electron App**: UI for managing multiple sessions with sidebar navigation
3. **MCP Integration**: Server to spawn fresh workspaces for agents

The prototype validates the core concept: can we create a pleasant UI for managing multiple concurrent development sessions?

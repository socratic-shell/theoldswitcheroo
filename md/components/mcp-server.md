# MCP Server

Model Context Protocol server for spawning agent workspaces.

## Tools
- `spawn_workspace`: Create fresh development environment for an agent
- `list_workspaces`: Show active sessions
- `terminate_workspace`: Clean up completed sessions

## Integration
- Calls Setup Tool to create remote sessions
- Communicates with Electron App for UI updates
- Monitors agent activity for attention signals

## Future Implementation
- Rust with MCP protocol support
- Agent lifecycle management
- Workspace templating

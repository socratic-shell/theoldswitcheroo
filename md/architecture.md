# Architecture

Three components working together:

```
[MCP Server] ──spawns──> [Setup Tool] ──SSH──> [Remote openvscode-server]
     │                                                    │
     └─────> [Electron App] ──HTTP tunnel──> ─────────────┘
```

## Data Flow

1. **MCP Server** receives spawn request
2. **Setup Tool** SSH's to remote host, starts openvscode-server
3. **Electron App** displays session in webview via SSH tunnel
4. **Agent** works in remote VSCode, signals completion
5. **Electron App** shows attention indicator

## Key Design Decisions

- **SSH tunneling** for secure remote access
- **Parent process monitoring** for automatic cleanup
- **Sidebar + webview** UI pattern for session management
- **Rust** for system-level tooling, **Electron** for UI

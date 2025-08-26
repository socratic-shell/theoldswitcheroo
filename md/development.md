# Development

## Milestones

### 0.5: Setup Tool
Rust CLI that deploys openvscode-server to remote hosts with auto-cleanup.

### 1.0: Single Session UI
Electron app with sidebar showing one session, webview displaying remote VSCode.

### 2.0: Multi-Session Management
Support multiple concurrent sessions with tab switching.

### 3.0: MCP Integration
Server that can spawn workspaces and manage agent lifecycles.

## Getting Started

1. Build setup tool: `cd setup-tool && cargo build`
2. Test remote deployment: `cargo run -- --host your-server`
3. Build Electron app: `cd electron-app && npm install && npm start`

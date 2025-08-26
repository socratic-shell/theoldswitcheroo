# Electron App

Desktop UI for managing multiple VSCode sessions.

## Layout
- **Sidebar**: Session list with numbered boxes and attention indicators
- **Main Area**: Webview displaying active VSCode session

## Features
- Tab-like session switching
- SSH tunnel management
- Visual attention indicators (green=working, yellow=needs attention)
- Session lifecycle management

## Implementation
- Electron with TypeScript
- `node-ssh` for tunnel management
- Webview for VSCode embedding

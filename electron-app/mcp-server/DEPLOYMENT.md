# TaskSpace MCP Server - Deployment

## Automated Installation

The easiest way to deploy the MCP server to a remote host:

```bash
npm run install-mcp-server <host> <path>
```

**Examples:**
```bash
npm run install-mcp-server myserver.com /usr/local/bin/theoldswitcheroo-mcp
npm run install-mcp-server user@host.com ~/bin/theoldswitcheroo-mcp
```

This will:
1. Bundle the MCP server into a standalone executable
2. Copy it to the specified path on the remote host via scp
3. Make it executable on the remote host
4. Show MCP client configuration example

**Requirements:**
- SSH access to the target host
- `scp` and `ssh` commands available locally

## Manual Installation

### Standalone Executables

The MCP server is available as standalone executables that include Node.js runtime, making them completely location-independent.

### Available Platforms

- **macOS (x64)**: `bin/bundle-macos`
- **Linux (x64)**: `bin/bundle-linux` 
- **Windows (x64)**: `bin/bundle-win.exe`

### Building Executables

```bash
npm run package
```

This creates standalone executables in the `bin/` directory for all three platforms.

### Usage

The executables work exactly like the Node.js version:

```bash
# macOS/Linux
./bin/bundle-macos

# Windows  
bundle-win.exe
```

### Configuration

Set environment variables before running:

```bash
export THEOLDSWITCHEROO_SOCKET=/path/to/daemon.sock
./bin/bundle-macos
```

### MCP Client Integration

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "theoldswitcheroo": {
      "command": "/path/to/bundle-macos",
      "env": {
        "THEOLDSWITCHEROO_SOCKET": "/Users/username/.socratic-shell/theoldswitcheroo/daemon.sock"
      }
    }
  }
}
```

### File Sizes

- macOS: ~50MB
- Linux: ~46MB  
- Windows: ~38MB

The executables are self-contained and require no additional dependencies.

### Testing

Test the executable with a simple MCP request:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | ./bin/bundle-macos
```

Should return the list of available tools (new_taskspace, log_progress, signal_user).

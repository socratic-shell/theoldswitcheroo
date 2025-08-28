# TaskSpace MCP Server - Deployment

## Standalone Executables

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

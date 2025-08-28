# TaskSpace Communication Architecture

The VSCode multiplexer enables bidirectional communication between remote VSCode taskspaces and the Electron app through a daemon-based architecture. This allows users to manage taskspaces from within their development environment using command-line tools.

## Architecture Overview

The communication system consists of three components:

1. **Electron App** - Manages taskspace lifecycle and UI
2. **Remote Daemon** - Message router running on the remote host
3. **CLI Tools** - Command-line interface for taskspace management

```
┌─────────────────┐    SSH Connection    ┌─────────────────┐
│   Electron App  │◄═══════════════════►│  Remote Daemon  │
│                 │   stdin/stdout       │                 │
└─────────────────┘                      └─────┬───────────┘
                                               │ Unix Socket
                                               │ ${BASE_DIR}/daemon.sock
                                               │
                                         ┌─────▼───────────┐
                                         │   CLI Tools     │
                                         │ & VSCode TaskSpaces│
                                         └─────────────────┘
```

## Component Lifecycle

### Daemon Process Management

The daemon follows the same lifecycle pattern as SSH master connections:

1. **Startup**: Electron app starts daemon via SSH when first taskspace is created
2. **Persistence**: Daemon stays alive for entire Electron app duration
3. **Cleanup**: Daemon terminates when Electron app shuts down

```javascript
// Daemon startup through SSH connection manager
const socketPath = `${BASE_DIR}/daemon.sock`;

const daemonScript = `
  cd ${BASE_DIR}
  rm -f daemon.sock  # Clean up any stale socket
  ./nodejs/bin/node daemon.js --socket-path daemon.sock
`;

const daemonProcess = await sshManager.executeStreamingCommand(hostname, daemonScript);
```

### Session Management and Instance Locking

The daemon uses a fixed socket path that serves as both communication channel and instance lock:

**Socket Path:** `${BASE_DIR}/daemon.sock`

This approach provides natural instance management:
- Only one Electron app can manage a remote host at a time
- Socket file acts as a lock - its presence indicates an active instance
- Simple discovery for CLI tools (always same location)
- Automatic cleanup detection (missing socket = no active instance)

### Instance Handoff Protocol

When starting up, if another instance is detected:

```javascript
// Electron app startup
const socketPath = `${BASE_DIR}/daemon.sock`;

if (fs.existsSync(socketPath)) {
  const result = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Take Over', 'Cancel'],
    defaultId: 1,
    message: 'Another instance is managing this host',
    detail: 'Do you want to take over management? The other instance will shut down gracefully.'
  });
  
  if (result.response === 0) {
    // User chose "Take Over" - delete the socket
    fs.unlinkSync(socketPath);
    // Wait for other instance to detect and shut down
    await new Promise(resolve => setTimeout(resolve, 2000));
  } else {
    process.exit(0);
  }
}
```

The running instance monitors for socket deletion and shuts down gracefully:

```javascript
class TaskSpaceCommunicationManager {
  startDaemon(hostname) {
    // ... start daemon ...
    
    // Monitor socket file for deletion (another instance taking over)
    this.socketWatcher = fs.watchFile(socketPath, (curr, prev) => {
      if (!fs.existsSync(socketPath)) {
        console.log('Socket file deleted - another instance is taking over');
        this.gracefulShutdown();
      }
    });
  }
  
  gracefulShutdown() {
    // Clean up daemon process
    if (this.daemonProcess) {
      this.daemonProcess.kill();
    }
    
    // Notify user
    dialog.showMessageBox({
      type: 'info',
      message: 'Another instance has taken over',
      detail: 'This instance will now close.'
    });
    
    app.quit();
  }
}
```

## Communication Protocols

### Message Flow

**TaskSpace → Electron:**
1. CLI tool connects to Unix socket
2. Daemon receives message from socket
3. Daemon forwards message to Electron via SSH stdout
4. Electron processes message and updates state

**Electron → TaskSpace:**
1. Electron sends message via SSH stdin
2. Daemon receives message from SSH stdin
3. Daemon broadcasts to connected CLI tools via Unix socket

### Message Format

All messages use single-line JSON format with a `type` field for routing:

```json
{"type":"new_taskspace_request","name":"API Server","description":"Main backend service","cwd":"/home/user/projects/api-server","timestamp":"2025-08-27T20:45:00Z"}

{"type":"update_taskspace","uuid":"abc123-def456-789","description":"Updated: Now includes authentication","timestamp":"2025-08-27T20:46:00Z"}

{"type":"taskspace_status","uuid":"abc123-def456-789","status":"ready","message":"TaskSpace is ready for connections"}
```

Each message is terminated with a newline character (`\n`) for reliable parsing over stdin/stdout and Unix sockets.

## Implementation Components

### Remote Daemon (daemon.js)

The daemon is a Node.js process that acts as a message router:

```javascript
const net = require('net');

class TaskSpaceDaemon {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.clients = new Set();
    this.setupUnixSocket();
    this.setupStdioHandling();
  }
  
  setupUnixSocket() {
    this.server = net.createServer((socket) => {
      this.clients.add(socket);
      
      socket.on('data', (data) => {
        // Forward message to Electron via stdout
        process.stdout.write(data + '\n');
      });
      
      socket.on('close', () => {
        this.clients.delete(socket);
      });
    });
    
    this.server.listen(this.socketPath);
  }
  
  setupStdioHandling() {
    // Receive messages from Electron via stdin
    process.stdin.on('data', (data) => {
      const message = data.toString().trim();
      
      // Broadcast to all connected clients
      for (const client of this.clients) {
        client.write(message + '\n');
      }
    });
  }
}
```

### CLI Tools

Command-line tools connect to the daemon's Unix socket:

```javascript
// theoldswitcheroo CLI tool
const net = require('net');
const path = require('path');

function sendMessage(message) {
  const socketPath = path.join(process.env.BASE_DIR || '~/.socratic-shell/theoldswitcheroo', 'daemon.sock');
  
  if (!require('fs').existsSync(socketPath)) {
    console.error('No active theoldswitcheroo instance found');
    process.exit(1);
  }
  
  const client = net.createConnection(socketPath);
  client.write(JSON.stringify(message));
  client.end();
}

// Usage: theoldswitcheroo new-taskspace --name "API Server"
sendMessage({
  type: 'new_taskspace_request',
  name: process.argv[3],
  description: process.argv[5] || '',
  cwd: process.cwd(),
  timestamp: new Date().toISOString()
});
```

### Electron Integration

The Electron app manages daemon lifecycle and processes messages:

```javascript
class TaskSpaceCommunicationManager {
  constructor(sshManager) {
    this.sshManager = sshManager;
    this.sessionUuid = generateUUID();
    this.daemonProcess = null;
  }
  
  async startDaemon(hostname) {
    const socketPath = `/tmp/theoldswitcheroo-${this.sessionUuid}.sock`;
    
    const daemonScript = `
      cd ${BASE_DIR}
      export THEOLDSWITCHEROO_SOCKET="${socketPath}"
      ./nodejs/bin/node daemon.js --socket-path "${socketPath}"
    `;
    
    this.daemonProcess = await this.sshManager.executeStreamingCommand(
      hostname, 
      daemonScript
    );
    
    this.daemonProcess.stdout.on('data', (data) => {
      const message = JSON.parse(data.toString().trim());
      this.handleMessage(message);
    });
  }
  
  handleMessage(message) {
    switch (message.type) {
      case 'new_taskspace_request':
        this.createNewTaskSpace(message);
        break;
      case 'update_taskspace':
        this.updateTaskSpace(message);
        break;
    }
  }
  
  sendMessage(message) {
    if (this.daemonProcess) {
      this.daemonProcess.stdin.write(JSON.stringify(message) + '\n');
    }
  }
}
```

## Runtime Dependencies

### Node.js Installation

The daemon and CLI tools require Node.js on the remote host. This is handled during setup:

```bash
# Part of the setup script
cd ${BASE_DIR}

# Download portable Node.js
if [ ! -d nodejs ]; then
  echo "Installing Node.js..."
  curl -L https://nodejs.org/dist/v20.17.0/node-v20.17.0-linux-x64.tar.xz | tar -xJ
  mv node-v20.17.0-linux-x64 nodejs
  chmod +x nodejs/bin/node
fi

# Install daemon and CLI tools
cp daemon.js ${BASE_DIR}/
cp theoldswitcheroo-cli.js ${BASE_DIR}/
chmod +x theoldswitcheroo-cli.js
```

### Environment Setup

CLI tools discover the daemon socket at a fixed location:

```bash
# Always connect to the same location
SOCKET_PATH="${BASE_DIR}/daemon.sock"
if [ ! -S "$SOCKET_PATH" ]; then
  echo "No active theoldswitcheroo instance found"
  exit 1
fi

# CLI tools can then connect
theoldswitcheroo new-taskspace --name "My Project"
```

## Security Considerations

- **Unix Socket Permissions**: Socket files created with 600 permissions (owner only)
- **Process Isolation**: Daemon runs under the same user as VSCode taskspaces
- **Message Validation**: All JSON messages validated before processing
- **Resource Cleanup**: Sockets and processes cleaned up on shutdown

## Error Handling

### Connection Failures

- CLI tools retry connection with exponential backoff
- Daemon restarts automatically if it crashes (via SSH process monitoring)
- Electron app detects daemon failures and can restart the daemon

### Message Delivery

- Messages are fire-and-forget for simplicity
- CLI tools can implement acknowledgment patterns if needed
- Daemon logs all message routing for debugging

## Future Extensions

### MCP Server Integration

The same message protocol can be used by MCP servers:

```javascript
// MCP server can send taskspace management messages
const message = {
  type: 'new_taskspace_request',
  name: 'Generated Project',
  description: 'AI-created development environment',
  cwd: '/tmp/ai-project-123'
};

sendToTaskSpaceDaemon(message);
```

### Advanced TaskSpace Operations

Additional message types can be added:

- `clone_repository` - Clone a git repository into a new taskspace
- `install_extensions` - Install VSCode extensions in a taskspace
- `execute_command` - Run commands within a taskspace's context
- `share_taskspace` - Enable collaborative access to a taskspace

The daemon architecture provides a flexible foundation for extending taskspace management capabilities.

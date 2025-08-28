# SSH Connection Handling

The VSCode multiplexer uses SSH ControlMaster for efficient connection management. Instead of establishing new SSH connections for each operation, we maintain a single master connection that multiplexes all SSH traffic.

## Master Process Lifecycle

### Establishing the Master

When the Electron app starts, we establish a master SSH connection that stays alive for the entire application lifecycle:

```javascript
const masterProcess = spawn('ssh', [
  '-M',           // Master mode
  '-N',           // No command (just maintain connection)
  '-o', `ControlPath=${socketPath}`,
  `${user}@${host}`
], {
  stdio: 'ignore'  // Run silently in background
});
```

The `-N` flag tells SSH to maintain the connection without executing any commands. The master process will:
- Connect to the remote host
- Create a local Unix domain socket file
- Wait for slave connections through the socket
- Keep the TCP connection alive indefinitely

### Socket Path Management

The `ControlPath` is a local Unix domain socket file that coordinates between master and slave processes:

```javascript
// Generate unique socket path per host
const socketPath = path.join(os.homedir(), '.ssh', `cm-${host}-${user}`);
```

This socket file acts as the communication channel:
1. **Master process** ↔ **Local socket** ↔ **Slave processes**
2. **Master process** ↔ **Network** ↔ **Remote host**

### Automatic Master Reuse

SSH ControlMaster automatically handles existing connections:
- If a healthy master exists → reuses it
- If no master exists → creates new one
- If stale master exists → cleans up and creates new one

No manual health checking required - just start with `-M` and SSH handles the complexity.

## Using the Master Connection

### Multiplexed Operations

All subsequent SSH operations use the existing master:

```javascript
// Fast operations using the master connection
spawn('ssh', [
  '-o', `ControlPath=${socketPath}`,
  `${user}@${host}`,
  'some command'
]);

// SCP file transfers also use the master
spawn('scp', [
  '-o', `ControlPath=${socketPath}`,
  'local-file',
  `${user}@${host}:remote-path`
]);
```

These operations bypass:
- TCP handshake (~50ms)
- SSH handshake (~200ms) 
- Authentication (~500-2000ms)

Connection time drops from seconds to milliseconds.

## Process Management

### Graceful Shutdown

The master process must be cleaned up when the Electron app exits:

```javascript
// Handle all shutdown scenarios
process.on('SIGINT', cleanup);   // Ctrl+C
process.on('SIGTERM', cleanup);  // Graceful kill
process.on('exit', cleanup);     // Normal exit

function cleanup() {
  if (masterProcess && !masterProcess.killed) {
    masterProcess.kill();
  }
}
```

### Orphaned Process Handling

If the Electron app is killed with `kill -9` (SIGKILL):
- The master SSH process becomes orphaned
- It will eventually timeout and die when it detects stale network connection
- On restart, SSH automatically detects and cleans up stale sockets

This is acceptable for development - SIGKILL scenarios are rare and self-recover.

## Implementation Architecture

### Connection Manager

```javascript
class SSHConnectionManager {
  constructor() {
    this.masters = new Map(); // host -> master process
  }
  
  async ensureMaster(host, user) {
    const key = `${user}@${host}`;
    
    if (!this.masters.has(key)) {
      const socketPath = this.generateSocketPath(host, user);
      const masterProcess = spawn('ssh', [
        '-M', '-N',
        '-o', `ControlPath=${socketPath}`,
        `${user}@${host}`
      ]);
      
      this.masters.set(key, { process: masterProcess, socketPath });
    }
    
    return this.masters.get(key);
  }
  
  async execute(host, user, command) {
    const { socketPath } = await this.ensureMaster(host, user);
    
    return spawn('ssh', [
      '-o', `ControlPath=${socketPath}`,
      `${user}@${host}`,
      command
    ]);
  }
  
  cleanup() {
    for (const [key, { process }] of this.masters) {
      if (!process.killed) {
        process.kill();
      }
    }
    this.masters.clear();
  }
}
```

### Integration with TaskSpace Management

The SSH connection manager integrates with the taskspace lifecycle:

1. **TaskSpace Creation**: Establish master connection to target host
2. **Server Operations**: Use multiplexed connections for all SSH/SCP operations
3. **TaskSpace Cleanup**: Master connection persists (may be reused by other taskspaces)
4. **App Shutdown**: Clean up all master connections

## Performance Benefits

With ControlMaster, SSH operations become dramatically faster:

| Operation | Without Master | With Master | Improvement |
|-----------|---------------|-------------|-------------|
| Connection Setup | 750-2250ms | 1-5ms | 99.5%+ |
| File Transfer | Full handshake + transfer | Direct transfer | Massive |
| Command Execution | Full handshake + command | Direct command | Massive |

This enables responsive UI operations that would otherwise feel sluggish with individual SSH connections.

## Security Considerations

- Socket files have restricted permissions (600)
- Master connections use existing SSH authentication
- No additional authentication required for slave connections
- Socket directory should have 700 permissions
- Consider shorter ControlPersist timeouts for production

The master connection approach provides both performance and security benefits while simplifying the connection management architecture.

# Setup Tool

Rust CLI for managing remote openvscode-server instances with real-time log streaming.

## Usage
```bash
cargo run -- --host hera
```

## User Interface
```
$ cargo run -- --host hera
Connecting to hera...
Installing openvscode-server...
Starting server on port 3000...

✓ Connection established.
  VSCode available at: http://hera:3000
  
  Press Ctrl+C to shutdown and cleanup.

[2025-08-26 01:48:15] [info] Web UI available at http://localhost:3000
[2025-08-26 01:48:16] [info] Server listening on port 3000
[2025-08-26 01:48:20] [info] New connection from 192.168.1.100
```

## Behavior
1. SSH to remote host
2. Create `~/.socratic-shell/theoldswitcheroo/` directory
3. Download openvscode-server binary
4. Start server with parent-process monitoring
5. Stream openvscode-server logs in real-time
6. Handle Ctrl+C for graceful shutdown and cleanup

## Implementation
- `clap` for CLI parsing
- `ssh2` for SSH connections and log streaming
- Bash wrapper script for parent monitoring and cleanup
- Real-time stdout/stderr forwarding from remote process

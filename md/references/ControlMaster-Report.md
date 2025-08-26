# SSH ControlMaster: Complete Guide to Connection Multiplexing

## Executive Summary

SSH ControlMaster enables connection multiplexing, allowing multiple SSH sessions to share a single network connection to the same host. This feature dramatically improves connection speed, reduces authentication overhead, and optimizes resource usage. After establishing an initial master connection, subsequent connections bypass the TCP handshake, SSH handshake, and authentication phases, reducing connection time from seconds to milliseconds.

## Technical Overview

### How Connection Multiplexing Works

ControlMaster creates a Unix domain socket that acts as a communication channel between SSH client processes. The master process maintains the actual network connection to the remote host, while slave processes communicate through the local socket.

```
┌─────────────┐      Unix Socket       ┌─────────────┐
│   SSH #2    │◄──────────────────────►│             │
├─────────────┤                        │   Master    │
│   SSH #3    │◄──────────────────────►│     SSH     │◄═══► Remote Host
├─────────────┤                        │   Process   │      (Single TCP)
│   SSH #4    │◄──────────────────────►│             │
└─────────────┘                        └─────────────┘
```

### Performance Impact

Connection establishment times with and without ControlMaster:

| Operation | Without ControlMaster | With ControlMaster | Improvement |
|-----------|----------------------|-------------------|-------------|
| TCP Handshake | ~50ms | 0ms | 100% |
| SSH Handshake | ~200ms | 0ms | 100% |
| Authentication | ~500-2000ms | 0ms | 100% |
| **Total** | **~750-2250ms** | **~1-5ms** | **99.5%+** |

## Configuration Deep Dive

### Basic Configuration

Add to `~/.ssh/config`:

```bash
Host *
    ControlMaster auto
    ControlPath ~/.ssh/cm-%C
    ControlPersist 10m
```

### Advanced Configuration Options

```bash
Host production-server
    HostName prod.example.com
    User deploy
    
    # ControlMaster modes
    ControlMaster auto      # Use existing or create new
    # ControlMaster yes     # Always be master (fails if socket exists)
    # ControlMaster no      # Never multiplex
    # ControlMaster ask     # Prompt before creating master
    # ControlMaster autoask # auto + ask for new masters
    
    # Socket path with tokens
    ControlPath ~/.ssh/controls/%r@%h:%p
    # %% - literal '%'
    # %C - hash of %l%h%p%r (shortened connection params)
    # %h - remote hostname
    # %i - local uid
    # %L - local hostname
    # %l - local hostname (short)
    # %n - hostname as given on command line
    # %p - remote port
    # %r - remote username
    # %u - local username
    
    # Keep master alive after last connection closes
    ControlPersist 30m      # 30 minutes
    # ControlPersist yes    # Keep alive forever
    # ControlPersist no     # Close with last connection
    # ControlPersist 0      # Close immediately
```

### Security-Focused Configuration

```bash
Host secure-*.example.com
    ControlMaster auto
    # Use %C hash to avoid exposing connection details in socket name
    ControlPath ~/.ssh/cm-%C
    # Shorter persistence for sensitive connections
    ControlPersist 5m
    # Ensure socket directory has restricted permissions
    # (Create directory with 700 permissions beforehand)
```

## Implementation in Node.js

### Complete ControlMaster Manager Class

```javascript
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

class ControlMasterManager {
  constructor(options = {}) {
    this.options = {
      controlDir: options.controlDir || path.join(os.homedir(), '.ssh', 'controls'),
      persistTime: options.persistTime || '10m',
      autoStart: options.autoStart !== false,
      ...options
    };
    
    this.connections = new Map();
    this.ensureControlDirectory();
  }
  
  ensureControlDirectory() {
    if (!fs.existsSync(this.options.controlDir)) {
      fs.mkdirSync(this.options.controlDir, { 
        recursive: true, 
        mode: 0o700  // Restricted permissions
      });
    }
    
    // Verify permissions
    const stats = fs.statSync(this.options.controlDir);
    const mode = stats.mode & parseInt('777', 8);
    if (mode !== parseInt('700', 8)) {
      console.warn(`Warning: Control directory has permissions ${mode.toString(8)}, should be 700`);
    }
  }
  
  generateControlPath(host, user, port = 22) {
    // Generate hash-based control path like %C token
    const hash = crypto
      .createHash('sha256')
      .update(`${os.hostname()}${host}${port}${user}`)
      .digest('hex')
      .substring(0, 16);
    
    return path.join(this.options.controlDir, `cm-${hash}`);
  }
  
  async establishMaster(host, user, options = {}) {
    const port = options.port || 22;
    const controlPath = this.generateControlPath(host, user, port);
    
    // Check if master already exists
    if (await this.checkMaster(host, user, port)) {
      console.log(`Master connection already exists for ${user}@${host}:${port}`);
      return { controlPath, status: 'existing' };
    }
    
    return new Promise((resolve, reject) => {
      const sshArgs = [
        '-M',  // Master mode
        '-N',  // No command
        '-f',  // Go to background
        '-o', `ControlPath=${controlPath}`,
        '-o', `ControlPersist=${this.options.persistTime}`,
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=60',
        '-o', 'ServerAliveCountMax=3'
      ];
      
      // Add port if non-standard
      if (port !== 22) {
        sshArgs.push('-p', port.toString());
      }
      
      // Add identity file if specified
      if (options.identityFile) {
        sshArgs.push('-i', options.identityFile);
      }
      
      // Add jump host if specified
      if (options.jumpHost) {
        sshArgs.push('-J', options.jumpHost);
      }
      
      sshArgs.push(`${user}@${host}`);
      
      const ssh = spawn('ssh', sshArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stderr = '';
      ssh.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      ssh.on('close', (code) => {
        if (code === 0) {
          this.connections.set(`${user}@${host}:${port}`, {
            controlPath,
            host,
            user,
            port,
            establishedAt: new Date()
          });
          
          resolve({ 
            controlPath, 
            status: 'created',
            pid: ssh.pid 
          });
        } else {
          reject(new Error(`Failed to establish master: ${stderr}`));
        }
      });
      
      ssh.on('error', reject);
    });
  }
  
  async checkMaster(host, user, port = 22) {
    const controlPath = this.generateControlPath(host, user, port);
    
    return new Promise((resolve) => {
      const ssh = spawn('ssh', [
        '-O', 'check',
        '-o', `ControlPath=${controlPath}`,
        '-p', port.toString(),
        `${user}@${host}`
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      ssh.on('close', (code) => {
        resolve(code === 0);
      });
      
      ssh.on('error', () => resolve(false));
    });
  }
  
  async executeCommand(host, user, command, options = {}) {
    const port = options.port || 22;
    const controlPath = this.generateControlPath(host, user, port);
    
    // Auto-establish master if enabled and not exists
    if (this.options.autoStart && !(await this.checkMaster(host, user, port))) {
      await this.establishMaster(host, user, options);
    }
    
    return new Promise((resolve, reject) => {
      const sshArgs = [
        '-o', `ControlPath=${controlPath}`,
        '-p', port.toString(),
        `${user}@${host}`,
        command
      ];
      
      const ssh = spawn('ssh', sshArgs);
      
      let stdout = '';
      let stderr = '';
      
      ssh.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      ssh.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      ssh.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
        } else {
          reject(new Error(`Command failed (code ${code}): ${stderr}`));
        }
      });
      
      ssh.on('error', reject);
    });
  }
  
  async stopMaster(host, user, port = 22) {
    const controlPath = this.generateControlPath(host, user, port);
    
    return new Promise((resolve, reject) => {
      const ssh = spawn('ssh', [
        '-O', 'stop',
        '-o', `ControlPath=${controlPath}`,
        '-p', port.toString(),
        `${user}@${host}`
      ]);
      
      ssh.on('close', (code) => {
        if (code === 0) {
          this.connections.delete(`${user}@${host}:${port}`);
          resolve();
        } else {
          reject(new Error('Failed to stop master connection'));
        }
      });
      
      ssh.on('error', reject);
    });
  }
  
  async stopAllMasters() {
    const stopPromises = [];
    
    for (const [key, conn] of this.connections) {
      stopPromises.push(
        this.stopMaster(conn.host, conn.user, conn.port)
          .catch(err => console.error(`Failed to stop ${key}:`, err))
      );
    }
    
    await Promise.all(stopPromises);
  }
  
  // Get master connection statistics
  async getMasterInfo(host, user, port = 22) {
    const controlPath = this.generateControlPath(host, user, port);
    
    if (!await this.checkMaster(host, user, port)) {
      return null;
    }
    
    try {
      // Try to get PID of master process
      const output = execSync(`ssh -O check -o ControlPath=${controlPath} ${user}@${host} 2>&1`, {
        encoding: 'utf8'
      });
      
      const pidMatch = output.match(/pid=(\d+)/);
      const pid = pidMatch ? parseInt(pidMatch[1]) : null;
      
      return {
        controlPath,
        pid,
        alive: true,
        connection: this.connections.get(`${user}@${host}:${port}`)
      };
    } catch (error) {
      return null;
    }
  }
  
  // Clean up stale socket files
  cleanupStaleSockets() {
    const files = fs.readdirSync(this.options.controlDir);
    let cleaned = 0;
    
    files.forEach(file => {
      if (file.startsWith('cm-')) {
        const socketPath = path.join(this.options.controlDir, file);
        const stats = fs.statSync(socketPath);
        
        // Check if socket is stale (no process listening)
        try {
          // Attempt to connect to socket
          const net = require('net');
          const client = net.createConnection(socketPath);
          
          client.on('error', () => {
            // Socket is dead, remove it
            fs.unlinkSync(socketPath);
            cleaned++;
          });
          
          client.on('connect', () => {
            // Socket is alive, keep it
            client.destroy();
          });
        } catch (err) {
          // Error checking socket, remove if old
          const ageHours = (Date.now() - stats.mtime) / (1000 * 60 * 60);
          if (ageHours > 24) {
            fs.unlinkSync(socketPath);
            cleaned++;
          }
        }
      }
    });
    
    return cleaned;
  }
}

// Usage example
async function main() {
  const manager = new ControlMasterManager({
    persistTime: '30m',
    autoStart: true
  });
  
  try {
    // Establish master connection
    const master = await manager.establishMaster('server.example.com', 'deploy', {
      port: 22,
      identityFile: '~/.ssh/id_rsa'
    });
    console.log('Master established:', master);
    
    // Execute multiple commands using the master
    const results = await Promise.all([
      manager.executeCommand('server.example.com', 'deploy', 'uptime'),
      manager.executeCommand('server.example.com', 'deploy', 'df -h'),
      manager.executeCommand('server.example.com', 'deploy', 'free -m')
    ]);
    
    results.forEach(result => {
      console.log('Output:', result.stdout);
    });
    
    // Get master info
    const info = await manager.getMasterInfo('server.example.com', 'deploy');
    console.log('Master info:', info);
    
    // Clean up when done (optional - will persist based on ControlPersist)
    // await manager.stopMaster('server.example.com', 'deploy');
    
  } catch (error) {
    console.error('Error:', error);
  }
}
```

### Stream-Based Implementation for Long-Running Commands

```javascript
class StreamingControlMaster {
  constructor(host, user, options = {}) {
    this.host = host;
    this.user = user;
    this.port = options.port || 22;
    this.controlPath = this.generateControlPath();
  }
  
  generateControlPath() {
    const hash = crypto
      .createHash('md5')
      .update(`${this.user}@${this.host}:${this.port}`)
      .digest('hex')
      .substring(0, 8);
    
    return path.join(os.homedir(), '.ssh', `cm-${hash}`);
  }
  
  streamCommand(command) {
    const ssh = spawn('ssh', [
      '-o', `ControlPath=${this.controlPath}`,
      `${this.user}@${this.host}`,
      command
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    return {
      process: ssh,
      stdout: ssh.stdout,
      stderr: ssh.stderr,
      stdin: ssh.stdin,
      
      // Convenience methods
      write: (data) => ssh.stdin.write(data),
      end: () => ssh.stdin.end(),
      kill: (signal = 'SIGTERM') => ssh.kill(signal),
      
      // Promise wrapper for completion
      completion: new Promise((resolve, reject) => {
        ssh.on('close', (code) => {
          if (code === 0) resolve(code);
          else reject(new Error(`Process exited with code ${code}`));
        });
        ssh.on('error', reject);
      })
    };
  }
  
  // Tail a remote file with streaming
  tailFile(filePath, lines = 10) {
    const stream = this.streamCommand(`tail -f -n ${lines} ${filePath}`);
    
    stream.stdout.on('data', (chunk) => {
      console.log('New log data:', chunk.toString());
    });
    
    return stream;
  }
  
  // Interactive shell session
  interactiveShell() {
    const ssh = spawn('ssh', [
      '-t',  // Allocate TTY
      '-o', `ControlPath=${this.controlPath}`,
      `${this.user}@${this.host}`
    ], {
      stdio: 'inherit'  // Connect to current terminal
    });
    
    return ssh;
  }
}
```

## Advanced Use Cases

### 1. Deployment Pipeline with Connection Reuse

```javascript
class DeploymentPipeline {
  constructor(servers) {
    this.servers = servers;
    this.manager = new ControlMasterManager({
      persistTime: '1h',
      autoStart: true
    });
  }
  
  async deploy(version) {
    console.log(`Starting deployment of version ${version}`);
    
    // Establish all master connections in parallel
    await Promise.all(
      this.servers.map(server => 
        this.manager.establishMaster(server.host, server.user, {
          port: server.port || 22
        })
      )
    );
    
    // Deploy to all servers
    for (const server of this.servers) {
      console.log(`Deploying to ${server.host}...`);
      
      try {
        // Stop application
        await this.manager.executeCommand(
          server.host, 
          server.user, 
          'systemctl stop myapp'
        );
        
        // Pull new code
        await this.manager.executeCommand(
          server.host, 
          server.user, 
          `cd /opt/myapp && git fetch && git checkout ${version}`
        );
        
        // Install dependencies
        await this.manager.executeCommand(
          server.host, 
          server.user, 
          'cd /opt/myapp && npm ci --production'
        );
        
        // Run migrations
        await this.manager.executeCommand(
          server.host, 
          server.user, 
          'cd /opt/myapp && npm run migrate'
        );
        
        // Start application
        await this.manager.executeCommand(
          server.host, 
          server.user, 
          'systemctl start myapp'
        );
        
        // Health check
        const health = await this.manager.executeCommand(
          server.host, 
          server.user, 
          'curl -f http://localhost:3000/health'
        );
        
        console.log(`✓ ${server.host} deployed successfully`);
        
      } catch (error) {
        console.error(`✗ ${server.host} deployment failed:`, error.message);
        throw error;
      }
    }
    
    console.log('Deployment complete!');
  }
}
```

### 2. Parallel Command Execution

```javascript
class ParallelSSHExecutor {
  constructor() {
    this.manager = new ControlMasterManager();
  }
  
  async executeOnHosts(hosts, command) {
    // Establish all masters first
    await Promise.all(
      hosts.map(({ host, user }) => 
        this.manager.establishMaster(host, user)
      )
    );
    
    // Execute command on all hosts in parallel
    const results = await Promise.all(
      hosts.map(async ({ host, user }) => {
        try {
          const result = await this.manager.executeCommand(host, user, command);
          return {
            host,
            success: true,
            output: result.stdout,
            error: result.stderr
          };
        } catch (error) {
          return {
            host,
            success: false,
            error: error.message
          };
        }
      })
    );
    
    return results;
  }
  
  async gatherSystemInfo(hosts) {
    const commands = {
      hostname: 'hostname -f',
      uptime: 'uptime',
      memory: 'free -h | grep Mem',
      disk: 'df -h /',
      load: 'cat /proc/loadavg',
      processes: 'ps aux | wc -l'
    };
    
    const info = {};
    
    for (const [key, cmd] of Object.entries(commands)) {
      const results = await this.executeOnHosts(hosts, cmd);
      
      results.forEach(result => {
        if (!info[result.host]) info[result.host] = {};
        info[result.host][key] = result.success ? result.output : result.error;
      });
    }
    
    return info;
  }
}
```

### 3. File Synchronization with rsync

```javascript
class FileSync {
  constructor(host, user) {
    this.host = host;
    this.user = user;
    this.controlPath = path.join(os.homedir(), '.ssh', `cm-${host}`);
  }
  
  async sync(localPath, remotePath, options = {}) {
    // Ensure master exists
    const manager = new ControlMasterManager();
    await manager.establishMaster(this.host, this.user);
    
    const rsyncArgs = [
      '-avz',  // Archive, verbose, compress
      '--progress',
      '-e', `ssh -o ControlPath=${this.controlPath}`,
      localPath,
      `${this.user}@${this.host}:${remotePath}`
    ];
    
    if (options.delete) {
      rsyncArgs.splice(1, 0, '--delete');
    }
    
    if (options.exclude) {
      options.exclude.forEach(pattern => {
        rsyncArgs.splice(1, 0, '--exclude', pattern);
      });
    }
    
    return new Promise((resolve, reject) => {
      const rsync = spawn('rsync', rsyncArgs, {
        stdio: 'inherit'
      });
      
      rsync.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`rsync failed with code ${code}`));
      });
      
      rsync.on('error', reject);
    });
  }
}

// Usage
const sync = new FileSync('server.example.com', 'deploy');
await sync.sync('./dist/', '/var/www/app/', {
  delete: true,
  exclude: ['*.log', 'node_modules/', '.git/']
});
```

## Monitoring and Management

### Control Socket Monitoring

```javascript
class ControlSocketMonitor {
  constructor(controlDir = '~/.ssh') {
    this.controlDir = controlDir.replace('~', os.homedir());
  }
  
  async getActiveSockets() {
    const files = fs.readdirSync(this.controlDir);
    const sockets = [];
    
    for (const file of files) {
      if (file.startsWith('cm-') || file.includes('%')) {
        const fullPath = path.join(this.controlDir, file);
        const stats = fs.statSync(fullPath);
        
        if (stats.isSocket()) {
          // Try to extract connection info from socket name
          const info = this.parseSocketName(file);
          
          sockets.push({
            path: fullPath,
            created: stats.birthtime,
            modified: stats.mtime,
            size: stats.size,
            ...info
          });
        }
      }
    }
    
    return sockets;
  }
  
  parseSocketName(filename) {
    // Parse different socket naming patterns
    const patterns = [
      // user@host:port format
      /cm-(.+)@(.+):(\d+)/,
      // Hash format
      /cm-([a-f0-9]+)/,
      // Custom patterns
      /control-(.+)-(.+)/
    ];
    
    for (const pattern of patterns) {
      const match = filename.match(pattern);
      if (match) {
        if (match.length === 4) {
          return {
            user: match[1],
            host: match[2],
            port: parseInt(match[3])
          };
        } else if (match.length === 2) {
          return { hash: match[1] };
        }
      }
    }
    
    return { filename };
  }
  
  async checkSocketHealth(socketPath) {
    // Attempt to find associated SSH process
    try {
      const output = execSync(`lsof ${socketPath} 2>/dev/null || true`, {
        encoding: 'utf8'
      });
      
      const lines = output.trim().split('\n');
      if (lines.length > 1) {
        const parts = lines[1].split(/\s+/);
        return {
          healthy: true,
          process: parts[0],
          pid: parseInt(parts[1])
        };
      }
    } catch (err) {
      // Socket might be stale
    }
    
    return { healthy: false };
  }
  
  async generateReport() {
    const sockets = await this.getActiveSockets();
    const report = {
      timestamp: new Date().toISOString(),
      totalSockets: sockets.length,
      sockets: []
    };
    
    for (const socket of sockets) {
      const health = await this.checkSocketHealth(socket.path);
      report.sockets.push({
        ...socket,
        ...health,
        age: Math.floor((Date.now() - socket.created) / 1000 / 60) + ' minutes'
      });
    }
    
    return report;
  }
}
```

## Troubleshooting Guide

### Common Issues and Solutions

#### 1. Master Connection Fails to Establish

```javascript
async function debugMasterConnection(host, user) {
  const debugArgs = [
    '-vvv',  // Maximum verbosity
    '-M',    // Master mode
    '-N',    // No command
    '-o', 'ControlPath=/tmp/debug-cm-test',
    '-o', 'ControlPersist=no',
    `${user}@${host}`
  ];
  
  const ssh = spawn('ssh', debugArgs, {
    stdio: 'inherit'
  });
  
  return new Promise((resolve) => {
    ssh.on('close', (code) => {
      console.log(`Debug connection closed with code: ${code}`);
      resolve(code);
    });
  });
}
```

#### 2. Socket Permission Issues

```javascript
function fixSocketPermissions(controlDir) {
  const dir = controlDir.replace('~', os.homedir());
  
  // Ensure directory exists with correct permissions
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  
  // Fix directory permissions
  fs.chmodSync(dir, 0o700);
  
  // Fix socket permissions
  const files = fs.readdirSync(dir);
  files.forEach(file => {
    if (file.startsWith('cm-')) {
      const fullPath = path.join(dir, file);
      try {
        fs.chmodSync(fullPath, 0o600);
      } catch (err) {
        console.warn(`Could not fix permissions for ${file}:`, err.message);
      }
    }
  });
}
```

#### 3. Stale Socket Detection and Cleanup

```javascript
class StaleSocketCleaner {
  static async findAndCleanStaleSockets(directory = '~/.ssh') {
    const dir = directory.replace('~', os.homedir());
    const stale = [];
    
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
      if (file.startsWith('cm-') || file.includes('control')) {
        const fullPath = path.join(dir, file);
        const stats = fs.statSync(fullPath);
        
        if (stats.isSocket()) {
          // Check if socket is active
          try {
            // Try SSH check command
            execSync(`ssh -O check -o ControlPath=${fullPath} dummy 2>/dev/null`, {
              timeout: 1000
            });
          } catch (err) {
            // Socket is stale
            stale.push(fullPath);
            fs.unlinkSync(fullPath);
          }
        }
      }
    }
    
    return stale;
  }
}
```

## Performance Benchmarks

### Connection Time Comparison

```javascript
class SSHPerformanceBenchmark {
  constructor(host, user) {
    this.host = host;
    this.user = user;
  }
  
  async benchmarkWithoutMultiplexing(iterations = 10) {
    const times = [];
    
    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
      
      await new Promise((resolve, reject) => {
        const ssh = spawn('ssh', [
          '-o', 'ControlMaster=no',
          `${this.user}@${this.host}`,
          'echo test'
        ]);
        
        ssh.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`SSH failed with code ${code}`));
        });
      });
      
      times.push(Date.now() - start);
    }
    
    return {
      average: times.reduce((a, b) => a + b) / times.length,
      min: Math.min(...times),
      max: Math.max(...times),
      times
    };
  }
  
  async benchmarkWithMultiplexing(iterations = 10) {
    // Establish master
    const manager = new ControlMasterManager();
    await manager.establishMaster(this.host, this.user);
    
    const times = [];
    
    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
      await manager.executeCommand(this.host, this.user, 'echo test');
      times.push(Date.now() - start);
    }
    
    await manager.stopMaster(this.host, this.user);
    
    return {
      average: times.reduce((a, b) => a + b) / times.length,
      min: Math.min(...times),
      max: Math.max(...times),
      times
    };
  }
  
  async runFullBenchmark() {
    console.log('Running SSH Performance Benchmark...\n');
    
    console.log('Without ControlMaster:');
    const withoutCM = await this.benchmarkWithoutMultiplexing();
    console.log(`  Average: ${withoutCM.average.toFixed(2)}ms`);
    console.log(`  Min: ${withoutCM.min}ms`);
    console.log(`  Max: ${withoutCM.max}ms`);
    
    console.log('\nWith ControlMaster:');
    const withCM = await this.benchmarkWithMultiplexing();
    console.log(`  Average: ${withCM.average.toFixed(2)}ms`);
    console.log(`  Min: ${withCM.min}ms`);
    console.log(`  Max: ${withCM.max}ms`);
    
    const improvement = ((withoutCM.average - withCM.average) / withoutCM.average * 100).toFixed(1);
    console.log(`\nImprovement: ${improvement}% faster with ControlMaster`);
    
    return {
      withoutControlMaster: withoutCM,
      withControlMaster: withCM,
      improvementPercent: parseFloat(improvement)
    };
  }
}
```

## Best Practices

### 1. Socket Directory Management

Always use a dedicated directory for control sockets:

```bash
# In ~/.ssh/config
Host *
    ControlPath ~/.ssh/controls/%C
    # Ensure directory exists with proper permissions
```

### 2. Connection Lifecycle Management

```javascript
class ManagedSSHConnection {
  constructor(host, user, options = {}) {
    this.host = host;
    this.user = user;
    this.options = options;
    this.manager = new ControlMasterManager();
    this.established = false;
  }
  
  async connect() {
    if (!this.established) {
      await this.manager.establishMaster(this.host, this.user, this.options);
      this.established = true;
      
      // Set up cleanup on process exit
      process.on('exit', () => this.disconnect());
      process.on('SIGINT', () => this.disconnect());
      process.on('SIGTERM', () => this.disconnect());
    }
  }
  
  async disconnect() {
    if (this.established) {
      await this.manager.stopMaster(this.host, this.user, this.options.port || 22);
      this.established = false;
    }
  }
  
  async execute(command) {
    await this.connect();
    return this.manager.executeCommand(this.host, this.user, command, this.options);
  }
}
```

### 3. Security Considerations

- Always use `%C` (hash) in ControlPath for production to avoid exposing connection details
- Set appropriate ControlPersist timeouts (shorter for production)
- Regularly clean up stale sockets
- Monitor socket directory permissions (must be 700)
- Use separate control paths for different security contexts

### 4. Error Handling Patterns

```javascript
class ResilientSSHConnection {
  constructor(config) {
    this.config = config;
    this.retryAttempts = 3;
    this.retryDelay = 1000;
  }
  
  async executeWithRetry(command) {
    let lastError;
    
    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        return await this.execute(command);
      } catch (error) {
        lastError = error;
        
        if (error.message.includes('ControlSocket') || 
            error.message.includes('connect to host')) {
          // Connection issue - try to re-establish master
          console.log(`Attempt ${attempt} failed, retrying...`);
          await this.reestablishMaster();
          await this.delay(this.retryDelay * attempt);
        } else {
          // Non-connection error, don't retry
          throw error;
        }
      }
    }
    
    throw lastError;
  }
  
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

## Conclusion

SSH ControlMaster dramatically improves SSH connection performance and resource usage through connection multiplexing. By implementing proper socket management, error handling, and lifecycle control in Node.js applications, developers can achieve:

- **99%+ reduction** in connection establishment time
- **Single authentication** for multiple operations
- **Reduced network overhead** through connection reuse
- **Improved reliability** with proper socket management
- **Better resource utilization** on both client and server

The combination of ControlMaster with Node.js process management enables efficient, scalable SSH operations suitable for deployment automation, system administration, monitoring, and any application requiring frequent SSH connections.

Key recommendations:
- Use `ControlMaster auto` for automatic multiplexing
- Implement proper socket lifecycle management
- Monitor and clean stale sockets regularly
- Use hash-based ControlPath (`%C`) in production
- Set appropriate ControlPersist timeouts
- Handle connection failures gracefully with retry logic
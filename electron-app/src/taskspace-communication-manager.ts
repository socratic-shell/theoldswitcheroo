import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SSHConnectionManager } from './ssh-manager.js';

// ES6 module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TaskSpaceMessage {
  type: string;
  timestamp: string;
  [key: string]: any;
}

interface TaskSpaceRequest {
  type: 'new_taskspace_request';
  name: string;
  description?: string;
  cwd?: string;
  timestamp: string;
}

export class TaskSpaceCommunicationManager {
  private sshManager: SSHConnectionManager;
  private daemonProcesses = new Map<string, ChildProcess>();
  private messageHandlers = new Map<string, (message: TaskSpaceMessage) => void>();

  constructor(sshManager: SSHConnectionManager) {
    this.sshManager = sshManager;
    this.setupMessageHandlers();
  }

  private setupMessageHandlers(): void {
    this.messageHandlers.set('new_taskspace_request', this.handleNewTaskSpaceRequest.bind(this));
    this.messageHandlers.set('update_taskspace', this.handleUpdateTaskSpace.bind(this));
    this.messageHandlers.set('status_request', this.handleStatusRequest.bind(this));
  }

  async startDaemon(hostname: string): Promise<void> {
    try {
      // Check if daemon is already running
      if (this.daemonProcesses.has(hostname)) {
        console.log(`Daemon already running for ${hostname}`);
        return;
      }

      const baseDir = `~/.socratic-shell/theoldswitcheroo`;
      const socketPath = `${baseDir}/daemon.sock`;
      const daemonPath = `${baseDir}/daemon-bundled.cjs`;

      // Check if daemon files exist on remote host
      const checkCommand = `test -f ${daemonPath} && echo "exists" || echo "missing"`;
      const checkResult = await this.sshManager.executeCommand(hostname, checkCommand);

      if (checkResult.trim() !== 'exists') {
        throw new Error(`Daemon files not found on ${hostname}. Run setup first.`);
      }

      // Check for existing daemon instance
      const instanceCheck = await this.checkExistingInstance(hostname, socketPath);
      if (instanceCheck.exists) {
        const shouldTakeOver = await this.showHandoffDialog(hostname, instanceCheck.pid);
        if (!shouldTakeOver) {
          throw new Error('User declined to take over existing instance');
        }

        // Kill existing daemon
        await this.sshManager.executeCommand(hostname, `kill ${instanceCheck.pid} 2>/dev/null || true`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Start daemon via SSH
      const daemonCommand = `cd ${baseDir} && ./nodejs/bin/node daemon-bundled.cjs --socket-path ${socketPath}`;
      const daemonProcess = spawn('ssh', [
        '-o', 'ControlMaster=no',
        '-o', 'ControlPath=none',
        hostname,
        daemonCommand
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Handle daemon output
      daemonProcess.stdout?.on('data', (data) => {
        const lines = data.toString().split('\n').filter(line => line.trim());
        for (const line of lines) {
          try {
            const message = JSON.parse(line) as TaskSpaceMessage;
            this.handleMessage(hostname, message);
          } catch (error) {
            // Not JSON, probably daemon log output
            console.log(`[${hostname}] Daemon:`, line);
          }
        }
      });

      daemonProcess.stderr?.on('data', (data) => {
        console.error(`[${hostname}] Daemon error:`, data.toString());
      });

      daemonProcess.on('exit', (code) => {
        console.log(`[${hostname}] Daemon exited with code ${code}`);
        this.daemonProcesses.delete(hostname);
      });

      this.daemonProcesses.set(hostname, daemonProcess);
      console.log(`Started daemon for ${hostname}`);

    } catch (error) {
      console.error(`Failed to start daemon for ${hostname}:`, error);
      throw error;
    }
  }

  async stopDaemon(hostname: string): Promise<void> {
    const daemonProcess = this.daemonProcesses.get(hostname);
    if (daemonProcess) {
      daemonProcess.kill('SIGTERM');
      this.daemonProcesses.delete(hostname);
      console.log(`Stopped daemon for ${hostname}`);
    }
  }

  private async checkExistingInstance(hostname: string, socketPath: string): Promise<{
    exists: boolean;
    pid?: string;
  }> {
    try {
      // Check if socket exists and get daemon PID
      const checkCommand = `if [ -S "${socketPath}" ]; then lsof -t "${socketPath}" 2>/dev/null | head -1; else echo ""; fi`;
      const result = await this.sshManager.executeCommand(hostname, checkCommand);

      const pid = result.trim();
      return {
        exists: pid !== '',
        pid: pid || undefined
      };
    } catch (error) {
      return { exists: false };
    }
  }

  private async showHandoffDialog(hostname: string, pid?: string): Promise<boolean> {
    try {
      const { dialog, BrowserWindow } = await import('electron');

      // Get the focused window or null
      const focusedWindow = BrowserWindow.getFocusedWindow();

      const options = {
        type: 'question' as const,
        buttons: ['Take Over', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: 'Existing Daemon Found',
        message: `Another theoldswitcheroo instance is running on ${hostname}`,
        detail: pid ? `Process ID: ${pid}\n\nTaking over will stop the existing instance and start a new one under your control.` : 'Taking over will stop the existing instance and start a new one under your control.'
      };

      const result = focusedWindow
        ? await dialog.showMessageBox(focusedWindow, options)
        : await dialog.showMessageBox(options);

      // Handle both possible return types (number or object with response)
      const responseIndex = typeof result === 'number' ? result : (result as any).response;
      return responseIndex === 0;
    } catch (error) {
      console.error('Error showing handoff dialog:', error);
      // Default to taking over if dialog fails
      return true;
    }
  }

  private handleMessage(hostname: string, message: TaskSpaceMessage): void {
    console.log(`[${hostname}] Received message:`, message);

    const handler = this.messageHandlers.get(message.type);
    if (handler) {
      handler(message);
    } else {
      console.warn(`No handler for message type: ${message.type}`);
    }
  }

  private handleNewTaskSpaceRequest(message: TaskSpaceMessage): void {
    const request = message as TaskSpaceRequest;
    console.log(`Creating new taskspace: ${request.name}`);

    // Emit event for main app to handle
    if (this.onTaskSpaceRequest) {
      this.onTaskSpaceRequest({
        type: 'new_taskspace',
        name: request.name,
        description: request.description || '',
        cwd: request.cwd || process.cwd(),
        hostname: this.getCurrentHostname(message)
      });
    }
  }

  private handleUpdateTaskSpace(message: TaskSpaceMessage): void {
    console.log('Updating taskspace:', message);

    // Emit event for main app to handle
    if (this.onTaskSpaceRequest) {
      this.onTaskSpaceRequest({
        type: 'update_taskspace',
        uuid: (message as any).uuid,
        description: (message as any).description,
        name: (message as any).name,
        hostname: this.getCurrentHostname(message)
      });
    }
  }

  private handleStatusRequest(message: TaskSpaceMessage): void {
    console.log('Status request received');

    // Send back current taskspace status via daemon
    const hostname = this.getCurrentHostname(message);
    if (this.onStatusRequest) {
      const status = this.onStatusRequest(hostname);
      this.sendMessage(hostname, {
        type: 'status_response',
        timestamp: new Date().toISOString(),
        ...status
      }).catch(console.error);
    }
  }

  private getCurrentHostname(message: TaskSpaceMessage): string {
    // Find which hostname this message came from
    for (const [hostname, process] of this.daemonProcesses) {
      // For now, return the first active hostname
      // In a real implementation, we'd track message sources
      return hostname;
    }
    return 'unknown';
  }

  // Event handlers for main app integration
  private onTaskSpaceRequest?: (request: {
    type: 'new_taskspace' | 'update_taskspace';
    name?: string;
    description?: string;
    cwd?: string;
    uuid?: string;
    hostname: string;
  }) => void;

  private onStatusRequest?: (hostname: string) => {
    taskspaces: Array<{ name: string; status: string; uuid: string }>;
    activeTaskSpace?: string;
  };

  setTaskSpaceRequestHandler(handler: typeof this.onTaskSpaceRequest): void {
    this.onTaskSpaceRequest = handler;
  }

  setStatusRequestHandler(handler: typeof this.onStatusRequest): void {
    this.onStatusRequest = handler;
  }

  async sendMessage(hostname: string, message: TaskSpaceMessage): Promise<void> {
    const daemonProcess = this.daemonProcesses.get(hostname);
    if (!daemonProcess || !daemonProcess.stdin) {
      throw new Error(`No active daemon for ${hostname}`);
    }

    const messageStr = JSON.stringify(message);
    daemonProcess.stdin.write(messageStr + '\n');
  }

  async deployDaemonFiles(hostname: string): Promise<void> {
    const baseDir = `~/.socratic-shell/theoldswitcheroo`;
    const binDir = `${baseDir}/bin`;
    const distDir = path.join(__dirname, '..', 'dist');

    // Ensure directories exist
    await this.sshManager.executeCommand(hostname, `mkdir -p ${binDir}`);

    // Install Node.js if not already present
    await this.installNodeJs(hostname, baseDir);

    // Upload bundled daemon and CLI files
    const daemonSource = path.join(distDir, 'daemon-bundled.cjs');
    const cliSource = path.join(distDir, 'theoldswitcheroo-bundled.cjs');

    if (!fs.existsSync(daemonSource)) {
      throw new Error('Daemon bundle not found. Run npm run build first.');
    }

    if (!fs.existsSync(cliSource)) {
      throw new Error('CLI bundle not found. Run npm run build first.');
    }

    // Upload daemon to base directory
    await this.sshManager.uploadFile(hostname, daemonSource, `${baseDir}/daemon-bundled.cjs`);

    // Upload CLI tool to bin directory (with .cjs extension)
    await this.sshManager.uploadFile(hostname, cliSource, `${binDir}/theoldswitcheroo-bundled.cjs`);
    
    // Create wrapper script that uses our Node.js with absolute paths
    const wrapperScript = `#!/bin/bash
exec "$HOME/.socratic-shell/theoldswitcheroo/nodejs/bin/node" "$HOME/.socratic-shell/theoldswitcheroo/bin/theoldswitcheroo-bundled.cjs" "$@"
`;
    
    // Write wrapper script
    await this.sshManager.executeCommand(hostname, `cat > ${binDir}/theoldswitcheroo << 'EOF'
${wrapperScript}EOF`);
    
    // Make files executable
    await this.sshManager.executeCommand(hostname, `chmod +x ${baseDir}/daemon-bundled.cjs ${binDir}/theoldswitcheroo-bundled.cjs ${binDir}/theoldswitcheroo`);

    console.log(`Deployed daemon files to ${hostname}`);
    console.log(`CLI tool available at: ${binDir}/theoldswitcheroo`);
    console.log(`PATH will be set by theoldswitcheroo extension`);
  }

  private async installNodeJs(hostname: string, baseDir: string): Promise<void> {
    const nodeDir = `${baseDir}/nodejs`;
    
    // Check if Node.js is already installed
    const checkResult = await this.sshManager.executeCommand(
      hostname, 
      `test -f ${nodeDir}/bin/node && echo "exists" || echo "missing"`
    );
    
    if (checkResult.trim() === 'exists') {
      console.log('Node.js already installed');
      return;
    }
    
    console.log('Installing Node.js...');
    
    // Detect architecture
    const archResult = await this.sshManager.executeCommand(hostname, 'uname -m');
    const arch = archResult.trim();
    
    // Map architecture to Node.js download names
    let nodeArch: string;
    if (arch === 'x86_64' || arch === 'amd64') {
      nodeArch = 'x64';
    } else if (arch === 'aarch64' || arch === 'arm64') {
      nodeArch = 'arm64';
    } else if (arch.startsWith('arm')) {
      nodeArch = 'armv7l';
    } else {
      throw new Error(`Unsupported architecture: ${arch}`);
    }
    
    // Download and extract Node.js
    const nodeVersion = 'v20.11.0'; // LTS version
    const nodeUrl = `https://nodejs.org/dist/${nodeVersion}/node-${nodeVersion}-linux-${nodeArch}.tar.xz`;
    
    const installScript = `
      cd ${baseDir}
      curl -L ${nodeUrl} | tar -xJ
      mv node-${nodeVersion}-linux-${nodeArch} nodejs
      chmod +x nodejs/bin/node
      echo "Node.js installed successfully"
    `;
    
    await this.sshManager.executeCommand(hostname, installScript);
    console.log(`✓ Node.js ${nodeVersion} installed for ${nodeArch}`);
  }

  async deployAdditionalTools(hostname: string, tools: Array<{ localPath: string; remoteName: string }>): Promise<void> {
    const binDir = `~/.socratic-shell/theoldswitcheroo/bin`;

    for (const tool of tools) {
      if (!fs.existsSync(tool.localPath)) {
        console.warn(`Tool not found: ${tool.localPath}, skipping...`);
        continue;
      }

      const remotePath = `${binDir}/${tool.remoteName}`;
      await this.sshManager.uploadFile(hostname, tool.localPath, remotePath);
      await this.sshManager.executeCommand(hostname, `chmod +x ${remotePath}`);

      console.log(`Deployed tool: ${tool.remoteName}`);
    }
  }

  isRunning(hostname: string): boolean {
    return this.daemonProcesses.has(hostname);
  }

  getActiveHosts(): string[] {
    return Array.from(this.daemonProcesses.keys());
  }
}

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SSHConnectionManager } from './ssh-manager.js';

// ES6 module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PortalMessage {
  type: string;
  timestamp: string;
  [key: string]: any;
}

interface PortalRequest {
  type: 'new_portal_request';
  name: string;
  description?: string;
  cwd?: string;
  timestamp: string;
}

export class PortalCommunicationManager {
  private sshManager: SSHConnectionManager;
  private daemonProcesses = new Map<string, ChildProcess>();
  private messageHandlers = new Map<string, (message: PortalMessage) => void>();

  constructor(sshManager: SSHConnectionManager) {
    this.sshManager = sshManager;
    this.setupMessageHandlers();
  }

  private setupMessageHandlers(): void {
    this.messageHandlers.set('new_portal_request', this.handleNewPortalRequest.bind(this));
    this.messageHandlers.set('update_portal', this.handleUpdatePortal.bind(this));
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
      const daemonPath = `${baseDir}/daemon-bundled.js`;

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
      const daemonCommand = `cd ${baseDir} && ./nodejs/bin/node daemon-bundled.js --socket-path ${socketPath}`;
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
            const message = JSON.parse(line) as PortalMessage;
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

  private handleMessage(hostname: string, message: PortalMessage): void {
    console.log(`[${hostname}] Received message:`, message);

    const handler = this.messageHandlers.get(message.type);
    if (handler) {
      handler(message);
    } else {
      console.warn(`No handler for message type: ${message.type}`);
    }
  }

  private handleNewPortalRequest(message: PortalMessage): void {
    const request = message as PortalRequest;
    console.log(`Creating new portal: ${request.name}`);

    // Emit event for main app to handle
    if (this.onPortalRequest) {
      this.onPortalRequest({
        type: 'new_portal',
        name: request.name,
        description: request.description || '',
        cwd: request.cwd || process.cwd(),
        hostname: this.getCurrentHostname(message)
      });
    }
  }

  private handleUpdatePortal(message: PortalMessage): void {
    console.log('Updating portal:', message);

    // Emit event for main app to handle
    if (this.onPortalRequest) {
      this.onPortalRequest({
        type: 'update_portal',
        uuid: (message as any).uuid,
        description: (message as any).description,
        name: (message as any).name,
        hostname: this.getCurrentHostname(message)
      });
    }
  }

  private handleStatusRequest(message: PortalMessage): void {
    console.log('Status request received');

    // Send back current portal status via daemon
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

  private getCurrentHostname(message: PortalMessage): string {
    // Find which hostname this message came from
    for (const [hostname, process] of this.daemonProcesses) {
      // For now, return the first active hostname
      // In a real implementation, we'd track message sources
      return hostname;
    }
    return 'unknown';
  }

  // Event handlers for main app integration
  private onPortalRequest?: (request: {
    type: 'new_portal' | 'update_portal';
    name?: string;
    description?: string;
    cwd?: string;
    uuid?: string;
    hostname: string;
  }) => void;

  private onStatusRequest?: (hostname: string) => {
    portals: Array<{ name: string; status: string; uuid: string }>;
    activePortal?: string;
  };

  setPortalRequestHandler(handler: typeof this.onPortalRequest): void {
    this.onPortalRequest = handler;
  }

  setStatusRequestHandler(handler: typeof this.onStatusRequest): void {
    this.onStatusRequest = handler;
  }

  async sendMessage(hostname: string, message: PortalMessage): Promise<void> {
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

    // Upload bundled daemon and CLI files
    const daemonSource = path.join(distDir, 'daemon-bundled.js');
    const cliSource = path.join(distDir, 'theoldswitcheroo-bundled.cjs');

    if (!fs.existsSync(daemonSource)) {
      throw new Error('Daemon bundle not found. Run npm run build first.');
    }

    if (!fs.existsSync(cliSource)) {
      throw new Error('CLI bundle not found. Run npm run build first.');
    }

    // Upload daemon to base directory
    await this.sshManager.uploadFile(hostname, daemonSource, `${baseDir}/daemon-bundled.js`);

    // Upload CLI tool to bin directory (without .cjs extension for cleaner usage)
    await this.sshManager.uploadFile(hostname, cliSource, `${binDir}/theoldswitcheroo`);

    // Make files executable
    await this.sshManager.executeCommand(hostname, `chmod +x ${baseDir}/daemon-bundled.js ${binDir}/theoldswitcheroo`);

    console.log(`Deployed daemon files to ${hostname}`);
    console.log(`CLI tool available at: ${binDir}/theoldswitcheroo`);
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

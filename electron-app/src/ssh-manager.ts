import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as os from 'os';

interface MasterConnection {
  process: ChildProcess;
  socketPath: string;
  host: string;
}

/**
 * SSH Connection Manager using ControlMaster for efficient connection multiplexing.
 * 
 * Maintains master SSH connections that stay alive for the application lifecycle,
 * allowing all SSH/SCP operations to use fast multiplexed connections.
 */
export class SSHConnectionManager {
  private masters = new Map<string, MasterConnection>();

  /**
   * Ensure a master connection exists for the given host.
   * If a master already exists, this is a no-op.
   * If no master exists, establishes a new one.
   */
  async ensureMaster(host: string): Promise<string> {
    if (this.masters.has(host)) {
      return this.masters.get(host)!.socketPath;
    }

    const socketPath = this.generateSocketPath(host);
    
    console.log(`Establishing SSH master connection to ${host}`);
    
    return new Promise((resolve, reject) => {
      const masterProcess = spawn('ssh', [
        '-M',           // Master mode
        '-N',           // No command (just maintain connection)
        '-o', `ControlPath=${socketPath}`,
        '-o', 'ControlPersist=no',  // Don't persist after we kill it
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=60',
        '-o', 'ServerAliveCountMax=3',
        host
      ], {
        stdio: 'ignore'  // Run silently in background
      });

      // Give the master a moment to establish
      setTimeout(() => {
        if (!masterProcess.killed) {
          this.masters.set(host, {
            process: masterProcess,
            socketPath,
            host
          });
          
          console.log(`SSH master connection established for ${host}`);
          resolve(socketPath);
        }
      }, 1000);

      masterProcess.on('error', (err) => {
        console.error(`Failed to establish SSH master for ${host}:`, err);
        reject(err);
      });

      masterProcess.on('close', (code) => {
        console.log(`SSH master for ${host} closed with code ${code}`);
        this.masters.delete(host);
      });
    });
  }

  /**
   * Execute a command on the remote host using the master connection.
   */
  async executeCommand(host: string, command: string): Promise<string> {
    const socketPath = await this.ensureMaster(host);
    
    return new Promise((resolve, reject) => {
      console.log(`Executing SSH command on ${host}: ${command}`);
      
      const ssh = spawn('ssh', [
        '-o', `ControlPath=${socketPath}`,
        host,
        command
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

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
          resolve(stdout.trim());
        } else {
          reject(new Error(`SSH command '${command}' on ${host} failed (${code}): ${stderr}`));
        }
      });

      ssh.on('error', reject);
    });
  }

  /**
   * Execute a streaming command on the remote host using the master connection.
   * Returns the SSH process for custom handling of stdout/stderr.
   */
  async executeStreamingCommand(host: string, command: string): Promise<ChildProcess> {
    const socketPath = await this.ensureMaster(host);
    
    console.log(`Executing streaming SSH command on ${host}: ${command}`);
    
    return spawn('ssh', [
      '-o', `ControlPath=${socketPath}`,
      host,
      command
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }

  /**
   * Upload a file to the remote host using SCP with the master connection.
   */
  async uploadFile(host: string, localPath: string, remotePath: string): Promise<void> {
    const socketPath = await this.ensureMaster(host);
    
    return new Promise((resolve, reject) => {
      console.log(`Uploading file to ${host}: ${localPath} -> ${remotePath}`);
      
      const scp = spawn('scp', [
        '-o', `ControlPath=${socketPath}`,
        localPath,
        `${host}:${remotePath}`
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stderr = '';

      scp.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      scp.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`SCP upload to ${host} failed (${code}): ${stderr}`));
        }
      });

      scp.on('error', reject);
    });
  }

  /**
   * Create an SSH tunnel using the master connection.
   * Returns the SSH process for the tunnel.
   */
  createTunnel(host: string, localPort: number, remotePort: number): ChildProcess {
    const socketPath = this.masters.get(host)?.socketPath;
    if (!socketPath) {
      throw new Error(`No master connection exists for ${host}. Call ensureMaster() first.`);
    }

    console.log(`Creating SSH tunnel: localhost:${localPort} -> ${host}:${remotePort}`);
    
    return spawn('ssh', [
      '-o', `ControlPath=${socketPath}`,
      '-L', `${localPort}:localhost:${remotePort}`,
      '-N',  // No command
      host
    ], {
      stdio: 'ignore'
    });
  }

  /**
   * Generate a unique socket path for the host.
   */
  private generateSocketPath(host: string): string {
    // Use a simple but unique socket path
    return path.join(os.homedir(), '.ssh', `cm-${host}`);
  }

  /**
   * Clean up all master connections.
   * Should be called when the application exits.
   */
  cleanup(): void {
    console.log('Cleaning up SSH master connections...');
    
    for (const [host, { process }] of this.masters) {
      if (!process.killed) {
        console.log(`Terminating SSH master for ${host}`);
        process.kill();
      }
    }
    
    this.masters.clear();
  }

  /**
   * Get information about active master connections.
   */
  getActiveMasters(): string[] {
    return Array.from(this.masters.keys());
  }
}

// Global instance
export const sshManager = new SSHConnectionManager();

// Set up cleanup handlers
process.on('SIGINT', () => sshManager.cleanup());
process.on('SIGTERM', () => sshManager.cleanup());
process.on('exit', () => sshManager.cleanup());

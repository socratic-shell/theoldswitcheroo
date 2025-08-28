import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Integration Tests', () => {
  const testSocketPath = '/tmp/integration-test-daemon.sock';
  const bundledDaemonPath = path.join(__dirname, '..', 'dist', 'daemon-bundled.cjs');
  const bundledCliPath = path.join(__dirname, '..', 'dist', 'theoldswitcheroo-bundled.cjs');

  beforeEach(() => {
    // Clean up any existing socket
    if (fs.existsSync(testSocketPath)) {
      fs.unlinkSync(testSocketPath);
    }
  });

  afterEach(() => {
    if (fs.existsSync(testSocketPath)) {
      fs.unlinkSync(testSocketPath);
    }
  });

  test('complete workflow: daemon startup -> CLI commands -> message flow', async () => {
    let daemonProcess: ChildProcess | null = null;
    
    try {
      // 1. Start daemon
      daemonProcess = spawn('node', [bundledDaemonPath, '--socket-path', testSocketPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Capture all daemon output
      let daemonStdout = '';
      let daemonStderr = '';
      
      daemonProcess.stdout?.on('data', (data) => {
        daemonStdout += data.toString();
      });
      
      daemonProcess.stderr?.on('data', (data) => {
        daemonStderr += data.toString();
      });

      // 2. Wait for daemon to be ready
      await waitForSocket(testSocketPath, 5000);
      await new Promise(resolve => setTimeout(resolve, 200));

      // 3. Send new-taskspace command
      const newTaskSpaceResult = await runCLICommand([
        'new-taskspace',
        '--name', 'Integration Test TaskSpace',
        '--description', 'Created during integration testing',
        '--cwd', '/tmp/test-project'
      ]);

      expect(newTaskSpaceResult.exitCode).toBe(0);
      expect(newTaskSpaceResult.stdout).toContain('TaskSpace creation request sent');

      // 4. Send status command
      const statusResult = await runCLICommand(['status']);

      expect(statusResult.exitCode).toBe(0);
      expect(statusResult.stdout).toContain('Status request sent');

      // 5. Verify daemon received messages
      await new Promise(resolve => setTimeout(resolve, 300));

      // Check new-taskspace message
      expect(daemonStdout).toContain('"type":"new_taskspace_request"');
      expect(daemonStdout).toContain('"name":"Integration Test TaskSpace"');
      expect(daemonStdout).toContain('"description":"Created during integration testing"');

      // Check status message
      expect(daemonStdout).toContain('"type":"status_request"');

      // No errors should occur
      expect(daemonStderr).not.toContain('Error');

    } finally {
      // Proper cleanup
      if (daemonProcess && !daemonProcess.killed) {
        daemonProcess.kill('SIGTERM');
        
        // Wait for process to exit
        await new Promise<void>((resolve) => {
          daemonProcess!.on('exit', () => resolve());
          // Force kill after 2 seconds
          setTimeout(() => {
            if (!daemonProcess!.killed) {
              daemonProcess!.kill('SIGKILL');
            }
            resolve();
          }, 2000);
        });
      }
    }
  }, 15000);

  test('new message types: log-progress and signal-user flow', async () => {
    let daemonProcess: ChildProcess | null = null;
    
    try {
      // 1. Start daemon
      daemonProcess = spawn('node', [bundledDaemonPath, '--socket-path', testSocketPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let daemonStdout = '';
      let daemonStderr = '';

      daemonProcess.stdout?.on('data', (data) => {
        daemonStdout += data.toString();
      });

      daemonProcess.stderr?.on('data', (data) => {
        daemonStderr += data.toString();
      });

      // 2. Wait for daemon to be ready
      await waitForSocket(testSocketPath, 5000);
      await new Promise(resolve => setTimeout(resolve, 100));

      // 3. Send log-progress command
      const logProgressResult = await runCLICommand([
        'log-progress',
        '--message', 'Authentication system implemented',
        '--category', 'milestone'
      ]);

      expect(logProgressResult.exitCode).toBe(0);
      expect(logProgressResult.stdout).toContain('Progress logged: ✅ Authentication system implemented');

      // 4. Send signal-user command
      const signalUserResult = await runCLICommand([
        'signal-user',
        '--message', 'Need help with database schema design'
      ]);

      expect(signalUserResult.exitCode).toBe(0);
      expect(signalUserResult.stdout).toContain('User signal sent: "Need help with database schema design"');

      // 5. Verify daemon received and forwarded messages
      await new Promise(resolve => setTimeout(resolve, 300));

      // Check progress_log message
      expect(daemonStdout).toContain('"type":"progress_log"');
      expect(daemonStdout).toContain('"message":"Authentication system implemented"');
      expect(daemonStdout).toContain('"category":"milestone"');

      // Check user_signal message
      expect(daemonStdout).toContain('"type":"user_signal"');
      expect(daemonStdout).toContain('"message":"Need help with database schema design"');

      // No errors should occur
      expect(daemonStderr).not.toContain('Error');

    } finally {
      // Proper cleanup
      if (daemonProcess && !daemonProcess.killed) {
        daemonProcess.kill('SIGTERM');
        
        // Wait for process to exit
        await new Promise<void>((resolve) => {
          daemonProcess!.on('exit', () => resolve());
          // Force kill after 2 seconds
          setTimeout(() => {
            if (!daemonProcess!.killed) {
              daemonProcess!.kill('SIGKILL');
            }
            resolve();
          }, 2000);
        });
      }
    }
  }, 15000);

  test('error handling: CLI with no daemon', async () => {
    // Ensure no daemon is running
    expect(fs.existsSync(testSocketPath)).toBe(false);

    const result = await runCLICommand([
      'new-taskspace',
      '--name', 'Should Fail'
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('No active theoldswitcheroo instance found');
  });

  test('daemon socket creation and cleanup', async () => {
    let daemonProcess: ChildProcess | null = null;
    
    try {
      // Start daemon
      daemonProcess = spawn('node', [bundledDaemonPath, '--socket-path', testSocketPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      await waitForSocket(testSocketPath, 5000);

      // Check socket exists
      expect(fs.existsSync(testSocketPath)).toBe(true);
      
      // Check socket permissions (platform-specific)
      const stats = fs.statSync(testSocketPath);
      const permissions = (stats.mode & parseInt('777', 8)).toString(8);
      
      if (os.platform() === 'darwin') {
        // macOS: Unix sockets may have different default permissions
        expect(['600', '755', '777']).toContain(permissions);
      } else {
        // Linux: Should be 600 (owner only)
        expect(permissions).toBe('600');
      }

      // Kill daemon
      daemonProcess.kill('SIGTERM');
      
      // Wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Socket should be cleaned up
      expect(fs.existsSync(testSocketPath)).toBe(false);

    } finally {
      if (daemonProcess && !daemonProcess.killed) {
        daemonProcess.kill('SIGKILL');
      }
    }
  });

  // Helper function to run CLI commands
  async function runCLICommand(args: string[]): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    return new Promise((resolve) => {
      const cliProcess = spawn('node', [bundledCliPath, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, THEOLDSWITCHEROO_SOCKET: testSocketPath }
      });

      let stdout = '';
      let stderr = '';

      cliProcess.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      cliProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      cliProcess.on('close', (code) => {
        resolve({
          exitCode: code || 0,
          stdout,
          stderr
        });
      });

      // Timeout after 8 seconds for CLI commands
      setTimeout(() => {
        cliProcess.kill('SIGKILL');
        resolve({
          exitCode: -1,
          stdout,
          stderr: stderr + '\nCLI command timeout'
        });
      }, 8000);
    });
  }
});

function waitForSocket(socketPath: string, timeout: number = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    const check = () => {
      if (fs.existsSync(socketPath)) {
        resolve();
      } else if (Date.now() - startTime > timeout) {
        reject(new Error(`Socket ${socketPath} not created within ${timeout}ms`));
      } else {
        setTimeout(check, 50);
      }
    };
    
    check();
  });
}

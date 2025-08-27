import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

describe('Integration Tests', () => {
  const testSocketPath = '/tmp/integration-test-daemon.sock';
  const bundledDaemonPath = path.join(__dirname, '..', 'dist', 'daemon-bundled.js');
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

      // 3. Send new-portal command
      const newPortalResult = await runCLICommand([
        'new-portal',
        '--name', 'Integration Test Portal',
        '--description', 'Created during integration testing',
        '--cwd', '/tmp/test-project'
      ]);

      expect(newPortalResult.exitCode).toBe(0);
      expect(newPortalResult.stdout).toContain('Portal creation request sent');

      // 4. Send status command
      const statusResult = await runCLICommand(['status']);

      expect(statusResult.exitCode).toBe(0);
      expect(statusResult.stdout).toContain('Status request sent');

      // 5. Verify daemon received messages
      await new Promise(resolve => setTimeout(resolve, 300));

      // Check new-portal message
      expect(daemonStdout).toContain('"type":"new_portal_request"');
      expect(daemonStdout).toContain('"name":"Integration Test Portal"');
      expect(daemonStdout).toContain('"description":"Created during integration testing"');

      // Check status message
      expect(daemonStdout).toContain('"type":"status_request"');

      // No errors should occur
      expect(daemonStderr).not.toContain('Error');

    } finally {
      // Cleanup
      if (daemonProcess && !daemonProcess.killed) {
        daemonProcess.kill();
      }
    }
  }, 15000);

  test('error handling: CLI with no daemon', async () => {
    // Ensure no daemon is running
    expect(fs.existsSync(testSocketPath)).toBe(false);

    const result = await runCLICommand([
      'new-portal',
      '--name', 'Should Fail'
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('No active theoldswitcheroo instance found');
  });

  test('daemon socket permissions and cleanup', async () => {
    let daemonProcess: ChildProcess | null = null;
    
    try {
      // Start daemon
      daemonProcess = spawn('node', [bundledDaemonPath, '--socket-path', testSocketPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      await waitForSocket(testSocketPath, 5000);

      // Check socket exists and has correct permissions
      expect(fs.existsSync(testSocketPath)).toBe(true);
      
      const stats = fs.statSync(testSocketPath);
      const permissions = (stats.mode & parseInt('777', 8)).toString(8);
      expect(permissions).toBe('600'); // Owner read/write only

      // Kill daemon
      daemonProcess.kill();
      
      // Wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Socket should be cleaned up
      expect(fs.existsSync(testSocketPath)).toBe(false);

    } finally {
      if (daemonProcess && !daemonProcess.killed) {
        daemonProcess.kill();
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
        cliProcess.kill();
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

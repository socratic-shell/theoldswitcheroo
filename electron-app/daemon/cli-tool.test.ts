import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

describe('TaskSpace CLI Tool', () => {
  let daemonProcess: ChildProcess;
  const testSocketPath = '/tmp/test-cli-daemon.sock';
  const bundledDaemonPath = path.join(__dirname, '..', 'dist', 'daemon-bundled.cjs');
  const bundledCliPath = path.join(__dirname, '..', 'dist', 'theoldswitcheroo-bundled.cjs');

  beforeEach(async () => {
    // Clean up any existing socket
    if (fs.existsSync(testSocketPath)) {
      fs.unlinkSync(testSocketPath);
    }

    // Start daemon for testing
    daemonProcess = spawn('node', [bundledDaemonPath, '--socket-path', testSocketPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Wait for socket to be created
    await waitForSocket(testSocketPath, 5000);
    
    // Give daemon a moment to fully initialize
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  afterEach(async () => {
    if (daemonProcess && !daemonProcess.killed) {
      daemonProcess.kill('SIGTERM');
      
      // Wait for process to actually exit
      await new Promise<void>((resolve) => {
        daemonProcess.on('exit', () => resolve());
        // Force kill after 2 seconds if it doesn't exit gracefully
        setTimeout(() => {
          if (!daemonProcess.killed) {
            daemonProcess.kill('SIGKILL');
          }
          resolve();
        }, 2000);
      });
    }
    
    if (fs.existsSync(testSocketPath)) {
      fs.unlinkSync(testSocketPath);
    }
  });

  test('CLI tool sends new-taskspace message', async () => {
    // Capture daemon stdout
    let stdoutData = '';
    daemonProcess.stdout?.on('data', (data) => {
      stdoutData += data.toString();
    });

    // Run CLI tool
    const cliProcess = spawn('node', [
      bundledCliPath,
      'new-taskspace',
      '--name', 'Test TaskSpace',
      '--description', 'A test taskspace'
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, THEOLDSWITCHEROO_SOCKET: testSocketPath }
    });

    let cliStdout = '';
    let cliStderr = '';
    
    cliProcess.stdout?.on('data', (data) => {
      cliStdout += data.toString();
    });
    
    cliProcess.stderr?.on('data', (data) => {
      cliStderr += data.toString();
    });

    // Wait for CLI to complete
    const exitCode = await new Promise<number>((resolve, reject) => {
      cliProcess.on('close', (code) => {
        resolve(code || 0);
      });

      setTimeout(() => {
        reject(new Error('CLI timeout'));
      }, 10000);
    });

    expect(exitCode).toBe(0);
    expect(cliStdout).toContain('TaskSpace creation request sent');
    
    // Give daemon time to process message
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Check that message was forwarded to daemon stdout
    expect(stdoutData).toContain('"type":"new_taskspace_request"');
    expect(stdoutData).toContain('"name":"Test TaskSpace"');
    expect(stdoutData).toContain('"description":"A test taskspace"');
  });

  test('CLI tool shows error when daemon not running', async () => {
    // Kill daemon first
    daemonProcess.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 200));

    // Run CLI tool
    const cliProcess = spawn('node', [
      bundledCliPath,
      'new-taskspace',
      '--name', 'Test TaskSpace'
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, THEOLDSWITCHEROO_SOCKET: testSocketPath }
    });

    let stderrData = '';
    cliProcess.stderr?.on('data', (data) => {
      stderrData += data.toString();
    });

    // Wait for CLI to complete
    await new Promise<void>((resolve) => {
      cliProcess.on('close', () => {
        resolve();
      });

      setTimeout(resolve, 5000);
    });

    expect(stderrData).toContain('No active theoldswitcheroo instance found');
  });
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

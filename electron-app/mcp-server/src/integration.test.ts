import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

describe('MCP Server Integration', () => {
  const testSocketPath = '/tmp/mcp-test-daemon.sock';
  const bundledDaemonPath = path.join(__dirname, '..', '..', 'dist', 'daemon-bundled.cjs');
  const mcpServerPath = path.join(__dirname, '..', 'dist', 'index.js');

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

  test('MCP server can send messages to daemon', async () => {
    let daemonProcess: ChildProcess | null = null;
    let mcpProcess: ChildProcess | null = null;

    try {
      // 1. Start daemon
      daemonProcess = spawn('node', [bundledDaemonPath, '--socket-path', testSocketPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let daemonStdout = '';
      daemonProcess.stdout?.on('data', (data) => {
        daemonStdout += data.toString();
      });

      // Wait for daemon to be ready
      await waitForSocket(testSocketPath, 5000);
      await new Promise(resolve => setTimeout(resolve, 100));

      // 2. Start MCP server
      mcpProcess = spawn('node', [mcpServerPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, THEOLDSWITCHEROO_SOCKET: testSocketPath }
      });

      let mcpStdout = '';
      mcpProcess.stdout?.on('data', (data) => {
        mcpStdout += data.toString();
      });

      // Wait for MCP server to start
      await new Promise(resolve => setTimeout(resolve, 500));

      // 3. Send log_progress tool call
      const toolCallRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'log_progress',
          arguments: {
            message: 'Test progress from MCP',
            category: 'info'
          }
        }
      };

      mcpProcess.stdin?.write(JSON.stringify(toolCallRequest) + '\n');

      // Wait for message to be processed
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 4. Verify daemon received the message
      expect(daemonStdout).toContain('"type":"progress_log"');
      expect(daemonStdout).toContain('"message":"Test progress from MCP"');
      expect(daemonStdout).toContain('"category":"info"');

    } finally {
      // Cleanup
      if (mcpProcess && !mcpProcess.killed) {
        mcpProcess.kill('SIGTERM');
      }
      if (daemonProcess && !daemonProcess.killed) {
        daemonProcess.kill('SIGTERM');
      }
    }
  }, 10000);
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

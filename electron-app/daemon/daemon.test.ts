import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

describe('Portal Daemon', () => {
  let daemonProcess: ChildProcess;
  const testSocketPath = '/tmp/test-daemon.sock';
  const bundledDaemonPath = path.join(__dirname, '..', 'dist', 'daemon-bundled.cjs');

  beforeEach(async () => {
    // Clean up any existing socket
    if (fs.existsSync(testSocketPath)) {
      fs.unlinkSync(testSocketPath);
    }
  });

  afterEach(() => {
    if (daemonProcess && !daemonProcess.killed) {
      daemonProcess.kill();
    }
    
    if (fs.existsSync(testSocketPath)) {
      fs.unlinkSync(testSocketPath);
    }
  });

  test('daemon starts and creates socket', async () => {
    // Start daemon
    daemonProcess = spawn('node', [bundledDaemonPath, '--socket-path', testSocketPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Wait for socket to be created
    await waitForSocket(testSocketPath, 5000);
    
    expect(fs.existsSync(testSocketPath)).toBe(true);
  });

  test('client can connect to daemon socket', async () => {
    // Start daemon
    daemonProcess = spawn('node', [bundledDaemonPath, '--socket-path', testSocketPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    await waitForSocket(testSocketPath, 5000);

    // Connect client
    const client = net.createConnection(testSocketPath);
    
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => {
        resolve();
      });
      
      client.on('error', reject);
      
      setTimeout(() => reject(new Error('Connection timeout')), 2000);
    });

    client.end();
  });

  test('daemon forwards client messages to stdout', async () => {
    // Start daemon
    daemonProcess = spawn('node', [bundledDaemonPath, '--socket-path', testSocketPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    await waitForSocket(testSocketPath, 5000);

    // Capture daemon stdout
    let stdoutData = '';
    daemonProcess.stdout?.on('data', (data) => {
      stdoutData += data.toString();
    });

    // Connect client and send message
    const client = net.createConnection(testSocketPath);
    
    await new Promise<void>((resolve) => {
      client.on('connect', () => {
        const testMessage = '{"type":"test_message","data":"hello"}';
        client.write(testMessage);
        client.end();
        
        // Wait a bit for message processing
        setTimeout(resolve, 100);
      });
    });

    expect(stdoutData).toContain('{"type":"test_message","data":"hello"}');
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

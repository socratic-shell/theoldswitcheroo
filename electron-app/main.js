const { app, BaseWindow, WebContentsView, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

// Get hostname from command line args
function getHostname() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: electron main.js <hostname>');
    process.exit(1);
  }
  return args[0];
}

// Execute SSH command using system ssh
async function execSSHCommand(hostname, command) {
  return new Promise((resolve, reject) => {
    const ssh = spawn('ssh', [hostname, command], {
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
        reject(new Error(`SSH command failed (${code}): ${stderr}`));
      }
    });
  });
}

// Map architecture output to VSCode server architecture
function mapArchitecture(arch) {
  switch (arch) {
    case 'x86_64':
      return 'linux-x64';
    case 'aarch64':
    case 'arm64':
      return 'linux-arm64';
    default:
      console.warn(`Unknown architecture '${arch}', defaulting to linux-x64`);
      return 'linux-x64';
  }
}

// Install VSCode server
async function installVSCodeServer(hostname, arch) {
  console.log(`Installing openvscode-server for ${arch}...`);
  
  const installScript = `
    cd ~/.socratic-shell/theoldswitcheroo/
    if [ ! -f openvscode-server.tar.gz ]; then
      curl -L https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v1.103.1/openvscode-server-v1.103.1-${arch}.tar.gz -o openvscode-server.tar.gz
    fi
    if [ ! -d openvscode-server ]; then
      tar -xzf openvscode-server.tar.gz
      mv openvscode-server-v1.103.1-${arch} openvscode-server
      chmod +x openvscode-server/bin/openvscode-server
    fi
  `;
  
  await execSSHCommand(hostname, installScript);
  console.log('✓ VSCode server installation complete');
}

// Start VSCode server with port forwarding
async function startVSCodeServerWithPortForwarding(hostname, port) {
  return new Promise((resolve, reject) => {
    console.log(`Starting SSH with port forwarding: localhost:${port} -> ${hostname}:${port}`);
    
    const serverScript = `
      cd ~/.socratic-shell/theoldswitcheroo/
      ./openvscode-server/bin/openvscode-server --host 0.0.0.0 --port ${port} --without-connection-token
    `;
    
    const ssh = spawn('ssh', [
      '-L', `${port}:localhost:${port}`,
      hostname,
      serverScript
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    ssh.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`[VSCode Server] ${output.trim()}`);
      
      // Look for server ready indication
      if (output.includes('Web UI available at')) {
        console.log('✓ VSCode server is ready');
        resolve(ssh);
      }
    });
    
    ssh.stderr.on('data', (data) => {
      console.error(`[VSCode Server Error] ${data.toString().trim()}`);
    });
    
    ssh.on('close', (code) => {
      console.log(`SSH process exited with code ${code}`);
    });
    
    ssh.on('error', (err) => {
      reject(new Error(`Failed to start SSH: ${err.message}`));
    });
    
    // Timeout if server doesn't start
    setTimeout(() => {
      if (!ssh.killed) {
        reject(new Error('VSCode server startup timeout'));
      }
    }, 60000); // 60 second timeout
  });
}

// SSH connection and setup using system ssh
async function setupRemoteServer(hostname) {
  console.log('Setting up remote server...');
  
  // Test basic SSH connection first
  console.log('Testing SSH connection...');
  await execSSHCommand(hostname, 'echo "SSH connection successful"');
  console.log('✓ SSH connection test successful');
  
  // Detect architecture
  console.log('Detecting remote architecture...');
  const archOutput = await execSSHCommand(hostname, 'uname -m');
  const arch = mapArchitecture(archOutput.toLowerCase());
  console.log(`✓ Detected architecture: ${archOutput} -> ${arch}`);
  
  // Setup remote directory
  console.log('Setting up remote directory...');
  await execSSHCommand(hostname, 'mkdir -p ~/.socratic-shell/theoldswitcheroo/');
  console.log('✓ Remote directory ready');
  
  // Install VSCode server
  await installVSCodeServer(hostname, arch);
  
  // Start server with port forwarding
  const port = 8765;
  console.log(`Starting VSCode server on port ${port}...`);
  const serverProcess = await startVSCodeServerWithPortForwarding(hostname, port);
  
  // Store server process globally for cleanup
  global.serverProcess = serverProcess;
  
  return { host: 'localhost', port };
}

async function checkServerHealth(url, maxRetries = 10) {
  for (let retries = 0; retries < maxRetries; retries++) {
    try {
      const response = await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
          resolve(res);
        });

        req.on('error', reject);
        req.setTimeout(2000, () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
      });

      if (response.statusCode === 200) {
        console.log('✓ Server is ready');
        return true;
      }
    } catch (error) {
      // Continue to retry
    }

    if (retries < maxRetries - 1) {
      const delay = Math.min(1000 * Math.pow(2, retries), 5000);
      console.log(`Server not ready, retrying in ${delay}ms... (${retries + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error(`Server not ready after ${maxRetries} attempts`);
}

async function createWindow() {
  const hostname = getHostname();
  
  let sessionData;
  try {
    sessionData = await setupRemoteServer(hostname);
    console.log('Remote server setup complete:', sessionData);
  } catch (error) {
    console.error('Failed to setup remote server:', error.message);
    process.exit(1);
  }

  // Configure user agent to prevent Electron blocking
  const standardUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  const vscodeUrl = `http://${sessionData.host}:${sessionData.port}`;
  console.log('VSCode should be available at:', vscodeUrl);

  try {
    // Wait for server to be ready before creating UI
    await checkServerHealth(vscodeUrl);
  } catch (error) {
    console.error('Server health check failed:', error.message);
    process.exit(1);
  }

  const mainWindow = new BaseWindow({
    width: 1200,
    height: 800,
    show: false, // Don't show until views are properly set up
    backgroundColor: '#1e1e1e',
  });

  // Create sidebar view for session management
  const sidebarView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  sidebarView.setBackgroundColor('#2d2d30'); // CRITICAL - prevents garbage pixels
  sidebarView.webContents.setUserAgent(standardUserAgent); // Use same UA as VSCode view

  // Create persistent session for VSCode
  const vscodeSession = session.fromPartition('persist:vscode-session');

  // Configure session for VSCode compatibility
  vscodeSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ['default-src * \'unsafe-inline\' \'unsafe-eval\'; script-src * \'unsafe-inline\' \'unsafe-eval\'; connect-src * \'unsafe-inline\'; img-src * data: blob: \'unsafe-inline\'; frame-src *; style-src * \'unsafe-inline\';']
      }
    });
  });

  // Create WebContentsView for VSCode
  const vscodeView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: vscodeSession,
      webSecurity: false, // Allow localhost connections
      allowRunningInsecureContent: true
    }
  });
  vscodeView.setBackgroundColor('#2d2d30');
  vscodeView.webContents.setUserAgent(standardUserAgent);

  // Add views to the window
  mainWindow.contentView.addChildView(sidebarView);
  mainWindow.contentView.addChildView(vscodeView);

  // Set bounds: sidebar on left (60px), VSCode on right
  sidebarView.setBounds({ x: 0, y: 0, width: 60, height: 800 });
  vscodeView.setBounds({ x: 60, y: 0, width: 1140, height: 800 });

  console.log('Loading VSCode from:', vscodeUrl);

  // Load the session management UI in sidebar
  sidebarView.webContents.loadFile('sidebar.html');

  // Load VSCode in the main view (server is now confirmed ready)
  console.log('About to load VSCode URL in webview...');
  vscodeView.webContents.loadURL(vscodeUrl);

  // Add webview event listeners for debugging
  vscodeView.webContents.on('did-start-loading', () => {
    console.log('VSCode webview started loading');
  });

  vscodeView.webContents.on('did-finish-load', () => {
    console.log('VSCode webview finished loading');
    // Show window only after VSCode loads
    mainWindow.show();
  });

  vscodeView.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.log('VSCode webview failed to load:', errorCode, errorDescription);
    // Show window anyway so user can see the error
    mainWindow.show();
  });
}

app.whenReady().then(() => {
  createWindow().catch(console.error);
});

app.on('window-all-closed', () => {
  // Clean up server process
  if (global.serverProcess) {
    global.serverProcess.kill();
  }
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BaseWindow.getAllWindows().length === 0) {
    createWindow().catch(console.error);
  }
});

// Clean up on exit
app.on('before-quit', () => {
  if (global.serverProcess) {
    global.serverProcess.kill();
  }
});

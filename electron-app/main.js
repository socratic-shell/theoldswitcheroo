const { app, BaseWindow, WebContentsView, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

// Global session management
let sessions = [];
let activeSessionId = null;

// Session object structure
function createSession(id, hostname, port, serverProcess) {
  return {
    id,
    hostname,
    port,
    serverProcess,
    host: 'localhost', // Always localhost due to port forwarding
    createdAt: new Date()
  };
}

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
    
    // Wrapper script that monitors parent and cleans up server on disconnect
    const serverScript = `
      cd ~/.socratic-shell/theoldswitcheroo/
      
      # Cleanup function
      cleanup() {
        if [ ! -z "$SERVER_PID" ]; then
          echo "Cleaning up VSCode server (PID: $SERVER_PID)"
          kill $SERVER_PID 2>/dev/null
        fi
        exit 0
      }
      
      # Set up signal traps to catch termination
      trap cleanup TERM INT HUP EXIT
      
      # Start VSCode server in background
      ./openvscode-server/bin/openvscode-server --host 0.0.0.0 --port ${port} --without-connection-token &
      SERVER_PID=$!
      
      # Wait a moment for server to start or fail
      sleep 2
      
      # Check if server process is still running
      if ! kill -0 $SERVER_PID 2>/dev/null; then
        echo "ERROR: openvscode-server failed to start"
        exit 1
      fi
      
      # Monitor parent process and cleanup on exit
      while true; do 
        sleep 1
      done
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
      console.log(`[VSCode Server ${port}] ${output.trim()}`);
      
      // Look for server ready indication
      if (output.includes('Web UI available at')) {
        console.log(`✓ VSCode server is ready on port ${port}`);
        resolve(ssh);
      }
    });
    
    ssh.stderr.on('data', (data) => {
      const output = data.toString().trim();
      console.error(`[VSCode Server ${port} Error] ${output}`);
      
      // Check for startup failure
      if (output.includes('ERROR: openvscode-server failed to start')) {
        reject(new Error(`VSCode server failed to start on port ${port}`));
      }
    });
    
    ssh.on('close', (code) => {
      console.log(`SSH process for port ${port} exited with code ${code}`);
    });
    
    ssh.on('error', (err) => {
      reject(new Error(`Failed to start SSH: ${err.message}`));
    });
    
    // Timeout if server doesn't start
    setTimeout(() => {
      if (!ssh.killed) {
        reject(new Error(`VSCode server startup timeout on port ${port}`));
      }
    }, 60000); // 60 second timeout
  });
}

// SSH connection and setup using system ssh
async function setupRemoteServer(hostname, sessionId) {
  console.log(`Setting up remote server for session ${sessionId}...`);
  
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
  const port = 8765 + sessionId - 1; // Session 1 gets 8765, session 2 gets 8766, etc.
  console.log(`Starting VSCode server on port ${port} for session ${sessionId}...`);
  const serverProcess = await startVSCodeServerWithPortForwarding(hostname, port);
  
  return createSession(sessionId, hostname, port, serverProcess);
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
  
  // Create first session
  let firstSession;
  try {
    firstSession = await setupRemoteServer(hostname, 1);
    sessions.push(firstSession);
    activeSessionId = 1;
    console.log('First session created:', firstSession);
  } catch (error) {
    console.error('Failed to setup remote server:', error.message);
    process.exit(1);
  }

  // Configure user agent to prevent Electron blocking
  const standardUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  const vscodeUrl = `http://${firstSession.host}:${firstSession.port}`;
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
    titleBarStyle: 'hidden', // Hide the title bar frame
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

  // Function to update view bounds based on window size
  function updateViewBounds() {
    const bounds = mainWindow.getBounds();
    const sidebarWidth = 60;
    
    sidebarView.setBounds({ x: 0, y: 0, width: sidebarWidth, height: bounds.height });
    vscodeView.setBounds({ x: sidebarWidth, y: 0, width: bounds.width - sidebarWidth, height: bounds.height });
  }

  // Set initial bounds
  updateViewBounds();

  // Update bounds when window is resized
  mainWindow.on('resize', updateViewBounds);

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
  // Clean up all session processes
  sessions.forEach(session => {
    if (session.serverProcess) {
      session.serverProcess.kill();
    }
  });
  
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
  sessions.forEach(session => {
    if (session.serverProcess) {
      session.serverProcess.kill();
    }
  });
});

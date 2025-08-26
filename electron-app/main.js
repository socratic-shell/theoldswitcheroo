const { app, BaseWindow, WebContentsView, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

// Global session management
let sessions = [];
let activeSessionId = null;
let currentHostname = null;
let mainWindow = null;
let sidebarView = null;

// Function to update view bounds based on window size
function updateViewBounds() {
  if (!mainWindow) return;
  
  const bounds = mainWindow.getBounds();
  const sidebarWidth = 75;
  
  sidebarView.setBounds({ x: 0, y: 0, width: sidebarWidth, height: bounds.height });
  
  // Update bounds for active session's view
  const activeSession = sessions.find(s => s.id === activeSessionId);
  if (activeSession && activeSession.vscodeView) {
    activeSession.vscodeView.setBounds({ x: sidebarWidth, y: 0, width: bounds.width - sidebarWidth, height: bounds.height });
  }
}

// Session object structure
function createSession(id, hostname, port, serverProcess) {
  return {
    id,
    hostname,
    port,
    serverProcess,
    host: 'localhost', // Always localhost due to port forwarding
    createdAt: new Date(),
    vscodeView: null // Will be created when first accessed
  };
}

// Switch to a different session
async function switchToSession(sessionId) {
  const session = sessions.find(s => s.id === sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }
  
  console.log(`Switching to session ${sessionId} on port ${session.port}`);
  
  // Create VSCode view for this session if it doesn't exist
  if (!session.vscodeView) {
    session.vscodeView = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });
    
    // Wait for server to be ready
    const vscodeUrl = `http://${session.host}:${session.port}`;
    await checkServerHealth(vscodeUrl);
    
    // Load VSCode in the view
    await session.vscodeView.webContents.loadURL(vscodeUrl);
  }
  
  // Remove current VSCode view if any
  const currentSession = sessions.find(s => s.id === activeSessionId);
  if (currentSession && currentSession.vscodeView) {
    mainWindow.contentView.removeChildView(currentSession.vscodeView);
  }
  
  // Add the new session's view
  mainWindow.contentView.addChildView(session.vscodeView);
  
  // Update bounds
  updateViewBounds();
  
  console.log(`✓ Switched to session ${sessionId}`);
}

// Create new session
async function createNewSession(hostname) {
  const nextSessionId = sessions.length + 1;
  console.log(`Creating session ${nextSessionId}...`);
  
  try {
    const newSession = await setupRemoteServer(hostname, nextSessionId);
    sessions.push(newSession);
    console.log(`Session ${nextSessionId} created successfully`);
    return newSession;
  } catch (error) {
    console.error(`Failed to create session ${nextSessionId}:`, error.message);
    throw error;
  }
}

// IPC handlers
ipcMain.handle('create-session', async () => {
  console.log('+ button clicked! Creating new session...');
  
  try {
    const newSession = await createNewSession(currentHostname);
    return { 
      success: true, 
      session: {
        id: newSession.id,
        port: newSession.port
      }
    };
  } catch (error) {
    return { 
      success: false, 
      error: error.message 
    };
  }
});

ipcMain.handle('switch-session', async (event, sessionId) => {
  console.log(`Switching to session ${sessionId}`);
  
  const session = sessions.find(s => s.id === sessionId);
  if (!session) {
    return { success: false, error: `Session ${sessionId} not found` };
  }
  
  try {
    await switchToSession(sessionId);
    activeSessionId = sessionId;
    return { success: true, sessionId };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get hostname from command line args
function getHostname() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: electron main.js <hostname>');
    console.error('Example: electron main.js myserver.com');
    app.quit();
    process.exit(1);
  }
  return args[0];
}

// Execute SSH command using system ssh with ControlMaster
async function execSSHCommand(hostname, command) {
  return new Promise((resolve, reject) => {
    const ssh = spawn('ssh', [
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=~/.ssh/cm-${hostname}`,
      '-o', 'ControlPersist=10m',
      hostname, 
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
async function startVSCodeServerWithPortForwarding(hostname, sessionId) {
  return new Promise((resolve, reject) => {
    console.log(`Starting SSH with port forwarding for session ${sessionId}...`);
    
    // Simple server script with auto-shutdown
    const serverScript = `
      cd ~/.socratic-shell/theoldswitcheroo/
      
      # Start VSCode with dynamic port and auto-shutdown
      ./openvscode-server/bin/openvscode-server \\
        --host 0.0.0.0 \\
        --port 0 \\
        --without-connection-token \\
        --enable-remote-auto-shutdown 2>&1
    `;
    
    const ssh = spawn('ssh', [
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=~/.ssh/cm-${hostname}`,
      '-o', 'ControlPersist=10m',
      hostname,
      serverScript
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let actualPort = null;
    
    ssh.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`[VSCode Server ${sessionId}] ${output.trim()}`);
      
      // Look for VSCode's port announcement in its output
      // VSCode typically outputs: "Web UI available at http://localhost:XXXX"
      const portMatch = output.match(/Web UI available at.*:(\d+)/i) || 
                       output.match(/localhost:(\d+)/) ||
                       output.match(/127\.0\.0\.1:(\d+)/) ||
                       output.match(/0\.0\.0\.0:(\d+)/);
      
      if (portMatch && !actualPort) {
        actualPort = parseInt(portMatch[1]);
        console.log(`✓ VSCode server ${sessionId} ready on port ${actualPort}`);
        
        // Now set up port forwarding for the actual port
        const forwardSsh = spawn('ssh', [
          '-o', 'ControlMaster=auto',
          '-o', `ControlPath=~/.ssh/cm-${hostname}`,
          '-o', 'ControlPersist=10m',
          '-L', `${actualPort}:localhost:${actualPort}`,
          '-N',
          hostname
        ]);
        
        resolve({ serverProcess: ssh, forwardProcess: forwardSsh, port: actualPort });
      }
    });
    
    ssh.stderr.on('data', (data) => {
      const output = data.toString().trim();
      console.error(`[VSCode Server ${sessionId} Error] ${output}`);
    });
    
    ssh.on('close', (code) => {
      console.log(`SSH process for session ${sessionId} exited with code ${code}`);
    });
    
    ssh.on('error', (err) => {
      reject(new Error(`Failed to start SSH: ${err.message}`));
    });
    
    // Timeout if server doesn't start
    setTimeout(() => {
      if (!actualPort) {
        reject(new Error(`VSCode server startup timeout for session ${sessionId}`));
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
  
  // Start server with dynamic port selection
  console.log(`Starting VSCode server for session ${sessionId}...`);
  const serverInfo = await startVSCodeServerWithPortForwarding(hostname, sessionId);
  
  return createSession(sessionId, hostname, serverInfo.port, serverInfo.serverProcess);
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
  currentHostname = hostname; // Store globally for IPC access
  
  if (!hostname) {
    console.error('No hostname provided');
    app.quit();
    return;
  }
  
  // Create first session
  let firstSession;
  try {
    firstSession = await setupRemoteServer(hostname, 1);
    sessions.push(firstSession);
    activeSessionId = 1;
    console.log('First session created:', firstSession);
  } catch (error) {
    console.error('Failed to setup remote server:', error.message);
    app.quit();
    return;
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
    app.quit();
    return;
  }

  mainWindow = new BaseWindow({
    width: 1200,
    height: 800,
    show: false, // Don't show until views are properly set up
    backgroundColor: '#1e1e1e',
    titleBarStyle: 'hidden', // Hide the title bar frame
  });

  // Create sidebar view for session management
  sidebarView = new WebContentsView({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false // Disable for IPC access
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

  // Create WebContentsView for first session
  firstSession.vscodeView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: vscodeSession,
      webSecurity: false, // Allow localhost connections
      allowRunningInsecureContent: true
    }
  });
  firstSession.vscodeView.setBackgroundColor('#2d2d30');
  firstSession.vscodeView.webContents.setUserAgent(standardUserAgent);

  // Add views to the window
  mainWindow.contentView.addChildView(sidebarView);
  mainWindow.contentView.addChildView(firstSession.vscodeView);

  // Set initial bounds
  updateViewBounds();

  // Update bounds when window is resized
  mainWindow.on('resize', updateViewBounds);

  console.log('Loading VSCode from:', vscodeUrl);

  // Load the session management UI in sidebar
  sidebarView.webContents.loadFile('sidebar.html');

  // Load VSCode in the main view (server is now confirmed ready)
  console.log('About to load VSCode URL in webview...');
  firstSession.vscodeView.webContents.loadURL(vscodeUrl);

  // Add webview event listeners for debugging
  firstSession.vscodeView.webContents.on('did-start-loading', () => {
    console.log('VSCode webview started loading');
  });

  firstSession.vscodeView.webContents.on('did-finish-load', () => {
    console.log('VSCode webview finished loading');
    // Show window only after VSCode loads
    mainWindow.show();
  });

  firstSession.vscodeView.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
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

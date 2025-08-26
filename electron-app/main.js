const { app, BaseWindow, WebContentsView, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

// Session persistence
const SESSION_FILE = path.join(os.homedir(), '.socratic-shell', 'theoldswitcheroo', 'sessions.json');

// Load sessions from disk
function loadSessions() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = fs.readFileSync(SESSION_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Failed to load sessions:', error.message);
  }
  return { hostname: null, sessions: [] };
}

// Save sessions to disk
function saveSessions(hostname, sessionList) {
  try {
    const dir = path.dirname(SESSION_FILE);
    fs.mkdirSync(dir, { recursive: true });
    
    const data = {
      hostname,
      sessions: sessionList.map(s => ({
        id: s.id,
        port: s.port,
        serverDataDir: `~/.socratic-shell/theoldswitcheroo/sessions/session-${s.id}/server-data`,
        lastSeen: new Date().toISOString()
      }))
    };
    
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
    console.log(`Saved ${sessionList.length} sessions to ${SESSION_FILE}`);
  } catch (error) {
    console.error('Failed to save sessions:', error.message);
  }
}

// Global session management
let sessions = [];
let activeSessionId = null;
let currentHostname = null;
let mainWindow = null;
let sidebarView = null;

class SplashScreen {
  constructor() {
    this.splashWindow = new BaseWindow({
      width: 500,
      height: 400,
      show: false,
      frame: false,
      backgroundColor: '#1e1e1e',
      center: true,
      resizable: false
    });

    this.splashView = new WebContentsView({
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    this.splashWindow.contentView.addChildView(this.splashView);
    this.splashView.setBounds({ x: 0, y: 0, width: 500, height: 400 });

    this.splashView.webContents.loadFile('splash.html');

    this.splashView.webContents.once('did-finish-load', () => {
      this.splashWindow.show();
    });
  }

  get webContents() {
    return this.splashView.webContents;
  }

  updateHostname(hostname) {
    this.webContents.postMessage('splash-hostname', hostname);
  }

  updateSessions(hostname) {
    this.webContents.postMessage('splash-sessions', hostname);
  }

  log(message) {
    console.log(message);
    this.webContents.postMessage('splash-log', message);
  }

  close() {
    this.splashWindow.close();
  }
}

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
    const newSession = await setupRemoteServer(null, hostname, nextSessionId);
    sessions.push(newSession);
    
    // Save updated session list
    saveSessions(hostname, sessions);
    
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

    // Simple server script with auto-shutdown and data directories
    const serverScript = `
      cd ~/.socratic-shell/theoldswitcheroo/
      
      # Create session-specific directories
      mkdir -p sessions/session-${sessionId}/server-data
      mkdir -p vscode-user-data
      
      # Start VSCode with data directories and dynamic port
      ./openvscode-server/bin/openvscode-server \\
        --host 0.0.0.0 \\
        --port 0 \\
        --user-data-dir ~/.socratic-shell/theoldswitcheroo/vscode-user-data \\
        --server-data-dir ~/.socratic-shell/theoldswitcheroo/sessions/session-${sessionId}/server-data \\
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
async function setupRemoteServer(splash, hostname, sessionId) {
  splash.log(`Setting up remote server for session ${sessionId}...`);

  // Test basic SSH connection first
  splash.log('Testing SSH connection...');
  await execSSHCommand(hostname, 'echo "SSH connection successful"');
  splash.log('✓ SSH connection test successful');

  // Detect architecture
  splash.log('Detecting remote architecture...');
  const archOutput = await execSSHCommand(hostname, 'uname -m');
  const arch = mapArchitecture(archOutput.toLowerCase());
  splash.log(`✓ Detected architecture: ${archOutput} -> ${arch}`);

  // Setup remote directory
  splash.log('Setting up remote directory...');
  await execSSHCommand(hostname, 'mkdir -p ~/.socratic-shell/theoldswitcheroo/');
  splash.log('✓ Remote directory ready');

  // Install VSCode server
  splash.log('Installing VSCode server...');
  await installVSCodeServer(hostname, arch);
  splash.log('✓ VSCode server installation complete');

  // Start server with dynamic port selection
  splash.log(`Starting VSCode server for session ${sessionId}...`);
  const serverInfo = await startVSCodeServerWithPortForwarding(hostname, sessionId);
  splash.log(`✓ VSCode server ${sessionId} ready on port ${serverInfo.port}`);

  return createSession(sessionId, hostname, serverInfo.port, serverInfo.serverProcess);
}

// Check if a session is still alive
async function checkSessionHealth(sessionData) {
  try {
    const url = `http://localhost:${sessionData.port}`;
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
    
    return response.statusCode === 200;
  } catch (error) {
    return false;
  }
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

  // Create and show splash screen
  let splash = new SplashScreen();

  // Wait for splash to load before updating it
  await new Promise(resolve => {
    splash.webContents.once('did-finish-load', resolve);
  });

  splash.updateHostname(hostname);

  // Load existing sessions
  splash.log('Checking for existing sessions...');
  const savedData = loadSessions();
  
  if (savedData.hostname === hostname && savedData.sessions.length > 0) {
    splash.log(`Found ${savedData.sessions.length} existing sessions, checking health...`);
    
    // Check health of each saved session
    for (const sessionData of savedData.sessions) {
      splash.log(`Checking session ${sessionData.id}...`);
      
      const isAlive = await checkSessionHealth(sessionData);
      if (isAlive) {
        splash.log(`✓ Session ${sessionData.id}: Reconnecting to port ${sessionData.port}`);
        // Create session object for existing server
        const existingSession = createSession(sessionData.id, hostname, sessionData.port, null);
        sessions.push(existingSession);
      } else {
        splash.log(`Session ${sessionData.id}: Server died, will restart...`);
        // Create new server with same session ID
        try {
          const newSession = await setupRemoteServer(splash, hostname, sessionData.id);
          sessions.push(newSession);
          splash.log(`✓ Session ${sessionData.id}: Restarted on port ${newSession.port}`);
        } catch (error) {
          splash.log(`✗ Session ${sessionData.id}: Failed to restart - ${error.message}`);
        }
      }
    }
    
    if (sessions.length > 0) {
      activeSessionId = sessions[0].id;
    }
  }
  
  // If no sessions exist, create first session
  if (sessions.length === 0) {
    splash.log('No existing sessions found, creating first session...');
    try {
      const firstSession = await setupRemoteServer(splash, hostname, 1);
      sessions.push(firstSession);
      activeSessionId = 1;
      splash.log(`✓ Created first session on port ${firstSession.port}`);
    } catch (error) {
      splash.log(`✗ Failed to create first session: ${error.message}`);
      setTimeout(() => app.quit(), 3000);
      return;
    }
  }

  // Save current session state
  saveSessions(hostname, sessions);

  splash.log('Setting up interface...');

  // Configure user agent to prevent Electron blocking
  const standardUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  // Get the active session
  const activeSession = sessions.find(s => s.id === activeSessionId);
  const vscodeUrl = `http://${activeSession.host}:${activeSession.port}`;
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

  // Create WebContentsView for active session
  activeSession.vscodeView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: vscodeSession,
      webSecurity: false, // Allow localhost connections
      allowRunningInsecureContent: true
    }
  });
  activeSession.vscodeView.setBackgroundColor('#2d2d30');
  activeSession.vscodeView.webContents.setUserAgent(standardUserAgent);

  // Add views to the window
  mainWindow.contentView.addChildView(sidebarView);
  mainWindow.contentView.addChildView(activeSession.vscodeView);

  // Set initial bounds
  updateViewBounds();

  // Update bounds when window is resized
  mainWindow.on('resize', updateViewBounds);

  console.log('Loading VSCode from:', vscodeUrl);

  // Load the session management UI in sidebar
  sidebarView.webContents.loadFile('sidebar.html');

  // Load VSCode in the main view (server is now confirmed ready)
  console.log('About to load VSCode URL in webview...');
  activeSession.vscodeView.webContents.loadURL(vscodeUrl);

  // Add webview event listeners for debugging
  activeSession.vscodeView.webContents.on('did-start-loading', () => {
    console.log('VSCode webview started loading');
  });

  activeSession.vscodeView.webContents.on('did-finish-load', () => {
    console.log('VSCode webview finished loading');
    // Close splash and show main window
    setTimeout(() => {
      splash.close();
      mainWindow.show();
    }, 500);
  });

  activeSession.vscodeView.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.log('VSCode webview failed to load:', errorCode, errorDescription);
    // Close splash and show window anyway so user can see the error
    splash.close();
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

const { app, BaseWindow, WebContentsView, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

function readSessionFile() {
  const sessionFile = path.join(os.homedir(), '.socratic-shell', 'theoldswitcheroo', 'session.json');
  
  try {
    const data = fs.readFileSync(sessionFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    throw new Error(`No active session found. Please run the setup tool first.\nExpected file: ${sessionFile}`);
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
  let sessionData;
  try {
    sessionData = readSessionFile();
    console.log('Session data:', sessionData);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const vscodeUrl = `http://${sessionData.host}:${sessionData.port}`;
  console.log('Checking server health at:', vscodeUrl);

  try {
    // Wait for server to be ready before creating UI
    await checkServerHealth(vscodeUrl);
  } catch (error) {
    console.error('Server health check failed:', error.message);
    process.exit(1);
  }

  const mainWindow = new BaseWindow({
    width: 1200,
    height: 800
  });

  // Create sidebar view for session management
  const sidebarView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

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

  // Configure user agent to prevent Electron blocking
  const standardUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  vscodeView.webContents.setUserAgent(standardUserAgent);

  // Add views to the window
  mainWindow.contentView.addChildView(sidebarView);
  mainWindow.contentView.addChildView(vscodeView);

  // Set bounds: sidebar on left (60px), VSCode on right
  sidebarView.setBounds({ x: 0, y: 0, width: 60, height: 800 });
  vscodeView.setBounds({ x: 60, y: 0, width: 1140, height: 800 });

  console.log('Loading VSCode from:', vscodeUrl);

  // Load the session management UI in sidebar
  sidebarView.webContents.loadFile('index.html');

  // Load VSCode in the main view (server is now confirmed ready)
  console.log('About to load VSCode URL in webview...');
  vscodeView.webContents.loadURL(vscodeUrl);

  // Add webview event listeners for debugging
  vscodeView.webContents.on('did-start-loading', () => {
    console.log('VSCode webview started loading');
  });

  vscodeView.webContents.on('did-finish-load', () => {
    console.log('VSCode webview finished loading');
  });

  vscodeView.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.log('VSCode webview failed to load:', errorCode, errorDescription);
  });

  // Enable dev tools for debugging
  sidebarView.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow().catch(console.error);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BaseWindow.getAllWindows().length === 0) {
    createWindow().catch(console.error);
  }
});

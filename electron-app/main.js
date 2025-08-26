const { app, BaseWindow, WebContentsView } = require('electron');
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

function checkServerHealth(url, maxRetries = 10) {
  return new Promise((resolve, reject) => {
    let retries = 0;
    
    function attempt() {
      const req = http.get(url, (res) => {
        if (res.statusCode === 200) {
          console.log('✓ Server is ready');
          resolve(true);
        } else {
          retry();
        }
      });
      
      req.on('error', () => {
        retry();
      });
      
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    }
    
    function retry() {
      retries++;
      if (retries >= maxRetries) {
        reject(new Error(`Server not ready after ${maxRetries} attempts`));
        return;
      }
      
      const delay = Math.min(1000 * Math.pow(2, retries - 1), 5000); // Exponential backoff, max 5s
      console.log(`Server not ready, retrying in ${delay}ms... (${retries}/${maxRetries})`);
      setTimeout(attempt, delay);
    }
    
    attempt();
  });
}

async function createWindow() {
  let session;
  try {
    session = readSessionFile();
    console.log('Session data:', session);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const vscodeUrl = `http://${session.host}:${session.port}`;
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

  // Create WebContentsView for VSCode
  const vscodeView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

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
  vscodeView.webContents.loadURL(vscodeUrl);

  // Enable dev tools for debugging
  sidebarView.webContents.openDevTools();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BaseWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

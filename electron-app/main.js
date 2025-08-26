const { app, BaseWindow, WebContentsView } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

function readSessionFile() {
  const sessionFile = path.join(os.homedir(), '.socratic-shell', 'theoldswitcheroo', 'session.json');
  
  try {
    const data = fs.readFileSync(sessionFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    throw new Error(`No active session found. Please run the setup tool first.\nExpected file: ${sessionFile}`);
  }
}

function createWindow() {
  let session;
  try {
    session = readSessionFile();
    console.log('Session data:', session);
  } catch (error) {
    console.error(error.message);
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

  const vscodeUrl = `http://${session.host}:${session.port}`;
  console.log('Loading VSCode from:', vscodeUrl);

  // Load the session management UI in sidebar
  sidebarView.webContents.loadFile('index.html');

  // Load VSCode in the main view
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

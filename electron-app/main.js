const { app, BrowserWindow } = require('electron');
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
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true
    }
  });

  // Pass session info to renderer
  mainWindow.webContents.once('dom-ready', () => {
    mainWindow.webContents.executeJavaScript(`
      document.getElementById('vscode-webview').src = 'http://${session.host}:${session.port}';
    `);
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

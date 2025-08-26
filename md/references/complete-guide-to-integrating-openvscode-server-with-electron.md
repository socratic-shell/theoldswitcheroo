# Complete Guide to Integrating OpenVSCode-Server with Electron via SSH Tunnel

## The critical issue: webview configuration and connection timing

Your ERR_CONNECTION_RESET error stems from three interconnected problems that commonly affect Electron webview integrations with remote VSCode instances. **The most immediate fix is removing "Electron" from the user agent string**, as many web services actively block Electron clients. Additionally, **webview tags are deprecated and problematic** for VSCode integration - you should migrate to WebContentsView immediately.

The connection reset happens because openvscode-server requires secure contexts for its service workers, but Electron's default webview configuration doesn't properly handle localhost connections through SSH tunnels. The server is running correctly, but the webview's security context and timing prevent proper connection establishment.

## Why openvscode-server beats Microsoft's alternatives

Gitpod created openvscode-server in 2021 to fill a critical gap: Microsoft's VS Code Server implementation remains proprietary with licensing restrictions that **explicitly prohibit hosting as a service**. OpenVSCode-Server maintains a minimal fork of VS Code with just enough changes to enable browser-based operation while staying synchronized with upstream VS Code daily.

The key advantages for your Electron integration include full MIT licensing without commercial restrictions, direct VS Code fork architecture ensuring compatibility with Electron's shared Chromium foundation, and official backing from major tech companies including GitLab, VMware, and SAP. Unlike code-server which adds extensive customizations, openvscode-server maintains vanilla VS Code behavior, making it ideal for seamless Electron embedding.

## Implementing robust webview integration with WebContentsView

### Migrate from deprecated webview tags to WebContentsView

WebContentsView became the official recommendation in Electron v30.0.0, offering superior websocket support crucial for VSCode's Language Server Protocol, proper session management with persistent partitions, and native clipboard and keyboard shortcut handling. The deprecated webview tag causes "dramatic architectural changes that impact stability" according to Electron's documentation.

```javascript
const { BaseWindow, WebContentsView, session } = require('electron');
const { spawn } = require('child_process');
const axios = require('axios');

class VSCodeIntegration {
  constructor() {
    this.serverPort = 8765;
    this.serverUrl = `http://localhost:${this.serverPort}`;
    this.vscodeView = null;
    this.mainWindow = null;
  }

  async createWindow() {
    this.mainWindow = new BaseWindow({ 
      width: 1400, 
      height: 900,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    // Critical: Use WebContentsView instead of webview tag
    this.vscodeView = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false, // Required for remote VSCode
        allowRunningInsecureContent: true,
        partition: 'persist:vscode-session',
        backgroundThrottling: false,
        v8CacheOptions: 'code'
      }
    });

    this.mainWindow.contentView.addChildView(this.vscodeView);
    this.vscodeView.setBounds({ x: 0, y: 0, width: 1400, height: 900 });
    
    // Handle window resizing
    this.mainWindow.on('resize', () => {
      const bounds = this.mainWindow.getBounds();
      this.vscodeView.setBounds({ 
        x: 0, y: 0, 
        width: bounds.width, 
        height: bounds.height 
      });
    });
  }

  setupSecurityHeaders() {
    // Configure permissive CSP for VSCode functionality
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src * 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; " +
            "script-src * 'self' 'unsafe-inline' 'unsafe-eval' blob: data:; " +
            "connect-src * 'self' ws: wss:; " +
            "worker-src 'self' blob:;"
          ],
          'Access-Control-Allow-Origin': ['*']
        }
      });
    });
  }
}
```

### Critical webview configuration fixes

The ERR_CONNECTION_RESET specifically results from Electron's default user agent being blocked. **Always filter out the Electron identifier**:

```javascript
// Fix user agent to prevent connection blocks
this.vscodeView.webContents.on('dom-ready', () => {
  const currentUA = this.vscodeView.webContents.getUserAgent();
  const cleanedUA = currentUA.split(' ')
    .filter(part => !part.startsWith('Electron'))
    .join(' ');
  this.vscodeView.webContents.setUserAgent(cleanedUA);
});

// Handle WebSocket connections properly
session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
  if (details.requestHeaders['Upgrade'] === 'websocket') {
    delete details.requestHeaders['Origin']; // Remove origin restrictions
  }
  callback({ requestHeaders: details.requestHeaders });
});
```

## Implementing comprehensive health checks before loading

OpenVSCode-Server lacks a built-in `/healthz` endpoint, requiring custom verification that goes beyond simple port checking. The server needs 5-15 seconds to fully initialize, during which it loads static assets, initializes the Monaco editor, and starts language servers.

```javascript
class OpenVSCodeHealthChecker {
  constructor(baseUrl = 'http://localhost:8765') {
    this.baseUrl = baseUrl;
    this.maxRetries = 10;
    this.retryDelay = 2000;
  }

  async checkServerReady() {
    try {
      const response = await axios.get(this.baseUrl, {
        timeout: 5000,
        validateStatus: (status) => status < 500
      });
      
      // Verify VS Code content is actually loaded
      const hasVSCodeContent = 
        response.data.includes('vs/workbench/workbench.web.main.js') ||
        response.data.includes('monaco') ||
        response.data.includes('microsoft');
      
      return response.status === 200 && hasVSCodeContent;
    } catch (error) {
      return false;
    }
  }

  async waitForServer() {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      console.log(`Health check attempt ${attempt}/${this.maxRetries}`);
      
      if (await this.checkServerReady()) {
        console.log('OpenVSCode Server ready!');
        return true;
      }
      
      await new Promise(resolve => setTimeout(resolve, this.retryDelay));
      this.retryDelay *= 1.2; // Exponential backoff
    }
    
    throw new Error('Server failed to become ready');
  }
}

// Integration with SSH tunnel verification
async function verifySSHTunnelAndServer() {
  // First verify SSH tunnel is active
  const tunnelActive = await checkPort('localhost', 8765);
  if (!tunnelActive) {
    throw new Error('SSH tunnel not established');
  }
  
  // Then verify server is responding
  const healthChecker = new OpenVSCodeHealthChecker();
  await healthChecker.waitForServer();
  
  // Finally verify content can be loaded
  const testResponse = await axios.get('http://localhost:8765/version', {
    timeout: 3000
  });
  
  return testResponse.status === 200;
}
```

## Authentication and security configuration strategies

The `--without-connection-token` flag completely disables authentication, which is acceptable for localhost SSH tunnels but creates security risks. OpenVSCode-Server generates random UUID tokens by default (like `40711257-5e5d-4906-b88f-fe13b1f317b7`) that must be passed as query parameters.

For your Electron integration with SSH tunneling, **using a fixed token provides the best balance**:

```bash
# Server command with fixed token for predictable access
./openvscode-server --host 127.0.0.1 --port 8765 --connection-token="your-fixed-token"
```

```javascript
// Load with token in Electron
const serverUrl = 'http://localhost:8765/?tkn=your-fixed-token';
this.vscodeView.webContents.loadURL(serverUrl);

// Or extract token from server output
function parseServerOutput(data) {
  const output = data.toString();
  const tokenMatch = output.match(/tkn=([a-f0-9-]+)/);
  if (tokenMatch) {
    return tokenMatch[1];
  }
  return null;
}
```

## Complete debugging strategy for connection issues

### Systematic debugging checklist

When encountering ERR_CONNECTION_RESET, follow this specific sequence:

1. **Verify basic connectivity outside Electron**:
```bash
# Test direct access
curl -I http://localhost:8765/
# Check SSH tunnel
lsof -i :8765
netstat -tlnp | grep 8765
```

2. **Enable comprehensive Electron logging**:
```javascript
// Start with full debugging
app.commandLine.appendSwitch('enable-logging');
app.commandLine.appendSwitch('v', '1');
app.commandLine.appendSwitch('trace-warnings');

// Open DevTools for webview
this.vscodeView.webContents.openDevTools();
```

3. **Monitor network events in webview**:
```javascript
this.vscodeView.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
  console.log(`Load failed: ${errorDescription} (${errorCode})`);
  if (errorCode === -102) { // ERR_CONNECTION_RESET
    // Implement retry with cleaned user agent
    setTimeout(() => this.retryConnection(), 2000);
  }
});

this.vscodeView.webContents.on('certificate-error', (event) => {
  event.preventDefault(); // Accept self-signed certificates for localhost
});
```

### Common error solutions

**IPv6 addressing issues**: SSH tunnels may use IPv6 localhost (::1) which requires proper bracket notation:
```javascript
const url = isIPv6 ? `http://[::1]:8765` : `http://localhost:8765`;
```

**Timing race conditions**: The webview may attempt connection before SSH tunnel stabilizes:
```javascript
// Add deliberate delay after SSH tunnel establishment
await new Promise(resolve => setTimeout(resolve, 1000));
await healthChecker.waitForServer();
```

**Service worker security errors**: Ensure secure context for service worker registration:
```javascript
// Use HTTPS with self-signed certificate for production
const https = require('https');
const fs = require('fs');

const httpsOptions = {
  key: fs.readFileSync('key.pem'),
  cert: fs.readFileSync('cert.pem')
};
```

## Production-ready implementation with full error handling

```javascript
class ProductionVSCodeIntegration {
  constructor(config) {
    this.config = {
      serverPort: config.serverPort || 8765,
      maxRetries: config.maxRetries || 10,
      retryDelay: config.retryDelay || 2000,
      useToken: config.useToken !== false,
      token: config.token || null
    };
    
    this.healthChecker = new OpenVSCodeHealthChecker(
      `http://localhost:${this.config.serverPort}`
    );
  }

  async initialize() {
    try {
      // Wait for SSH tunnel from Rust tool
      await this.waitForSSHTunnel();
      
      // Verify server health
      await this.healthChecker.waitForServer();
      
      // Create Electron window
      await this.createWindow();
      
      // Configure security
      this.setupSecurityHeaders();
      
      // Load VSCode with retry logic
      await this.loadVSCodeWithRetry();
      
      return true;
    } catch (error) {
      console.error('VSCode integration failed:', error);
      this.handleInitializationFailure(error);
      return false;
    }
  }

  async loadVSCodeWithRetry() {
    let retries = 0;
    const maxRetries = 3;
    
    const attemptLoad = async () => {
      try {
        // Clean user agent
        this.cleanUserAgent();
        
        // Build URL with optional token
        const url = this.buildServerUrl();
        
        // Load and wait for success
        await this.vscodeView.webContents.loadURL(url);
        
        // Verify content loaded
        const loaded = await this.verifyVSCodeContent();
        if (!loaded) throw new Error('VSCode content verification failed');
        
        console.log('VSCode successfully loaded');
        return true;
      } catch (error) {
        retries++;
        if (retries >= maxRetries) throw error;
        
        console.log(`Retry ${retries}/${maxRetries} after error:`, error.message);
        await new Promise(resolve => setTimeout(resolve, 2000 * retries));
        return attemptLoad();
      }
    };
    
    return attemptLoad();
  }

  async verifyVSCodeContent() {
    return this.vscodeView.webContents.executeJavaScript(`
      document.querySelector('.monaco-workbench') !== null ||
      document.querySelector('.vs') !== null ||
      document.title.includes('Visual Studio Code')
    `);
  }

  cleanUserAgent() {
    const ua = this.vscodeView.webContents.getUserAgent();
    const cleaned = ua.split(' ')
      .filter(part => !part.includes('Electron'))
      .join(' ');
    this.vscodeView.webContents.setUserAgent(cleaned);
  }

  buildServerUrl() {
    const base = `http://localhost:${this.config.serverPort}`;
    return this.config.useToken && this.config.token 
      ? `${base}/?tkn=${this.config.token}`
      : base;
  }
}
```

## Key success factors for your implementation

Your specific setup with Rust SSH tooling and Electron requires three critical adjustments: **migrating from webview tags to WebContentsView** for stability, **removing "Electron" from the user agent** to prevent connection blocks, and **implementing proper health checking** with exponential backoff before attempting to load the VSCode interface.

The openvscode-server choice is optimal for your use case due to its minimal fork approach, unrestricted licensing, and compatibility with Electron's architecture. With the configuration provided above, you'll achieve a stable integration that handles the complexities of SSH tunneling, authentication, and webview security while maintaining full VSCode functionality in your Electron application.
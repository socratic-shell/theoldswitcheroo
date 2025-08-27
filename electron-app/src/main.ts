const { app, BaseWindow, WebContentsView, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

// Type definitions
interface Extensions {
  marketplace: string[];
  local: string[];
}

interface ServerInfo {
  port: number;
  serverProcess?: any;
}

interface ILoadingView {
  updateMessage(message: string): void;
  getView(): any;
}

// Generate UUID v4
function generateUUID(): string {
  return randomUUID();
}

// Portal persistence
const LOCAL_DATA_DIR = path.join(os.homedir(), '.socratic-shell', 'theoldswitcheroo');
const PORTALS_FILE = path.join(LOCAL_DATA_DIR, 'portals.json');
const BASE_DIR = "~/.socratic-shell/theoldswitcheroo";

class PortalPaths {
  dir: string;
  cloneDir: string;
  serverDataDir: string;
  extensionsDir: string;
  freshClone: string;

  constructor(uuid: string) {
    this.dir = `portals/${uuid}`;
    this.cloneDir = `portals/${uuid}/clone`;
    this.serverDataDir = `portals/portal-${uuid}/server-data`;
    this.extensionsDir = `portals/portal-${uuid}/extensions`;
    this.freshClone = `portals/${uuid}/fresh-clone.sh`;
  }
}

// Helper to read project extensions
function readProjectExtensions(): Extensions {
  const projectName = 'theoldswitcheroo';
  const projectDir = path.join(LOCAL_DATA_DIR, 'projects', projectName);
  const extensionsFile = path.join(projectDir, 'vscode-extensions.json');

  if (fs.existsSync(extensionsFile)) {
    try {
      const extensionsData = JSON.parse(fs.readFileSync(extensionsFile, 'utf8'));
      return {
        marketplace: extensionsData.extensions || [],
        local: extensionsData.local_extensions || []
      };
    } catch (error) {
      console.log(`Warning: Could not parse vscode-extensions.json: ${error.message}`);
    }
  }
  return { marketplace: [], local: [] };
}

// Configure user agent to prevent Electron blocking
const STANDARD_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function main() {
  const hostname = getHostname();

  if (!hostname) {
    console.error('No hostname provided');
    app.quit();
    return;
  }

  await new SwitcherooApp(hostname).bootUp();
}

// Parse CLI arguments for --clean command
const args = process.argv.slice(2);
const cleanIndex = args.indexOf('--clean');
if (cleanIndex !== -1 && cleanIndex + 1 < args.length) {
  const hostname = args[cleanIndex + 1];
  console.log(`Cleaning ~/.socratic-shell/theoldswitcheroo from ${hostname}...`);

  execSSHCommand(hostname, `rm -rf ~/.socratic-shell/theoldswitcheroo`)
    .then(() => {
      console.log(`✓ Cleaned ~/.socratic-shell/theoldswitcheroo from ${hostname}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`✗ Failed to clean from ${hostname}:`, error.message);
      process.exit(1);
    });
} else if (app) {
  // Normal app startup (only if running in Electron)
  app.whenReady().then(() => {
    main().catch(console.error);
  });

  app.on('activate', () => {
    if (BaseWindow.getAllWindows().length === 0) {
      main().catch(console.error);
    }
  });
} else {
  console.error('This script must be run with Electron or with --clean flag');
  process.exit(1);
}

class SwitcherooApp {
  portals: Portal[] = [];
  activePortalUuid: string | null = null;
  hostname: string;
  loadingView: ILoadingView;
  vscodeSession: any;
  mainWindow: any = null;
  sidebarView: any = null;
  mainView: any = null;

  constructor(hostname: string) {
    // Global session management
    this.portals = [];
    this.activePortalUuid = null;
    this.hostname = hostname;
    this.loadingView = new LoadingView();

    // Create a persistent session for this hostname (shared across all sessions)
    // and initialize it for vscode compatibility.
    this.vscodeSession = session.fromPartition(`persist:vscode-${hostname}`);
    this.vscodeSession.setCodeCachePath(path.join(LOCAL_DATA_DIR, 'code-cache'));
    this.vscodeSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ['default-src * \'unsafe-inline\' \'unsafe-eval\'; script-src * \'unsafe-inline\' \'unsafe-eval\'; connect-src * \'unsafe-inline\'; img-src * data: blob: \'unsafe-inline\'; frame-src *; style-src * \'unsafe-inline\';']
        }
      });
    });

    // Create the main window
    this.mainWindow = new BaseWindow({
      width: 1200,
      height: 800,
      show: false, // Don't show until views are properly set up
      backgroundColor: '#1e1e1e',
      titleBarStyle: 'hidden', // Hide the title bar frame
    });

    // Create sidebar view for session management
    this.sidebarView = new WebContentsView({
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false // Disable for IPC access
      }
    });
    this.sidebarView.setBackgroundColor('#2d2d30'); // CRITICAL - prevents garbage pixels
    this.sidebarView.webContents.setUserAgent(STANDARD_USER_AGENT); // Use same UA as VSCode view
    this.sidebarView.webContents.inspectSharedWorker();
    this.mainWindow.contentView.addChildView(this.sidebarView);

    // Clear the "main view" to null, also initializing bounds etc
    this.mainView = null;
    this.setMainView(null);

    // Initialize the main IPC handlers. These will receive various
    // messages from the other views.
    ipcMain.handle('create-portal', async () => await this.handleCreatePortal());
    ipcMain.handle('toggle-view', async (_event, portalUuid) => await this.handleToggleViewMessage(portalUuid));
    ipcMain.handle('switch-portal', async (_event, portalUuid) => await this.handleSwitchPortalMessage(portalUuid));
  }

  async bootUp() {
    // Show main window immediately with loading view
    this.setMainView(this.loadingView.getView());
    this.mainWindow.show();

    // Initialize the sidebar HTML and wait for it to load.
    this.loadingView.updateMessage('Loading interface...');
    this.sidebarView.webContents.loadFile('sidebar.html');
    await new Promise(resolve => {
      this.sidebarView.webContents.once('did-finish-load', resolve);
    });

    // Load existing portals
    this.loadingView.updateMessage('Checking for existing portals...');
    this.log('Checking for existing portals...');
    const savedPortalData = this.loadPortalData();

    // If there is savedData, restore it
    if (savedPortalData.hostname === this.hostname && savedPortalData.portals.length > 0) {
      this.loadingView.updateMessage('Restoring saved portals...');
      await this.restoreSavedPortals(savedPortalData);
      this.notifyPortalsChanged();
    }

    // Make sure there is at least one portal
    if (this.portals.length == 0) {
      this.loadingView.updateMessage('Creating initial portal...');
      this.log(`Creating initial portal`);
      const portal = await this.createNewPortal(this.loadingView);
      this.log(`✓ Portal ${portal.name}: Started on port ${portal.port}`);
    }

    // Make sure *some* portal is selected
    if (!this.activePortalUuid || !this.portalWithUuid(this.activePortalUuid)) {
      this.activePortalUuid = this.portals[0].uuid;
    }

    // Select the active portal
    this.loadingView.updateMessage('Loading VSCode...');
    await this.switchPortal(this.portalWithUuid(this.activePortalUuid));
  }

  /// Replace the "main view" in our app with `view`
  /// and resize it to balance it with the sidebar (which is never removed).
  /// This will remove the existing main view, if any.
  setMainView(view) {
    // Remove the old main view (leave the sidebar view)
    if (this.mainView) {
      this.mainWindow.contentView.removeChildView(this.mainView);
    }

    // Add the new one
    this.mainView = view;
    if (view) {
      this.mainWindow.contentView.addChildView(view);
    }

    // Adjust the bounds of this new view to match the window size
    this.updateViewBounds();
  }

  /// Create a vscode server for portal with uuid and (optionally) a previous port.
  async ensureVSCodeServer(portal) {
    // If portal already has a running server, check if it's still alive
    if (portal.port) {
      if (await checkPortalHealth(this.hostname, portal.port)) {
        this.log(`✓ Portal ${portal.name}: Server still running on port ${portal.port}`);
        // Ensure port forwarding is active
        this.forwardPort(portal.port);
        return; // Server is good
      } else {
        this.log(`Portal ${portal.name}: Server died, restarting...`);
      }
    }

    // Start fresh server
    this.log(`Starting VSCode server for portal ${portal.name}...`);

    // Detect architecture
    const archOutput = await execSSHCommand(this.hostname, 'uname -m');
    const arch = mapArchitecture(String(archOutput).toLowerCase());

    // Install VSCode server
    await installVSCodeServer(this.hostname, arch);

    // Start server
    const extensions = portal.extensions || readProjectExtensions();
    const serverInfo = await this.startVSCodeServer(this.hostname, portal.uuid, portal.name, extensions);

    // Update port on the portal
    portal.port = serverInfo.port;

    // Start port forwarding
    this.forwardPort(serverInfo.port);

    this.log(`✓ Portal ${portal.name}: Server ready on port ${portal.port}`);
  }

  /// Log messages to console
  log(message) {
    console.log(message);
  }

  /// Handles a new session message from the sidebar
  async handleCreatePortal() {
    console.log('+ button clicked! Creating new session...');

    try {
      const newPortal = await this.createNewPortal();
      console.log('newPortal created', newPortal);
      return {
        success: true,
        uuid: newPortal.uuid,
        name: newPortal.name,
        port: newPortal.port
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  portalWithUuid(portalUuid) {
    return this.portals.find(s => s.uuid === portalUuid);
  }

  /// Handles a switch portal from the sidebar
  async handleSwitchPortalMessage(portalUuid) {
    this.log(`Switching to portal ${portalUuid}`);

    const portal = this.portalWithUuid(portalUuid);
    if (!portal) {
      return { success: false, error: `Portal ${portalUuid} not found` };
    }

    try {
      await this.switchPortal(portal);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async switchPortal(portal) {
    this.log(`switchPortal ${portal}`);

    // Show loading view immediately
    this.setMainView(this.loadingView.getView());
    this.loadingView.updateMessage('Starting VSCode server...');

    let view = await portal.ensureView(this, this.loadingView);
    this.setMainView(view);
    this.activePortalUuid = portal.uuid;

    this.notifyPortalsChanged();
  }

  /// Handles a toggle view message from the sidebar
  async handleToggleViewMessage(portalUuid) {
    this.log(`Toggle meta-view for portal ${portalUuid}`);

    const portal = this.portalWithUuid(portalUuid);
    if (!portal) {
      return { success: false, error: `Portal ${portalUuid} not found` };
    }

    portal.toggleView();
    return { success: true };
  }

  async createNewPortal(loadingView: ILoadingView | null = null) {
    const uuid = generateUUID();
    const name = `P${this.portals.length}`;

    // Create directory and clone project
    if (loadingView) loadingView.updateMessage(`Creating portal ${name}...`);
    const extensions = await this.createPortalDirectory(uuid, name, loadingView);

    // Create portal object with no server running yet
    const portal = new Portal(uuid, name, this.hostname, 0, this);
    portal.extensions = extensions; // Store extensions on portal
    this.portals.push(portal);

    this.notifyPortalsChanged();
    return portal;
  }

  async restoreSavedPortals(savedPortalData) {
    this.log(`Restoring previous session with ${savedPortalData.portals.length} existing portals`);

    // Check directory existence for each saved portal
    for (const savedPortalDatum of savedPortalData.portals) {
      this.log(`Checking portal ${savedPortalDatum.name}...`);

      // Check if portal clone directory still exists
      const portalPaths = new PortalPaths(savedPortalDatum.uuid);
      const portalCloneDir = `${BASE_DIR}/${portalPaths.cloneDir}`;
      try {
        await execSSHCommand(this.hostname, `test -d ${portalCloneDir}`);
        this.log(`✓ Portal ${savedPortalDatum.name}: Directory exists`);

        // Create portal object with saved port (server status unknown)
        const portal = new Portal(savedPortalDatum.uuid, savedPortalDatum.name, this.hostname, savedPortalDatum.port, this);
        this.portals.push(portal);
      } catch (error) {
        this.log(`✗ Portal ${savedPortalDatum.name}: Directory missing, removing from list`);
        // Portal directory is gone, don't restore it
      }
    }

    if (savedPortalData.activePortalUuid) {
      this.activePortalUuid = savedPortalData.activePortalUuid;
    }
  }

  /// Given a portal uuid + name, start the VSCode process and then connect to it.
  ///
  /// Instantiates a `Portal` object and adds it to `this.portals`.
  ///
  /// This portal may have been newly created or may have been loaded from disk
  /// and encountered a missing server.
  async createPortalDirectory(uuid: string, name: string, loadingView: ILoadingView | null = null) {
    this.log(`Creating directory and project for portal ${name} with uuid ${uuid}...`);

    // Test basic SSH connection first
    if (loadingView) loadingView.updateMessage(`Testing SSH connection for ${name}...`);
    this.log('Testing SSH connection...');
    await execSSHCommand(this.hostname, 'echo "SSH connection successful"');
    this.log('✓ SSH connection test successful');

    // Setup remote directory
    if (loadingView) loadingView.updateMessage(`Setting up remote directory for ${name}...`);
    await execSSHCommand(this.hostname, `mkdir -p ${BASE_DIR}/`);
    this.log('✓ Remote directory ready');

    // Clone project for this portal
    const extensions = await this.cloneProjectForPortal(uuid, name, loadingView);
    this.log(`✓ Project cloned for portal ${name}`);

    return extensions;
  }

  ///
  /// Instantiates a `Portal` object and adds it to `this.portals`.
  ///
  /// This portal may have been newly created or may have been loaded from disk
  /// and encountered a missing server.
  async finalizePortal(uuid: string, name: string) {
    this.log(`Setting up remote server for portal ${name} with uuid ${uuid}...`);

    // Detect architecture
    const archOutput = await execSSHCommand(this.hostname, 'uname -m');
    const arch = mapArchitecture(String(archOutput).toLowerCase());
    this.log(`✓ Detected architecture: ${archOutput} -> ${arch}`);

    // Install VSCode server
    await installVSCodeServer(this.hostname, arch);
    this.log('✓ VSCode server installation complete');

    // Start server with dynamic port selection
    const serverInfo = await this.startVSCodeServer(this.hostname, uuid, name);
    this.log(`✓ VSCode server ${name} ready on port ${serverInfo.port}`);

    const _forwardPid = this.forwardPort(serverInfo.port);
    this.log(`✓ Forwarding port ${serverInfo.port}`);

    const portal = new Portal(uuid, name, this.hostname, serverInfo.port, this);
    this.portals.push(portal);
    return portal;
  }

  async cloneProjectForPortal(uuid: string, name: string, loadingView: ILoadingView | null = null) {
    // For now, hardcode to theoldswitcheroo project
    const projectName = 'theoldswitcheroo';
    const projectDir = path.join(LOCAL_DATA_DIR, 'projects', projectName);
    const cloneScript = path.join(projectDir, 'fresh-clone.sh');
    const extensionsFile = path.join(projectDir, 'vscode-extensions.json');

    // Check if project definition exists
    if (!fs.existsSync(cloneScript)) {
      throw new Error(`Project definition not found: ${cloneScript}`);
    }

    // Read extensions if available
    let extensions = { marketplace: [], local: [] };
    if (fs.existsSync(extensionsFile)) {
      try {
        const extensionsData = JSON.parse(fs.readFileSync(extensionsFile, 'utf8'));
        extensions = {
          marketplace: extensionsData.extensions || [],
          local: extensionsData.local_extensions || []
        };
        const totalCount = extensions.marketplace.length + extensions.local.length;
        this.log(`Found ${totalCount} extensions to install for ${name}`);
      } catch (error) {
        this.log(`Warning: Could not parse vscode-extensions.json: ${error.message}`);
      }
    }

    // Remote target directory for this portal
    const portalPaths = new PortalPaths(uuid);
    const remoteTargetDir = `${BASE_DIR}/${portalPaths.cloneDir}`;

    // Create portal directory structure
    if (loadingView) loadingView.updateMessage(`Creating portal ${name} directory...`);
    await execSSHCommand(this.hostname, `mkdir -p ${BASE_DIR}/${portalPaths.dir}`);

    // Upload the clone script to portal directory
    if (loadingView) loadingView.updateMessage(`Uploading clone script for ${name}...`);
    const remoteScriptPath = `${BASE_DIR}/${portalPaths.freshClone}`;
    await execSCP(this.hostname, cloneScript, remoteScriptPath);
    await execSSHCommand(this.hostname, `chmod +x ${remoteScriptPath}`);

    // Run the clone script
    if (loadingView) loadingView.updateMessage(`Cloning project for portal ${name}...`);
    await execSSHCommand(this.hostname, `${remoteScriptPath} ${remoteTargetDir}`);

    return extensions;
  }

  // Load portals JSON from disk
  loadPortalData() {
    try {
      if (fs.existsSync(PORTALS_FILE)) {
        const data = fs.readFileSync(PORTALS_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('Failed to load sessions:', error.message);
    }
    return { hostname: null, sessions: [] };
  }

  // Save portal JSON to disk
  savePortalData() {
    try {
      const dir = path.dirname(PORTALS_FILE);
      fs.mkdirSync(dir, { recursive: true });

      const data = {
        hostname: this.hostname,
        activePortalUuid: this.activePortalUuid,
        portals: this.portals.map(s => ({
          uuid: s.uuid,
          name: s.name,
          port: s.port,
          serverDataDir: `${BASE_DIR}/${new PortalPaths(s.uuid).serverDataDir}`,
          lastSeen: new Date().toISOString()
        }))
      };

      fs.writeFileSync(PORTALS_FILE, JSON.stringify(data, null, 2));
      this.log(`Saved ${this.portals.length} portals to ${PORTALS_FILE}`);
    } catch (error) {
      console.error('Failed to save sessions:', error.message);
    }
  }

  /// Start a vscode server process for the given portal, connected to the given uuid, with the given name.
  async startVSCodeServer(hostname: string, portalUuid: string, portalName: string, extensions: Extensions = { marketplace: [], local: [] }): Promise<ServerInfo> {
    this.log(`Starting SSH with port forwarding for session ${portalName}...`);

    // Upload local extensions if any
    if (extensions.local && extensions.local.length > 0) {
      console.log(`Uploading custom extensions...`);
      for (const localExt of extensions.local) {
        const localPath = path.resolve(LOCAL_DATA_DIR, 'projects', 'theoldswitcheroo', localExt);
        const remotePath = `${BASE_DIR}/${path.basename(localExt)}`;
        console.log(`Uploading ${localPath} to ${remotePath}`);
        await execSCP(hostname, localPath, remotePath);
      }
    }

    return new Promise((resolve, reject) => {

      const dirs = new PortalPaths(portalUuid);

      // Build extension install commands
      const marketplaceCommands = extensions.marketplace?.length > 0
        ? extensions.marketplace.map(ext => `./openvscode-server/bin/openvscode-server --extensions-dir ${BASE_DIR}/${dirs.extensionsDir} --install-extension ${ext}`).join(' && ')
        : '';

      const localCommands = extensions.local?.length > 0
        ? extensions.local.map(ext => `./openvscode-server/bin/openvscode-server --extensions-dir ${BASE_DIR}/${dirs.extensionsDir} --install-extension ${BASE_DIR}/${path.basename(ext)}`).join(' && ')
        : '';

      const allExtensionCommands = [marketplaceCommands, localCommands].filter(cmd => cmd).join(' && ');

      // Simple server script with auto-shutdown and data directories
      const serverScript = `
        cd ${BASE_DIR}
        
        # Create session-specific directories
        mkdir -p ${dirs.serverDataDir}
        mkdir -p ${dirs.extensionsDir}
        mkdir -p vscode-user-data
        
        ${allExtensionCommands ? `# Install extensions\n        ${allExtensionCommands}\n        ` : ''}
        # Start VSCode with data directories and dynamic port, opening the cloned project
        ./openvscode-server/bin/openvscode-server \\
          --host 0.0.0.0 \\
          --port 0 \\
          --user-data-dir ${BASE_DIR}/vscode-user-data \\
          --server-data-dir ${BASE_DIR}/${dirs.serverDataDir} \\
          --extensions-dir ${BASE_DIR}/${dirs.extensionsDir} \\
          --without-connection-token \\
          --enable-remote-auto-shutdown \\
          --default-folder ${BASE_DIR}/${dirs.cloneDir} 2>&1
      `;

      console.log(serverScript);

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
        this.log(`[VSCode Server ${portalName}] ${output.trim()}`);

        // Look for VSCode's port announcement in its output
        // VSCode typically outputs: "Web UI available at http://localhost:XXXX"
        const portMatch = output.match(/Web UI available at.*:(\d+)/i) ||
          output.match(/localhost:(\d+)/) ||
          output.match(/127\.0\.0\.1:(\d+)/) ||
          output.match(/0\.0\.0\.0:(\d+)/);

        if (portMatch && !actualPort) {
          actualPort = parseInt(portMatch[1]);
          this.log(`✓ VSCode server ${portalName} ready on port ${actualPort}`);

          resolve({ serverProcess: ssh, port: actualPort });
        }
      });

      ssh.stderr.on('data', (data) => {
        const output = data.toString().trim();
        console.error(`[VSCode Server ${portalName} Error] ${output}`);
      });

      ssh.on('close', (code) => {
        this.log(`SSH process for session ${portalName} exited with code ${code}`);
      });

      ssh.on('error', (err) => {
        reject(new Error(`Failed to start SSH: ${err.message}`));
      });

      // Timeout if server doesn't start
      setTimeout(() => {
        if (!actualPort) {
          reject(new Error(`VSCode server startup timeout for session ${portalName}`));
        }
      }, 60000); // 60 second timeout
    });
  }

  // ForSet up port forwarding for the actual port
  forwardPort(port) {
    return spawn('ssh', [
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=~/.ssh/cm-${this.hostname}`,
      '-o', 'ControlPersist=10m',
      '-L', `${port}:localhost:${port}`,
      '-N',
      this.hostname
    ]);
  }


  // Update sidebar with current portals
  notifyPortalsChanged() {
    console.log(`Portals changed, activePortalUuid = ${this.activePortalUuid}`);
    this.savePortalData();
    const portalData = this.portals.map(portal => ({
      uuid: portal.uuid,
      name: portal.name,
      active: portal.uuid === this.activePortalUuid
    }));
    console.log(`Posting message to sidecar`, portalData);
    this.sidebarView.webContents.postMessage('update-portals', {
      portalData: portalData,
      activePortalUuid: this.activePortalUuid,
    });
  }

  // Function to update view bounds based on window size
  updateViewBounds() {
    const bounds = this.mainWindow.getBounds();
    const sidebarWidth = 75;

    this.sidebarView.setBounds({ x: 0, y: 0, width: sidebarWidth, height: bounds.height });

    // Update bounds for active session's view
    if (this.mainView) {
      this.mainView.setBounds({ x: sidebarWidth, y: 0, width: bounds.width - sidebarWidth, height: bounds.height });
    }
  }
}

/// A "Portal" is an active VSCode window.
class Portal {
  uuid: string;
  name: string;
  hostname: string;
  port: number;
  viewName: string;
  createdAt: Date;
  vscodeView: any = null;
  metaView: any = null;
  extensions?: Extensions;

  /// Create Portal with the given uuid/name running on the given host.
  ///
  /// If port is 0, then no port is assigned yet.
  ///
  /// If port is non-zero, then a previous port exists, though we have not yet
  /// verified that the vscode server is actually *running* on that port.
  /// That takes place in `ensureView`. If there is no server, the port
  /// will be reassigned to whatever the fresh server adopts.
  constructor(uuid: string, name: string, hostname: string, port: number = 0, switcheroo?: SwitcherooApp) {
    this.uuid = uuid;
    this.name = name;
    this.hostname = hostname;
    this.port = port;
    this.viewName = 'vscode'; // current view, vscode or meta
    this.createdAt = new Date();
    this.vscodeView = null; // Will be created when first accessed
    this.metaView = null; // Will be created when first accessed
  }

  get vscodeUrl() {
    // Always localhost due to port forwarding
    return `http://localhost:${this.port}`;
  }

  toggleView() {
    if (this.viewName == 'vscode') {
      this.viewName = 'meta';
    } else {
      this.viewName = 'vscode';
    }
  }

  /// Ensure that the current view exists, either vscode or meta.
  ///
  /// Lazilly starts up the vscode server etc.
  async ensureView(switcheroo: SwitcherooApp, loadingView: ILoadingView | null = null) {
    const vscodeSession = switcheroo.vscodeSession;
    console.log("ensureView", this.viewName, vscodeSession);

    if (this.viewName == 'vscode') {
      if (!this.vscodeView) {
        // Ensure VSCode server is running
        await switcheroo.ensureVSCodeServer(this);

        // Create WebContentsView for active session
        this.vscodeView = new WebContentsView({
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            session: vscodeSession,
            webSecurity: false, // Allow localhost connections
            allowRunningInsecureContent: true
          }
        });
        this.vscodeView.setBackgroundColor('#2d2d30');
        this.vscodeView.webContents.setUserAgent(STANDARD_USER_AGENT);

        // Wait for server to be ready before attempting to load the UI
        if (loadingView) loadingView.updateMessage('Waiting for VSCode server...');
        await waitForServer(this.vscodeUrl);

        // Load VSCode in the view
        if (loadingView) loadingView.updateMessage('Loading VSCode interface...');
        await this.vscodeView.webContents.loadURL(this.vscodeUrl);

        if (loadingView) loadingView.updateMessage('Ready!');
      }

      // Add views to the window
      return this.vscodeView;
    }

    if (!this.metaView) {
      this.metaView = new WebContentsView({
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          session: vscodeSession,
        }
      });
      this.metaView.setBackgroundColor('#1e1e1e');

      // Wait for meta-view to load before sending data
      await new Promise((resolve) => {
        this.metaView.webContents.once('did-finish-load', resolve);
        this.metaView.webContents.loadFile('meta-view.html');
      });
    }

    return this.metaView;
  }
}

class LoadingView implements ILoadingView {
  view: any;

  constructor() {
    this.view = new WebContentsView({
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    this.view.setBackgroundColor('#1e1e1e');
    this.view.webContents.loadFile(path.join(__dirname, 'loading.html'));
  }

  updateMessage(message: string): void {
    this.view.webContents.postMessage('loading-progress', message);
  }

  getView() {
    return this.view;
  }
}

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
    console.log("execSSHCommand: ", hostname, command);
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
      console.log("stdout: ", data);
      stdout += data.toString();
    });

    ssh.stderr.on('data', (data) => {
      console.log("stderr: ", data);
      stderr += data.toString();
    });

    ssh.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`SSH command '${command}' on ${hostname} failed (${code}): ${stderr}`));
      }
    });
  });
}

// Upload file using scp with ControlMaster
async function execSCP(hostname, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    console.log("execSCP: ", localPath, "->", `${hostname}:${remotePath}`);
    const scp = spawn('scp', [
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=~/.ssh/cm-${hostname}`,
      '-o', 'ControlPersist=10m',
      localPath,
      `${hostname}:${remotePath}`
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderr = '';

    scp.stderr.on('data', (data) => {
      console.log("scp stderr: ", data);
      stderr += data.toString();
    });

    scp.on('close', (code) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`SCP failed with code ${code}: ${stderr}`));
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
    cd ${BASE_DIR}
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

/// Check if the port is bound on the localhost
async function checkPortalHealth(hostname, port) {
  let resultCode = await execSSHCommand(hostname, `/usr/bin/curl -sL -w %{http_code} http://localhost:${port} -o /dev/null || true`);
  return (resultCode == '200');
}

// Wait for a URL to be accessible for up to `maxRetries` attempts
async function waitForServer(url, maxRetries = 10) {
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

      if ((response as any).statusCode === 200) {
        console.log('✓ Server is ready');
        return true;
      }
    } catch (error) {
      // Continue to retry
    }

    if (retries < maxRetries - 1) {
      const delay = Math.min(1000 * Math.pow(2, retries), 5000);
      console.log(`Server at ${url} not ready, retrying in ${delay}ms... (${retries + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error(`Server not ready after ${maxRetries} attempts`);
}

import { app, BaseWindow, WebContentsView, session, ipcMain, Session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { LOCAL_DATA_DIR, TASKSPACES_FILE, SETTINGS_FILE, BASE_DIR, loadSettings, saveSettings, Settings } from './settings.js';
import { sshManager } from './ssh-manager.js';
import { TaskSpaceCommunicationManager } from './taskspace-communication-manager.js';

// ES6 module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Type definitions
interface Extensions {
  marketplace: string[];
  local: string[];
}

interface ServerInfo {
  port: number;
  serverProcess?: ChildProcess;
}

interface ILoadingView {
  updateMessage(message: string): void;
  getView(): WebContentsView;
}

interface SavedTaskSpaceDatum {
  uuid: string;
  name: string;
  port: number;
  serverDataDir: string;
  lastSeen: string;
  extensions: Extensions;
}

interface SavedTaskSpaceData {
  hostname: string | null;
  activeTaskSpaceUuid?: string | null;
  taskspaces: SavedTaskSpaceDatum[];
}

// Generate UUID v4
function generateUUID(): string {
  return randomUUID();
}

class TaskSpacePaths {
  dir: string;
  cloneDir: string;
  serverDataDir: string;
  extensionsDir: string;
  freshClone: string;

  constructor(uuid: string) {
    this.dir = `taskspaces/${uuid}`;
    this.cloneDir = `taskspaces/${uuid}/clone`;
    this.serverDataDir = `taskspaces/taskspace-${uuid}/server-data`;
    this.extensionsDir = `taskspaces/taskspace-${uuid}/extensions`;
    this.freshClone = `taskspaces/${uuid}/fresh-clone.sh`;
  }
}

// Helper to read project extensions
function readProjectExtensions(): Extensions {
  const projectName = 'theoldswitcheroo';
  // Use the development directory, not the data directory
  const projectDir = path.join(LOCAL_DATA_DIR, 'projects', projectName);
  const extensionsFile = path.join(projectDir, 'vscode-extensions.json');

  console.log(`DEBUG: readProjectExtensions - extensionsFile: ${extensionsFile}`);
  console.log(`DEBUG: readProjectExtensions - file exists: ${fs.existsSync(extensionsFile)}`);

  // Always include the built-in theoldswitcheroo extension
  const builtinExtension = 'theoldswitcheroo-extension-0.0.1.vsix';
  let extensions: Extensions = {
    marketplace: [],
    local: [builtinExtension]
  };

  if (fs.existsSync(extensionsFile)) {
    try {
      const extensionsData = JSON.parse(fs.readFileSync(extensionsFile, 'utf8'));
      console.log(`DEBUG: readProjectExtensions - extensionsData:`, extensionsData);
      extensions.marketplace = extensionsData.extensions || [];
      extensions.local = [...extensions.local, ...(extensionsData.local_extensions || [])];
    } catch (error) {
      console.log(`Warning: Could not parse vscode-extensions.json: ${error.message}`);
    }
  }

  console.log(`DEBUG: readProjectExtensions - final extensions:`, extensions);
  return extensions;
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

  // Add cleanup for daemon processes
  app.on('before-quit', async () => {
    console.log('App quitting, cleaning up daemon processes...');
    // Stop all active daemons
    const activeHosts = ['hostname']; // We'd need to track this properly
    for (const hostname of activeHosts) {
      try {
        // Note: We can't easily access SwitcherooApp instance here
        // The SSH connections will close automatically
        console.log(`Daemon cleanup for ${hostname} will happen via SSH connection close`);
      } catch (error) {
        console.error(`Error cleaning up daemon for ${hostname}:`, error);
      }
    }
  });
} else {
  console.error('This script must be run with Electron or with --clean flag');
  process.exit(1);
}

class SwitcherooApp {
  taskspaces: TaskSpace[] = [];
  activeTaskSpaceUuid: string | null = null;
  hostname: string;
  loadingView: ILoadingView;
  errorView: ErrorView;
  vscodeSession: Session;
  mainWindow!: BaseWindow;
  sidebarView!: WebContentsView;
  mainView: WebContentsView | null = null;
  sidebarWidth: number = 250; // Track sidebar width
  taskspaceManager: TaskSpaceCommunicationManager; // Add taskspace communication manager

  constructor(hostname: string) {
    // Global session management
    this.taskspaces = [];
    this.activeTaskSpaceUuid = null;
    this.hostname = hostname;
    this.loadingView = new LoadingView();
    this.errorView = new ErrorView();

    // Initialize taskspace communication manager
    this.taskspaceManager = new TaskSpaceCommunicationManager(sshManager);

    // Set up taskspace request handlers
    this.taskspaceManager.setTaskSpaceRequestHandler(this.handleTaskSpaceRequest.bind(this));
    this.taskspaceManager.setStatusRequestHandler(this.handleStatusRequest.bind(this));

    // Create a persistent session for this hostname (shared across all sessions)
    // and initialize it for vscode compatibility.
    this.vscodeSession = session.fromPartition(`persist:vscode-${hostname}`);
    this.vscodeSession.setCodeCachePath(path.join(LOCAL_DATA_DIR, 'code-cache'));
    this.vscodeSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': 'default-src * \'unsafe-inline\' \'unsafe-eval\'; script-src * \'unsafe-inline\' \'unsafe-eval\'; connect-src * \'unsafe-inline\'; img-src * data: blob: \'unsafe-inline\'; frame-src *; style-src * \'unsafe-inline\';'
        }
      });
    });

    // Create the main window
    this.mainWindow = new BaseWindow({
      width: 1200,
      height: 800,
      minWidth: 300,
      minHeight: 400,
      resizable: true,
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
    ipcMain.handle('create-taskspace', async () => await this.handleCreateTaskSpace());
    ipcMain.handle('toggle-view', async (_event, taskspaceUuid) => await this.handleToggleViewMessage(taskspaceUuid));
    ipcMain.handle('switch-taskspace', async (_event, taskspaceUuid) => await this.handleSwitchTaskSpaceMessage(taskspaceUuid));
    ipcMain.handle('resize-sidebar', async (_event, newWidth) => await this.handleSidebarResize(newWidth));
    ipcMain.handle('toggle-devtools', async () => {
      this.sidebarView.webContents.toggleDevTools();
      return { success: true };
    });

    // Add daemon management handlers
    ipcMain.handle('setup-host', async (_event, hostname) => await this.handleSetupHost(hostname));
    ipcMain.handle('start-daemon', async (_event, hostname) => await this.handleStartDaemon(hostname));
    ipcMain.handle('stop-daemon', async (_event, hostname) => await this.handleStopDaemon(hostname));
    ipcMain.handle('get-daemon-status', (_event, hostname) => this.taskspaceManager.isRunning(hostname));
    ipcMain.handle('quit-app', () => {
      app.quit();
    });
  }

  async bootUp() {
    try {
      // Show main window immediately with loading view
      this.setMainView(this.loadingView.getView());
      this.mainWindow.show();

      // Add resize event listener to update view bounds
      this.mainWindow.on('resize', () => {
        this.updateViewBounds();
      });

      // Initialize the sidebar HTML and wait for it to load.
      this.loadingView.updateMessage('Loading interface...');
      this.sidebarView.webContents.loadFile(path.join(__dirname, '..', 'sidebar.html'));
      await new Promise<void>(resolve => {
        this.sidebarView.webContents.once('did-finish-load', () => resolve());
      });

      // Start daemon for this hostname
      this.loadingView.updateMessage('Starting communication daemon...');
      await this.taskspaceManager.deployDaemonFiles(this.hostname);
      await this.taskspaceManager.startDaemon(this.hostname);
      this.log('✓ Daemon started successfully');
      this.log('✓ CLI tool available in terminals as: theoldswitcheroo');

      // Load existing taskspaces
      this.loadingView.updateMessage('Checking for existing taskspaces...');
      this.log('Checking for existing taskspaces...');
      const savedTaskSpaceData = this.loadTaskSpaceData();

      // If there is savedData, restore it
      if (savedTaskSpaceData.hostname === this.hostname && savedTaskSpaceData.taskspaces.length > 0) {
        this.loadingView.updateMessage('Restoring saved taskspaces...');
        await this.restoreSavedTaskSpaces(savedTaskSpaceData);
        this.notifyTaskSpacesChanged();
      }

      // Make sure there is at least one taskspace
      if (this.taskspaces.length == 0) {
        this.loadingView.updateMessage('Creating initial taskspace...');
        this.log(`Creating initial taskspace`);
        const taskspace = await this.createNewTaskSpace(this.loadingView);
        this.log(`✓ TaskSpace ${taskspace.name}: Started on port ${taskspace.port}`);
      }

      // Make sure *some* taskspace is selected
      if (!this.activeTaskSpaceUuid || !this.taskspaceWithUuid(this.activeTaskSpaceUuid)) {
        this.activeTaskSpaceUuid = this.taskspaces[0].uuid;
      }

      // Select the active taskspace
      this.loadingView.updateMessage('Loading VSCode...');
      await this.switchTaskSpace(this.taskspaceWithUuid(this.activeTaskSpaceUuid));

    } catch (error) {
      this.log(`Error during startup: ${error instanceof Error ? error.message : error}`);

      // Show error view for any startup failure
      this.errorView.showError(
        'Startup Failed',
        'Something went wrong while initializing the application. Please check your configuration and try again.',
        error instanceof Error ? error.stack || error.message : String(error)
      );
      this.setMainView(this.errorView.getView());
    }
  }

  /// Replace the "main view" in our app with `view`
  /// and resize it to balance it with the sidebar (which is never removed).
  /// This will remove the existing main view, if any.
  setMainView(view: WebContentsView | null) {
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

  /// Create a vscode server for taskspace with uuid and (optionally) a previous port.
  async ensureVSCodeServer(taskspace) {
    // If taskspace already has a running server, check if it's still alive
    if (taskspace.port) {
      if (await checkTaskSpaceHealth(this.hostname, taskspace.port)) {
        this.log(`✓ TaskSpace ${taskspace.name}: Server still running on port ${taskspace.port}`);
        // Ensure port forwarding is active
        this.forwardPort(taskspace.port);
        return; // Server is good
      } else {
        this.log(`TaskSpace ${taskspace.name}: Server died, restarting...`);
      }
    }

    // Start fresh server
    this.log(`Starting VSCode server for taskspace ${taskspace.name}...`);

    // Detect architecture
    const archOutput = await execSSHCommand(this.hostname, 'uname -m');
    const arch = mapArchitecture(String(archOutput).toLowerCase());

    // Install VSCode server
    await installVSCodeServer(this.hostname, arch);

    // Start server
    const serverInfo = await this.startVSCodeServer(this.hostname, taskspace.uuid, taskspace.name, taskspace.extensions);

    // Update port on the taskspace
    taskspace.port = serverInfo.port;

    // Start port forwarding
    this.forwardPort(serverInfo.port);

    this.log(`✓ TaskSpace ${taskspace.name}: Server ready on port ${taskspace.port}`);
  }

  /// Log messages to console
  log(message) {
    console.log(message);
  }

  /// Handles a new session message from the sidebar
  async handleCreateTaskSpace() {
    console.log('+ button clicked! Creating new session...');

    try {
      const newTaskSpace = await this.createNewTaskSpace();
      console.log('newTaskSpace created', newTaskSpace);
      return {
        success: true,
        uuid: newTaskSpace.uuid,
        name: newTaskSpace.name,
        port: newTaskSpace.port
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  taskspaceWithUuid(taskspaceUuid): TaskSpace {
    return this.taskspaces.find(s => s.uuid === taskspaceUuid);
  }

  /// Handles a switch taskspace from the sidebar
  async handleSwitchTaskSpaceMessage(taskspaceUuid) {
    this.log(`Switching to taskspace ${taskspaceUuid}`);

    const taskspace = this.taskspaceWithUuid(taskspaceUuid);
    if (!taskspace) {
      return { success: false, error: `TaskSpace ${taskspaceUuid} not found` };
    }

    try {
      await this.switchTaskSpace(taskspace);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async switchTaskSpace(taskspace) {
    this.log(`switchTaskSpace ${taskspace}`);

    // Show loading view immediately
    this.setMainView(this.loadingView.getView());
    this.loadingView.updateMessage('Starting VSCode server...');

    let view = await taskspace.ensureView(this, this.loadingView);
    this.setMainView(view);
    this.activeTaskSpaceUuid = taskspace.uuid;

    this.notifyTaskSpacesChanged();
  }

  /// Handles sidebar resize from the sidebar
  async handleSidebarResize(newWidth: number) {
    // Clamp width between 250 and 500 pixels
    this.sidebarWidth = Math.max(250, Math.min(500, newWidth));
    this.updateViewBounds();
    return { success: true };
  }

  /// Handles daemon setup for a host
  async handleSetupHost(hostname: string) {
    try {
      // Deploy daemon files (includes CLI tool in bin directory)
      await this.taskspaceManager.deployDaemonFiles(hostname);

      // TODO: Deploy additional tools if needed
      // await this.taskspaceManager.deployAdditionalTools(hostname, [
      //   { localPath: '/path/to/other/tool', remoteName: 'tool-name' }
      // ]);

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /// Handles daemon start for a host
  async handleStartDaemon(hostname: string) {
    try {
      await this.taskspaceManager.startDaemon(hostname);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /// Handles daemon stop for a host
  async handleStopDaemon(hostname: string) {
    try {
      await this.taskspaceManager.stopDaemon(hostname);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /// Handle taskspace requests from CLI tools via daemon
  private handleTaskSpaceRequest(request: {
    type: 'new_taskspace' | 'update_taskspace';
    name?: string;
    description?: string;
    cwd?: string;
    uuid?: string;
    hostname: string;
  }): void {
    if (request.type === 'new_taskspace' && request.name) {
      // Create new taskspace using existing system
      this.createNewTaskSpaceFromCLI(request.name, request.description || '', request.cwd || '/tmp', request.hostname);
    } else if (request.type === 'update_taskspace' && request.uuid) {
      // Update existing taskspace
      this.updateTaskSpaceFromCLI(request.uuid, request.name, request.description);
    }
  }

  /// Handle status requests from CLI tools
  private handleStatusRequest(hostname: string) {
    return {
      taskspaces: this.taskspaces.map(taskspace => ({
        name: taskspace.name,
        status: taskspace.uuid === this.activeTaskSpaceUuid ? 'active' : 'inactive',
        uuid: taskspace.uuid
      })),
      activeTaskSpace: this.activeTaskSpaceUuid || undefined
    };
  }

  /// Create taskspace from CLI request
  private async createNewTaskSpaceFromCLI(name: string, description: string, cwd: string, hostname: string): Promise<void> {
    try {
      console.log(`Creating taskspace from CLI: ${name} on ${hostname}`);

      // Use existing taskspace creation logic but with CLI-provided details
      const taskspace = await this.createNewTaskSpace();

      // Update taskspace with CLI details
      taskspace.name = name;
      // Note: description and cwd would need to be added to TaskSpace class

      this.notifyTaskSpacesChanged();

      console.log(`✓ Created taskspace ${name} from CLI request`);
    } catch (error) {
      console.error(`Failed to create taskspace from CLI:`, error);
    }
  }

  /// Update taskspace from CLI request
  private updateTaskSpaceFromCLI(uuid: string, name?: string, description?: string): void {
    const taskspace = this.taskspaceWithUuid(uuid);
    if (taskspace) {
      if (name) taskspace.name = name;
      // Note: description would need to be added to TaskSpace class

      this.notifyTaskSpacesChanged();
      console.log(`✓ Updated taskspace ${uuid} from CLI request`);
    } else {
      console.warn(`TaskSpace ${uuid} not found for update`);
    }
  }

  /// Show error view with custom message
  showError(title: string, message: string, details?: string): void {
    this.errorView.showError(title, message, details);
    this.setMainView(this.errorView.getView());
  }

  /// Handles a toggle view message from the sidebar
  async handleToggleViewMessage(taskspaceUuid) {
    this.log(`Toggle meta-view for taskspace ${taskspaceUuid}`);

    const taskspace = this.taskspaceWithUuid(taskspaceUuid);
    if (!taskspace) {
      return { success: false, error: `TaskSpace ${taskspaceUuid} not found` };
    }

    taskspace.toggleView();
    return { success: true };
  }

  async createNewTaskSpace(loadingView: ILoadingView | null = null) {
    const uuid = generateUUID();
    const name = `P${this.taskspaces.length}`;

    // Create directory and clone project
    if (loadingView) loadingView.updateMessage(`Creating taskspace ${name}...`);
    const extensions = await this.createTaskSpaceDirectory(uuid, name, loadingView);

    // Create taskspace object with no server running yet
    const taskspace = new TaskSpace(uuid, name, this.hostname, 0, this, extensions);
    taskspace.extensions = extensions; // Store extensions on taskspace
    this.taskspaces.push(taskspace);

    this.notifyTaskSpacesChanged();
    return taskspace;
  }

  async restoreSavedTaskSpaces(savedTaskSpaceData: SavedTaskSpaceData) {
    this.log(`Restoring previous session with ${savedTaskSpaceData.taskspaces.length} existing taskspaces`);

    // Check directory existence for each saved taskspace
    for (const savedTaskSpaceDatum of savedTaskSpaceData.taskspaces) {
      this.log(`Checking taskspace ${savedTaskSpaceDatum.name}...`);

      // Check if taskspace clone directory still exists
      const taskspacePaths = new TaskSpacePaths(savedTaskSpaceDatum.uuid);
      const taskspaceCloneDir = `${BASE_DIR}/${taskspacePaths.cloneDir}`;
      try {
        await execSSHCommand(this.hostname, `test -d ${taskspaceCloneDir}`);
        this.log(`✓ TaskSpace ${savedTaskSpaceDatum.name}: Directory exists`);

        // Create taskspace object with saved port (server status unknown)
        const taskspace = new TaskSpace(savedTaskSpaceDatum.uuid, savedTaskSpaceDatum.name, this.hostname, savedTaskSpaceDatum.port, this, savedTaskSpaceDatum.extensions);
        this.taskspaces.push(taskspace);
      } catch (error) {
        this.log(`✗ TaskSpace ${savedTaskSpaceDatum.name}: Directory missing, removing from list`);
        // TaskSpace directory is gone, don't restore it
      }
    }

    if (savedTaskSpaceData.activeTaskSpaceUuid) {
      this.activeTaskSpaceUuid = savedTaskSpaceData.activeTaskSpaceUuid;
    }
  }

  /// Given a taskspace uuid + name, start the VSCode process and then connect to it.
  ///
  /// Instantiates a `TaskSpace` object and adds it to `this.taskspaces`.
  ///
  /// This taskspace may have been newly created or may have been loaded from disk
  /// and encountered a missing server.
  async createTaskSpaceDirectory(uuid: string, name: string, loadingView: ILoadingView | null = null): Promise<Extensions> {
    this.log(`Creating directory and project for taskspace ${name} with uuid ${uuid}...`);

    // Test basic SSH connection first
    if (loadingView) loadingView.updateMessage(`Testing SSH connection for ${name}...`);
    this.log('Testing SSH connection...');
    await execSSHCommand(this.hostname, 'echo "SSH connection successful"');
    this.log('✓ SSH connection test successful');

    // Setup remote directory
    if (loadingView) loadingView.updateMessage(`Setting up remote directory for ${name}...`);
    await execSSHCommand(this.hostname, `mkdir -p ${BASE_DIR}/`);
    this.log('✓ Remote directory ready');

    // Clone project for this taskspace
    const extensions = await this.cloneProjectForTaskSpace(uuid, name, loadingView);
    this.log(`✓ Project cloned for taskspace ${name}`);

    return extensions;
  }

  async cloneProjectForTaskSpace(uuid: string, name: string, loadingView: ILoadingView | null = null): Promise<Extensions> {
    // For now, hardcode to theoldswitcheroo project
    const projectName = 'theoldswitcheroo';
    const projectDir = path.join(LOCAL_DATA_DIR, 'projects', projectName);
    const cloneScript = path.join(projectDir, 'fresh-clone.sh');

    // Check if project definition exists
    if (!fs.existsSync(cloneScript)) {
      throw new Error(`Project definition not found: ${cloneScript}`);
    }

    // Read extensions using the helper that includes built-in extension
    const extensions = readProjectExtensions();
    const totalCount = extensions.marketplace.length + extensions.local.length;
    this.log(`Found ${totalCount} extensions to install for ${name}`);

    // Remote target directory for this taskspace
    const taskspacePaths = new TaskSpacePaths(uuid);
    const remoteTargetDir = `${BASE_DIR}/${taskspacePaths.cloneDir}`;

    // Create taskspace directory structure
    if (loadingView) loadingView.updateMessage(`Creating taskspace ${name} directory...`);
    await execSSHCommand(this.hostname, `mkdir -p ${BASE_DIR}/${taskspacePaths.dir}`);

    // Upload the clone script to taskspace directory
    if (loadingView) loadingView.updateMessage(`Uploading clone script for ${name}...`);
    const remoteScriptPath = `${BASE_DIR}/${taskspacePaths.freshClone}`;
    await execSCP(this.hostname, cloneScript, remoteScriptPath);
    await execSSHCommand(this.hostname, `chmod +x ${remoteScriptPath}`);

    // Run the clone script
    if (loadingView) loadingView.updateMessage(`Cloning project for taskspace ${name}...`);
    await execSSHCommand(this.hostname, `${remoteScriptPath} ${remoteTargetDir}`);

    return extensions;
  }

  // Load taskspaces JSON from disk
  loadTaskSpaceData(): SavedTaskSpaceData {
    try {
      if (fs.existsSync(TASKSPACES_FILE)) {
        const data = fs.readFileSync(TASKSPACES_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('Failed to load sessions:', error.message);
    }
    return { hostname: null, taskspaces: [] };
  }

  // Save taskspace JSON to disk
  saveTaskSpaceData() {
    try {
      const dir = path.dirname(TASKSPACES_FILE);
      fs.mkdirSync(dir, { recursive: true });

      const data = {
        hostname: this.hostname,
        activeTaskSpaceUuid: this.activeTaskSpaceUuid,
        taskspaces: this.taskspaces.map(s => ({
          uuid: s.uuid,
          name: s.name,
          port: s.port,
          serverDataDir: `${BASE_DIR}/${new TaskSpacePaths(s.uuid).serverDataDir}`,
          lastSeen: new Date().toISOString()
        }))
      };

      fs.writeFileSync(TASKSPACES_FILE, JSON.stringify(data, null, 2));
      this.log(`Saved ${this.taskspaces.length} taskspaces to ${TASKSPACES_FILE}`);
    } catch (error) {
      console.error('Failed to save sessions:', error.message);
    }
  }

  /// Start a vscode server process for the given taskspace, connected to the given uuid, with the given name.
  async startVSCodeServer(hostname: string, taskspaceUuid: string, taskspaceName: string, extensions: Extensions = { marketplace: [], local: [] }): Promise<ServerInfo> {
    this.log(`Starting SSH with port forwarding for session ${taskspaceName}...`);

    // Upload local extensions if any
    if (extensions.local && extensions.local.length > 0) {
      console.log(`Uploading custom extensions...`);
      for (const localExt of extensions.local) {
        const localPath = path.resolve(__dirname, localExt);
        const remotePath = `${BASE_DIR}/${path.basename(localExt)}`;
        console.log(`Uploading ${localPath} to ${remotePath}`);
        await execSCP(hostname, localPath, remotePath);
      }
    }

    return new Promise((resolve, reject) => {

      const dirs = new TaskSpacePaths(taskspaceUuid);

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
          --disable-workspace-trust \\
          --default-folder ${BASE_DIR}/${dirs.cloneDir} 2>&1
      `;

      console.log(serverScript);

      // Get the SSH process for streaming
      sshManager.executeStreamingCommand(hostname, serverScript).then(ssh => {
        let actualPort = null;

        ssh.stdout.on('data', (data) => {
          const output = data.toString();
          this.log(`[VSCode Server ${taskspaceName}] ${output.trim()}`);

          // Look for VSCode's port announcement in its output
          // VSCode typically outputs: "Web UI available at http://localhost:XXXX"
          const portMatch = output.match(/Web UI available at.*:(\d+)/i) ||
            output.match(/localhost:(\d+)/) ||
            output.match(/127\.0\.0\.1:(\d+)/) ||
            output.match(/0\.0\.0\.0:(\d+)/);

          if (portMatch && !actualPort) {
            actualPort = parseInt(portMatch[1]);
            this.log(`✓ VSCode server ${taskspaceName} ready on port ${actualPort}`);

            resolve({ serverProcess: ssh, port: actualPort });
          }
        });

        ssh.stderr.on('data', (data) => {
          const output = data.toString().trim();
          console.error(`[VSCode Server ${taskspaceName} Error] ${output}`);
        });

        ssh.on('close', (code) => {
          this.log(`SSH process for session ${taskspaceName} exited with code ${code}`);
        });

        ssh.on('error', (err) => {
          reject(new Error(`Failed to start SSH: ${err.message}`));
        });

        // Timeout if server doesn't start
        setTimeout(() => {
          if (!actualPort) {
            reject(new Error(`VSCode server startup timeout for session ${taskspaceName}`));
          }
        }, 60000); // 60 second timeout
      }).catch(reject);
    });
  }

  // Set up port forwarding for the actual port
  forwardPort(port: number) {
    return sshManager.createTunnel(this.hostname, port, port);
  }


  // Update sidebar with current taskspaces
  notifyTaskSpacesChanged() {
    console.log(`TaskSpaces changed, activeTaskSpaceUuid = ${this.activeTaskSpaceUuid}`);
    this.saveTaskSpaceData();
    const taskspaceData = this.taskspaces.map(taskspace => ({
      uuid: taskspace.uuid,
      name: taskspace.name,
      active: taskspace.uuid === this.activeTaskSpaceUuid
    }));
    console.log(`Posting message to sidecar`, taskspaceData);
    this.sidebarView.webContents.postMessage('update-taskspaces', {
      taskspaceData: taskspaceData,
      activeTaskSpaceUuid: this.activeTaskSpaceUuid,
    });
  }

  // Function to update view bounds based on window size
  updateViewBounds() {
    const bounds = this.mainWindow.getBounds();

    this.sidebarView.setBounds({ x: 0, y: 0, width: this.sidebarWidth, height: bounds.height });

    // Update bounds for active session's view
    if (this.mainView) {
      this.mainView.setBounds({ x: this.sidebarWidth, y: 0, width: bounds.width - this.sidebarWidth, height: bounds.height });
    }
  }
}

/// A "TaskSpace" is an active VSCode window.
class TaskSpace {
  uuid: string;
  name: string;
  hostname: string;
  port: number;
  viewName: string;
  createdAt: Date;
  vscodeView: WebContentsView | null = null;
  metaView: WebContentsView | null = null;
  extensions!: Extensions;

  /// Create TaskSpace with the given uuid/name running on the given host.
  ///
  /// If port is 0, then no port is assigned yet.
  ///
  /// If port is non-zero, then a previous port exists, though we have not yet
  /// verified that the vscode server is actually *running* on that port.
  /// That takes place in `ensureView`. If there is no server, the port
  /// will be reassigned to whatever the fresh server adopts.
  constructor(uuid: string, name: string, hostname: string, port: number = 0, switcheroo: SwitcherooApp, extensions: Extensions) {
    this.uuid = uuid;
    this.name = name;
    this.hostname = hostname;
    this.port = port;
    this.viewName = 'vscode'; // current view, vscode or meta
    this.createdAt = new Date();
    this.vscodeView = null; // Will be created when first accessed
    this.metaView = null; // Will be created when first accessed
    this.extensions = extensions;
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
      await new Promise<void>((resolve) => {
        this.metaView!.webContents.once('did-finish-load', () => resolve());
        this.metaView!.webContents.loadFile(path.join(__dirname, '..', 'meta-view.html'));
      });
    }

    return this.metaView;
  }
}

class ErrorView implements ILoadingView {
  view: WebContentsView;

  constructor() {
    this.view = new WebContentsView({
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    this.view.setBackgroundColor('#1e1e1e');
    this.view.webContents.loadFile(path.join(__dirname, '..', 'error-view.html'));
  }

  updateMessage(message: string): void {
    this.view.webContents.postMessage('error-details', {
      type: 'error-details',
      message: message
    });
  }

  showError(title: string, message: string, details?: string): void {
    this.view.webContents.postMessage('error-details', {
      type: 'error-details',
      title,
      message,
      details
    });
  }

  getView() {
    return this.view;
  }
}

class LoadingView implements ILoadingView {
  view: WebContentsView;

  constructor() {
    this.view = new WebContentsView({
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    this.view.setBackgroundColor('#1e1e1e');
    this.view.webContents.loadFile(path.join(__dirname, '..', 'loading.html'));
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
  const settings = loadSettings();
  if (settings.hostname) {
    return settings.hostname;
  }

  console.error('No hostname configured in settings.');
  console.error('Create ~/.socratic-shell/theoldswitcheroo/settings.json with {"hostname": "your-host"}');
  app.quit();
  process.exit(1);
}

// Execute SSH command using SSH manager with ControlMaster
async function execSSHCommand(hostname: string, command: string): Promise<string> {
  return sshManager.executeCommand(hostname, command);
}

// Upload file using scp with ControlMaster
// Upload file using SSH manager with ControlMaster
async function execSCP(hostname: string, localPath: string, remotePath: string): Promise<void> {
  return sshManager.uploadFile(hostname, localPath, remotePath);
}

// Map architecture output to VSCode server architecture
function mapArchitecture(arch: string): string {
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
async function installVSCodeServer(hostname: string, arch: string): Promise<void> {
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
async function checkTaskSpaceHealth(hostname: string, port: number): Promise<boolean> {
  let resultCode = await execSSHCommand(hostname, `/usr/bin/curl -sL -w %{http_code} http://localhost:${port} -o /dev/null || true`);
  return (resultCode == '200');
}

// Wait for a URL to be accessible for up to `maxRetries` attempts
async function waitForServer(url: string, maxRetries: number = 10): Promise<boolean> {
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

#!/usr/bin/env node

import { Command } from 'commander';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Helper function to extract UUID from current working directory path
function extractUuidFromPath(cwd: string): string | null {
  // Look for UUID pattern in the path (e.g., /path/to/taskspaces/uuid-here/clone)
  const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const match = cwd.match(uuidRegex);
  return match ? match[0] : null;
}

interface TaskSpaceMessage {
  type: string;
  timestamp: string;
  [key: string]: any;
}

class TaskSpaceCLI {
  private socketPath: string;

  constructor() {
    // Default socket path - can be overridden by environment
    const baseDir = process.env.BASE_DIR || path.join(os.homedir(), '.socratic-shell', 'theoldswitcheroo');
    this.socketPath = process.env.THEOLDSWITCHEROO_SOCKET || path.join(baseDir, 'daemon.sock');
  }

  private async sendMessage(message: TaskSpaceMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      // Check if socket exists
      if (!fs.existsSync(this.socketPath)) {
        reject(new Error('No active theoldswitcheroo instance found. Is the daemon running?'));
        return;
      }

      const client = net.createConnection(this.socketPath);
      let responseReceived = false;

      client.on('connect', () => {
        const messageStr = JSON.stringify(message);
        client.write(messageStr);
        client.end();
      });

      client.on('close', () => {
        if (!responseReceived) {
          responseReceived = true;
          resolve();
        }
      });

      client.on('error', (error) => {
        if (!responseReceived) {
          responseReceived = true;
          reject(new Error(`Failed to connect to daemon: ${error.message}`));
        }
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        if (!responseReceived) {
          responseReceived = true;
          client.destroy();
          reject(new Error('Timeout waiting for daemon response'));
        }
      }, 5000);
    });
  }

  async newTaskSpace(name: string, options: { description?: string; cwd?: string }): Promise<void> {
    const message: TaskSpaceMessage = {
      type: 'new_taskspace_request',
      name,
      description: options.description || '',
      cwd: options.cwd || process.cwd(),
      timestamp: new Date().toISOString()
    };

    try {
      await this.sendMessage(message);
      console.log(`✓ TaskSpace creation request sent: "${name}"`);
    } catch (error) {
      console.error(`✗ Failed to create taskspace: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  }

  async updateTaskSpace(uuid: string, options: { description?: string; name?: string }): Promise<void> {
    if (!options.description && !options.name) {
      console.error('✗ Must specify --description or --name to update');
      process.exit(1);
    }

    const message: TaskSpaceMessage = {
      type: 'update_taskspace',
      uuid,
      timestamp: new Date().toISOString(),
      ...(options.description && { description: options.description }),
      ...(options.name && { name: options.name })
    };

    try {
      await this.sendMessage(message);
      console.log(`✓ TaskSpace update request sent for: ${uuid}`);
    } catch (error) {
      console.error(`✗ Failed to update taskspace: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  }

  async status(): Promise<void> {
    const message: TaskSpaceMessage = {
      type: 'status_request',
      timestamp: new Date().toISOString()
    };

    try {
      await this.sendMessage(message);
      console.log('✓ Status request sent');
    } catch (error) {
      console.error(`✗ Failed to get status: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  }
}

async function main(): Promise<void> {
  const program = new Command();
  const cli = new TaskSpaceCLI();

  program
    .name('theoldswitcheroo')
    .description('Manage VSCode taskspaces from the command line')
    .version('1.0.0');

  program
    .command('new-taskspace')
    .description('Create a new VSCode taskspace')
    .requiredOption('-n, --name <name>', 'TaskSpace name')
    .option('-d, --description <description>', 'TaskSpace description')
    .option('-c, --cwd <directory>', 'Working directory for the taskspace', process.cwd())
    .action(async (options) => {
      await cli.newTaskSpace(options.name, {
        description: options.description,
        cwd: options.cwd
      });
    });

  program
    .command('update-taskspace')
    .description('Update an existing taskspace (uses UUID from current directory)')
    .option('-d, --description <description>', 'New description')
    .option('-n, --name <name>', 'New name')
    .action(async (options) => {
      // Extract UUID from current working directory
      const cwd = process.cwd();
      const uuid = extractUuidFromPath(cwd);
      
      if (!uuid) {
        console.error('✗ Could not determine taskspace UUID from current directory');
        console.error('  Make sure you are running this command from within a taskspace directory');
        process.exit(1);
      }
      
      await cli.updateTaskSpace(uuid, {
        description: options.description,
        name: options.name
      });
    });

  program
    .command('status')
    .description('Get daemon and taskspace status')
    .action(async () => {
      await cli.status();
    });

  // Show help if no command provided
  if (process.argv.length <= 2) {
    program.help();
  }

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error('CLI Error:', error);
  process.exit(1);
});

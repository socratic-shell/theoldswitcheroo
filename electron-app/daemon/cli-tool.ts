#!/usr/bin/env node

import { Command } from 'commander';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface PortalMessage {
  type: string;
  timestamp: string;
  [key: string]: any;
}

class PortalCLI {
  private socketPath: string;

  constructor() {
    // Default socket path - can be overridden by environment
    const baseDir = process.env.BASE_DIR || path.join(os.homedir(), '.socratic-shell', 'theoldswitcheroo');
    this.socketPath = process.env.THEOLDSWITCHEROO_SOCKET || path.join(baseDir, 'daemon.sock');
  }

  private async sendMessage(message: PortalMessage): Promise<void> {
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

  async newPortal(name: string, options: { description?: string; cwd?: string }): Promise<void> {
    const message: PortalMessage = {
      type: 'new_portal_request',
      name,
      description: options.description || '',
      cwd: options.cwd || process.cwd(),
      timestamp: new Date().toISOString()
    };

    try {
      await this.sendMessage(message);
      console.log(`✓ Portal creation request sent: "${name}"`);
    } catch (error) {
      console.error(`✗ Failed to create portal: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  }

  async updatePortal(uuid: string, options: { description?: string; name?: string }): Promise<void> {
    if (!options.description && !options.name) {
      console.error('✗ Must specify --description or --name to update');
      process.exit(1);
    }

    const message: PortalMessage = {
      type: 'update_portal',
      uuid,
      timestamp: new Date().toISOString(),
      ...(options.description && { description: options.description }),
      ...(options.name && { name: options.name })
    };

    try {
      await this.sendMessage(message);
      console.log(`✓ Portal update request sent for: ${uuid}`);
    } catch (error) {
      console.error(`✗ Failed to update portal: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  }

  async status(): Promise<void> {
    const message: PortalMessage = {
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
  const cli = new PortalCLI();

  program
    .name('theoldswitcheroo')
    .description('Manage VSCode portals from the command line')
    .version('1.0.0');

  program
    .command('new-portal')
    .description('Create a new VSCode portal')
    .requiredOption('-n, --name <name>', 'Portal name')
    .option('-d, --description <description>', 'Portal description')
    .option('-c, --cwd <directory>', 'Working directory for the portal', process.cwd())
    .action(async (options) => {
      await cli.newPortal(options.name, {
        description: options.description,
        cwd: options.cwd
      });
    });

  program
    .command('update-portal')
    .description('Update an existing portal')
    .requiredOption('-u, --uuid <uuid>', 'Portal UUID')
    .option('-d, --description <description>', 'New description')
    .option('-n, --name <name>', 'New name')
    .action(async (options) => {
      await cli.updatePortal(options.uuid, {
        description: options.description,
        name: options.name
      });
    });

  program
    .command('status')
    .description('Get daemon and portal status')
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

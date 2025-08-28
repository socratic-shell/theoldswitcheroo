#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface TaskSpaceMessage {
  type: string;
  timestamp: string;
  [key: string]: any;
}

class TaskSpaceMCPServer {
  private server: Server;
  private socketPath: string;

  constructor() {
    this.server = new Server(
      {
        name: 'theoldswitcheroo-taskspace',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Default socket path - matches daemon configuration
    const baseDir = process.env.BASE_DIR || path.join(os.homedir(), '.socratic-shell', 'theoldswitcheroo');
    this.socketPath = process.env.THEOLDSWITCHEROO_SOCKET || path.join(baseDir, 'daemon.sock');

    this.setupToolHandlers();
  }

  private setupToolHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'new_taskspace',
            description: 'Create a new taskspace for focused development work',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Name for the taskspace',
                },
                short_description: {
                  type: 'string',
                  description: 'Brief description of the work to be done',
                },
                initial_prompt: {
                  type: 'string',
                  description: 'Initial prompt or context for the taskspace',
                },
              },
              required: ['name', 'short_description', 'initial_prompt'],
            },
          },
          {
            name: 'log_progress',
            description: 'Log progress on the current task with visual indicators',
            inputSchema: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: 'Progress message to log',
                },
                category: {
                  type: 'string',
                  enum: ['info', 'warn', 'error', 'milestone', 'question'],
                  description: 'Category of progress: info (ℹ️), warn (⚠️), error (❌), milestone (✅), question (❓)',
                },
              },
              required: ['message', 'category'],
            },
          },
          {
            name: 'signal_user',
            description: 'Signal the user for help or attention',
            inputSchema: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: 'Message requesting user help or attention',
                },
              },
              required: ['message'],
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'new_taskspace':
            return await this.handleNewTaskSpace(args as {
              name: string;
              short_description: string;
              initial_prompt: string;
            });

          case 'log_progress':
            return await this.handleLogProgress(args as {
              message: string;
              category: 'info' | 'warn' | 'error' | 'milestone' | 'question';
            });

          case 'signal_user':
            return await this.handleSignalUser(args as {
              message: string;
            });

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async handleNewTaskSpace(args: {
    name: string;
    short_description: string;
    initial_prompt: string;
  }) {
    const message: TaskSpaceMessage = {
      type: 'new_taskspace_request',
      name: args.name,
      description: args.short_description,
      initial_prompt: args.initial_prompt,
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
    };

    await this.sendMessage(message);

    return {
      content: [
        {
          type: 'text',
          text: `✓ TaskSpace creation request sent: "${args.name}"\nDescription: ${args.short_description}`,
        },
      ],
    };
  }

  private async handleLogProgress(args: {
    message: string;
    category: 'info' | 'warn' | 'error' | 'milestone' | 'question';
  }) {
    const message: TaskSpaceMessage = {
      type: 'progress_log',
      message: args.message,
      category: args.category,
      timestamp: new Date().toISOString(),
    };

    await this.sendMessage(message);

    const emoji = { info: 'ℹ️', warn: '⚠️', error: '❌', milestone: '✅', question: '❓' }[args.category];

    return {
      content: [
        {
          type: 'text',
          text: `✓ Progress logged: ${emoji} ${args.message}`,
        },
      ],
    };
  }

  private async handleSignalUser(args: { message: string }) {
    const message: TaskSpaceMessage = {
      type: 'user_signal',
      message: args.message,
      timestamp: new Date().toISOString(),
    };

    await this.sendMessage(message);

    return {
      content: [
        {
          type: 'text',
          text: `✓ User signal sent: "${args.message}"`,
        },
      ],
    };
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

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('TaskSpace MCP server running on stdio');
  }
}

// Main execution
async function main() {
  const server = new TaskSpaceMCPServer();
  await server.run();
}

main().catch((error) => {
  console.error('MCP Server error:', error);
  process.exit(1);
});

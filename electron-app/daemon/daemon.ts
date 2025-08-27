#!/usr/bin/env node

import * as net from 'net';
import * as fs from 'fs';
import * as readline from 'readline';

interface PortalMessage {
  type: string;
  [key: string]: any;
}

class PortalDaemon {
  private server: net.Server;
  private clients = new Set<net.Socket>();
  private socketPath: string;
  private stdinReader: readline.Interface;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
    this.server = net.createServer(this.handleClient.bind(this));
    this.stdinReader = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });
    
    this.setupStdinHandling();
    this.setupShutdownHandlers();
  }

  private handleClient(socket: net.Socket): void {
    console.log('Client connected to daemon');
    this.clients.add(socket);

    socket.on('data', (data: Buffer) => {
      try {
        const message = data.toString().trim();
        if (message) {
          // Forward message to Electron via stdout
          process.stdout.write(message + '\n');
          console.log('Forwarded to Electron:', message);
        }
      } catch (error) {
        console.error('Error processing client message:', error);
      }
    });

    socket.on('close', () => {
      console.log('Client disconnected');
      this.clients.delete(socket);
    });

    socket.on('error', (error) => {
      console.error('Client socket error:', error);
      this.clients.delete(socket);
    });
  }

  private setupStdinHandling(): void {
    // Receive messages from Electron via stdin
    this.stdinReader.on('line', (line: string) => {
      try {
        const message = line.trim();
        if (message) {
          console.log('Received from Electron:', message);
          
          // Broadcast to all connected clients
          for (const client of this.clients) {
            client.write(message + '\n');
          }
        }
      } catch (error) {
        console.error('Error processing stdin message:', error);
      }
    });
  }

  private setupShutdownHandlers(): void {
    const cleanup = () => {
      console.log('Shutting down daemon...');
      
      // Close all client connections
      for (const client of this.clients) {
        client.end();
      }
      
      // Close server
      this.server.close();
      
      // Remove socket file
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }
      
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('exit', cleanup);
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Clean up any existing socket
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }

      this.server.listen(this.socketPath, () => {
        console.log(`Portal daemon listening on ${this.socketPath}`);
        
        // Set socket permissions (owner only)
        fs.chmodSync(this.socketPath, 0o600);
        
        resolve();
      });

      this.server.on('error', (error) => {
        console.error('Server error:', error);
        reject(error);
      });
    });
  }
}

// Parse command line arguments
function parseArgs(): { socketPath: string } {
  const args = process.argv.slice(2);
  const socketPathIndex = args.indexOf('--socket-path');
  
  if (socketPathIndex === -1 || socketPathIndex === args.length - 1) {
    console.error('Usage: daemon --socket-path <path>');
    process.exit(1);
  }
  
  return {
    socketPath: args[socketPathIndex + 1]
  };
}

// Main execution
async function main(): Promise<void> {
  try {
    const { socketPath } = parseArgs();
    const daemon = new PortalDaemon(socketPath);
    await daemon.start();
    
    console.log('Portal daemon started successfully');
  } catch (error) {
    console.error('Failed to start daemon:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

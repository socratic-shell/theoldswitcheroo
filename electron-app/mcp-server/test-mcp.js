#!/usr/bin/env node

// Simple test script to verify MCP server works
import { spawn } from 'child_process';

const mcpServer = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

mcpServer.stderr.on('data', (data) => {
  console.log('MCP Server:', data.toString());
});

mcpServer.stdout.on('data', (data) => {
  console.log('MCP Response:', data.toString());
});

// Test list tools
const listToolsRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/list',
  params: {}
};

console.log('Sending list tools request...');
mcpServer.stdin.write(JSON.stringify(listToolsRequest) + '\n');

// Wait a bit then exit
setTimeout(() => {
  mcpServer.kill();
  process.exit(0);
}, 2000);

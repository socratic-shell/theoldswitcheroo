#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

function usage() {
  console.log('Usage: npm run install-mcp-server <host> <path>');
  console.log('');
  console.log('Examples:');
  console.log('  npm run install-mcp-server myserver.com /usr/local/bin/theoldswitcheroo-mcp');
  console.log('  npm run install-mcp-server user@host.com ~/bin/theoldswitcheroo-mcp');
  console.log('');
  console.log('This will:');
  console.log('1. Bundle the MCP server into a standalone executable');
  console.log('2. Copy it to the specified path on the remote host via scp');
  console.log('3. Make it executable on the remote host');
  process.exit(1);
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`Running: ${command} ${args.join(' ')}`);
    const proc = spawn(command, args, { stdio: 'inherit', ...options });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });
    
    proc.on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 2) {
    usage();
  }
  
  const [host, remotePath] = args;
  
  console.log(`Installing MCP server to ${host}:${remotePath}`);
  
  try {
    // 1. Bundle the MCP server
    console.log('\n📦 Bundling MCP server...');
    await runCommand('npm', ['run', 'bundle']);
    
    // 2. Determine which executable to use based on host OS
    // For now, assume Linux (most common for servers)
    // TODO: Could detect OS via ssh uname command
    const executableName = 'bundle-linux';
    const localExecutable = path.join(__dirname, '..', 'bin', executableName);
    
    // 3. Build the executable if it doesn't exist
    console.log('\n🔨 Building standalone executable...');
    await runCommand('npm', ['run', 'package']);
    
    // 4. Copy to remote host
    console.log(`\n🚀 Copying to ${host}:${remotePath}...`);
    await runCommand('scp', [localExecutable, `${host}:${remotePath}`]);
    
    // 5. Make executable on remote host
    console.log('\n✅ Making executable on remote host...');
    await runCommand('ssh', [host, `chmod +x ${remotePath}`]);
    
    console.log(`\n🎉 Successfully installed MCP server to ${host}:${remotePath}`);
    console.log('\nTo use it, add to your MCP client configuration:');
    console.log(`{`);
    console.log(`  "mcpServers": {`);
    console.log(`    "theoldswitcheroo": {`);
    console.log(`      "command": "${remotePath}",`);
    console.log(`      "env": {`);
    console.log(`        "THEOLDSWITCHEROO_SOCKET": "/path/to/daemon.sock"`);
    console.log(`      }`);
    console.log(`    }`);
    console.log(`  }`);
    console.log(`}`);
    
  } catch (error) {
    console.error('\n❌ Installation failed:', error.message);
    process.exit(1);
  }
}

main();

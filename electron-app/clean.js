#!/usr/bin/env node

import { spawn } from 'child_process';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const hostname = process.argv[2];
if (!hostname) {
  console.error('Usage: node clean.js <hostname>');
  process.exit(1);
}

console.log(`Cleaning ~/.socratic-shell/theoldswitcheroo on ${hostname}...`);

const ssh = spawn('ssh', [hostname, 'rm -rf ~/.socratic-shell/theoldswitcheroo'], {
  stdio: 'inherit'
});

ssh.on('close', async (code) => {
  if (code === 0) {
    console.log(`Successfully cleaned ${hostname}`);
    
    // Also delete local portals.json
    const portalsFile = join(homedir(), '.socratic-shell', 'theoldswitcheroo', 'portals.json');
    try {
      await unlink(portalsFile);
      console.log('Deleted local portals.json');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.log(`Warning: Could not delete local portals.json: ${error.message}`);
      }
    }
  } else {
    console.error(`Failed to clean ${hostname} (exit code: ${code})`);
  }
  process.exit(code);
});

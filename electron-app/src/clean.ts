#!/usr/bin/env node

import { spawn } from 'child_process';
import { unlink } from 'fs/promises';
import { loadSettings, TASKSPACES_FILE } from './settings.js';

const hostname = process.argv[2];

// If no hostname provided, try to load from settings
let targetHostname = hostname;
if (!targetHostname) {
  const settings = loadSettings();
  if (settings.hostname) {
    targetHostname = settings.hostname;
  } else {
    console.error('No hostname provided and no hostname configured in settings.');
    console.error('Usage: node clean.js [hostname]');
    console.error('Or configure hostname in ~/.socratic-shell/theoldswitcheroo/settings.json');
    process.exit(1);
  }
}

console.log(`Cleaning ~/.socratic-shell/theoldswitcheroo on ${targetHostname}...`);

const ssh = spawn('ssh', [targetHostname, 'rm -rf ~/.socratic-shell/theoldswitcheroo'], {
  stdio: 'inherit'
});

ssh.on('close', async (code) => {
  if (code === 0) {
    console.log(`Successfully cleaned ${targetHostname}`);
    
    // Also delete local taskspaces.json
    try {
      await unlink(TASKSPACES_FILE);
      console.log('Deleted local taskspaces.json');
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.log(`Warning: Could not delete local taskspaces.json: ${error.message}`);
      }
    }
  } else {
    console.error(`Failed to clean ${targetHostname} (exit code: ${code})`);
  }
  process.exit(code || 0);
});

#!/usr/bin/env node

import { spawn } from 'child_process';

const hostname = process.argv[2];
if (!hostname) {
  console.error('Usage: node clean.js <hostname>');
  process.exit(1);
}

console.log(`Cleaning ~/.socratic-shell/theoldswitcheroo on ${hostname}...`);

const ssh = spawn('ssh', [hostname, 'rm -rf ~/.socratic-shell/theoldswitcheroo'], {
  stdio: 'inherit'
});

ssh.on('close', (code) => {
  if (code === 0) {
    console.log(`Successfully cleaned ${hostname}`);
  } else {
    console.error(`Failed to clean ${hostname} (exit code: ${code})`);
  }
  process.exit(code);
});

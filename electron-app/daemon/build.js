const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

async function build() {
  // Ensure dist directory exists
  const distDir = path.join(__dirname, '..', 'dist');
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  console.log('Building daemon and CLI tools...');

  try {
    // Bundle daemon
    await esbuild.build({
      entryPoints: ['daemon.ts'],
      bundle: true,
      platform: 'node',
      target: 'node18',
      outfile: '../dist/daemon-bundled.cjs',
      external: [], // Bundle all dependencies
      format: 'cjs'
    });
    
    // Add shebang to daemon
    const daemonPath = path.join(distDir, 'daemon-bundled.cjs');
    let daemonContent = fs.readFileSync(daemonPath, 'utf8');
    daemonContent = daemonContent.replace(/^#!.*\n/, ''); // Remove existing shebang
    fs.writeFileSync(daemonPath, '#!/usr/bin/env node\n' + daemonContent);
    
    console.log('✓ Built daemon-bundled.cjs');

    // Bundle CLI tool
    await esbuild.build({
      entryPoints: ['cli-tool.ts'],
      bundle: true,
      platform: 'node',
      target: 'node18',
      outfile: '../dist/theoldswitcheroo-bundled.cjs',
      external: [], // Bundle all dependencies
      format: 'cjs'
    });
    
    // Add shebang to CLI tool
    const cliPath = path.join(distDir, 'theoldswitcheroo-bundled.cjs');
    let cliContent = fs.readFileSync(cliPath, 'utf8');
    cliContent = cliContent.replace(/^#!.*\n/, ''); // Remove existing shebang
    fs.writeFileSync(cliPath, '#!/usr/bin/env node\n' + cliContent);
    
    console.log('✓ Built theoldswitcheroo-bundled.cjs');

    // Make bundled files executable
    fs.chmodSync(daemonPath, 0o755);
    fs.chmodSync(cliPath, 0o755);
    console.log('✓ Made files executable');

  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build().catch(console.error);

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
      entryPoints: ['daemon.js'],
      bundle: true,
      platform: 'node',
      target: 'node18',
      outfile: '../dist/daemon-bundled.js',
      banner: { js: '#!/usr/bin/env node' },
      external: [] // Bundle all dependencies
    });
    console.log('✓ Built daemon-bundled.js');

    // Bundle CLI tool
    await esbuild.build({
      entryPoints: ['cli-tool.js'],
      bundle: true,
      platform: 'node',
      target: 'node18',
      outfile: '../dist/theoldswitcheroo-bundled.js',
      banner: { js: '#!/usr/bin/env node' },
      external: [] // Bundle all dependencies
    });
    console.log('✓ Built theoldswitcheroo-bundled.js');

    // Make bundled files executable
    fs.chmodSync(path.join(distDir, 'daemon-bundled.js'), 0o755);
    fs.chmodSync(path.join(distDir, 'theoldswitcheroo-bundled.js'), 0o755);
    console.log('✓ Made files executable');

  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build().catch(console.error);

# theoldswitcheroo

VSCode multiplexer experiment

## Usage

### Normal Operation
```bash
cd electron-app
npm run gui
# or
electron main.js
```

### Cleanup
```bash
cd electron-app
npm run clean <hostname>
# or
node main.js --clean <hostname>
```

Removes `~/.socratic-shell/theoldswitcheroo` from the specified remote host.

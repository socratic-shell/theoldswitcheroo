# theoldswitcheroo

VSCode multiplexer experiment

## Usage

### Normal Operation
```bash
cd electron-app
electron main.js
```

### Cleanup
```bash
cd electron-app
node main.js --clean <hostname>
```

Removes `~/.socratic-shell/theoldswitcheroo` from the specified remote host.

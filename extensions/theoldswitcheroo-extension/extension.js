const vscode = require('vscode');
const os = require('os');
const path = require('path');

function activate(context) {
    console.log('The Old Switcheroo extension is now active!');

    // Add theoldswitcheroo bin directory to PATH for integrated terminals
    // Use expanded home directory instead of tilde
    const homeDir = os.homedir();
    const binPath = path.join(homeDir, '.socratic-shell', 'theoldswitcheroo', 'bin');
    const currentPath = process.env.PATH || '';
    
    console.log(`Current PATH: ${currentPath}`);
    console.log(`Checking if PATH contains: ${binPath}`);
    
    if (!currentPath.includes(binPath)) {
        const newPath = `${binPath}:${currentPath}`;
        process.env.PATH = newPath;
        console.log(`✓ Added ${binPath} to PATH`);
        console.log(`New PATH: ${process.env.PATH}`);
    } else {
        console.log(`PATH already contains ${binPath}`);
    }

    // Create output channel
    const outputChannel = vscode.window.createOutputChannel('The Old Switcheroo');
    outputChannel.appendLine('Hello, world! The Old Switcheroo extension is loaded and ready.');
    outputChannel.appendLine(`CLI tool available in terminals: theoldswitcheroo`);
    outputChannel.appendLine(`PATH modified: ${!currentPath.includes(binPath) ? 'YES' : 'NO (already present)'}`);
    outputChannel.appendLine(`Bin path: ${binPath}`);
    outputChannel.show();

    let disposable = vscode.commands.registerCommand('theoldswitcheroo.helloWorld', function () {
        vscode.window.showInformationMessage('Hello World from The Old Switcheroo!');
        outputChannel.appendLine('Hello World command executed!');
        outputChannel.appendLine(`Current PATH: ${process.env.PATH}`);
    });

    context.subscriptions.push(disposable);
    context.subscriptions.push(outputChannel);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};

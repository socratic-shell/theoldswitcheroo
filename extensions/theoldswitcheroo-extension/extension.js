const vscode = require('vscode');

function activate(context) {
    console.log('The Old Switcheroo extension is now active!');

    // Add theoldswitcheroo bin directory to PATH for integrated terminals
    const binPath = '~/.socratic-shell/theoldswitcheroo/bin';
    const currentPath = process.env.PATH || '';
    
    if (!currentPath.includes(binPath)) {
        process.env.PATH = `${binPath}:${currentPath}`;
        console.log(`Added ${binPath} to PATH`);
    }

    // Create output channel
    const outputChannel = vscode.window.createOutputChannel('The Old Switcheroo');
    outputChannel.appendLine('Hello, world! The Old Switcheroo extension is loaded and ready.');
    outputChannel.appendLine(`CLI tool available in terminals: theoldswitcheroo`);
    outputChannel.show();

    let disposable = vscode.commands.registerCommand('theoldswitcheroo.helloWorld', function () {
        vscode.window.showInformationMessage('Hello World from The Old Switcheroo!');
        outputChannel.appendLine('Hello World command executed!');
        outputChannel.appendLine(`Current PATH includes: ${process.env.PATH}`);
    });

    context.subscriptions.push(disposable);
    context.subscriptions.push(outputChannel);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};

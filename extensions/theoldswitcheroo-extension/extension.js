const vscode = require('vscode');

function activate(context) {
    console.log('The Old Switcheroo extension is now active!');

    // Create output channel
    const outputChannel = vscode.window.createOutputChannel('The Old Switcheroo');
    outputChannel.appendLine('Hello, world! The Old Switcheroo extension is loaded and ready.');
    outputChannel.show();

    let disposable = vscode.commands.registerCommand('theoldswitcheroo.helloWorld', function () {
        vscode.window.showInformationMessage('Hello World from The Old Switcheroo!');
        outputChannel.appendLine('Hello World command executed!');
    });

    context.subscriptions.push(disposable);
    context.subscriptions.push(outputChannel);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};

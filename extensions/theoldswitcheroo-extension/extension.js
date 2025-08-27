const vscode = require('vscode');

function activate(context) {
    console.log('The Old Switcheroo extension is now active!');

    let disposable = vscode.commands.registerCommand('theoldswitcheroo.helloWorld', function () {
        vscode.window.showInformationMessage('Hello World from The Old Switcheroo!');
    });

    context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};

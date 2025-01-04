const vscode = require('vscode');

/**
 * @param {vscode.ExtensionContext} context
 */

function activate(context) {
	// status bar item
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
	statusBarItem.text = "$(database) DrawMeDatabase";
	statusBarItem.command = "DMDB.Draw";
	statusBarItem.show();

	// command
	console.log('DrawMeDatabase est activé!');
	const disposable = vscode.commands.registerCommand('DMDB.Draw', () => {
		vscode.window.showInformationMessage('Bienvenue sur DrawMeDatabase!');
	});

	context.subscriptions.push(disposable, statusBarItem);
}

function deactivate() {}
module.exports = {
	activate,
	deactivate
}

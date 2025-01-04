const vscode = require('vscode');
const parser = require('./parsers/parser');

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
	console.log('DrawMeDatabase is now active');
	const disposable = vscode.commands.registerCommand('DMDB.Draw', () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			const projectPath = workspaceFolders[0].uri.fsPath;

			// framework detection
			const framework = parser.detectFramework(projectPath);
			if (framework === 'Unknown') {
				vscode.window.showErrorMessage('Unknown framework, unable to draw database');
				return;
			} else {
				vscode.window.showInformationMessage(`Framework detected: ${framework}, starting to draw database...`);
			}
		}
	});

	context.subscriptions.push(disposable, statusBarItem);
}

function deactivate() {}
module.exports = {
	activate,
	deactivate
}

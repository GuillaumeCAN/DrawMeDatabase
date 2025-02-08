const vscode = require('vscode');
const parser = require('./parsers/parser');
const path = require('path');
const fs = require('fs');

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
				vscode.window.setStatusBarMessage(`Framework detected: ${framework}, starting to draw database...`, 3000);
			}

			// parse database and get JSON data
			const frameworkParser = require(`./parsers/${framework}`);
			const jsonTable = frameworkParser.Parser(projectPath);

			// display webview with JSON data ("json" is the default viewer method)
			showWebview(context, jsonTable, "mermaid");

		} else {
			vscode.window.showErrorMessage('No workspace opened, unable to draw database');
		}
	});

	context.subscriptions.push(disposable, statusBarItem);
}

function showWebview(context, jsonTable, method){
	// create webview panel
	const panel = vscode.window.createWebviewPanel(
		method+'View',
		method+' viewer',
		vscode.ViewColumn.One,
		{
			enableScripts: true
		}
	);

	// set webview content
	const htmlContent = getHtmlContent(context, jsonTable, method);
	panel.webview.html = htmlContent;
}

// get the correct HTML & CSS content viewer
function getHtmlContent(context, jsonTable, method){
	// Path to the HTML file
    const htmlPath = path.join(context.extensionPath, 'views', method, 'template.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');

    // Path to the CSS
    const cssPath = path.join(context.extensionPath, 'views', 'theme.css');
    let css = fs.readFileSync(cssPath, 'utf-8');

    // Path to the JS
    const jsPath = path.join(context.extensionPath, 'views', method, method+'.js');
    let js = fs.readFileSync(jsPath, 'utf-8');

    // Inject JSON data into the HTML
    const jsonScript = `<script>const jsonData = ${JSON.stringify(jsonTable, null, 2)};</script>`;
    html = html.replace('JSON_DATA', jsonScript);
    html = html.replace('/* CSS_STYLES */', css);
    html = html.replace('/* SCRIPT_METHOD */', js);

    return html;
}

function deactivate() {}
module.exports = {
	activate,
	deactivate
}

//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const parser = require('./parsers/parser');

function activate(context) {
    // Status bar item
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusBarItem.text = "$(database) DrawMeDatabase";
    statusBarItem.command = 'DMDB.parseSchema';
    statusBarItem.tooltip = 'Draw the database schema';
    statusBarItem.show();

    // Command to parse the schema
    const parseCommand = vscode.commands.registerCommand('DMDB.parseSchema', async () => {
        let projectPath = vscode.workspace.getConfiguration().get('DMDB.frameworkPath');

        if (!projectPath) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                projectPath = workspaceFolders[0].uri.fsPath;
            }
        }

        if (!projectPath) {
            vscode.window.showErrorMessage("No project opened in the current workspace. Unable to draw the schema.");
            return;
        }

        // Framework detection
        const framework = parser.detectFramework(projectPath);
        console.log(`Framework : ${framework}`);

        if (framework === 'Unknown') {
            vscode.window.showErrorMessage("Unknown framework. Unable to draw the schema.");
            return;
        }

        // Parsing
        const frameworkParser = require(`./parsers/${framework}`);
        const jsonTable = frameworkParser.Parser(projectPath);

        if (!jsonTable) {
            vscode.window.showErrorMessage("An error occured while parsing the schema.");
            return;
        }

        // Webview
        showWebview(context, jsonTable, "mermaid");
    });

    context.subscriptions.push(parseCommand);
}

function showWebview(context, jsonTable, method) {
    const panel = vscode.window.createWebviewPanel(
        method + 'View',
        'DrawMeDatabase',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    const htmlContent = getHtmlContent(context, jsonTable, method);
    panel.webview.html = htmlContent;

    panel.webview.onDidReceiveMessage(
        message => {
            if (message.command === 'changeViewer') {
                const newHtmlContent = getHtmlContent(context, jsonTable, message.viewer);
                panel.webview.html = newHtmlContent;
            }
        },
        undefined,
        context.subscriptions
    );
}

function getHtmlContent(context, jsonTable, method) {
    const htmlPath = path.join(context.extensionPath, 'views', method, 'template.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');

    const cssPath = path.join(context.extensionPath, 'views', 'theme.css');
    let css = fs.readFileSync(cssPath, 'utf-8');

    const jsPath = path.join(context.extensionPath, 'views', method, method + '.js');
    let js = fs.readFileSync(jsPath, 'utf-8');

    const jsonScript = `<script>const jsonData = ${JSON.stringify(jsonTable, null, 2)};</script>`;
    html = html.replace('JSON_DATA', jsonScript);
    html = html.replace('/* CSS_STYLES */', css);
    html = html.replace('/* SCRIPT_METHOD */', js);

    return html;
}

function deactivate() {}

module.exports = {
    activate,
    deactivate,
};

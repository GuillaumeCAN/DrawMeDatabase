//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { detectFramework } = require('./parsers/parser');
const { ParserError } = require('./parsers/errors');
const html = require('./views/html');

// Parsers by detected framework (loaded on first use)
const PARSERS = {
    laravel: () => require('./parsers/laravel'),
    symfony: () => require('./parsers/symfony'),
};

const VIEWERS = ['mermaid', 'json'];

function activate(context) {
    const output = vscode.window.createOutputChannel('DrawMeDatabase');
    context.subscriptions.push(output);

    // Status bar item
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusBarItem.text = "$(database) DrawMeDatabase";
    statusBarItem.command = 'DMDB.parseSchema';
    statusBarItem.tooltip = 'Draw the database schema';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    const viewer = createViewer(context, output);
    context.subscriptions.push(viewer);

    // Workspace folder of the last run, reused by a refresh from the panel (no active editor then)
    let lastFolder;

    // Command to parse the schema: shows the diagram and returns the parsed tables
    const parseCommand = vscode.commands.registerCommand('DMDB.parseSchema', () => {
        const folder = getWorkspaceFolder(lastFolder);
        let tables;
        if (folder) {
            lastFolder = folder;
            tables = readSchema(folder, output);
        } else {
            vscode.window.showErrorMessage("No project opened in the current workspace. Unable to draw the schema.");
        }

        // Nothing to draw: close the panel rather than leave the previous schema on screen
        if (!tables || tables.length === 0) {
            viewer.close();
            return tables;
        }

        // Webview
        try {
            viewer.show(tables);
        } catch (err) {
            reportUnexpectedError(output, err);
        }
        return tables;
    });

    context.subscriptions.push(parseCommand);
}

// Detects the framework and parses the schema: returns the tables, or undefined after an error
// (already shown to the user)
function readSchema(folder, output) {
    const frameworkPath = getFrameworkPath(folder);
    const basePath = resolveBasePath(folder.uri.fsPath, frameworkPath);
    if (!fs.existsSync(basePath)) {
        // Name the setting as the user wrote it: an absolute path was looked for in both places
        const elsewhere = path.isAbsolute(frameworkPath) ? ', nor as an absolute path' : '';
        vscode.window.showErrorMessage(frameworkPath
            ? `The DrawMeDatabase.frameworkPath folder "${frameworkPath}" was not found in "${folder.uri.fsPath}"${elsewhere}. Check the setting.`
            : `The folder "${basePath}" does not exist. Unable to draw the schema.`);
        return undefined;
    }

    let result;
    try {
        // Framework detection
        const framework = detectFramework(basePath);
        output.appendLine(`Framework: ${framework} (${basePath})`);
        if (!Object.prototype.hasOwnProperty.call(PARSERS, framework)) {
            const hint = frameworkPath
                ? 'Check the DrawMeDatabase.frameworkPath setting.'
                : 'If the project is in a subfolder, set DrawMeDatabase.frameworkPath.';
            vscode.window.showErrorMessage(`No Laravel or Symfony project found in "${basePath}". ${hint} Unable to draw the schema.`);
            return undefined;
        }

        // Parsing
        result = PARSERS[framework]().parse(basePath);
    } catch (err) {
        if (err instanceof ParserError) {
            output.appendLine(`Error: ${err.message}`);
            vscode.window.showErrorMessage(err.message);
        } else {
            reportUnexpectedError(output, err);
        }
        return undefined;
    }

    const tables = result && Array.isArray(result.tables) ? result.tables : [];
    const warnings = result && Array.isArray(result.warnings) ? result.warnings : [];
    warnings.forEach(warning => output.appendLine(`Warning: ${warning}`));
    output.appendLine(`${tables.length} table(s) found.`);

    if (warnings.length > 0) {
        reportWarnings(output, warnings.length);
    }
    if (tables.length === 0) {
        vscode.window.showInformationMessage(`No tables found in "${basePath}". Nothing to draw.`);
    }
    return tables;
}

// The workspace folder of the active editor, else the one of the last run, else the first one
function getWorkspaceFolder(lastFolder) {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return undefined;
    }
    const editor = vscode.window.activeTextEditor;
    const folder = editor ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : undefined;
    const last = lastFolder && folders.find(candidate => candidate.uri.toString() === lastFolder.uri.toString());
    return folder || last || folders[0];
}

// The DrawMeDatabase.frameworkPath setting of the folder, trimmed
function getFrameworkPath(folder) {
    const setting = vscode.workspace.getConfiguration('DrawMeDatabase', folder.uri).get('frameworkPath', '');
    return typeof setting === 'string' ? setting.trim() : '';
}

// The framework root. The setting is relative to the workspace folder, even with a leading
// '/' or '\' ('/backend' worked in 1.1.1). An absolute path is used as is only when it exists
// and the folder of the same name in the workspace does not.
function resolveBasePath(folderPath, frameworkPath) {
    const relative = path.resolve(folderPath, frameworkPath.replace(/^[\\/]+/, ''));
    if (path.isAbsolute(frameworkPath) && !fs.existsSync(relative) && fs.existsSync(frameworkPath)) {
        return path.resolve(frameworkPath);
    }
    return relative;
}

// One generic message for the user, the details in the output channel
function reportUnexpectedError(output, err) {
    output.appendLine(`Unexpected error: ${err && err.stack ? err.stack : err}`);
    vscode.window.showErrorMessage(
        'An unexpected error occurred while drawing the schema. See the "DrawMeDatabase" output for details.',
        'Show Output'
    ).then(choice => {
        if (choice) {
            output.show();
        }
    });
}

// One non-blocking message per run, the warnings themselves are in the output channel
function reportWarnings(output, count) {
    vscode.window.showWarningMessage(
        `${count} warning(s) while reading the schema. See the "DrawMeDatabase" output for details.`,
        'Show Output'
    ).then(choice => {
        if (choice) {
            output.show();
        }
    });
}

// A single webview panel, revealed and refreshed on each run
function createViewer(context, output) {
    let panel;
    let tables = [];
    let current = 'mermaid';

    const render = () => {
        panel.webview.html = getHtmlContent(context, panel.webview, tables, current);
    };

    const close = () => {
        if (panel) {
            panel.dispose();
        }
    };

    return {
        show(newTables) {
            tables = newTables;
            if (panel) {
                panel.reveal();
                render();
                return;
            }

            panel = vscode.window.createWebviewPanel(
                'drawMeDatabase',
                'DrawMeDatabase',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'views')],
                }
            );

            const messageListener = panel.webview.onDidReceiveMessage(message => {
                if (message && message.command === 'changeViewer' && VIEWERS.includes(message.viewer)) {
                    current = message.viewer;
                    try {
                        render();
                    } catch (err) {
                        reportUnexpectedError(output, err);
                    }
                }
            });
            panel.onDidDispose(() => {
                messageListener.dispose();
                panel = undefined;
                current = 'mermaid';
            });

            render();
        },
        close,
        dispose: close,
    };
}

function getHtmlContent(context, webview, tables, viewer) {
    const template = fs.readFileSync(path.join(context.extensionPath, 'views', viewer, 'template.html'), 'utf8');
    return html.buildPage(template, {
        viewer,
        cspSource: webview.cspSource,
        viewUri: (...segments) => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'views', ...segments)).toString(),
        data: tables,
    });
}

function deactivate() {}

module.exports = {
    activate,
    deactivate,
};

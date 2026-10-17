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

const VIEW_TYPE = 'drawMeDatabase';

// Parsers by detected framework (loaded on first use)
const PARSERS = {
    laravel: () => require('./parsers/laravel'),
    symfony: () => require('./parsers/symfony'),
};

const FRAMEWORK_LABELS = { laravel: 'Laravel', symfony: 'Symfony' };

// Settings the toolbar of the panel can change, with their allowed values (first = default)
const SETTINGS = {
    layout: ['elk', 'dagre'],
    direction: ['TB', 'LR'],
};

// Files the panel can export
const EXPORT_FORMATS = {
    svg: { label: 'SVG image', binary: false },
    png: { label: 'PNG image', binary: true },
    mmd: { label: 'Mermaid diagram', binary: false },
    md: { label: 'Markdown', binary: false },
    json: { label: 'JSON', binary: false },
};
const MAX_EXPORT_LENGTH = 200 * 1024 * 1024;

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

    // Workspace folder of the last run, reused by a refresh from the panel (no active editor then)
    let lastFolder;

    // Parses the schema of the folder and shows it: returns the parsed tables
    const draw = (folder) => {
        let schema;
        if (folder) {
            lastFolder = folder;
            schema = readSchema(folder, output);
        } else {
            vscode.window.showErrorMessage("No project opened in the current workspace. Unable to draw the schema.");
        }

        // Nothing to draw: close the panel rather than leave the previous schema on screen
        if (!schema || schema.tables.length === 0) {
            viewer.close();
            return schema ? schema.tables : undefined;
        }

        try {
            viewer.show({
                tables: schema.tables,
                warnings: schema.warnings,
                project: {
                    name: folder.name,
                    folder: folder.uri.toString(),
                    framework: schema.framework,
                    frameworkLabel: FRAMEWORK_LABELS[schema.framework] || '',
                },
            });
        } catch (err) {
            reportUnexpectedError(output, err);
        }
        return schema.tables;
    };

    const viewer = createViewer(context, output, {
        refresh: () => draw(getWorkspaceFolder(lastFolder)),
        exportFolder: () => lastFolder,
    });
    context.subscriptions.push(viewer);

    context.subscriptions.push(
        vscode.commands.registerCommand('DMDB.parseSchema', () => draw(getWorkspaceFolder(lastFolder))),
        vscode.commands.registerCommand('DMDB.refresh', () => draw(getWorkspaceFolder(lastFolder))),
        // The panel is restored after a reload of the window: draw the schema of its folder again
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            async deserializeWebviewPanel(panel, state) {
                viewer.restore(panel);
                const folders = vscode.workspace.workspaceFolders || [];
                const folder = state && typeof state.folder === 'string'
                    ? folders.find(candidate => candidate.uri.toString() === state.folder)
                    : undefined;
                if (folder) {
                    draw(folder);
                } else {
                    viewer.empty('Run DrawMeDatabase (or click Refresh) to draw the schema of the project.');
                }
            },
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (Object.keys(SETTINGS).some(key => event.affectsConfiguration(`DrawMeDatabase.${key}`))) {
                viewer.settingsChanged();
            }
        }),
    );

    // API of the extension (vscode.extensions.getExtension(...).exports), for the integration test
    return {
        get lastRender() {
            return viewer.lastRender;
        },
    };
}

// Detects the framework and parses the schema: returns { tables, warnings (count), framework },
// or undefined after an error (already shown to the user)
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
    let framework;
    try {
        // Framework detection
        framework = detectFramework(basePath);
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
    return { tables, warnings: warnings.length, framework };
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

// A single webview panel. The page is loaded once: the schema and the settings are posted to it
// (again when it reloads, after being restored), and it asks for refreshes and exports.
function createViewer(context, output, { refresh, exportFolder }) {
    let panel;
    let ready = false;
    // What the page shows: the last schema, or a message when there is none
    let schema = null;
    let emptyText = '';
    let subscriptions = [];
    // The last drawing reported by the page (shown in the output when it failed)
    let lastRender = null;

    const post = (message) => {
        if (panel && ready) {
            panel.webview.postMessage(message);
        }
    };

    const settingsMessage = () => {
        const config = vscode.workspace.getConfiguration('DrawMeDatabase');
        const message = { type: 'settings' };
        for (const [key, values] of Object.entries(SETTINGS)) {
            const value = config.get(key, values[0]);
            message[key] = values.includes(value) ? value : values[0];
        }
        return message;
    };

    const toast = (text) => post({ type: 'toast', text });

    function onMessage(message) {
        if (!message || typeof message !== 'object') {
            return;
        }
        switch (message.type) {
            case 'ready':
                ready = true;
                post(settingsMessage());
                if (schema) {
                    post(schema);
                } else if (emptyText) {
                    post({ type: 'empty', text: emptyText });
                }
                break;
            case 'refresh':
                // Let the page show its progress bar before the (synchronous) parsing
                post({ type: 'busy', busy: true });
                setTimeout(() => {
                    try {
                        refresh();
                    } finally {
                        post({ type: 'busy', busy: false });
                    }
                }, 20);
                break;
            case 'setting':
                if (Object.prototype.hasOwnProperty.call(SETTINGS, message.key) && SETTINGS[message.key].includes(message.value)) {
                    Promise.resolve(vscode.workspace.getConfiguration('DrawMeDatabase')
                        .update(message.key, message.value, vscode.ConfigurationTarget.Global))
                        .catch(err => reportUnexpectedError(output, err));
                }
                break;
            case 'save':
                saveExport(message).catch(err => reportUnexpectedError(output, err));
                break;
            case 'copy':
                if (typeof message.content === 'string' && message.content.length <= MAX_EXPORT_LENGTH) {
                    Promise.resolve(vscode.env.clipboard.writeText(message.content))
                        .then(() => toast(message.format === 'json' ? 'JSON copied to the clipboard.' : 'Mermaid source copied to the clipboard.'))
                        .catch(err => reportUnexpectedError(output, err));
                }
                break;
            case 'showOutput':
                output.show();
                break;
            case 'rendered':
                lastRender = {
                    ok: message.ok === true,
                    layout: String(message.layout || ''),
                    entities: Number(message.entities) || 0,
                    error: String(message.error || ''),
                };
                if (!lastRender.ok) {
                    output.appendLine(`Diagram error: ${lastRender.error}`);
                }
                break;
        }
    }

    // Writes an export where the user chooses (Save dialog, in the project folder by default)
    async function saveExport(message) {
        const format = Object.prototype.hasOwnProperty.call(EXPORT_FORMATS, message.format) ? EXPORT_FORMATS[message.format] : null;
        if (!format || typeof message.content !== 'string' || message.content.length > MAX_EXPORT_LENGTH) {
            return;
        }
        const requested = typeof message.fileName === 'string' ? path.basename(message.fileName) : '';
        const fileName = requested.endsWith(`.${message.format}`) ? requested : `schema.${message.format}`;
        const folder = exportFolder();
        const uri = await vscode.window.showSaveDialog({
            defaultUri: folder ? vscode.Uri.joinPath(folder.uri, fileName) : undefined,
            filters: { [format.label]: [message.format] },
            saveLabel: 'Export',
            title: 'Export the database diagram',
        });
        if (!uri) {
            return;
        }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(message.content, format.binary ? 'base64' : 'utf8'));
        const choice = await vscode.window.showInformationMessage(`Exported to ${path.basename(uri.fsPath)}.`, 'Open');
        if (choice === 'Open') {
            await vscode.commands.executeCommand('vscode.open', uri);
        }
    }

    function setup(newPanel) {
        panel = newPanel;
        ready = false;
        panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'images', 'logo_128.png');
        panel.webview.options = webviewOptions(context);
        subscriptions = [
            panel.webview.onDidReceiveMessage(message => {
                try {
                    onMessage(message);
                } catch (err) {
                    reportUnexpectedError(output, err);
                }
            }),
            panel.onDidDispose(() => {
                subscriptions.forEach(subscription => subscription.dispose());
                subscriptions = [];
                panel = undefined;
                ready = false;
            }),
        ];
        panel.webview.html = getHtmlContent(context, panel.webview);
    }

    const close = () => {
        if (panel) {
            panel.dispose();
        }
    };

    return {
        show(newSchema) {
            schema = { type: 'schema', ...newSchema };
            emptyText = '';
            if (panel) {
                panel.reveal();
                post(schema);
                return;
            }
            setup(vscode.window.createWebviewPanel(VIEW_TYPE, 'DrawMeDatabase', vscode.ViewColumn.One, {
                ...webviewOptions(context),
                // Large diagrams take seconds to draw: keep them while the tab is hidden
                retainContextWhenHidden: true,
            }));
        },
        // A panel restored by VS Code after a reload of the window
        restore(restoredPanel) {
            if (panel && panel !== restoredPanel) {
                panel.dispose();
            }
            setup(restoredPanel);
        },
        empty(text) {
            schema = null;
            emptyText = text;
            post({ type: 'empty', text });
        },
        settingsChanged() {
            post(settingsMessage());
        },
        get lastRender() {
            return lastRender;
        },
        close,
        dispose: close,
    };
}

function webviewOptions(context) {
    return {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'views')],
    };
}

function getHtmlContent(context, webview) {
    const template = fs.readFileSync(path.join(context.extensionPath, 'views', 'index.html'), 'utf8');
    return html.buildPage(template, {
        cspSource: webview.cspSource,
        viewUri: (...segments) => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'views', ...segments)).toString(),
    });
}

function deactivate() {}

module.exports = {
    activate,
    deactivate,
};

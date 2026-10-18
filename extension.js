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
    showGitStatus: [true, false],
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

// DrawMeDatabase Pro adds its exports and tools through the API below
const PRO_EXTENSION_ID = 'GuillaumeCancalon.draw-me-database-pro';
const API_VERSION = 1;

// A minimal vscode.Event: event(listener, thisArgs, disposables) → Disposable
function createEmitter() {
    const listeners = new Set();
    const event = (listener, thisArgs, disposables) => {
        const bound = thisArgs ? listener.bind(thisArgs) : listener;
        listeners.add(bound);
        const disposable = { dispose: () => listeners.delete(bound) };
        if (Array.isArray(disposables)) {
            disposables.push(disposable);
        }
        return disposable;
    };
    return {
        event,
        fire(value) {
            for (const listener of [...listeners]) {
                try {
                    listener(value);
                } catch {
                    // A listener of another extension must not break the diagram
                }
            }
        },
        dispose: () => listeners.clear(),
    };
}

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
    // The schema on screen: its folder, framework root and tables (source files of the tables)
    let current = null;
    // git status by folder, kept while only unsaved editors change (see parsers/git.js)
    const gitCache = new Map();
    // API: the schema on screen changed; exports added by other extensions
    const schemaChanged = createEmitter();
    context.subscriptions.push(schemaChanged);
    const exporters = new Map();

    // Parses the schema of the folder and shows it: returns the parsed tables. auto: refresh
    // after a change of the code, without messages and without closing the panel on an error
    // (the code may be in the middle of an edit), nor bringing the panel to the front.
    const draw = (folder, { auto = false } = {}) => {
        let schema;
        if (!auto) {
            gitCache.clear();
        }
        if (folder) {
            lastFolder = folder;
            schema = readSchema(folder, output, {
                notify: !auto,
                // What the developer sees: the text of the editors not saved yet
                overrides: unsavedEditors(),
                gitCache,
                git: vscode.workspace.getConfiguration('DrawMeDatabase').get('showGitStatus', true) !== false,
            });
        } else if (!auto) {
            vscode.window.showErrorMessage("No project opened in the current workspace. Unable to draw the schema.");
        }

        if (!schema || schema.tables.length === 0) {
            if (auto) {
                viewer.toast(schema
                    ? 'No tables found: the diagram shows the previous schema.'
                    : 'The schema could not be read (see the DrawMeDatabase output): the diagram shows the previous schema.');
                return schema ? schema.tables : undefined;
            }
            // Nothing to draw: close the panel rather than leave the previous schema on screen
            viewer.close();
            return schema ? schema.tables : undefined;
        }

        try {
            current = { folder, basePath: schema.basePath, framework: schema.framework, tables: schema.tables };
            viewer.show({
                tables: schema.tables,
                warnings: schema.warnings,
                project: {
                    name: folder.name,
                    folder: folder.uri.toString(),
                    framework: schema.framework,
                    frameworkLabel: FRAMEWORK_LABELS[schema.framework] || '',
                },
            }, { reveal: !auto });
            watcher.watch(current);
            schemaChanged.fire(publicSchema());
        } catch (err) {
            reportUnexpectedError(output, err);
        }
        return schema.tables;
    };

    // Opens the file a table comes from (migration or entity), beside the diagram
    const openTable = (name) => {
        const table = current && typeof name === 'string' ? current.tables.find(candidate => candidate.table === name) : undefined;
        const source = table && table.source;
        if (!source || typeof source.file !== 'string') {
            return;
        }
        // Only files of the project: the path comes from the parser, never from the page
        const file = path.resolve(current.basePath, source.file);
        const relative = path.relative(current.basePath, file);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            return;
        }
        const line = Math.max(0, (Number(source.line) || 1) - 1);
        Promise.resolve(vscode.window.showTextDocument(vscode.Uri.file(file), {
            viewColumn: vscode.ViewColumn.Beside,
            preview: true,
            selection: new vscode.Range(line, 0, line, 0),
        })).catch(err => {
            output.appendLine(`Unable to open ${file}: ${err && err.message ? err.message : err}`);
            vscode.window.showErrorMessage(`Unable to open ${source.file}.`);
        });
    };

    // Refreshes the open diagram after the migrations or entities change: on disk (and in git,
    // after a commit or a checkout) the git status is read again, while typing it is not
    const watcher = createWatcher(({ disk }) => {
        if (disk) {
            gitCache.clear();
        }
        if (current && viewer.isOpen()) {
            draw(current.folder, { auto: true });
        }
    });
    context.subscriptions.push(watcher);

    // Text of the unsaved editors of the watched migrations or entities (absolute path → text)
    const unsavedEditors = () => {
        const overrides = new Map();
        for (const document of vscode.workspace.textDocuments) {
            if (document.isDirty && document.uri.scheme === 'file' && watcher.covers(document.uri.fsPath)) {
                overrides.set(path.resolve(document.uri.fsPath), document.getText());
            }
        }
        return overrides;
    };

    // Live diagram: an edit of a migration or an entity, before it is saved
    const onEditor = (document, disk) => {
        if (document.uri.scheme === 'file' && watcher.covers(document.uri.fsPath)) {
            watcher.schedule({ disk });
        }
    };
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.contentChanges.length > 0) {
                onEditor(event.document, false);
            }
        }),
        // A save may change the git status; closing an unsaved editor drops its changes
        vscode.workspace.onDidSaveTextDocument(document => onEditor(document, true)),
        vscode.workspace.onDidCloseTextDocument(document => onEditor(document, false)),
        watchGitRepositories(() => watcher.schedule({ disk: true })),
    );

    // The schema on screen, as other extensions get it (copies: they cannot change it)
    const publicSchema = () => (current ? {
        tables: JSON.parse(JSON.stringify(current.tables)),
        framework: current.framework,
        basePath: current.basePath,
        project: { name: current.folder.name, folder: current.folder.uri.toString() },
    } : null);

    const viewer = createViewer(context, output, {
        refresh: () => draw(getWorkspaceFolder(lastFolder)),
        exportFolder: () => lastFolder,
        openTable,
        onClose: () => watcher.stop(),
        exporters: () => [...exporters.values()],
        schemaFor: (names) => {
            const schema = publicSchema();
            if (schema && Array.isArray(names)) {
                const shown = new Set(names.filter(name => typeof name === 'string'));
                schema.tables = schema.tables.filter(table => shown.has(table.table));
            }
            return schema;
        },
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
            if (!current || !viewer.isOpen()) {
                return;
            }
            if (event.affectsConfiguration('DrawMeDatabase.autoRefresh')) {
                watcher.watch(current);
            }
            // The git status is read again when it is shown again
            if (event.affectsConfiguration('DrawMeDatabase.showGitStatus')) {
                watcher.schedule({ disk: true });
            }
            // Another framework folder: draw it (after a pause, the setting may be typed)
            if (event.affectsConfiguration('DrawMeDatabase.frameworkPath')) {
                watcher.schedule({ disk: true });
            }
        }),
    );

    // API of the extension: vscode.extensions.getExtension('GuillaumeCancalon.draw-me-database').exports.
    // Used by DrawMeDatabase Pro and the integration test; documented in docs/api.md.
    return {
        apiVersion: API_VERSION,
        get lastRender() {
            return viewer.lastRender;
        },
        // The schema on screen ({ tables, framework, basePath, project }), or null
        getSchema: publicSchema,
        onDidChangeSchema: schemaChanged.event,
        // Opens the diagram of the workspace (like the DrawMeDatabase command): the parsed tables
        showDiagram: () => vscode.commands.executeCommand('DMDB.parseSchema'),
        detectFramework,
        // Parses a framework folder ({ tables, warnings }), options as in docs/pivot-format.md
        parseSchema(basePath, framework, options = {}) {
            if (!Object.prototype.hasOwnProperty.call(PARSERS, framework)) {
                throw new ParserError(`Unknown framework: ${framework}`);
            }
            return PARSERS[framework]().parse(basePath, options);
        },
        // The page files, for the panels of other extensions (localResourceRoots, script order)
        viewsUri: vscode.Uri.joinPath(context.extensionUri, 'views'),
        viewScripts: html.SCRIPTS.filter(segments => !['app.js', 'json.js'].includes(segments[segments.length - 1])).map(segments => segments.join('/')),
        // An item of the Export menu: { id, label, extension, export(schema) → text } (schema: the
        // tables on screen). Returns a Disposable.
        registerExporter(exporter) {
            if (!exporter || typeof exporter.id !== 'string' || typeof exporter.export !== 'function') {
                throw new TypeError('An exporter needs an id and an export(schema) function');
            }
            exporters.set(exporter.id, {
                id: exporter.id,
                label: String(exporter.label || exporter.id),
                extension: String(exporter.extension || 'txt').replace(/[^A-Za-z0-9]/g, '') || 'txt',
                export: exporter.export,
            });
            viewer.exportersChanged();
            return {
                dispose() {
                    exporters.delete(exporter.id);
                    viewer.exportersChanged();
                },
            };
        },
        // Shows these tables only (with the relations between them), the highlighted ones standing
        // out, and a label to go back to the whole schema: { tables, highlight, label }
        focusTables(focus) {
            viewer.focus(focus);
        },
        // The diagram on screen as an SVG file (text), or null when none is drawn
        getDiagramSvg: () => viewer.requestSvg(),
    };
}

// Detects the framework and parses the schema: returns { tables, warnings (count), framework,
// basePath }, or undefined after an error (already shown to the user). notify: false writes the
// messages to the output only (automatic refresh); overrides, gitCache and git go to the parser.
function readSchema(folder, output, { notify = true, overrides = null, gitCache = null, git = true } = {}) {
    const tell = (show, text, ...items) => (notify ? show(text, ...items) : output.appendLine(text));
    const showError = (text) => tell(vscode.window.showErrorMessage, text);

    const frameworkPath = getFrameworkPath(folder);
    const basePath = resolveBasePath(folder.uri.fsPath, frameworkPath);
    if (!fs.existsSync(basePath)) {
        // Name the setting as the user wrote it: an absolute path was looked for in both places
        const elsewhere = path.isAbsolute(frameworkPath) ? ', nor as an absolute path' : '';
        showError(frameworkPath
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
            showError(`No Laravel or Symfony project found in "${basePath}". ${hint} Unable to draw the schema.`);
            return undefined;
        }

        // Parsing
        result = PARSERS[framework]().parse(basePath, { overrides, gitCache, git });
    } catch (err) {
        if (err instanceof ParserError) {
            output.appendLine(`Error: ${err.message}`);
            if (notify) {
                vscode.window.showErrorMessage(err.message);
            }
        } else if (notify) {
            reportUnexpectedError(output, err);
        } else {
            output.appendLine(`Unexpected error: ${err && err.stack ? err.stack : err}`);
        }
        return undefined;
    }

    const tables = result && Array.isArray(result.tables) ? result.tables : [];
    const warnings = result && Array.isArray(result.warnings) ? result.warnings : [];
    warnings.forEach(warning => output.appendLine(`Warning: ${warning}`));
    output.appendLine(`${tables.length} table(s) found.`);

    if (warnings.length > 0 && notify) {
        reportWarnings(output, warnings.length);
    }
    if (tables.length === 0) {
        tell(vscode.window.showInformationMessage, `No tables found in "${basePath}". Nothing to draw.`);
    }
    return { tables, warnings: warnings.length, framework, basePath };
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

// Watches the migrations (Laravel) or the entities (Symfony) of the schema on screen, while
// DrawMeDatabase.autoRefresh is on. onChange({ disk }) runs once the changes pause: 300 ms after
// an edit in an editor, 500 ms after a change on disk (disk: true, the git status may change too).
function createWatcher(onChange) {
    let watcher;
    let watched = '';
    let folder = '';
    let framework = '';
    let timer;
    let disk = false;

    const schedule = ({ disk: changedOnDisk = true } = {}) => {
        if (!watched) {
            return;
        }
        clearTimeout(timer);
        disk = disk || changedOnDisk;
        timer = setTimeout(() => {
            const reason = { disk };
            disk = false;
            onChange(reason);
        }, disk ? 500 : 300);
    };

    const stop = () => {
        clearTimeout(timer);
        if (watcher) {
            watcher.dispose();
        }
        watcher = undefined;
        watched = '';
        disk = false;
    };

    return {
        watch({ basePath, framework: newFramework }) {
            const enabled = vscode.workspace.getConfiguration('DrawMeDatabase').get('autoRefresh', true) !== false;
            const newFolder = newFramework === 'laravel' ? path.join(basePath, 'database', 'migrations')
                : newFramework === 'symfony' ? path.join(basePath, 'src', 'Entity') : '';
            const target = enabled && newFolder ? `${newFramework}:${newFolder}` : '';
            if (target === watched) {
                return;
            }
            stop();
            if (!target) {
                return;
            }
            watched = target;
            folder = path.resolve(newFolder);
            framework = newFramework;
            // Laravel reads the files of database/migrations only, Symfony its sub-folders too
            watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(newFolder), framework === 'laravel' ? '*.php' : '**/*.php'));
            watcher.onDidChange(() => schedule({ disk: true }));
            watcher.onDidCreate(() => schedule({ disk: true }));
            watcher.onDidDelete(() => schedule({ disk: true }));
        },
        // Whether the file is one of the migrations or entities watched
        covers(filePath) {
            if (!watched || !filePath.endsWith('.php')) {
                return false;
            }
            const file = path.resolve(filePath);
            return framework === 'laravel' ? path.dirname(file) === folder : file.startsWith(folder + path.sep);
        },
        schedule,
        stop,
        dispose: stop,
    };
}

// Calls onChange when a git repository of the workspace changes (commit, checkout, stage...),
// through the API of the built-in Git extension, when it is enabled
function watchGitRepositories(onChange) {
    const subscriptions = [];
    let disposed = false;
    const extension = vscode.extensions && vscode.extensions.getExtension('vscode.git');
    if (extension) {
        Promise.resolve(extension.isActive ? extension.exports : extension.activate()).then(exports => {
            if (disposed || !exports || !exports.enabled) {
                return;
            }
            const api = exports.getAPI(1);
            const track = (repository) => subscriptions.push(repository.state.onDidChange(onChange));
            api.repositories.forEach(track);
            subscriptions.push(api.onDidOpenRepository(track));
        }).catch(() => {});
    }
    return {
        dispose() {
            disposed = true;
            subscriptions.forEach(subscription => subscription.dispose());
        },
    };
}

// A single webview panel. The page is loaded once: the schema and the settings are posted to it
// (again when it reloads, after being restored), and it asks for refreshes and exports.
function createViewer(context, output, { refresh, exportFolder, openTable, onClose, exporters, schemaFor }) {
    let panel;
    let ready = false;
    // What the page shows: the last schema, or a message when there is none
    let schema = null;
    let emptyText = '';
    let subscriptions = [];
    // The last drawing reported by the page (shown in the output when it failed)
    let lastRender = null;
    // A focus asked before the page was ready; SVG requests waiting for the page
    let pendingFocus = null;
    const svgRequests = new Map();
    let svgRequestCount = 0;

    const exportersMessage = () => ({
        type: 'exporters',
        items: exporters().map(({ id, label, extension }) => ({ id, label, extension })),
        pro: Boolean(vscode.extensions && vscode.extensions.getExtension(PRO_EXTENSION_ID)),
    });

    const focusMessage = (focus) => {
        const names = (list) => (Array.isArray(list) ? list.filter(name => typeof name === 'string') : []);
        return {
            type: 'focus',
            tables: names(focus && focus.tables),
            highlight: names(focus && focus.highlight),
            label: focus && typeof focus.label === 'string' ? focus.label : '',
        };
    };

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
                post(exportersMessage());
                if (schema) {
                    post(schema);
                } else if (emptyText) {
                    post({ type: 'empty', text: emptyText });
                }
                if (pendingFocus) {
                    post(pendingFocus);
                    pendingFocus = null;
                }
                break;
            case 'export': {
                // An export of another extension, on the tables on screen
                const exporter = exporters().find(candidate => candidate.id === message.id);
                if (exporter) {
                    runExporter(exporter, message.tables).catch(err => reportUnexpectedError(output, err));
                }
                break;
            }
            case 'pro':
                Promise.resolve(vscode.commands.executeCommand('extension.open', PRO_EXTENSION_ID))
                    .catch(err => reportUnexpectedError(output, err));
                break;
            case 'svg': {
                const resolve = svgRequests.get(message.id);
                if (resolve) {
                    svgRequests.delete(message.id);
                    resolve(typeof message.svg === 'string' ? message.svg : null);
                }
                break;
            }
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
            case 'open':
                openTable(message.table);
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

    // An export of another extension: its text, saved like the others
    async function runExporter(exporter, names) {
        const schemaToExport = schemaFor(names);
        if (!schemaToExport) {
            return;
        }
        const content = await exporter.export(schemaToExport);
        if (typeof content !== 'string' || content.length === 0) {
            return;
        }
        const name = schemaToExport.project.name.normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|-+$/g, '');
        await saveFile(content, { extension: exporter.extension, label: exporter.label, binary: false }, `${name ? `${name}-` : ''}schema.${exporter.extension}`);
    }

    // Writes an export where the user chooses (Save dialog, in the project folder by default)
    async function saveExport(message) {
        const format = Object.prototype.hasOwnProperty.call(EXPORT_FORMATS, message.format) ? EXPORT_FORMATS[message.format] : null;
        if (!format || typeof message.content !== 'string' || message.content.length > MAX_EXPORT_LENGTH) {
            return;
        }
        await saveFile(message.content, { extension: message.format, label: format.label, binary: format.binary }, message.fileName);
    }

    async function saveFile(content, { extension, label, binary }, suggestedName) {
        const requested = typeof suggestedName === 'string' ? path.basename(suggestedName) : '';
        const fileName = requested.endsWith(`.${extension}`) ? requested : `schema.${extension}`;
        const folder = exportFolder();
        const uri = await vscode.window.showSaveDialog({
            defaultUri: folder ? vscode.Uri.joinPath(folder.uri, fileName) : undefined,
            filters: { [label]: [extension] },
            saveLabel: 'Export',
            title: 'Export the database diagram',
        });
        if (!uri) {
            return;
        }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, binary ? 'base64' : 'utf8'));
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
                svgRequests.forEach(resolve => resolve(null));
                svgRequests.clear();
                onClose();
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
        // reveal: bring the panel to the front (not after an automatic refresh)
        show(newSchema, { reveal = true } = {}) {
            const next = { type: 'schema', ...newSchema };
            // An automatic refresh that changes nothing (an edit outside the schema) is not posted
            const same = schema !== null && JSON.stringify(schema) === JSON.stringify(next);
            schema = next;
            emptyText = '';
            if (panel) {
                if (reveal) {
                    panel.reveal();
                }
                if (!same || reveal) {
                    post(schema);
                }
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
        toast,
        isOpen: () => Boolean(panel),
        get lastRender() {
            return lastRender;
        },
        exportersChanged() {
            post(exportersMessage());
        },
        focus(focus) {
            const message = focusMessage(focus);
            if (panel && ready) {
                panel.reveal();
                post(message);
            } else {
                pendingFocus = message;
                if (!panel) {
                    Promise.resolve(vscode.commands.executeCommand('DMDB.parseSchema')).catch(err => reportUnexpectedError(output, err));
                }
            }
        },
        requestSvg() {
            if (!panel || !ready || !schema) {
                return Promise.resolve(null);
            }
            const id = ++svgRequestCount;
            return new Promise(resolve => {
                svgRequests.set(id, resolve);
                post({ type: 'svgRequest', id });
                setTimeout(() => {
                    if (svgRequests.delete(id)) {
                        resolve(null);
                    }
                }, 15000);
            });
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

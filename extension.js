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
const i18n = require('./views/i18n');
const appearance = require('./views/appearance');

const VIEW_TYPE = 'drawMeDatabase';

// Parsers by detected framework (loaded on first use)
const PARSERS = {
    laravel: () => require('./parsers/laravel'),
    symfony: () => require('./parsers/symfony'),
};

const FRAMEWORK_LABELS = { laravel: 'Laravel', symfony: 'Symfony' };

// Settings the page (toolbar and side panel) can change: their allowed values (first = default),
// or their default and a function that returns the cleaned value (undefined when it is invalid)
const SETTINGS = {
    layout: { values: ['elk', 'dagre'] },
    direction: { values: ['TB', 'LR'] },
    showGitStatus: { values: [true, false] },
    keysOnly: { values: [false, true] },
    relationLabels: { values: [true, false] },
    autoRefresh: { values: [true, false] },
    language: { values: ['auto', ...i18n.LANGUAGES] },
    theme: { values: appearance.THEMES },
    palette: { values: Object.keys(appearance.PALETTES) },
    font: { values: appearance.FONTS },
    grid: { values: [true, false] },
    fontSize: { default: appearance.FONT_SIZE.default, clean: (value) => (Number.isFinite(value) ? appearance.sanitize({ fontSize: value }).fontSize : undefined) },
    customFont: { default: '', clean: (value) => (typeof value === 'string' ? appearance.sanitize({ customFont: value }).customFont : undefined) },
    colors: { default: {}, clean: (value) => appearance.sanitizeColors(value) },
};
const APPEARANCE_SETTINGS = ['theme', 'palette', 'colors', 'font', 'customFont', 'fontSize', 'grid'];

// The cleaned value of a setting, or undefined when it is not allowed
function settingValue(key, value) {
    if (!Object.prototype.hasOwnProperty.call(SETTINGS, key)) {
        return undefined;
    }
    const setting = SETTINGS[key];
    if (setting.values) {
        return setting.values.includes(value) ? value : undefined;
    }
    return setting.clean(value);
}

function readSetting(config, key) {
    const setting = SETTINGS[key];
    const value = settingValue(key, config.get(key));
    return value === undefined ? (setting.values ? setting.values[0] : setting.default) : value;
}

// Texts of the messages, in the language of the DrawMeDatabase.language setting (views/i18n.js)
function tr(key, params) {
    const setting = vscode.workspace.getConfiguration('DrawMeDatabase').get('language', 'auto');
    const language = i18n.resolveLanguage(setting, vscode.env && vscode.env.language);
    return i18n.translator(language)(key, params);
}

// Files the panel can export
const EXPORT_FORMATS = {
    svg: { label: 'format.svg', binary: false },
    png: { label: 'format.png', binary: true },
    mmd: { label: 'format.mmd', binary: false },
    md: { label: 'format.md', binary: false },
    json: { label: 'format.json', binary: false },
};
const MAX_EXPORT_LENGTH = 200 * 1024 * 1024;

// DrawMeDatabase Pro adds its exports and tools through the API below
const PRO_EXTENSION_ID = 'GuillaumeCancalon.draw-me-database-pro';
const API_VERSION = 2;

// Tools and exports of DrawMeDatabase Pro, shown greyed in the side panel until it adds them
const PRO_TOOLS = ['pro.canvas', 'pro.designer', 'pro.addColumns', 'pro.compare', 'pro.compareRefs', 'pro.migrationChanges', 'pro.checks', 'pro.findPath', 'pro.saveView', 'pro.openView', 'pro.models'];
const PRO_EXPORTS = ['pro.sql-mysql', 'pro.sql-postgresql', 'pro.sql-sqlite', 'pro.dbml', 'pro.plantuml', 'pro.typescript', 'pro.html'];
const LICENSE_KINDS = ['licensed', 'trial', 'expired', 'development'];

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
    statusBarItem.tooltip = tr('statusBar.tooltip');
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
    // Tools of other extensions in the side panel (id → { id, label, hint, icon, command, args,
    // pro, locked }), and the license of DrawMeDatabase Pro ({ kind, daysLeft, commands } or null)
    const tools = new Map();
    let license = null;
    // What other extensions show in the inspector of a table (id → provide(table, schema)), and
    // the commands of the actions they posted to the page (action id → { command, args })
    const tableProviders = new Map();
    let tableActions = new Map();
    // API: the appearance and the language of the pages, for the panels of other extensions
    const displayChanged = createEmitter();
    context.subscriptions.push(displayChanged);
    const displaySettings = () => {
        const config = vscode.workspace.getConfiguration('DrawMeDatabase');
        const settings = {};
        for (const key of APPEARANCE_SETTINGS) {
            settings[key] = readSetting(config, key);
        }
        settings.language = i18n.resolveLanguage(readSetting(config, 'language'), vscode.env && vscode.env.language);
        return settings;
    };
    const openPro = () => Promise.resolve(vscode.commands.executeCommand('extension.open', PRO_EXTENSION_ID))
        .catch(err => reportUnexpectedError(output, err));

    // What the side panel lists: the tools and exports of the extensions (the ones of DrawMeDatabase
    // Pro greyed while it does not add them, locked when its trial has ended) and the license
    const features = () => {
        const expired = Boolean(license && license.kind === 'expired');
        const state = (item) => (!item ? 'missing' : item.locked || (item.pro && expired) ? 'locked' : 'available');
        const describe = (id, item) => ({
            id,
            label: item ? item.label : '',
            hint: item && item.hint ? item.hint : '',
            icon: item && item.icon ? item.icon : undefined,
            pro: item ? item.pro : true,
            state: state(item),
        });
        const others = (registry, catalog) => [...registry.values()].filter(item => !catalog.includes(item.id));
        const commands = license && license.commands ? license.commands : {};
        let actions = ['discover'];
        if (license) {
            actions = (license.kind === 'licensed' ? ['manage'] : license.kind === 'development' ? [] : ['buy', 'enter']).filter(action => commands[action]);
        }
        return {
            tools: [...PRO_TOOLS.map(id => describe(id, tools.get(id))), ...others(tools, PRO_TOOLS).map(tool => describe(tool.id, tool))],
            exports: [...PRO_EXPORTS.map(id => describe(id, exporters.get(id))), ...others(exporters, PRO_EXPORTS).map(exporter => describe(exporter.id, exporter))],
            license: license ? { kind: license.kind, daysLeft: license.daysLeft, actions } : { kind: 'free', actions },
        };
    };
    const runTool = (id) => {
        const tool = tools.get(id);
        if (tool) {
            Promise.resolve(vscode.commands.executeCommand(tool.command, ...tool.args)).catch(err => reportUnexpectedError(output, err));
        } else if (PRO_TOOLS.includes(id)) {
            openPro();
        }
    };
    // The sections of the inspector of a table, from the providers (each one at most 10 s), or
    // the Pro teaser when none is registered
    const tableInfo = async (name) => {
        if (tableProviders.size === 0) {
            return { sections: [], teaser: true };
        }
        const schema = publicSchema();
        const timeout = () => new Promise(resolve => setTimeout(() => resolve([]), 10000));
        const results = await Promise.all([...tableProviders.values()].map(provide => Promise.race([
            Promise.resolve().then(() => provide(name, schema)).catch(err => {
                output.appendLine(`Table info: ${err && err.message ? err.message : err}`);
                return [];
            }),
            timeout(),
        ])));
        tableActions = new Map();
        const sections = results.flat().map(section => cleanSection(section, tableActions)).filter(Boolean);
        return { sections, teaser: false };
    };
    const runTableAction = (id) => {
        const action = tableActions.get(id);
        if (action) {
            Promise.resolve(vscode.commands.executeCommand(action.command, ...action.args)).catch(err => reportUnexpectedError(output, err));
        }
    };
    const runLicenseAction = (action) => {
        const command = license && license.commands ? license.commands[action] : undefined;
        if (command) {
            Promise.resolve(vscode.commands.executeCommand(command)).catch(err => reportUnexpectedError(output, err));
        } else if (action === 'discover') {
            openPro();
        }
    };

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
            vscode.window.showErrorMessage(tr('message.noProject'));
        }

        if (!schema || schema.tables.length === 0) {
            if (auto) {
                viewer.toast(tr(schema ? 'message.previousNoTables' : 'message.previousError'));
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
    // Opens the file of a table, or the line of one of its columns (column: its name)
    const openTable = (name, columnName) => {
        const table = current && typeof name === 'string' ? current.tables.find(candidate => candidate.table === name) : undefined;
        const column = table && typeof columnName === 'string' ? (table.columns || []).find(candidate => candidate.name === columnName) : undefined;
        const source = columnName === undefined ? table && table.source : column && column.source;
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
            vscode.window.showErrorMessage(tr('message.openFailed', { file: source.file }));
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
        features,
        runTool,
        runLicenseAction,
        tableInfo,
        runTableAction,
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
                    viewer.empty(tr('message.restore'));
                }
            },
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (Object.keys(SETTINGS).some(key => event.affectsConfiguration(`DrawMeDatabase.${key}`))) {
                viewer.settingsChanged();
            }
            if ([...APPEARANCE_SETTINGS, 'language'].some(key => event.affectsConfiguration(`DrawMeDatabase.${key}`))) {
                displayChanged.fire(displaySettings());
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
                // A feature of DrawMeDatabase Pro: locked in the side panel once its trial has ended
                pro: exporter.pro === true || PRO_EXPORTS.includes(exporter.id),
            });
            viewer.exportersChanged();
            return {
                dispose() {
                    exporters.delete(exporter.id);
                    viewer.exportersChanged();
                },
            };
        },
        // A tool in the side panel: { id, label, command, args, hint, icon, pro }. Returns
        // { update({ label, hint, locked }), dispose() }
        registerTool(tool) {
            if (!tool || typeof tool.id !== 'string' || typeof tool.command !== 'string') {
                throw new TypeError('A tool needs an id and a command');
            }
            const text = (value) => (typeof value === 'string' ? value.slice(0, 200) : '');
            const entry = {
                id: tool.id,
                label: text(tool.label) || tool.id,
                hint: text(tool.hint),
                icon: typeof tool.icon === 'string' ? tool.icon : undefined,
                command: tool.command,
                args: Array.isArray(tool.args) ? tool.args.filter(arg => ['string', 'number', 'boolean'].includes(typeof arg)) : [],
                pro: tool.pro === true,
                locked: tool.locked === true,
            };
            tools.set(entry.id, entry);
            viewer.featuresChanged();
            return {
                update(changes) {
                    if (changes && typeof changes === 'object') {
                        if (typeof changes.label === 'string') {
                            entry.label = text(changes.label) || entry.id;
                        }
                        if (typeof changes.hint === 'string') {
                            entry.hint = text(changes.hint);
                        }
                        if (typeof changes.locked === 'boolean') {
                            entry.locked = changes.locked;
                        }
                        viewer.featuresChanged();
                    }
                },
                dispose() {
                    if (tools.get(entry.id) === entry) {
                        tools.delete(entry.id);
                        viewer.featuresChanged();
                    }
                },
            };
        },
        // Sections of the inspector of a table: provide(table, schema) returns (or resolves to) a list of
        // { title, items: [{ label, value, hint, tone, badge }], actions: [{ label, command, args }],
        // note, locked }. Returns a Disposable
        registerTableInfoProvider(provider) {
            if (!provider || typeof provider.id !== 'string' || typeof provider.provide !== 'function') {
                throw new TypeError('A table info provider needs an id and a provide(table, schema) function');
            }
            tableProviders.set(provider.id, provider.provide);
            return {
                dispose() {
                    if (tableProviders.get(provider.id) === provider.provide) {
                        tableProviders.delete(provider.id);
                    }
                },
            };
        },
        // The license of DrawMeDatabase Pro, shown at the bottom of the side panel:
        // { kind: 'licensed' | 'trial' | 'expired' | 'development', daysLeft, commands: { buy, enter, manage } },
        // or null (not installed)
        setLicenseStatus(status) {
            if (status && LICENSE_KINDS.includes(status.kind)) {
                const commands = {};
                for (const action of ['buy', 'enter', 'manage']) {
                    if (status.commands && typeof status.commands[action] === 'string') {
                        commands[action] = status.commands[action];
                    }
                }
                license = { kind: status.kind, daysLeft: Number.isFinite(status.daysLeft) ? Math.max(0, Math.round(status.daysLeft)) : undefined, commands };
            } else {
                license = null;
            }
            viewer.featuresChanged();
        },
        // Shows these tables only (with the relations between them), the highlighted ones standing
        // out, and a label to go back to the whole schema: { tables, highlight, label }
        focusTables(focus) {
            viewer.focus(focus);
        },
        // The diagram on screen as an SVG file (text), or null when none is drawn
        getDiagramSvg: () => viewer.requestSvg(),
        // The appearance of the pages and their language (version 2): { theme, palette, colors, font,
        // customFont, fontSize, grid, language ('en', 'fr') }, for DrawMeDatabaseAppearance.apply() and
        // DrawMeDatabaseI18n.translator() in other panels; the event fires when they change
        getDisplaySettings: displaySettings,
        onDidChangeDisplaySettings: displayChanged.event,
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
        const elsewhere = path.isAbsolute(frameworkPath) ? tr('message.frameworkPathElsewhere') : '';
        showError(frameworkPath
            ? tr('message.frameworkPathMissing', { path: frameworkPath, folder: folder.uri.fsPath, elsewhere })
            : tr('message.folderMissing', { path: basePath }));
        return undefined;
    }

    let result;
    let framework;
    try {
        // Framework detection
        framework = detectFramework(basePath);
        output.appendLine(`Framework: ${framework} (${basePath})`);
        if (!Object.prototype.hasOwnProperty.call(PARSERS, framework)) {
            const hint = tr(frameworkPath ? 'message.noFramework.checkSetting' : 'message.noFramework.setSetting');
            showError(tr('message.noFramework', { path: basePath, hint }));
            return undefined;
        }

        // Parsing
        // columnSources: the line of each column, opened from the inspector of the page
        result = PARSERS[framework]().parse(basePath, { overrides, gitCache, git, columnSources: true });
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
        tell(vscode.window.showInformationMessage, tr('message.noTables', { path: basePath }));
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
    vscode.window.showErrorMessage(tr('message.unexpected'), tr('message.showOutput')).then(choice => {
        if (choice) {
            output.show();
        }
    });
}

// One non-blocking message per run, the warnings themselves are in the output channel
function reportWarnings(output, count) {
    vscode.window.showWarningMessage(tr('message.warnings', { count }), tr('message.showOutput')).then(choice => {
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

// A section of the inspector from another extension, kept to the known fields and sizes; its
// actions are stored in `actions` (id → { command, args }) and posted with their id only
const SECTION_TONES = ['added', 'modified', 'removed', 'muted', 'accent'];
function cleanSection(section, actions) {
    if (!section || typeof section !== 'object' || typeof section.title !== 'string' || !section.title.trim()) {
        return null;
    }
    const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);
    const items = (Array.isArray(section.items) ? section.items : []).slice(0, 200)
        .filter(item => item && typeof item.label === 'string')
        .map(item => ({
            label: text(item.label, 200),
            value: text(item.value, 200),
            hint: text(item.hint, 300),
            badge: text(item.badge, 40),
            tone: SECTION_TONES.includes(item.tone) ? item.tone : undefined,
        }));
    const sectionActions = (Array.isArray(section.actions) ? section.actions : []).slice(0, 8)
        .filter(action => action && typeof action.label === 'string' && typeof action.command === 'string')
        .map(action => {
            const id = `action-${actions.size + 1}`;
            actions.set(id, { command: action.command, args: Array.isArray(action.args) ? action.args.filter(arg => ['string', 'number', 'boolean'].includes(typeof arg)) : [] });
            return { id, label: text(action.label, 80) };
        });
    return { title: text(section.title, 80), items, actions: sectionActions, note: text(section.note, 500), locked: section.locked === true };
}

// A single webview panel. The page is loaded once: the schema and the settings are posted to it
// (again when it reloads, after being restored), and it asks for refreshes and exports.
function createViewer(context, output, { refresh, exportFolder, openTable, onClose, exporters, schemaFor, features, runTool, runLicenseAction, tableInfo, runTableAction }) {
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
        for (const key of Object.keys(SETTINGS)) {
            message[key] = readSetting(config, key);
        }
        message.languageResolved = i18n.resolveLanguage(message.language, vscode.env && vscode.env.language);
        return message;
    };

    const updateSetting = (key, value) => Promise.resolve(vscode.workspace.getConfiguration('DrawMeDatabase')
        .update(key, value, vscode.ConfigurationTarget.Global))
        .catch(err => reportUnexpectedError(output, err));

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
                post({ type: 'features', ...features() });
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
            case 'setting': {
                const value = typeof message.key === 'string' ? settingValue(message.key, message.value) : undefined;
                if (value !== undefined) {
                    updateSetting(message.key, value);
                }
                break;
            }
            case 'resetAppearance':
                APPEARANCE_SETTINGS.forEach(key => updateSetting(key, undefined));
                break;
            case 'tool':
                if (typeof message.id === 'string') {
                    runTool(message.id);
                }
                break;
            case 'license':
                if (typeof message.action === 'string') {
                    runLicenseAction(message.action);
                }
                break;
            case 'openSettings': {
                const query = message.target === 'frameworkPath' ? 'DrawMeDatabase.frameworkPath' : '@ext:GuillaumeCancalon.draw-me-database';
                Promise.resolve(vscode.commands.executeCommand('workbench.action.openSettings', query))
                    .catch(err => reportUnexpectedError(output, err));
                break;
            }
            case 'save':
                saveExport(message).catch(err => reportUnexpectedError(output, err));
                break;
            case 'copy':
                if (typeof message.content === 'string' && message.content.length <= MAX_EXPORT_LENGTH) {
                    Promise.resolve(vscode.env.clipboard.writeText(message.content))
                        .then(() => toast(tr(message.format === 'json' ? 'message.copiedJson' : 'message.copiedMermaid')))
                        .catch(err => reportUnexpectedError(output, err));
                }
                break;
            case 'showOutput':
                output.show();
                break;
            case 'open':
                openTable(message.table);
                break;
            case 'openColumn':
                if (typeof message.column === 'string') {
                    openTable(message.table, message.column);
                }
                break;
            case 'tableInfo':
                if (typeof message.table === 'string') {
                    tableInfo(message.table)
                        .then(info => post({ type: 'tableInfo', table: message.table, request: message.request, ...info }))
                        .catch(err => reportUnexpectedError(output, err));
                }
                break;
            case 'tableAction':
                if (typeof message.id === 'string') {
                    runTableAction(message.id);
                }
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
        await saveFile(message.content, { extension: message.format, label: tr(format.label), binary: format.binary }, message.fileName);
    }

    async function saveFile(content, { extension, label, binary }, suggestedName) {
        const requested = typeof suggestedName === 'string' ? path.basename(suggestedName) : '';
        const fileName = requested.endsWith(`.${extension}`) ? requested : `schema.${extension}`;
        const folder = exportFolder();
        const uri = await vscode.window.showSaveDialog({
            defaultUri: folder ? vscode.Uri.joinPath(folder.uri, fileName) : undefined,
            filters: { [label]: [extension] },
            saveLabel: tr('save.label'),
            title: tr('save.title'),
        });
        if (!uri) {
            return;
        }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, binary ? 'base64' : 'utf8'));
        const open = tr('message.open');
        const choice = await vscode.window.showInformationMessage(tr('message.exported', { file: path.basename(uri.fsPath) }), open);
        if (choice === open) {
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
            post({ type: 'features', ...features() });
        },
        featuresChanged() {
            post({ type: 'features', ...features() });
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

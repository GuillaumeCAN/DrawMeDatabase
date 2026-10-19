//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// extension.js with a mocked 'vscode' module (and stubbed framework parsers: their real detection
// and sources, a stubbed parse()): the command flow, the messages shown to the user and the
// webview panel, without VS Code.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const { ParserError } = require('../../parsers/errors');
const html = require('../../views/html');

const ROOT = path.join(__dirname, '..', '..');

// The settings posted to the page when nothing is configured
const DEFAULT_SETTINGS = {
    type: 'settings',
    layout: 'elk',
    direction: 'TB',
    showGitStatus: true,
    showColumnGitStatus: true,
    keysOnly: false,
    relationLabels: true,
    autoRefresh: true,
    language: 'auto',
    theme: 'auto',
    palette: 'vscode',
    font: 'default',
    grid: true,
    fontSize: 13,
    customFont: '',
    colors: {},
    languageResolved: 'en',
    pro: false,
};
const EXTENSION = path.join(ROOT, 'extension.js');
const REGISTRY = path.join(ROOT, 'parsers', 'registry.js');
const PRO_ID = 'GuillaumeCancalon.draw-me-database-pro';
const WEBVIEW_ROOT = 'https://webview.test/';

class Uri {
    constructor(fsPath) {
        this.fsPath = fsPath;
    }

    static file(fsPath) {
        return new Uri(path.resolve(fsPath));
    }

    static joinPath(base, ...segments) {
        return new Uri(path.join(base.fsPath, ...segments));
    }

    static from(components) {
        return Object.assign(new Uri(components.path), components);
    }

    toString() {
        return `file://${this.fsPath}`;
    }
}

const emitter = () => {
    const listeners = new Set();
    const event = (listener) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
    };
    event.fire = (value) => [...listeners].forEach(listener => listener(value));
    event.count = () => listeners.size;
    return event;
};

// The parts of the VS Code API used by extension.js. Messages resolve to state.answer
// (the button the user clicks, undefined = dismissed), the Save dialog to state.saveUri.
function createVscode(state) {
    const message = (list) => (text, ...items) => {
        list.push({ text, items });
        return Promise.resolve(state.answer);
    };
    const onConfiguration = emitter();
    const onChangeDocument = emitter();
    const onSaveDocument = emitter();
    const onCloseDocument = emitter();
    const onWorkspaceFolders = emitter();

    // A tree view of the Activity Bar; show(visible) shows or hides it like the user does
    function createTreeView(id, options) {
        const onVisibility = emitter();
        const view = {
            id,
            options,
            visible: state.visibleViews.includes(id),
            description: undefined,
            onDidChangeVisibility: onVisibility,
            disposed: false,
            show(visible = true) {
                view.visible = visible;
                onVisibility.fire({ visible });
            },
            // The items of the view (TreeItems with their children), as VS Code asks for them
            items(node) {
                return options.treeDataProvider.getChildren(node).map(child => {
                    const item = options.treeDataProvider.getTreeItem(child);
                    return { ...item, node: child, children: item.collapsibleState ? view.items(child) : [] };
                });
            },
            dispose() {
                view.disposed = true;
            },
        };
        return view;
    }

    function createPanel(viewType, title, column, options) {
        const onMessage = emitter();
        const onDispose = emitter();
        const panel = {
            viewType, title, options,
            pages: [],
            posted: [],
            reveals: 0,
            disposed: false,
            iconPath: undefined,
            webview: {
                options: undefined,
                cspSource: 'https://webview.test',
                asWebviewUri: (uri) => ({ toString: () => WEBVIEW_ROOT + path.relative(ROOT, uri.fsPath).split(path.sep).join('/') }),
                onDidReceiveMessage: onMessage,
                postMessage: (value) => {
                    panel.posted.push(value);
                    return Promise.resolve(true);
                },
                set html(value) {
                    panel.pages.push(value);
                },
                get html() {
                    return panel.pages[panel.pages.length - 1];
                },
            },
            reveal: () => panel.reveals++,
            onDidDispose: onDispose,
            dispose() {
                panel.disposed = true;
                onDispose.fire();
            },
            postFromPage: (value) => onMessage.fire(value),
            listeners: () => onMessage.count(),
            // The messages of a type posted to the page
            sent: (type) => panel.posted.filter(posted => posted.type === type),
        };
        return panel;
    }

    return {
        Uri,
        Range: class Range {
            constructor(startLine, startCharacter, endLine, endCharacter) {
                Object.assign(this, { startLine, startCharacter, endLine, endCharacter });
            }
        },
        RelativePattern: class RelativePattern {
            constructor(base, pattern) {
                Object.assign(this, { base, pattern });
            }
        },
        StatusBarAlignment: { Left: 1, Right: 2 },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        TreeItem: class TreeItem {
            constructor(label, collapsibleState) {
                Object.assign(this, { label, collapsibleState });
            }
        },
        ThemeIcon: class ThemeIcon {
            constructor(id, color) {
                Object.assign(this, { id, color });
            }
        },
        ThemeColor: class ThemeColor {
            constructor(id) {
                this.id = id;
            }
        },
        FileDecoration: class FileDecoration {
            constructor(badge, tooltip, color) {
                Object.assign(this, { badge, tooltip, color });
            }
        },
        EventEmitter: class EventEmitter {
            constructor() {
                this.event = emitter();
            }

            fire(value) {
                this.event.fire(value);
            }

            dispose() {}
        },
        ViewColumn: { One: 1, Beside: -2 },
        ConfigurationTarget: { Global: 1, Workspace: 2 },
        window: {
            get activeTextEditor() {
                return state.activeTextEditor;
            },
            createOutputChannel: () => ({
                appendLine: (line) => state.output.push(line),
                show: () => state.outputShown++,
                dispose() {},
            }),
            createStatusBarItem: () => ({ show() {}, dispose() {} }),
            showErrorMessage: message(state.errors),
            showWarningMessage: message(state.warnings),
            showInformationMessage: message(state.infos),
            showSaveDialog: (options) => {
                state.saveDialogs.push(options);
                return Promise.resolve(state.saveUri);
            },
            createWebviewPanel(...args) {
                const panel = createPanel(...args);
                state.panels.push(panel);
                return panel;
            },
            showTextDocument(uri, options) {
                state.opened.push({ path: uri.fsPath, options });
                return Promise.resolve();
            },
            registerWebviewPanelSerializer(viewType, serializer) {
                state.serializers.set(viewType, serializer);
                return { dispose: () => state.serializers.delete(viewType) };
            },
            createTreeView(id, options) {
                const view = createTreeView(id, options);
                state.treeViews.set(id, view);
                return view;
            },
            registerFileDecorationProvider(provider) {
                state.decorations.push(provider);
                return { dispose: () => state.decorations.splice(state.decorations.indexOf(provider), 1) };
            },
        },
        workspace: {
            get workspaceFolders() {
                return state.folders;
            },
            getWorkspaceFolder: (uri) => state.folders.find(folder => uri.fsPath.startsWith(folder.uri.fsPath + path.sep)),
            getConfiguration: (section, scope) => ({
                get: (key, defaultValue) => {
                    const settings = state.settings[scope ? scope.fsPath : ''] || {};
                    const name = `${section}.${key}`;
                    return Object.prototype.hasOwnProperty.call(settings, name) ? settings[name] : defaultValue;
                },
                update: (key, value, target) => {
                    state.updates.push({ key: `${section}.${key}`, value, target });
                    return Promise.resolve();
                },
            }),
            onDidChangeConfiguration: onConfiguration,
            get textDocuments() {
                return state.documents;
            },
            onDidChangeTextDocument: onChangeDocument,
            onDidSaveTextDocument: onSaveDocument,
            onDidCloseTextDocument: onCloseDocument,
            onDidChangeWorkspaceFolders: onWorkspaceFolders,
            createFileSystemWatcher(pattern) {
                const events = { change: emitter(), create: emitter(), delete: emitter() };
                const watcher = {
                    pattern,
                    disposed: false,
                    onDidChange: events.change,
                    onDidCreate: events.create,
                    onDidDelete: events.delete,
                    fire: (kind) => events[kind].fire(Uri.file(path.join(pattern.base.fsPath, 'x.php'))),
                    dispose() {
                        watcher.disposed = true;
                    },
                };
                state.watchers.push(watcher);
                return watcher;
            },
            fs: {
                writeFile: (uri, data) => {
                    state.written.push({ path: uri.fsPath, data: Buffer.from(data) });
                    return Promise.resolve();
                },
            },
        },
        extensions: {
            getExtension: (id) => (id === 'vscode.git' ? state.gitExtension : id === PRO_ID ? state.proExtension : undefined),
        },
        env: {
            clipboard: {
                writeText: (text) => {
                    state.clipboard.push(text);
                    return Promise.resolve();
                },
            },
        },
        commands: {
            registerCommand(id, callback) {
                state.commands.set(id, callback);
                return { dispose: () => state.commands.delete(id) };
            },
            // The context keys go to state.context, the other commands to state.executed
            executeCommand(id, ...args) {
                if (id === 'setContext') {
                    state.context[args[0]] = args[1];
                } else {
                    state.executed.push({ id, args });
                }
                if (state.failingCommands.has(id)) {
                    return Promise.reject(new Error(`Extension '${args[0]}' not found.`));
                }
                return Promise.resolve();
            },
        },
        // Fires a configuration change of the given settings
        changeConfiguration: (...names) => onConfiguration.fire({ affectsConfiguration: (name) => names.includes(name) }),
        // Editor events: an edit (not saved), a save, the closing of an editor
        editDocument: (document) => onChangeDocument.fire({ document, contentChanges: [{ text: 'x' }] }),
        saveDocument: (document) => onSaveDocument.fire(document),
        closeDocument: (document) => onCloseDocument.fire(document),
        createPanel,
    };
}

// 'vscode' as extension.js requires it, and the framework parsers as the registry requires them
let mocks;
const originalLoad = Module._load;

test.before(() => {
    Module._load = function (request, parent, ...rest) {
        if (mocks && request === 'vscode') {
            return mocks.vscode;
        }
        if (mocks && parent && parent.filename === REGISTRY && Object.prototype.hasOwnProperty.call(mocks.parsers, request)) {
            return mocks.parsers[request];
        }
        return originalLoad.call(this, request, parent, ...rest);
    };
});

test.after(() => {
    Module._load = originalLoad;
});

// Activates a fresh copy of extension.js. parse(basePath) is the stubbed parse() of both frameworks
// (their detect() and sources() are the real ones), initial overrides the initial state (e.g.
// gitExtension, read when the extension activates).
function activate(parse = () => ({ tables: TABLES, warnings: [] }), initial = {}) {
    const state = {
        answer: undefined,
        activeTextEditor: undefined,
        folders: [],
        settings: {},
        commands: new Map(),
        panels: [],
        errors: [],
        warnings: [],
        infos: [],
        output: [],
        outputShown: 0,
        parsed: [],
        serializers: new Map(),
        updates: [],
        saveDialogs: [],
        saveUri: undefined,
        written: [],
        clipboard: [],
        executed: [],
        // Commands that reject, like extension.open for an extension the Marketplace does not know
        failingCommands: new Set(),
        opened: [],
        watchers: [],
        documents: [],
        gitExtension: undefined,
        parseOptions: [],
        // Views of the Activity Bar: the ones visible when the extension activates, the views by
        // id, the decoration providers, the context keys
        visibleViews: [],
        treeViews: new Map(),
        decorations: [],
        context: {},
        ...initial,
    };
    const stub = (real) => ({
        ...real,
        parse: (basePath, options) => {
            state.parsed.push(basePath);
            state.parseOptions.push(options);
            return parse(basePath, options);
        },
    });
    mocks = {
        vscode: createVscode(state),
        parsers: { './laravel': stub(require('../../parsers/laravel')), './symfony': stub(require('../../parsers/symfony')), './prisma': stub(require('../../parsers/prisma')) },
    };

    delete require.cache[EXTENSION];
    const extension = require(EXTENSION);
    const context = { subscriptions: [], extensionUri: Uri.file(ROOT), extensionPath: ROOT };
    context.api = extension.activate(context);

    return {
        state,
        context,
        vscode: mocks.vscode,
        run: () => state.commands.get('DMDB.parseSchema')(),
        openFolders: (...folderPaths) => {
            state.folders = folderPaths.map((folderPath, index) => ({ uri: Uri.file(folderPath), name: path.basename(folderPath), index }));
        },
        setFrameworkPath: (folderPath, value) => {
            state.settings[path.resolve(folderPath)] = { 'DrawMeDatabase.frameworkPath': value };
        },
        openEditor: (filePath) => {
            state.activeTextEditor = { document: { uri: Uri.file(filePath) } };
        },
    };
}

const TABLES = [
    { table: 'users', columns: [{ name: 'id', type: 'bigIncrements', primary: true }], relations: [] },
    {
        table: 'posts',
        columns: [{ name: 'user_id', type: 'unsignedBigInteger' }],
        relations: [{ foreignKey: 'user_id', references: 'id', on: 'users', type: 'many-to-one' }],
    },
];

// Workspaces on disk, for the real framework detection
let tmpRoot;
const LARAVEL = { artisan: '', 'composer.json': JSON.stringify({ require: { 'laravel/framework': '^12.0' } }) };
const SYMFONY = { 'bin/console': '', 'composer.json': JSON.stringify({ require: { 'symfony/framework-bundle': '^7.4' } }) };
const PRISMA = { 'package.json': JSON.stringify({ devDependencies: { prisma: '^7.10.1' } }), 'prisma/schema/schema.prisma': 'datasource db {\n  provider = "postgresql"\n}\n' };

function folder(name, files = {}) {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), content);
    }
    return dir;
}

test.before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmdb-extension-'));
});

test.after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const flush = () => new Promise(resolve => setImmediate(resolve));

// DrawMeDatabase Pro as VS Code gives it to other extensions: activate() resolves to its exports,
// frozen like the ones of Pro (frozen: false, exports that another extension could change).
// connect() calls connectPro() as Pro does; set(status) changes its license and fires its event.
function installPro(ext, status, { frozen = true } = {}) {
    let current = status;
    const listeners = new Set();
    const exports = {
        licenseStatus: () => current,
        onDidChangeLicenseStatus: (listener) => {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        },
    };
    ext.state.proExtension = { id: PRO_ID, isActive: false, exports: undefined, activate: () => Promise.resolve(frozen ? Object.freeze(exports) : exports) };
    return {
        exports,
        listeners,
        connect: () => ext.context.api.connectPro(),
        set(value) {
            current = value;
            [...listeners].forEach(listener => listener());
        },
    };
}

// The script and stylesheet URLs of a page
const pageUrls = (page) => [...page.matchAll(/(?:src|href)="([^"]*)"/g)].map(match => match[1]);

test('draws the schema in one panel: the page once, then the settings and the schema', async () => {
    const ext = activate(() => ({ tables: TABLES, warnings: ['x.php:1: skipped'] }));
    const dir = folder('draw', LARAVEL);
    ext.openFolders(dir);

    assert.deepEqual(ext.run(), TABLES);
    assert.equal(ext.state.panels.length, 1);
    const panel = ext.state.panels[0];
    assert.equal(panel.viewType, 'drawMeDatabase');
    assert.equal(panel.options.enableScripts, true);
    assert.equal(panel.options.retainContextWhenHidden, true);
    assert.deepEqual(panel.options.localResourceRoots.map(uri => uri.fsPath), [path.join(ROOT, 'views')]);
    assert.deepEqual(panel.webview.options.localResourceRoots.map(uri => uri.fsPath), [path.join(ROOT, 'views')]);
    assert.equal(panel.iconPath.fsPath, path.join(ROOT, 'images', 'logo_128.png'));
    assert.deepEqual(ext.state.errors, []);

    const page = panel.webview.html;
    assert.ok(!page.includes('{{'), 'every placeholder is filled');
    assert.ok(page.includes('<title>DrawMeDatabase</title>'));
    assert.match(page, /content="default-src &#39;none&#39;; script-src &#39;nonce-[^&]+&#39;; style-src https:\/\/webview.test /);
    assert.deepEqual(pageUrls(page), ['views/theme.css', ...html.SCRIPTS.map(segments => `views/${segments.join('/')}`)].map(file => WEBVIEW_ROOT + file));
    for (const file of pageUrls(page).map(url => url.slice(WEBVIEW_ROOT.length)).filter(file => !file.startsWith('views/vendor/'))) {
        assert.ok(fs.existsSync(path.join(ROOT, file)), file);
    }

    // Nothing is posted before the page is ready
    assert.deepEqual(panel.posted, []);
    panel.postFromPage({ type: 'ready' });
    assert.deepEqual(panel.posted.filter(message => message.type !== 'features'), [
        DEFAULT_SETTINGS,
        { type: 'exporters', items: [], pro: false },
        {
            type: 'schema',
            tables: TABLES,
            warnings: 1,
            project: { name: 'draw', folder: Uri.file(dir).toString(), framework: 'laravel', frameworkLabel: 'Laravel' },
        },
    ]);

    // A reload of the page (restored panel) gets everything again
    panel.postFromPage({ type: 'ready' });
    assert.equal(panel.sent('schema').length, 2);
    assert.equal(panel.pages.length, 1);
});

test('invalid messages from the page are ignored', async () => {
    const ext = activate();
    ext.openFolders(folder('messages', LARAVEL));
    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });
    const posted = panel.posted.length;

    for (const message of [
        { type: 'setting', key: 'layout', value: 'circle' },
        { type: 'setting', key: 'frameworkPath', value: '/etc' },
        { type: 'setting', key: 'constructor', value: 'elk' },
        { type: 'save', format: 'exe', content: 'MZ' },
        { type: 'save', format: 'toString', content: 'x' },
        { type: 'save', format: 'svg', content: 42 },
        { type: 'copy', content: { text: 'x' } },
        { type: 'changeViewer', viewer: 'json' },
        { type: 'other' },
        { command: 'changeViewer', viewer: 'json' },
        null,
        'json',
    ]) {
        panel.postFromPage(message);
    }
    await flush();
    assert.equal(panel.posted.length, posted);
    assert.equal(panel.pages.length, 1);
    assert.deepEqual(ext.state.updates, []);
    assert.deepEqual(ext.state.saveDialogs, []);
    assert.deepEqual(ext.state.clipboard, []);
    assert.deepEqual(ext.state.errors, []);
});

test('a new run reuses the panel and posts the new schema; once closed, the next run opens a new one', () => {
    const ext = activate();
    ext.openFolders(folder('reuse', LARAVEL));
    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });

    ext.run();
    assert.equal(ext.state.panels.length, 1);
    assert.equal(panel.reveals, 1);
    assert.equal(panel.pages.length, 1, 'the page is not reloaded');
    assert.equal(panel.sent('schema').length, 2);

    panel.dispose();
    assert.equal(panel.listeners(), 0, 'the message listener is disposed');
    ext.run();
    assert.equal(ext.state.panels.length, 2);

    // Deactivation disposes the panel
    ext.context.subscriptions.forEach(item => item.dispose());
    assert.equal(ext.state.panels[1].disposed, true);
});

test('the settings come from the configuration, the toolbar changes them globally', async () => {
    const ext = activate();
    ext.openFolders(folder('settings', LARAVEL));
    ext.state.settings[''] = { 'DrawMeDatabase.layout': 'dagre', 'DrawMeDatabase.direction': 'sideways' };
    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });
    assert.deepEqual(panel.sent('settings'), [{ ...DEFAULT_SETTINGS, layout: 'dagre' }]);

    panel.postFromPage({ type: 'setting', key: 'direction', value: 'LR' });
    panel.postFromPage({ type: 'setting', key: 'layout', value: 'elk' });
    assert.deepEqual(ext.state.updates, [
        { key: 'DrawMeDatabase.direction', value: 'LR', target: 1 },
        { key: 'DrawMeDatabase.layout', value: 'elk', target: 1 },
    ]);

    ext.state.settings[''] = { 'DrawMeDatabase.layout': 'elk', 'DrawMeDatabase.direction': 'LR' };
    ext.vscode.changeConfiguration('DrawMeDatabase.direction');
    ext.vscode.changeConfiguration('DrawMeDatabase.frameworkPath');
    assert.deepEqual(panel.sent('settings'), [
        { ...DEFAULT_SETTINGS, layout: 'dagre' },
        { ...DEFAULT_SETTINGS, layout: 'elk', direction: 'LR' },
    ]);

    // The frameworkPath change scheduled a refresh: deactivation cancels it
    ext.context.subscriptions.forEach(item => item.dispose());
});

test('an export is written where the user chooses, then can be opened', async () => {
    const ext = activate();
    const dir = folder('export', LARAVEL);
    ext.openFolders(dir);
    ext.run();
    const panel = ext.state.panels[0];

    // Cancelled: nothing is written
    panel.postFromPage({ type: 'save', format: 'svg', content: '<svg/>', fileName: 'export-schema.svg' });
    await flush();
    assert.equal(ext.state.saveDialogs.length, 1);
    assert.equal(ext.state.saveDialogs[0].defaultUri.fsPath, path.join(dir, 'export-schema.svg'));
    assert.deepEqual(ext.state.saveDialogs[0].filters, { 'SVG image': ['svg'] });
    assert.deepEqual(ext.state.written, []);

    ext.state.saveUri = Uri.file(path.join(dir, 'out.svg'));
    ext.state.answer = 'Open';
    panel.postFromPage({ type: 'save', format: 'svg', content: '<svg>é</svg>', fileName: 'export-schema.svg' });
    await flush();
    await flush();
    assert.equal(ext.state.written.length, 1);
    assert.equal(ext.state.written[0].data.toString('utf8'), '<svg>é</svg>');
    assert.deepEqual(ext.state.infos.map(info => info.text), ['Exported to out.svg.']);
    assert.deepEqual(ext.state.executed, [{ id: 'vscode.open', args: [ext.state.saveUri] }]);

    // PNG content is base64; a file name of another type or with a path is not trusted
    ext.state.answer = undefined;
    ext.state.saveUri = Uri.file(path.join(dir, 'out.png'));
    panel.postFromPage({ type: 'save', format: 'png', content: Buffer.from([137, 80, 78, 71]).toString('base64'), fileName: '../../evil.sh' });
    await flush();
    await flush();
    assert.equal(ext.state.saveDialogs[2].defaultUri.fsPath, path.join(dir, 'schema.png'));
    assert.deepEqual([...ext.state.written[1].data], [137, 80, 78, 71]);
    assert.equal(ext.state.executed.length, 1);
});

test('copy puts the text on the clipboard and tells the page', async () => {
    const ext = activate();
    ext.openFolders(folder('copy', LARAVEL));
    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });

    panel.postFromPage({ type: 'copy', format: 'mmd', content: 'erDiagram\n' });
    panel.postFromPage({ type: 'copy', format: 'json', content: '[]' });
    await flush();
    assert.deepEqual(ext.state.clipboard, ['erDiagram\n', '[]']);
    assert.deepEqual(panel.sent('toast').map(toast => toast.text), ['Mermaid source copied to the clipboard.', 'JSON copied to the clipboard.']);
});

test('refresh from the page parses again and shows the progress', async () => {
    const ext = activate();
    ext.openFolders(folder('refresh', LARAVEL));
    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });
    ext.state.parsed = [];

    panel.postFromPage({ type: 'refresh' });
    assert.deepEqual(panel.sent('busy'), [{ type: 'busy', busy: true }]);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(ext.state.parsed.length, 1);
    assert.deepEqual(panel.sent('busy'), [{ type: 'busy', busy: true }, { type: 'busy', busy: false }]);
    assert.equal(panel.sent('schema').length, 2);

    panel.postFromPage({ type: 'showOutput' });
    assert.equal(ext.state.outputShown, 1);
});

test('the drawing reported by the page is exported, its errors are written to the output', () => {
    const ext = activate();
    ext.openFolders(folder('rendered', LARAVEL));
    ext.run();
    const panel = ext.state.panels[0];
    const api = ext.context.api;

    panel.postFromPage({ type: 'rendered', ok: true, layout: 'elk', entities: 2, ms: 120 });
    assert.deepEqual(api.lastRender, { ok: true, layout: 'elk', entities: 2, error: '' });
    panel.postFromPage({ type: 'rendered', ok: false, error: 'Mermaid could not draw the diagram: boom' });
    assert.equal(api.lastRender.ok, false);
    assert.ok(ext.state.output.includes('Diagram error: Mermaid could not draw the diagram: boom'));
});

const SOURCED = [
    { ...TABLES[0], source: { file: 'database/migrations/2024_01_01_000000_create_users_table.php', line: 14 } },
    { ...TABLES[1], source: { file: '../../outside.php', line: 3 } },
];

test('a click on a table opens its source file beside the diagram, inside the project only', async () => {
    const ext = activate(() => ({ tables: SOURCED, warnings: [] }));
    const dir = folder('open', LARAVEL);
    ext.openFolders(dir);
    ext.run();
    const panel = ext.state.panels[0];

    panel.postFromPage({ type: 'open', table: 'users' });
    await flush();
    assert.equal(ext.state.opened.length, 1);
    assert.equal(ext.state.opened[0].path, path.join(dir, 'database', 'migrations', '2024_01_01_000000_create_users_table.php'));
    assert.equal(ext.state.opened[0].options.viewColumn, -2);
    assert.equal(ext.state.opened[0].options.selection.startLine, 13);

    // A source outside the project, an unknown table, or a name that is not a string: nothing opens
    for (const table of ['posts', 'comments', ['users'], undefined]) {
        panel.postFromPage({ type: 'open', table });
    }
    await flush();
    assert.equal(ext.state.opened.length, 1);
});

test('a click opens a Prisma schema set outside of the framework folder (a source of the parser), never another file outside of it', async () => {
    const schemaFile = '../../packages/db/prisma/schema.prisma';
    const ext = activate(() => ({
        tables: [
            { table: 'User', columns: [{ name: 'email', type: 'String', source: { file: schemaFile, line: 7 } }], relations: [], source: { file: schemaFile, line: 5 } },
            { table: 'Seed', columns: [], relations: [], source: { file: '../../packages/db/seed.ts', line: 1 } },
        ],
        warnings: [],
    }));
    const root = folder('prisma-outside', {
        'apps/web/package.json': JSON.stringify({ dependencies: { '@prisma/client': '^6.19.1' } }),
        'apps/web/prisma.config.ts': `export default { schema: '${schemaFile}' }\n`,
        'packages/db/prisma/schema.prisma': 'model User {\n  id Int @id\n}\n',
        'packages/db/seed.ts': '',
    });
    ext.openFolders(root);
    ext.setFrameworkPath(root, 'apps/web');
    ext.run();
    assert.equal(ext.context.api.getSchema().framework, 'prisma');
    const open = ext.state.commands.get('DMDB.openTable');
    open('User');
    open('User', 'email');
    open('Seed');
    await flush();
    const target = path.join(root, 'packages', 'db', 'prisma', 'schema.prisma');
    assert.deepEqual(ext.state.opened.map(item => [item.path, item.options.selection.startLine]), [[target, 4], [target, 6]]);
});

const settle = (ms = 600) => new Promise(resolve => setTimeout(resolve, ms));

test('auto-refresh: a change of the migrations redraws the open diagram, quietly', async () => {
    let result = () => ({ tables: TABLES, warnings: ['w'] });
    const ext = activate(() => result());
    const dir = folder('auto', LARAVEL);
    ext.openFolders(dir);
    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });
    assert.equal(ext.state.watchers.length, 1);
    const watcher = ext.state.watchers[0];
    assert.equal(watcher.pattern.base.fsPath, path.join(dir, 'database', 'migrations'));
    assert.equal(watcher.pattern.pattern, '*.php');
    const warningsShown = ext.state.warnings.length;

    // Several changes in a row: one refresh, without warning popup nor bringing the panel to the front
    result = () => ({ tables: TABLES.slice(0, 1), warnings: ['w'] });
    watcher.fire('change');
    watcher.fire('create');
    watcher.fire('delete');
    await settle();
    assert.equal(ext.state.parsed.length, 2, JSON.stringify(ext.state.parsed));
    assert.equal(panel.sent('schema').length, 2);
    assert.equal(panel.reveals, 0);
    assert.equal(ext.state.warnings.length, warningsShown);
    assert.equal(ext.state.watchers.length, 1, 'the same folder keeps its watcher');

    // A broken migration while editing: the panel stays open with the previous schema
    result = () => {
        throw new ParserError('No PHP migration files found.');
    };
    watcher.fire('change');
    await settle();
    assert.equal(panel.disposed, false);
    assert.deepEqual(ext.state.errors, []);
    assert.match(panel.sent('toast').pop().text, /^The schema could not be read/);

    // Closing the panel stops watching
    panel.dispose();
    assert.equal(watcher.disposed, true);
});

// An editor of a file: { uri, isDirty, getText }
const editor = (filePath, text, isDirty = true) => ({ uri: Object.assign(Uri.file(filePath), { scheme: 'file' }), isDirty, getText: () => text });

test('live diagram: an unsaved edit of a migration is drawn, with the git status kept in cache', async () => {
    const ext = activate();
    const dir = folder('live', LARAVEL);
    ext.openFolders(dir);
    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });
    const migration = path.join(dir, 'database', 'migrations', '2024_01_01_000000_create_users_table.php');
    const first = ext.state.parseOptions[0];
    assert.ok(first.gitCache instanceof Map);
    assert.equal(first.git, true);
    assert.deepEqual([...first.overrides], []);

    // The git status of the last parse, cached
    first.gitCache.set('repo', 'status');
    const typed = editor(migration, '<?php // typing');
    ext.state.documents = [typed, editor(path.join(dir, 'README.md'), 'not a migration'), editor(path.join(dir, 'app', 'User.php'), 'no')];
    ext.vscode.editDocument(typed);
    ext.vscode.editDocument(ext.state.documents[1]);
    await settle(400);
    assert.equal(ext.state.parsed.length, 2);
    const live = ext.state.parseOptions[1];
    assert.deepEqual([...live.overrides], [[path.resolve(migration), '<?php // typing']], 'only the watched migrations');
    assert.equal(live.gitCache.get('repo'), 'status', 'typing does not run git again');
    assert.equal(panel.reveals, 0);
    // Same tables: the page is not asked to draw again
    assert.equal(panel.sent('schema').length, 1);

    // Saving reads the git status again
    ext.vscode.saveDocument(typed);
    await settle();
    assert.equal(ext.state.parsed.length, 3);
    assert.equal(ext.state.parseOptions[2].gitCache.has('repo'), false);

    // Edits of other files are ignored
    ext.vscode.editDocument(ext.state.documents[1]);
    await settle(400);
    assert.equal(ext.state.parsed.length, 3);
    ext.context.subscriptions.forEach(item => item.dispose());
});

test('live diagram of a Symfony project: the unsaved entities of src/Entity and of its sub-folders', async () => {
    const ext = activate();
    const dir = folder('live-symfony', SYMFONY);
    ext.openFolders(dir);
    ext.run();
    ext.state.panels[0].postFromPage({ type: 'ready' });
    assert.equal(ext.state.watchers.length, 1);
    assert.equal(ext.state.watchers[0].pattern.base.fsPath, path.join(dir, 'src', 'Entity'));
    assert.equal(ext.state.watchers[0].pattern.pattern, '**/*.php');

    const entity = path.join(dir, 'src', 'Entity', 'Blog', 'Post.php');
    const typed = editor(entity, '<?php // typing');
    const repository = editor(path.join(dir, 'src', 'Repository', 'PostRepository.php'), '<?php // not an entity');
    ext.state.documents = [typed, repository, editor(path.join(dir, 'src', 'Entity', 'notes.md'), 'not PHP')];
    ext.vscode.editDocument(typed);
    await settle(400);
    assert.equal(ext.state.parsed.length, 2);
    assert.deepEqual([...ext.state.parseOptions[1].overrides], [[path.resolve(entity), '<?php // typing']], 'only the watched entities');

    ext.vscode.editDocument(repository);
    await settle(400);
    assert.equal(ext.state.parsed.length, 2, 'a file outside of src/Entity is not followed');
    ext.context.subscriptions.forEach(item => item.dispose());
});

test('live diagram of a Prisma project: the unsaved .prisma files of its schema folder, package.json and prisma.config.ts', async () => {
    const ext = activate();
    const dir = folder('live-prisma', PRISMA);
    ext.openFolders(dir);
    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });
    assert.equal(ext.context.api.getSchema().framework, 'prisma');
    assert.equal(panel.sent('schema').at(-1).project.frameworkLabel, 'Prisma');
    assert.ok(ext.state.output.includes(`Framework: prisma (${dir})`));
    assert.deepEqual(ext.state.watchers.map(watcher => [watcher.pattern.base.fsPath, watcher.pattern.pattern]), [
        [path.join(dir, 'prisma', 'schema'), '**/*.prisma'],
        [dir, 'package.json'],
        [dir, 'prisma.config.ts'],
    ]);

    const model = path.join(dir, 'prisma', 'schema', 'models', 'post.prisma');
    const typed = editor(model, 'model Post {\n  id Int @id\n}\n');
    const config = editor(path.join(dir, 'prisma.config.ts'), 'export default {}\n');
    const seed = editor(path.join(dir, 'prisma', 'seed.ts'), '// not the schema');
    ext.state.documents = [typed, config, seed];
    ext.vscode.editDocument(typed);
    await settle(400);
    assert.equal(ext.state.parsed.length, 2);
    assert.deepEqual([...ext.state.parseOptions[1].overrides], [[path.resolve(model), 'model Post {\n  id Int @id\n}\n'], [path.resolve(config.uri.fsPath), 'export default {}\n']], 'the schema files and the config file');

    ext.vscode.editDocument(seed);
    await settle(400);
    assert.equal(ext.state.parsed.length, 2, 'a file outside of the sources is not followed');
    // The API gives the same sources
    assert.equal(ext.context.api.getSources(dir, 'prisma').folders[0].path, path.join(dir, 'prisma', 'schema'));
    ext.context.subscriptions.forEach(item => item.dispose());
});

test('live diagram of a Prisma project: an unsaved package.json that moves the schema moves the sources, and the new schema file is followed', async () => {
    const ext = activate();
    const pkg = (extra = {}) => JSON.stringify({ ...extra, devDependencies: { prisma: '6.19.1' } });
    const dir = folder('live-prisma-moved', {
        'package.json': pkg(),
        'prisma/schema.prisma': 'model User {\n  id Int @id\n}\n',
        'alt/schema.prisma': 'model Alt {\n  id Int @id\n}\n',
    });
    ext.openFolders(dir);
    ext.run();
    ext.state.panels[0].postFromPage({ type: 'ready' });
    const watched = () => ext.state.watchers.filter(watcher => !watcher.disposed).map(watcher => path.join(watcher.pattern.base.fsPath, watcher.pattern.pattern));
    assert.deepEqual(watched(), [path.join(dir, 'prisma', 'schema.prisma'), path.join(dir, 'package.json'), path.join(dir, 'prisma.config.ts')]);

    // The unsaved package.json moves the schema to alt/schema.prisma, already being edited too
    const packageEditor = editor(path.join(dir, 'package.json'), pkg({ prisma: { schema: 'alt/schema.prisma' } }));
    const alt = editor(path.join(dir, 'alt', 'schema.prisma'), 'model Alt {\n  id Int @id\n}\n\nmodel AltLive {\n  id Int @id\n}\n');
    ext.state.documents = [packageEditor, alt];
    ext.vscode.editDocument(packageEditor);
    await settle(400);
    assert.equal(ext.state.parsed.length, 2);
    assert.deepEqual([...ext.state.parseOptions[1].overrides.keys()], [path.join(dir, 'package.json'), path.join(dir, 'alt', 'schema.prisma')], 'the unsaved schema it moves to is read');
    assert.deepEqual(watched(), [path.join(dir, 'alt', 'schema.prisma'), path.join(dir, 'package.json'), path.join(dir, 'prisma.config.ts')]);

    // Typing in the new schema file refreshes the diagram
    ext.vscode.editDocument(alt);
    await settle(400);
    assert.equal(ext.state.parsed.length, 3);
    assert.deepEqual([...ext.state.parseOptions[2].overrides.keys()], [path.join(dir, 'package.json'), path.join(dir, 'alt', 'schema.prisma')]);

    // package.json reverted: the schema and the sources are back, the editor of alt/ is no source any more
    packageEditor.isDirty = false;
    ext.vscode.editDocument(packageEditor);
    await settle(400);
    assert.equal(ext.state.parsed.length, 4);
    assert.deepEqual([...ext.state.parseOptions[3].overrides.keys()], []);
    assert.deepEqual(watched(), [path.join(dir, 'prisma', 'schema.prisma'), path.join(dir, 'package.json'), path.join(dir, 'prisma.config.ts')]);
    ext.vscode.editDocument(alt);
    await settle(400);
    assert.equal(ext.state.parsed.length, 4, 'alt/schema.prisma is not followed any more');
    ext.context.subscriptions.forEach(item => item.dispose());
});

test('DrawMeDatabase.framework chooses the parser of a project that matches several of them', async () => {
    const ext = activate();
    const dir = folder('framework-setting', {
        artisan: '',
        'bin/console': '',
        'composer.json': JSON.stringify({ require: { 'laravel/framework': '^12.0', 'symfony/framework-bundle': '^7.4' } }),
    });
    ext.openFolders(dir);

    // Detected: Laravel wins the tie, and the output names the setting
    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });
    assert.equal(ext.context.api.getSchema().framework, 'laravel');
    assert.ok(ext.state.output.includes(`Framework: laravel (${dir})`));
    assert.ok(ext.state.output.includes('Frameworks found: laravel (100), symfony (100). DrawMeDatabase.framework chooses another one.'));
    assert.equal(ext.state.watchers.at(-1).pattern.pattern, '*.php');

    // Set for the folder: the change reads the project again with the parser of Symfony, whose
    // entities are watched instead of the migrations
    ext.state.settings[path.resolve(dir)] = { 'DrawMeDatabase.framework': 'symfony' };
    ext.vscode.changeConfiguration('DrawMeDatabase.framework');
    await settle();
    assert.equal(ext.state.parsed.length, 2);
    assert.equal(ext.context.api.getSchema().framework, 'symfony');
    assert.ok(ext.state.output.includes(`Framework: symfony, set by DrawMeDatabase.framework (${dir})`));
    assert.equal(panel.sent('schema').at(-1).project.frameworkLabel, 'Symfony');
    const live = ext.state.watchers.filter(watcher => !watcher.disposed);
    assert.deepEqual(live.map(watcher => [watcher.pattern.base.fsPath, watcher.pattern.pattern]), [[path.join(dir, 'src', 'Entity'), '**/*.php']]);

    // A value that names no parser: detected, and the output says so
    ext.state.settings[path.resolve(dir)] = { 'DrawMeDatabase.framework': 'rails' };
    ext.run();
    assert.equal(ext.context.api.getSchema().framework, 'laravel');
    assert.ok(ext.state.output.includes('DrawMeDatabase.framework: "rails" is not a supported framework, the framework is detected.'));
    ext.context.subscriptions.forEach(item => item.dispose());
});

test('DrawMeDatabase.framework set for a folder the parser cannot read: its error is shown', () => {
    const ext = activate(() => {
        throw new ParserError('No src/Entity folder found.');
    });
    const dir = folder('framework-forced', LARAVEL);
    ext.openFolders(dir);
    ext.state.settings[path.resolve(dir)] = { 'DrawMeDatabase.framework': 'symfony' };
    assert.equal(ext.run(), undefined);
    assert.deepEqual(ext.state.errors, [{ text: 'No src/Entity folder found.', items: [] }]);
    assert.deepEqual(ext.state.parsed, [dir]);
});

test('a commit or a checkout (built-in Git extension) refreshes the git status of the diagram', async () => {
    const onState = emitter();
    const onRepository = emitter();
    const gitExtension = {
        isActive: true,
        exports: { enabled: true, getAPI: () => ({ repositories: [{ state: { onDidChange: onState } }], onDidOpenRepository: onRepository }) },
    };
    const ext = activate(undefined, { gitExtension });
    ext.openFolders(folder('commit', LARAVEL));
    ext.run();
    await flush();
    assert.equal(onState.count(), 1);
    assert.equal(onRepository.count(), 1);

    ext.state.parseOptions[0].gitCache.set('repo', 'status');
    onState.fire();
    await settle();
    assert.equal(ext.state.parsed.length, 2);
    assert.equal(ext.state.parseOptions[1].gitCache.has('repo'), false, 'git runs again');

    ext.context.subscriptions.forEach(item => item.dispose());
    assert.equal(onState.count(), 0, 'the listeners are disposed');
});

test('the git status can be hidden: no git for the parser, and the setting is posted', async () => {
    const ext = activate();
    ext.openFolders(folder('no-git', LARAVEL));
    ext.state.settings[''] = { 'DrawMeDatabase.showGitStatus': false };
    ext.run();
    assert.equal(ext.state.parseOptions[0].git, false);
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });
    assert.equal(panel.sent('settings')[0].showGitStatus, false);

    panel.postFromPage({ type: 'setting', key: 'showGitStatus', value: true });
    panel.postFromPage({ type: 'setting', key: 'showGitStatus', value: 'yes' });
    assert.deepEqual(ext.state.updates, [{ key: 'DrawMeDatabase.showGitStatus', value: true, target: 1 }]);

    ext.state.settings[''] = {};
    ext.vscode.changeConfiguration('DrawMeDatabase.showGitStatus');
    await settle();
    assert.equal(ext.state.parsed.length, 2);
    assert.equal(ext.state.parseOptions[1].git, true);
    ext.context.subscriptions.forEach(item => item.dispose());
});

test('auto-refresh can be turned off; a new frameworkPath redraws the diagram', async () => {
    const ext = activate();
    const dir = folder('auto-off', LARAVEL);
    ext.openFolders(dir);
    ext.state.settings[''] = { 'DrawMeDatabase.autoRefresh': false };
    ext.run();
    assert.equal(ext.state.watchers.length, 0);

    ext.state.settings[''] = {};
    ext.vscode.changeConfiguration('DrawMeDatabase.autoRefresh');
    assert.equal(ext.state.watchers.length, 1);

    ext.vscode.changeConfiguration('DrawMeDatabase.frameworkPath');
    await settle();
    assert.equal(ext.state.parsed.length, 2);
    ext.context.subscriptions.forEach(item => item.dispose());
});

test('API: the schema on screen, its changes, and the parsers', () => {
    const ext = activate(() => ({ tables: SOURCED, warnings: [] }));
    const api = ext.context.api;
    const dir = folder('api', LARAVEL);
    ext.openFolders(dir);
    assert.equal(api.apiVersion, 3);
    assert.equal(api.getSchema(), null);

    const seen = [];
    const subscription = api.onDidChangeSchema(schema => seen.push(schema));
    ext.run();
    const schema = api.getSchema();
    assert.deepEqual(schema, { tables: SOURCED, framework: 'laravel', basePath: dir, project: { name: 'api', folder: Uri.file(dir).toString() } });
    assert.deepEqual(seen, [schema]);
    schema.tables.length = 0;
    assert.equal(api.getSchema().tables.length, 2, 'a copy: other extensions cannot change it');

    subscription.dispose();
    ext.run();
    assert.equal(seen.length, 1);

    assert.deepEqual(api.parseSchema(dir, 'laravel', { git: false }).tables, SOURCED);
    assert.deepEqual(ext.state.parseOptions.at(-1), { git: false });
    assert.throws(() => api.parseSchema(dir, 'rails'), ParserError);
    assert.equal(api.detectFramework(dir), 'laravel');
    assert.equal(api.detectFramework(dir, { framework: 'symfony' }), 'symfony', 'an id wins over the detection');
    assert.equal(api.detectFramework(folder('api-none')), 'Unknown');

    // Version 3: the supported stacks, and what their parsers read
    assert.deepEqual(api.getFrameworks(), [{ id: 'laravel', label: 'Laravel' }, { id: 'symfony', label: 'Symfony' }, { id: 'prisma', label: 'Prisma' }, { id: 'drizzle', label: 'Drizzle' }, { id: 'sql', label: 'SQL' }]);
    assert.deepEqual(api.getSources(dir, 'laravel'), { folders: [{ path: path.join(dir, 'database', 'migrations'), recursive: false }], files: [], extensions: ['.php'] });
    assert.deepEqual(api.getSources(dir, 'symfony').folders, [{ path: path.join(dir, 'src', 'Entity'), recursive: true }]);
    assert.throws(() => api.getSources(dir, 'rails'), error => error instanceof ParserError && error.message === 'Unknown framework: rails');
    assert.ok(api.viewScripts.includes('vendor/mermaid.min.js') && api.viewScripts.includes('mermaid/diagram.js'));
    assert.ok(!api.viewScripts.includes('app.js'));
    assert.equal(api.viewsUri.fsPath, path.join(ROOT, 'views'));
});

test('API: exports of other extensions are listed in the page and saved like the others', async () => {
    const ext = activate(() => ({ tables: SOURCED, warnings: [] }));
    const api = ext.context.api;
    const dir = folder('api-export', LARAVEL);
    ext.openFolders(dir);
    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });

    const exported = [];
    const registration = api.registerExporter({
        id: 'sql', label: 'Save as SQL…', extension: 'sql',
        export: (schema) => {
            exported.push(schema.tables.map(table => table.table));
            return 'CREATE TABLE users;';
        },
    });
    assert.deepEqual(panel.sent('exporters').at(-1), { type: 'exporters', items: [{ id: 'sql', label: 'Save as SQL…', extension: 'sql' }], pro: false });
    assert.throws(() => api.registerExporter({ id: 'x' }), TypeError);

    ext.state.saveUri = Uri.file(path.join(dir, 'out.sql'));
    panel.postFromPage({ type: 'export', id: 'sql', tables: ['users'] });
    panel.postFromPage({ type: 'export', id: 'unknown', tables: [] });
    await flush();
    await flush();
    assert.deepEqual(exported, [['users']], 'the tables on screen only');
    assert.equal(ext.state.saveDialogs[0].defaultUri.fsPath, path.join(dir, 'api-export-schema.sql'));
    assert.deepEqual(ext.state.saveDialogs[0].filters, { 'Save as SQL…': ['sql'] });
    assert.equal(ext.state.written[0].data.toString(), 'CREATE TABLE users;');

    registration.dispose();
    assert.deepEqual(panel.sent('exporters').at(-1).items, []);

    // Without Pro, the page offers it: its page opens in the Extensions view
    panel.postFromPage({ type: 'pro' });
    await flush();
    assert.deepEqual(ext.state.executed.at(-1), { id: 'extension.open', args: ['GuillaumeCancalon.draw-me-database-pro'] });
});

test('API: focus on tables, also before the panel is ready, and the SVG of the diagram', async () => {
    const ext = activate();
    const api = ext.context.api;
    ext.openFolders(folder('api-focus', LARAVEL));
    assert.equal(await api.getDiagramSvg(), null, 'no diagram yet');
    ext.run();
    const panel = ext.state.panels[0];

    api.focusTables({ tables: ['users', 'posts', 42], highlight: ['users'], label: 'Path: users → posts' });
    assert.deepEqual(panel.sent('focus'), []);
    panel.postFromPage({ type: 'ready' });
    assert.deepEqual(panel.sent('focus'), [{ type: 'focus', tables: ['users', 'posts'], highlight: ['users'], label: 'Path: users → posts' }]);
    api.focusTables({ tables: ['users'] });
    assert.equal(panel.sent('focus').length, 2);
    assert.equal(panel.reveals, 1);

    const svg = api.getDiagramSvg();
    const request = panel.sent('svgRequest')[0];
    panel.postFromPage({ type: 'svg', id: request.id, svg: '<svg/>' });
    assert.equal(await svg, '<svg/>');
    const pending = api.getDiagramSvg();
    panel.dispose();
    assert.equal(await pending, null, 'a closed panel answers null');
});

test('DMDB.refresh draws the schema like DMDB.parseSchema', () => {
    const ext = activate();
    ext.openFolders(folder('refresh-command', LARAVEL));
    assert.deepEqual(ext.state.commands.get('DMDB.refresh')(), TABLES);
    assert.equal(ext.state.panels.length, 1);
});

test('a panel restored after a reload draws the schema of its folder again', async () => {
    const ext = activate();
    const dir = folder('restore', LARAVEL);
    ext.openFolders(dir);
    const serializer = ext.state.serializers.get('drawMeDatabase');
    assert.ok(serializer, 'a serializer is registered for the panel');

    const restored = ext.vscode.createPanel('drawMeDatabase', 'DrawMeDatabase', 1, {});
    await serializer.deserializeWebviewPanel(restored, { viewer: 'json', folder: Uri.file(dir).toString() });
    assert.equal(restored.pages.length, 1);
    assert.equal(restored.webview.options.enableScripts, true);
    assert.deepEqual(ext.state.parsed, [dir]);
    restored.postFromPage({ type: 'ready' });
    assert.equal(restored.sent('schema').length, 1);
    assert.equal(ext.state.panels.length, 0, 'the restored panel is reused');

    // Unknown folder: the page asks the user to draw the schema
    const other = ext.vscode.createPanel('drawMeDatabase', 'DrawMeDatabase', 1, {});
    await serializer.deserializeWebviewPanel(other, { folder: 'file:///elsewhere' });
    assert.equal(restored.disposed, true, 'one panel at a time');
    other.postFromPage({ type: 'ready' });
    assert.equal(other.sent('schema').length, 0);
    assert.deepEqual(other.sent('empty'), [{ type: 'empty', text: 'Run DrawMeDatabase (or click Refresh) to draw the schema of the project.' }]);
    await serializer.deserializeWebviewPanel(ext.vscode.createPanel('drawMeDatabase', 'DrawMeDatabase', 1, {}), undefined);
    assert.equal(ext.state.parsed.length, 1);
});

test('a ParserError is shown as is', () => {
    const ext = activate(() => {
        throw new ParserError('No migrations folder found.');
    });
    ext.openFolders(folder('parser-error', LARAVEL));

    assert.equal(ext.run(), undefined);
    assert.deepEqual(ext.state.errors, [{ text: 'No migrations folder found.', items: [] }]);
    assert.ok(ext.state.output.includes('Error: No migrations folder found.'));
    assert.equal(ext.state.panels.length, 0);
});

test('an unexpected error gives one generic message, the details in the output', async () => {
    const ext = activate(() => {
        throw new TypeError('boom');
    });
    ext.openFolders(folder('unexpected', LARAVEL));
    ext.state.answer = 'Show Output';

    assert.equal(ext.run(), undefined);
    assert.equal(ext.state.errors.length, 1);
    assert.match(ext.state.errors[0].text, /^An unexpected error occurred while drawing the schema\. See the "DrawMeDatabase" output/);
    assert.deepEqual(ext.state.errors[0].items, ['Show Output']);
    assert.ok(ext.state.output.some(line => line.startsWith('Unexpected error: TypeError: boom')));
    await flush();
    assert.equal(ext.state.outputShown, 1, "'Show Output' reveals the output channel");
});

test('an empty schema shows a message and no panel', () => {
    const ext = activate(() => ({ tables: [], warnings: [] }));
    ext.openFolders(folder('empty', LARAVEL));

    assert.deepEqual(ext.run(), []);
    assert.equal(ext.state.panels.length, 0);
    assert.equal(ext.state.infos.length, 1);
    assert.match(ext.state.infos[0].text, /^No tables found in ".*empty"\. Nothing to draw\.$/);
    assert.ok(ext.state.output.includes('Files read: database/migrations/*.php'), 'the output tells what was read');
    assert.deepEqual(ext.state.errors, []);
    assert.deepEqual(ext.state.warnings, []);
});

test('warnings are written to the output and announced once per run', async () => {
    const ext = activate(() => ({ tables: TABLES, warnings: ['a.php:3: dynamic table name skipped', 'b.php:9: unknown table'] }));
    ext.openFolders(folder('warnings', LARAVEL));

    ext.run();
    assert.ok(ext.state.output.includes('Warning: a.php:3: dynamic table name skipped'));
    assert.ok(ext.state.output.includes('Warning: b.php:9: unknown table'));
    assert.deepEqual(ext.state.warnings, [{
        text: '2 warnings while reading the schema. See the "DrawMeDatabase" output for details.',
        items: ['Show Output'],
    }]);
    assert.equal(ext.state.panels.length, 1, 'the diagram is still drawn');

    ext.state.answer = 'Show Output';
    ext.run();
    assert.equal(ext.state.warnings.length, 2);
    await flush();
    assert.equal(ext.state.outputShown, 1);
});

test('a run with nothing to draw closes the open panel', () => {
    let result = () => ({ tables: TABLES, warnings: [] });
    const ext = activate(() => result());
    const dir = folder('stale', LARAVEL);
    ext.openFolders(dir);

    for (const failure of [
        () => ({ tables: [], warnings: [] }),
        () => {
            throw new ParserError('No PHP files found.');
        },
        () => {
            throw new Error('boom');
        },
    ]) {
        result = () => ({ tables: TABLES, warnings: [] });
        ext.run();
        const panel = ext.state.panels[ext.state.panels.length - 1];
        assert.equal(panel.disposed, false);

        result = failure;
        ext.run();
        assert.equal(panel.disposed, true);
    }

    // Also when the project is no longer found
    result = () => ({ tables: TABLES, warnings: [] });
    ext.run();
    ext.setFrameworkPath(dir, 'missing');
    assert.equal(ext.run(), undefined);
    assert.equal(ext.state.panels[ext.state.panels.length - 1].disposed, true);
});

test('frameworkPath is resolved from the workspace folder', () => {
    const workspace = folder('mono', { 'backend/artisan': '', 'backend/composer.json': LARAVEL['composer.json'] });
    const backend = path.join(workspace, 'backend');
    const elsewhere = folder('elsewhere', LARAVEL);
    const ext = activate();
    ext.openFolders(workspace);

    for (const [value, expected] of [
        ['backend', backend],
        [' ./backend/ ', backend],
        ['/backend', backend],
        ['\\backend', backend],
        ['//backend//', backend],
        [elsewhere, elsewhere],
        [`${elsewhere}${path.sep}`, elsewhere],
    ]) {
        ext.state.parsed = [];
        ext.setFrameworkPath(workspace, value);
        assert.deepEqual(ext.run(), TABLES, JSON.stringify(value));
        assert.deepEqual(ext.state.parsed, [expected], JSON.stringify(value));
    }
    assert.deepEqual(ext.state.errors, []);

    ext.setFrameworkPath(workspace, '/does-not-exist');
    assert.equal(ext.run(), undefined);
    ext.setFrameworkPath(workspace, 'missing/app');
    assert.equal(ext.run(), undefined);
    assert.deepEqual(ext.state.errors.map(error => error.text), [
        `The DrawMeDatabase.frameworkPath folder "/does-not-exist" was not found in "${workspace}", nor as an absolute path. Check the setting.`,
        `The DrawMeDatabase.frameworkPath folder "missing/app" was not found in "${workspace}". Check the setting.`,
    ]);
});

test('frameworkPath: the workspace folder wins over an absolute path of the same name', () => {
    const workspace = folder('root-app', LARAVEL);
    const elsewhere = folder('other-app', LARAVEL);
    const inside = folder(path.join('root-app', elsewhere), LARAVEL);
    const ext = activate();
    ext.openFolders(workspace);

    for (const [value, expected] of [['/', workspace], ['\\', workspace], [elsewhere, inside]]) {
        ext.state.parsed = [];
        ext.setFrameworkPath(workspace, value);
        assert.deepEqual(ext.run(), TABLES, JSON.stringify(value));
        assert.deepEqual(ext.state.parsed, [expected], JSON.stringify(value));
    }
});

test('a folder without project suggests the setting only when it is empty', () => {
    const workspace = folder('no-project', { 'backend/readme.md': '' });
    const ext = activate();
    ext.openFolders(workspace);

    assert.equal(ext.run(), undefined);
    ext.setFrameworkPath(workspace, 'backend');
    assert.equal(ext.run(), undefined);
    assert.deepEqual(ext.state.errors.map(error => error.text), [
        `No supported project (Laravel, Symfony, Prisma, Drizzle, SQL) found in "${workspace}". If the project is in a subfolder, set DrawMeDatabase.frameworkPath. Unable to draw the schema.`,
        `No supported project (Laravel, Symfony, Prisma, Drizzle, SQL) found in "${path.join(workspace, 'backend')}". Check the DrawMeDatabase.frameworkPath setting. Unable to draw the schema.`,
    ]);
    assert.deepEqual(ext.state.parsed, []);
    assert.ok(ext.state.output.includes('Supported frameworks: Laravel, Symfony, Prisma, Drizzle, SQL.'), 'the output lists the supported frameworks');
});

test('a monorepo root with prisma in its package.json, the schema in a package: the framework folder is suggested', () => {
    const root = folder('prisma-monorepo', {
        'package.json': JSON.stringify({ workspaces: ['packages/*'], devDependencies: { prisma: '^6.19.1' } }),
        'packages/db/package.json': JSON.stringify({ dependencies: { '@prisma/client': '^6.19.1' } }),
        'packages/db/prisma/schema.prisma': 'model User {\n  id Int @id\n}\n',
    });
    const ext = activate();
    ext.openFolders(root);
    assert.equal(ext.run(), undefined);
    assert.deepEqual(ext.state.errors.map(error => error.text), [`No supported project (Laravel, Symfony, Prisma, Drizzle, SQL) found in "${root}". If the project is in a subfolder, set DrawMeDatabase.frameworkPath. Unable to draw the schema.`]);
    assert.equal(ext.state.context['drawMeDatabase.schemaState'], 'noProject', 'the Schema view offers to set the framework folder');
    assert.deepEqual(ext.state.parsed, []);
    // The framework folder of the package
    ext.setFrameworkPath(root, 'packages/db');
    assert.deepEqual(ext.run(), TABLES);
    assert.deepEqual(ext.state.parsed, [path.join(root, 'packages', 'db')]);
});

test('a parser that could not read the folder while another one recognized it: its error is a warning in the output', () => {
    const dir = folder('prisma-bad-composer', { artisan: '', 'composer.json': '{,}', ...PRISMA });
    const ext = activate(() => ({ tables: TABLES, warnings: ['w'] }));
    ext.openFolders(dir);
    assert.deepEqual(ext.run(), TABLES);
    assert.equal(ext.context.api.getSchema().framework, 'prisma');
    const warnings = ext.state.output.filter(line => line.startsWith('Warning: '));
    assert.equal(warnings.length, 2, JSON.stringify(ext.state.output));
    // One warning for both parsers that read composer.json
    assert.ok(warnings[0].startsWith(`Warning: composer.json in "${dir}" could not be read: `), warnings[0]);
    assert.ok(warnings[0].endsWith(' (detection of Laravel, Symfony)'), warnings[0]);
    assert.equal(warnings[1], 'Warning: w');
    // Counted with the warnings of the parser
    assert.deepEqual(ext.state.warnings.map(warning => warning.text), ['2 warnings while reading the schema. See the "DrawMeDatabase" output for details.']);
});

test('an invalid composer.json is reported as such', () => {
    const workspace = folder('bad-composer', { artisan: '', 'composer.json': '{"require": {,}' });
    const ext = activate();
    ext.openFolders(workspace);

    assert.equal(ext.run(), undefined);
    assert.equal(ext.state.errors.length, 1);
    assert.ok(ext.state.errors[0].text.startsWith(`composer.json in "${workspace}" could not be read: `), ext.state.errors[0].text);
    assert.deepEqual(ext.state.errors[0].items, []);
});

test('multi-root: the folder of the active editor, else the folder of the last run', () => {
    const first = folder('multi-a', { 'readme.md': '' });
    const second = folder('multi-b', LARAVEL);
    const ext = activate();
    ext.openFolders(first, second);

    // No editor: the first folder
    assert.equal(ext.run(), undefined);
    assert.equal(ext.state.errors.length, 1);

    ext.openEditor(path.join(second, 'composer.json'));
    assert.deepEqual(ext.run(), TABLES);

    // The panel has the focus (no active editor): the refresh uses the same folder
    ext.state.activeTextEditor = undefined;
    assert.deepEqual(ext.run(), TABLES);
    assert.deepEqual(ext.state.parsed, [second, second]);

    // An editor of the other folder wins
    ext.openEditor(path.join(first, 'readme.md'));
    assert.equal(ext.run(), undefined);
    assert.equal(ext.state.errors.length, 2);

    // A last folder removed from the workspace is not used
    ext.state.activeTextEditor = undefined;
    ext.openFolders(second);
    ext.run();
    ext.openFolders(first);
    assert.equal(ext.run(), undefined);
    assert.equal(ext.state.parsed.length, 3);
});

test('no workspace folder', () => {
    const ext = activate();
    assert.equal(ext.run(), undefined);
    assert.deepEqual(ext.state.errors.map(error => error.text), ['No project opened in the current workspace. Unable to draw the schema.']);
});

test('side panel: the tools and exports of DrawMeDatabase Pro are listed greyed until it adds them', async () => {
    const ext = activate();
    const api = ext.context.api;
    ext.openFolders(folder('panel-free', LARAVEL));
    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });

    const free = panel.sent('features').at(-1);
    assert.ok(free.tools.length >= 10 && free.tools.every(tool => tool.state === 'missing' && tool.pro), 'every Pro tool is missing');
    assert.ok(free.exports.some(item => item.id === 'pro.sql-mysql' && item.state === 'missing'));
    assert.deepEqual(free.license, { kind: 'free', actions: ['discover'] });

    // A missing tool, or "Discover", opens the page of DrawMeDatabase Pro
    panel.postFromPage({ type: 'tool', id: 'pro.canvas' });
    panel.postFromPage({ type: 'license', action: 'discover' });
    panel.postFromPage({ type: 'tool', id: 'unknown' });
    await flush();
    assert.deepEqual(ext.state.executed, [
        { id: 'extension.open', args: ['GuillaumeCancalon.draw-me-database-pro'] },
        { id: 'extension.open', args: ['GuillaumeCancalon.draw-me-database-pro'] },
    ]);

    // Pro adds its tools: they run their command, with their arguments
    const canvas = api.registerTool({ id: 'pro.canvas', label: 'Schema canvas', command: 'DMDBPro.openCanvas', pro: true });
    api.registerTool({ id: 'acme.audit', label: 'Audit', command: 'acme.audit', args: ['users', { bad: true }, 3] });
    api.registerExporter({ id: 'pro.sql-mysql', label: 'Save as SQL (MySQL)…', extension: 'sql', export: () => 'SQL' });
    assert.throws(() => api.registerTool({ id: 'x' }), TypeError);
    const listed = panel.sent('features').at(-1);
    assert.deepEqual(listed.tools.find(tool => tool.id === 'pro.canvas'), { id: 'pro.canvas', label: 'Schema canvas', hint: '', icon: undefined, pro: true, state: 'available' });
    assert.deepEqual(listed.tools.at(-1), { id: 'acme.audit', label: 'Audit', hint: '', icon: undefined, pro: false, state: 'available' });
    assert.equal(listed.exports.find(item => item.id === 'pro.sql-mysql').state, 'available');

    ext.state.executed = [];
    panel.postFromPage({ type: 'tool', id: 'pro.canvas' });
    panel.postFromPage({ type: 'tool', id: 'acme.audit' });
    await flush();
    assert.deepEqual(ext.state.executed, [{ id: 'DMDBPro.openCanvas', args: [] }, { id: 'acme.audit', args: ['users', 3] }]);

    // Its license: the trial, then the end of the trial locks its tools and exports
    const pro = installPro(ext, { kind: 'trial', daysLeft: 9.4, commands: { buy: 'DMDBPro.buyLicense', enter: 'DMDBPro.enterLicense', manage: 'DMDBPro.licenseStatus' } });
    assert.equal(await pro.connect(), true);
    assert.deepEqual(panel.sent('features').at(-1).license, { kind: 'trial', daysLeft: 9, actions: ['buy', 'enter'] });
    pro.set({ kind: 'expired', commands: { buy: 'DMDBPro.buyLicense' } });
    const expired = panel.sent('features').at(-1);
    assert.deepEqual(expired.license, { kind: 'expired', daysLeft: undefined, actions: ['buy'] });
    assert.equal(expired.tools.find(tool => tool.id === 'pro.canvas').state, 'locked');
    assert.equal(expired.tools.find(tool => tool.id === 'acme.audit').state, 'available', 'not a Pro tool');
    assert.equal(expired.exports.find(item => item.id === 'pro.sql-mysql').state, 'locked');
    ext.state.executed = [];
    panel.postFromPage({ type: 'license', action: 'buy' });
    panel.postFromPage({ type: 'license', action: 'enter' });
    await flush();
    assert.deepEqual(ext.state.executed, [{ id: 'DMDBPro.buyLicense', args: [] }]);

    pro.set({ kind: 'licensed', commands: { manage: 'DMDBPro.licenseStatus' } });
    assert.deepEqual(panel.sent('features').at(-1).license.actions, ['manage']);
    // A stored key: Pro gives its remove command, shown after the others
    pro.set({ kind: 'licensed', commands: { manage: 'DMDBPro.licenseStatus', remove: 'DMDBPro.removeLicense' } });
    assert.deepEqual(panel.sent('features').at(-1).license.actions, ['manage', 'remove']);
    pro.set({ kind: 'expired', commands: { buy: 'DMDBPro.buyLicense', enter: 'DMDBPro.enterLicense', remove: 'DMDBPro.removeLicense' } });
    assert.deepEqual(panel.sent('features').at(-1).license.actions, ['buy', 'enter', 'remove']);
    ext.state.executed = [];
    panel.postFromPage({ type: 'license', action: 'remove' });
    await flush();
    assert.deepEqual(ext.state.executed, [{ id: 'DMDBPro.removeLicense', args: [] }]);
    pro.set({ kind: 'stolen' });
    assert.equal(panel.sent('features').at(-1).license.kind, 'free');

    canvas.update({ locked: true, label: 'Canvas' });
    assert.deepEqual(panel.sent('features').at(-1).tools.find(tool => tool.id === 'pro.canvas'), { id: 'pro.canvas', label: 'Canvas', hint: '', icon: undefined, pro: true, state: 'locked' });
    canvas.dispose();
    assert.equal(panel.sent('features').at(-1).tools.find(tool => tool.id === 'pro.canvas').state, 'missing');
});

test('API: the license of DrawMeDatabase Pro comes from the frozen exports of Pro only', async () => {
    const ext = activate();
    const api = ext.context.api;
    ext.openFolders(folder('license-handshake', LARAVEL));
    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });
    const unlocked = () => panel.sent('settings').at(-1).pro;

    // Any extension can call the API: nothing in it sets the license
    assert.equal(api.setLicenseStatus, undefined);
    assert.equal(await api.connectPro({ licenseStatus: () => ({ kind: 'licensed' }) }), false, 'Pro is not installed');
    assert.equal(unlocked(), false);
    assert.equal(ext.state.context['drawMeDatabase.license'], 'free');

    // Exports that are not frozen: another extension could have put its own functions there
    const open = installPro(ext, { kind: 'licensed' }, { frozen: false });
    assert.equal(await open.connect(), false);
    assert.equal(unlocked(), false);
    assert.equal(open.listeners.size, 0);
    assert.ok(ext.state.output.includes('DrawMeDatabase Pro: no license in its exports'));

    // Pro: its license, followed once however many times connectPro() is called
    const pro = installPro(ext, { kind: 'trial', daysLeft: 5 });
    assert.equal(await pro.connect(), true);
    assert.equal(await pro.connect(), true);
    assert.equal(pro.listeners.size, 1);
    assert.equal(unlocked(), true);
    assert.equal(ext.state.context['drawMeDatabase.license'], 'trial');
    pro.set({ kind: 'expired' });
    assert.equal(unlocked(), false);

    // An error of Pro is a free version, until its event brings its license back
    pro.set({ get kind() { throw new Error('broken'); } });
    assert.equal(ext.state.context['drawMeDatabase.license'], 'free');
    assert.ok(ext.state.output.includes('DrawMeDatabase Pro: broken'));
    pro.set({ kind: 'licensed' });
    assert.equal(unlocked(), true);

    // Pro activated again (new exports): the old ones are no longer followed
    const again = installPro(ext, { kind: 'expired' });
    assert.equal(await again.connect(), true);
    assert.equal(pro.listeners.size, 0);
    assert.equal(unlocked(), false);
    again.set({ kind: 'licensed' });
    assert.equal(unlocked(), true);

    // Pro deactivated (its exports give null), then DrawMeDatabase itself
    again.set(null);
    assert.equal(ext.state.context['drawMeDatabase.license'], 'free');
    ext.context.subscriptions.forEach(subscription => subscription.dispose());
    assert.equal(again.listeners.size, 0);
});

test('side panel: appearance, options and language are saved globally, after validation', async () => {
    const ext = activate();
    ext.openFolders(folder('panel-settings', LARAVEL));
    ext.state.settings[''] = { 'DrawMeDatabase.palette': 'neon', 'DrawMeDatabase.fontSize': 400, 'DrawMeDatabase.colors': { header: '#ABCDEF', text: 'blue' } };
    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });
    const settings = panel.sent('settings').at(-1);
    assert.equal(settings.palette, 'vscode', 'an unknown palette is the default one');
    assert.equal(settings.fontSize, 20, 'clamped');
    assert.deepEqual(settings.colors, { header: '#abcdef' });

    for (const [key, value] of [
        ['theme', 'light'], ['palette', 'forest'], ['font', 'mono'], ['grid', false], ['keysOnly', true],
        ['relationLabels', false], ['language', 'fr'], ['autoRefresh', false], ['fontSize', 15.2],
        ['customFont', 'Fira Sans; x'], ['colors', { accent: '#FF0000', nope: '#000000' }],
        // Refused
        ['theme', 'pink'], ['fontSize', 'big'], ['customFont', 42], ['language', 'de'], ['toString', 1],
    ]) {
        panel.postFromPage({ type: 'setting', key, value });
    }
    await flush();
    assert.deepEqual(ext.state.updates.map(update => [update.key.replace('DrawMeDatabase.', ''), update.value, update.target]), [
        ['theme', 'light', 1], ['palette', 'forest', 1], ['font', 'mono', 1], ['grid', false, 1], ['keysOnly', true, 1],
        ['relationLabels', false, 1], ['language', 'fr', 1], ['autoRefresh', false, 1], ['fontSize', 15, 1],
        ['customFont', 'Fira Sans x', 1], ['colors', { accent: '#ff0000' }, 1],
    ]);

    // Reset: every appearance setting back to its default
    ext.state.updates = [];
    panel.postFromPage({ type: 'resetAppearance' });
    await flush();
    assert.deepEqual(ext.state.updates.map(update => [update.key, update.value]), ['theme', 'palette', 'colors', 'font', 'customFont', 'fontSize', 'grid'].map(key => [`DrawMeDatabase.${key}`, undefined]));

    // Settings of VS Code, at the framework folder or at every setting of the extension
    panel.postFromPage({ type: 'openSettings', target: 'frameworkPath' });
    panel.postFromPage({ type: 'openSettings', target: 'anything' });
    await flush();
    assert.deepEqual(ext.state.executed, [
        { id: 'workbench.action.openSettings', args: ['DrawMeDatabase.frameworkPath'] },
        { id: 'workbench.action.openSettings', args: ['@ext:GuillaumeCancalon.draw-me-database'] },
    ]);

    // A new appearance setting is posted to the page
    ext.state.settings[''] = { 'DrawMeDatabase.theme': 'dark', 'DrawMeDatabase.language': 'fr' };
    ext.vscode.changeConfiguration('DrawMeDatabase.theme');
    assert.equal(panel.sent('settings').at(-1).theme, 'dark');
    assert.equal(panel.sent('settings').at(-1).languageResolved, 'fr');
});

test('the messages follow the language setting, else the language of VS Code', () => {
    const ext = activate();
    ext.vscode.env.language = 'fr-ca';
    ext.run();
    assert.deepEqual(ext.state.errors.at(-1).text, 'Aucun projet ouvert dans l\'espace de travail. Impossible de dessiner le schéma.');
    ext.state.settings[''] = { 'DrawMeDatabase.language': 'en' };
    ext.run();
    assert.deepEqual(ext.state.errors.at(-1).text, 'No project opened in the current workspace. Unable to draw the schema.');
});

test('API: the display settings (appearance and language) and their changes', () => {
    const ext = activate();
    const api = ext.context.api;
    ext.state.settings[''] = { 'DrawMeDatabase.palette': 'ocean', 'DrawMeDatabase.fontSize': 16, 'DrawMeDatabase.language': 'auto' };
    ext.vscode.env.language = 'fr';
    assert.deepEqual(api.getDisplaySettings(), { theme: 'auto', palette: 'ocean', colors: {}, font: 'default', customFont: '', fontSize: 16, grid: true, language: 'fr' });

    const seen = [];
    const subscription = api.onDidChangeDisplaySettings(settings => seen.push(settings));
    ext.state.settings[''] = { 'DrawMeDatabase.theme': 'dark', 'DrawMeDatabase.language': 'en' };
    ext.vscode.changeConfiguration('DrawMeDatabase.theme');
    ext.vscode.changeConfiguration('DrawMeDatabase.layout');
    assert.deepEqual(seen.map(settings => [settings.theme, settings.language]), [['dark', 'en']], 'only the display settings fire');
    subscription.dispose();
});

test('inspector: a column opens at its line; the sections of other extensions, or the Pro teaser', async () => {
    const tables = [
        { table: 'users', columns: [{ name: 'id', type: 'bigIncrements', primary: true, source: { file: 'database/migrations/users.php', line: 14 } }], relations: [], source: { file: 'database/migrations/users.php', line: 12 } },
        { table: 'outside', columns: [{ name: 'id', type: 'integer', source: { file: '../../etc/passwd', line: 1 } }], relations: [] },
    ];
    const ext = activate(() => ({ tables, warnings: [] }));
    const api = ext.context.api;
    const dir = folder('inspector', LARAVEL);
    ext.openFolders(dir);
    ext.run();
    assert.equal(ext.state.parseOptions[0].columnSources, true, 'the lines of the columns are read');
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });

    panel.postFromPage({ type: 'openColumn', table: 'users', column: 'id' });
    panel.postFromPage({ type: 'openColumn', table: 'users', column: 'nope' });
    panel.postFromPage({ type: 'openColumn', table: 'outside', column: 'id' });
    panel.postFromPage({ type: 'openColumn', table: 'users', column: 42 });
    await flush();
    assert.deepEqual(ext.state.opened.map(opened => [path.relative(dir, opened.path), opened.options.selection.startLine]), [[path.join('database', 'migrations', 'users.php'), 13]]);

    // No provider: the teaser of DrawMeDatabase Pro
    panel.postFromPage({ type: 'tableInfo', table: 'users', request: 1 });
    await flush();
    assert.deepEqual(panel.sent('tableInfo').at(-1), { type: 'tableInfo', table: 'users', request: 1, sections: [], teaser: true });

    // Providers: their sections, cleaned, with actions run by id only
    const seen = [];
    api.registerTableInfoProvider({
        id: 'pro',
        provide: (table, schema) => {
            seen.push([table, schema.tables.length]);
            return Promise.resolve([
                { title: 'Details', items: [{ label: 'Index', value: 'email', badge: 'unique', tone: 'accent', extra: 1 }, { label: 3 }], actions: [{ label: 'Add columns…', command: 'DMDBPro.addColumns', args: ['users', { x: 1 }] }] },
                { title: '' },
                { title: 'History', items: [], locked: true, note: 'Trial ended' },
            ]);
        },
    });
    const failing = api.registerTableInfoProvider({ id: 'broken', provide: () => { throw new Error('boom'); } });
    assert.throws(() => api.registerTableInfoProvider({ id: 'x' }), TypeError);
    panel.postFromPage({ type: 'tableInfo', table: 'users', request: 2 });
    await flush();
    await flush();
    const info = panel.sent('tableInfo').at(-1);
    assert.deepEqual(seen, [['users', 2]]);
    assert.equal(info.teaser, false);
    assert.deepEqual(info.sections, [
        { title: 'Details', items: [{ label: 'Index', value: 'email', hint: undefined, badge: 'unique', tone: 'accent' }], actions: [{ id: 'action-1', label: 'Add columns…' }], note: undefined, locked: false },
        { title: 'History', items: [], actions: [], note: 'Trial ended', locked: true },
    ]);
    assert.ok(ext.state.output.some(line => line.includes('boom')), 'a failing provider is written to the output');

    ext.state.executed = [];
    panel.postFromPage({ type: 'tableAction', id: 'action-1' });
    panel.postFromPage({ type: 'tableAction', id: 'action-9' });
    await flush();
    assert.deepEqual(ext.state.executed, [{ id: 'DMDBPro.addColumns', args: ['users'] }]);
    failing.dispose();
});

test('free version: the page gets the git status of the tables, the columns come with DrawMeDatabase Pro', async () => {
    const tables = [{
        table: 'users',
        git: 'modified',
        columns: [{ name: 'id', type: 'bigIncrements', primary: true, git: 'committed' }, { name: 'email', type: 'string', git: 'unsaved' }],
        relations: [],
    }];
    const ext = activate(() => ({ tables, warnings: [] }));
    const api = ext.context.api;
    ext.openFolders(folder('free-git', LARAVEL));
    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });
    const free = panel.sent('schema').at(-1).tables[0];
    assert.equal(free.git, 'modified', 'the status of the table stays');
    assert.deepEqual(free.columns.map(column => column.git), [undefined, undefined]);
    assert.equal(panel.sent('settings').at(-1).pro, false);
    assert.equal(api.getSchema().tables[0].columns[1].git, 'unsaved', 'other extensions get everything');

    // The trial of Pro: the columns get their status, the page knows it
    const pro = installPro(ext, { kind: 'trial', daysLeft: 14 });
    await pro.connect();
    assert.equal(panel.sent('settings').at(-1).pro, true);
    assert.deepEqual(panel.sent('schema').at(-1).tables[0].columns.map(column => column.git), ['committed', 'unsaved']);

    // Pro can hide them (setting), and they go away when its trial ends
    ext.state.settings[''] = { 'DrawMeDatabase.showColumnGitStatus': false };
    ext.vscode.changeConfiguration('DrawMeDatabase.showColumnGitStatus');
    assert.deepEqual(panel.sent('schema').at(-1).tables[0].columns.map(column => column.git), [undefined, undefined]);
    ext.state.settings[''] = {};
    ext.vscode.changeConfiguration('DrawMeDatabase.showColumnGitStatus');
    assert.equal(panel.sent('schema').at(-1).tables[0].columns[1].git, 'unsaved');
    pro.set({ kind: 'expired' });
    assert.equal(panel.sent('settings').at(-1).pro, false);
    assert.equal(panel.sent('schema').at(-1).tables[0].columns[1].git, undefined);
});

// ---------------------------------------------------------------------------------------------
// The views of the Activity Bar (sidebar.js)

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const fires = (event) => {
    let count = 0;
    event(() => count++);
    return () => count;
};

const SIDEBAR_TABLES = [
    {
        table: 'users',
        git: 'untracked',
        columns: [{ name: 'id', type: 'bigIncrements', primary: true, git: 'untracked', source: { file: 'database/migrations/2024_01_01_000000_create_users_table.php', line: 14 } }],
        relations: [],
        source: { file: 'database/migrations/2024_01_01_000000_create_users_table.php', line: 12 },
    },
    {
        table: 'posts',
        columns: [{ name: 'user_id', type: 'unsignedBigInteger', nullable: true }],
        relations: [{ foreignKey: 'user_id', references: 'id', on: 'users', type: 'many-to-one' }],
    },
];

test('views: the container has its views; the Schema view reads the schema itself, without the diagram', async () => {
    const ext = activate(() => ({ tables: SIDEBAR_TABLES, warnings: ['x.php:1: skipped'] }));
    const dir = folder('views', LARAVEL);
    ext.openFolders(dir);
    const views = ext.state.treeViews;
    assert.deepEqual([...views.keys()], ['DMDB.schema', 'DMDB.tools', 'DMDB.exports', 'DMDB.license']);
    assert.equal(views.get('DMDB.schema').options.showCollapseAll, true);
    assert.deepEqual(ext.state.context, { 'drawMeDatabase.sidebar': true, 'drawMeDatabase.license': 'free' });

    // Nothing is read while the view is hidden
    const schema = views.get('DMDB.schema');
    assert.deepEqual(schema.items(), []);
    assert.equal(ext.state.parsed.length, 0);

    const changes = fires(ext.context.api.onDidChangeSchema);
    schema.show();
    assert.equal(ext.state.context['drawMeDatabase.schemaState'], 'loading');
    await sleep(10);
    assert.equal(ext.state.parsed.length, 1);
    assert.equal(ext.state.panels.length, 0, 'no diagram');
    assert.equal(ext.state.context['drawMeDatabase.schemaState'], 'ready');
    assert.equal(schema.description, 'Laravel · views');
    assert.equal(changes(), 1, 'other extensions get the schema too');
    assert.deepEqual(ext.context.api.getSchema().tables, SIDEBAR_TABLES);
    // The messages go to the output only: the view tells what happened
    assert.deepEqual(ext.state.warnings, []);
    assert.ok(ext.state.output.includes('Warning: x.php:1: skipped'));

    const [posts, users] = schema.items();
    assert.deepEqual({ label: posts.label, description: posts.description, icon: posts.iconPath.id, collapsible: posts.collapsibleState, command: posts.command },
        { label: 'posts', description: '1 column', icon: 'table', collapsible: 1, command: undefined });
    assert.deepEqual(posts.children.map(column => [column.label, column.description, column.iconPath.id]), [['user_id', 'unsignedBigInteger? → users.id', 'references']]);
    assert.equal(users.id, 'table:users');
    assert.equal(users.contextValue, 'table');
    assert.deepEqual(users.command, { title: 'users', command: 'DMDB.openTable', arguments: ['users'] });

    // The git status of the table colors its name; the one of its columns comes with Pro
    assert.equal(users.resourceUri.scheme, 'drawmedatabase');
    assert.equal(users.resourceUri.query, 'git=untracked');
    assert.equal(users.children[0].resourceUri, undefined);
    const decoration = ext.state.decorations[0].provideFileDecoration(users.resourceUri);
    assert.deepEqual({ badge: decoration.badge, tooltip: decoration.tooltip, color: decoration.color.id }, { badge: 'U', tooltip: 'Not in the last commit', color: 'gitDecoration.untrackedResourceForeground' });
    assert.equal(ext.state.decorations[0].provideFileDecoration(Uri.file('/x.php')), undefined);
    await installPro(ext, { kind: 'trial', daysLeft: 3 }).connect();
    assert.equal(schema.items()[1].children[0].resourceUri.query, 'git=untracked');
    ext.state.settings[''] = { 'DrawMeDatabase.showGitStatus': false };
    assert.equal(schema.items()[1].resourceUri, undefined, 'git status hidden');
});

test('views: a click opens the file of a table or the line of a column; Show in Diagram selects the table', async () => {
    const ext = activate(() => ({ tables: SIDEBAR_TABLES, warnings: [] }), { visibleViews: ['DMDB.schema'] });
    const dir = folder('views-open', LARAVEL);
    ext.openFolders(dir);
    // Visible from the start (the layout of the window is restored)
    await sleep(10);
    const [, users] = ext.state.treeViews.get('DMDB.schema').items();
    const run = (item) => ext.state.commands.get(item.command.command)(...item.command.arguments);

    run(users);
    run(users.children[0]);
    await flush();
    const file = path.join(dir, 'database', 'migrations', '2024_01_01_000000_create_users_table.php');
    assert.deepEqual(ext.state.opened.map(opened => [opened.path, opened.options.selection.startLine]), [[file, 11], [file, 13]]);

    // Show in Diagram: the diagram is opened, then shows the table once it is ready
    const show = ext.state.commands.get('DMDB.showInDiagram');
    show(users.node);
    await flush();
    assert.deepEqual(ext.state.executed, [{ id: 'DMDB.parseSchema', args: [] }]);
    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });
    assert.deepEqual(panel.posted.slice(-2).map(message => message.type), ['schema', 'showTable']);
    assert.deepEqual(panel.sent('showTable'), [{ type: 'showTable', table: 'users' }]);
    // Once ready, at once (a column shows its table); invalid arguments do nothing
    show(users.children[0].node);
    show({ table: 3 });
    show(undefined);
    assert.deepEqual(panel.sent('showTable').at(-1), { type: 'showTable', table: 'users' });
    assert.equal(panel.sent('showTable').length, 2);
    assert.ok(panel.reveals >= 1);
});

test('views: the tools, exports and license of the side panel, Pro ones greyed until it adds them', async () => {
    const ext = activate();
    const api = ext.context.api;
    ext.openFolders(folder('views-tools', LARAVEL));
    const tools = ext.state.treeViews.get('DMDB.tools');
    const exportsView = ext.state.treeViews.get('DMDB.exports');
    const license = ext.state.treeViews.get('DMDB.license');
    const command = (id) => ext.state.commands.get(id);
    const toolsChanged = fires(tools.options.treeDataProvider.onDidChangeTreeData);

    const free = tools.items();
    assert.ok(free.length >= 10 && free.every(item => item.description === 'PRO' && item.resourceUri.query === 'state=missing'), 'every Pro tool is greyed');
    assert.equal(free[0].iconPath.color.id, 'disabledForeground');
    const greyed = ext.state.decorations[0].provideFileDecoration(free[0].resourceUri);
    assert.deepEqual({ badge: greyed.badge, color: greyed.color.id, tooltip: greyed.tooltip }, { badge: undefined, color: 'disabledForeground', tooltip: 'Available with DrawMeDatabase Pro' });

    // A missing tool or export opens the page of DrawMeDatabase Pro
    command('DMDB.runTool')('pro.canvas');
    command('DMDB.runExport')('pro.sql-mysql');
    command('DMDB.runTool')(undefined);
    await flush();
    assert.deepEqual(ext.state.executed, [
        { id: 'extension.open', args: ['GuillaumeCancalon.draw-me-database-pro'] },
        { id: 'extension.open', args: ['GuillaumeCancalon.draw-me-database-pro'] },
    ]);

    // Pro adds them: they run their command
    api.registerTool({ id: 'pro.canvas', label: 'Schema canvas', command: 'DMDBPro.openCanvas', pro: true });
    api.registerExporter({ id: 'pro.sql-mysql', label: 'SQL', extension: 'sql', export: () => 'SQL' });
    assert.ok(toolsChanged() >= 1);
    const canvas = tools.items().find(item => item.id === 'tool:pro.canvas');
    assert.deepEqual({ label: canvas.label, description: canvas.description, resourceUri: canvas.resourceUri, icon: canvas.iconPath.id, color: canvas.iconPath.color },
        { label: 'Schema canvas', description: undefined, resourceUri: undefined, icon: 'layout', color: undefined });
    assert.equal(exportsView.items().find(item => item.id === 'export:pro.sql-mysql').description, undefined);
    ext.state.executed = [];
    command(canvas.command.command)(...canvas.command.arguments);
    await flush();
    assert.deepEqual(ext.state.executed, [{ id: 'DMDBPro.openCanvas', args: [] }]);

    // An export asks the diagram (opened first), which runs it on what it shows
    ext.state.executed = [];
    command('DMDB.runExport')('svg');
    await flush();
    assert.deepEqual(ext.state.executed, [{ id: 'DMDB.parseSchema', args: [] }]);
    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });
    assert.deepEqual(panel.sent('runExport'), [{ type: 'runExport', id: 'svg' }]);
    command('DMDB.runExport')('pro.sql-mysql');
    assert.deepEqual(panel.sent('runExport').at(-1), { type: 'runExport', id: 'pro.sql-mysql' });

    // The license: the view is hidden without Pro (context key), then follows its state
    assert.equal(ext.state.context['drawMeDatabase.license'], 'free');
    const pro = installPro(ext, { kind: 'trial', daysLeft: 9, commands: { buy: 'DMDBPro.buyLicense', enter: 'DMDBPro.enterLicense' } });
    await pro.connect();
    assert.equal(ext.state.context['drawMeDatabase.license'], 'trial');
    assert.deepEqual(license.items().map(item => item.label), ['Pro trial: 9 days left', 'Buy a license', 'Enter a license key']);
    ext.state.executed = [];
    command('DMDB.licenseAction')('buy');
    command('DMDB.licenseAction')('manage');
    await flush();
    assert.deepEqual(ext.state.executed, [{ id: 'DMDBPro.buyLicense', args: [] }]);
    pro.set({ kind: 'expired', commands: { buy: 'DMDBPro.buyLicense' } });
    assert.equal(tools.items().find(item => item.id === 'tool:pro.canvas').iconPath.id, 'lock');
    pro.set(null);
    assert.equal(ext.state.context['drawMeDatabase.license'], 'free');
});

test('views: the welcome content tells why there is no schema, without notifications', async () => {
    let parse = () => ({ tables: TABLES, warnings: [] });
    const ext = activate((basePath, options) => parse(basePath, options), { visibleViews: ['DMDB.schema'] });
    const state = () => ext.state.context['drawMeDatabase.schemaState'];
    const refresh = async () => {
        ext.state.commands.get('DMDB.refreshSchema')();
        await sleep(10);
    };
    await sleep(10);
    assert.equal(state(), 'noFolder');

    const empty = folder('views-empty');
    ext.openFolders(empty);
    await refresh();
    assert.equal(state(), 'noProject');

    // The framework folder is set: the view reads it again
    folder('views-empty/backend', LARAVEL);
    ext.state.settings[path.resolve(empty)] = { 'DrawMeDatabase.frameworkPath': 'backend' };
    ext.vscode.changeConfiguration('DrawMeDatabase.frameworkPath');
    await sleep(600);
    assert.equal(state(), 'ready');
    assert.equal(ext.state.treeViews.get('DMDB.schema').items().length, 2);

    parse = () => ({ tables: [], warnings: [] });
    await refresh();
    assert.equal(state(), 'noTables');
    assert.deepEqual(ext.state.treeViews.get('DMDB.schema').items(), []);
    assert.equal(ext.context.api.getSchema(), null);

    parse = () => {
        throw new ParserError('composer.json is not valid JSON');
    };
    await refresh();
    assert.equal(state(), 'error');
    parse = () => {
        throw new Error('boom');
    };
    await refresh();
    assert.equal(state(), 'error');
    assert.deepEqual(ext.state.errors, []);
    assert.deepEqual(ext.state.infos, []);
    assert.ok(ext.state.output.some(line => line.includes('boom')));

    ext.state.commands.get('DMDB.showOutput')();
    assert.equal(ext.state.outputShown, 1);
    ext.state.commands.get('DMDB.openSettings')('frameworkPath');
    ext.state.commands.get('DMDB.openSettings')();
    await flush();
    assert.deepEqual(ext.state.executed.slice(-2), [
        { id: 'workbench.action.openSettings', args: ['DrawMeDatabase.frameworkPath'] },
        { id: 'workbench.action.openSettings', args: ['@ext:GuillaumeCancalon.draw-me-database'] },
    ]);
});

test('views: the Schema view follows the code while it is visible, and stops when it is hidden', async () => {
    const ext = activate(() => ({ tables: TABLES, warnings: [] }), { visibleViews: ['DMDB.schema'] });
    const dir = folder('views-live', LARAVEL);
    ext.openFolders(dir);
    await sleep(10);
    assert.equal(ext.state.parsed.length, 1);
    assert.equal(ext.state.watchers.length, 1);
    const watcher = ext.state.watchers[0];
    assert.equal(watcher.pattern.base.fsPath, path.join(dir, 'database', 'migrations'));

    watcher.fire('create');
    await sleep(600);
    assert.equal(ext.state.parsed.length, 2);
    assert.equal(ext.state.panels.length, 0);

    const schema = ext.state.treeViews.get('DMDB.schema');
    schema.show(false);
    assert.equal(watcher.disposed, true);
    // Shown again: the code may have changed meanwhile
    schema.show(true);
    await sleep(10);
    assert.equal(ext.state.parsed.length, 3);
    assert.equal(ext.state.watchers.length, 2);

    // The diagram, once closed, leaves the view following the code
    ext.run();
    ext.state.panels[0].dispose();
    assert.equal(ext.state.watchers.at(-1).disposed, false);
    // The refresh of the view redraws the open diagram quietly, without bringing it to the front
    ext.run();
    const panel = ext.state.panels[1];
    panel.postFromPage({ type: 'ready' });
    const reveals = panel.reveals;
    ext.state.commands.get('DMDB.refreshSchema')();
    assert.equal(panel.reveals, reveals);
    assert.equal(ext.state.parsed.length, 6);
});

test('views: the language and the git settings redraw the views; the options panel opens them', async () => {
    const ext = activate();
    ext.openFolders(folder('views-language', LARAVEL));
    const tools = ext.state.treeViews.get('DMDB.tools');
    const changed = fires(tools.options.treeDataProvider.onDidChangeTreeData);
    const decorations = fires(ext.state.decorations[0].onDidChangeFileDecorations);
    assert.equal(tools.items()[0].label, 'Schema canvas');

    ext.state.settings[''] = { 'DrawMeDatabase.language': 'fr' };
    ext.vscode.changeConfiguration('DrawMeDatabase.language');
    assert.equal(changed(), 1);
    assert.equal(decorations(), 1);
    assert.equal(tools.items()[0].label, 'Canevas du schéma');
    assert.equal(tools.items()[0].tooltip, 'Déplacez les tables et les liens à la main\nDisponible avec DrawMeDatabase Pro');
    ext.vscode.changeConfiguration('DrawMeDatabase.showGitStatus');
    assert.equal(changed(), 2);

    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'openSidebar' });
    await flush();
    assert.deepEqual(ext.state.executed, [{ id: 'workbench.view.extension.drawMeDatabase', args: [] }]);
});

test('views: what was asked for the diagram is dropped when there is nothing to draw', async () => {
    let tables = TABLES;
    const ext = activate(() => ({ tables, warnings: [] }));
    ext.openFolders(folder('views-dropped', LARAVEL));
    ext.state.commands.get('DMDB.runExport')('png');
    // DMDB.parseSchema finds no tables: the panel is not opened, the export is forgotten
    tables = [];
    ext.run();
    tables = TABLES;
    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });
    assert.deepEqual(panel.sent('runExport'), []);
});

test('a Pro button tells when DrawMeDatabase Pro cannot be found, instead of an error', async () => {
    const ext = activate();
    ext.openFolders(folder('pro-missing', LARAVEL));
    ext.state.failingCommands.add('extension.open');
    ext.run();
    const panel = ext.state.panels[0];
    panel.postFromPage({ type: 'ready' });
    panel.postFromPage({ type: 'pro' });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(ext.state.executed.filter(command => command.id === 'extension.open').map(command => command.args),
        [['GuillaumeCancalon.draw-me-database-pro']]);
    assert.deepEqual(ext.state.errors, []);
    assert.deepEqual(ext.state.infos.map(info => info.text),
        ['DrawMeDatabase Pro was not found on the Marketplace: it is not published yet, or VS Code is offline.']);
});

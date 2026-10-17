//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// extension.js with a mocked 'vscode' module (and stubbed framework parsers): the command flow,
// the messages shown to the user and the webview panel, without VS Code.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const { ParserError } = require('../../parsers/errors');
const html = require('../../views/html');

const ROOT = path.join(__dirname, '..', '..');
const EXTENSION = path.join(ROOT, 'extension.js');
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
            executeCommand(id, ...args) {
                state.executed.push({ id, args });
                return Promise.resolve();
            },
        },
        // Fires a configuration change of the given settings
        changeConfiguration: (...names) => onConfiguration.fire({ affectsConfiguration: (name) => names.includes(name) }),
        createPanel,
    };
}

// 'vscode' and the framework parsers, as extension.js requires them
let mocks;
const originalLoad = Module._load;

test.before(() => {
    Module._load = function (request, parent, ...rest) {
        if (mocks && request === 'vscode') {
            return mocks.vscode;
        }
        if (mocks && parent && parent.filename === EXTENSION && Object.prototype.hasOwnProperty.call(mocks.parsers, request)) {
            return mocks.parsers[request];
        }
        return originalLoad.call(this, request, parent, ...rest);
    };
});

test.after(() => {
    Module._load = originalLoad;
});

// Activates a fresh copy of extension.js. parse(basePath) is the stubbed parser of both frameworks.
function activate(parse = () => ({ tables: TABLES, warnings: [] })) {
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
        opened: [],
        watchers: [],
    };
    const parser = {
        parse: (basePath) => {
            state.parsed.push(basePath);
            return parse(basePath);
        },
    };
    mocks = { vscode: createVscode(state), parsers: { './parsers/laravel': parser, './parsers/symfony': parser } };

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
    assert.deepEqual(panel.posted, [
        { type: 'settings', layout: 'elk', direction: 'TB' },
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
    assert.deepEqual(panel.sent('settings'), [{ type: 'settings', layout: 'dagre', direction: 'TB' }]);

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
        { type: 'settings', layout: 'dagre', direction: 'TB' },
        { type: 'settings', layout: 'elk', direction: 'LR' },
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
        text: '2 warning(s) while reading the schema. See the "DrawMeDatabase" output for details.',
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
        `No Laravel or Symfony project found in "${workspace}". If the project is in a subfolder, set DrawMeDatabase.frameworkPath. Unable to draw the schema.`,
        `No Laravel or Symfony project found in "${path.join(workspace, 'backend')}". Check the DrawMeDatabase.frameworkPath setting. Unable to draw the schema.`,
    ]);
    assert.deepEqual(ext.state.parsed, []);
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

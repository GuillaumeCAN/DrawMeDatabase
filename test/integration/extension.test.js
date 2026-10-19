//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Runs inside VS Code (npm test). The workspace is test/fixtures/integration/workspace, whose
// .vscode/settings.json points DrawMeDatabase.frameworkPath to the Laravel app in backend/.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXTENSION_ID = 'GuillaumeCancalon.draw-me-database';

const findTable = (tables, name) => tables.find(table => table.table === name);

// A column without its git status (it depends on the state of the repository the test runs in)
// and its source line (checked on its own)
const withoutGit = (column) => {
    const copy = { ...column };
    delete copy.git;
    delete copy.source;
    return copy;
};
const GIT_STATUSES = ['committed', 'modified', 'untracked'];

const drawMeDatabaseTabs = () => vscode.window.tabGroups.all
    .flatMap(group => group.tabs)
    .filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'DrawMeDatabase');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// The drawing reported by the webview (exported by the extension): waits for one that matches
async function rendered(extension, matches) {
    for (let i = 0; i < 300; i++) {
        const render = extension.exports && extension.exports.lastRender;
        if (render && matches(render)) {
            return render;
        }
        await sleep(100);
    }
    return extension.exports && extension.exports.lastRender;
}

// The tab model is updated asynchronously: wait for the panel tab, then a little longer so a
// second (unwanted) panel would have time to show up too
async function settledTabCount() {
    for (let i = 0; i < 50 && drawMeDatabaseTabs().length === 0; i++) {
        await sleep(100);
    }
    await sleep(500);
    return drawMeDatabaseTabs().length;
}

suite('DrawMeDatabase extension', () => {
    suiteTeardown(async () => {
        await vscode.workspace.getConfiguration('DrawMeDatabase').update('layout', undefined, vscode.ConfigurationTarget.Global);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('activates and registers DMDB.parseSchema', async () => {
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(extension, `${EXTENSION_ID} is not installed`);
        await extension.activate();
        assert.equal(extension.isActive, true);

        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('DMDB.parseSchema'));
    });

    test('the DrawMeDatabase container of the Activity Bar: its Schema view reads the schema without the diagram', async function () {
        this.timeout(30000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const { viewsContainers, views } = extension.packageJSON.contributes;
        assert.deepEqual(viewsContainers.activitybar.map(container => container.id), ['drawMeDatabase']);
        assert.deepEqual(views.drawMeDatabase.map(view => view.id), ['DMDB.schema', 'DMDB.tools', 'DMDB.exports', 'DMDB.license']);
        // VS Code registered the container and its views
        const commands = await vscode.commands.getCommands(true);
        for (const command of ['workbench.view.extension.drawMeDatabase', 'DMDB.schema.focus', 'DMDB.tools.focus', 'DMDB.exports.focus', 'DMDB.refreshSchema', 'DMDB.runTool']) {
            assert.ok(commands.includes(command), command);
        }

        assert.equal(extension.exports.getSchema(), null, 'nothing read before the view is shown');
        await vscode.commands.executeCommand('workbench.view.extension.drawMeDatabase');
        await vscode.commands.executeCommand('DMDB.schema.focus');
        for (let i = 0; i < 100 && !extension.exports.getSchema(); i++) {
            await sleep(100);
        }
        const schema = extension.exports.getSchema();
        assert.ok(schema, 'the Schema view read the schema');
        assert.deepEqual(schema.tables.map(table => table.table).sort(), ['posts', 'users']);
        assert.equal(schema.framework, 'laravel');
        assert.equal(drawMeDatabaseTabs().length, 0, 'without opening the diagram');
    });

    test('DMDB.parseSchema parses the Laravel app of the frameworkPath setting', async () => {
        const tables = await vscode.commands.executeCommand('DMDB.parseSchema');

        assert.ok(Array.isArray(tables), 'the command returns the parsed tables');
        assert.deepEqual(tables.map(table => table.table).sort(), ['posts', 'users']);

        const users = findTable(tables, 'users');
        assert.deepEqual(withoutGit(users.columns.find(column => column.name === 'id')),
            { name: 'id', type: 'bigIncrements', primary: true });
        // The line of each column, for the inspector of the page
        assert.deepEqual(users.columns.find(column => column.name === 'id').source,
            { file: 'database/migrations/2024_01_01_000000_create_users_table.php', line: 12 });
        // The fixture is in this repository: every table and column has a git status
        assert.ok(GIT_STATUSES.includes(users.git), users.git);
        assert.ok(users.columns.every(column => GIT_STATUSES.includes(column.git)));
        assert.deepEqual(users.columns.map(column => column.name), ['id', 'name', 'email', 'currency']);
        assert.deepEqual(users.relations, []);

        const posts = findTable(tables, 'posts');
        assert.deepEqual(withoutGit(posts.columns.find(column => column.name === 'user_id')),
            { name: 'user_id', type: 'unsignedBigInteger' });
        assert.deepEqual(posts.relations,
            [{ foreignKey: 'user_id', references: 'id', on: 'users', type: 'many-to-one' }]);

        assert.equal(await settledTabCount(), 1, 'one DrawMeDatabase panel is open');
    });

    test('the webview draws the diagram with Mermaid, in both layouts', async function () {
        this.timeout(60000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const elk = await rendered(extension, render => render.layout === 'elk');
        assert.ok(elk && elk.ok, `ELK drawing: ${JSON.stringify(elk)}`);
        assert.ok(elk.entities >= 2, JSON.stringify(elk));

        // The toolbar and the setting change the layout: the page draws again
        await vscode.workspace.getConfiguration('DrawMeDatabase').update('layout', 'dagre', vscode.ConfigurationTarget.Global);
        const dagre = await rendered(extension, render => render.layout === 'dagre');
        assert.ok(dagre && dagre.ok, `Dagre drawing: ${JSON.stringify(dagre)}`);
    });

    test('the options of the side panel redraw the diagram: language, theme, palette, font, keys only', async function () {
        this.timeout(60000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const config = vscode.workspace.getConfiguration('DrawMeDatabase');
        const keys = ['language', 'theme', 'palette', 'colors', 'fontSize', 'keysOnly', 'relationLabels'];
        try {
            const before = extension.exports.lastRender;
            await config.update('language', 'fr', vscode.ConfigurationTarget.Global);
            await config.update('theme', 'light', vscode.ConfigurationTarget.Global);
            await config.update('palette', 'forest', vscode.ConfigurationTarget.Global);
            await config.update('colors', { accent: '#ff0000' }, vscode.ConfigurationTarget.Global);
            await config.update('fontSize', 16, vscode.ConfigurationTarget.Global);
            await config.update('keysOnly', true, vscode.ConfigurationTarget.Global);
            await config.update('relationLabels', false, vscode.ConfigurationTarget.Global);
            assert.equal(extension.exports.getDisplaySettings().language, 'fr');
            assert.equal(extension.exports.getDisplaySettings().palette, 'forest');
            const redrawn = await rendered(extension, render => render !== before && render.ok);
            assert.ok(redrawn && redrawn.ok && redrawn.entities >= 2, JSON.stringify(redrawn));
        } finally {
            for (const key of keys) {
                await config.update(key, undefined, vscode.ConfigurationTarget.Global);
            }
        }
    });

    test('running the command again reuses the same panel', async () => {
        const tables = await vscode.commands.executeCommand('DMDB.parseSchema');
        assert.equal(tables.length, 2);
        assert.equal(await settledTabCount(), 1);
    });

    test('the parsers: the stacks of the API, their sources, and the DrawMeDatabase.framework setting', () => {
        const api = vscode.extensions.getExtension(EXTENSION_ID).exports;
        assert.equal(api.apiVersion, 3);
        assert.deepEqual(api.getFrameworks(), [{ id: 'laravel', label: 'Laravel' }, { id: 'symfony', label: 'Symfony' }, { id: 'prisma', label: 'Prisma' }, { id: 'drizzle', label: 'Drizzle' }, { id: 'sql', label: 'SQL' }]);
        const schema = api.getSchema();
        assert.equal(schema.framework, 'laravel');
        assert.deepEqual(api.getSources(schema.basePath, schema.framework),
            { folders: [{ path: path.join(schema.basePath, 'database', 'migrations'), recursive: false }], files: [], extensions: ['.php'] });
        // VS Code knows the setting, per workspace folder
        const setting = vscode.workspace.getConfiguration('DrawMeDatabase', vscode.workspace.workspaceFolders[0].uri).inspect('framework');
        assert.equal(setting.defaultValue, 'auto');
        assert.equal(setting.workspaceFolderValue, undefined);
    });

    test('a new migration refreshes the open diagram (DrawMeDatabase.autoRefresh)', async function () {
        this.timeout(60000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const file = path.join(workspace, 'backend', 'database', 'migrations', '2024_01_03_000000_create_tags_table.php');
        try {
            fs.writeFileSync(file, [
                '<?php',
                '',
                'use Illuminate\\Database\\Migrations\\Migration;',
                'use Illuminate\\Database\\Schema\\Blueprint;',
                'use Illuminate\\Support\\Facades\\Schema;',
                '',
                'return new class extends Migration',
                '{',
                '    public function up(): void',
                '    {',
                "        Schema::create('tags', function (Blueprint $table) {",
                '            $table->id();',
                '        });',
                '    }',
                '};',
                '',
            ].join('\n'));
            const added = await rendered(extension, render => render.ok && render.entities === 3);
            assert.equal(added && added.entities, 3, `after the new migration: ${JSON.stringify(added)}`);
        } finally {
            fs.rmSync(file, { force: true });
        }
        const removed = await rendered(extension, render => render.ok && render.entities === 2);
        assert.equal(removed && removed.entities, 2, `after its deletion: ${JSON.stringify(removed)}`);
    });

    test('an unsaved edit of a migration is drawn live, and reverting it removes it', async function () {
        this.timeout(60000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const file = path.join(workspace, 'backend', 'database', 'migrations', '2024_01_02_000000_create_posts_table.php');
        const document = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
        const offset = document.getText().indexOf("Schema::create('posts'");
        assert.ok(offset > 0);

        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, document.positionAt(offset), "Schema::create('live_tags', function (Blueprint $table) {\n            $table->id();\n        });\n        ");
        assert.ok(await vscode.workspace.applyEdit(edit));
        assert.equal(document.isDirty, true, 'not saved');
        const typed = await rendered(extension, render => render.ok && render.entities === 3);
        assert.equal(typed && typed.entities, 3, `while typing: ${JSON.stringify(typed)}`);

        await vscode.commands.executeCommand('workbench.action.files.revert');
        const reverted = await rendered(extension, render => render.ok && render.entities === 2);
        assert.equal(reverted && reverted.entities, 2, `after the revert: ${JSON.stringify(reverted)}`);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    test('an export of the Exports view runs in the diagram, which is opened when it is closed', async function () {
        this.timeout(60000);
        const clipboard = async (matches) => {
            for (let i = 0; i < 300; i++) {
                const text = await vscode.env.clipboard.readText();
                if (matches(text)) {
                    return text;
                }
                await sleep(100);
            }
            return vscode.env.clipboard.readText();
        };
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await sleep(500);
        assert.equal(drawMeDatabaseTabs().length, 0);

        await vscode.env.clipboard.writeText('');
        await vscode.commands.executeCommand('DMDB.runExport', 'copyJson');
        const json = await clipboard(text => text.includes('"table"'));
        assert.deepEqual(JSON.parse(json).map(table => table.table).sort(), ['posts', 'users']);
        assert.equal(drawMeDatabaseTabs().length, 1, 'the diagram was opened');

        // Open and drawn: at once
        await vscode.env.clipboard.writeText('');
        await vscode.commands.executeCommand('DMDB.runExport', 'copyMermaid');
        assert.match(await clipboard(text => text.includes('erDiagram')), /erDiagram/);
    });
});

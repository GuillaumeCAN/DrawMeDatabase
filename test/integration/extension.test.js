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
const withoutGit = (column) => {
    const copy = { ...column };
    delete copy.git;
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

    test('DMDB.parseSchema parses the Laravel app of the frameworkPath setting', async () => {
        const tables = await vscode.commands.executeCommand('DMDB.parseSchema');

        assert.ok(Array.isArray(tables), 'the command returns the parsed tables');
        assert.deepEqual(tables.map(table => table.table).sort(), ['posts', 'users']);

        const users = findTable(tables, 'users');
        assert.deepEqual(withoutGit(users.columns.find(column => column.name === 'id')),
            { name: 'id', type: 'bigIncrements', primary: true });
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

    test('running the command again reuses the same panel', async () => {
        const tables = await vscode.commands.executeCommand('DMDB.parseSchema');
        assert.equal(tables.length, 2);
        assert.equal(await settledTabCount(), 1);
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
});

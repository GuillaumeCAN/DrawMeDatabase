//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Runs inside VS Code (npm test), in the workspace test/fixtures/integration/sql-workspace: a
// Supabase project at the root of the workspace, its schema in the SQL migrations of
// supabase/migrations, replayed without a database.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXTENSION_ID = 'GuillaumeCancalon.draw-me-database';
const GIT_STATUSES = ['committed', 'modified', 'untracked'];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const findTable = (tables, name) => tables.find(table => table.table === name);
// A column without its git status (it depends on the state of the repository the test runs in)
// and its source line (checked on its own)
const withoutGit = (column) => {
    const copy = { ...column };
    delete copy.git;
    delete copy.source;
    return copy;
};

// Waits until test() is true (at most `ms`)
async function waitFor(test, ms = 2000) {
    for (let waited = 0; !test() && waited < ms; waited += 50) {
        await sleep(50);
    }
    return test();
}

// The tab of a text document, in any editor group; whether it is the active tab
const shows = (tab, document) => Boolean(tab) && tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === document.uri.toString();
const tabOf = (document) => vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => shows(tab, document));
const isActive = (document) => shows(vscode.window.tabGroups.activeTabGroup.activeTab, document);

// Reverts an unsaved document with workbench.action.files.revert, which reverts the active editor:
// VS Code 1.96 can give the focus back to the diagram right after showTextDocument(), so the
// editor is shown again, and checked to be active, before each try. Returns whether it reverted.
async function revert(document) {
    for (let attempt = 0; attempt < 10 && document.isDirty; attempt++) {
        await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
        if (await waitFor(() => isActive(document), 1000)) {
            await vscode.commands.executeCommand('workbench.action.files.revert');
        }
        await waitFor(() => !document.isDirty, 1000);
    }
    return !document.isDirty;
}

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

suite('DrawMeDatabase extension: a project of SQL migrations', () => {
    const workspace = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
    const migrations = (...parts) => path.join(workspace(), 'supabase', 'migrations', ...parts);

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('detects the SQL migrations of the workspace and replays them, without a database', async function () {
        this.timeout(30000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        await extension.activate();
        const tables = await vscode.commands.executeCommand('DMDB.parseSchema');

        assert.deepEqual(tables.map(table => table.table), ['users', 'posts']);
        const users = findTable(tables, 'users');
        assert.deepEqual(users.columns.map(withoutGit), [
            { name: 'id', type: 'bigint', primary: true },
            { name: 'email', type: 'varchar' },
            { name: 'display_name', type: 'text', nullable: true },
            { name: 'created_at', type: 'timestamptz' },
        ]);
        const posts = findTable(tables, 'posts');
        assert.deepEqual(posts.relations, [{ foreignKey: 'author_id', references: 'id', on: 'users', type: 'many-to-one' }]);
        // The line of the CREATE TABLE, and of each column: its definition, or the ALTER TABLE that added it
        assert.deepEqual(users.source, { file: 'supabase/migrations/20240101000000_init.sql', line: 2 });
        assert.deepEqual(users.columns.map(column => column.source), [
            { file: 'supabase/migrations/20240101000000_init.sql', line: 3 },
            { file: 'supabase/migrations/20240101000000_init.sql', line: 4 },
            { file: 'supabase/migrations/20240101000000_init.sql', line: 5 },
            { file: 'supabase/migrations/20240102000000_posts_index.sql', line: 2 },
        ]);
        // The fixture is in this repository: every table and column has a git status
        assert.ok(tables.every(table => GIT_STATUSES.includes(table.git) && table.columns.every(column => GIT_STATUSES.includes(column.git))));

        const api = extension.exports;
        const schema = api.getSchema();
        assert.equal(schema.framework, 'sql');
        assert.equal(schema.basePath, workspace());
        assert.deepEqual(api.getFrameworks().map(framework => framework.id), ['laravel', 'symfony', 'prisma', 'drizzle', 'sql']);
        assert.equal(api.detectFramework(workspace()), 'sql');
        assert.deepEqual(api.getSources(workspace(), 'sql'), { folders: [{ path: migrations(), recursive: false }], files: [], extensions: ['.sql'] });
        // The details for the tools: the length, the referential actions, the indexes; the schema after a migration
        const details = api.parseSchema(workspace(), 'sql', { details: true, git: false });
        assert.deepEqual(findTable(details.tables, 'users').columns[1], { name: 'email', type: 'varchar', length: 200, unique: true });
        assert.equal(findTable(details.tables, 'posts').relations[0].onDelete, 'cascade');
        assert.deepEqual(findTable(details.tables, 'posts').indexes, [{ columns: ['author_id'], type: 'index', name: 'posts_author_idx' }]);
        assert.deepEqual(details.warnings, []);
        const before = api.parseSchema(workspace(), 'sql', { git: false, until: '20240101000000_init.sql' });
        assert.deepEqual(findTable(before.tables, 'users').columns.map(column => column.name), ['id', 'email', 'display_name']);
    });

    test('the webview draws the diagram of the SQL migrations', async function () {
        this.timeout(60000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const render = await rendered(extension, r => r.ok && r.entities === 2);
        assert.ok(render && render.ok && render.entities === 2, JSON.stringify(render));
    });

    test('a new migration refreshes the open diagram, and its deletion too', async function () {
        this.timeout(60000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const file = migrations('20240103000000_comments.sql');
        try {
            fs.writeFileSync(file, 'create table public.comments (\n  id bigint primary key,\n  post_id bigint references public.posts (id)\n);\n');
            const added = await rendered(extension, r => r.ok && r.entities === 3);
            assert.equal(added && added.entities, 3, `after the new file: ${JSON.stringify(added)}`);
            assert.ok(findTable(extension.exports.getSchema().tables, 'comments'));
        } finally {
            fs.rmSync(file, { force: true });
        }
        const removed = await rendered(extension, r => r.ok && r.entities === 2);
        assert.equal(removed && removed.entities, 2, `after its deletion: ${JSON.stringify(removed)}`);
    });

    test('an unsaved edit of a migration is drawn live, and reverting it removes it', async function () {
        this.timeout(60000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const document = await vscode.workspace.openTextDocument(migrations('20240102000000_posts_index.sql'));
        await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);

        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, document.positionAt(document.getText().length), '\ncreate table public.drafts (id bigint primary key);\n');
        assert.ok(await vscode.workspace.applyEdit(edit));
        assert.equal(document.isDirty, true, 'not saved');
        const typed = await rendered(extension, r => r.ok && r.entities === 3);
        assert.equal(typed && typed.entities, 3, `while typing: ${JSON.stringify(typed)}`);
        const drafts = findTable(extension.exports.getSchema().tables, 'drafts');
        assert.equal(drafts && drafts.git, 'unsaved');

        assert.equal(await revert(document), true, 'the editor is reverted');
        const reverted = await rendered(extension, r => r.ok && r.entities === 2);
        assert.equal(reverted && reverted.entities, 2, `after the revert: ${JSON.stringify(reverted)}`);
        const tab = tabOf(document);
        if (tab) {
            await vscode.window.tabGroups.close(tab);
        }
    });
});

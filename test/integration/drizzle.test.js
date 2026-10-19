//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Runs inside VS Code (npm test), in the workspace test/fixtures/integration/drizzle-workspace: a
// Drizzle project at the root of the workspace, its schema in the files of src/db/schema (set by
// drizzle.config.ts), columns spread from src/db/columns.ts.

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

suite('DrawMeDatabase extension: a Drizzle project', () => {
    const workspace = () => vscode.workspace.workspaceFolders[0].uri.fsPath;

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('detects the Drizzle project of the workspace and reads its schema files, without running them', async function () {
        this.timeout(30000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        await extension.activate();
        const tables = await vscode.commands.executeCommand('DMDB.parseSchema');

        // In the order of the files: posts.ts, users.ts
        assert.deepEqual(tables.map(table => table.table), ['posts', 'users']);
        const posts = findTable(tables, 'posts');
        assert.deepEqual(posts.columns.map(withoutGit), [
            { name: 'id', type: 'serial', primary: true },
            { name: 'title', type: 'varchar' },
            { name: 'author_id', type: 'integer' },
        ]);
        assert.deepEqual(posts.relations, [{ foreignKey: 'author_id', references: 'id', on: 'users', type: 'many-to-one' }]);
        // The line of the table and of each column: the click on a table, the inspector
        assert.deepEqual(posts.source, { file: 'src/db/schema/posts.ts', line: 4 });
        assert.deepEqual(posts.columns.map(column => column.source), [5, 6, 7].map(line => ({ file: 'src/db/schema/posts.ts', line })));
        const users = findTable(tables, 'users');
        assert.deepEqual(users.columns.map(withoutGit), [
            { name: 'id', type: 'serial', primary: true },
            { name: 'email', type: 'varchar' },
            { name: 'display_name', type: 'text', nullable: true },
            { name: 'created_at', type: 'timestamp' },
        ]);
        // A column spread from a helper file: its line in that file
        assert.deepEqual(users.columns[3].source, { file: 'src/db/columns.ts', line: 4 });
        // The fixture is in this repository: every table and column has a git status
        assert.ok(tables.every(table => GIT_STATUSES.includes(table.git) && table.columns.every(column => GIT_STATUSES.includes(column.git))));

        const api = extension.exports;
        const schema = api.getSchema();
        assert.equal(schema.framework, 'drizzle');
        assert.equal(schema.basePath, workspace());
        assert.deepEqual(api.getFrameworks().map(framework => framework.id), ['laravel', 'symfony', 'prisma', 'drizzle']);
        assert.equal(api.detectFramework(workspace()), 'drizzle');
        const at = (...parts) => path.join(workspace(), ...parts);
        assert.deepEqual(api.getSources(workspace(), 'drizzle'), {
            folders: [{ path: at('src', 'db', 'schema'), recursive: false }],
            files: [at('src', 'db', 'schema', 'posts.ts'), at('src', 'db', 'schema', 'users.ts'), at('src', 'db', 'columns.ts'), at('package.json'), at('drizzle.config.ts')],
            extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
        });
        // The details for the tools: the length, the referential actions, the indexes
        const details = api.parseSchema(workspace(), 'drizzle', { details: true, git: false });
        assert.deepEqual(findTable(details.tables, 'posts').columns[1], { name: 'title', type: 'varchar', length: 200 });
        assert.equal(findTable(details.tables, 'posts').relations[0].onDelete, 'cascade');
        assert.deepEqual(findTable(details.tables, 'posts').indexes, [{ columns: ['author_id'], type: 'index', name: 'posts_author_idx' }]);
        assert.deepEqual(details.warnings, []);
    });

    test('the webview draws the diagram of the Drizzle schema', async function () {
        this.timeout(60000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const render = await rendered(extension, r => r.ok && r.entities === 2);
        assert.ok(render && render.ok && render.entities === 2, JSON.stringify(render));
    });

    test('a new file of the schema folder refreshes the open diagram, and its deletion too', async function () {
        this.timeout(60000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const file = path.join(workspace(), 'src', 'db', 'schema', 'comments.ts');
        try {
            fs.writeFileSync(file, "import { pgTable, serial, text } from 'drizzle-orm/pg-core';\n\nexport const comments = pgTable('comments', {\n  id: serial().primaryKey(),\n  body: text().notNull(),\n});\n");
            const added = await rendered(extension, r => r.ok && r.entities === 3);
            assert.equal(added && added.entities, 3, `after the new file: ${JSON.stringify(added)}`);
            assert.ok(findTable(extension.exports.getSchema().tables, 'comments'));
        } finally {
            fs.rmSync(file, { force: true });
        }
        const removed = await rendered(extension, r => r.ok && r.entities === 2);
        assert.equal(removed && removed.entities, 2, `after its deletion: ${JSON.stringify(removed)}`);
    });

    test('an unsaved edit of a schema file is drawn live, and reverting it removes it', async function () {
        this.timeout(60000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const document = await vscode.workspace.openTextDocument(path.join(workspace(), 'src', 'db', 'schema', 'users.ts'));
        await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);

        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, document.positionAt(document.getText().length), "\nexport const drafts = pgTable('drafts', {\n  id: serial().primaryKey(),\n});\n");
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

    test('an unsaved edit of a helper file whose columns are spread is drawn live too', async function () {
        this.timeout(60000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const document = await vscode.workspace.openTextDocument(path.join(workspace(), 'src', 'db', 'columns.ts'));
        await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);

        const text = document.getText();
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, document.positionAt(text.indexOf('};')), '  updatedAt: timestamp(),\n');
        assert.ok(await vscode.workspace.applyEdit(edit));
        const hasUpdated = () => {
            const users = findTable((extension.exports.getSchema() || { tables: [] }).tables, 'users');
            return Boolean(users && users.columns.some(column => column.name === 'updated_at'));
        };
        assert.ok(await waitFor(hasUpdated, 15000), 'the spread column appears while typing');
        const users = findTable(extension.exports.getSchema().tables, 'users');
        assert.equal(users.columns.find(column => column.name === 'updated_at').git, 'unsaved');

        assert.equal(await revert(document), true, 'the editor is reverted');
        assert.ok(await waitFor(() => !hasUpdated(), 15000), 'gone after the revert');
        const tab = tabOf(document);
        if (tab) {
            await vscode.window.tabGroups.close(tab);
        }
    });
});

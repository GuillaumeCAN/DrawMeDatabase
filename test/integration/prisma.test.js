//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Runs inside VS Code (npm test), in the workspace test/fixtures/integration/prisma-workspace: a
// Prisma project at the root of the workspace, with a multi-file schema in prisma/schema/.

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

suite('DrawMeDatabase extension: a Prisma project', () => {
    const workspace = () => vscode.workspace.workspaceFolders[0].uri.fsPath;

    suiteTeardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('detects the Prisma project of the workspace and reads every file of its schema folder', async function () {
        this.timeout(30000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        await extension.activate();
        const tables = await vscode.commands.executeCommand('DMDB.parseSchema');

        // In the order of the files: post.prisma, schema.prisma (the datasource), user.prisma
        assert.deepEqual(tables.map(table => table.table), ['posts', 'Tag', 'users']);
        const posts = findTable(tables, 'posts');
        assert.deepEqual(posts.columns.map(withoutGit), [
            { name: 'id', type: 'Int', primary: true },
            { name: 'title', type: 'String' },
            { name: 'author_id', type: 'Int' },
        ]);
        assert.deepEqual(posts.relations, [
            { foreignKey: 'author_id', references: 'id', on: 'users', type: 'many-to-one' },
            { foreignKey: 'A', references: 'id', on: 'Tag', type: 'many-to-many', via: '_PostToTag' },
        ]);
        // The line of the model and of each field: the click on a table, the inspector
        assert.deepEqual(posts.source, { file: 'prisma/schema/post.prisma', line: 1 });
        assert.deepEqual(posts.columns.map(column => column.source), [2, 3, 4].map(line => ({ file: 'prisma/schema/post.prisma', line })));
        assert.deepEqual(findTable(tables, 'users').columns.map(withoutGit), [
            { name: 'id', type: 'Int', primary: true },
            { name: 'email', type: 'String' },
            { name: 'name', type: 'String', nullable: true },
        ]);
        // The fixture is in this repository: every table and column has a git status
        assert.ok(tables.every(table => GIT_STATUSES.includes(table.git) && table.columns.every(column => GIT_STATUSES.includes(column.git))));

        const api = extension.exports;
        const schema = api.getSchema();
        assert.equal(schema.framework, 'prisma');
        assert.equal(schema.dialect, 'postgresql', 'the provider of the datasource (API version 4)');
        assert.equal(schema.basePath, workspace());
        assert.equal(api.getMigrations(workspace(), 'prisma'), null, 'no prisma/migrations yet');
        assert.deepEqual(api.getFrameworks().map(framework => framework.id), ['laravel', 'symfony', 'prisma', 'drizzle', 'sql']);
        assert.equal(api.detectFramework(workspace()), 'prisma');
        assert.deepEqual(api.getSources(workspace(), 'prisma'), {
            folders: [{ path: path.join(workspace(), 'prisma', 'schema'), recursive: true }],
            files: [path.join(workspace(), 'package.json'), path.join(workspace(), 'prisma.config.ts')],
            extensions: ['.prisma'],
        });
        // The details for the tools: the native type, the referential actions
        const details = api.parseSchema(workspace(), 'prisma', { details: true, git: false });
        assert.deepEqual(findTable(details.tables, 'posts').columns[1], { name: 'title', type: 'String', length: 200, nativeType: 'VarChar(200)' });
        assert.equal(findTable(details.tables, 'posts').relations[0].onDelete, 'cascade');
        assert.deepEqual(details.warnings, []);
    });

    test('the webview draws the diagram of the Prisma schema', async function () {
        this.timeout(60000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const render = await rendered(extension, r => r.ok && r.entities === 3);
        assert.ok(render && render.ok && render.entities === 3, JSON.stringify(render));
    });

    test('a new .prisma file of the schema folder refreshes the open diagram, and its deletion too', async function () {
        this.timeout(60000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const file = path.join(workspace(), 'prisma', 'schema', 'comment.prisma');
        try {
            fs.writeFileSync(file, 'model Comment {\n  id     Int    @id\n  body   String\n}\n');
            const added = await rendered(extension, r => r.ok && r.entities === 4);
            assert.equal(added && added.entities, 4, `after the new file: ${JSON.stringify(added)}`);
            assert.ok(findTable(extension.exports.getSchema().tables, 'Comment'));
        } finally {
            fs.rmSync(file, { force: true });
        }
        const removed = await rendered(extension, r => r.ok && r.entities === 3);
        assert.equal(removed && removed.entities, 3, `after its deletion: ${JSON.stringify(removed)}`);
    });

    test('an unsaved edit of a model is drawn live, and reverting it removes it', async function () {
        this.timeout(60000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const document = await vscode.workspace.openTextDocument(path.join(workspace(), 'prisma', 'schema', 'user.prisma'));
        await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);

        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, document.positionAt(document.getText().length), '\nmodel Draft {\n  id Int @id\n}\n');
        assert.ok(await vscode.workspace.applyEdit(edit));
        assert.equal(document.isDirty, true, 'not saved');
        const typed = await rendered(extension, r => r.ok && r.entities === 4);
        assert.equal(typed && typed.entities, 4, `while typing: ${JSON.stringify(typed)}`);
        const draft = findTable(extension.exports.getSchema().tables, 'Draft');
        assert.equal(draft && draft.git, 'unsaved');

        assert.equal(await revert(document), true, 'the editor is reverted');
        const reverted = await rendered(extension, r => r.ok && r.entities === 3);
        assert.equal(reverted && reverted.entities, 3, `after the revert: ${JSON.stringify(reverted)}`);
        const tab = tabOf(document);
        if (tab) {
            await vscode.window.tabGroups.close(tab);
        }
    });
});

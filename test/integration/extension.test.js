//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Runs inside VS Code (npm test). The workspace is test/fixtures/integration/workspace, whose
// .vscode/settings.json points DrawMeDatabase.frameworkPath to the Laravel app in backend/.

const assert = require('node:assert/strict');
const vscode = require('vscode');

const EXTENSION_ID = 'GuillaumeCancalon.draw-me-database';

const findTable = (tables, name) => tables.find(table => table.table === name);

const drawMeDatabaseTabs = () => vscode.window.tabGroups.all
    .flatMap(group => group.tabs)
    .filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'DrawMeDatabase');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
        assert.deepEqual(users.columns.find(column => column.name === 'id'),
            { name: 'id', type: 'bigIncrements', primary: true });
        assert.deepEqual(users.columns.map(column => column.name), ['id', 'name', 'email', 'currency']);
        assert.deepEqual(users.relations, []);

        const posts = findTable(tables, 'posts');
        assert.deepEqual(posts.columns.find(column => column.name === 'user_id'),
            { name: 'user_id', type: 'unsignedBigInteger' });
        assert.deepEqual(posts.relations,
            [{ foreignKey: 'user_id', references: 'id', on: 'users', type: 'many-to-one' }]);

        assert.equal(await settledTabCount(), 1, 'one DrawMeDatabase panel is open');
    });

    test('running the command again reuses the same panel', async () => {
        const tables = await vscode.commands.executeCommand('DMDB.parseSchema');
        assert.equal(tables.length, 2);
        assert.equal(await settledTabCount(), 1);
    });
});

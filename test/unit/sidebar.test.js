//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// The items of the views of the Activity Bar (sidebar.js), without VS Code; the views themselves
// are tested with extension.js (extension.test.js).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const sidebar = require('../../sidebar');
const i18n = require('../../views/i18n');

const t = i18n.translator('en');
const fr = i18n.translator('fr');

const SCHEMA = {
    framework: 'laravel',
    tables: [
        {
            table: 'users',
            columns: [{ name: 'id', type: 'bigIncrements', primary: true, git: 'committed', source: { file: 'database/migrations/0001_create_users_table.php', line: 14 } }],
            relations: [],
            source: { file: 'database/migrations/0001_create_users_table.php', line: 12 },
        },
        {
            table: 'posts',
            git: 'modified',
            columns: [
                { name: 'id', type: 'bigIncrements', primary: true },
                { name: 'user_id', type: 'foreignId', git: 'unsaved', source: { file: 'database/migrations/0002_create_posts_table.php', line: 16 } },
                { name: 'title', type: 'string', nullable: true, git: 'weird' },
            ],
            relations: [{ foreignKey: 'user_id', references: 'id', on: 'users', type: 'many-to-one' }],
            source: { file: 'database/migrations/0002_create_posts_table.php', line: 12 },
        },
        // A table only referenced: no file to open
        { table: 'archived', columns: [], relations: [] },
        null,
    ],
};

describe('sidebar: Schema view', () => {
    it('lists the tables by name, with their columns', () => {
        const nodes = sidebar.schemaNodes(SCHEMA, t);
        assert.deepEqual(nodes.map(node => node.label), ['archived', 'posts', 'users']);
        const posts = nodes[1];
        assert.equal(posts.id, 'table:posts');
        assert.equal(posts.table, 'posts');
        assert.equal(posts.description, '3 columns');
        assert.equal(posts.icon, 'table');
        assert.equal(posts.contextValue, 'table');
        assert.deepEqual(posts.command, { id: 'DMDB.openTable', args: ['posts'] });
        assert.equal(posts.tooltip, 'posts\ndatabase/migrations/0002_create_posts_table.php\nChanged since the last commit\nOpen the migration');
        assert.deepEqual(posts.children.map(column => column.label), ['id', 'user_id', 'title']);
        assert.equal(nodes[2].description, '1 column');
    });

    it('describes the columns: key, type, nullable, foreign key, and opens their line', () => {
        const [id, userId, title] = sidebar.schemaNodes(SCHEMA, t)[1].children;
        assert.deepEqual({ id: id.id, icon: id.icon, description: id.description, tooltip: id.tooltip },
            { id: 'column:posts.id', icon: 'key', description: 'bigIncrements', tooltip: 'id: bigIncrements\nPrimary key' });
        assert.equal(id.command, undefined, 'no line: nothing to open');
        assert.equal(userId.icon, 'references');
        assert.equal(userId.description, 'foreignId → users.id');
        assert.equal(userId.tooltip, 'user_id: foreignId\nForeign key to users.id (many to one)\nOpen at the line of this column');
        assert.deepEqual(userId.command, { id: 'DMDB.openTable', args: ['posts', 'user_id'] });
        assert.deepEqual({ table: userId.table, column: userId.column, contextValue: userId.contextValue }, { table: 'posts', column: 'user_id', contextValue: 'column' });
        assert.equal(title.icon, 'symbol-field');
        assert.equal(title.description, 'string?');
    });

    it('colors the git status of the tables, and of the columns with DrawMeDatabase Pro only', () => {
        const free = sidebar.schemaNodes(SCHEMA, t);
        assert.deepEqual(free[1].decoration, { git: 'modified' });
        assert.equal(free[2].decoration, undefined, 'committed');
        assert.ok(free[1].children.every(column => column.decoration === undefined));

        const pro = sidebar.schemaNodes(SCHEMA, t, { columnGit: true })[1].children;
        assert.deepEqual(pro.map(column => column.decoration), [undefined, { git: 'unsaved' }, undefined]);
        assert.match(pro[1].tooltip, /Changes not saved yet/);

        const hidden = sidebar.schemaNodes(SCHEMA, t, { git: false, columnGit: true });
        assert.equal(hidden[1].decoration, undefined);
        assert.ok(hidden[1].children.every(column => column.decoration === undefined));
    });

    it('is empty without a schema, and speaks the language of the setting', () => {
        assert.deepEqual(sidebar.schemaNodes(null, t), []);
        assert.deepEqual(sidebar.schemaNodes({ tables: 'x' }, t), []);
        const posts = sidebar.schemaNodes({ ...SCHEMA, framework: 'symfony' }, fr)[1];
        assert.equal(posts.description, '3 colonnes');
        assert.match(posts.tooltip, /Ouvrir l'entité$/);
    });
});

describe('sidebar: Tools, Exports and License views', () => {
    const features = {
        tools: [
            { id: 'pro.canvas', label: '', hint: '', pro: true, state: 'missing' },
            { id: 'pro.timeline', label: 'Timeline', hint: 'Replay', pro: true, state: 'available' },
            { id: 'pro.checks', label: 'Checks', pro: true, state: 'locked' },
            { id: 'acme.audit', label: 'Audit', hint: 'Audit the schema', icon: 'history', pro: false, state: 'available' },
            { id: 'acme.codicon', label: 'Plug', icon: 'plug', pro: false, state: 'weird' },
            { id: 'acme.bad', label: 'Bad', icon: '<svg>', pro: false },
            { label: 'no id' },
        ],
        exports: [
            { id: 'pro.sql-mysql', label: '', pro: true, state: 'missing' },
            { id: 'pro.typescript', label: 'TS', pro: true, state: 'locked' },
            { id: 'acme.csv', label: 'CSV', pro: false, state: 'available' },
        ],
    };

    it('lists the tools: Pro ones greyed with PRO when missing, with a lock once the trial has ended', () => {
        const nodes = sidebar.toolNodes(features, t);
        assert.deepEqual(nodes.map(node => node.id), ['tool:pro.canvas', 'tool:pro.timeline', 'tool:pro.checks', 'tool:acme.audit', 'tool:acme.codicon', 'tool:acme.bad']);
        const [canvas, timeline, checks, audit, plug, bad] = nodes;
        assert.deepEqual(canvas, {
            id: 'tool:pro.canvas',
            label: 'Schema canvas',
            description: 'PRO',
            tooltip: 'Move the tables and the links by hand\nAvailable with DrawMeDatabase Pro',
            icon: 'layout',
            muted: true,
            decoration: { state: 'missing' },
            contextValue: 'tool.missing',
            command: { id: 'DMDB.runTool', args: ['pro.canvas'] },
        });
        assert.equal(timeline.label, 'Schema time machine', 'the texts of DrawMeDatabase');
        assert.equal(timeline.description, undefined);
        assert.equal(timeline.muted, false);
        assert.equal(timeline.decoration, undefined);
        assert.equal(checks.icon, 'lock');
        assert.deepEqual(checks.decoration, { state: 'locked' });
        assert.match(checks.tooltip, /trial of DrawMeDatabase Pro has ended/);
        assert.deepEqual({ label: audit.label, tooltip: audit.tooltip, icon: audit.icon, description: audit.description },
            { label: 'Audit', tooltip: 'Audit the schema', icon: 'history', description: undefined });
        assert.equal(plug.icon, 'plug', 'a codicon');
        assert.equal(plug.contextValue, 'tool.available');
        assert.equal(bad.icon, 'tools');
        assert.equal(sidebar.toolNodes(features, fr)[0].label, 'Canevas du schéma');
        assert.deepEqual(sidebar.toolNodes({}, t), []);
    });

    it('lists the exports of the diagram, then the ones of the extensions', () => {
        const nodes = sidebar.exportNodes(features, t);
        assert.deepEqual(nodes.map(node => node.id), [
            ...sidebar.BUILT_IN_EXPORTS.map(item => `export:${item.id}`),
            'export:pro.sql-mysql', 'export:pro.typescript', 'export:acme.csv',
        ]);
        assert.deepEqual(nodes[0], {
            id: 'export:svg',
            label: 'Save as SVG…',
            tooltip: 'What the diagram shows: the search result when there is one',
            icon: 'file-media',
            contextValue: 'export.available',
            command: { id: 'DMDB.runExport', args: ['svg'] },
        });
        const [sql, typescript, csv] = nodes.slice(-3);
        assert.deepEqual({ label: sql.label, description: sql.description, icon: sql.icon, muted: sql.muted }, { label: 'SQL (MySQL)', description: 'PRO', icon: 'database', muted: true });
        assert.equal(typescript.icon, 'lock');
        assert.deepEqual({ label: csv.label, icon: csv.icon, muted: csv.muted }, { label: 'CSV', icon: 'file-code', muted: false });
        assert.deepEqual(csv.command, { id: 'DMDB.runExport', args: ['acme.csv'] });
    });

    it('shows the license of DrawMeDatabase Pro and its buttons', () => {
        const labels = (license) => sidebar.licenseNodes(license, t).map(node => node.label);
        assert.deepEqual(labels({ kind: 'free', actions: ['discover'] }), ['Free version', 'Discover DrawMeDatabase Pro']);
        assert.deepEqual(labels({ kind: 'trial', daysLeft: 1, actions: ['buy', 'enter'] }), ['Pro trial: 1 day left', 'Buy a license', 'Enter a license key']);
        assert.deepEqual(labels({ kind: 'expired', actions: ['buy', 'bogus'] }), ['Your Pro trial has ended', 'Buy a license']);
        assert.deepEqual(labels({ kind: 'licensed', actions: ['manage'] }), ['DrawMeDatabase Pro', 'License']);
        assert.deepEqual(labels({ kind: 'development', actions: [] }), ['DrawMeDatabase Pro (development)']);
        assert.deepEqual(labels(null), ['Free version']);
        const [status, buy] = sidebar.licenseNodes({ kind: 'trial', daysLeft: 9, actions: ['buy'] }, fr);
        assert.deepEqual({ label: status.label, icon: status.icon, contextValue: status.contextValue }, { label: 'Essai Pro : encore 9 jours', icon: 'watch', contextValue: 'license.trial' });
        assert.deepEqual({ icon: buy.icon, command: buy.command }, { icon: 'credit-card', command: { id: 'DMDB.licenseAction', args: ['buy'] } });
    });

    it('has an icon for every tool of DrawMeDatabase Pro', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', '..', 'extension.js'), 'utf8');
        const tools = JSON.parse(/const PRO_TOOLS = (\[[^\]]+\])/.exec(source)[1].replace(/'/g, '"'));
        const icons = sidebar.toolNodes({ tools: tools.map(id => ({ id, pro: true, state: 'missing' })) }, t).map(node => node.icon);
        assert.ok(icons.every(icon => icon !== 'tools'), icons.join());
    });
});

describe('sidebar: package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));

    it('declares the container and its views', () => {
        const [container] = pkg.contributes.viewsContainers.activitybar;
        assert.equal(container.id, sidebar.CONTAINER_ID);
        assert.ok(fs.existsSync(path.join(__dirname, '..', '..', container.icon)), container.icon);
        assert.deepEqual(pkg.contributes.views[sidebar.CONTAINER_ID].map(view => view.id), Object.values(sidebar.VIEWS));
    });

    it('the welcome content uses the states of the Schema view, and the commands exist', () => {
        const states = pkg.contributes.viewsWelcome.map(welcome => /drawMeDatabase\.schemaState == (\w+)/.exec(welcome.when)).filter(Boolean).map(match => match[1]);
        assert.ok(states.length >= 4);
        for (const state of states) {
            assert.ok(sidebar.SCHEMA_STATES.includes(state), state);
        }
        const source = fs.readFileSync(path.join(__dirname, '..', '..', 'extension.js'), 'utf8');
        const registered = [...source.matchAll(/registerCommand\('([\w.]+)'/g)].map(match => match[1]);
        const nls = fs.readFileSync(path.join(__dirname, '..', '..', 'package.nls.json'), 'utf8');
        const linked = [...nls.matchAll(/\(command:(DMDB\.\w+)/g)].map(match => match[1]);
        const menus = Object.values(pkg.contributes.menus).flat().map(item => item.command);
        assert.ok(linked.length >= 3);
        for (const command of [...linked, ...menus, ...pkg.contributes.commands.map(item => item.command)]) {
            assert.ok(registered.includes(command), command);
        }
    });
});

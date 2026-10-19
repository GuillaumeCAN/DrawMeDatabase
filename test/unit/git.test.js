//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Git status and unsaved editors (parsers/git.js), and their use by the Laravel parser

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const { lineMapping, tableStatus, createStatusReader, sourcePaths } = require('../../parsers/git');
const laravel = require('../../parsers/laravel');

const TMP = fs.realpathSync(os.tmpdir());

// Isolate the parser's git calls from the developer's config, and from a stray repo above TMP
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CEILING_DIRECTORIES = TMP;

const created = [];
after(() => created.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

function git(cwd, ...args) {
    return childProcess.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
        cwd,
        stdio: 'pipe',
        encoding: 'utf8',
    });
}

// Temporary Laravel project in a git repository, migrations given as { fileName: phpSource }
function repository(files) {
    const dir = fs.mkdtempSync(path.join(TMP, 'dmdb-git-'));
    created.push(dir);
    const migrations = path.join(dir, 'database', 'migrations');
    fs.mkdirSync(migrations, { recursive: true });
    for (const [name, source] of Object.entries(files)) {
        fs.writeFileSync(path.join(migrations, name), source);
    }
    git(dir, 'init', '-q');
    return { dir, migrations, file: (name) => path.join(migrations, name) };
}

function commitAll(cwd) {
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'commit');
}

const migration = (body) => `<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
${body}
    }
};
`;

const USERS = migration(`        Schema::create('users', function (Blueprint $table) {
            $table->id();
            $table->string('email');
        });`);

// { table: { '': tableStatus, column: status } }
function statuses(result) {
    return Object.fromEntries(result.tables.map(table => [table.table, {
        '': table.git,
        ...Object.fromEntries(table.columns.map(column => [column.name, column.git])),
    }]));
}

describe('lineMapping', () => {
    it('maps the unchanged lines of the editor to the saved file, new or changed lines to 0', () => {
        assert.deepEqual(lineMapping('a\nb\nc\nd', 'a\nX\nb\nd\nE'), [0, 1, 0, 2, 4, 0]);
        assert.deepEqual(lineMapping('a\nb', 'a\nb'), [0, 1, 2]);
        assert.deepEqual(lineMapping('a\r\nb\r\n', 'a\nb\n'), [0, 1, 2, 3], 'line endings are ignored');
        assert.deepEqual(lineMapping('', 'x'), [0, 0]);
    });
});

describe('tableStatus', () => {
    it('summarizes the declaration and the columns', () => {
        assert.equal(tableStatus('unsaved', ['committed']), 'unsaved');
        assert.equal(tableStatus('untracked', ['untracked', 'unsaved']), 'untracked');
        assert.equal(tableStatus('committed', ['committed', 'unsaved']), 'unsaved');
        assert.equal(tableStatus('committed', ['committed', 'untracked']), 'modified');
        assert.equal(tableStatus('modified', ['committed']), 'modified');
        assert.equal(tableStatus('committed', ['committed', null]), 'committed');
        assert.equal(tableStatus(null, [null, null]), null);
        assert.equal(tableStatus(null, ['committed']), 'committed');
    });
});

describe('createStatusReader without git', () => {
    it('only tells the lines changed in an editor', () => {
        const { dir, file } = repository({ 'a.php': 'one\ntwo\nthree\n' });
        const overrides = new Map([[file('a.php'), 'one\nTWO\nthree\nfour\n'], [file('new.php'), 'x\n']]);
        const reader = createStatusReader(dir, { git: false, overrides });
        const status = reader.statusOf(file('a.php'));
        assert.equal(status(1, 1), null, 'unchanged line, no git: nothing known');
        assert.equal(status(2, 2), 'unsaved');
        assert.equal(status(1, 3), 'unsaved', 'a range with a changed line');
        assert.equal(status(4, 4), 'unsaved', 'an added line');
        assert.equal(reader.statusOf(file('new.php'))(1, 1), 'unsaved', 'a file that only exists in an editor');
        assert.equal(reader.warning, null);

        // Lines removed inside a range
        const removed = createStatusReader(dir, { git: false, overrides: new Map([[file('a.php'), 'one\nthree\n']]) });
        assert.equal(removed.statusOf(file('a.php'))(1, 2), 'unsaved');
        assert.equal(removed.statusOf(file('a.php'))(2, 2), null);
    });
});

describe('createStatusReader with the sources of a parser', () => {
    it('reads the folders and the files of the sources, the missing ones left out', () => {
        const { dir, file } = repository({ 'a.php': 'one\ntwo\n' });
        fs.mkdirSync(path.join(dir, 'schema'));
        fs.writeFileSync(path.join(dir, 'schema', 'main.x'), 'model\n');
        fs.writeFileSync(path.join(dir, 'config.x'), 'path\n');
        fs.writeFileSync(path.join(dir, 'other.x'), 'not read\n');
        commitAll(dir);
        fs.writeFileSync(file('a.php'), 'one\nTWO\n');
        fs.writeFileSync(path.join(dir, 'schema', 'main.x'), 'model\nfield\n');
        fs.writeFileSync(path.join(dir, 'config.x'), 'other path\n');
        fs.writeFileSync(path.join(dir, 'other.x'), 'changed, not read\n');
        fs.writeFileSync(path.join(dir, 'schema', 'new.x'), 'new\n');

        const sources = {
            folders: [{ path: path.join(dir, 'database', 'migrations'), recursive: false }, { path: path.join(dir, 'schema'), recursive: true }],
            files: [path.join(dir, 'config.x'), path.join(dir, 'missing.x')],
            extensions: ['.php', '.x'],
        };
        const cache = new Map();
        const reader = createStatusReader(sources, { cache });
        assert.equal(reader.warning, null);
        assert.equal(reader.statusOf(file('a.php'))(1, 1), 'committed');
        assert.equal(reader.statusOf(file('a.php'))(2, 2), 'modified');
        assert.equal(reader.statusOf(path.join(dir, 'schema', 'main.x'))(1, 1), 'committed');
        assert.equal(reader.statusOf(path.join(dir, 'schema', 'main.x'))(2, 2), 'modified');
        assert.equal(reader.statusOf(path.join(dir, 'schema', 'new.x'))(1, 1), 'untracked');
        assert.equal(reader.statusOf(path.join(dir, 'config.x'))(1, 1), 'modified');
        // A file outside of the sources: git did not read it
        assert.equal(reader.statusOf(path.join(dir, 'other.x'))(1, 1), 'committed');
        assert.equal(cache.size, 1, 'one git run for all the sources');

        // Only missing files: no git status, and nothing to tell
        const none = createStatusReader({ folders: [], files: [path.join(dir, 'missing.x')] });
        assert.equal(none.warning, null);
        assert.equal(none.statusOf(file('a.php'))(1, 1), null);
    });

    it('takes a folder, a list of paths, or sources', () => {
        assert.deepEqual(sourcePaths('/app/db'), ['/app/db']);
        assert.deepEqual(sourcePaths(['/app/db', 3, '/app/x']), ['/app/db', '/app/x']);
        assert.deepEqual(sourcePaths({ folders: [{ path: '/app/db', recursive: false }, '/app/src', { path: '' }], files: ['/app/schema.x', ''] }), ['/app/db', '/app/src', '/app/schema.x']);
        assert.deepEqual(sourcePaths(undefined), []);
    });
});

describe('laravel parser: git status', () => {
    it('committed, modified, untracked and unsaved tables and columns', () => {
        const repo = repository({ '2024_01_01_000000_create_users_table.php': USERS });
        commitAll(repo.dir);
        assert.deepEqual(statuses(laravel.parse(repo.dir)), {
            users: { '': 'committed', id: 'committed', email: 'committed' },
        });

        // An edit of a committed migration, and a new migration
        fs.writeFileSync(repo.file('2024_01_01_000000_create_users_table.php'), USERS.replace("$table->string('email');", "$table->string('email')->nullable();"));
        fs.writeFileSync(repo.file('2024_01_02_000000_create_posts_table.php'), migration(`        Schema::create('posts', function (Blueprint $table) {
            $table->id();
        });`));
        assert.deepEqual(statuses(laravel.parse(repo.dir)), {
            users: { '': 'modified', id: 'committed', email: 'modified' },
            posts: { '': 'untracked', id: 'untracked' },
        });

        // A column typed in an editor, not saved yet: the other lines keep their status
        const unsaved = USERS.replace("            $table->string('email');", "            $table->string('name');\n            $table->string('email')->nullable();");
        const result = laravel.parse(repo.dir, { overrides: new Map([[repo.file('2024_01_01_000000_create_users_table.php'), unsaved]]) });
        assert.deepEqual(statuses(result).users, { '': 'unsaved', id: 'committed', name: 'unsaved', email: 'modified' });
        assert.deepEqual(result.tables[0].columns.map(column => column.name), ['id', 'name', 'email']);
    });

    it('a column changed or renamed by a later migration takes the status of that migration', () => {
        const repo = repository({ '2024_01_01_000000_create_users_table.php': USERS });
        commitAll(repo.dir);
        fs.writeFileSync(repo.file('2024_01_02_000000_change_users.php'), migration(`        Schema::table('users', function (Blueprint $table) {
            $table->renameColumn('email', 'mail');
        });`));
        assert.deepEqual(statuses(laravel.parse(repo.dir)), {
            users: { '': 'modified', id: 'committed', mail: 'untracked' },
        });
    });

    it('git runs again only once the cache is cleared', () => {
        const repo = repository({ '2024_01_01_000000_create_users_table.php': USERS });
        commitAll(repo.dir);
        const gitCache = new Map();
        assert.equal(laravel.parse(repo.dir, { gitCache }).tables[0].git, 'committed');

        fs.writeFileSync(repo.file('2024_01_01_000000_create_users_table.php'), USERS.replace("'email'", "'mail'"));
        assert.equal(laravel.parse(repo.dir, { gitCache }).tables[0].git, 'committed', 'the cached git status');
        gitCache.clear();
        assert.equal(laravel.parse(repo.dir, { gitCache }).tables[0].git, 'modified');
    });

    it('no git status outside a repository or with git: false', () => {
        const repo = repository({ '2024_01_01_000000_create_users_table.php': USERS });
        fs.rmSync(path.join(repo.dir, '.git'), { recursive: true, force: true });
        const outside = laravel.parse(repo.dir);
        assert.deepEqual(outside.warnings, []);
        assert.equal(outside.tables[0].git, undefined);
        assert.ok(outside.tables[0].columns.every(column => column.git === undefined));

        const repo2 = repository({ '2024_01_01_000000_create_users_table.php': USERS });
        commitAll(repo2.dir);
        assert.equal(laravel.parse(repo2.dir, { git: false }).tables[0].git, undefined);
    });
});

//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// The registry of the parsers (parsers/registry.js): the contract of the parsers, the detection of
// the stack of a folder (scores, ties, the DrawMeDatabase.framework setting) and their sources

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registry = require('../../parsers/registry');
const { detectFramework, createRegistry, covers, watchPatterns } = registry;
const { ParserError } = require('../../parsers/errors');
const pkg = require('../../package.json');

let tmpRoot;

test.before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmdb-detect-'));
});

test.after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Creates a project folder with the given files (relative path -> content)
function project(name, files) {
    const dir = path.join(tmpRoot, name);
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), content);
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

const composer = (dependencies, extra = {}) => JSON.stringify({ name: 'acme/app', require: dependencies, ...extra }, null, 4);

test('detects Laravel: artisan + laravel/framework', () => {
    const dir = project('laravel', {
        artisan: '#!/usr/bin/env php',
        'composer.json': composer({ php: '^8.2', 'laravel/framework': '^12.0' }),
    });
    assert.equal(detectFramework(dir), 'laravel');
});

test('detects Symfony: bin/console + symfony/framework-bundle', () => {
    const dir = project('symfony', {
        'bin/console': '#!/usr/bin/env php',
        'composer.json': composer({ php: '>=8.2', 'symfony/framework-bundle': '7.4.*', 'doctrine/orm': '^3.3' }),
    });
    assert.equal(detectFramework(dir), 'symfony');
});

test('detects Symfony with another symfony/* package', () => {
    const dir = project('symfony-console', {
        'bin/console': '',
        'composer.json': composer({ 'symfony/console': '^7.4', 'doctrine/orm': '^3.3' }),
    });
    assert.equal(detectFramework(dir), 'symfony');
});

test('a symfony polyfill alone is not Symfony', () => {
    const dir = project('polyfill', {
        'bin/console': '',
        'composer.json': composer({ 'symfony/polyfill-mbstring': '^1.31' }),
    });
    assert.equal(detectFramework(dir), 'Unknown');
});

test('packages only in require-dev are ignored', () => {
    const dir = project('require-dev', {
        artisan: '',
        'bin/console': '',
        'composer.json': composer({ php: '^8.2' }, { 'require-dev': { 'laravel/framework': '^12.0', 'symfony/framework-bundle': '^7.4' } }),
    });
    assert.equal(detectFramework(dir), 'Unknown');
});

test('Laravel needs artisan, Symfony needs bin/console', () => {
    const noArtisan = project('no-artisan', { 'composer.json': composer({ 'laravel/framework': '^12.0' }) });
    assert.equal(detectFramework(noArtisan), 'Unknown');
    const noConsole = project('no-console', { 'composer.json': composer({ 'symfony/framework-bundle': '^7.4' }) });
    assert.equal(detectFramework(noConsole), 'Unknown');
});

test('Laravel wins when both markers are present', () => {
    const dir = project('both', {
        artisan: '',
        'bin/console': '',
        'composer.json': composer({ 'laravel/framework': '^12.0', 'symfony/console': '^7.4' }),
    });
    assert.equal(detectFramework(dir), 'laravel');
});

test('unknown project, missing composer.json or missing folder', () => {
    assert.equal(detectFramework(project('empty', {})), 'Unknown');
    assert.equal(detectFramework(project('no-composer', { artisan: '' })), 'Unknown');
    assert.equal(detectFramework(path.join(tmpRoot, 'does-not-exist')), 'Unknown');
    assert.equal(detectFramework(''), 'Unknown');
    assert.equal(detectFramework(undefined), 'Unknown');
});

test('invalid composer.json is reported with the reason', () => {
    const trailingComma = project('bad-json', {
        artisan: '',
        'composer.json': '{"require": {"laravel/framework": "^12.0",}}',
    });
    assert.throws(() => detectFramework(trailingComma), error => error instanceof ParserError
        && error.message.startsWith(`composer.json in "${trailingComma}" could not be read: `)
        && /JSON/.test(error.message));

    const empty = project('empty-json', { artisan: '', 'composer.json': '' });
    assert.throws(() => detectFramework(empty), ParserError);
});

test('composer.json without a usable "require" is Unknown', () => {
    for (const [name, content] of [['null-json', 'null'], ['array-require', '{"require": ["laravel/framework"]}'], ['no-require', '{}']]) {
        assert.equal(detectFramework(project(name, { artisan: '', 'composer.json': content })), 'Unknown', name);
    }
});

test('composer.json with a UTF-8 BOM is read', () => {
    const laravel = project('bom-laravel', {
        artisan: '',
        'composer.json': '\uFEFF' + composer({ 'laravel/framework': '^12.0' }),
    });
    assert.equal(detectFramework(laravel), 'laravel');

    const symfony = project('bom-symfony', {
        'bin/console': '',
        'composer.json': Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(composer({ 'symfony/framework-bundle': '^7.4' }))]),
    });
    assert.equal(detectFramework(symfony), 'symfony');
});

test('no source file holds a raw byte order mark: an editor that strips it would empty the regex that removes it', () => {
    const ROOT = path.join(__dirname, '..', '..');
    const files = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory() && !['node_modules', 'vendor', 'fixtures', '.git', '.vscode-test'].includes(entry.name)) {
                walk(full);
            } else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) {
                files.push(full);
            }
        }
    };
    walk(ROOT);
    assert.ok(files.includes(path.join(ROOT, 'parsers', 'composer.js')));
    assert.deepEqual(files.filter(file => fs.readFileSync(file, 'utf8').includes('\uFEFF')).map(file => path.relative(ROOT, file)), []);
});

const PRISMA_SCHEMA = 'datasource db {\n  provider = "postgresql"\n}\n\nmodel User {\n  id Int @id\n}\n';

test('detects Prisma: a schema and prisma or @prisma/client in package.json, or the schema alone', () => {
    const app = project('prisma-app', { 'package.json': JSON.stringify({ devDependencies: { prisma: '^7.10.1' } }), 'prisma/schema.prisma': PRISMA_SCHEMA });
    assert.deepEqual(registry.detect(app), { framework: 'prisma', forced: false, matches: [{ id: 'prisma', label: 'Prisma', score: 100 }], errors: [] });
    assert.equal(detectFramework(project('prisma-schema-only', { 'schema.prisma': PRISMA_SCHEMA })), 'prisma');
    assert.equal(detectFramework(project('prisma-folder', { 'prisma/schema/user.prisma': PRISMA_SCHEMA })), 'prisma');
    // The package alone is no Prisma project (a monorepo root, an app using the client of a package)
    assert.equal(detectFramework(project('prisma-package-only', { 'package.json': JSON.stringify({ dependencies: { '@prisma/client': '6.19.1' } }) })), 'Unknown');
    assert.equal(detectFramework(project('node-app', { 'package.json': JSON.stringify({ dependencies: { express: '^5.0.0' } }) })), 'Unknown');
});

test('Laravel and Symfony win a tie with Prisma, a stronger Prisma wins over a weaker Symfony; both are listed', () => {
    const prisma = { 'package.json': JSON.stringify({ devDependencies: { prisma: '^7.10.1' } }), 'prisma/schema.prisma': PRISMA_SCHEMA };
    const laravel = project('laravel-prisma', { artisan: '', 'composer.json': composer({ 'laravel/framework': '^12.0' }), ...prisma });
    assert.deepEqual(registry.detect(laravel).matches.map(match => [match.id, match.score]), [['laravel', 100], ['prisma', 100]]);
    assert.equal(detectFramework(laravel), 'laravel');
    assert.equal(detectFramework(laravel, { framework: 'prisma' }), 'prisma', 'the setting chooses Prisma');
    const symfony = project('symfony-console-prisma', { 'bin/console': '', 'composer.json': composer({ 'symfony/console': '^7.4' }), ...prisma });
    assert.deepEqual(registry.detect(symfony).matches.map(match => [match.id, match.score]), [['prisma', 100], ['symfony', 80]]);
    // An invalid composer.json does not hide a Prisma project
    assert.equal(detectFramework(project('prisma-bad-composer', { artisan: '', 'composer.json': '{,}', ...prisma })), 'prisma');
});

const DRIZZLE_SCHEMA = "import { pgTable, integer } from 'drizzle-orm/pg-core';\nexport const users = pgTable('users', { id: integer().primaryKey() });\n";
const DRIZZLE_PACKAGE = JSON.stringify({ dependencies: { 'drizzle-orm': '^0.45.4' }, devDependencies: { 'drizzle-kit': '^0.31.11' } });

test('detects Drizzle: a drizzle.config.ts and its schema files, or a schema at a usual location and drizzle-orm in package.json', () => {
    const app = project('drizzle-app', { 'drizzle.config.ts': "export default { dialect: 'postgresql', schema: './src/db/schema.ts' };\n", 'src/db/schema.ts': DRIZZLE_SCHEMA });
    assert.deepEqual(registry.detect(app), { framework: 'drizzle', forced: false, matches: [{ id: 'drizzle', label: 'Drizzle', score: 100 }], errors: [] });
    assert.equal(detectFramework(project('drizzle-no-config', { 'package.json': DRIZZLE_PACKAGE, 'src/db/schema.ts': DRIZZLE_SCHEMA })), 'drizzle');
    assert.equal(detectFramework(project('drizzle-schema-only', { 'db/schema.ts': DRIZZLE_SCHEMA })), 'drizzle', 'a schema file that imports drizzle-orm (50)');
    // The package alone is no Drizzle project (a monorepo root), nor is another TypeScript project
    assert.equal(detectFramework(project('drizzle-package-only', { 'package.json': DRIZZLE_PACKAGE })), 'Unknown');
    assert.equal(detectFramework(project('kysely-app', { 'package.json': JSON.stringify({ dependencies: { kysely: '^0.28.0' } }), 'src/db/schema.ts': 'export interface Database {}\n' })), 'Unknown');
});

test('Prisma wins a tie with Drizzle (a project moving from one to the other); the setting chooses Drizzle; both are listed', () => {
    const both = project('prisma-drizzle', {
        'package.json': JSON.stringify({ dependencies: { '@prisma/client': '6.19.1', 'drizzle-orm': '0.45.4' } }),
        'prisma/schema.prisma': PRISMA_SCHEMA,
        'src/db/schema.ts': DRIZZLE_SCHEMA,
    });
    assert.deepEqual(registry.detect(both).matches.map(match => [match.id, match.score]), [['prisma', 100], ['drizzle', 100]]);
    assert.equal(detectFramework(both), 'prisma');
    assert.equal(detectFramework(both, { framework: 'drizzle' }), 'drizzle');
    // A Drizzle config file whose schema is missing (50) loses to a Prisma schema with its package
    const half = project('prisma-drizzle-config', { 'package.json': JSON.stringify({ devDependencies: { prisma: '^7.10.1' } }), 'prisma/schema.prisma': PRISMA_SCHEMA, 'drizzle.config.ts': "export default { schema: './missing.ts' };\n" });
    assert.deepEqual(registry.detect(half).matches.map(match => [match.id, match.score]), [['prisma', 100], ['drizzle', 50]]);
});

test('detects SQL: the migrations of a SQL tool or a dump (45, 40), below the frameworks, whose SQL output it is not when they are detected', () => {
    const supabase = project('sql-supabase', { 'supabase/migrations/20240101000000_init.sql': 'create table profiles (id uuid primary key references auth.users);\n' });
    assert.deepEqual(registry.detect(supabase), { framework: 'sql', forced: false, matches: [{ id: 'sql', label: 'SQL', score: 45 }], errors: [] });
    assert.equal(detectFramework(project('sql-dump', { 'db/schema.sql': 'CREATE TABLE a (id int);\n' })), 'sql');
    assert.equal(detectFramework(project('sql-loose', { 'notes.sql': 'CREATE TABLE a (id int);\n' })), 'Unknown', 'a .sql file of any name is read only when the setting chooses sql');
    // Below every framework, also a Prisma schema without its package (50)
    const laravel = project('laravel-sql', { artisan: '', 'composer.json': composer({ 'laravel/framework': '^12.0' }), 'schema.sql': 'CREATE TABLE a (id int);\n' });
    assert.deepEqual(registry.detect(laravel).matches.map(match => [match.id, match.score]), [['laravel', 100], ['sql', 40]]);
    const prisma = project('prisma-sql', { 'prisma/schema.prisma': PRISMA_SCHEMA, 'supabase/migrations/1_init.sql': 'CREATE TABLE a (id int);\n' });
    assert.deepEqual(registry.detect(prisma).matches.map(match => [match.id, match.score]), [['prisma', 50], ['sql', 45]]);
    // prisma/migrations is the SQL of a Prisma project, not a SQL project; the setting reads it
    const migrated = project('prisma-migrated', { 'package.json': JSON.stringify({ devDependencies: { prisma: '^7.10.1' } }), 'prisma/schema.prisma': PRISMA_SCHEMA, 'prisma/migrations/1_init/migration.sql': 'CREATE TABLE "User" ("id" INTEGER NOT NULL);\n' });
    assert.deepEqual(registry.detect(migrated).matches.map(match => match.id), ['prisma']);
    assert.equal(detectFramework(migrated, { framework: 'sql' }), 'sql');
    assert.deepEqual(registry.getParser('sql').parse(migrated, { git: false }).tables.map(t => t.table), ['User']);
});

test('artisan must be a file', () => {
    const dir = project('artisan-dir', {
        'artisan/readme.txt': '',
        'composer.json': composer({ 'laravel/framework': '^12.0' }),
    });
    assert.equal(detectFramework(dir), 'Unknown');
});

// ---------------------------------------------------------------------------------------------
// Registry

// A parser of the contract that gives `score` (or runs it, when it is a function)
const fake = (id, score, extra = {}) => ({
    id,
    label: id.toUpperCase(),
    detect: typeof score === 'function' ? score : () => score,
    sources: () => ({ folders: [], files: [], extensions: [] }),
    parse: () => ({ tables: [], warnings: [] }),
    ...extra,
});

// Both markers and both framework packages: Laravel and Symfony both give 100
const BOTH = {
    artisan: '',
    'bin/console': '',
    'composer.json': composer({ 'laravel/framework': '^12.0', 'symfony/framework-bundle': '^7.4' }),
};

test('every parser follows the contract: id, label, detect(), sources(), parse()', () => {
    const parsers = registry.getParsers();
    assert.deepEqual(parsers.map(parser => parser.id), ['laravel', 'symfony', 'prisma', 'drizzle', 'sql'], 'Laravel first: it wins the ties');
    assert.deepEqual(registry.labels(), ['Laravel', 'Symfony', 'Prisma', 'Drizzle', 'SQL']);
    const missing = path.join(tmpRoot, 'does-not-exist');
    for (const parser of parsers) {
        assert.match(parser.id, /^[a-z][a-z0-9-]*$/, parser.id);
        assert.notEqual(parser.id, 'auto', 'auto is the value of the setting that detects');
        assert.ok(typeof parser.label === 'string' && parser.label.trim(), parser.id);
        for (const member of ['detect', 'sources', 'parse']) {
            assert.equal(typeof parser[member], 'function', `${parser.id}.${member}`);
        }
        assert.equal(parser.detect(missing), 0, `${parser.id}: no score for a missing folder`);
        assert.equal(registry.getParser(parser.id), parser);
        const sources = registry.getSources(parser.id, tmpRoot);
        assert.ok(sources.folders.length + sources.files.length > 0, `${parser.id} reads something`);
        assert.ok([...sources.folders.map(folder => folder.path), ...sources.files].every(item => path.isAbsolute(item) && item.startsWith(tmpRoot + path.sep)));
    }
    assert.equal(new Set(parsers.map(parser => parser.id)).size, parsers.length, 'unique ids');
    assert.equal(registry.getParser('rails'), undefined);
    assert.equal(registry.getParser(undefined), undefined);
});

test('scores: Laravel 100, Symfony 100 with its framework bundle and 80 with another symfony/* package', () => {
    const laravel = registry.getParser('laravel');
    const symfony = registry.getParser('symfony');
    const bundle = project('score-bundle', { 'bin/console': '', 'composer.json': composer({ 'symfony/framework-bundle': '^7.4' }) });
    const consoleOnly = project('score-console', { 'bin/console': '', 'composer.json': composer({ 'symfony/console': '^7.4' }) });
    const app = project('score-laravel', { artisan: '', 'composer.json': composer({ 'laravel/framework': '^12.0' }) });
    assert.equal(laravel.detect(app), 100);
    assert.equal(symfony.detect(app), 0);
    assert.equal(symfony.detect(bundle), 100);
    assert.equal(symfony.detect(consoleOnly), 80);
    assert.equal(laravel.detect(bundle), 0);
    assert.deepEqual(registry.detect(consoleOnly), { framework: 'symfony', forced: false, matches: [{ id: 'symfony', label: 'Symfony', score: 80 }], errors: [] });
    assert.deepEqual(registry.detect(project('score-none', {})), { framework: 'Unknown', forced: false, matches: [], errors: [] });
});

test('Laravel wins a tie with Symfony, as before the registry; both are listed', () => {
    const dir = project('tie', BOTH);
    assert.deepEqual(registry.detect(dir).matches.map(match => [match.id, match.score]), [['laravel', 100], ['symfony', 100]]);
    assert.equal(detectFramework(dir), 'laravel');
});

test('the best score wins, the order of the registry breaks the ties', () => {
    const scored = createRegistry([fake('a', 50), fake('b', 80), fake('c', 80), fake('d', 0)]);
    assert.deepEqual(scored.detect(tmpRoot), {
        framework: 'b',
        forced: false,
        matches: [{ id: 'b', label: 'B', score: 80 }, { id: 'c', label: 'C', score: 80 }, { id: 'a', label: 'A', score: 50 }],
        errors: [],
    });
    assert.equal(createRegistry([fake('a', 80), fake('b', 80)]).detectFramework(tmpRoot), 'a');
    assert.equal(createRegistry([fake('b', 80), fake('a', 80)]).detectFramework(tmpRoot), 'b');
    assert.equal(createRegistry([fake('low', 1), fake('high', 2)]).detectFramework(tmpRoot), 'high');
    // Not a positive finite number: not this stack
    assert.equal(createRegistry([fake('a', 'yes'), fake('b', -1), fake('c', NaN), fake('d', Infinity), fake('e', null)]).detectFramework(tmpRoot), 'Unknown');
    // A number as text counts
    assert.equal(createRegistry([fake('a', '30')]).detectFramework(tmpRoot), 'a');
    // Parsers given as functions are loaded on use
    let loaded = 0;
    const lazy = createRegistry([() => {
        loaded++;
        return fake('lazy', 10);
    }]);
    assert.equal(loaded, 0);
    assert.equal(lazy.detectFramework(tmpRoot), 'lazy');
    assert.ok(loaded > 0);
});

test('the error of a parser is thrown only when no other parser recognizes the folder', () => {
    const broken = fake('broken', () => {
        throw new ParserError('broken config');
    });
    assert.equal(createRegistry([broken, fake('ok', 10)]).detectFramework(tmpRoot), 'ok');
    assert.throws(() => createRegistry([fake('none', 0), broken]).detectFramework(tmpRoot), error => error instanceof ParserError && error.message === 'broken config');
    // The first error is thrown
    const other = fake('other', () => {
        throw new ParserError('other config');
    });
    assert.throws(() => createRegistry([broken, other]).detectFramework(tmpRoot), /broken config/);
    // No detection without a folder
    assert.equal(createRegistry([broken]).detectFramework(''), 'Unknown');
    assert.equal(createRegistry([broken]).detectFramework(tmpRoot, { framework: 'broken' }), 'broken', 'set, it is not detected');
});

test('the errors of the parsers that throw come with the detection when another parser recognizes the folder', () => {
    const broken = fake('broken', () => {
        throw new ParserError('broken config');
    });
    assert.deepEqual(createRegistry([broken, fake('ok', 10)]).detect(tmpRoot), {
        framework: 'ok',
        forced: false,
        matches: [{ id: 'ok', label: 'OK', score: 10 }],
        errors: [{ id: 'broken', label: 'BROKEN', message: 'broken config' }],
    });
    // A PHP project whose composer.json is invalid, with a Prisma schema: drawn as Prisma, the
    // error of composer.json is kept for the output
    const dir = project('prisma-broken-composer', { artisan: '', 'bin/console': '', 'composer.json': '{,}', 'prisma/schema.prisma': PRISMA_SCHEMA });
    const detection = registry.detect(dir);
    assert.equal(detection.framework, 'prisma');
    assert.deepEqual(detection.errors.map(error => [error.id, error.label]), [['laravel', 'Laravel'], ['symfony', 'Symfony']]);
    assert.ok(detection.errors.every(error => error.message.startsWith(`composer.json in "${dir}" could not be read: `)), JSON.stringify(detection.errors));
    // Set, nothing is detected: no errors
    assert.deepEqual(registry.detect(dir, { framework: 'prisma' }).errors, []);
});

test('getSources() gives options.overrides (the unsaved editors) to the parser: its sources may follow an unsaved configuration file', () => {
    const received = [];
    const configured = createRegistry([fake('conf', 1, {
        sources: (basePath, options) => {
            received.push(options);
            return { files: options && options.overrides ? [...options.overrides.keys()] : [] };
        },
    })]);
    const overrides = new Map([[path.join(tmpRoot, 'config.json'), '{}']]);
    assert.deepEqual(configured.getSources('conf', tmpRoot, { overrides }).files, [path.join(tmpRoot, 'config.json')]);
    assert.equal(received[0].overrides, overrides);
    assert.deepEqual(configured.getSources('conf', tmpRoot).files, []);
    assert.deepEqual(configured.getSources('conf', tmpRoot, { overrides: 'not a Map' }).files, []);
    assert.deepEqual(received.slice(1), [{ overrides: null }, { overrides: null }]);
    // Laravel and Symfony read fixed folders, whatever the editors
    for (const id of ['laravel', 'symfony']) {
        assert.deepEqual(registry.getSources(id, tmpRoot, { overrides }), registry.getSources(id, tmpRoot), id);
    }
});

test('options.framework (the DrawMeDatabase.framework setting) wins over the detection', () => {
    const dir = project('tie-setting', BOTH);
    assert.equal(detectFramework(dir, { framework: 'symfony' }), 'symfony');
    assert.deepEqual(registry.detect(dir, { framework: 'symfony' }), { framework: 'symfony', forced: true, matches: [], errors: [] });
    assert.equal(detectFramework(dir, { framework: 'laravel' }), 'laravel');
    // Even for a folder that does not look like it: the parser then tells what is missing
    assert.equal(detectFramework(project('forced-empty', {}), { framework: 'symfony' }), 'symfony');
    // An invalid composer.json is not read
    const bad = project('forced-bad-json', { artisan: '', 'composer.json': '{,}' });
    assert.equal(detectFramework(bad, { framework: 'laravel' }), 'laravel');
    assert.throws(() => detectFramework(bad), ParserError);
    // 'auto', a value that names no parser, or no value: detected
    for (const framework of ['auto', 'rails', 'Laravel', '', undefined, null, 42]) {
        assert.equal(detectFramework(dir, { framework }), 'laravel', String(framework));
        assert.equal(registry.detect(dir, { framework }).forced, false, String(framework));
    }
    assert.equal(detectFramework(dir, null), 'laravel');
    assert.equal(detectFramework(dir, 'symfony'), 'laravel', 'options is an object');
});

test('the DrawMeDatabase.framework setting lists auto and the parsers, each one described', () => {
    const setting = pkg.contributes.configuration.properties['DrawMeDatabase.framework'];
    assert.deepEqual(setting.enum, ['auto', ...registry.getParsers().map(parser => parser.id)]);
    assert.equal(setting.default, 'auto');
    assert.equal(setting.scope, 'resource', 'per workspace folder, like the framework folder');
    assert.equal(setting.enumDescriptions.length, setting.enum.length);
    const english = require('../../package.nls.json');
    const french = require('../../package.nls.fr.json');
    for (const key of [setting.markdownDescription, ...setting.enumDescriptions].map(text => text.replace(/^%|%$/g, ''))) {
        assert.ok(english[key] && french[key], key);
    }
});

// ---------------------------------------------------------------------------------------------
// Sources

test('the sources of Laravel and Symfony: database/migrations and src/Entity (with its sub-folders)', () => {
    const base = path.join(tmpRoot, 'app');
    assert.deepEqual(registry.getSources('laravel', base), { folders: [{ path: path.join(base, 'database', 'migrations'), recursive: false }], files: [], extensions: ['.php'] });
    assert.deepEqual(registry.getSources('symfony', base), { folders: [{ path: path.join(base, 'src', 'Entity'), recursive: true }], files: [], extensions: ['.php'] });
    assert.equal(registry.getSources('rails', base), undefined);
});

test('the sources of Prisma: the schema file (or folder), package.json and the config file', () => {
    const app = project('prisma-sources', { 'prisma/schema.prisma': PRISMA_SCHEMA });
    assert.deepEqual(registry.getSources('prisma', app), {
        folders: [],
        files: [path.join(app, 'prisma', 'schema.prisma'), path.join(app, 'package.json'), path.join(app, 'prisma.config.ts')],
        extensions: ['.prisma'],
    });
    assert.deepEqual(watchPatterns(registry.getSources('prisma', app)), [
        { base: path.join(app, 'prisma'), pattern: 'schema.prisma' },
        { base: app, pattern: 'package.json' },
        { base: app, pattern: 'prisma.config.ts' },
    ]);
});

test('the sources of Drizzle: the schema files and what they import, the folders of drizzle.config.ts, package.json and the config file', () => {
    const app = project('drizzle-sources', {
        'drizzle.config.ts': "export default { schema: './src/db/schema/*.ts' };\n",
        'src/db/schema/users.ts': `import { timestamps } from '../columns';\n${DRIZZLE_SCHEMA}`,
        'src/db/columns.ts': 'export const timestamps = {};\n',
    });
    const sources = registry.getSources('drizzle', app);
    assert.deepEqual(sources.folders, [{ path: path.join(app, 'src', 'db', 'schema'), recursive: false }]);
    assert.deepEqual(sources.files, [path.join(app, 'src', 'db', 'schema', 'users.ts'), path.join(app, 'src', 'db', 'columns.ts'), path.join(app, 'package.json'), path.join(app, 'drizzle.config.ts')]);
    assert.equal(covers(sources, path.join(app, 'src', 'db', 'schema', 'posts.ts')), true);
    assert.equal(covers(sources, path.join(app, 'src', 'db', 'schema', 'notes.md')), false);
    assert.equal(covers(sources, path.join(app, 'src', 'db', 'seed.ts')), false);
});

test('the sources of SQL: the folder of the migrations of its tool, or the dump; the places looked for while there is none', () => {
    const flyway = project('sql-sources-flyway', { 'src/main/resources/db/migration/V1__init.sql': 'CREATE TABLE a (id int);\n' });
    const sources = registry.getSources('sql', flyway);
    assert.deepEqual(sources, { folders: [{ path: path.join(flyway, 'src', 'main', 'resources', 'db', 'migration'), recursive: true }], files: [], extensions: ['.sql'] });
    assert.equal(covers(sources, path.join(flyway, 'src', 'main', 'resources', 'db', 'migration', 'v2', 'V2__more.sql')), true);
    assert.equal(covers(sources, path.join(flyway, 'src', 'main', 'resources', 'db', 'migration', 'README.md')), false);
    const empty = registry.getSources('sql', project('sql-sources-empty', {}));
    assert.ok(empty.folders.length > 5 && empty.files.length > 5);
});

test('getSources() cleans the sources of a parser: absolute paths, recursive or not, extensions with a dot', () => {
    const base = path.join(tmpRoot, 'app');
    const custom = createRegistry([fake('x', 1, {
        sources: (basePath) => ({
            folders: ['db', { path: path.join(basePath, 'src'), recursive: true }, { path: 'lib', recursive: 'yes' }, { path: '' }, null, 3],
            files: ['schema.x', '', 3, path.join(basePath, 'config.x')],
            extensions: ['x', '.y', 'x', ''],
        }),
    }), fake('none', 1, { sources: () => undefined })]);
    assert.deepEqual(custom.getSources('x', base), {
        folders: [{ path: path.join(base, 'db'), recursive: false }, { path: path.join(base, 'src'), recursive: true }, { path: path.join(base, 'lib'), recursive: false }],
        files: [path.join(base, 'schema.x'), path.join(base, 'config.x')],
        extensions: ['.x', '.y'],
    });
    assert.deepEqual(custom.getSources('none', base), { folders: [], files: [], extensions: [] });
});

test('covers(): the files of the folders with the extensions, the sub-folders of the recursive ones, the listed files', () => {
    const base = path.join(tmpRoot, 'app');
    const at = (...segments) => path.join(base, ...segments);
    const laravel = registry.getSources('laravel', base);
    assert.equal(covers(laravel, at('database', 'migrations', '2024_01_01_000000_create_users_table.php')), true);
    assert.equal(covers(laravel, at('database', 'migrations', 'old', '2024_01_01_000000_create_users_table.php')), false, 'not read by Laravel');
    assert.equal(covers(laravel, at('database', 'migrations', 'notes.md')), false);
    assert.equal(covers(laravel, at('database', 'migrations.php')), false);
    assert.equal(covers(laravel, at('database', 'migrations', '..', 'seeders', 'a.php')), false);

    const symfony = registry.getSources('symfony', base);
    assert.equal(covers(symfony, at('src', 'Entity', 'Blog', 'Post.php')), true);
    assert.equal(covers(symfony, at('src', 'Entity', 'Post.php')), true);
    assert.equal(covers(symfony, at('src', 'EntityListener', 'Post.php')), false, 'a folder of the same prefix');
    assert.equal(covers(symfony, at('src', 'Entity')), false);

    const other = { folders: [{ path: at('prisma'), recursive: false }], files: [at('package.json')], extensions: ['.prisma'] };
    assert.equal(covers(other, at('package.json')), true, 'a listed file, whatever its extension');
    assert.equal(covers(other, at('prisma', 'schema.prisma')), true);
    assert.equal(covers(other, at('prisma', 'seed.ts')), false);
    assert.equal(covers({ folders: [{ path: at('sql'), recursive: true }], files: [], extensions: [] }, at('sql', 'v1', 'init.sql')), true, 'no extensions: every file');
    assert.equal(covers(null, at('a.php')), false);
    assert.equal(covers(laravel, ''), false);
    assert.equal(covers(laravel, undefined), false);
});

test('watchPatterns(): a glob per folder (its sub-folders when recursive) and per file', () => {
    const base = path.join(tmpRoot, 'app');
    assert.deepEqual(watchPatterns(registry.getSources('laravel', base)), [{ base: path.join(base, 'database', 'migrations'), pattern: '*.php' }]);
    assert.deepEqual(watchPatterns(registry.getSources('symfony', base)), [{ base: path.join(base, 'src', 'Entity'), pattern: '**/*.php' }]);
    assert.deepEqual(watchPatterns({ folders: [{ path: path.join(base, 'prisma'), recursive: true }], files: [path.join(base, 'prisma.config.ts')], extensions: ['.prisma', '.sql'] }), [
        { base: path.join(base, 'prisma'), pattern: '**/*.{prisma,sql}' },
        { base, pattern: 'prisma.config.ts' },
    ]);
    assert.deepEqual(watchPatterns({ folders: [{ path: path.join(base, 'sql'), recursive: false }], files: [], extensions: [] }), [{ base: path.join(base, 'sql'), pattern: '*' }]);
    assert.deepEqual(watchPatterns(undefined), []);
});

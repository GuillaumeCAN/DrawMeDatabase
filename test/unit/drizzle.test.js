//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// The Drizzle parser (parsers/drizzle.js): where the schema is, the tables drizzle-kit creates from
// it, the relations, the details, the source lines and the git status. The fixtures were checked
// with drizzle-kit 0.31.11 (`drizzle-kit generate`) and 1.0.0-rc.4 (see test/fixtures/drizzle/README.md).

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const parser = require('../../parsers/drizzle');
const registry = require('../../parsers/registry');
const { ParserError } = require('../../parsers/errors');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'drizzle');
const TMP = fs.realpathSync(os.tmpdir());

// Isolate the parser's git calls from the developer's config, and from a stray repo above TMP
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CEILING_DIRECTORIES = TMP;

const created = [];
after(() => {
    for (const dir of created) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// Temporary project with the given files ({ 'src/db/schema.ts': '...' })
function project(files = {}) {
    const dir = fs.mkdtempSync(path.join(TMP, 'dmdb-drizzle-'));
    created.push(dir);
    writeFiles(dir, files);
    return dir;
}

function writeFiles(dir, files) {
    for (const [rel, content] of Object.entries(files)) {
        const filePath = path.join(dir, rel);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    }
}

function git(cwd, ...args) {
    return childProcess.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
        cwd,
        stdio: 'pipe',
        encoding: 'utf8',
    });
}

function commitAll(cwd, message = 'commit') {
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', message);
}

const PACKAGE = JSON.stringify({ name: 'app', dependencies: { 'drizzle-orm': '^0.45.4' }, devDependencies: { 'drizzle-kit': '^0.31.11' } });
const PG = "import { pgTable, integer, text, varchar, serial, timestamp, boolean, uuid, index, uniqueIndex, unique, primaryKey, foreignKey } from 'drizzle-orm/pg-core';\n";
const MYSQL = "import { mysqlTable, int, varchar, serial, timestamp, mysqlEnum, primaryKey } from 'drizzle-orm/mysql-core';\n";
const SQLITE = "import { sqliteTable, integer, text, primaryKey } from 'drizzle-orm/sqlite-core';\n";
const USERS = "export const users = pgTable('users', {\n  id: serial('id').primaryKey(),\n  email: varchar('email', { length: 255 }).notNull(),\n});\n";

// A project whose src/db/schema.ts is `body` (after the imports of pg-core), with a package.json
const schemaProject = (body, files = {}) => project({ 'package.json': PACKAGE, 'src/db/schema.ts': PG + body, ...files });
// The tables of a schema, without their source line and git status (tested on their own)
function tablesOf(body, options = {}, files = {}) {
    const result = parser.parse(schemaProject(body, files), { git: false, ...options });
    return result.tables.map(({ source, git: status, ...table }) => {
        assert.ok(source && status === undefined);
        return table;
    });
}
const parseSchema = (body, options = {}, files = {}) => parser.parse(schemaProject(body, files), { git: false, ...options });
const tableNamed = (tables, name) => tables.find(t => t.table === name);
const columnsOf = (body, options = {}, files = {}) => tablesOf(body, { details: true, ...options }, files)[0].columns;

// ---------------------------------------------------------------------------------------------

describe('drizzle parser: real and hand-made fixtures', () => {
    const fixtures = fs.readdirSync(FIXTURES).filter(name => name !== 'expected' && fs.statSync(path.join(FIXTURES, name)).isDirectory()).sort();
    const expected = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected', `${name}.json`), 'utf8'));
    const DETAIL_KEYS = ['length', 'precision', 'scale', 'unsigned', 'default', 'defaultRaw', 'onUpdateCurrent', 'values', 'unique', 'autoIncrement', 'nativeType'];

    it('has the six real schemas and the hand-made ones', () => {
        assert.deepEqual(fixtures, ['cap', 'midday', 'multi-file', 'mysql-edge-cases', 'openstatus', 'pg-edge-cases', 'saas-starter', 'sqlite-edge-cases', 't3', 'v1-syntax', 'vercel-chatbot']);
    });

    for (const name of fixtures) {
        it(`${name}: the exact tables, relations, details, lines and warnings (expected/${name}.json)`, () => {
            assert.deepEqual(parser.parse(path.join(FIXTURES, name), { details: true, columnSources: true, git: false }), expected(name));
        });
    }

    it('without details nor column sources: the same tables, without them', () => {
        for (const name of fixtures) {
            const full = expected(name);
            const without = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
            const tables = full.tables.map(table => ({
                ...without(table, ['indexes']),
                columns: table.columns.map(column => without(column, ['source', ...DETAIL_KEYS])),
                relations: table.relations.map(relation => without(relation, ['onDelete', 'onUpdate'])),
            }));
            assert.deepEqual(parser.parse(path.join(FIXTURES, name), { git: false }), { tables, warnings: full.warnings }, name);
        }
    });

    it('every fixture is detected as Drizzle, with its config file or its package (100)', () => {
        for (const name of fixtures) {
            assert.deepEqual(registry.detect(path.join(FIXTURES, name)), { framework: 'drizzle', forced: false, matches: [{ id: 'drizzle', label: 'Drizzle', score: 100 }], errors: [] }, name);
        }
    });

    it('openstatus: the tables of the 42 files that src/schema/index.ts re-exports (export * from folders), the validation files read too', () => {
        const { tables } = parser.parse(path.join(FIXTURES, 'openstatus'), { git: false });
        const files = [...new Set(tables.map(t => t.source.file))];
        assert.equal(tables.length, 59);
        assert.equal(files.length, 42);
        assert.deepEqual(files, [...files].sort(), 'in the order of their paths');
        assert.deepEqual(tableNamed(tables, 'monitor').source, { file: 'src/schema/monitors/monitor.ts', line: 18 });
        const sources = registry.getSources('drizzle', path.join(FIXTURES, 'openstatus'));
        assert.equal(sources.files.filter(file => file.includes(`${path.sep}src${path.sep}schema${path.sep}`)).length, 118, 'every file reached from the index, for the watcher and git');
    });

    it('cap: drizzle.config.ts casing snake_case, customType columns, helpers of the schema file, an imported constant in a dataType', () => {
        const { tables } = parser.parse(path.join(FIXTURES, 'cap'), { git: false, details: true });
        const users = tableNamed(tables, 'users');
        assert.deepEqual(users.columns[0], { name: 'id', type: 'nanoId', primary: true, length: 15, nativeType: 'varchar(15)' });
        assert.deepEqual(users.columns.find(c => c.name === 'created_at'), { name: 'created_at', type: 'timestamp', defaultRaw: '(now())' });
    });

    it('midday: the indexes of drizzle-kit pull (using(), op()), foreign keys of the extra config with their actions, a self foreign key', () => {
        const { tables } = parser.parse(path.join(FIXTURES, 'midday'), { git: false, details: true });
        const categories = tableNamed(tables, 'transaction_categories');
        assert.deepEqual(categories.relations.find(r => r.foreignKey === 'parent_id'), { foreignKey: 'parent_id', references: 'id', on: 'transaction_categories', type: 'many-to-one', onDelete: 'set null', onUpdate: 'no action' });
        assert.deepEqual(tableNamed(tables, 'auth.users').indexes[0], { columns: ['instance_id', 'lower((email)::text)'], type: 'index', name: 'users_instance_id_email_idx' });
    });
});

// ---------------------------------------------------------------------------------------------

describe('drizzle parser: detection', () => {
    const SCHEMA = PG + USERS;

    it('detection: a config file with its schema files scores 100, whatever package.json says', () => {
        assert.equal(parser.detect(project({ 'drizzle.config.ts': "export default { schema: './db/schema.ts', dialect: 'postgresql' }\n", 'db/schema.ts': SCHEMA })), 100);
        assert.equal(parser.detect(project({ 'drizzle.config.json': '{ "schema": "./db/schema.ts" }', 'db/schema.ts': SCHEMA, 'package.json': PACKAGE })), 100);
    });

    it('detection: a schema at a usual location and drizzle-orm or drizzle-kit in package.json score 100', () => {
        assert.equal(parser.detect(project({ 'src/db/schema.ts': SCHEMA, 'package.json': PACKAGE })), 100);
        assert.equal(parser.detect(project({ 'src/schema.ts': SCHEMA, 'package.json': JSON.stringify({ devDependencies: { 'drizzle-kit': '0.31.0' } }) })), 100);
        assert.equal(parser.detect(project({ 'db/schema/users.ts': SCHEMA, 'package.json': PACKAGE })), 100, 'a schema folder');
        assert.equal(parser.detect(project({ 'drizzle/schema.ts': SCHEMA, 'package.json': PACKAGE })), 100, 'the output of drizzle-kit pull');
    });

    it('detection: a config file whose schema is missing, or a schema file that imports drizzle-orm without the package, score 50', () => {
        assert.equal(parser.detect(project({ 'drizzle.config.ts': "export default { schema: './db/schema.ts' }\n" })), 50);
        assert.equal(parser.detect(project({ 'src/db/schema.ts': SCHEMA })), 50);
        assert.equal(parser.detect(project({ 'src/db/schema.ts': "import { sql } from 'kysely';\nexport const x = 1;\n" })), 0, 'another library');
    });

    it('detection: the package alone scores 0, a monorepo root whose schema is in a package is no Drizzle project (the framework folder is suggested)', () => {
        assert.equal(parser.detect(project({ 'package.json': PACKAGE })), 0);
        const root = project({
            'package.json': JSON.stringify({ workspaces: ['packages/*'], devDependencies: { 'drizzle-kit': '^0.31.0' } }),
            'packages/db/package.json': PACKAGE,
            'packages/db/drizzle.config.ts': "export default { schema: './src/schema.ts' }\n",
            'packages/db/src/schema.ts': SCHEMA,
        });
        assert.equal(parser.detect(root), 0);
        assert.deepEqual(registry.detect(root), { framework: 'Unknown', forced: false, matches: [], errors: [] });
        assert.equal(parser.detect(path.join(root, 'packages', 'db')), 100, 'its framework folder');
        assert.equal(parser.detect(project({ 'composer.json': '{}', artisan: '' })), 0);
        assert.equal(parser.detect(path.join(TMP, 'dmdb-drizzle-missing')), 0);
        assert.equal(parser.detect(path.join(project({ 'schema.ts': SCHEMA }), 'schema.ts')), 0, 'a file is not a project');
        assert.equal(parser.detect(''), 0);
        assert.equal(parser.detect(undefined), 0);
    });

    it('detection: an invalid package.json is not an error', () => {
        assert.equal(parser.detect(project({ 'package.json': '{ "name": ', 'src/db/schema.ts': SCHEMA })), 50);
        assert.equal(parser.detect(project({ 'package.json': '\uFEFF' + PACKAGE, 'src/db/schema.ts': SCHEMA })), 100, 'UTF-8 BOM');
        assert.equal(parser.detect(project({ 'package.json': 'null', 'src/db/schema.ts': SCHEMA })), 50);
    });
});

// ---------------------------------------------------------------------------------------------

describe('drizzle parser: where the schema is', () => {
    const SCHEMA = PG + USERS;
    const tablesIn = (dir) => parser.parse(dir, { git: false }).tables.map(t => [t.table, t.source.file]);

    it('drizzle.config.ts: defineConfig(), `satisfies Config`, a variable, a .js module.exports, a .json; read, never run', () => {
        const configs = [
            ['drizzle.config.ts', "import { defineConfig } from 'drizzle-kit';\n\nexport default defineConfig({\n  dialect: 'postgresql',\n  schema: './db/main.ts',\n  dbCredentials: { url: process.env.DATABASE_URL! },\n});\n"],
            ['drizzle.config.ts', "import type { Config } from 'drizzle-kit';\nexport default {\n  schema: \"./db/main.ts\",\n  out: './drizzle',\n} satisfies Config;\n"],
            ['drizzle.config.ts', "const config: Config = { schema: `./db/main.ts`, dialect: 'postgresql' };\nexport default config;\n"],
            ['drizzle.config.js', "/** @type { import('drizzle-kit').Config } */\nmodule.exports = {\n  schema: './db/main.ts',\n};\n"],
            ['drizzle.config.mjs', "import { defineConfig } from 'drizzle-kit'\nexport default defineConfig({ schema: './db/main.ts' })\n"],
            ['drizzle.config.json', '{\n  "dialect": "postgresql",\n  "schema": "./db/main.ts"\n}\n'],
            // Running the file would throw: it is only read
            ['drizzle.config.ts', "throw new Error('not run');\nexport default { schema: './db/main.ts' };\n"],
            ['drizzle.config.ts', "import path from 'node:path';\nexport default defineConfig({ schema: path.join(__dirname, 'db', 'main.ts') });\n"],
            ['drizzle.config.ts', "const base = { dialect: 'postgresql' };\nexport default defineConfig({ ...base, schema: './db/main.ts' });\n"],
        ];
        for (const [name, text] of configs) {
            const dir = project({ [name]: text, 'db/main.ts': SCHEMA, 'src/db/schema.ts': SCHEMA.replace("'users'", "'other'") });
            assert.deepEqual(tablesIn(dir), [['users', 'db/main.ts']], text);
            assert.deepEqual(parser.parse(dir, { git: false }).warnings, [], text);
        }
    });

    it('the schema of the config: a file, a folder (its files, not its sub-folders), a glob, an array; relative to the framework folder, as drizzle-kit runs there', () => {
        const files = {
            'db/a.ts': SCHEMA.replace("'users'", "'a'"),
            'db/b.ts': SCHEMA.replace("'users'", "'b'"),
            'db/notes.md': SCHEMA.replace("'users'", "'md'"),
            'db/types.d.ts': SCHEMA.replace("'users'", "'dts'"),
            'db/nested/c.ts': SCHEMA.replace("'users'", "'c'"),
            'db/nested/deep/d.ts': SCHEMA.replace("'users'", "'d'"),
        };
        const read = (schema) => tablesIn(project({ ...files, 'drizzle.config.ts': `export default { schema: ${JSON.stringify(schema)} };\n` })).map(t => t[0]);
        assert.deepEqual(read('./db/a.ts'), ['a']);
        assert.deepEqual(read('./db'), ['a', 'b'], 'a folder: the script files directly in it');
        assert.deepEqual(read('./db/*.ts'), ['a', 'b']);
        assert.deepEqual(read('db/**/*.ts'), ['a', 'b', 'c', 'd']);
        assert.deepEqual(read('./db/{a,nested/c}.ts'), ['a', 'c'], 'braces expanded first, as glob does');
        assert.deepEqual(read('./db/nested/*'), ['c', 'd'], 'a folder matched by the glob: its files, as drizzle-kit reads it');
        assert.deepEqual(read(['./db/b.ts', './db/nested/c.ts']), ['b', 'c']);
        assert.deepEqual(read(['./db/b.ts', './db/b.ts', './db/*.ts']), ['a', 'b'], 'each file once');
        const missing = parser.parse(project({ ...files, 'drizzle.config.ts': "export default { schema: ['./db/a.ts', './db/missing/*.ts'] };\n" }), { git: false });
        assert.deepEqual(missing.warnings, ['drizzle.config.ts: no schema file matches ./db/missing/*.ts.']);
    });

    it('without a config file, or with one that sets no schema: the first usual location with schema files', () => {
        const order = ['src/db/schema.ts', 'src/db/schema/users.ts', 'src/schema.ts', 'src/schema/users.ts', 'db/schema.ts', 'db/schema/users.ts', 'drizzle/schema.ts', 'schema.ts', 'schema/users.ts'];
        for (let i = 0; i < order.length; i++) {
            const files = Object.fromEntries(order.slice(i).map(file => [file, SCHEMA]));
            assert.deepEqual(tablesIn(project({ ...files, 'package.json': PACKAGE })).map(t => t[1]), [order[i]], order[i]);
        }
        assert.deepEqual(tablesIn(project({ 'drizzle.config.ts': "export default { dialect: 'postgresql', out: './drizzle' };\n", 'db/schema.ts': SCHEMA })), [['users', 'db/schema.ts']]);
    });

    it('a schema path computed in drizzle.config.ts is told, and the usual locations are read', () => {
        const dir = project({ 'drizzle.config.ts': "export default defineConfig({ schema: process.env.SCHEMA ?? './db/main.ts' });\n", 'src/db/schema.ts': SCHEMA });
        const result = parser.parse(dir, { git: false });
        assert.deepEqual(result.warnings, ['drizzle.config.ts: the schema path is computed, it cannot be read without running the file: the usual locations are read.']);
        assert.deepEqual(result.tables.map(t => t.table), ['users']);
        const built = parser.parse(project({ 'drizzle.config.ts': "export default makeConfig({ schema: './db/main.ts' });\n", 'src/db/schema.ts': SCHEMA }), { git: false });
        assert.deepEqual(built.warnings, ['drizzle.config.ts: the schema path is computed, it cannot be read without running the file: the usual locations are read.'], 'a config built by a function');
    });

    it('errors: no schema, a schema set in the config that does not exist', () => {
        const empty = project({ 'package.json': PACKAGE });
        assert.throws(() => parser.parse(empty), error => error instanceof ParserError && error.message === `No Drizzle schema found in ${empty}: DrawMeDatabase reads the schema set in drizzle.config.ts (or .js, .json), else src/db/schema.ts, src/schema.ts, db/schema.ts, drizzle/schema.ts or a schema folder.`);
        const missing = project({ 'drizzle.config.ts': "export default { schema: ['./db/schema.ts', './db/more/*.ts'] };\n" });
        assert.throws(() => parser.parse(missing), error => error instanceof ParserError && error.message === `The Drizzle schema set in drizzle.config.ts was not found: ./db/schema.ts, ./db/more/*.ts (from ${missing})`);
    });

    it('sources(): the schema files and the files they import, the folders of the config, package.json and the config file; every usual location while there is no schema', () => {
        const dir = project({
            'drizzle.config.ts': "export default { schema: './src/db/schema/*.ts' };\n",
            'src/db/schema/users.ts': `${PG}import { timestamps } from '../columns';\nimport type { Role } from '../types';\nimport { z } from 'zod';\n${USERS}`,
            'src/db/schema/index.ts': "export * from './users';\nexport { posts } from '../legacy/posts.js';\n",
            'src/db/columns.ts': 'export const timestamps = {};\n',
            'src/db/types.ts': 'export type Role = string;\n',
            'src/db/legacy/posts.ts': `${PG}export const posts = pgTable('posts', { id: serial().primaryKey() });\n`,
        });
        const sources = registry.getSources('drizzle', dir);
        const at = (...parts) => path.join(dir, ...parts);
        assert.deepEqual(sources, {
            folders: [{ path: at('src', 'db', 'schema'), recursive: false }],
            files: [at('src', 'db', 'schema', 'index.ts'), at('src', 'db', 'schema', 'users.ts'), at('src', 'db', 'legacy', 'posts.ts'), at('src', 'db', 'columns.ts'), at('package.json'), at('drizzle.config.ts')],
            extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
        });
        assert.equal(registry.covers(sources, at('src', 'db', 'schema', 'new.ts')), true, 'a new file of the schema folder');
        assert.equal(registry.covers(sources, at('src', 'db', 'types.ts')), false, 'a type-only import');
        assert.deepEqual(registry.watchPatterns(sources).slice(0, 2), [
            { base: at('src', 'db', 'schema'), pattern: '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}' },
            { base: at('src', 'db', 'schema'), pattern: 'index.ts' },
        ]);
        assert.deepEqual(registry.getSources('drizzle', project({ 'drizzle.config.ts': "export default { schema: 'db/**/*.ts' };\n", 'db/a/b.ts': SCHEMA })).folders.map(f => f.recursive), [true], 'a ** glob: the sub-folders too');
        const none = project({ 'package.json': PACKAGE });
        assert.deepEqual(registry.getSources('drizzle', none), {
            folders: ['src/db/schema', 'src/schema', 'db/schema', 'schema'].map(folder => ({ path: path.join(none, folder), recursive: false })),
            files: [...['src/db/schema.ts', 'src/db/schema.js', 'src/schema.ts', 'src/schema.js', 'db/schema.ts', 'db/schema.js', 'drizzle/schema.ts', 'drizzle/schema.js', 'schema.ts'].map(file => path.join(none, file)), path.join(none, 'package.json'), path.join(none, 'drizzle.config.ts')],
            extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
        });
    });

    it('sources() and parse() follow an unsaved drizzle.config.ts that moves the schema, and an unsaved schema file that imports another file (options.overrides)', () => {
        const dir = project({ 'drizzle.config.ts': "export default { schema: './db/a.ts' };\n", 'db/a.ts': SCHEMA, 'db/b.ts': SCHEMA.replace("'users'", "'b'"), 'db/helpers.ts': 'export const x = {};\n' });
        const config = new Map([[path.join(dir, 'drizzle.config.ts'), "export default { schema: './db/b.ts' };\n"]]);
        assert.deepEqual(registry.getSources('drizzle', dir, { overrides: config }).files.slice(0, 1), [path.join(dir, 'db', 'b.ts')]);
        assert.deepEqual(parser.parse(dir, { overrides: config, git: false }).tables.map(t => t.table), ['b']);
        const importing = new Map([[path.join(dir, 'db', 'a.ts'), `import { x } from './helpers';\n${SCHEMA}`]]);
        assert.deepEqual(registry.getSources('drizzle', dir, { overrides: importing }).files.slice(0, 2), [path.join(dir, 'db', 'a.ts'), path.join(dir, 'db', 'helpers.ts')]);
        assert.deepEqual(parser.sources(dir, { overrides: new Map() }), parser.sources(dir));
        assert.deepEqual(parser.sources(dir, null), parser.sources(dir));
    });

    it('imports: relative paths with or without an extension, .js for a .ts file, a folder index, the path aliases of tsconfig.json', () => {
        const columns = "import { integer } from 'drizzle-orm/pg-core';\nexport const id = { id: integer().primaryKey() };\n";
        const variants = [
            ["import { id } from './columns';", { 'src/db/columns.ts': columns }],
            ["import { id } from './columns.js';", { 'src/db/columns.ts': columns }],
            ["import { id } from './columns/index.js';", { 'src/db/columns/index.ts': columns }],
            ["import { id } from './columns';", { 'src/db/columns/index.ts': columns }],
            ["import { id } from '@/db/columns';", { 'src/db/columns.ts': columns, 'tsconfig.json': '{\n  // aliases\n  "compilerOptions": { "paths": { "@/*": ["./src/*"], }, },\n}\n' }],
            ["import { id } from '~db/columns';", { 'src/db/columns.ts': columns, 'tsconfig.json': '{ "compilerOptions": { "baseUrl": "src", "paths": { "~db/*": ["db/*"] } } }' }],
        ];
        for (const [line, files] of variants) {
            const result = parseSchema(`${line}\nexport const t = pgTable('t', { ...id, name: text() });\n`, {}, files);
            assert.deepEqual(result.tables[0].columns.map(c => c.name), ['id', 'name'], line);
            assert.deepEqual(result.warnings, [], line);
        }
    });
});

// ---------------------------------------------------------------------------------------------

describe('drizzle parser: tables and columns', () => {
    it('table functions: pgTable, mysqlTable, sqliteTable, singlestoreTable, a pgSchema, the prefix of a table creator, in the order of the files and of the code', () => {
        const dir = project({
            'package.json': PACKAGE,
            'drizzle.config.ts': "export default { schema: ['./db/pg.ts', './db/mysql.ts', './db/sqlite.ts', './db/singlestore.ts'] };\n",
            'db/pg.ts': `${PG}import { pgSchema, pgTableCreator } from 'drizzle-orm/pg-core';\nexport const b = pgTable('b', { id: integer() });\nexport const a = pgTable('a', { id: integer() });\nconst auth = pgSchema('auth');\nexport const sessions = auth.table('sessions', { id: integer() });\nconst createTable = pgTableCreator((name) => \`app_\${name}\`);\nexport const settings = createTable('settings', { id: integer() });\nexport const pub = pgSchema('public').table('pub', { id: integer() });\n`,
            'db/mysql.ts': `${MYSQL}import { mysqlTableCreator } from 'drizzle-orm/mysql-core';\nexport const m = mysqlTable('m', { id: int() });\nconst legacy = mysqlTableCreator((name) => 'legacy_' + name);\nexport const old = legacy('old', { id: int() });\n`,
            'db/sqlite.ts': `${SQLITE}export const s = sqliteTable('s', { id: integer() });\n`,
            'db/singlestore.ts': "import { singlestoreTable, int } from 'drizzle-orm/singlestore-core';\nexport const ss = singlestoreTable('ss', { id: int().autoincrement().primaryKey() });\n",
        });
        const { tables, warnings } = parser.parse(dir, { git: false, details: true });
        assert.deepEqual(tables.map(t => t.table), ['m', 'legacy_old', 'b', 'a', 'auth.sessions', 'app_settings', 'pub', 'ss', 's']);
        assert.deepEqual(tableNamed(tables, 'ss').columns, [{ name: 'id', type: 'int', primary: true, autoIncrement: true }]);
        assert.deepEqual(warnings, []);
    });

    it('column names: the first argument, else the key, with the casing of drizzle.config.ts (snake_case, camelCase), as drizzle-orm converts it', () => {
        const body = "export const t = pgTable('t', {\n  firstName: text(),\n  last_name: text(),\n  userID: integer(),\n  HTMLParser: text(),\n  x1y2: text(),\n  named: text('Explicit_Name'),\n  opts: varchar({ length: 10 }),\n});\n";
        const names = (casing) => tablesOf(body, {}, casing ? { 'drizzle.config.ts': `export default { schema: './src/db/schema.ts', casing: '${casing}' };\n` } : {})[0].columns.map(c => c.name);
        assert.deepEqual(names(null), ['firstName', 'last_name', 'userID', 'HTMLParser', 'x1y2', 'Explicit_Name', 'opts']);
        assert.deepEqual(names('snake_case'), ['first_name', 'last_name', 'user_id', 'html_parser', 'x1y2', 'Explicit_Name', 'opts']);
        assert.deepEqual(names('camelCase'), ['firstName', 'lastName', 'userID', 'htmlParser', 'x1y2', 'Explicit_Name', 'opts']);
        const computed = parseSchema(body, {}, { 'drizzle.config.ts': "export default { schema: './src/db/schema.ts', casing: process.env.CASING };\n" });
        assert.deepEqual(computed.tables[0].columns[0].name, 'firstName');
        assert.deepEqual(computed.warnings, ['drizzle.config.ts: the casing is computed, it cannot be read without running the file: the columns are named after the keys of the objects.']);
    });

    it('drizzle-orm 1.0: snakeCase.table(), camelCase.schema().table(), pgTableCreator(fn, casing); drizzle-kit 1.0 ignores the casing of the config file, with a warning', () => {
        const files = { 'package.json': JSON.stringify({ dependencies: { 'drizzle-orm': '1.0.0-rc.4' }, devDependencies: { 'drizzle-kit': '1.0.0-rc.4' } }) };
        const body = "import { snakeCase, camelCase, pgTableCreator } from 'drizzle-orm/pg-core';\nexport const a = snakeCase.table('a', { firstName: text() });\nexport const b = camelCase.schema('crm').table('b', { last_name: text() });\nconst create = pgTableCreator((n) => `x_${n}`, 'snake_case');\nexport const c = create('c', { userId: integer() });\nexport const d = pgTable('d', { userId: integer() });\n";
        const plain = parser.parse(project({ ...files, 'src/db/schema.ts': PG + body }), { git: false });
        assert.deepEqual(plain.tables.map(t => [t.table, t.columns[0].name]), [['a', 'first_name'], ['crm.b', 'lastName'], ['x_c', 'user_id'], ['d', 'userId']]);
        assert.deepEqual(plain.warnings, []);
        const configured = parser.parse(project({ ...files, 'src/db/schema.ts': PG + body, 'drizzle.config.ts': "export default { schema: './src/db/schema.ts', casing: 'snake_case' };\n" }), { git: false });
        assert.deepEqual(configured.tables.map(t => t.columns[0].name), ['first_name', 'lastName', 'user_id', 'userId'], 'the casing of the config is ignored');
        assert.deepEqual(configured.warnings, ['drizzle.config.ts: drizzle-kit 1 ignores the casing of the config file: the columns are named after the keys of the objects, as it does (snakeCase.table() sets a casing).']);
    });

    it('columns written in a callback: (d) => ({ id: d.integer() }), destructured builders, a block that returns them, the namespace of pg-core', () => {
        const tables = tablesOf("import * as p from 'drizzle-orm/pg-core';\nexport const a = pgTable('a', (d) => ({ id: d.integer().primaryKey(), name: d.varchar({ length: 20 }) }));\nexport const b = pgTable('b', ({ integer: int, text }) => ({ id: int().notNull(), bio: text() }));\nexport const c = pgTable('c', (t) => {\n  return { id: t.uuid().defaultRandom() };\n});\nexport const d = p.pgTable('d', { id: p.bigint({ mode: 'number' }).primaryKey() });\n");
        assert.deepEqual(tables.map(t => [t.table, t.columns]), [
            ['a', [{ name: 'id', type: 'integer', primary: true }, { name: 'name', type: 'varchar', nullable: true }]],
            ['b', [{ name: 'id', type: 'integer' }, { name: 'bio', type: 'text', nullable: true }]],
            ['c', [{ name: 'id', type: 'uuid', nullable: true }]],
            ['d', [{ name: 'id', type: 'bigint', primary: true }]],
        ]);
    });

    it('types: the name of the builder, of a pgEnum (with its schema), enum for mysqlEnum, [] per array dimension, the name of a customType; enum values in the details', () => {
        const columns = columnsOf("import { pgEnum, pgSchema, customType, jsonb } from 'drizzle-orm/pg-core';\nexport const role = pgEnum('user_role', ['user', 'admin']);\nconst billing = pgSchema('billing');\nexport const plan = billing.enum('plan', ['free', 'pro']);\nconst citext = customType<{ data: string }>({ dataType() { return 'citext'; } });\nexport const t = pgTable('t', {\n  role: role().notNull(),\n  roles: role('roles').array(),\n  plan: plan(),\n  email: citext('email'),\n  grid: integer().array().array(),\n  cube: integer().array('[][][]'),\n  data: jsonb().$type<{ a: string }>(),\n});\n");
        assert.deepEqual(columns, [
            { name: 'role', type: 'user_role', values: ['user', 'admin'] },
            { name: 'roles', type: 'user_role[]', nullable: true, values: ['user', 'admin'] },
            { name: 'plan', type: 'billing.plan', nullable: true, values: ['free', 'pro'] },
            { name: 'email', type: 'citext', nullable: true, nativeType: 'citext' },
            { name: 'grid', type: 'integer[][]', nullable: true },
            { name: 'cube', type: 'integer[][][]', nullable: true },
            { name: 'data', type: 'jsonb', nullable: true },
        ]);
        const mysql = parser.parse(project({ 'package.json': PACKAGE, 'src/db/schema.ts': `${MYSQL}const STATUSES = ['a', 'b'] as const;\nexport enum Kind { One = 'one', Two = 'two' }\nexport const t = mysqlTable('t', {\n  status: mysqlEnum('status', STATUSES).notNull(),\n  kind: mysqlEnum(Kind),\n  bare: mysqlEnum(['x', 'y']),\n});\n` }), { git: false, details: true });
        assert.deepEqual(mysql.tables[0].columns, [
            { name: 'status', type: 'enum', values: ['a', 'b'] },
            { name: 'kind', type: 'enum', nullable: true, values: ['one', 'two'] },
            { name: 'bare', type: 'enum', nullable: true, values: ['x', 'y'] },
        ]);
    });

    it('enum values: an array, an `as const` array declared elsewhere, a TypeScript enum, Object.values()', () => {
        const columns = columnsOf("import { pgEnum } from 'drizzle-orm/pg-core';\nimport { STATUSES } from './constants';\nexport enum Color { Red = 'red', Blue = 'blue' }\nexport const a = pgEnum('a', STATUSES);\nexport const b = pgEnum('b', Color);\nexport const c = pgEnum('c', Object.values(Color) as [string, ...string[]]);\nexport const t = pgTable('t', { a: a(), b: b(), c: c() });\n", {}, { 'src/db/constants.ts': "export const STATUSES = ['open', 'closed'] as const;\n" });
        assert.deepEqual(columns.map(c => c.values), [['open', 'closed'], ['red', 'blue'], ['red', 'blue']]);
    });

    it('nullable and primary: notNull(), primaryKey(), serial and identity columns are never null; the columns of a composite primary key neither, except on SQLite', () => {
        assert.deepEqual(tablesOf("export const t = pgTable('t', {\n  a: integer(),\n  b: integer().notNull(),\n  c: serial(),\n  d: integer().generatedAlwaysAsIdentity(),\n  e: integer().generatedByDefaultAsIdentity({ startWith: 10 }),\n  f: text().primaryKey(),\n});\n")[0].columns, [
            { name: 'a', type: 'integer', nullable: true },
            { name: 'b', type: 'integer' },
            { name: 'c', type: 'serial' },
            { name: 'd', type: 'integer' },
            { name: 'e', type: 'integer' },
            { name: 'f', type: 'text', primary: true },
        ]);
        assert.deepEqual(tablesOf("export const t = pgTable('t', { a: integer(), b: integer() }, (t) => [primaryKey({ columns: [t.a, t.b] })]);\n")[0].columns, [
            { name: 'a', type: 'integer', primary: true },
            { name: 'b', type: 'integer', primary: true },
        ]);
        const sqlite = parser.parse(project({ 'package.json': PACKAGE, 'src/db/schema.ts': `${SQLITE}export const t = sqliteTable('t', { a: integer(), b: text().notNull() }, (t) => [primaryKey({ columns: [t.a, t.b] })]);\n` }), { git: false });
        assert.deepEqual(sqlite.tables[0].columns, [{ name: 'a', type: 'integer', primary: true, nullable: true }, { name: 'b', type: 'text', primary: true }]);
    });

    it('spreads of columns: an object of the file, of an imported file, a function that returns them, a namespace import; a spread that cannot be read is told', () => {
        const files = {
            'src/db/helpers.ts': "import { timestamp } from 'drizzle-orm/pg-core';\nexport const timestamps = {\n  createdAt: timestamp('created_at').defaultNow().notNull(),\n  updatedAt: timestamp('updated_at'),\n};\nexport const audit = (prefix: string) => ({\n  [`${prefix}_by`]: text(),\n  deletedAt: timestamp(),\n});\n",
        };
        const result = parseSchema("import { timestamps, audit } from './helpers';\nimport * as helpers from './helpers';\nimport { external } from 'some-package';\nconst ids = { id: serial().primaryKey() };\nexport const t = pgTable('t', {\n  ...ids,\n  ...timestamps,\n  ...audit('x'),\n  ...helpers.timestamps,\n  ...external,\n  name: text(),\n});\n", { columnSources: true }, files);
        assert.deepEqual(result.tables[0].columns.map(c => [c.name, c.source.file, c.source.line]), [
            ['id', 'src/db/schema.ts', 5],
            ['created_at', 'src/db/helpers.ts', 3],
            ['updated_at', 'src/db/helpers.ts', 4],
            ['deletedAt', 'src/db/helpers.ts', 8],
            ['created_at', 'src/db/helpers.ts', 3],
            ['updated_at', 'src/db/helpers.ts', 4],
            ['name', 'src/db/schema.ts', 12],
        ]);
        assert.deepEqual(result.warnings, [
            'src/db/helpers.ts:7: t: a computed column key cannot be read, column skipped.',
            'src/db/schema.ts:11: t: ...external cannot be read, its columns are skipped.',
        ]);
    });

    it('helpers of columns: a function that returns a builder (its arguments and their defaults), a shared builder, an object of builders', () => {
        const columns = columnsOf("const id = () => integer().primaryKey().generatedByDefaultAsIdentity();\nconst code = (name: string, length = 8) => varchar(name, { length }).notNull();\nfunction fk(name?: string) {\n  return integer(name ?? 'parent_id');\n}\nconst createdAt = timestamp('created_at').defaultNow();\nconst cols = { email: () => varchar({ length: 320 }) };\nexport const t = pgTable('t', {\n  id: id(),\n  code: code('code_value'),\n  short: code('short', 2).unique(),\n  parent: fk(),\n  other: fk('other_id'),\n  createdAt,\n  email: cols.email().notNull(),\n});\n");
        assert.deepEqual(columns, [
            { name: 'id', type: 'integer', primary: true, autoIncrement: true },
            { name: 'code_value', type: 'varchar', length: 8 },
            { name: 'short', type: 'varchar', length: 2, unique: true },
            { name: 'parent_id', type: 'integer', nullable: true },
            { name: 'other_id', type: 'integer', nullable: true },
            { name: 'created_at', type: 'timestamp', nullable: true, defaultRaw: 'now()' },
            { name: 'email', type: 'varchar', length: 320 },
        ]);
    });

    it('the tables drizzle-kit creates: the exported ones (export const, export { a as b }, export * from, an exported alias), each once; export * as ns is not read', () => {
        const files = {
            'drizzle.config.ts': "export default { schema: ['./db/index.ts', './db/users.ts'] };\n",
            'db/index.ts': "export * from './users';\nexport { posts as articles } from './posts';\nexport * as legacy from './legacy';\nimport { tags } from './tags';\nexport { tags };\n",
            'db/users.ts': `${PG}${USERS}const archive = pgTable('archive', { id: integer() });\nexport const archivedUsers = archive;\nexport default pgTable('defaults', { id: integer() });\n`,
            'db/posts.ts': `${PG}export const posts = pgTable('posts', { id: integer() });\n`,
            'db/tags.ts': `${PG}export const tags = pgTable('tags', { id: integer() });\n`,
            'db/legacy.ts': `${PG}export const old = pgTable('old', { id: integer() });\n`,
        };
        const result = parser.parse(project(files), { git: false });
        assert.deepEqual(result.tables.map(t => [t.table, t.source.file]), [['posts', 'db/posts.ts'], ['tags', 'db/tags.ts'], ['users', 'db/users.ts'], ['archive', 'db/users.ts'], ['defaults', 'db/users.ts']]);
        assert.deepEqual(result.warnings, []);
    });

    it('a table that is not exported is skipped with a warning; a view is not drawn; relations() and defineRelations() are not tables', () => {
        const result = parseSchema("import { relations, defineRelations } from 'drizzle-orm';\nimport { pgView, pgMaterializedView, pgSchema } from 'drizzle-orm/pg-core';\nconst hidden = pgTable('hidden', { id: integer() });\nexport const users = pgTable('users', { id: integer() });\nexport const usersRelations = relations(users, ({ many }) => ({}));\nexport const all = defineRelations({ users }, (r) => ({}));\nexport const v = pgView('v').as((qb) => qb.select().from(users));\nexport const mv = pgMaterializedView('mv', { id: integer() }).existing();\nexport const sv = pgSchema('s').view('sv').as((qb) => qb.select().from(users));\n");
        assert.deepEqual(result.tables.map(t => t.table), ['users']);
        assert.deepEqual(result.warnings, [
            'src/db/schema.ts:8: view v skipped: views are not drawn.',
            'src/db/schema.ts:9: view mv skipped: views are not drawn.',
            'src/db/schema.ts:10: view sv skipped: views are not drawn.',
            'src/db/schema.ts:4: table hidden is not exported: drizzle-kit does not create it, skipped.',
        ]);
    });

    it('MySQL: the tables of mysqlSchema() are another database, which drizzle-kit does not create: skipped with a warning', () => {
        const result = parser.parse(project({ 'package.json': PACKAGE, 'src/db/schema.ts': `${MYSQL}import { mysqlSchema } from 'drizzle-orm/mysql-core';\nconst analytics = mysqlSchema('analytics');\nexport const views = analytics.table('views', { id: int() });\nexport const posts = mysqlTable('posts', { id: int() });\n` }), { git: false });
        assert.deepEqual(result.tables.map(t => t.table), ['posts']);
        assert.deepEqual(result.warnings, ['src/db/schema.ts:4: table analytics.views skipped: drizzle-kit does not create the tables of another database (mysqlSchema()).']);
    });

    it('drizzle-orm before 0.29: the extra config returns an object, primaryKey(t.a, t.b); a wrapper of pgTable of the project is followed', () => {
        const tables = tablesOf("const table = (name: string, columns: any) => pgTable(name, { id: serial().primaryKey(), ...columns });\nexport const tags = table('tags', { label: text() });\nexport const links = pgTable('links', { a: integer('a').notNull(), b: integer('b').notNull() }, (t) => ({\n  pk: primaryKey(t.a, t.b),\n  byB: index('links_b_idx').on(t.b),\n}));\n", { details: true });
        assert.deepEqual(tables, [
            { table: 'tags', columns: [{ name: 'id', type: 'serial', primary: true, autoIncrement: true }, { name: 'label', type: 'text', nullable: true }], relations: [] },
            { table: 'links', columns: [{ name: 'a', type: 'integer', primary: true }, { name: 'b', type: 'integer', primary: true }], relations: [], indexes: [{ columns: ['b'], type: 'index', name: 'links_b_idx' }] },
        ]);
    });
});

// ---------------------------------------------------------------------------------------------

describe('drizzle parser: relations', () => {
    it('references(): the referenced table and column, by their names in the database, in the order of the columns', () => {
        const tables = tablesOf(`${USERS}export const posts = pgTable('blog_posts', {\n  id: serial().primaryKey(),\n  authorId: integer('author_id').notNull().references(() => users.id),\n  editorId: integer('editor_id').references(() => users.id, { onDelete: 'set null', onUpdate: 'cascade' }),\n});\n`, { details: true });
        assert.deepEqual(tables[1].relations, [
            { foreignKey: 'author_id', references: 'id', on: 'users', type: 'many-to-one', onDelete: 'no action', onUpdate: 'no action' },
            { foreignKey: 'editor_id', references: 'id', on: 'users', type: 'many-to-one', onDelete: 'set null', onUpdate: 'cascade' },
        ]);
        assert.deepEqual(tablesOf(`${USERS}export const posts = pgTable('posts', { authorId: integer().references(() => users.id) });\n`)[1].relations, [{ foreignKey: 'authorId', references: 'id', on: 'users', type: 'many-to-one' }], 'without details: no actions');
    });

    it('self and circular references: (): AnyPgColumn => categories.id, two tables of two files that reference each other, a table declared after', () => {
        const files = {
            'drizzle.config.ts': "export default { schema: './db/*.ts', casing: 'snake_case' };\n",
            'db/teams.ts': `${PG}import { users } from './users';\nexport const teams = pgTable('teams', {\n  id: serial().primaryKey(),\n  ownerId: integer().notNull().references(() => users.id),\n});\n`,
            'db/users.ts': `${PG}import { type AnyPgColumn } from 'drizzle-orm/pg-core';\nimport { teams } from './teams';\nexport const users = pgTable('users', {\n  id: serial().primaryKey(),\n  teamId: integer().references((): AnyPgColumn => teams.id),\n  managerId: integer().references((): AnyPgColumn => users.id, { onDelete: 'set null' }),\n  mentorId: integer().references(() => mentors.mentorKey),\n});\nexport const mentors = pgTable('mentors', { mentorKey: integer().primaryKey() });\n`,
        };
        const { tables } = parser.parse(project(files), { git: false });
        assert.deepEqual(tables.map(t => [t.table, t.relations.map(r => `${r.foreignKey} → ${r.on}.${r.references}`)]), [
            ['teams', ['owner_id → users.id']],
            ['users', ['team_id → teams.id', 'manager_id → users.id', 'mentor_id → mentors.mentor_key']],
            ['mentors', []],
        ]);
    });

    it('foreignKey() of the extra config: composite, with its actions, to the table itself through the callback parameter', () => {
        const tables = tablesOf("export const documents = pgTable('documents', {\n  id: uuid().notNull(),\n  version: integer().notNull(),\n  parentId: uuid(),\n}, (t) => [\n  primaryKey({ columns: [t.id, t.version] }),\n  foreignKey({ columns: [t.parentId], foreignColumns: [t.id], name: 'parent_fk' }).onDelete('cascade'),\n]);\nexport const comments = pgTable('comments', {\n  docId: uuid('doc_id').notNull(),\n  docVersion: integer('doc_version').notNull(),\n}, (table) => [\n  foreignKey({ columns: [table.docId, table.docVersion], foreignColumns: [documents.id, documents.version] }).onDelete('CASCADE').onUpdate('restrict'),\n]);\n", { details: true });
        assert.deepEqual(tables.map(t => t.relations), [
            [{ foreignKey: 'parentId', references: 'id', on: 'documents', type: 'many-to-one', onDelete: 'cascade', onUpdate: 'no action' }],
            [
                { foreignKey: 'doc_id', references: 'id', on: 'documents', type: 'many-to-one', onDelete: 'cascade', onUpdate: 'restrict' },
                { foreignKey: 'doc_version', references: 'version', on: 'documents', type: 'many-to-one', onDelete: 'cascade', onUpdate: 'restrict' },
            ],
        ]);
    });

    it('one-to-one: a unique foreign key (unique(), a unique index of the column, the primary key, a composite unique of the same columns)', () => {
        const tables = tablesOf(`${USERS}export const profiles = pgTable('profiles', {\n  userId: integer().notNull().unique().references(() => users.id),\n});\nexport const avatars = pgTable('avatars', {\n  userId: integer().primaryKey().references(() => users.id),\n});\nexport const settings = pgTable('settings', {\n  userId: integer().references(() => users.id),\n  otherId: integer().references(() => users.id),\n}, (t) => [uniqueIndex().on(t.userId)]);\nexport const pairs = pgTable('pairs', { a: integer(), b: integer() }, (t) => [\n  unique().on(t.a, t.b),\n  foreignKey({ columns: [t.a, t.b], foreignColumns: [users.id, users.email] }),\n]);\n`);
        assert.deepEqual(tables.slice(1).map(t => t.relations.map(r => `${r.foreignKey}:${r.type}`)), [
            ['userId:one-to-one'],
            ['userId:one-to-one'],
            ['userId:one-to-one', 'otherId:many-to-one'],
            ['a:one-to-one', 'b:one-to-one'],
        ]);
    });

    it('a reference to a table that is not created (not exported, or of another file) still names it; a reference that cannot be read is told', () => {
        const result = parseSchema(`import { orgs } from './orgs';\nimport { remote } from 'other-package';\nconst hidden = pgTable('hidden_table', { id: integer() });\nexport const t = pgTable('t', {\n  hiddenId: integer().references(() => hidden.id),\n  orgId: integer().references(() => orgs.id),\n  remoteId: integer().references(() => remote.id),\n  badId: integer().references(getColumn),\n}, (t) => [foreignKey({ columns: [t.badId], foreignColumns: [] })]);\n`, {}, { 'src/db/orgs.ts': `${PG}export const orgs = pgTable('organizations', { id: integer() });\n` });
        assert.deepEqual(result.tables.map(t => t.table), ['t']);
        assert.deepEqual(result.tables[0].relations, [
            { foreignKey: 'hiddenId', references: 'id', on: 'hidden_table', type: 'many-to-one' },
            { foreignKey: 'orgId', references: 'id', on: 'organizations', type: 'many-to-one' },
        ]);
        assert.deepEqual(result.warnings, [
            'src/db/schema.ts:10: t: the columns of the foreign key cannot be read, relation skipped.',
            'src/db/schema.ts:4: table hidden is not exported: drizzle-kit does not create it, skipped.',
            'src/db/schema.ts:8: t.remoteId: the referenced column cannot be read, relation skipped.',
            'src/db/schema.ts:9: t.badId: the referenced column cannot be read, relation skipped.',
        ]);
    });
});

// ---------------------------------------------------------------------------------------------

describe('drizzle parser: details', () => {
    it('defaults: constants, sql`...` as written, defaultNow() and defaultRandom() as drizzle-kit writes them, JSON for json columns; values computed at run time are not defaults', () => {
        assert.deepEqual(columnsOf("import { sql } from 'drizzle-orm';\nimport { jsonb, json, bigint, numeric } from 'drizzle-orm/pg-core';\nconst DEFAULT_ROLE = 'member';\nexport const t = pgTable('t', {\n  a: text().default('it\\'s'),\n  b: integer().default(-3),\n  c: boolean().default(false),\n  d: text().default(null),\n  e: text().default(DEFAULT_ROLE),\n  f: timestamp().default(sql`CURRENT_TIMESTAMP`),\n  g: timestamp().defaultNow(),\n  h: uuid().defaultRandom(),\n  i: jsonb().default({ tags: [] }),\n  j: json().default('x'),\n  k: text().array().default(['a']),\n  l: bigint({ mode: 'bigint' }).default(9007199254740993n),\n  m: timestamp().$defaultFn(() => new Date()),\n  n: text().$default(() => 'x'),\n  o: timestamp().default(new Date()),\n  p: numeric().default(sql`${0}`),\n  q: text().default(`a${DEFAULT_ROLE}`),\n});\n").map(({ name, default: value, defaultRaw }) => [name, value, defaultRaw]), [
            ['a', 'it\'s', undefined],
            ['b', -3, undefined],
            ['c', false, undefined],
            ['d', null, undefined],
            ['e', 'member', undefined],
            ['f', undefined, 'CURRENT_TIMESTAMP'],
            ['g', undefined, 'now()'],
            ['h', undefined, 'gen_random_uuid()'],
            ['i', '{"tags":[]}', undefined],
            ['j', '"x"', undefined],
            ['k', undefined, undefined],
            ['l', undefined, '9007199254740993'],
            ['m', undefined, undefined],
            ['n', undefined, undefined],
            ['o', undefined, undefined],
            ['p', undefined, '0'],
            ['q', 'amember', undefined],
        ]);
        const mysql = parser.parse(project({ 'package.json': PACKAGE, 'src/db/schema.ts': `${MYSQL}export const t = mysqlTable('t', { at: timestamp().defaultNow().onUpdateNow() });\n` }), { git: false, details: true });
        assert.deepEqual(mysql.tables[0].columns, [{ name: 'at', type: 'timestamp', nullable: true, defaultRaw: '(now())', onUpdateCurrent: true }]);
        const sqlite = parser.parse(project({ 'package.json': PACKAGE, 'src/db/schema.ts': `${SQLITE}export const t = sqliteTable('t', { at: integer({ mode: 'timestamp' }).defaultNow(), data: text({ mode: 'json' }).default([1]) });\n` }), { git: false, details: true });
        assert.deepEqual(sqlite.tables[0].columns.map(c => c.defaultRaw || c.default), ['(cast((julianday(\'now\') - 2440587.5)*86400000 as integer))', '[1]']);
    });

    it('length, precision and scale, unsigned, auto-increment (serial, identity, autoincrement(), primaryKey({ autoIncrement }))', () => {
        assert.deepEqual(columnsOf("import { numeric, char } from 'drizzle-orm/pg-core';\nexport const t = pgTable('t', {\n  a: varchar('a', { length: 191 }),\n  b: char({ length: 2 }),\n  c: numeric({ precision: 10, scale: 2 }),\n  d: numeric({ precision: 6 }),\n  e: timestamp({ precision: 3 }),\n  f: serial(),\n});\n"), [
            { name: 'a', type: 'varchar', nullable: true, length: 191 },
            { name: 'b', type: 'char', nullable: true, length: 2 },
            { name: 'c', type: 'numeric', nullable: true, precision: 10, scale: 2 },
            { name: 'd', type: 'numeric', nullable: true, precision: 6 },
            { name: 'e', type: 'timestamp', nullable: true },
            { name: 'f', type: 'serial', autoIncrement: true },
        ]);
        const mysql = parser.parse(project({ 'package.json': PACKAGE, 'src/db/schema.ts': "import { mysqlTable, int, bigint, decimal } from 'drizzle-orm/mysql-core';\nexport const t = mysqlTable('t', {\n  id: int().autoincrement().primaryKey(),\n  big: bigint({ mode: 'number', unsigned: true }),\n  price: decimal({ precision: 8, scale: 2, unsigned: true }),\n});\n" }), { git: false, details: true });
        assert.deepEqual(mysql.tables[0].columns, [
            { name: 'id', type: 'int', primary: true, autoIncrement: true },
            { name: 'big', type: 'bigint', nullable: true, unsigned: true },
            { name: 'price', type: 'decimal', nullable: true, precision: 8, scale: 2, unsigned: true },
        ]);
        const sqlite = parser.parse(project({ 'package.json': PACKAGE, 'src/db/schema.ts': `${SQLITE}export const t = sqliteTable('t', { id: integer().primaryKey({ autoIncrement: true }), name: text({ length: 30 }) });\n` }), { git: false, details: true });
        assert.deepEqual(sqlite.tables[0].columns, [{ name: 'id', type: 'integer', primary: true, autoIncrement: true }, { name: 'name', type: 'text', nullable: true, length: 30 }]);
    });

    it('unique columns and indexes: unique(), one-column unique indexes and constraints give unique; the others are indexes, named when the code names them, SQL expressions as written', () => {
        const [table] = tablesOf("import { sql } from 'drizzle-orm';\nexport const t = pgTable('t', {\n  email: text().unique(),\n  slug: text(),\n  code: text(),\n  a: integer(),\n  b: integer(),\n  c: integer(),\n}, (t) => [\n  uniqueIndex('t_slug_idx').on(t.slug),\n  unique().on(t.code),\n  unique('t_a_b_key').on(t.a, t.b),\n  index().on(t.a.desc(), t.b.asc().nullsLast()),\n  index('t_c_idx').using('gin', t.c.op('int4_ops')),\n  uniqueIndex('t_lower_idx').on(sql`lower(${t.email})`),\n  index('t_partial').on(t.c).where(sql`${t.c} > 0`),\n]);\n", { details: true });
        assert.deepEqual(table.columns.filter(c => c.unique).map(c => c.name), ['email', 'slug', 'code']);
        assert.deepEqual(table.indexes, [
            { columns: ['a', 'b'], type: 'unique', name: 't_a_b_key' },
            { columns: ['a', 'b'], type: 'index' },
            { columns: ['c'], type: 'index', name: 't_c_idx' },
            { columns: ['lower(email)'], type: 'unique', name: 't_lower_idx' },
            { columns: ['c'], type: 'index', name: 't_partial' },
        ]);
    });

    it('custom types: the native type of a constant dataType() (an imported constant in it), its length for a varchar; a computed one is not given', () => {
        const columns = columnsOf("import { customType } from 'drizzle-orm/pg-core';\nimport { ID_LENGTH } from './constants';\nconst shortId = customType<{ data: string }>({ dataType() { return `varchar(${ID_LENGTH})`; } });\nconst money = customType<{ data: number; config: { scale: number } }>({ dataType: (config) => `numeric(12, ${config?.scale})` });\nconst point = customType<{ data: [number, number] }>({ dataType: () => 'point' });\nexport const t = pgTable('t', { id: shortId('id').primaryKey(), price: money({ scale: 2 }), at: point() });\n", {}, { 'src/db/constants.ts': 'export const ID_LENGTH = 21;\n' });
        assert.deepEqual(columns, [
            { name: 'id', type: 'shortId', primary: true, length: 21, nativeType: 'varchar(21)' },
            { name: 'price', type: 'money', nullable: true },
            { name: 'at', type: 'point', nullable: true, nativeType: 'point' },
        ]);
    });
});

// ---------------------------------------------------------------------------------------------

describe('drizzle parser: source lines, git status and unsaved editors', () => {
    const BODY = `${PG}export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  name: text('name'),
});

export const posts = pgTable(
  'posts',
  {
    id: serial('id').primaryKey(),
    title: text('title').notNull(),
    authorId: integer('author_id')
      .notNull()
      .references(() => users.id),
  },
  (t) => [index('posts_author_idx').on(t.authorId)],
);
`;
    const statuses = (result) => result.tables.map(t => [t.table, t.git, ...t.columns.map(c => `${c.name}=${c.git}`)]);
    const files = (body = BODY) => ({ 'package.json': PACKAGE, 'src/db/schema.ts': body });

    it('source lines: the line of the variable for the table, the line of each key for its column (click-to-code, the Schema view)', () => {
        const dir = project(files());
        const { tables } = parser.parse(dir, { git: false, columnSources: true });
        assert.deepEqual(tables.map(t => [t.source, ...t.columns.map(c => c.source.line)]), [
            [{ file: 'src/db/schema.ts', line: 2 }, 3, 4, 5],
            [{ file: 'src/db/schema.ts', line: 8 }, 11, 12, 13],
        ]);
        assert.ok(parser.parse(dir, { git: false }).tables.every(t => t.columns.every(c => c.source === undefined)));
    });

    it('git status per column and table: untracked before the first commit, committed, modified (a changed, removed or added column, a changed key)', () => {
        const dir = project(files());
        git(dir, 'init', '-q');
        assert.deepEqual(statuses(parser.parse(dir)), [
            ['users', 'untracked', 'id=untracked', 'email=untracked', 'name=untracked'],
            ['posts', 'untracked', 'id=untracked', 'title=untracked', 'author_id=untracked'],
        ], 'no commit yet');
        commitAll(dir);
        assert.deepEqual(statuses(parser.parse(dir)), [
            ['users', 'committed', 'id=committed', 'email=committed', 'name=committed'],
            ['posts', 'committed', 'id=committed', 'title=committed', 'author_id=committed'],
        ]);
        const file = path.join(dir, 'src', 'db', 'schema.ts');
        fs.writeFileSync(file, BODY
            .replace("{ length: 255 }", '{ length: 320 }')
            .replace("  name: text('name'),\n", '')
            .replace("(t) => [index('posts_author_idx').on(t.authorId)]", "(t) => [index('posts_author_idx').on(t.authorId, t.title)]"));
        assert.deepEqual(statuses(parser.parse(dir)), [
            ['users', 'modified', 'id=committed', 'email=modified'],
            ['posts', 'modified', 'id=committed', 'title=committed', 'author_id=committed'],
        ]);
    });

    it('a table added to a file that is in HEAD is new (untracked), with its columns, as in a new file; a new file of a schema folder too', () => {
        const dir = project(files());
        git(dir, 'init', '-q');
        commitAll(dir);
        const file = path.join(dir, 'src', 'db', 'schema.ts');
        fs.writeFileSync(file, `${BODY.replace('export const posts', "export const drafts = pgTable('drafts', {\n  id: serial('id').primaryKey(),\n\n  body: text('body'),\n});\n\nexport const posts")}\nexport const tags = pgTable('tags', {\n  id: serial('id').primaryKey(),\n});\n`);
        assert.deepEqual(statuses(parser.parse(dir)), [
            ['users', 'committed', 'id=committed', 'email=committed', 'name=committed'],
            ['drafts', 'untracked', 'id=untracked', 'body=untracked'],
            ['posts', 'committed', 'id=committed', 'title=committed', 'author_id=committed'],
            ['tags', 'untracked', 'id=untracked'],
        ]);
        // Once committed, a table whose columns all change (not its declaration line) is modified
        commitAll(dir);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("export const tags = pgTable('tags', {\n  id: serial('id').primaryKey(),\n", "export const tags = pgTable('tags', {\n  id: integer('id').primaryKey(),\n"));
        assert.deepEqual(statuses(parser.parse(dir)).at(-1), ['tags', 'modified', 'id=modified']);
        // A new file of the schema folder
        const folder = project({ 'package.json': PACKAGE, 'src/db/schema/users.ts': PG + USERS });
        git(folder, 'init', '-q');
        commitAll(folder);
        writeFiles(folder, { 'src/db/schema/tags.ts': `${PG}export const tags = pgTable('tags', { id: integer() });\n` });
        assert.deepEqual(statuses(parser.parse(folder)), [['tags', 'untracked', 'id=untracked'], ['users', 'committed', 'id=committed', 'email=committed']]);
    });

    it('columns spread from a helper file: their status is the one of their lines in that file', () => {
        const dir = project({
            'package.json': PACKAGE,
            'src/db/columns.ts': "import { timestamp } from 'drizzle-orm/pg-core';\nexport const timestamps = {\n  createdAt: timestamp('created_at').notNull(),\n  updatedAt: timestamp('updated_at'),\n};\n",
            'src/db/schema.ts': `${PG}import { timestamps } from './columns';\nexport const users = pgTable('users', {\n  id: serial('id').primaryKey(),\n  ...timestamps,\n});\n`,
        });
        git(dir, 'init', '-q');
        commitAll(dir);
        fs.writeFileSync(path.join(dir, 'src', 'db', 'columns.ts'), fs.readFileSync(path.join(dir, 'src', 'db', 'columns.ts'), 'utf8').replace("timestamp('updated_at')", "timestamp('updated_at', { withTimezone: true })"));
        assert.deepEqual(statuses(parser.parse(dir)), [['users', 'modified', 'id=committed', 'created_at=committed', 'updated_at=modified']]);
    });

    it('unsaved editors: the text of a schema file, of a helper file and of drizzle.config.ts is read', () => {
        const dir = project({ ...files(), 'db/other.ts': PG + USERS.replace("'users'", "'other'"), 'drizzle.config.ts': "export default { schema: './src/db/schema.ts' };\n" });
        git(dir, 'init', '-q');
        commitAll(dir);
        const file = path.join(dir, 'src', 'db', 'schema.ts');
        const typed = BODY.replace("  name: text('name'),\n", "  name: text('name'),\n  bio: text('bio'),\n");
        assert.deepEqual(statuses(parser.parse(dir, { overrides: new Map([[file, typed]]) })), [
            ['users', 'unsaved', 'id=committed', 'email=committed', 'name=committed', 'bio=unsaved'],
            ['posts', 'committed', 'id=committed', 'title=committed', 'author_id=committed'],
        ]);
        const config = new Map([[path.join(dir, 'drizzle.config.ts'), "export default { schema: './db/other.ts' };\n"]]);
        assert.deepEqual(parser.parse(dir, { overrides: config, git: false }).tables.map(t => t.table), ['other']);
        // Unsaved without git: only the unsaved lines have a status
        const offline = parser.parse(dir, { overrides: new Map([[file, typed]]), git: false });
        assert.deepEqual(statuses(offline), [['users', 'unsaved', 'id=undefined', 'email=undefined', 'name=undefined', 'bio=unsaved'], ['posts', undefined, 'id=undefined', 'title=undefined', 'author_id=undefined']]);
    });

    it('the git cache is reused until it is cleared, git: false gives no git keys, a folder outside a repository neither, without warning', () => {
        const dir = project(files());
        git(dir, 'init', '-q');
        commitAll(dir);
        const gitCache = new Map();
        assert.equal(parser.parse(dir, { gitCache }).tables[0].git, 'committed');
        assert.equal(gitCache.size, 1);
        fs.appendFileSync(path.join(dir, 'src', 'db', 'schema.ts'), "\nexport const tags = pgTable('tags', { id: integer() });\n");
        assert.equal(parser.parse(dir, { gitCache }).tables[2].git, 'committed', 'the cache is kept');
        assert.equal(parser.parse(dir, { gitCache: new Map() }).tables[2].git, 'untracked');
        const off = parser.parse(dir, { git: false });
        assert.ok(off.tables.every(t => t.git === undefined && t.columns.every(c => c.git === undefined)));
        const outside = parser.parse(project(files()));
        assert.deepEqual(outside.warnings, []);
        assert.ok(outside.tables.every(t => t.git === undefined && t.columns.every(c => c.git === undefined)));
    });

    it('a project in a subfolder of the repository (monorepo), its schema folder read with one git call', () => {
        const root = project({ 'packages/db/package.json': PACKAGE, 'packages/db/src/db/schema/users.ts': PG + USERS, 'README.md': 'monorepo' });
        git(root, 'init', '-q');
        commitAll(root);
        fs.appendFileSync(path.join(root, 'packages', 'db', 'src', 'db', 'schema', 'users.ts'), "\nexport const tags = pgTable('tags', { id: integer() });\n");
        assert.deepEqual(parser.parse(path.join(root, 'packages', 'db')).tables.map(t => [t.table, t.git, t.source.file]), [
            ['users', 'committed', 'src/db/schema/users.ts'],
            ['tags', 'untracked', 'src/db/schema/users.ts'],
        ]);
    });
});

// ---------------------------------------------------------------------------------------------

describe('drizzle parser: warnings', () => {
    it('a computed table name, a computed column name, a column that is not a builder, a table declared twice', () => {
        const result = parseSchema("const NAME = process.env.TABLE;\nexport const a = pgTable(NAME, { id: integer() });\nexport const b = pgTable('b', {\n  id: integer(columnName()),\n  weird: 42,\n  ok: text(),\n});\nexport const c = pgTable('b', { id: integer() });\n", {}, { 'src/db/other.ts': '' });
        assert.deepEqual(result.tables.map(t => [t.table, t.columns.map(c => c.name)]), [['b', ['id', 'ok']], ['b', ['id']]]);
        assert.deepEqual(result.warnings, [
            'src/db/schema.ts:3: a: the table name is computed, table skipped.',
            'src/db/schema.ts:5: b.id: the column name is computed, the key is used.',
            'src/db/schema.ts:6: b.weird: column not understood, skipped.',
            'Table "b" is declared twice (src/db/schema.ts and src/db/schema.ts).',
        ]);
    });

    it('code being typed: a column not finished, a string or a template not closed, brackets not closed, do not throw', () => {
        const typing = [
            "export const users = pgTable('users', {\n  id: serial().primaryKey(),\n  email: varchar(\n});\n",
            "export const users = pgTable('users', {\n  id: serial().primaryKey(),\n  email: varchar('ema\n});\n",
            "export const users = pgTable('users', {\n  id: serial().primaryKey(),\n  email: text().default(`x${\n",
            "export const users = pgTable('users', {\n  id: serial().primaryKey(),\n  email: text().references(() => \n",
            "export const users = pgTable('users', {\n  id: serial().primaryKey(),\n  ...\n});\n",
            "export const users = pgTable('users'",
            'export const users = pgTable(',
        ];
        for (const body of typing) {
            const result = parseSchema(body);
            assert.ok(Array.isArray(result.tables) && Array.isArray(result.warnings), body);
        }
        assert.deepEqual(parseSchema(typing[0]).tables[0].columns.map(c => c.name), ['id', 'email']);
    });

    it('a UTF-8 BOM, CRLF line endings, comments with brackets and quotes, a regular expression, code without semicolons', () => {
        const text = `\uFEFF${PG}/* a { comment ( with "quotes */\nconst SLUG = /^[a-z}{]+$/;\nexport const users = pgTable('users', { // }\n  id: serial('id').primaryKey(), // )\n  slug: text('slug').notNull()\n})\nexport const tags = pgTable('tags', {\n  id: integer('id')\n})\n`.replace(/\n/g, '\r\n');
        const result = parser.parse(project({ 'package.json': PACKAGE, 'src/db/schema.ts': text }), { git: false, columnSources: true });
        assert.deepEqual(result.tables.map(t => [t.table, t.source.line, t.columns.map(c => [c.name, c.source.line])]), [
            ['users', 4, [['id', 5], ['slug', 6]]],
            ['tags', 8, [['id', 9]]],
        ]);
        assert.deepEqual(result.warnings, []);
    });

    it('calls nested 20000 times, a 200k-character line, generic types never closed, a spread of itself: read quickly, without a stack overflow', () => {
        const deep = `export const a = pgTable('a', {\n  id: integer().default(${'f('.repeat(20000)}${')'.repeat(20000)}),\n  wide:${' '.repeat(200000)}integer(),\n  type: integer().$type<${'A<'.repeat(20000)}>(),\n  ok: integer(),\n});\nconst s = { ...s, x: integer() };\nexport const b = pgTable('b', { ...s, id: integer() });\n`;
        const started = Date.now();
        const result = parseSchema(deep);
        assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
        assert.deepEqual(result.tables.map(t => [t.table, t.columns.map(c => c.name)]), [['a', ['id', 'wide', 'ok']], ['b', ['x', 'id']]]);
        assert.deepEqual(result.warnings, [
            'src/db/schema.ts:5: a.type: column not understood, skipped.',
            'src/db/schema.ts:8: b: ...s cannot be read, its columns are skipped.',
        ]);
    });

    it('does not depend on vscode, and never runs a file of the project', () => {
        for (const file of ['drizzle.js', 'ts-utils.js']) {
            const source = fs.readFileSync(path.join(__dirname, '..', '..', 'parsers', file), 'utf8');
            assert.doesNotMatch(source, /require\(['"]vscode['"]\)/, file);
            assert.doesNotMatch(source, /child_process|\beval\(|new Function|vm\.|import\(/, file);
        }
    });
});

//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// The Prisma parser (parsers/prisma.js): where the schema is, the tables of the models as
// `prisma migrate` creates them, the relations, the details, the source lines and the git status.
// The fixtures and the schemas below were checked with `prisma migrate diff --from-empty --script`
// (see test/fixtures/prisma/README.md).

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const parser = require('../../parsers/prisma');
const registry = require('../../parsers/registry');
const { ParserError } = require('../../parsers/errors');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'prisma');
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

// Temporary project with the given files ({ 'prisma/schema.prisma': '...' })
function project(files = {}) {
    const dir = fs.mkdtempSync(path.join(TMP, 'dmdb-prisma-'));
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

const datasource = (provider = 'postgresql') => `datasource db {\n  provider = "${provider}"\n}\n\n`;
const PACKAGE = JSON.stringify({ name: 'app', devDependencies: { prisma: '^7.10.1' } });
const SCHEMA = `${datasource()}model User {\n  id Int @id\n}\n`;

// A project whose prisma/schema.prisma is `body` after the datasource of `provider`
const schemaProject = (body, provider) => project({ 'prisma/schema.prisma': datasource(provider) + body });
// The tables of a schema, without their source line and git status (tested on their own)
function tablesOf(body, options = {}, provider = 'postgresql') {
    const result = parser.parse(schemaProject(body, provider), { git: false, ...options });
    return result.tables.map(({ source, git: status, ...table }) => {
        assert.ok(source && status === undefined);
        return table;
    });
}
const parseSchema = (body, options = {}, provider = 'postgresql') => parser.parse(schemaProject(body, provider), { git: false, ...options });
const tableNamed = (tables, name) => tables.find(t => t.table === name);

// ---------------------------------------------------------------------------------------------

describe('prisma parser: real and hand-made fixtures', () => {
    const fixtures = fs.readdirSync(FIXTURES).filter(name => name !== 'expected' && fs.statSync(path.join(FIXTURES, name)).isDirectory()).sort();
    const expected = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected', `${name}.json`), 'utf8'));
    const DETAIL_KEYS = ['length', 'precision', 'scale', 'unsigned', 'default', 'defaultRaw', 'values', 'unique', 'autoIncrement', 'nativeType'];

    it('has the six real schemas and the hand-made ones', () => {
        assert.deepEqual(fixtures, ['cal-diy', 'dub', 'edge-cases', 'hoppscotch', 'multi-schema', 'prisma-examples-betterauth', 'prisma-examples-sql-server', 'umami']);
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

    it('every fixture is detected as Prisma, with its package (100)', () => {
        for (const name of fixtures.filter(n => !['edge-cases', 'multi-schema'].includes(n))) {
            assert.deepEqual(registry.detect(path.join(FIXTURES, name)), { framework: 'prisma', forced: false, matches: [{ id: 'prisma', label: 'Prisma', score: 100 }], errors: [] }, name);
        }
        assert.equal(registry.detect(path.join(FIXTURES, 'edge-cases')).matches[0].score, 50, 'the schema alone');
    });

    it('dub: the 37 files of its multi-file schema folder, in the order of their paths', () => {
        const { tables } = parser.parse(path.join(FIXTURES, 'dub'), { git: false });
        const files = [...new Set(tables.map(t => t.source.file))];
        assert.equal(files.length, 37);
        assert.deepEqual(files, [...files].sort());
        assert.ok(files.every(file => /^prisma\/schema\/\w+\.prisma$/.test(file)));
        assert.deepEqual(tableNamed(tables, 'ActivityLog').source, { file: 'prisma/schema/activity.prisma', line: 1 });
    });
});

// ---------------------------------------------------------------------------------------------

describe('prisma parser: detection', () => {
    it('detection: a schema and prisma or @prisma/client in package.json score 100', () => {
        assert.equal(parser.detect(project({ 'prisma/schema.prisma': SCHEMA, 'package.json': PACKAGE })), 100);
        assert.equal(parser.detect(project({ 'schema.prisma': SCHEMA, 'package.json': JSON.stringify({ dependencies: { '@prisma/client': '6.19.1' } }) })), 100);
        assert.equal(parser.detect(project({ 'prisma/schema.prisma': SCHEMA, 'prisma.config.ts': 'export default {}\n' })), 100, 'a Prisma config file counts as the package');
    });

    it('detection: the schema alone or a config file alone score 50; the package alone, or nothing, scores 0', () => {
        assert.equal(parser.detect(project({ 'prisma/schema.prisma': SCHEMA })), 50);
        assert.equal(parser.detect(project({ 'prisma.config.ts': 'export default {}\n' })), 50);
        assert.equal(parser.detect(project({ 'package.json': JSON.stringify({ dependencies: { '@prisma/adapter-pg': '7.0.0', 'prisma-kysely': '1.0.0' } }) })), 0);
        assert.equal(parser.detect(project({ 'package.json': JSON.stringify({ peerDependencies: { prisma: '7.0.0' } }) })), 0, 'only dependencies and devDependencies');
        assert.equal(parser.detect(project({ 'composer.json': '{}', artisan: '' })), 0);
        assert.equal(parser.detect(path.join(TMP, 'dmdb-prisma-missing')), 0);
        assert.equal(parser.detect(path.join(project({ 'schema.prisma': SCHEMA }), 'schema.prisma')), 0, 'a file is not a project');
        assert.equal(parser.detect(''), 0);
        assert.equal(parser.detect(undefined), 0);
    });

    it('detection: the package alone scores 0, a monorepo root whose schema is in a package is no Prisma project (the framework folder is suggested)', () => {
        assert.equal(parser.detect(project({ 'package.json': PACKAGE })), 0);
        assert.equal(parser.detect(project({ 'package.json': JSON.stringify({ dependencies: { '@prisma/client': '6.19.1' } }) })), 0, 'an app using the client of another package');
        const root = project({
            'package.json': JSON.stringify({ workspaces: ['packages/*'], devDependencies: { prisma: '^6' } }),
            'packages/db/package.json': PACKAGE,
            'packages/db/prisma/schema.prisma': SCHEMA,
        });
        assert.equal(parser.detect(root), 0);
        assert.deepEqual(registry.detect(root), { framework: 'Unknown', forced: false, matches: [], errors: [] });
        assert.equal(parser.detect(path.join(root, 'packages', 'db')), 100, 'its framework folder');
        // A config file or a "prisma.schema" of package.json whose schema is missing: a Prisma project, parse() tells it
        assert.equal(parser.detect(project({ 'package.json': JSON.stringify({ prisma: { schema: 'db/main.prisma' }, devDependencies: { prisma: '6.19.1' } }) })), 50);
        assert.equal(parser.detect(project({ 'package.json': JSON.stringify({ prisma: { schema: 'db/main.prisma' } }) })), 0, 'without the package');
    });

    it('detection: the multi-file schema folder prisma/schema, the "prisma.schema" path of package.json and the schema of prisma.config.ts', () => {
        assert.equal(parser.detect(project({ 'prisma/schema/user.prisma': SCHEMA })), 50);
        assert.equal(parser.detect(project({ 'db/main.prisma': SCHEMA, 'package.json': JSON.stringify({ prisma: { schema: 'db/main.prisma' } }) })), 50);
        assert.equal(parser.detect(project({ 'db/main.prisma': SCHEMA, 'prisma.config.ts': 'export default { schema: "db/main.prisma" }\n' })), 100);
        assert.equal(parser.detect(project({ 'prisma.config.ts': 'export default { schema: "db/main.prisma" }\n' })), 50, 'the config file, without the schema it names');
    });

    it('detection: an invalid package.json is not an error, the schema is still found', () => {
        assert.equal(parser.detect(project({ 'package.json': '{ "name": ', 'prisma/schema.prisma': SCHEMA })), 50);
        assert.equal(parser.detect(project({ 'package.json': '\uFEFF' + PACKAGE, 'prisma/schema.prisma': SCHEMA })), 100, 'UTF-8 BOM');
        assert.equal(parser.detect(project({ 'package.json': 'null' })), 0);
    });
});

// ---------------------------------------------------------------------------------------------

describe('prisma parser: where the schema is', () => {
    const fileOf = (dir) => {
        const sources = registry.getSources('prisma', dir);
        return sources.folders.length > 0 ? { folder: path.relative(dir, sources.folders[0].path) } : { file: path.relative(dir, sources.files[0]) };
    };

    it('schema.prisma, then prisma/schema.prisma, then the prisma/schema folder, as the Prisma CLI looks for them', () => {
        const files = { 'schema.prisma': SCHEMA, 'prisma/schema.prisma': SCHEMA, 'prisma/schema/user.prisma': SCHEMA };
        assert.deepEqual(fileOf(project(files)), { file: 'schema.prisma' });
        assert.deepEqual(fileOf(project({ 'prisma/schema.prisma': SCHEMA, 'prisma/schema/user.prisma': SCHEMA })), { file: path.join('prisma', 'schema.prisma') });
        assert.deepEqual(fileOf(project({ 'prisma/schema/user.prisma': SCHEMA })), { folder: path.join('prisma', 'schema') });
    });

    it('prisma.config.ts: a string, path.join(), path.resolve(__dirname, ...), a shorthand property; relative to the folder of the config file; read, never run', () => {
        const configs = [
            ['prisma.config.ts', "import { defineConfig } from 'prisma/config'\n\nexport default defineConfig({\n  schema: 'db/main.prisma',\n  migrations: { path: 'db/migrations' },\n})\n", { file: path.join('db', 'main.prisma') }],
            ['prisma.config.ts', "import path from 'node:path'\nexport default defineConfig({\n  // schema: 'old.prisma',\n  schema: path.join('db', 'schema'),\n})\n", { folder: path.join('db', 'schema') }],
            ['prisma.config.ts', 'export default defineConfig({ schema: path.resolve(__dirname, "db", "main.prisma") })\n', { file: path.join('db', 'main.prisma') }],
            ['prisma.config.ts', "const schema = 'db/main.prisma'\nexport default defineConfig({ schema })\n", { file: path.join('db', 'main.prisma') }],
            ['prisma.config.mts', 'export default defineConfig({ "schema": `./db/main.prisma` })\n', { file: path.join('db', 'main.prisma') }],
            ['.config/prisma.ts', "export default defineConfig({ schema: '../db/main.prisma' })\n", { file: path.join('db', 'main.prisma') }],
            // Running the file would throw: it is only read
            ['prisma.config.ts', "throw new Error('not run')\nexport default { schema: 'db/main.prisma' }\n", { file: path.join('db', 'main.prisma') }],
        ];
        for (const [name, text, location] of configs) {
            const dir = project({ [name]: text, 'db/main.prisma': SCHEMA, 'db/schema/user.prisma': SCHEMA, 'prisma/schema.prisma': SCHEMA });
            assert.deepEqual(fileOf(dir), location, text);
            assert.equal(parser.parse(dir, { git: false }).tables.length, 1, text);
        }
    });

    it('prisma.config.ts: only the schema of the config object counts, not the schema option of a driver adapter or of another object', () => {
        const configs = [
            // PrismaPg and PrismaNeon take the Postgres schema in their options
            "import { defineConfig } from 'prisma/config'\nclass PrismaPg { constructor(public pool: object, public options: object) {} }\nconst tenant = { schema: 'tenant_b' }\n\nexport default defineConfig({\n  experimental: { adapter: true },\n  async adapter() {\n    return new PrismaPg({ connectionString: process.env.DATABASE_URL }, { schema: 'tenant_a' })\n  },\n  schema: 'db/main.prisma',\n})\n",
            // A variable that is exported, typed, with a nested schema key
            "import type { PrismaConfig } from 'prisma'\nconst adapterOptions = { schema: 'tenant_a' }\nconst config: PrismaConfig = {\n  migrations: { path: 'db/migrations', schema: 'x' },\n  'schema': 'db/main.prisma',\n}\nexport default config\n",
            "const options = { schema: 'tenant_a' }\nexport default {\n  ...base,\n  schema: 'db/main.prisma',\n} satisfies PrismaConfig\n",
            "module.exports = defineConfig({ datasource: { url: env('DATABASE_URL'), schema: 'x' }, schemaPath: 'x', schema: 'db/main.prisma' })\n",
            "const config = defineConfig({ adapter: () => new PrismaPg(pool, { schema: 'a' }), schema: 'db/main.prisma' })\nexport default config\n",
        ];
        for (const text of configs) {
            const dir = project({ 'prisma.config.ts': text, 'db/main.prisma': SCHEMA, 'prisma/schema.prisma': SCHEMA.replace('User', 'Other') });
            assert.deepEqual(fileOf(dir), { file: path.join('db', 'main.prisma') }, text);
            assert.deepEqual(parser.parse(dir, { git: false }).warnings, [], text);
        }
        // A config object without a schema: the default locations, without a warning
        const nested = project({ 'prisma.config.ts': "export default defineConfig({\n  adapter: () => new PrismaPg(pool, { schema: 'tenant_a' }),\n})\n", 'prisma/schema.prisma': SCHEMA });
        assert.deepEqual(fileOf(nested), { file: path.join('prisma', 'schema.prisma') });
        assert.deepEqual(parser.parse(nested, { git: false }).warnings, []);
        // A config built by a function: its schema is computed
        const built = project({ 'prisma.config.ts': "export default defineConfig(makeConfig({ schema: 'db/main.prisma' }))\n", 'prisma/schema.prisma': SCHEMA });
        assert.deepEqual(parser.parse(built, { git: false }).warnings, ['prisma.config.ts: the schema path is computed, it cannot be read without running the file: the default locations are read.']);
        const plain = project({ 'prisma.config.ts': 'export default makeConfig()\n', 'prisma/schema.prisma': SCHEMA });
        assert.deepEqual(parser.parse(plain, { git: false }).warnings, [], 'no schema key: nothing to tell');
    });

    it('a schema path computed in prisma.config.ts is told, and the default locations are read', () => {
        const dir = project({ 'prisma.config.ts': 'export default defineConfig({ schema: process.env.SCHEMA ?? "prisma/schema.prisma" })\n', 'prisma/schema.prisma': SCHEMA });
        const result = parser.parse(dir, { git: false });
        assert.deepEqual(result.warnings, ['prisma.config.ts: the schema path is computed, it cannot be read without running the file: the default locations are read.']);
        assert.deepEqual(result.tables.map(t => t.table), ['User']);
        // A config file without a schema: the default locations, without a warning
        assert.deepEqual(parser.parse(path.join(FIXTURES, 'umami'), { git: false }).warnings, []);
    });

    it('the "prisma.schema" path of package.json (Prisma 6), unless prisma.config.ts sets the schema', () => {
        const pkg = JSON.stringify({ prisma: { schema: './db/main.prisma' }, devDependencies: { prisma: '6.19.1' } });
        assert.deepEqual(fileOf(project({ 'package.json': pkg, 'db/main.prisma': SCHEMA, 'prisma/schema.prisma': SCHEMA })), { file: path.join('db', 'main.prisma') });
        assert.deepEqual(fileOf(project({ 'package.json': pkg, 'db/main.prisma': SCHEMA, 'prisma.config.ts': 'export default { schema: "other.prisma" }\n', 'other.prisma': SCHEMA })), { file: 'other.prisma' });
        assert.deepEqual(fileOf(project({ 'package.json': JSON.stringify({ prisma: { schema: 'db' } }), 'db/a.prisma': SCHEMA })), { folder: 'db' });
        // An invalid package.json is told when it is read for the schema path
        const broken = parser.parse(project({ 'package.json': '{,}', 'prisma/schema.prisma': SCHEMA }), { git: false });
        assert.equal(broken.warnings.length, 1);
        assert.match(broken.warnings[0], /^package\.json could not be read: /);
    });

    it('Prisma 7 ignores the "prisma.schema" of package.json: the default location is read, else that schema, with a warning', () => {
        const pkg = (version, key = 'devDependencies', name = 'prisma') => JSON.stringify({ prisma: { schema: 'db/schema.prisma' }, [key]: { [name]: version } });
        const both = { 'db/schema.prisma': SCHEMA.replace('User', 'FromPkg'), 'prisma/schema.prisma': SCHEMA };
        for (const [version, key, name] of [['^7.10.1'], ['7.0.0', 'dependencies'], ['~7.1.0', 'dependencies', '@prisma/client'], ['>= 7', 'devDependencies'], ['workspace:^7.2.0']]) {
            const dir = project({ 'package.json': pkg(version, key, name), ...both });
            const result = parser.parse(dir, { git: false });
            assert.deepEqual(result.tables.map(t => t.table), ['User'], version);
            assert.deepEqual(result.warnings, [`package.json: Prisma 7 ignores "prisma.schema" (the schema is set in prisma.config.ts): prisma/schema.prisma is read, as the Prisma CLI does.`], version);
            assert.deepEqual(fileOf(dir), { file: path.join('prisma', 'schema.prisma') }, 'the sources follow');
        }
        // Prisma 5 and 6, or a range that tells no version: package.json is followed, without a warning
        for (const version of ['6.19.1', '^5.22.0', 'latest', 'workspace:*']) {
            const result = parser.parse(project({ 'package.json': pkg(version), ...both }), { git: false });
            assert.deepEqual([result.tables.map(t => t.table), result.warnings], [['FromPkg'], []], version);
        }
        // Prisma 7 without a schema at a default location: the schema of package.json, told
        const only = parser.parse(project({ 'package.json': pkg('^7.10.1'), 'db/schema.prisma': SCHEMA.replace('User', 'FromPkg') }), { git: false });
        assert.deepEqual(only.tables.map(t => t.table), ['FromPkg']);
        assert.deepEqual(only.warnings, ['package.json: Prisma 7 ignores "prisma.schema" (the schema is set in prisma.config.ts), there is no schema at the default locations: the one of package.json is read.']);
        // The schema of prisma.config.ts still wins
        const config = project({ 'package.json': pkg('^7.10.1'), 'prisma.config.ts': "export default { schema: 'other.prisma' }\n", 'other.prisma': SCHEMA.replace('User', 'Other'), ...both });
        const configured = parser.parse(config, { git: false });
        assert.deepEqual([configured.tables.map(t => t.table), configured.warnings], [['Other'], []]);
    });

    it('errors: no schema, a schema path that does not exist, a folder without .prisma files', () => {
        const empty = project({ 'package.json': PACKAGE });
        assert.throws(() => parser.parse(empty), error => error instanceof ParserError && error.message === `No Prisma schema found in ${empty}: DrawMeDatabase reads schema.prisma, prisma/schema.prisma, the prisma/schema folder, or the schema set in prisma.config.ts or in the "prisma" section of package.json.`);
        const missing = project({ 'prisma.config.ts': "export default { schema: 'db/main.prisma' }\n" });
        assert.throws(() => parser.parse(missing), error => error instanceof ParserError && error.message === `The Prisma schema set in prisma.config.ts was not found: ${path.join(missing, 'db', 'main.prisma')}`);
        const pkg = project({ 'package.json': JSON.stringify({ prisma: { schema: 'db.prisma' } }) });
        assert.throws(() => parser.parse(pkg), error => error instanceof ParserError && error.message === `The Prisma schema set in package.json was not found: ${path.join(pkg, 'db.prisma')}`);
        const folder = project({ 'prisma/schema/README.md': '' });
        assert.throws(() => parser.parse(folder), error => error instanceof ParserError && error.message === `No .prisma files found in ${path.join(folder, 'prisma', 'schema')}`);
    });

    it('a schema folder: its .prisma files and those of its sub-folders, in the order of their paths', () => {
        const dir = project({
            'prisma/schema/schema.prisma': datasource(),
            'prisma/schema/b.prisma': 'model B {\n  id Int @id\n}\n',
            'prisma/schema/a/z.prisma': 'model Z {\n  id Int @id\n}\n',
            'prisma/schema/a.prisma': 'model A {\n  id Int @id\n}\n',
            'prisma/schema/notes.md': 'model Note {\n  id Int @id\n}\n',
            'prisma/schema/migrations/0_init/migration.sql': 'CREATE TABLE "x" ();',
        });
        const { tables } = parser.parse(dir, { git: false });
        // Byte order of the paths: a.prisma ('.') before a/z.prisma ('/')
        assert.deepEqual(tables.map(t => [t.table, t.source.file]), [['A', 'prisma/schema/a.prisma'], ['Z', 'prisma/schema/a/z.prisma'], ['B', 'prisma/schema/b.prisma']]);
    });

    it('sources(): the schema file or folder, package.json and the config file; every default location while there is no schema', () => {
        const single = project({ 'prisma/schema.prisma': SCHEMA, 'prisma.config.mts': 'export default {}\n' });
        assert.deepEqual(registry.getSources('prisma', single), {
            folders: [],
            files: [path.join(single, 'prisma', 'schema.prisma'), path.join(single, 'package.json'), path.join(single, 'prisma.config.mts')],
            extensions: ['.prisma'],
        });
        const folder = project({ 'prisma/schema/user.prisma': SCHEMA });
        const sources = registry.getSources('prisma', folder);
        assert.deepEqual(sources, {
            folders: [{ path: path.join(folder, 'prisma', 'schema'), recursive: true }],
            files: [path.join(folder, 'package.json'), path.join(folder, 'prisma.config.ts')],
            extensions: ['.prisma'],
        });
        assert.deepEqual(registry.watchPatterns(sources), [
            { base: path.join(folder, 'prisma', 'schema'), pattern: '**/*.prisma' },
            { base: folder, pattern: 'package.json' },
            { base: folder, pattern: 'prisma.config.ts' },
        ]);
        assert.equal(registry.covers(sources, path.join(folder, 'prisma', 'schema', 'models', 'post.prisma')), true);
        assert.equal(registry.covers(sources, path.join(folder, 'prisma', 'schema', 'migrations', '0_init', 'migration.sql')), false);
        assert.equal(registry.covers(sources, path.join(folder, 'prisma.config.ts')), true);
        const none = project({ 'package.json': PACKAGE });
        assert.deepEqual(registry.getSources('prisma', none), {
            folders: [{ path: path.join(none, 'prisma', 'schema'), recursive: true }],
            files: [path.join(none, 'schema.prisma'), path.join(none, 'prisma', 'schema.prisma'), path.join(none, 'package.json'), path.join(none, 'prisma.config.ts')],
            extensions: ['.prisma'],
        });
    });
});

describe('prisma parser: the dialect and the migrations of a project (API version 4)', () => {
    const MIGRATION = (name) => ({ [`${name}/migration.sql`]: `CREATE TABLE "${name.replace(/^\d+_/, '')}" ("id" INTEGER NOT NULL PRIMARY KEY);\n` });
    const migrationsIn = (folder, provider = 'postgresql') => Object.fromEntries(Object.entries({ ...MIGRATION('20240101000000_a'), ...MIGRATION('20240102000000_b'), 'migration_lock.toml': `provider = "${provider}"\n` }).map(([rel, text]) => [`${folder}/${rel}`, text]));
    const ids = (result) => result && result.migrations.map(m => m.id);

    it('the dialect: the provider of the datasource, of a schema folder too', () => {
        for (const [provider, dialect] of [['postgresql', 'postgresql'], ['postgres', 'postgresql'], ['mysql', 'mysql'], ['sqlite', 'sqlite'], ['sqlserver', 'sqlserver'], ['cockroachdb', 'cockroachdb'], ['mongodb', 'mongodb'], ['other', null]]) {
            assert.equal(parser.dialect(schemaProject('model A {\n  id Int @id\n}\n', provider)), dialect, provider);
        }
        const folder = project({ 'package.json': PACKAGE, 'prisma/schema/user.prisma': 'model User {\n  id Int @id\n}\n', 'prisma/schema/schema.prisma': datasource('mysql') });
        assert.equal(registry.getDialect('prisma', folder), 'mysql');
        // The unsaved schema
        const dir = schemaProject('', 'sqlite');
        assert.equal(parser.dialect(dir, { overrides: new Map([[path.join(dir, 'prisma', 'schema.prisma'), datasource('mysql')]]) }), 'mysql');
        assert.equal(parser.dialect(project({ 'package.json': PACKAGE })), null);
        assert.equal(parser.dialect(project({ 'prisma/schema.prisma': 'model A {\n  id Int @id\n}\n' })), null, 'no datasource');
    });

    it('the migrations: the SQL of prisma migrate next to the schema, or in the migrations.path of prisma.config.ts, read by the SQL reader in their order', () => {
        const dir = project({ 'package.json': PACKAGE, 'prisma/schema.prisma': SCHEMA, ...migrationsIn('prisma/migrations') });
        const result = registry.getMigrations('prisma', dir);
        assert.deepEqual(result, { root: dir, framework: 'sql', migrations: [
            { id: '20240101000000_a', file: path.join(dir, 'prisma', 'migrations', '20240101000000_a', 'migration.sql'), time: Date.UTC(2024, 0, 1) / 1000 },
            { id: '20240102000000_b', file: path.join(dir, 'prisma', 'migrations', '20240102000000_b', 'migration.sql'), time: Date.UTC(2024, 0, 2) / 1000 },
        ] });
        assert.deepEqual(registry.getParser('sql').parse(result.root, { git: false, until: '20240101000000_a' }).tables.map(t => t.table), ['a']);
        // A schema at the root: ./migrations; a schema folder: its migrations sub-folder, else the one next to it
        assert.deepEqual(ids(parser.migrations(project({ 'package.json': PACKAGE, 'schema.prisma': SCHEMA, ...migrationsIn('migrations') }))), ['20240101000000_a', '20240102000000_b']);
        const inFolder = project({ 'package.json': PACKAGE, 'prisma/schema/schema.prisma': SCHEMA, ...migrationsIn('prisma/schema/migrations') });
        assert.equal(parser.migrations(inFolder).root, inFolder);
        const nextToFolder = project({ 'package.json': PACKAGE, 'prisma/schema/schema.prisma': SCHEMA, ...migrationsIn('prisma/migrations') });
        assert.deepEqual(ids(parser.migrations(nextToFolder)), ['20240101000000_a', '20240102000000_b']);
        // prisma.config.ts: migrations.path, relative to the config file; its migrations are read from their own folder when the reader would find others first
        const config = "import { defineConfig } from 'prisma/config';\nexport default defineConfig({\n  schema: 'prisma/schema.prisma',\n  migrations: {\n    path: 'db/history', // the folder of prisma migrate\n    seed: 'tsx db/seed.ts',\n  },\n});\n";
        const configured = project({ 'package.json': PACKAGE, 'prisma.config.ts': config, 'prisma/schema.prisma': SCHEMA, ...migrationsIn('db/history', 'sqlite'), ...migrationsIn('prisma/migrations') });
        const moved = registry.getMigrations('prisma', configured);
        assert.equal(moved.root, path.join(configured, 'db', 'history'));
        assert.deepEqual(moved.migrations.map(m => path.relative(configured, m.file)), [path.join('db', 'history', '20240101000000_a', 'migration.sql'), path.join('db', 'history', '20240102000000_b', 'migration.sql')]);
        assert.equal(registry.getDialect('sql', moved.root), 'sqlite');
        const joined = project({ 'package.json': PACKAGE, 'prisma.config.ts': "import path from 'node:path';\nexport default { migrations: { path: path.join('prisma', 'history') } };\n", 'prisma/schema.prisma': SCHEMA, ...migrationsIn('prisma/history') });
        assert.equal(parser.migrations(joined).root, path.join(joined, 'prisma', 'history'));
        // None: no migrations yet, or a computed path that cannot be read (the default folder then)
        assert.equal(parser.migrations(project({ 'package.json': PACKAGE, 'prisma/schema.prisma': SCHEMA })), null);
        assert.equal(parser.migrations(project({ 'package.json': PACKAGE, 'prisma.config.ts': 'export default { migrations: { path: process.env.MIGRATIONS } };\n', 'prisma/schema.prisma': SCHEMA })), null);
        assert.equal(parser.migrations(path.join(TMP, 'dmdb-prisma-missing')), null);
    });
});

describe('prisma parser: sources of unsaved editors', () => {
    it('sources() follow an unsaved package.json or prisma.config.ts that moves the schema (options.overrides), as parse() does', () => {
        const pkgText = (extra = {}) => JSON.stringify({ ...extra, devDependencies: { prisma: '6.19.1' } });
        const dir = project({ 'prisma/schema.prisma': SCHEMA, 'alt/schema.prisma': SCHEMA.replace('User', 'Alt'), 'package.json': pkgText(), 'prisma.config.ts': 'export default {}\n' });
        const files = (rel) => [path.join(dir, rel), path.join(dir, 'package.json'), path.join(dir, 'prisma.config.ts')];
        assert.deepEqual(registry.getSources('prisma', dir).files, files(path.join('prisma', 'schema.prisma')));
        const pkg = new Map([[path.join(dir, 'package.json'), pkgText({ prisma: { schema: 'alt/schema.prisma' } })]]);
        assert.deepEqual(registry.getSources('prisma', dir, { overrides: pkg }).files, files(path.join('alt', 'schema.prisma')));
        assert.deepEqual(parser.parse(dir, { overrides: pkg, git: false }).tables.map(t => [t.table, t.source.file]), [['Alt', 'alt/schema.prisma']]);
        const config = new Map([[path.join(dir, 'prisma.config.ts'), "export default { schema: 'alt' }\n"]]);
        assert.deepEqual(registry.getSources('prisma', dir, { overrides: config }).folders, [{ path: path.join(dir, 'alt'), recursive: true }]);
        assert.deepEqual(parser.sources(dir, { overrides: new Map() }), parser.sources(dir));
        assert.deepEqual(parser.sources(dir, null), parser.sources(dir));
    });
});

// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------

describe('prisma parser: models and columns', () => {
    it('models → tables: @@map table names, @map column names, in the order of the code', () => {
        assert.deepEqual(tablesOf(`model User {
  id        Int    @id @map("user_id")
  firstName String @map(name: "first_name")
  @@map("users")
}

model Post {
  id Int @id
  @@map(name: "blog_posts")
}
`), [
            { table: 'users', columns: [{ name: 'user_id', type: 'Int', primary: true }, { name: 'first_name', type: 'String' }], relations: [] },
            { table: 'blog_posts', columns: [{ name: 'id', type: 'Int', primary: true }], relations: [] },
        ]);
    });

    it('attributes written against the type (Int@id, String?@unique, B@relation(...)) are read, as the Prisma CLI accepts them', () => {
        const body = `model A {
  id    Int@id
  tags  String[]@default([])
  email String?@unique
  bId   Int
  b     B@relation(fields: [bId], references: [id])
  geo   Unsupported("point")@map("location")
}

model B {
  id Int @id
  as A[]
}
`;
        const expected = [
            {
                table: 'A',
                columns: [
                    { name: 'id', type: 'Int', primary: true },
                    { name: 'tags', type: 'String[]', nullable: true },
                    { name: 'email', type: 'String', nullable: true, unique: true },
                    { name: 'bId', type: 'Int' },
                    { name: 'location', type: 'Unsupported("point")', nativeType: 'point' },
                ],
                relations: [{ foreignKey: 'bId', references: 'id', on: 'B', type: 'many-to-one', onDelete: 'restrict', onUpdate: 'cascade' }],
            },
            { table: 'B', columns: [{ name: 'id', type: 'Int', primary: true }], relations: [] },
        ];
        for (const text of [body, body.replace(/\n/g, '\r\n')]) {
            assert.deepEqual(parseSchema(text).warnings, []);
            assert.deepEqual(tablesOf(text, { details: true }), expected);
        }
        // Something else against the type is still no field
        assert.deepEqual(parseSchema('model A {\n  id Int@id\n  name String!\n}\n').warnings, ['prisma/schema.prisma:7: line not understood, skipped: name String!']);
    });

    it('scalar fields keep their Prisma type: String, Int, BigInt, Float, Decimal, Boolean, DateTime, Json, Bytes, enums, Unsupported("...")', () => {
        assert.deepEqual(tablesOf(`model Thing {
  id       Int      @id
  name     String
  big      BigInt
  ratio    Float
  price    Decimal
  done     Boolean
  at       DateTime
  data     Json
  blob     Bytes
  status   Status
  shape    Unsupported("circle")
  geo      Unsupported("\\"public\\".geography")?
}

enum Status {
  OPEN
  CLOSED
}
`)[0].columns, [
            { name: 'id', type: 'Int', primary: true },
            { name: 'name', type: 'String' },
            { name: 'big', type: 'BigInt' },
            { name: 'ratio', type: 'Float' },
            { name: 'price', type: 'Decimal' },
            { name: 'done', type: 'Boolean' },
            { name: 'at', type: 'DateTime' },
            { name: 'data', type: 'Json' },
            { name: 'blob', type: 'Bytes' },
            { name: 'status', type: 'Status' },
            { name: 'shape', type: 'Unsupported("circle")' },
            { name: 'geo', type: 'Unsupported("\\"public\\".geography")', nullable: true },
        ]);
    });

    it('optional "?" fields are nullable, and scalar lists "[]" too: prisma migrate creates them without NOT NULL', () => {
        assert.deepEqual(tablesOf(`model Thing {
  id    Int      @id
  note  String?
  tags  String[]
  marks Mark[]
}

enum Mark {
  A
}
`)[0].columns, [
            { name: 'id', type: 'Int', primary: true },
            { name: 'note', type: 'String', nullable: true },
            { name: 'tags', type: 'String[]', nullable: true },
            { name: 'marks', type: 'Mark[]', nullable: true },
        ]);
    });

    it('@id and @@id([...]): the primary key, also written @@id(fields: [...]) or @id()', () => {
        const tables = tablesOf(`model A {
  id String @id()
}

model B {
  tenant Int
  code   String
  @@id([tenant, code])
}

model C {
  x Int
  y Int @map("why")
  @@id(fields: [x, y], name: "xy", map: "c_pk")
}
`);
        assert.deepEqual(tables.map(t => t.columns), [
            [{ name: 'id', type: 'String', primary: true }],
            [{ name: 'tenant', type: 'Int', primary: true }, { name: 'code', type: 'String', primary: true }],
            [{ name: 'x', type: 'Int', primary: true }, { name: 'why', type: 'Int', primary: true }],
        ]);
    });

    it('@ignore fields and @@ignore models are drawn: prisma migrate creates them in the database', () => {
        assert.deepEqual(tablesOf(`model Visible {
  id     Int  @id
  legacy Int? @ignore
}

model Legacy {
  id Int @id
  @@ignore
}
`), [
            { table: 'Visible', columns: [{ name: 'id', type: 'Int', primary: true }, { name: 'legacy', type: 'Int', nullable: true }], relations: [] },
            { table: 'Legacy', columns: [{ name: 'id', type: 'Int', primary: true }], relations: [] },
        ]);
    });

    it('views and composite types are skipped with a warning', () => {
        const result = parseSchema(`model User {
  id      Int     @id
  address Address
}

view UserInfo {
  id    Int    @unique
  email String
}

type Address {
  street String
}
`);
        assert.deepEqual(result.tables.map(t => [t.table, t.columns.map(c => c.name)]), [['User', ['id']]]);
        assert.deepEqual(result.warnings, [
            'prisma/schema.prisma:10: view UserInfo skipped: views are not drawn.',
            'prisma/schema.prisma:15: composite type Address skipped: composite types are not tables.',
        ]);
    });

    it('the mongodb provider: a warning and no tables, MongoDB stores documents', () => {
        const result = parseSchema('model User {\n  id String @id @default(auto()) @map("_id") @db.ObjectId\n}\n\ntype Address {\n  street String\n}\n', {}, 'mongodb');
        assert.deepEqual(result, { tables: [], warnings: ['prisma/schema.prisma:1: the mongodb provider stores documents, not tables: the models are not drawn.'] });
    });

    it('comments //, /// and /* */ are ignored, and // in a string is no comment', () => {
        assert.deepEqual(tablesOf(`// model Commented {
//   id Int @id
// }
/// The users
model User {
  id   Int    @id // the key @unique
  /* name String
  ignored Int */
  url  String @default("https://example.com") @map("home_page") // a comment
  /// doc comment @map("x")
  note String
}
/*
model Hidden {
  id Int @id
}
*/
`, { details: true })[0].columns, [
            { name: 'id', type: 'Int', primary: true },
            { name: 'home_page', type: 'String', default: 'https://example.com' },
            { name: 'note', type: 'String' },
        ]);
    });

    it('@@schema: the tables of another schema than the default one are qualified (auth.users), and their join tables', () => {
        const body = `model Account {
  id    Int    @id
  roles Role[]
  @@map("users")
  @@schema("auth")
}

model Role {
  id       Int       @id
  accounts Account[]
  @@schema("%DEFAULT%")
}
`;
        const pg = tablesOf(body.replace('%DEFAULT%', 'public'));
        assert.deepEqual(pg.map(t => t.table), ['auth.users', 'Role']);
        assert.deepEqual(pg[0].relations, [{ foreignKey: 'A', references: 'id', on: 'Role', type: 'many-to-many', via: 'auth._AccountToRole' }]);
        assert.deepEqual(tablesOf(body.replace('%DEFAULT%', 'dbo'), {}, 'sqlserver').map(t => t.table), ['auth.users', 'Role'], 'SQL Server: dbo');
        assert.deepEqual(tablesOf(body.replace('%DEFAULT%', 'app'), {}, 'mysql').map(t => t.table), ['auth.users', 'app.Role'], 'no default schema on MySQL');
    });
});

// ---------------------------------------------------------------------------------------------

describe('prisma parser: relations', () => {
    it('@relation(fields, references): a many-to-one foreign key on the side that holds the fields, in database names', () => {
        assert.deepEqual(tablesOf(`model User {
  id    Int    @id @map("user_id")
  posts Post[]
  @@map("users")
}

model Post {
  id       Int  @id
  authorId Int  @map("author_id")
  author   User @relation(fields: [authorId], references: [id])
}
`), [
            { table: 'users', columns: [{ name: 'user_id', type: 'Int', primary: true }], relations: [] },
            {
                table: 'Post',
                columns: [{ name: 'id', type: 'Int', primary: true }, { name: 'author_id', type: 'Int' }],
                relations: [{ foreignKey: 'author_id', references: 'user_id', on: 'users', type: 'many-to-one' }],
            },
        ]);
    });

    it('one-to-one when the fields are unique: @unique, @id, or a @@unique / @@id of the same fields', () => {
        const tables = tablesOf(`model User {
  id      Int      @id
  profile Profile?
  avatar  Avatar?
  badge   Badge?
  card    Card?
  posts   Post[]
}

model Profile {
  id     Int  @id
  userId Int  @unique
  user   User @relation(fields: [userId], references: [id])
}

model Avatar {
  userId Int  @id
  user   User @relation(fields: [userId], references: [id])
}

model Badge {
  id     Int  @id
  userId Int
  user   User @relation(fields: [userId], references: [id])
  @@unique([userId])
}

model Card {
  userId Int
  kind   Int
  user   User @relation(fields: [userId], references: [id])
  @@id([userId])
}

model Post {
  id     Int  @id
  userId Int
  user   User @relation(fields: [userId], references: [id])
  @@unique([userId, id])
}
`);
        assert.deepEqual(tables.slice(1).map(t => [t.table, t.relations.map(r => r.type)]), [
            ['Profile', ['one-to-one']],
            ['Avatar', ['one-to-one']],
            ['Badge', ['one-to-one']],
            ['Card', ['one-to-one']],
            ['Post', ['many-to-one']],
        ]);
    });

    it('composite foreign keys: one relation per column', () => {
        const tables = tablesOf(`model Order {
  tenant Int
  number Int
  lines  Line[]
  @@id([tenant, number])
}

model Line {
  id          Int   @id
  orderTenant Int
  orderNumber Int   @map("order_no")
  order       Order @relation(fields: [orderTenant, orderNumber], references: [tenant, number])
}
`);
        assert.deepEqual(tables[1].relations, [
            { foreignKey: 'orderTenant', references: 'tenant', on: 'Order', type: 'many-to-one' },
            { foreignKey: 'order_no', references: 'number', on: 'Order', type: 'many-to-one' },
        ]);
    });

    it('referential actions: onDelete and onUpdate as declared, else the ones prisma migrate writes', () => {
        const body = `model User {
  id    Int    @id
  a     A[]
  b     B[]
  c     C[]
}

model A {
  id     Int  @id
  userId Int
  user   User @relation(fields: [userId], references: [id])
}

model B {
  id     Int   @id
  userId Int?
  user   User? @relation(fields: [userId], references: [id])
}

model C {
  id     Int  @id
  userId Int
  user   User @relation(fields: [userId], references: [id], onDelete: Cascade, onUpdate: NoAction)
}
`;
        const actions = (provider) => tablesOf(body, { details: true }, provider).slice(1).map(t => [t.table, t.relations[0].onDelete, t.relations[0].onUpdate]);
        assert.deepEqual(actions('postgresql'), [['A', 'restrict', 'cascade'], ['B', 'set null', 'cascade'], ['C', 'cascade', 'no action']]);
        assert.deepEqual(actions('mysql'), [['A', 'restrict', 'cascade'], ['B', 'set null', 'cascade'], ['C', 'cascade', 'no action']]);
        // SQL Server has no RESTRICT
        assert.deepEqual(actions('sqlserver'), [['A', 'no action', 'cascade'], ['B', 'set null', 'cascade'], ['C', 'cascade', 'no action']]);
        // Every action, lower case
        const declared = tablesOf(body.replace('onDelete: Cascade, onUpdate: NoAction', 'onDelete: SetDefault, onUpdate: SetNull').replace('references: [id])\n}\n\nmodel B', 'references: [id], onDelete: Restrict)\n}\n\nmodel B'), { details: true });
        assert.deepEqual(declared.slice(1).map(t => [t.relations[0].onDelete, t.relations[0].onUpdate]), [['restrict', 'cascade'], ['set null', 'cascade'], ['set default', 'set null']]);
    });

    it('implicit many-to-many: Prisma\'s join table _AToB on the first model by name, its column A referencing the id; @relation("Name") gives _Name', () => {
        const tables = tablesOf(`model Post {
  id     Int        @id
  tags   Tag[]
  labels Category[] @relation("labelled")
}

model Tag {
  key   String @id @map("tag_key")
  posts Post[]
  @@map("tags")
}

model Category {
  id    Int    @id
  posts Post[] @relation("labelled")
}
`, { details: true });
        assert.deepEqual(tables.map(t => [t.table, t.relations]), [
            ['Post', [{ foreignKey: 'A', references: 'id', on: 'tags', type: 'many-to-many', via: '_PostToTag', onDelete: 'cascade', onUpdate: 'cascade' }]],
            ['tags', []],
            ['Category', [{ foreignKey: 'A', references: 'id', on: 'Post', type: 'many-to-many', via: '_labelled', onDelete: 'cascade', onUpdate: 'cascade' }]],
        ]);
        // The model names, not the table names, and in byte order (upper case first)
        assert.deepEqual(tablesOf('model zebra {\n  id Int @id\n  apes Ape[]\n}\n\nmodel Ape {\n  id String @id\n  zebras zebra[]\n  @@map("apes")\n}\n')[1].relations,
            [{ foreignKey: 'A', references: 'id', on: 'zebra', type: 'many-to-many', via: '_ApeTozebra' }]);
    });

    it('self relations: one-to-many, one-to-one and many-to-many', () => {
        const tables = tablesOf(`model User {
  id          Int    @id
  managerId   Int?
  manager     User?  @relation("team", fields: [managerId], references: [id])
  reports     User[] @relation("team")
  successorId Int?   @unique
  successor   User?  @relation("history", fields: [successorId], references: [id])
  predecessor User?  @relation("history")
  followers   User[] @relation("follows")
  following   User[] @relation("follows")
}
`);
        assert.deepEqual(tables[0].relations, [
            { foreignKey: 'managerId', references: 'id', on: 'User', type: 'many-to-one' },
            { foreignKey: 'successorId', references: 'id', on: 'User', type: 'one-to-one' },
            { foreignKey: 'A', references: 'id', on: 'User', type: 'many-to-many', via: '_follows' },
        ]);
    });

    it('SQL Server: the join table of a self many-to-many does not cascade (cycles), the others do', () => {
        const tables = tablesOf(`model User {
  id        Int     @id
  followers User[]  @relation("follows")
  following User[]  @relation("follows")
  groups    Group[]
}

model Group {
  id    Int    @id
  users User[]
}
`, { details: true }, 'sqlserver');
        assert.deepEqual(tables.map(t => t.relations.map(r => [r.via, r.onDelete, r.onUpdate])), [[['_follows', 'no action', 'no action']], [['_GroupToUser', 'cascade', 'cascade']]]);
    });

    it('the other side of a relation (a list, or an optional field without fields) has no column nor relation', () => {
        const tables = tablesOf(`model User {
  id      Int      @id
  posts   Post[]
  profile Profile?
}

model Post {
  id     Int  @id
  userId Int
  user   User @relation(fields: [userId], references: [id])
}

model Profile {
  id     Int  @id
  userId Int  @unique
  user   User @relation(fields: [userId], references: [id])
}
`);
        assert.deepEqual(tables[0], { table: 'User', columns: [{ name: 'id', type: 'Int', primary: true }], relations: [] });
    });

    it('relations to unknown models, or without a side that holds the fields: a warning', () => {
        const result = parseSchema(`model Post {
  id       Int     @id
  authorId Int
  author   Writer  @relation(fields: [authorId], references: [id])
  tags     Label[]
  users    User[]
  owner    User?
  readers  Reader[]
}

model User {
  id   Int   @id
  post Post?
}

model Reader {
  id Int @id
}
`);
        assert.deepEqual(result.tables[0].relations, [{ foreignKey: 'authorId', references: 'id', on: 'Writer', type: 'many-to-one' }]);
        assert.deepEqual(result.warnings, [
            'prisma/schema.prisma:8: Post.author: model Writer not found.',
            'prisma/schema.prisma:9: Post.tags: unknown type Label, field skipped.',
            'prisma/schema.prisma:10: Post.users: neither side of the relation has fields: [...], skipped.',
            'prisma/schema.prisma:11: Post.owner: neither side of the relation has fields: [...], skipped.',
            'prisma/schema.prisma:12: Post.readers: Reader has no field for the other side of the relation, skipped.',
            'prisma/schema.prisma:17: User.post: neither side of the relation has fields: [...], skipped.',
        ]);
    });
});

// ---------------------------------------------------------------------------------------------

describe('prisma parser: details', () => {
    const columnsOf = (body, provider) => tablesOf(body, { details: true }, provider)[0].columns;

    it('native types: the length of @db.VarChar(255), the precision and scale of @db.Decimal(10, 2), unsigned MySQL integers, nativeType', () => {
        assert.deepEqual(columnsOf(`model Thing {
  id    Int     @id @db.UnsignedInt
  name  String  @db.VarChar(191)
  code  String  @db.Char(3)
  price Decimal @db.Decimal(10,2)
  body  String  @db.LongText
  at    DateTime @db.DateTime(0)
  bin   Bytes   @db.VarBinary(16)
  small Int     @db.UnsignedSmallInt
}
`, 'mysql'), [
            { name: 'id', type: 'Int', primary: true, unsigned: true, nativeType: 'UnsignedInt' },
            { name: 'name', type: 'String', length: 191, nativeType: 'VarChar(191)' },
            { name: 'code', type: 'String', length: 3, nativeType: 'Char(3)' },
            { name: 'price', type: 'Decimal', precision: 10, scale: 2, nativeType: 'Decimal(10, 2)' },
            { name: 'body', type: 'String', nativeType: 'LongText' },
            { name: 'at', type: 'DateTime', nativeType: 'DateTime(0)' },
            { name: 'bin', type: 'Bytes', length: 16, nativeType: 'VarBinary(16)' },
            { name: 'small', type: 'Int', unsigned: true, nativeType: 'UnsignedSmallInt' },
        ]);
        assert.deepEqual(columnsOf('model T {\n  id String @id @db.NVarChar(Max)\n  geo Unsupported("point")\n}\n', 'sqlserver'), [
            { name: 'id', type: 'String', primary: true, nativeType: 'NVarChar(Max)' },
            { name: 'geo', type: 'Unsupported("point")', nativeType: 'point' },
        ]);
    });

    it('native types are prefixed with the name of the datasource: @pg.VarChar(32) for `datasource pg`', () => {
        const dir = project({ 'prisma/schema.prisma': 'datasource pg {\n  provider = "postgresql"\n}\n\nmodel Product {\n  id    Int     @id @pg.SmallInt\n  sku   String  @unique @pg.VarChar(32)\n  price Decimal @pg.Decimal(10, 2)\n  code  String  @pg.Char(3)\n  note  String  @db.Text\n}\n' });
        assert.deepEqual(parser.parse(dir, { git: false, details: true }).tables[0].columns, [
            { name: 'id', type: 'Int', primary: true, nativeType: 'SmallInt' },
            { name: 'sku', type: 'String', length: 32, unique: true, nativeType: 'VarChar(32)' },
            { name: 'price', type: 'Decimal', precision: 10, scale: 2, nativeType: 'Decimal(10, 2)' },
            { name: 'code', type: 'String', length: 3, nativeType: 'Char(3)' },
            // Prisma rejects another prefix than the datasource name: no native type
            { name: 'note', type: 'String' },
        ]);
        // Without a datasource: @db
        assert.deepEqual(parser.parse(project({ 'prisma/schema.prisma': 'model T {\n  id String @id @db.VarChar(8)\n}\n' }), { git: false, details: true }).tables[0].columns, [
            { name: 'id', type: 'String', primary: true, length: 8, nativeType: 'VarChar(8)' },
        ]);
    });

    it('@default: strings, numbers, booleans, enum values as stored, now(), dbgenerated("..."), autoincrement(), sequence(); a BigInt above 2^53 as SQL', () => {
        assert.deepEqual(columnsOf(`model Thing {
  id      Int      @id @default(autoincrement())
  name    String   @default("it's \\"new\\"")
  count   Int      @default(-3)
  ratio   Float    @default(0.5)
  big     BigInt   @default(9007199254740993)
  small   BigInt   @default(42)
  done    Boolean  @default(false)
  status  Status   @default(OPEN)
  at      DateTime @default(now())
  uuid    String   @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  data    Json     @default("[]")
}

enum Status {
  OPEN @map("open")
  CLOSED
}
`), [
            { name: 'id', type: 'Int', primary: true, autoIncrement: true },
            { name: 'name', type: 'String', default: 'it\'s "new"' },
            { name: 'count', type: 'Int', default: -3 },
            { name: 'ratio', type: 'Float', default: 0.5 },
            { name: 'big', type: 'BigInt', defaultRaw: '9007199254740993' },
            { name: 'small', type: 'BigInt', default: 42 },
            { name: 'done', type: 'Boolean', default: false },
            { name: 'status', type: 'Status', default: 'open', values: ['open', 'CLOSED'] },
            { name: 'at', type: 'DateTime', defaultRaw: 'CURRENT_TIMESTAMP' },
            { name: 'uuid', type: 'String', defaultRaw: 'gen_random_uuid()', nativeType: 'Uuid' },
            { name: 'data', type: 'Json', default: '[]' },
        ]);
        assert.deepEqual(columnsOf('model T {\n  id Int @id @default(sequence(maxValue: 10))\n}\n', 'cockroachdb'), [{ name: 'id', type: 'Int', primary: true, autoIncrement: true }]);
    });

    it('client-side values are no database default: uuid(), cuid(), nanoid(), ulid(), @updatedAt, scalar lists, Json and Bytes on MySQL', () => {
        const body = `model Thing {
  id    String   @id @default(uuid())
  a     String   @default(cuid(2))
  b     String   @default(nanoid(16))
  c     String   @default(ulid())
  at    DateTime @updatedAt
  tags  String[] @default(["a", "b"])
  data  Json     @default("{}")
  blob  Bytes    @default("")
}
`;
        assert.deepEqual(columnsOf(body.replace('  tags  String[] @default(["a", "b"])\n', ''), 'mysql'), [
            { name: 'id', type: 'String', primary: true },
            { name: 'a', type: 'String' },
            { name: 'b', type: 'String' },
            { name: 'c', type: 'String' },
            { name: 'at', type: 'DateTime' },
            { name: 'data', type: 'Json' },
            { name: 'blob', type: 'Bytes' },
        ]);
        assert.deepEqual(columnsOf(body).slice(5), [
            { name: 'tags', type: 'String[]', nullable: true },
            { name: 'data', type: 'Json', default: '{}' },
            { name: 'blob', type: 'Bytes', default: '' },
        ], 'PostgreSQL keeps the Json and Bytes defaults');
    });

    it('SQLite: an Int @id is auto-incremented, as prisma migrate writes it (INTEGER PRIMARY KEY AUTOINCREMENT)', () => {
        const tables = tablesOf('model A {\n  id Int @id\n}\n\nmodel B {\n  id BigInt @id\n}\n\nmodel C {\n  a Int\n  b Int\n  @@id([a, b])\n}\n', { details: true }, 'sqlite');
        assert.deepEqual(tables.map(t => t.columns), [
            [{ name: 'id', type: 'Int', primary: true, autoIncrement: true }],
            [{ name: 'id', type: 'BigInt', primary: true }],
            [{ name: 'a', type: 'Int', primary: true }, { name: 'b', type: 'Int', primary: true }],
        ]);
    });

    it('enum values: in the details, as stored in the database (@map), for enum lists too', () => {
        assert.deepEqual(columnsOf(`model User {
  id    Int    @id
  role  Role
  roles Role[]
}

enum Role {
  USER
  ADMIN  @map("admin") // the administrators
  @@map("user_role")
}
`), [
            { name: 'id', type: 'Int', primary: true },
            { name: 'role', type: 'Role', values: ['USER', 'admin'] },
            { name: 'roles', type: 'Role[]', nullable: true, values: ['USER', 'admin'] },
        ]);
    });

    it('@unique and a @@unique of one field give unique; @@unique, @@index and @@fulltext of several fields are indexes, named by map:', () => {
        const [table] = tablesOf(`model Post {
  id     Int    @id
  slug   String @unique(map: "slug_key")
  code   String
  title  String @map("post_title")
  body   String
  author Int
  @@unique([code])
  @@unique([author, slug], name: "authorSlug")
  @@index([title(length: 10), id(sort: Desc)], map: "title_idx", type: BTree)
  @@index(author)
  @@fulltext([title, body])
  @@map("posts")
}
`, { details: true }, 'mysql');
        assert.deepEqual(table.columns.filter(c => c.unique).map(c => c.name), ['slug', 'code']);
        assert.deepEqual(table.indexes, [
            { columns: ['author', 'slug'], type: 'unique' },
            { columns: ['post_title', 'id'], type: 'index', name: 'title_idx' },
            { columns: ['author'], type: 'index' },
            { columns: ['post_title', 'body'], type: 'fulltext' },
        ]);
    });
});

// ---------------------------------------------------------------------------------------------

describe('prisma parser: source lines, git status and unsaved editors', () => {
    const BODY = `${datasource()}model User {
  id    Int    @id
  email String @unique
  name  String?
  posts Post[]
}

model Post {
  id       Int  @id
  title    String
  authorId Int
  author   User @relation(fields: [authorId], references: [id])
}
`;
    const statuses = (result) => result.tables.map(t => [t.table, t.git, ...t.columns.map(c => `${c.name}=${c.git}`)]);

    it('source lines: the line of the model for the table, the line of each field for its column (click-to-code, the Schema view)', () => {
        const dir = project({ 'prisma/schema.prisma': BODY });
        const { tables } = parser.parse(dir, { git: false, columnSources: true });
        assert.deepEqual(tables.map(t => [t.source, ...t.columns.map(c => c.source.line)]), [
            [{ file: 'prisma/schema.prisma', line: 5 }, 6, 7, 8],
            [{ file: 'prisma/schema.prisma', line: 12 }, 13, 14, 15],
        ]);
        assert.ok(parser.parse(dir, { git: false }).tables.every(t => t.columns.every(c => c.source === undefined)));
    });

    it('git status per column and table: committed, modified, a removed field or a changed relation marks the table modified, untracked', () => {
        const dir = project({ 'prisma/schema.prisma': BODY, 'package.json': PACKAGE });
        git(dir, 'init', '-q');
        assert.deepEqual(statuses(parser.parse(dir)), [
            ['User', 'untracked', 'id=untracked', 'email=untracked', 'name=untracked'],
            ['Post', 'untracked', 'id=untracked', 'title=untracked', 'authorId=untracked'],
        ], 'no commit yet');
        commitAll(dir);
        assert.deepEqual(statuses(parser.parse(dir)), [
            ['User', 'committed', 'id=committed', 'email=committed', 'name=committed'],
            ['Post', 'committed', 'id=committed', 'title=committed', 'authorId=committed'],
        ]);
        const file = path.join(dir, 'prisma', 'schema.prisma');
        fs.writeFileSync(file, BODY
            .replace('  email String @unique\n', '  email String @unique @db.VarChar(200)\n')
            .replace('  name  String?\n', '')
            .replace('references: [id])', 'references: [id], onDelete: Cascade)'));
        assert.deepEqual(statuses(parser.parse(dir)), [
            ['User', 'modified', 'id=committed', 'email=modified'],
            ['Post', 'modified', 'id=committed', 'title=committed', 'authorId=committed'],
        ]);
        // A new file of a schema folder is untracked
        fs.rmSync(file);
        writeFiles(dir, { 'prisma/schema/schema.prisma': BODY, 'prisma/schema/tag.prisma': 'model Tag {\n  id Int @id\n}\n' });
        commitAll(dir);
        writeFiles(dir, { 'prisma/schema/label.prisma': 'model Label {\n  id Int @id\n}\n' });
        assert.deepEqual(statuses(parser.parse(dir)).map(s => s.slice(0, 2)), [['Label', 'untracked'], ['User', 'committed'], ['Post', 'committed'], ['Tag', 'committed']]);
    });

    it('a model added to a file that is in HEAD is new (untracked), with its columns, as in a new file; a model with changed fields is modified', () => {
        const dir = project({ 'prisma/schema.prisma': BODY, 'package.json': PACKAGE });
        git(dir, 'init', '-q');
        commitAll(dir);
        const file = path.join(dir, 'prisma', 'schema.prisma');
        // Inserted between two models (with a blank line in it), and appended
        fs.writeFileSync(file, `${BODY.replace('model Post {', 'model Draft {\n  id   Int @id\n\n  text String\n}\n\nmodel Post {')}\nmodel Comment {\n  id   Int    @id\n  body String\n}\n`);
        assert.deepEqual(statuses(parser.parse(dir)), [
            ['User', 'committed', 'id=committed', 'email=committed', 'name=committed'],
            ['Draft', 'untracked', 'id=untracked', 'text=untracked'],
            ['Post', 'committed', 'id=committed', 'title=committed', 'authorId=committed'],
            ['Comment', 'untracked', 'id=untracked', 'body=untracked'],
        ]);
        // A field typed in the new model, not saved yet: the model is being edited, its saved fields stay new
        const typed = fs.readFileSync(file, 'utf8').replace('  body String\n', '  body String\n  note String?\n');
        assert.deepEqual(statuses(parser.parse(dir, { overrides: new Map([[file, typed]]) })).at(-1), ['Comment', 'unsaved', 'id=untracked', 'body=untracked', 'note=unsaved']);
        // Without git: no status
        assert.deepEqual(statuses(parser.parse(dir, { git: false })).at(-1), ['Comment', undefined, 'id=undefined', 'body=undefined']);
        // Once committed, a model whose fields all change (not its model line) is modified
        commitAll(dir);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('  id   Int    @id\n  body String\n', '  id   BigInt @id\n  body Json\n'));
        assert.deepEqual(statuses(parser.parse(dir)).at(-1), ['Comment', 'modified', 'id=modified', 'body=modified']);
        // A model renamed with all its fields: a new table
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('model Comment {\n  id   BigInt @id\n  body Json\n', 'model Reply {\n  key  String @id\n  text Json\n'));
        assert.deepEqual(statuses(parser.parse(dir)).at(-1), ['Reply', 'untracked', 'key=untracked', 'text=untracked']);
    });

    it('unsaved editors: the text of the schema, of a file of the schema folder, of prisma.config.ts and of package.json is read', () => {
        const dir = project({ 'prisma/schema.prisma': BODY, 'db/main.prisma': SCHEMA.replace('User', 'Other'), 'package.json': PACKAGE, 'prisma.config.ts': 'export default {}\n' });
        git(dir, 'init', '-q');
        commitAll(dir);
        const file = path.join(dir, 'prisma', 'schema.prisma');
        const typed = BODY.replace('  name  String?\n', '  name  String?\n  bio   String?\n');
        const result = parser.parse(dir, { overrides: new Map([[file, typed]]) });
        assert.deepEqual(statuses(result), [
            ['User', 'unsaved', 'id=committed', 'email=committed', 'name=committed', 'bio=unsaved'],
            ['Post', 'committed', 'id=committed', 'title=committed', 'authorId=committed'],
        ]);
        // The schema path of an unsaved prisma.config.ts or package.json
        const config = new Map([[path.join(dir, 'prisma.config.ts'), "export default { schema: 'db/main.prisma' }\n"]]);
        assert.deepEqual(parser.parse(dir, { overrides: config, git: false }).tables.map(t => t.table), ['Other']);
        const pkg = new Map([[path.join(dir, 'package.json'), JSON.stringify({ prisma: { schema: 'db/main.prisma' } })]]);
        assert.deepEqual(parser.parse(dir, { overrides: pkg, git: false }).tables.map(t => t.table), ['Other']);
        // Unsaved without git: only the unsaved lines have a status
        const offline = parser.parse(dir, { overrides: new Map([[file, typed]]), git: false });
        assert.deepEqual(statuses(offline), [['User', 'unsaved', 'id=undefined', 'email=undefined', 'name=undefined', 'bio=unsaved'], ['Post', undefined, 'id=undefined', 'title=undefined', 'authorId=undefined']]);
    });

    it('the git cache is reused until it is cleared, git: false gives no git keys, a folder outside a repository neither, without warning', () => {
        const dir = project({ 'prisma/schema.prisma': BODY });
        git(dir, 'init', '-q');
        commitAll(dir);
        const gitCache = new Map();
        assert.equal(parser.parse(dir, { gitCache }).tables[0].git, 'committed');
        assert.equal(gitCache.size, 1);
        fs.appendFileSync(path.join(dir, 'prisma', 'schema.prisma'), '\nmodel Tag {\n  id Int @id\n}\n');
        assert.equal(parser.parse(dir, { gitCache }).tables[2].git, 'committed', 'the cache is kept');
        assert.equal(parser.parse(dir, { gitCache: new Map() }).tables[2].git, 'untracked');
        const off = parser.parse(dir, { git: false });
        assert.ok(off.tables.every(t => t.git === undefined && t.columns.every(c => c.git === undefined)));
        const outside = parser.parse(project({ 'prisma/schema.prisma': BODY }));
        assert.deepEqual(outside.warnings, []);
        assert.ok(outside.tables.every(t => t.git === undefined && t.columns.every(c => c.git === undefined)));
    });

    it('a project in a subfolder of the repository (monorepo), its schema folder read with one git call', () => {
        const root = project({ 'apps/api/prisma/schema/schema.prisma': BODY, 'apps/api/package.json': PACKAGE, 'README.md': 'monorepo' });
        git(root, 'init', '-q');
        commitAll(root);
        fs.appendFileSync(path.join(root, 'apps', 'api', 'prisma', 'schema', 'schema.prisma'), '\nmodel Tag {\n  id Int @id\n}\n');
        const result = parser.parse(path.join(root, 'apps', 'api'));
        assert.deepEqual(result.tables.map(t => [t.table, t.git, t.source.file]), [
            ['User', 'committed', 'prisma/schema/schema.prisma'],
            ['Post', 'committed', 'prisma/schema/schema.prisma'],
            ['Tag', 'untracked', 'prisma/schema/schema.prisma'],
        ]);
    });
});

// ---------------------------------------------------------------------------------------------

describe('prisma parser: warnings', () => {
    it('a line not understood, a block not closed, a model declared twice, a table mapped twice', () => {
        const result = parser.parse(project({
            'prisma/schema/a.prisma': `${datasource()}model User {
  id    Int @id
  title
  name  String @default(
  @@index([
  email String
}

model Post {
  id Int @id
`,
            'prisma/schema/b.prisma': 'model User {\n  id Int @id\n}\n\nmodel Account {\n  id Int @id\n  @@map("User")\n}\n',
        }), { git: false });
        assert.deepEqual(result.tables.map(t => [t.table, t.columns.map(c => c.name)]), [['User', ['id', 'email']], ['Post', ['id']], ['User', ['id']]]);
        assert.deepEqual(result.warnings, [
            'prisma/schema/a.prisma:13: model Post is not closed.',
            'prisma/schema/a.prisma:7: line not understood, skipped: title',
            'prisma/schema/a.prisma:8: line not understood, skipped: name  String @default(',
            'prisma/schema/a.prisma:9: line not understood, skipped: @@index([',
            'prisma/schema/b.prisma:1: model User is declared twice, skipped.',
            'Table "User" is mapped twice (prisma/schema/a.prisma and prisma/schema/b.prisma).',
        ]);
    });

    it('an Unsupported field being typed (without its complete ("...")) is skipped with a warning, it does not throw', () => {
        for (const line of ['geom Unsupported', 'geom Unsupported?', 'geom Unsupported(', 'geom Unsupported("geometry"', 'geom Unsupported("geometry', 'geom Unsupported()', 'geom Unsupported(geometry)', 'geom Unsupported(1)']) {
            const result = parseSchema(`model Place {\n  id Int @id\n  ${line}\n  name String\n}\n`, { details: true });
            assert.deepEqual(result.tables[0].columns.map(c => c.name), ['id', 'name'], line);
            assert.deepEqual(result.warnings, [`prisma/schema.prisma:7: line not understood, skipped: ${line}`], line);
        }
    });

    it('a UTF-8 BOM and CRLF line endings', () => {
        const text = `\uFEFF${datasource()}model User {\n  id   Int    @id\n  name String @default("a") // note\n}\n`.replace(/\n/g, '\r\n');
        const result = parser.parse(project({ 'prisma/schema.prisma': text }), { git: false, details: true, columnSources: true });
        assert.deepEqual(result, {
            tables: [{
                table: 'User',
                columns: [
                    { name: 'id', type: 'Int', primary: true, source: { file: 'prisma/schema.prisma', line: 6 } },
                    { name: 'name', type: 'String', source: { file: 'prisma/schema.prisma', line: 7 }, default: 'a' },
                ],
                relations: [],
                source: { file: 'prisma/schema.prisma', line: 5 },
            }],
            warnings: [],
        });
    });

    it('arguments nested 20000 times, a 100k-character line: skipped quickly, without a stack overflow', () => {
        const deep = `model A {\n  id Int @id @default(${'f('.repeat(20000)}${')'.repeat(20000)})\n  list Int @default(${'['.repeat(20000)}${']'.repeat(20000)})\n  wide${' '.repeat(100000)}Int\n  ok Int\n}\n`;
        const started = Date.now();
        const result = parseSchema(deep);
        assert.ok(Date.now() - started < 2000);
        assert.deepEqual(result.tables[0].columns.map(c => c.name), ['wide', 'ok']);
        // The line is shown up to 60 characters
        assert.deepEqual(result.warnings, [
            `prisma/schema.prisma:6: line not understood, skipped: id Int @id @default(${'f('.repeat(20)}...`,
            `prisma/schema.prisma:7: line not understood, skipped: list Int @default(${'['.repeat(42)}...`,
        ]);
    });

    it('does not depend on vscode, and never runs a file of the project', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', '..', 'parsers', 'prisma.js'), 'utf8');
        assert.doesNotMatch(source, /require\(['"]vscode['"]\)/);
        assert.doesNotMatch(source, /child_process|\beval\(|new Function|vm\.|import\(/);
    });
});

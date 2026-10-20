//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// The SQL reader (parsers/sql.js): where the SQL files are and in which order each tool applies
// them, the statements of PostgreSQL, MySQL and SQLite that create and change tables, the warnings,
// the source lines, the git status and `until`. The fixtures were applied to PostgreSQL 17, MySQL
// 8.4 and SQLite, whose catalogs gave the same tables (see test/fixtures/sql/README.md).

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const parser = require('../../parsers/sql');
const registry = require('../../parsers/registry');
const { ParserError } = require('../../parsers/errors');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'sql');
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

// Temporary project with the given files ({ 'supabase/migrations/1_init.sql': '...' })
function project(files = {}) {
    const dir = fs.mkdtempSync(path.join(TMP, 'dmdb-sql-'));
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

// SQL text replayed in a dialect, as a dump: { tables (pivot format, with the details), warnings }
const BASE = path.join(TMP, 'dmdb-sql-replay');
function replayed(text, dialect = 'postgresql', options = {}) {
    const state = parser.replay([{ path: path.join(BASE, 'schema.sql'), rel: 'schema.sql', text }], { dialect });
    return { tables: parser.toPivot(state, BASE, null, { details: true, ...options }), warnings: state.warnings };
}
const tableNamed = (tables, name) => tables.find(t => t.table === name);
// The columns of a table without their source line
const columnsOf = (text, table, dialect) => tableNamed(replayed(text, dialect).tables, table).columns;
// A table in a short form: { name: [columns], relations: ['col -> table.col'] }
const shape = (tables) => Object.fromEntries(tables.map(t => [t.table, t.columns.map(c => `${c.name}${c.nullable ? '?' : ''}${c.primary ? '*' : ''}`).join(' ')]));
const relationsOf = (tables) => tables.flatMap(t => t.relations.map(r => `${t.table}.${r.foreignKey} -> ${r.on}.${r.references} ${r.type}${r.onDelete ? ` ${r.onDelete}` : ''}${r.onUpdate ? `/${r.onUpdate}` : ''}`));
const statementsOf = (text, dialect = 'postgresql', options) => parser.scanStatements(text, dialect, options).statements.map(s => s.tokens.map(t => t.value).join(' '));

// ---------------------------------------------------------------------------------------------

describe('sql parser: real and hand-made fixtures', () => {
    // name → [folder, framework folder in it, layout]
    const FIXTURE_BASES = {
        'dbmate-testdata': ['dbmate-testdata', '', 'dbmate'],
        'drizzle-openstatus': ['drizzle-openstatus', '', 'drizzle'],
        'flyway-atala-prism': ['flyway-atala-prism', '', 'flyway'],
        'golang-migrate-examples': ['golang-migrate-examples', '', 'golang-migrate'],
        'goose-openfga-mysql': ['goose-openfga', 'assets/migrations/mysql', 'goose'],
        'goose-openfga-postgres': ['goose-openfga', 'assets/migrations/postgres', 'goose'],
        'goose-openfga-sqlite': ['goose-openfga', 'assets/migrations/sqlite', 'goose'],
        'mysql-edge-cases': ['mysql-edge-cases', '', 'flyway'],
        'mysql-sakila': ['mysql-sakila', '', 'dump'],
        'pg-dump-pagila': ['pg-dump-pagila', '', 'dump'],
        'pg-edge-cases': ['pg-edge-cases', '', 'supabase'],
        'prisma-umami': ['prisma-umami', '', 'prisma'],
        'rails-feedbin': ['rails-feedbin', '', 'rails'],
        'schema-listmonk': ['schema-listmonk', '', 'dump'],
        'sqlite-edge-cases': ['sqlite-edge-cases', '', 'golang-migrate'],
        'supabase-basejump': ['supabase-basejump', '', 'supabase'],
        'supabase-chatbot-ui': ['supabase-chatbot-ui', '', 'supabase'],
        'supabase-nextjs-subscription-payments': ['supabase-nextjs-subscription-payments', '', 'supabase'],
        'up-sql-harness': ['up-sql-harness', 'app/store/database/migrate/postgres', 'golang-migrate'],
    };
    const base = (name) => path.join(FIXTURES, FIXTURE_BASES[name][0], FIXTURE_BASES[name][1]);
    const expected = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected', `${name}.json`), 'utf8'));
    const DETAIL_KEYS = ['length', 'precision', 'scale', 'unsigned', 'default', 'defaultRaw', 'onUpdateCurrent', 'values', 'unique', 'autoIncrement', 'comment'];

    it('has the real migrations and dumps and the hand-made ones, each with its expected output', () => {
        const folders = fs.readdirSync(FIXTURES).filter(name => name !== 'expected' && fs.statSync(path.join(FIXTURES, name)).isDirectory()).sort();
        assert.deepEqual(folders, [...new Set(Object.values(FIXTURE_BASES).map(([folder]) => folder))].sort());
        assert.deepEqual(fs.readdirSync(path.join(FIXTURES, 'expected')).sort(), Object.keys(FIXTURE_BASES).map(name => `${name}.json`).sort());
    });

    for (const name of Object.keys(FIXTURE_BASES)) {
        it(`${name}: the exact tables, relations, details, lines and warnings (expected/${name}.json)`, () => {
            assert.deepEqual(parser.parse(base(name), { details: true, columnSources: true, git: false }), expected(name));
        });
    }

    it('without details nor column sources: the same tables, without them', () => {
        for (const name of Object.keys(FIXTURE_BASES)) {
            const full = expected(name);
            const without = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
            const tables = full.tables.map(table => ({
                ...without(table, ['indexes']),
                columns: table.columns.map(column => without(column, ['source', ...DETAIL_KEYS])),
                relations: table.relations.map(relation => without(relation, ['onDelete', 'onUpdate'])),
            }));
            assert.deepEqual(parser.parse(base(name), { git: false }), { tables, warnings: full.warnings }, name);
        }
    });

    it('every fixture is detected as SQL, in the layout of its tool: 45 for migrations of a tool or a Rails structure.sql, 40 for a dump or migrations in the framework folder itself', () => {
        for (const [name, [, folder, layout]] of Object.entries(FIXTURE_BASES)) {
            const score = folder || ['dump'].includes(layout) ? 40 : 45;
            assert.deepEqual(registry.detect(base(name)), { framework: 'sql', forced: false, matches: [{ id: 'sql', label: 'SQL', score }], errors: [] }, name);
            assert.equal(parser.locate(base(name)).layout.id, layout, name);
        }
    });

    it('the order of the files: Supabase by name, Flyway by version (sub-folders too), drizzle-kit by its journal, golang-migrate by number', () => {
        const files = (name) => parser.locate(base(name)).files.map(file => toPosix(path.relative(base(name), file.path)));
        assert.deepEqual(files('mysql-edge-cases'), ['db/migration/V1__init.sql', 'db/migration/V1.1__routines.sql', 'db/migration/V1_2__underscore.sql', 'db/migration/V2__changes.sql', 'db/migration/more/V3__nested.sql', 'db/migration/V10__later.sql']);
        assert.deepEqual(files('sqlite-edge-cases'), ['migrations/1_init.up.sql', 'migrations/2_redefine_posts.up.sql', 'migrations/3_seed.up.sql', 'migrations/10_alter.up.sql']);
        const journal = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'drizzle-openstatus', 'drizzle', 'meta', '_journal.json'), 'utf8'));
        assert.deepEqual(files('drizzle-openstatus'), journal.entries.map(entry => `drizzle/${entry.tag}.sql`));
        assert.equal(files('supabase-chatbot-ui').length, 25);
        assert.deepEqual(files('supabase-chatbot-ui'), [...files('supabase-chatbot-ui')].sort());
        assert.deepEqual(files('prisma-umami').slice(0, 2), ['prisma/migrations/01_init/migration.sql', 'prisma/migrations/02_report_schema_session_data/migration.sql']);
    });

    it('chatbot-ui: the tables of auth (created by Supabase) are referenced, not drawn; a 1536-dimension vector column is a vector', () => {
        const { tables } = parser.parse(base('supabase-chatbot-ui'), { git: false, details: true });
        assert.ok(!tables.some(t => t.table.startsWith('auth.')));
        assert.deepEqual(tableNamed(tables, 'profiles').relations, [{ foreignKey: 'user_id', references: 'id', on: 'auth.users', type: 'one-to-one', onDelete: 'cascade' }]);
        assert.deepEqual(tableNamed(tables, 'file_items').columns.find(c => c.name === 'openai_embedding'), { name: 'openai_embedding', type: 'vector', nullable: true });
    });

    it('the replay of prisma migrate and drizzle-kit migrations gives the tables of the schema of the same commit', () => {
        const names = (tables) => tables.map(t => t.table).sort();
        const umami = parser.parse(base('prisma-umami'), { git: false }).tables;
        const prismaUmami = require('../../parsers/prisma').parse(path.join(__dirname, '..', 'fixtures', 'prisma', 'umami'), { git: false }).tables;
        assert.deepEqual(names(umami), names(prismaUmami));
        for (const table of umami) {
            const other = tableNamed(prismaUmami, table.table);
            assert.deepEqual(table.columns.map(c => c.name).sort(), other.columns.map(c => c.name).sort(), table.table);
            assert.deepEqual(table.columns.filter(c => c.nullable).map(c => c.name).sort(), other.columns.filter(c => c.nullable).map(c => c.name).sort(), table.table);
        }
        // OpenStatus: the 95 migrations, and the schema files (which no longer declare status_reports_to_pages, still in the database)
        const openstatus = parser.parse(base('drizzle-openstatus'), { git: false }).tables;
        const drizzle = require('../../parsers/drizzle').parse(path.join(__dirname, '..', 'fixtures', 'drizzle', 'openstatus'), { git: false }).tables;
        assert.deepEqual(names(openstatus), [...names(drizzle), 'status_reports_to_pages'].sort());
        for (const table of drizzle) {
            const other = tableNamed(openstatus, table.table);
            assert.deepEqual(other.columns.map(c => `${c.name}${c.nullable ? '?' : ''}`).sort(), table.columns.map(c => `${c.name}${c.nullable ? '?' : ''}`).sort(), table.table);
        }
    });
});

const toPosix = (filePath) => filePath.split(path.sep).join('/');

// ---------------------------------------------------------------------------------------------

describe('sql parser: statements', () => {
    it('semicolons end the statements, not those of strings, quoted names, comments and dollar-quoted bodies', () => {
        assert.deepEqual(statementsOf("CREATE TABLE a (b text DEFAULT 'x;y''z');\n-- c; d\n/* e; /* nested; */ f; */\nSELECT \"g;h\", $$i;j$$, $tag$k $$ ; $tag$;\nSELECT E'l\\';m';"), [
            'CREATE TABLE a ( b text DEFAULT x;y\'z )',
            'SELECT g;h , i;j , k $$ ; ',
            'SELECT l\';m',
        ]);
        // Without the last semicolon, and a statement of a single comment
        assert.deepEqual(statementsOf('CREATE TABLE a (id int)\n/* only a comment */'), ['CREATE TABLE a ( id int )']);
        assert.deepEqual(statementsOf(''), []);
    });

    it('MySQL: backslash escapes and double quotes in strings, backticks, # comments, block comments that do not nest, DELIMITER', () => {
        assert.deepEqual(statementsOf("SELECT 'a\\';b', \"c;d\", `e;f`; # g; h\nSELECT /* /* */ 1;\nDELIMITER ;;\nCREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; END ;;\nDELIMITER ;\nSELECT 2;", 'mysql'), [
            'SELECT a\';b , c;d , e;f',
            'SELECT 1',
            'CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW . a = 1 ; END',
            'SELECT 2',
        ]);
        // On PostgreSQL, a column named delimiter at the start of a line is a column
        assert.deepEqual(statementsOf('CREATE TABLE a (\ndelimiter text\n);'), ['CREATE TABLE a ( delimiter text )']);
    });

    it('MySQL executable comments are code for the versions up to 8.4 (/*!50705 ... */), other comments are comments', () => {
        assert.deepEqual(statementsOf('/*!40101 SET NAMES utf8 */;\nCREATE TABLE a (b point /*!80003 SRID 0 */ /*!50705 NOT NULL,*/ c int /*!90000 INVISIBLE */);\n/*!99999 SELECT 1 */;', 'mysql'), [
            'SET NAMES utf8',
            'CREATE TABLE a ( b point SRID 0 NOT NULL , c int )',
        ]);
        assert.deepEqual(statementsOf('/*!40101 SET NAMES utf8 */;\nSELECT 1;'), ['SELECT 1'], 'a comment on PostgreSQL');
    });

    it('psql: its backslash commands are skipped, and the data of COPY ... FROM stdin up to \\.', () => {
        const text = "\\restrict abc\nSET a = 1;\nCOPY public.t (a, b) FROM stdin;\n1\tx; CREATE TABLE no (id int);\n2\t'y\n\\.\nCREATE TABLE yes (id int);\n\\unrestrict abc\n";
        const { statements } = parser.scanStatements(text, 'postgresql');
        assert.deepEqual(statements.map(s => s.tokens.map(t => t.value).join(' ')), ['SET a = 1', 'COPY public . t ( a , b ) FROM stdin', 'CREATE TABLE yes ( id int )']);
        assert.equal(text.slice(statements[1].copy.start, statements[1].copy.end), "1\tx; CREATE TABLE no (id int);\n2\t'y\n");
    });

    it('the bodies of triggers and routines without a DELIMITER (SQLite, BEGIN ATOMIC), with their CASE and END IF', () => {
        assert.deepEqual(statementsOf('CREATE TRIGGER t AFTER UPDATE ON a BEGIN UPDATE a SET b = CASE WHEN 1 THEN 2 END; INSERT INTO c VALUES (1); END;\nCREATE TABLE d (id int);', 'sqlite'), [
            'CREATE TRIGGER t AFTER UPDATE ON a BEGIN UPDATE a SET b = CASE WHEN 1 THEN 2 END ; INSERT INTO c VALUES ( 1 ) ; END',
            'CREATE TABLE d ( id int )',
        ]);
        assert.deepEqual(statementsOf('CREATE PROCEDURE p() BEGIN IF x THEN SELECT 1; END IF; LOOP SELECT 2; END LOOP; END;\nBEGIN;\nCREATE TABLE e (id int);\nCOMMIT;', 'mysql').map(s => s.split(' ')[0] + ' ' + s.split(' ').slice(-1)[0]), [
            'CREATE END', 'BEGIN BEGIN', 'CREATE )', 'COMMIT COMMIT',
        ]);
        assert.deepEqual(statementsOf('CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END;\nSELECT 3;'), ['CREATE FUNCTION f ( ) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1 ; SELECT 2 ; END', 'SELECT 3']);
    });

    it('the up sections of dbmate, goose (with StatementBegin) and node-pg-migrate, and the breakpoints of drizzle-kit', () => {
        assert.deepEqual(statementsOf('CREATE TABLE before (id int);\n-- migrate:up\nCREATE TABLE a (id int);\n-- migrate:down\nDROP TABLE a;\n', 'postgresql', { sections: 'dbmate' }), ['CREATE TABLE a ( id int )']);
        assert.deepEqual(statementsOf('-- +goose Up\n-- +goose StatementBegin\nCREATE FUNCTION f() RETURNS int AS \'SELECT 1; SELECT 2\' LANGUAGE sql; SELECT 3;\n-- +goose StatementEnd\nCREATE TABLE b (id int);\n-- +goose Down\nDROP TABLE b;', 'postgresql', { sections: 'goose' }), [
            'CREATE FUNCTION f ( ) RETURNS int AS SELECT 1; SELECT 2 LANGUAGE sql ; SELECT 3 ;',
            'CREATE TABLE b ( id int )',
        ]);
        assert.deepEqual(statementsOf('-- Up Migration\nCREATE TABLE c (id int);\n-- Down Migration\nDROP TABLE c;', 'postgresql', { sections: 'pgmigrate' }), ['CREATE TABLE c ( id int )']);
        assert.deepEqual(statementsOf('CREATE TABLE `d` (`id` integer)\n--> statement-breakpoint\nCREATE INDEX `e` ON `d` (`id`);', 'sqlite'), ['CREATE TABLE d ( id integer )', 'CREATE INDEX e ON d ( id )']);
    });

    it('a string, a quoted name, a comment or a dollar-quoted body not closed: the end of the file is skipped, told with its line', () => {
        const problems = (text, dialect) => parser.scanStatements(text, dialect).problems.map(p => `${text.slice(0, p.offset).split('\n').length}: ${p.message}`);
        assert.deepEqual(problems("SELECT 1;\nSELECT 'never", 'postgresql'), ['2: string not closed: the end of the file is skipped.']);
        assert.deepEqual(problems('SELECT 1;\n\nSELECT "never', 'postgresql'), ['3: quoted name not closed: the end of the file is skipped.']);
        assert.deepEqual(problems('/* never', 'mysql'), ['1: comment not closed: the end of the file is skipped.']);
        assert.deepEqual(problems('SELECT 1;\nDO $body$ never', 'postgresql'), ['2: dollar-quoted text ($body$) not closed: the end of the file is skipped.']);
    });

    it('the dialect of SQL files, from what only one dialect writes', () => {
        assert.equal(parser.sniffDialect(['CREATE TABLE `a` (id int AUTO_INCREMENT) ENGINE=InnoDB;']), 'mysql');
        assert.equal(parser.sniffDialect(['CREATE TABLE a (id integer PRIMARY KEY AUTOINCREMENT);']), 'sqlite');
        assert.equal(parser.sniffDialect(["CREATE TABLE a (id serial, b text DEFAULT ''::text);"]), 'postgresql');
        assert.equal(parser.sniffDialect(['CREATE TABLE a (id int);']), 'unknown');
    });

    it('data statements (INSERT, REPLACE) that skipData skips are not read past their first tokens, their strings and comments still ending them; each statement is given as soon as it is read', () => {
        const text = [
            'CREATE TABLE a (id int);',
            "INSERT INTO a VALUES (1, 'x;y', E'z\\';', $$w;$$, \"q;\"), (2, 'it''s -- not a comment; /* nor */');",
            'insert into a values (3);INSERT INTO a VALUES (4) -- c;',
            ';',
            'REPLACE INTO a SELECT 1 /* ; */;',
            'CREATE TABLE b (id int);',
            "INSERT INTO migrations VALUES (1, 'm;');",
            "INSERT INTO a VALUES ('never",
        ].join('\n');
        const scan = (skipData) => {
            const read = [];
            const asked = [];
            const result = parser.scanStatements(text, 'postgresql', {
                skipData: (tokens) => {
                    asked.push(tokens.length);
                    return skipData(tokens);
                },
                onStatement: (statement) => read.push(statement.tokens.map(t => t.value).join(' ')),
            });
            return { read, asked, statements: result.statements, problems: result.problems.map(p => `${text.slice(0, p.offset).split('\n').length}: ${p.message}`) };
        };
        // The rows of migrations are read, as for the schema dump of Laravel
        const byName = scan((tokens) => (tokens.length < 3 ? null : tokens[2].value !== 'migrations'));
        assert.deepEqual(byName.read, ['CREATE TABLE a ( id int )', 'INSERT INTO a', 'insert into a', 'INSERT INTO a', 'REPLACE INTO a', 'CREATE TABLE b ( id int )', 'INSERT INTO migrations VALUES ( 1 , m; )', 'INSERT INTO a never']);
        assert.deepEqual(byName.statements, [], 'given to onStatement, not kept');
        assert.deepEqual(byName.problems, ['8: string not closed: the end of the file is skipped.']);
        assert.ok(Math.max(...byName.asked) <= 3, 'asked on the first tokens only');
        // Skipped at their first word: the data statements that follow one another are passed over at once
        const all = scan(() => true);
        assert.deepEqual(all.read, ['CREATE TABLE a ( id int )', 'INSERT', 'CREATE TABLE b ( id int )', 'INSERT never']);
        assert.deepEqual(all.problems, byName.problems);
        // Without skipData, the same statements in full
        assert.deepEqual(statementsOf(text).filter(s => !/^(?:INSERT|insert|REPLACE)/.test(s)), ['CREATE TABLE a ( id int )', 'CREATE TABLE b ( id int )']);
        // MySQL: backslashes, double-quoted strings, # comments and a DELIMITER
        const mysql = "INSERT INTO `t` VALUES ('a\\';b', \"c\\\";d\", 'e'); # f;\nDELIMITER ;;\nINSERT INTO t VALUES ('g;');;\nCREATE TABLE `u` (id int);;\nDELIMITER ;\nCREATE TABLE v (id int);";
        const read = [];
        parser.scanStatements(mysql, 'mysql', { skipData: () => true, onStatement: (statement) => read.push(statement.tokens.map(t => t.value).join(' ')) });
        assert.deepEqual(read, ['INSERT', 'INSERT', 'CREATE TABLE u ( id int )', 'CREATE TABLE v ( id int )']);
    });
});

// ---------------------------------------------------------------------------------------------

describe('sql parser: where the SQL files are, in the order of each tool', () => {
    const TABLE = (name) => `CREATE TABLE ${name} (id int);\n`;
    const layoutOf = (dir) => {
        const location = parser.locate(dir, { any: true });
        return location && { layout: location.layout.id, files: location.files.map(file => toPosix(path.relative(dir, file.path))) };
    };
    const tables = (dir, options) => parser.parse(dir, { git: false, ...options }).tables.map(t => t.table);

    it('Supabase: supabase/migrations/<timestamp>_<name>.sql by name; the CLI skips the other files, with a warning', () => {
        const dir = project({
            'supabase/migrations/20240102000000_b.sql': TABLE('b'),
            'supabase/migrations/20240101000000_a.sql': TABLE('a'),
            'supabase/migrations/init.sql': TABLE('skipped'),
            'supabase/migrations/notes.md': '# not SQL',
            'supabase/seed.sql': "INSERT INTO a VALUES (1);\n",
        });
        assert.deepEqual(layoutOf(dir), { layout: 'supabase', files: ['supabase/migrations/20240101000000_a.sql', 'supabase/migrations/20240102000000_b.sql'] });
        assert.deepEqual(parser.parse(dir, { git: false }), {
            tables: [
                { table: 'a', columns: [{ name: 'id', type: 'int', nullable: true }], relations: [], source: { file: 'supabase/migrations/20240101000000_a.sql', line: 1 } },
                { table: 'b', columns: [{ name: 'id', type: 'int', nullable: true }], relations: [], source: { file: 'supabase/migrations/20240102000000_b.sql', line: 1 } },
            ],
            warnings: ['supabase/migrations/init.sql: skipped, as the Supabase CLI does: a migration is named <timestamp>_<name>.sql.'],
        });
        assert.equal(parser.detect(dir), 45);
    });

    it('Flyway: V<version>__<name>.sql by version (1.1 and 1_1 are the same, 10 after 2), in sub-folders too; repeatable and undo migrations are not replayed', () => {
        for (const folder of ['src/main/resources/db/migration', 'db/migration', 'sql']) {
            const dir = project({
                [`${folder}/V10__j.sql`]: TABLE('j'),
                [`${folder}/V2__b.sql`]: TABLE('b'),
                [`${folder}/V1__a.sql`]: TABLE('a'),
                [`${folder}/V1_1__a1.sql`]: TABLE('a1'),
                [`${folder}/V1.2.1__a21.sql`]: TABLE('a21'),
                [`${folder}/later/V3__c.sql`]: TABLE('c'),
                [`${folder}/R__views.sql`]: TABLE('repeatable'),
                [`${folder}/U2__undo.sql`]: TABLE('undo'),
                [`${folder}/v4__lower_case.sql`]: TABLE('lower'),
            });
            assert.deepEqual(tables(dir), ['a', 'a1', 'a21', 'b', 'c', 'j'], folder);
            assert.equal(parser.detect(dir), 45, folder);
        }
    });

    it('Flyway: a schema written as a placeholder (${schema}.users) is the default one, the other placeholders are left as they are', () => {
        const dir = project({
            'db/migration/V1__init.sql': `CREATE TABLE \${schema}.users (id int primary key, name text);
CREATE TABLE posts (id int primary key, user_id int references \${schema}.users(id));
CREATE TABLE "\${flyway:defaultSchema}".tags (id int primary key);
CREATE TABLE \${flyway:defaultSchema}.post_tags (post_id int references posts(id), tag_id int references tags(id), primary key (post_id, tag_id));
GRANT SELECT ON posts TO \${reader};
CREATE TABLE \${table} (id int);`,
        });
        const { tables, warnings } = parser.parse(dir, { git: false, columnSources: true });
        // As PostgreSQL 17 has them once Flyway gives the placeholders the value public
        assert.deepEqual(shape(tables), { users: 'id* name?', posts: 'id* user_id?', tags: 'id*', post_tags: 'post_id* tag_id*' });
        assert.deepEqual(relationsOf(tables), ['posts.user_id -> users.id many-to-one', 'post_tags.post_id -> posts.id many-to-one', 'post_tags.tag_id -> tags.id many-to-one']);
        assert.deepEqual(tableNamed(tables, 'posts').columns[1].source, { file: 'db/migration/V1__init.sql', line: 2 });
        assert.deepEqual(warnings, ['db/migration/V1__init.sql:6: CREATE TABLE not understood, skipped: CREATE TABLE ${table} (id int)']);
        // Only Flyway replaces them
        assert.deepEqual(Object.keys(shape(replayed('CREATE TABLE ${schema}.users (id int);').tables)), []);
    });

    it('Flyway: a folder reached through symbolic links is read once, and a link back to a parent folder is not followed', () => {
        const dir = project({ 'db/migration/V1__a.sql': TABLE('a'), 'shared/V2__b.sql': TABLE('b') });
        // 'junction': a link to a folder that Windows creates without the administrator rights
        fs.symlinkSync(path.join(dir, 'db'), path.join(dir, 'db', 'migration', 'loop'), 'junction');
        fs.symlinkSync(path.join(dir, 'shared'), path.join(dir, 'db', 'migration', 'common'), 'junction');
        fs.symlinkSync(path.join(dir, 'shared'), path.join(dir, 'db', 'migration', 'common-again'), 'junction');
        assert.deepEqual(layoutOf(dir), { layout: 'flyway', files: ['db/migration/V1__a.sql', 'db/migration/common/V2__b.sql'] });
        assert.deepEqual(parser.parse(dir, { git: false }).warnings, [], 'no migration replayed twice');
        assert.deepEqual(tables(dir), ['a', 'b']);
    });

    it('dbmate: db/migrations with -- migrate:up, by name, only the up section; without the markers, the files are numbered migrations', () => {
        const dbmate = project({
            'db/migrations/20240102000000_b.sql': '-- migrate:up\nCREATE TABLE b (id int);\n\n-- migrate:down\nDROP TABLE a;\n',
            'db/migrations/20240101000000_a.sql': '-- migrate:up transaction:false\nCREATE TABLE a (id int);\n-- migrate:down\nDROP TABLE a;\n',
            'db/schema.sql': TABLE('dumped'),
        });
        assert.deepEqual(layoutOf(dbmate).layout, 'dbmate');
        assert.deepEqual(tables(dbmate), ['a', 'b']);
        const numbered = project({ 'db/migrations/002_b.sql': TABLE('b'), 'db/migrations/001_a.sql': TABLE('a'), 'db/migrations/001_a.down.sql': 'DROP TABLE a;\n' });
        assert.deepEqual(layoutOf(numbered), { layout: 'migrations', files: ['db/migrations/001_a.sql', 'db/migrations/002_b.sql'] });
    });

    it('golang-migrate: <version>_<name>.up.sql by version number, the down files left out; _up.sql too', () => {
        const dir = project({
            'migrations/10_j.up.sql': TABLE('j'),
            'migrations/10_j.down.sql': 'DROP TABLE j;\n',
            'migrations/2_b.up.sql': TABLE('b'),
            'migrations/1_a.up.sql': TABLE('a'),
            'migrations/3_c_up.sql': TABLE('c'),
            'migrations/3_c_down.sql': 'DROP TABLE c;\n',
        });
        assert.deepEqual(layoutOf(dir), { layout: 'golang-migrate', files: ['migrations/1_a.up.sql', 'migrations/2_b.up.sql', 'migrations/3_c_up.sql', 'migrations/10_j.up.sql'] });
        assert.deepEqual(tables(dir), ['a', 'b', 'c', 'j']);
    });

    it('goose: -- +goose Up sections, by version number; also in sql/schema (sqlc)', () => {
        const dir = project({
            'sql/schema/10_j.sql': '-- +goose Up\nCREATE TABLE j (id int);\n-- +goose Down\nDROP TABLE j;\n',
            'sql/schema/2_b.sql': '-- +goose Up\n-- +goose StatementBegin\nCREATE TABLE b (id int);\n-- +goose StatementEnd\n',
        });
        assert.deepEqual(layoutOf(dir), { layout: 'goose', files: ['sql/schema/2_b.sql', 'sql/schema/10_j.sql'] });
        assert.deepEqual(tables(dir), ['b', 'j']);
    });

    it('diesel: migrations/<version>_<name>/up.sql by folder name', () => {
        const dir = project({
            'migrations/2024-01-02-000000_b/up.sql': TABLE('b'),
            'migrations/2024-01-02-000000_b/down.sql': 'DROP TABLE b;\n',
            'migrations/00000000000000_diesel_initial_setup/up.sql': TABLE('setup'),
            'diesel.toml': '',
        });
        assert.deepEqual(layoutOf(dir), { layout: 'diesel', files: ['migrations/00000000000000_diesel_initial_setup/up.sql', 'migrations/2024-01-02-000000_b/up.sql'] });
    });

    it('prisma migrate: prisma/migrations/<name>/migration.sql by name, in the dialect of migration_lock.toml; read when Prisma itself is not detected, or when the framework is set to sql', () => {
        const files = {
            'prisma/migrations/20240102000000_b/migration.sql': 'CREATE TABLE "B" ("id" TEXT NOT NULL PRIMARY KEY);\n',
            'prisma/migrations/20240101000000_a/migration.sql': 'CREATE TABLE "A" ("id" TEXT NOT NULL PRIMARY KEY, "x" TEXT PRIMARY KEY);\n',
            'prisma/migrations/migration_lock.toml': 'provider = "sqlite"\n',
        };
        const migrationsOnly = project(files);
        assert.equal(parser.detect(migrationsOnly), 45);
        assert.equal(parser.locate(migrationsOnly).dialect, 'sqlite');
        assert.deepEqual(tables(migrationsOnly), ['A', 'B']);
        const prismaProject = project({ ...files, 'prisma/schema.prisma': 'datasource db {\n  provider = "sqlite"\n}\n', 'package.json': JSON.stringify({ devDependencies: { prisma: '^7.10.1' } }) });
        assert.equal(parser.detect(prismaProject), 0, 'the output of the Prisma project');
        assert.deepEqual(registry.detect(prismaProject).matches.map(match => match.id), ['prisma']);
        assert.deepEqual(registry.detect(prismaProject, { framework: 'sql' }), { framework: 'sql', forced: true, matches: [], errors: [] });
        assert.deepEqual(tables(prismaProject), ['A', 'B'], 'the history of the Prisma project, when sql is chosen');
        // A folder named migrations is prisma migrate's with its lock file only
        assert.equal(parser.locate(project({ 'migrations/1_a/migration.sql': TABLE('a') })), null);
        assert.equal(parser.locate(project({ 'migrations/1_a/migration.sql': TABLE('a'), 'migrations/migration_lock.toml': 'provider = "postgresql"\n' })).layout.id, 'prisma');
    });

    it('drizzle-kit: the order of its journal (meta/_journal.json), not of the names; its 1.0 folders; read when Drizzle itself is not detected', () => {
        const journal = { version: '7', dialect: 'mysql', entries: [{ idx: 0, tag: '0001_second' }, { idx: 1, tag: '0000_first' }] };
        const files = {
            'drizzle/0000_first.sql': 'CREATE TABLE `first` (`id` int);\n',
            'drizzle/0001_second.sql': 'CREATE TABLE `second` (`id` int);\n',
            'drizzle/0002_not_in_journal.sql': TABLE('ignored'),
            'drizzle/meta/_journal.json': JSON.stringify(journal),
        };
        const dir = project(files);
        assert.deepEqual(layoutOf(dir), { layout: 'drizzle', files: ['drizzle/0001_second.sql', 'drizzle/0000_first.sql'] });
        assert.equal(parser.locate(dir).dialect, 'mysql');
        // Without a journal: the 0000_name.sql files of drizzle/; drizzle-kit 1.0: a folder per migration with its snapshot
        assert.deepEqual(layoutOf(project({ 'drizzle/0001_b.sql': TABLE('b'), 'drizzle/0000_a.sql': TABLE('a') })).files, ['drizzle/0000_a.sql', 'drizzle/0001_b.sql']);
        const v1 = project({ 'drizzle/20240102000000_b/migration.sql': TABLE('b'), 'drizzle/20240102000000_b/snapshot.json': '{"dialect":"postgresql"}', 'drizzle/20240101000000_a/migration.sql': TABLE('a'), 'drizzle/20240101000000_a/snapshot.json': '{"dialect":"postgresql"}' });
        assert.deepEqual(layoutOf(v1), { layout: 'drizzle', files: ['drizzle/20240101000000_a/migration.sql', 'drizzle/20240102000000_b/migration.sql'] });
        assert.equal(parser.locate(v1).dialect, 'postgresql');
        // Another out folder needs the journal
        assert.equal(layoutOf(project({ 'src/db/migrations/0000_a.sql': TABLE('a') })), null);
        assert.equal(layoutOf(project({ 'src/db/migrations/0000_a.sql': TABLE('a'), 'src/db/migrations/meta/_journal.json': JSON.stringify({ entries: [{ idx: 0, tag: '0000_a' }] }) })).layout, 'drizzle');
        // A Drizzle project: its output is not plain SQL
        const drizzleProject = project({ ...files, 'drizzle.config.ts': "export default { dialect: 'mysql', schema: './schema.ts' };\n", 'schema.ts': "import { mysqlTable, int } from 'drizzle-orm/mysql-core';\nexport const first = mysqlTable('first', { id: int() });\n" });
        assert.equal(parser.detect(drizzleProject), 0);
        assert.deepEqual(registry.detect(drizzleProject).matches.map(match => match.id), ['drizzle']);
    });

    it('a dump: Rails db/structure.sql (45), schema.sql, structure.sql, dump.sql... at the root, then in db/ (40)', () => {
        assert.deepEqual(layoutOf(project({ 'db/structure.sql': TABLE('a'), 'db/schema.rb': '' })), { layout: 'rails', files: ['db/structure.sql'] });
        assert.equal(parser.detect(project({ 'db/structure.sql': TABLE('a') })), 45);
        for (const name of ['schema.sql', 'structure.sql', 'database.sql', 'dump.sql', 'db.sql', 'init.sql', 'db/schema.sql', 'db/dump.sql', 'sql/schema.sql']) {
            const dir = project({ [name]: TABLE('a') });
            assert.deepEqual(layoutOf(dir), { layout: 'dump', files: [name] }, name);
            assert.equal(parser.detect(dir), 40, name);
        }
        assert.deepEqual(layoutOf(project({ 'schema.sql': TABLE('root'), 'db/schema.sql': TABLE('db') })).files, ['schema.sql']);
        // Migrations win over a dump of the same project
        assert.equal(layoutOf(project({ 'supabase/migrations/1_a.sql': TABLE('a'), 'schema.sql': TABLE('b') })).layout, 'supabase');
    });

    it('migrations directly in the framework folder (40); any .sql file of it when the framework is set to sql (not detected)', () => {
        const folder = project({ '001_a.sql': TABLE('a'), '002_b.sql': TABLE('b'), 'README.md': '' });
        assert.deepEqual(layoutOf(folder), { layout: 'migrations', files: ['001_a.sql', '002_b.sql'] });
        assert.equal(parser.detect(folder), 40);
        const loose = project({ 'tables.sql': TABLE('a'), 'more.sql': TABLE('b') });
        assert.equal(parser.detect(loose), 0);
        assert.deepEqual(layoutOf(loose), { layout: 'files', files: ['more.sql', 'tables.sql'] });
        assert.deepEqual(tables(loose), ['b', 'a']);
    });

    it('nothing to read: an error that names the places looked for; the sources are every one of them, inside the folder', () => {
        const dir = project({ 'README.md': '' });
        assert.equal(parser.detect(dir), 0);
        assert.throws(() => parser.parse(dir), (err) => err instanceof ParserError && err.message === `No SQL files found in ${dir}: DrawMeDatabase reads the migrations of supabase/migrations, Flyway (db/migration/V1__*.sql), dbmate, golang-migrate (*.up.sql), goose, diesel, prisma migrate or drizzle-kit, Rails' db/structure.sql, or a dump (schema.sql, structure.sql...) at the root or in db/.`);
        const sources = registry.getSources('sql', dir);
        assert.ok(sources.folders.some(folder => folder.path === path.join(dir, 'supabase', 'migrations')));
        assert.ok(sources.folders.some(folder => folder.path === path.join(dir, 'db', 'migration') && folder.recursive));
        assert.ok(sources.files.includes(path.join(dir, 'db', 'structure.sql')) && sources.files.includes(path.join(dir, 'schema.sql')));
        assert.ok([...sources.folders.map(folder => folder.path), ...sources.files].every(item => item.startsWith(dir + path.sep)));
        assert.deepEqual(sources.extensions, ['.sql']);
        assert.equal(parser.detect(path.join(dir, 'missing')), 0);
        assert.equal(parser.detect(''), 0);
        assert.equal(parser.detect(undefined), 0);
    });

    it('the sources: the folder of the migrations (its sub-folders for Flyway and the migrations in folders), the lock file or journal, or the dump', () => {
        const at = (dir, ...parts) => path.join(dir, ...parts);
        const supabase = project({ 'supabase/migrations/1_a.sql': TABLE('a') });
        assert.deepEqual(registry.getSources('sql', supabase), { folders: [{ path: at(supabase, 'supabase', 'migrations'), recursive: false }], files: [], extensions: ['.sql'] });
        const flyway = project({ 'db/migration/V1__a.sql': TABLE('a') });
        assert.deepEqual(registry.getSources('sql', flyway).folders, [{ path: at(flyway, 'db', 'migration'), recursive: true }]);
        const prisma = project({ 'prisma/migrations/1_a/migration.sql': TABLE('a') });
        assert.deepEqual(registry.getSources('sql', prisma), { folders: [{ path: at(prisma, 'prisma', 'migrations'), recursive: true }], files: [at(prisma, 'prisma', 'migrations', 'migration_lock.toml')], extensions: ['.sql'] });
        const drizzle = project({ 'drizzle/0000_a.sql': TABLE('a') });
        assert.deepEqual(registry.getSources('sql', drizzle).files, [at(drizzle, 'drizzle', 'meta', '_journal.json')]);
        const dump = project({ 'db/structure.sql': TABLE('a') });
        assert.deepEqual(registry.getSources('sql', dump), { folders: [], files: [at(dump, 'db', 'structure.sql')], extensions: ['.sql'] });
        assert.deepEqual(registry.watchPatterns(registry.getSources('sql', flyway)), [{ base: at(flyway, 'db', 'migration'), pattern: '**/*.sql' }]);
    });

    it('the folder of prisma migrate or of drizzle-kit as the framework folder (40): with its lock file or its journal, in their order, watched with its sub-folders', () => {
        const prisma = project({ '20240102000000_b/migration.sql': TABLE('b'), '20240101000000_a/migration.sql': TABLE('a'), 'migration_lock.toml': 'provider = "postgresql"\n' });
        assert.deepEqual(layoutOf(prisma), { layout: 'prisma', files: ['20240101000000_a/migration.sql', '20240102000000_b/migration.sql'] });
        assert.equal(parser.detect(prisma), 40);
        assert.deepEqual(registry.getSources('sql', prisma), { folders: [{ path: prisma, recursive: true }], files: [path.join(prisma, 'migration_lock.toml')], extensions: ['.sql'] });
        assert.equal(layoutOf(project({ '1_a/migration.sql': TABLE('a') })), null, 'without its lock file');
        const drizzle = project({ '0000_b.sql': TABLE('b'), '0001_a.sql': TABLE('a'), 'meta/_journal.json': JSON.stringify({ dialect: 'postgresql', entries: [{ idx: 0, tag: '0001_a' }, { idx: 1, tag: '0000_b' }] }) });
        assert.deepEqual(layoutOf(drizzle), { layout: 'drizzle', files: ['0001_a.sql', '0000_b.sql'] });
        assert.deepEqual(tables(drizzle), ['a', 'b']);
        assert.deepEqual(registry.getSources('sql', drizzle).files, [path.join(drizzle, 'meta', '_journal.json')]);
        // Without the journal: numbered migrations, by number
        assert.deepEqual(layoutOf(project({ '0001_a.sql': TABLE('a'), '0000_b.sql': TABLE('b') })), { layout: 'migrations', files: ['0000_b.sql', '0001_a.sql'] });
    });

    it('the tables of the migration tools are not drawn: schema_migrations, flyway_schema_history, _prisma_migrations, goose_db_version...', () => {
        const dump = ['schema_migrations', 'ar_internal_metadata', 'flyway_schema_history', '_prisma_migrations', 'goose_db_version', '__drizzle_migrations', '__diesel_schema_migrations', '_sqlx_migrations', 'atlas_schema_revisions', 'pgmigrations', 'sqlite_sequence']
            .map(name => `CREATE TABLE ${name} (version text PRIMARY KEY);\nCREATE INDEX ${name}_idx ON ${name} (version);\nALTER TABLE ${name} ADD COLUMN x int;\n`).join('') + 'CREATE TABLE drizzle.__drizzle_migrations (id serial);\nCREATE TABLE users (id int);\n';
        assert.deepEqual(parser.parse(project({ 'schema.sql': dump }), { git: false }), {
            tables: [{ table: 'users', columns: [{ name: 'id', type: 'int', nullable: true }], relations: [], source: { file: 'schema.sql', line: 35 } }],
            warnings: [],
        });
    });
});

// ---------------------------------------------------------------------------------------------

describe('sql parser: the migrations and the dialect of a project (API version 4)', () => {
    const TABLE = (name) => `CREATE TABLE ${name} (id int);\n`;
    const steps = (result) => result && { root: result.root, framework: result.framework, migrations: result.migrations.map(m => [path.relative(result.root, m.file), m.id, m.time]) };

    it('the migrations of each layout in the order of their tool, their id what `until` takes, the time their name or journal tells; none for a dump', () => {
        const supabase = project({ 'supabase/migrations/20240102030405_b.sql': TABLE('b'), 'supabase/migrations/20240101000000_a.sql': TABLE('a') });
        assert.deepEqual(steps(parser.migrations(supabase)), { root: supabase, framework: 'sql', migrations: [
            [path.join('supabase', 'migrations', '20240101000000_a.sql'), '20240101000000_a.sql', Date.UTC(2024, 0, 1) / 1000],
            [path.join('supabase', 'migrations', '20240102030405_b.sql'), '20240102030405_b.sql', Date.UTC(2024, 0, 2, 3, 4, 5) / 1000],
        ] });
        const flyway = project({ 'db/migration/V10__c.sql': TABLE('c'), 'db/migration/V2__b.sql': TABLE('b'), 'db/migration/old/V20240101120000__a.sql': TABLE('a') });
        assert.deepEqual(steps(parser.migrations(flyway)).migrations.map(([, id, time]) => [id, time]), [['V2__b.sql', undefined], ['V10__c.sql', undefined], ['V20240101120000__a.sql', Date.UTC(2024, 0, 1, 12) / 1000]]);
        const golang = project({ 'migrations/1704110400_init.up.sql': TABLE('a'), 'migrations/1704110400_init.down.sql': 'DROP TABLE a;', 'migrations/0000000002_seq.up.sql': TABLE('b') });
        assert.deepEqual(steps(parser.migrations(golang)).migrations.map(([, id, time]) => [id, time]), [['0000000002_seq.up.sql', undefined], ['1704110400_init.up.sql', 1704110400]]);
        const drizzle = project({ 'drizzle/0000_a.sql': TABLE('a'), 'drizzle/meta/_journal.json': JSON.stringify({ entries: [{ idx: 0, tag: '0000_a', when: 1704110400123 }] }) });
        assert.deepEqual(steps(parser.migrations(drizzle)).migrations, [[path.join('drizzle', '0000_a.sql'), '0000_a.sql', 1704110400]]);
        const prisma = project({ 'prisma/migrations/20240101000000_init/migration.sql': TABLE('a'), 'prisma/migrations/migration_lock.toml': 'provider = "postgresql"\n' });
        assert.deepEqual(steps(parser.migrations(prisma)).migrations, [[path.join('prisma', 'migrations', '20240101000000_init', 'migration.sql'), '20240101000000_init', Date.UTC(2024, 0, 1) / 1000]]);
        // Each id gives the schema right after its migration
        for (const migration of parser.migrations(supabase).migrations) {
            assert.deepEqual(parser.parse(supabase, { git: false, until: migration.id }).tables.map(t => t.table), migration.id.endsWith('_a.sql') ? ['a'] : ['a', 'b']);
        }
        // Any .sql file of the folder (the framework set to sql): by name
        assert.deepEqual(steps(parser.migrations(project({ 'tables.sql': TABLE('a'), 'more.sql': TABLE('b') }))).migrations.map(([, id]) => id), ['more.sql', 'tables.sql']);
        assert.equal(parser.migrations(project({ 'schema.sql': TABLE('a') })), null, 'a dump');
        assert.equal(parser.migrations(project({ 'db/structure.sql': TABLE('a') })), null, "Rails' structure.sql");
        assert.equal(parser.migrations(project({ 'README.md': '' })), null);
        assert.equal(parser.migrations(path.join(TMP, 'dmdb-sql-missing')), null);
    });

    it('the time of a migration: the timestamp that starts its name, read as UTC, when it is a date', () => {
        const at = (...parts) => Date.UTC(...parts) / 1000;
        assert.equal(parser.migrationTime('20240229235960_leap.sql'), at(2024, 1, 29, 23, 59, 60));
        assert.equal(parser.migrationTime('2024-01-02-030405_diesel'), at(2024, 0, 2, 3, 4, 5));
        assert.equal(parser.migrationTime('2024_01_02_030405_create_users_table.php'), at(2024, 0, 2, 3, 4, 5));
        assert.equal(parser.migrationTime('V20240102030405__flyway.sql'), at(2024, 0, 2, 3, 4, 5));
        for (const name of ['V1__a.sql', '0001_a.sql', '20241301000000_month.sql', '20240101250000_hour.sql', '202401010000001_more_digits.sql', '19690101000000_old.sql', '', undefined]) {
            assert.equal(parser.migrationTime(name), undefined, name);
        }
    });

    it("the migrations of an ORM's folder (stackMigrations): from the first folder where the SQL reader finds that folder with that layout", () => {
        const files = { 'supabase/migrations/1_s.sql': TABLE('s'), 'drizzle/0000_a.sql': TABLE('a'), 'drizzle/meta/_journal.json': JSON.stringify({ entries: [{ idx: 0, tag: '0000_a' }] }) };
        // The framework root reads supabase/migrations first: drizzle/ is read from itself
        const both = project(files);
        assert.equal(parser.stackMigrations(both, path.join(both, 'drizzle'), 'drizzle').root, path.join(both, 'drizzle'));
        const alone = project({ 'drizzle/0000_a.sql': TABLE('a'), 'drizzle/meta/_journal.json': files['drizzle/meta/_journal.json'] });
        assert.equal(parser.stackMigrations(alone, path.join(alone, 'drizzle'), 'drizzle').root, alone);
        // drizzle-kit writing into supabase/migrations: its journal, from supabase/
        const out = project({ 'supabase/migrations/0000_a.sql': TABLE('a'), 'supabase/migrations/meta/_journal.json': files['drizzle/meta/_journal.json'] });
        assert.deepEqual(steps(parser.stackMigrations(out, path.join(out, 'supabase', 'migrations'), 'drizzle')), { root: path.join(out, 'supabase'), framework: 'sql', migrations: [[path.join('migrations', '0000_a.sql'), '0000_a.sql', undefined]] });
        // A folder of another name (prisma.config.ts migrations.path), outside of the project too
        const custom = project({ 'db/history/20240101000000_a/migration.sql': TABLE('a'), 'db/history/migration_lock.toml': 'provider = "mysql"\n' });
        assert.equal(parser.stackMigrations(path.join(custom, 'app'), path.join(custom, 'db', 'history'), 'prisma').root, path.join(custom, 'db', 'history'));
        assert.equal(parser.stackMigrations(alone, path.join(alone, 'missing'), 'drizzle'), null);
        assert.equal(parser.stackMigrations(alone, path.join(alone, 'drizzle'), 'prisma'), null, 'not the layout of that ORM');
    });

    it('the dialect: the one the tool of the files tells, else what only one dialect writes, else the names of the folders; MariaDB by its dump or folder; null when nothing tells it', () => {
        const dialect = (files) => parser.dialect(project(files));
        assert.equal(dialect({ 'supabase/migrations/1_a.sql': TABLE('a') }), 'postgresql');
        assert.equal(dialect({ 'prisma/migrations/1_a/migration.sql': TABLE('a'), 'prisma/migrations/migration_lock.toml': 'provider = "cockroachdb"\n' }), 'cockroachdb');
        assert.equal(dialect({ 'prisma/migrations/1_a/migration.sql': TABLE('a'), 'prisma/migrations/migration_lock.toml': 'provider = "sqlserver"\n' }), 'sqlserver');
        assert.equal(dialect({ 'drizzle/0000_a.sql': TABLE('a'), 'drizzle/meta/_journal.json': JSON.stringify({ dialect: 'turso', entries: [{ idx: 0, tag: '0000_a' }] }) }), 'sqlite');
        assert.equal(dialect({ 'drizzle/0000_a.sql': TABLE('a'), 'drizzle/meta/_journal.json': JSON.stringify({ dialect: 'singlestore', entries: [{ idx: 0, tag: '0000_a' }] }) }), 'singlestore');
        assert.equal(dialect({ 'schema.sql': 'CREATE TABLE a (id int AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;\n' }), 'mysql');
        assert.equal(dialect({ 'schema.sql': '-- MariaDB dump 10.19  Distrib 10.11.6-MariaDB\nCREATE TABLE a (id int AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;\n' }), 'mariadb');
        assert.equal(dialect({ 'db/mariadb/migrations/1_a.sql': 'CREATE TABLE a (id int AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;\n' }), null, 'not a layout');
        assert.equal(parser.dialect(path.join(project({ 'mariadb/migrations/1_a.sql': 'CREATE TABLE a (id int AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;\n' }), 'mariadb')), 'mariadb');
        assert.equal(dialect({ 'schema.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT);\n' }), 'sqlite');
        assert.equal(dialect({ 'migrations/sqlite/001_a.sql': TABLE('a') }), null, 'the migrations folder is not the framework folder');
        assert.equal(parser.dialect(path.join(project({ 'sqlite/001_a.sql': TABLE('a') }), 'sqlite')), 'sqlite', 'the name of the folder');
        assert.equal(dialect({ 'schema.sql': TABLE('a') }), null, 'SQL that only one dialect would not write');
        assert.equal(dialect({ 'README.md': '' }), null);
        // The text of an unsaved editor, and only the start of a large dump
        const dir = project({ 'schema.sql': TABLE('a') });
        assert.equal(parser.dialect(dir, { overrides: new Map([[path.join(dir, 'schema.sql'), 'CREATE TABLE a (id serial, b jsonb);\n']]) }), 'postgresql');
        const large = project({ 'dump.sql': `CREATE TABLE a (id int) ENGINE=InnoDB;\n${'-- '.padEnd(1000, 'x')}\n`.repeat(2000) });
        assert.equal(registry.getDialect('sql', large), 'mysql');
    });
});

describe('sql parser: detection among the frameworks', () => {
    it('SQL scores below the frameworks: a Laravel project with a schema.sql is Laravel, a Supabase project with Drizzle is Drizzle', () => {
        const laravel = project({ artisan: '', 'composer.json': JSON.stringify({ require: { 'laravel/framework': '^12.0' } }), 'database/migrations/2024_01_01_000000_a.php': '<?php\n', 'schema.sql': 'CREATE TABLE a (id int);\n' });
        assert.deepEqual(registry.detect(laravel).matches.map(match => [match.id, match.score]), [['laravel', 100], ['sql', 40]]);
        const drizzle = project({
            'drizzle.config.ts': "export default { dialect: 'postgresql', schema: './src/schema.ts', out: './supabase/migrations' };\n",
            'src/schema.ts': "import { pgTable, integer } from 'drizzle-orm/pg-core';\nexport const users = pgTable('users', { id: integer() });\n",
            'supabase/migrations/0000_init.sql': 'CREATE TABLE "users" ("id" integer);\n',
        });
        assert.deepEqual(registry.detect(drizzle).matches.map(match => [match.id, match.score]), [['drizzle', 100], ['sql', 45]]);
        // A Prisma schema without its package (50) wins too
        const prisma = project({ 'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n}\n\nmodel User {\n  id Int @id\n}\n', 'supabase/migrations/1_a.sql': 'CREATE TABLE a (id int);\n' });
        assert.deepEqual(registry.detect(prisma).matches.map(match => [match.id, match.score]), [['prisma', 50], ['sql', 45]]);
        assert.equal(registry.detectFramework(prisma, { framework: 'sql' }), 'sql');
    });
});

// ---------------------------------------------------------------------------------------------

describe('sql parser: PostgreSQL', () => {
    it('types as written, in lower case and without their arguments: lengths, precisions, arrays, the default schema left out', () => {
        assert.deepEqual(columnsOf(`CREATE TABLE t (
  a character varying(255) NOT NULL,
  b VARCHAR(20),
  c numeric(10, 2),
  d timestamp(3) with time zone,
  e double precision,
  f text[],
  g integer ARRAY,
  h public.citext,
  i "public"."My Type",
  j bit varying(8),
  k char(3)[][],
  l interval day to second,
  m public.geography(Point, 4326)
);`, 't'), [
            { name: 'a', type: 'character varying', length: 255 },
            { name: 'b', type: 'varchar', nullable: true, length: 20 },
            { name: 'c', type: 'numeric', nullable: true, precision: 10, scale: 2 },
            { name: 'd', type: 'timestamp with time zone', nullable: true },
            { name: 'e', type: 'double precision', nullable: true },
            { name: 'f', type: 'text[]', nullable: true },
            { name: 'g', type: 'integer[]', nullable: true },
            { name: 'h', type: 'citext', nullable: true },
            { name: 'i', type: 'My Type', nullable: true },
            { name: 'j', type: 'bit varying', nullable: true, length: 8 },
            { name: 'k', type: 'char[][]', nullable: true, length: 3 },
            { name: 'l', type: 'interval day to second', nullable: true },
            { name: 'm', type: 'geography', nullable: true },
        ]);
    });

    it('defaults: a literal (casts and parentheses left out, numbers of numeric columns), an SQL expression as written, nextval() and identity are auto-increments', () => {
        assert.deepEqual(columnsOf(`CREATE TABLE t (
  a text DEFAULT 'it''s'::text,
  b integer DEFAULT '-1'::integer,
  c numeric DEFAULT (0)::numeric,
  d boolean DEFAULT true,
  e text DEFAULT NULL::character varying,
  f bigint DEFAULT 9007199254740993,
  g timestamp DEFAULT now() NOT NULL,
  h date DEFAULT ('now'::text)::date,
  i jsonb DEFAULT '{}'::jsonb,
  j integer DEFAULT nextval('t_j_seq'::regclass) NOT NULL,
  k bigint GENERATED BY DEFAULT AS IDENTITY,
  l serial,
  m uuid DEFAULT gen_random_uuid(),
  n text DEFAULT E'a\\nb',
  o real DEFAULT -0.5,
  p tsvector GENERATED ALWAYS AS (to_tsvector('simple', a)) STORED
);`, 't'), [
            { name: 'a', type: 'text', nullable: true, default: 'it\'s' },
            { name: 'b', type: 'integer', nullable: true, default: -1 },
            { name: 'c', type: 'numeric', nullable: true, default: 0 },
            { name: 'd', type: 'boolean', nullable: true, default: true },
            { name: 'e', type: 'text', nullable: true, default: null },
            { name: 'f', type: 'bigint', nullable: true, defaultRaw: '9007199254740993' },
            { name: 'g', type: 'timestamp', defaultRaw: 'now()' },
            { name: 'h', type: 'date', nullable: true, defaultRaw: "('now'::text)::date" },
            { name: 'i', type: 'jsonb', nullable: true, default: '{}' },
            { name: 'j', type: 'integer', autoIncrement: true },
            { name: 'k', type: 'bigint', autoIncrement: true },
            { name: 'l', type: 'serial', autoIncrement: true },
            { name: 'm', type: 'uuid', nullable: true, defaultRaw: 'gen_random_uuid()' },
            { name: 'n', type: 'text', nullable: true, default: 'a\nb' },
            { name: 'o', type: 'real', nullable: true, default: -0.5 },
            { name: 'p', type: 'tsvector', nullable: true },
        ]);
    });

    it('names: unquoted ones folded to lower case, quoted ones kept; the schema in the name unless it is public; the search path', () => {
        const { tables } = replayed(`CREATE TABLE Users (Id int PRIMARY KEY, "DisplayName" text);
CREATE TABLE "Posts" ("Id" int, author int REFERENCES USERS (ID));
CREATE SCHEMA app;
CREATE TABLE app.comments (id int, post int REFERENCES "Posts");
SET search_path TO app, public;
CREATE TABLE tags (id int, user_id int REFERENCES users);
ALTER TABLE comments ADD COLUMN tag int REFERENCES tags;
SELECT pg_catalog.set_config('search_path', '', false);
CREATE TABLE public.labels (id int);`);
        assert.deepEqual(shape(tables), { users: 'id* DisplayName?', Posts: 'Id? author?', 'app.comments': 'id? post? tag?', 'app.tags': 'id? user_id?', labels: 'id?' });
        assert.deepEqual(relationsOf(tables), ['Posts.author -> users.id many-to-one', 'app.comments.post -> Posts.id many-to-one', 'app.comments.tag -> app.tags.id many-to-one', 'app.tags.user_id -> users.id many-to-one']);
    });

    it('keys: inline and table constraints, one-to-one when the foreign key is unique or the primary key, composite keys, the primary key of the referenced table by default, referential actions', () => {
        const { tables } = replayed(`CREATE TABLE users (id bigint PRIMARY KEY, email text UNIQUE NOT NULL);
CREATE TABLE profiles (user_id bigint PRIMARY KEY REFERENCES users ON DELETE CASCADE, bio text);
CREATE TABLE posts (
  id bigint,
  author_id bigint NOT NULL,
  parent_id bigint,
  CONSTRAINT posts_pkey PRIMARY KEY (id),
  CONSTRAINT posts_author_fkey FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (parent_id) REFERENCES posts MATCH SIMPLE ON DELETE NO ACTION,
  CHECK (id > 0)
);
CREATE TABLE tenancies (tenant int, id int, PRIMARY KEY (tenant, id));
CREATE TABLE seats (tenant int, tenancy int, UNIQUE (tenant, tenancy), FOREIGN KEY (tenant, tenancy) REFERENCES tenancies ON DELETE RESTRICT);`);
        assert.deepEqual(relationsOf(tables), [
            'profiles.user_id -> users.id one-to-one cascade',
            'posts.author_id -> users.id many-to-one set null/cascade',
            'posts.parent_id -> posts.id many-to-one no action',
            'seats.tenant -> tenancies.tenant one-to-one restrict',
            'seats.tenancy -> tenancies.id one-to-one restrict',
        ]);
        assert.deepEqual(shape(tables), { users: 'id* email', profiles: 'user_id* bio?', posts: 'id* author_id parent_id?', tenancies: 'tenant* id*', seats: 'tenant? tenancy?' });
        assert.deepEqual(tableNamed(tables, 'users').columns[1], { name: 'email', type: 'text', unique: true });
        assert.deepEqual(tableNamed(tables, 'seats').indexes, [{ columns: ['tenant', 'tenancy'], type: 'unique' }]);
    });

    it('a UNIQUE that repeats the primary key or another one of its CREATE TABLE is dropped, as PostgreSQL does', () => {
        const { tables } = replayed('CREATE TABLE a (id uuid UNIQUE NOT NULL, b int, c int, PRIMARY KEY (id), UNIQUE (b, c), UNIQUE (b, c), UNIQUE (c, b));');
        assert.deepEqual(tables[0].columns[0], { name: 'id', type: 'uuid', primary: true });
        assert.deepEqual(tables[0].indexes, [{ columns: ['b', 'c'], type: 'unique' }, { columns: ['c', 'b'], type: 'unique' }]);
    });

    it('indexes: CREATE [UNIQUE] INDEX, partial unique indexes, expressions, operator classes and orders left out, DROP INDEX, ALTER INDEX RENAME, exclusion constraints', () => {
        const { tables } = replayed(`CREATE TABLE t (id int, email text, slug text, at tstzrange, deleted_at timestamp);
CREATE UNIQUE INDEX t_email_key ON public.t USING btree (email);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS t_slug_live ON ONLY t (slug) WHERE deleted_at IS NULL;
CREATE INDEX ON t (lower(email) text_pattern_ops DESC NULLS LAST, id);
CREATE INDEX t_expr ON t ((email || slug));
CREATE INDEX t_gone ON t (slug);
DROP INDEX IF EXISTS t_gone, public.t_unknown CASCADE;
CREATE INDEX t_slug_idx ON t USING gin (slug gin_trgm_ops) INCLUDE (id) WITH (fastupdate = off);
ALTER INDEX t_slug_idx RENAME TO t_slug_trgm;
ALTER TABLE t ADD CONSTRAINT t_no_overlap EXCLUDE USING gist (id WITH =, at WITH &&) WHERE (deleted_at IS NULL);`);
        assert.deepEqual(tables[0].columns.find(c => c.name === 'email'), { name: 'email', type: 'text', nullable: true, unique: true });
        assert.deepEqual(tables[0].indexes, [
            { columns: ['slug'], type: 'unique', name: 't_slug_live' },
            { columns: ['lower(email)', 'id'], type: 'index' },
            { columns: ['email || slug'], type: 'index', name: 't_expr' },
            { columns: ['slug'], type: 'index', name: 't_slug_trgm' },
            { columns: ['id', 'at'], type: 'index', name: 't_no_overlap' },
        ]);
    });

    it('ALTER TABLE: columns added, dropped, changed and renamed, several actions at once; the foreign keys follow the renamed tables and columns', () => {
        const { tables } = replayed(`CREATE TABLE users (id int PRIMARY KEY, name text, old text);
CREATE TABLE posts (id int, author int REFERENCES users (id));
ALTER TABLE ONLY users ADD COLUMN email varchar(100) NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS name text, DROP COLUMN old, DROP COLUMN IF EXISTS missing CASCADE;
ALTER TABLE users ALTER COLUMN name SET NOT NULL, ALTER COLUMN name TYPE varchar(80) USING name::varchar(80), ALTER COLUMN email DROP DEFAULT;
ALTER TABLE users ALTER COLUMN email SET DATA TYPE text, ALTER COLUMN email DROP NOT NULL, ALTER COLUMN name SET DEFAULT 'anonymous';
ALTER TABLE users RENAME COLUMN id TO user_id;
ALTER TABLE users RENAME TO members;
ALTER TABLE IF EXISTS ghosts ADD COLUMN x int;
ALTER TABLE posts RENAME author TO member_id, ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;
ALTER TABLE posts ADD COLUMN at timestamptz, ALTER COLUMN at SET STATISTICS 100, OWNER TO postgres, ENABLE ROW LEVEL SECURITY, REPLICA IDENTITY FULL;`);
        assert.deepEqual(shape(tables), { members: 'user_id* name email?', posts: 'id member_id? at?' });
        assert.deepEqual(tableNamed(tables, 'members').columns, [
            { name: 'user_id', type: 'int', primary: true },
            { name: 'name', type: 'varchar', length: 80, default: 'anonymous' },
            { name: 'email', type: 'text', nullable: true },
        ]);
        assert.deepEqual(relationsOf(tables), ['posts.member_id -> members.user_id many-to-one']);
        assert.equal(tableNamed(tables, 'posts').columns[0].autoIncrement, true);
    });

    it('ALTER TABLE: constraints added and dropped by their name or the name PostgreSQL gives them, NOT VALID and VALIDATE, keys from an index (supabase db diff), SET SCHEMA', () => {
        const { tables } = replayed(`CREATE TABLE users (id int NOT NULL, email text UNIQUE, tenant int);
CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id);
ALTER TABLE users ADD CONSTRAINT users_pkey PRIMARY KEY USING INDEX users_pkey;
CREATE TABLE posts (id int PRIMARY KEY, author int, editor int, slug text);
ALTER TABLE posts ADD CONSTRAINT posts_author_fkey FOREIGN KEY (author) REFERENCES users(id) NOT VALID;
ALTER TABLE posts VALIDATE CONSTRAINT posts_author_fkey;
ALTER TABLE posts ADD FOREIGN KEY (editor) REFERENCES users;
ALTER TABLE posts DROP CONSTRAINT posts_editor_fkey;
CREATE UNIQUE INDEX posts_slug_key ON posts (slug);
ALTER TABLE posts ADD CONSTRAINT posts_slug_key UNIQUE USING INDEX posts_slug_key;
ALTER TABLE users DROP CONSTRAINT users_email_key;
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_pkey;
ALTER TABLE posts ADD PRIMARY KEY (id, author);
ALTER TABLE posts RENAME CONSTRAINT posts_slug_key TO posts_slug_unique;
CREATE SCHEMA blog;
ALTER TABLE posts SET SCHEMA blog;`);
        assert.deepEqual(shape(tables), { users: 'id* email? tenant?', 'blog.posts': 'id* author* editor? slug?' });
        assert.deepEqual(relationsOf(tables), ['blog.posts.author -> users.id many-to-one']);
        assert.equal(tableNamed(tables, 'users').columns[1].unique, undefined);
        assert.equal(tableNamed(tables, 'blog.posts').columns[3].unique, true);
    });

    it('enum types: their values, added (BEFORE, AFTER, IF NOT EXISTS) and renamed; a renamed type keeps its columns; DROP TYPE ... CASCADE drops them', () => {
        const { tables } = replayed(`CREATE TYPE mood AS ENUM ('sad', 'ok');
CREATE TYPE auth.level AS ENUM ('low');
CREATE TABLE t (a mood, b mood[] NOT NULL, c auth.level, d public.mood DEFAULT 'ok'::public.mood);
ALTER TYPE mood ADD VALUE 'happy' AFTER 'ok';
ALTER TYPE mood ADD VALUE IF NOT EXISTS 'sad';
ALTER TYPE mood ADD VALUE 'awful' BEFORE 'sad';
ALTER TYPE mood RENAME VALUE 'ok' TO 'fine';
ALTER TYPE auth.level RENAME TO grade;
CREATE TYPE gone AS ENUM ('x');
ALTER TABLE t ADD COLUMN e gone;
DROP TYPE gone CASCADE;`);
        assert.deepEqual(tables[0].columns, [
            { name: 'a', type: 'mood', nullable: true, values: ['awful', 'sad', 'fine', 'happy'] },
            { name: 'b', type: 'mood[]', values: ['awful', 'sad', 'fine', 'happy'] },
            { name: 'c', type: 'auth.grade', nullable: true, values: ['low'] },
            { name: 'd', type: 'mood', nullable: true, default: 'ok', values: ['awful', 'sad', 'fine', 'happy'] },
        ]);
        // prisma migrate and supabase db diff change an enum by renaming the old one
        const prisma = replayed(`CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');
CREATE TABLE "User" ("role" "Role" NOT NULL DEFAULT 'USER');
ALTER TYPE "Role" RENAME TO "Role_old";
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN', 'OWNER');
ALTER TABLE "User" ALTER COLUMN "role" TYPE "Role" USING ("role"::text::"Role");
DROP TYPE "Role_old";`).tables;
        assert.deepEqual(prisma[0].columns, [{ name: 'role', type: 'Role', default: 'USER', values: ['USER', 'ADMIN', 'OWNER'] }]);
    });

    it('DROP TABLE and DROP SCHEMA: with CASCADE, the foreign keys that reference them go too', () => {
        const { tables } = replayed(`CREATE TABLE a (id int PRIMARY KEY);
CREATE TABLE b (id int PRIMARY KEY);
CREATE TABLE c (a_id int REFERENCES a, b_id int REFERENCES b, x_id int REFERENCES trash.x);
CREATE SCHEMA trash;
CREATE TABLE trash.x (id int PRIMARY KEY);
DROP TABLE IF EXISTS a CASCADE;
DROP TABLE b;
DROP SCHEMA trash CASCADE;`);
        assert.deepEqual(shape(tables), { c: 'a_id? b_id? x_id?' });
        assert.deepEqual(relationsOf(tables), ['c.b_id -> b.id many-to-one']);
    });

    it('DO blocks: the DDL of their branches is applied (idempotent migrations), not the one of their exception handlers; EXECUTE of a constant string too', () => {
        const { tables, warnings } = replayed(`DO $$
DECLARE
  n int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mood') THEN
    CREATE TYPE mood AS ENUM ('ok');
  ELSE
    RAISE NOTICE 'exists';
  END IF;
  <<inner>>
  BEGIN
    CREATE TABLE a (id int, m mood);
  EXCEPTION WHEN duplicate_table THEN
    CREATE TABLE never (id int);
  END inner;
  FOR n IN 1..2 LOOP
    PERFORM 1;
  END LOOP;
  EXECUTE 'ALTER TABLE a ADD COLUMN b int';
  EXECUTE format('ALTER TABLE %I ADD COLUMN c int', 'a');
END
$$ LANGUAGE plpgsql;
DO LANGUAGE plv8 $js$ plv8.execute('CREATE TABLE js (id int)') $js$;
DO 'BEGIN CREATE TABLE quoted (id int); END';`);
        assert.deepEqual(shape(tables), { a: 'id? m? b?', quoted: 'id?' });
        assert.deepEqual(tables[0].columns[1].values, ['ok']);
        assert.deepEqual(warnings, ['schema.sql:20: dynamic SQL (EXECUTE) skipped: it cannot be read without running it.']);
    });

    it('functions, triggers, policies, grants, views, materialized views, sequences, extensions, comments and transactions change no table, without a warning', () => {
        const { tables, warnings } = replayed(`BEGIN;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE TABLE t (id int, note text);
CREATE SEQUENCE t_id_seq START 1;
ALTER SEQUENCE t_id_seq OWNED BY t.id;
CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $$ BEGIN CREATE TABLE inside (id int); RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f();
CREATE POLICY "read" ON t FOR SELECT TO authenticated USING (true);
ALTER POLICY "read" ON t RENAME TO "read all";
GRANT SELECT ON t TO anon;
REVOKE ALL ON t FROM anon;
CREATE VIEW v AS SELECT * FROM t;
CREATE MATERIALIZED VIEW mv AS SELECT id FROM t;
CREATE UNIQUE INDEX mv_id ON mv (id);
ALTER TABLE mv OWNER TO postgres;
COMMENT ON TABLE t IS 'a table';
COMMENT ON COLUMN t.note IS 'a note';
CREATE ROLE reader;
INSERT INTO t VALUES (1, 'CREATE TABLE in_a_string (id int)');
UPDATE t SET note = 'x';
VACUUM ANALYZE t;
COMMIT;`);
        assert.deepEqual(tables, [{ table: 't', columns: [{ name: 'id', type: 'int', nullable: true }, { name: 'note', type: 'text', nullable: true, comment: 'a note' }], relations: [], source: { file: 'schema.sql', line: 3 } }]);
        assert.deepEqual(warnings, []);
    });

    it('partitions, views and sequences are no tables; LIKE copies the columns (INCLUDING ALL the keys), INHERITS puts the columns of the parents first; temporary tables do not stay', () => {
        const { tables, warnings } = replayed(`CREATE TABLE events (id bigint NOT NULL, at date NOT NULL) PARTITION BY RANGE (at);
CREATE TABLE events_2024 PARTITION OF events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE INDEX events_2024_at ON events_2024 (at);
CREATE TABLE events_2025 (id bigint NOT NULL, at date NOT NULL);
ALTER TABLE ONLY events ATTACH PARTITION events_2025 FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
ALTER TABLE ONLY events_2025 ADD CONSTRAINT events_2025_pkey PRIMARY KEY (id);
CREATE TABLE base (id serial PRIMARY KEY, at timestamptz DEFAULT now() NOT NULL);
CREATE TABLE copy (LIKE base);
CREATE TABLE full_copy (LIKE base INCLUDING ALL, extra text);
CREATE TABLE child (note text) INHERITS (base);
CREATE TEMP TABLE scratch (id int);
CREATE TEMPORARY TABLE IF NOT EXISTS scratch2 (id int);
CREATE UNLOGGED TABLE cache (k text PRIMARY KEY);`);
        assert.deepEqual(shape(tables), { events: 'id at', base: 'id* at', copy: 'id at', full_copy: 'id* at extra?', child: 'id at note?', cache: 'k*' });
        assert.deepEqual(tableNamed(tables, 'copy').columns, [{ name: 'id', type: 'serial' }, { name: 'at', type: 'timestamptz' }]);
        assert.deepEqual(tableNamed(tables, 'child').columns[1], { name: 'at', type: 'timestamptz', defaultRaw: 'now()' });
        assert.deepEqual(warnings, []);
    });

    it('a column named begin in a table that has one named event is a column, not the body of a routine: the next statements are read', () => {
        const { tables, warnings } = replayed(`create table bookings (id int primary key, event text, begin timestamptz, "end" timestamptz);
create table rooms (id int primary key);
create function f(a int) returns int language sql begin atomic select a + 1; select a; end;
create table users (id int primary key);
alter table rooms add column name text;`);
        assert.deepEqual(shape(tables), { bookings: 'id* event? begin? end?', rooms: 'id* name?', users: 'id*' });
        assert.deepEqual(warnings, []);
    });

    it('nextval() of a serial column, quoted (pg_dump --quote-all-identifiers, supabase db dump) or in pg_catalog, is an auto-increment', () => {
        const { tables } = replayed(`CREATE TABLE "public"."t" ("id" integer NOT NULL, "n" integer, "q" integer, "o" integer);
ALTER TABLE ONLY "public"."t" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."t_id_seq"'::"regclass");
ALTER TABLE t ALTER COLUMN n SET DEFAULT pg_catalog.nextval('t_n_seq');
ALTER TABLE t ALTER COLUMN q SET DEFAULT "pg_catalog"."nextval"('t_q_seq'::regclass);
ALTER TABLE t ALTER COLUMN o SET DEFAULT "NextVal"('t_o_seq');`);
        assert.deepEqual(tableNamed(tables, 't').columns.map(c => [c.name, c.autoIncrement || c.defaultRaw]), [['id', true], ['n', true], ['q', true], ['o', '"NextVal"(\'t_o_seq\')']]);
    });

    it('the search path: RESET search_path and RESET ALL give the default one back, SET LOCAL lasts until COMMIT or ROLLBACK', () => {
        const { tables } = replayed(`create schema app;
set search_path to app;
create table a (id int primary key);
reset search_path;
create table b (id int primary key, a_id int references app.a);
begin;
set local search_path to app;
create table c (id int);
commit;
create table d (id int);
begin;
set search_path = app;
set local search_path = public;
create table e (id int);
commit;
create table f (id int);
reset all;
begin;
set search_path = app;
rollback;
create table g (id int);
begin;
set local search_path = app;
savepoint s;
rollback to savepoint s;
create table h (id int);
end;
create table i (id int);
start transaction;
select pg_catalog.set_config('search_path', 'app', true);
create table j (id int);
commit;
create table k (id int);
set local search_path = app;
create table l (id int);`);
        // As PostgreSQL 17 creates them, run one by one; a SET LOCAL outside BEGIN lasts until the end of the file, which the
        // migration tools run in a transaction
        assert.deepEqual(tables.map(t => t.table), ['app.a', 'b', 'app.c', 'd', 'e', 'app.f', 'g', 'app.h', 'i', 'app.j', 'k', 'app.l']);
        assert.deepEqual(relationsOf(tables), ['b.a_id -> app.a.id many-to-one']);
    });

    it('a default name already taken gets 1, 2... as PostgreSQL gives it: a second foreign key or index on the same columns is kept, and dropped by that name', () => {
        const text = `create table a (id int primary key);
create table b (id int primary key);
create table c (x int references a, y int, z int unique);
alter table c add foreign key (x) references b;
alter table c add unique (z);
create table accounts (id int primary key, mixed int, other int);
create index on accounts (mixed);
create index on accounts (mixed);
create index on accounts (lower(other::text));
create index on accounts (lower(other::text));
create table c_y_fkey (id int);
alter table c add foreign key (y) references a;`;
        const indexes = (tables) => tableNamed(tables, 'accounts').indexes.map(index => index.columns.join(','));
        const first = replayed(text);
        assert.deepEqual(relationsOf(first.tables), ['c.x -> a.id many-to-one', 'c.x -> b.id many-to-one', 'c.y -> a.id many-to-one']);
        assert.deepEqual(indexes(first.tables), ['mixed', 'mixed', 'lower(other::text)', 'lower(other::text)']);
        // The names of PostgreSQL 17: c_x_fkey1, c_z_key1, accounts_mixed_idx1, accounts_lower_idx1 (c_y_fkey: a table of that name is no constraint)
        const dropped = replayed(`${text}\nalter table c drop constraint c_x_fkey1;\nalter table c drop constraint c_y_fkey;\nalter table c drop constraint c_z_key1;\ndrop index accounts_mixed_idx1;\ndrop index accounts_lower_idx;`);
        assert.deepEqual(relationsOf(dropped.tables), ['c.x -> a.id many-to-one']);
        assert.deepEqual(indexes(dropped.tables), ['mixed', 'lower(other::text)']);
        assert.equal(tableNamed(dropped.tables, 'c').columns[2].unique, true);
        assert.deepEqual(dropped.warnings, []);
    });

    it('DROP COLUMN drops the indexes whose expression, WHERE or INCLUDE uses the column, as PostgreSQL does', () => {
        const { tables } = replayed(`create table accounts (id int primary key, mail text, other text, note text, kind text, keep text);
create unique index accounts_lower_mail on accounts (lower(mail));
create index accounts_partial on accounts (other) where mail is not null;
create index accounts_cover on accounts (id) include (note);
create index accounts_kind on accounts ((kind::text));
create index accounts_keep on accounts (keep) where keep <> '';
create index accounts_renamed on accounts (lower(other));
alter table accounts add constraint accounts_excl exclude using btree (keep with =) where (kind is not null);
alter table accounts drop column mail;
alter table accounts drop column note;
alter table accounts rename column other to other2;
alter table accounts drop column other2;
alter table accounts drop column kind cascade;`);
        assert.deepEqual(tableNamed(tables, 'accounts').indexes, [{ columns: ['keep'], type: 'index', name: 'accounts_keep' }]);
        // A function or a type named as the column is not the column
        const kept = replayed('create table t (id int, lower text, text text, x text);\ncreate index t_x on t (lower(x::text));\nalter table t drop column lower;\nalter table t drop column text;').tables;
        assert.deepEqual(tableNamed(kept, 't').indexes, [{ columns: ['lower(x::text)'], type: 'index', name: 't_x' }]);
    });

    it('DROP COLUMN keeps the indexes whose SQL words only look like the column: EXTRACT(year FROM ...), AT TIME ZONE, reserved words, types and interval units', () => {
        const { tables } = replayed(`create table r (id int primary key, year int, day int, epoch int, zone text, "time" int, "at" int, "end" int, "null" int, varying int, "precision" int, unknown int, hour int, "C" int, created_at timestamp, ts timestamp, tz timestamptz, kind text, name text);
create index r_year on r ((extract(year from created_at)));
create index r_epoch on r ((extract(epoch from ts)));
create index r_day on r (kind) where extract(day from ts) = 1;
create index r_zone on r ((created_at at time zone 'UTC'));
create index r_case on r ((case when kind = 'a' then 1 else 0 end));
create index r_null on r (kind) where name is not null and kind is distinct from 'x';
create index r_cast on r ((kind::character varying));
create index r_double on r ((id::double precision));
create index r_with_zone on r ((tz::timestamp with time zone));
create index r_literal on r (kind) where created_at > timestamp '2020-01-01' + interval '1 day';
create index r_unit on r (kind) where ts > timestamp '2020-01-01' + interval '1' hour;
create index r_unknown on r (kind) where (name = 'a') is not unknown;
create index r_collate on r ((name collate "C"));
create index r_uses_year on r (kind) where year > 2000;
create index r_uses_zone on r ((zone || 'x'));
create index r_uses_end on r (("end" + 1));
create index r_uses_at on r (("at" + 1));
create index r_uses_time on r (("time" + hour));
alter table r drop column year, drop column day, drop column epoch, drop column zone, drop column "time", drop column "at", drop column "end";
alter table r drop column "null", drop column varying, drop column "precision", drop column unknown, drop column hour, drop column "C";`);
        // As PostgreSQL 17 keeps them: the r_uses_ ones use the dropped columns
        assert.deepEqual(tableNamed(tables, 'r').indexes.map(index => index.name), ['r_year', 'r_epoch', 'r_day', 'r_zone', 'r_case', 'r_null', 'r_cast', 'r_double', 'r_with_zone', 'r_literal', 'r_unit', 'r_unknown', 'r_collate']);
    });

    it('DROP COLUMN keeps the indexes of IS JSON, IS NORMALIZED, normalize() and xmlparse(): their words are no columns, columns of those names are', () => {
        const { tables } = replayed(`create table r (id int primary key, name text, payload text, n int, json int, nfc int, nfkd int, normalized int, document int, content int, keys int, scalar int, object int, value int);
create index r_a on r (n) where payload is json;
create index r_b on r (n) where payload is not json object;
create index r_c on r (n) where payload is json scalar with unique keys;
create index r_d on r (n) where payload is json value without unique;
create index r_e on r (n) where name is nfc normalized;
create index r_f on r (n) where name is not nfkd normalized;
create index r_g on r (n) where name is normalized;
create index r_h on r ((normalize(name, nfc)));
create index r_i on r ((normalize(name, nfkd)));
create index r_j on r ((xmlparse(document name)::text));
create index r_k on r ((xmlparse(content name)::text));
create index r_l on r ((xmlserialize(document xmlparse(document name) as text)));
create index i_json on r ((json + 1));
create index i_nfc on r ((nfc + n));
create index i_doc on r (n) where document > 0;
create index i_content on r ((content * 2));
create index i_keys on r ((keys + 1));
create index i_scalar on r (n) where scalar is not null;
create index i_object on r ((object - 1));
create index i_value on r (n) where value is null;
create index i_norm on r ((normalized + nfkd));
create index i_fn on r ((normalize(name)));
alter table r drop column json, drop column nfc, drop column nfkd, drop column normalized, drop column document;
alter table r drop column content, drop column keys, drop column scalar, drop column object, drop column value;`);
        // As PostgreSQL 17.11 keeps them: the i_ ones use the dropped columns, except i_fn
        assert.deepEqual(tableNamed(tables, 'r').indexes.map(index => index.name), ['r_a', 'r_b', 'r_c', 'r_d', 'r_e', 'r_f', 'r_g', 'r_h', 'r_i', 'r_j', 'r_k', 'r_l', 'i_fn']);
    });

    it('the columns added, dropped, renamed or altered on a parent are those of the tables that inherit it (INHERITS), unless ONLY or their own; DROP ... CASCADE drops them', () => {
        const { tables, warnings } = replayed(`create table parent (id int primary key, old text, shared text);
create table child (extra text, shared text) inherits (parent);
create table grandchild (g int) inherits (child);
create table other_parent (id int primary key);
create table loner (id int primary key) inherits (other_parent);
alter table parent add column added int references other_parent(id);
alter table parent rename column added to added2;
alter table parent alter column added2 type bigint;
alter table parent alter column old set not null;
alter table parent drop column shared;
alter table parent drop column old;
alter table parent add column only_drop int;
alter table only parent drop column only_drop;
alter table parent add column only_drop int;
alter table parent drop column only_drop;
alter table loner no inherit other_parent;
alter table other_parent add column after_no int;
create table droppable (id int primary key);
create table droppable_child (x int) inherits (droppable);
drop table droppable cascade;`);
        // As PostgreSQL 17 has them; the foreign key of a parent is not inherited
        assert.deepEqual(shape(tables), { parent: 'id* added2?', child: 'id shared? extra? added2? only_drop?', grandchild: 'id shared? extra? g? added2? only_drop?', other_parent: 'id* after_no?', loner: 'id*' });
        assert.deepEqual(tableNamed(tables, 'grandchild').columns.find(c => c.name === 'added2').type, 'bigint');
        assert.deepEqual(relationsOf(tables), ['parent.added2 -> other_parent.id many-to-one']);
        assert.deepEqual(warnings, []);
    });

    it('several parents (INHERITS (a, b)): a column of both is one column, kept until the last parent that gives it drops it; INHERIT and NO INHERIT count too', () => {
        const { tables, warnings } = replayed(`create table p1 (id int, a int);
create table p2 (id int, b int);
create table mc (own text) inherits (p1, p2);
create table mc2 () inherits (mc);
alter table p1 drop column id;
alter table p2 add column a int;
alter table p1 drop column a;
alter table p2 add column c int;
alter table p1 add column c int;
alter table mc no inherit p2;
alter table p1 drop column c;
create table q1 (x int, y int);
create table q2 (x int);
create table mq () inherits (q1, q2);
alter table mq no inherit q1;
alter table q2 drop column x;
create table s1 (k int);
create table s2 (k int, z int);
create table sc () inherits (s1);
alter table sc add column z int;
alter table sc inherit s2;
alter table s1 drop column k;
alter table s2 drop column z;
create table own (k int) inherits (s2);`);
        // As PostgreSQL 17 has them
        assert.deepEqual(shape(tables), { p1: '', p2: 'id? b? a? c?', mc: 'id? a? b? own?', mc2: 'id? a? b? own?', q1: 'x? y?', q2: '', mq: 'y?', s1: '', s2: 'k?', sc: 'k? z?', own: 'k?' });
        assert.deepEqual(warnings, []);
    });

    it('a table that inherits two tables of the same parent (a diamond) counts the columns of that parent once per line: a column dropped from it goes, an added one stays while one line gives it', () => {
        const { tables, warnings } = replayed(`create table gp (id int, x int);
create table p1 (a int) inherits (gp);
create table p2 (b int) inherits (gp);
create table c (own int) inherits (p1, p2);
create table cc (k int) inherits (c);
alter table gp drop column x;
alter table gp add column y int;
alter table p1 no inherit gp;
alter table p1 drop column y;
alter table gp add column z int;
create table h1 (id int, w int);
create table h2 (id int, w int);
create table hd (own int) inherits (h1, h2);
create table hdd (q int) inherits (hd);
alter table c no inherit p2;
alter table gp drop column z;`);
        // As PostgreSQL 17.11 has them: c.x dropped through both parents, c.y kept by p2, c.z left
        // to c once it no longer inherits p2
        assert.deepEqual(shape(tables), { gp: 'id? y?', p1: 'id? a?', p2: 'id? b? y?', c: 'id? a? b? own? y? z?', cc: 'id? a? b? own? k? y? z?', h1: 'id? w?', h2: 'id? w?', hd: 'id? w? own?', hdd: 'id? w? own? q?' });
        assert.deepEqual(warnings, []);
        // A loop of INHERIT (PostgreSQL refuses it) ends: b gets x once
        const loop = replayed('create table a (id int);\ncreate table b () inherits (a);\nalter table a inherit b;\nalter table a add column x int;\nalter table b drop column id;\n');
        assert.deepEqual(shape(loop.tables), { a: 'id? x?', b: 'x?' });
    });
});

// ---------------------------------------------------------------------------------------------

describe('sql parser: MySQL', () => {
    it('backticks, AUTO_INCREMENT, table options, inline keys and indexes, enum and set values, unsigned, ON UPDATE CURRENT_TIMESTAMP, comments, generated columns', () => {
        const { tables } = replayed(`CREATE TABLE \`users\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`email\` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'The \\'login\\'',
  \`status\` enum('active','banned') NOT NULL DEFAULT 'active',
  \`roles\` set('a','b') DEFAULT NULL,
  \`score\` decimal(8,2) unsigned zerofill DEFAULT '0.00',
  \`admin\` tinyint(1) NOT NULL DEFAULT '0',
  \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  \`uuid\` char(36) NOT NULL DEFAULT (uuid()),
  \`full\` varchar(300) GENERATED ALWAYS AS (concat(\`email\`, ' ')) VIRTUAL,
  \`key\` varchar(10) DEFAULT "x",
  PRIMARY KEY (\`id\`) USING BTREE,
  UNIQUE KEY \`users_email_unique\` (\`email\`),
  KEY \`users_status_index\` (\`status\`, \`updated_at\` DESC),
  KEY (\`key\`(5)),
  FULLTEXT KEY \`users_full\` (\`full\`),
  CONSTRAINT \`users_self\` FOREIGN KEY (\`id\`) REFERENCES \`users\` (\`id\`) ON DELETE RESTRICT
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COMMENT='Users';`, 'mysql');
        assert.deepEqual(tables[0].columns, [
            { name: 'id', type: 'bigint', primary: true, unsigned: true, autoIncrement: true },
            { name: 'email', type: 'varchar', length: 191, unique: true, comment: 'The \'login\'' },
            { name: 'status', type: 'enum', default: 'active', values: ['active', 'banned'] },
            { name: 'roles', type: 'set', nullable: true, default: null, values: ['a', 'b'] },
            { name: 'score', type: 'decimal', nullable: true, precision: 8, scale: 2, unsigned: true, default: 0 },
            { name: 'admin', type: 'tinyint', default: 0 },
            { name: 'updated_at', type: 'timestamp', defaultRaw: 'CURRENT_TIMESTAMP', onUpdateCurrent: true },
            { name: 'uuid', type: 'char', length: 36, defaultRaw: '(uuid())' },
            { name: 'full', type: 'varchar', nullable: true, length: 300 },
            { name: 'key', type: 'varchar', nullable: true, length: 10, default: 'x' },
        ]);
        assert.deepEqual(tables[0].indexes, [
            { columns: ['status', 'updated_at'], type: 'index', name: 'users_status_index' },
            { columns: ['key'], type: 'index' },
            { columns: ['full'], type: 'fulltext', name: 'users_full' },
        ]);
        assert.deepEqual(tables[0].relations, [{ foreignKey: 'id', references: 'id', on: 'users', type: 'one-to-one', onDelete: 'restrict' }]);
    });

    it('MODIFY, CHANGE, FIRST and AFTER, RENAME TABLE, DROP FOREIGN KEY, DROP INDEX, DROP PRIMARY KEY; a dropped column leaves the indexes that hold it', () => {
        const { tables } = replayed(`CREATE TABLE a (id int NOT NULL, b int, c text, d int, PRIMARY KEY (id, b), KEY a_b_c (b, c(10)), UNIQUE KEY a_d (d));
CREATE TABLE z (id int PRIMARY KEY, a_id int, CONSTRAINT z_a FOREIGN KEY (a_id) REFERENCES a (id));
ALTER TABLE a ADD COLUMN first_col int FIRST, ADD COLUMN after_b varchar(5) NULL AFTER b, MODIFY COLUMN c varchar(50) NOT NULL DEFAULT '';
ALTER TABLE a CHANGE d e bigint UNSIGNED;
ALTER TABLE a DROP COLUMN b;
ALTER TABLE a DROP INDEX a_d, DROP PRIMARY KEY, ADD PRIMARY KEY (id);
ALTER TABLE z DROP FOREIGN KEY z_a, ADD CONSTRAINT z_a2 FOREIGN KEY (a_id) REFERENCES a (id) ON DELETE CASCADE;
RENAME TABLE a TO aa, z TO zz;
ALTER TABLE zz RENAME TO zzz, ENGINE = InnoDB, CONVERT TO CHARACTER SET utf8mb4, ALGORITHM=INPLACE;`, 'mysql');
        assert.deepEqual(shape(tables), { aa: 'first_col? id* after_b? c e?', zzz: 'id* a_id?' });
        assert.deepEqual(tableNamed(tables, 'aa').indexes, [{ columns: ['c'], type: 'index', name: 'a_b_c' }]);
        assert.deepEqual(tableNamed(tables, 'aa').columns.find(c => c.name === 'e'), { name: 'e', type: 'bigint', nullable: true, unsigned: true });
        assert.deepEqual(relationsOf(tables), ['zzz.a_id -> aa.id many-to-one cascade']);
    });

    it('CREATE TABLE ... LIKE copies the columns and indexes; DELIMITER and executable comments of mysqldump; USE and the name of the current database', () => {
        const { tables, warnings } = replayed(`/*!40101 SET NAMES utf8mb4 */;
CREATE DATABASE IF NOT EXISTS shop;
USE \`shop\`;
CREATE TABLE \`shop\`.\`orders\` (
  \`id\` int NOT NULL,
  /*!50705 \`place\` point NOT NULL /*!80003 SRID 4326 */,*/
  UNIQUE KEY \`orders_id\` (\`id\`)
) /*!50100 PARTITION BY HASH (id) */;
CREATE TABLE archive LIKE orders;
CREATE TABLE other.remote (id int);
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=\`root\`@\`localhost\`*/ /*!50003 TRIGGER t BEFORE INSERT ON orders FOR EACH ROW SET NEW.id = 1 */;;
DELIMITER ;`, 'mysql');
        assert.deepEqual(shape(tables), { orders: 'id place', archive: 'id place', 'other.remote': 'id?' });
        assert.deepEqual(tableNamed(tables, 'archive').columns[0], { name: 'id', type: 'int', unique: true });
        assert.deepEqual(warnings, []);
    });

    it('MySQL keeps a UNIQUE that repeats the primary key; ADD with several columns; an index is replaced by the one of the same name', () => {
        const { tables } = replayed(`CREATE TABLE a (id int UNIQUE PRIMARY KEY, b int, KEY a_b (b));
ALTER TABLE a ADD COLUMN (c int, d int), ADD UNIQUE INDEX a_b (b, c), ADD KEY a_cd (c, d) USING BTREE;`, 'mysql');
        assert.deepEqual(tables[0].columns.map(c => `${c.name}${c.unique ? '!' : ''}`), ['id!', 'b', 'c', 'd']);
        assert.deepEqual(tables[0].indexes, [{ columns: ['b', 'c'], type: 'unique', name: 'a_b' }, { columns: ['c', 'd'], type: 'index', name: 'a_cd' }]);
    });

    it('mysqldump --databases a b: the tables of the first database without its name, those of the others with theirs, as each USE tells', () => {
        const { tables, warnings } = replayed(`CREATE DATABASE /*!32312 IF NOT EXISTS*/ \`app1\`;
USE \`app1\`;
DROP TABLE IF EXISTS \`users\`;
CREATE TABLE \`users\` (\`id\` int NOT NULL, \`a1\` int, PRIMARY KEY (\`id\`)) ENGINE=InnoDB;
CREATE TABLE \`posts\` (\`id\` int NOT NULL, \`user_id\` int, PRIMARY KEY (\`id\`), CONSTRAINT \`posts_ibfk_1\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`)) ENGINE=InnoDB;
CREATE DATABASE /*!32312 IF NOT EXISTS*/ \`app2\`;
USE \`app2\`;
DROP TABLE IF EXISTS \`orders\`;
CREATE TABLE \`orders\` (\`id\` int NOT NULL, \`user_id\` int, \`buyer_id\` int, PRIMARY KEY (\`id\`), CONSTRAINT \`orders_ibfk_1\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`), CONSTRAINT \`orders_ibfk_2\` FOREIGN KEY (\`buyer_id\`) REFERENCES \`app1\`.\`users\` (\`id\`)) ENGINE=InnoDB;
DROP TABLE IF EXISTS \`users\`;
CREATE TABLE \`users\` (\`id\` int NOT NULL, \`a2\` int, PRIMARY KEY (\`id\`)) ENGINE=InnoDB;
ALTER TABLE app1.users ADD COLUMN extra int;`, 'mysql');
        // As MySQL 8.4 has them after the dump is loaded
        assert.deepEqual(shape(tables), { users: 'id* a1? extra?', posts: 'id* user_id?', 'app2.orders': 'id* user_id? buyer_id?', 'app2.users': 'id* a2?' });
        assert.deepEqual(relationsOf(tables), ['posts.user_id -> users.id many-to-one', 'app2.orders.user_id -> app2.users.id many-to-one', 'app2.orders.buyer_id -> users.id many-to-one']);
        assert.deepEqual(warnings, []);
    });

    it('mysqldump --all-databases: the databases of the server (mysql, sys...) are not drawn, and the first database of the user is the one without a name', () => {
        const { tables, warnings } = replayed(`CREATE DATABASE /*!32312 IF NOT EXISTS*/ \`mysql\`;
USE \`mysql\`;
CREATE TABLE \`user\` (\`Host\` char(255) NOT NULL, \`User\` char(32) NOT NULL, PRIMARY KEY (\`Host\`,\`User\`)) ENGINE=InnoDB;
INSERT INTO \`user\` VALUES ('localhost','root');
CREATE TABLE IF NOT EXISTS \`general_log\` (\`event_time\` timestamp(6) NOT NULL) ENGINE=CSV;
ALTER TABLE \`user\` ADD COLUMN \`x\` int;
CREATE DATABASE /*!32312 IF NOT EXISTS*/ \`app1\`;
USE \`app1\`;
CREATE TABLE \`users\` (\`id\` int NOT NULL, PRIMARY KEY (\`id\`)) ENGINE=InnoDB;
CREATE DATABASE /*!32312 IF NOT EXISTS*/ \`app2\`;
USE \`app2\`;
CREATE TABLE \`orders\` (\`id\` int NOT NULL, \`user_id\` int, PRIMARY KEY (\`id\`), CONSTRAINT \`orders_ibfk_1\` FOREIGN KEY (\`user_id\`) REFERENCES \`app1\`.\`users\` (\`id\`)) ENGINE=InnoDB;
CREATE TABLE sys.extra (id int) ENGINE=InnoDB;
CREATE TABLE performance_schema.extra (id int);
CREATE TABLE \`INFORMATION_SCHEMA\`.extra (id int);`, 'mysql');
        assert.deepEqual(shape(tables), { users: 'id*', 'app2.orders': 'id* user_id?' });
        assert.deepEqual(relationsOf(tables), ['app2.orders.user_id -> users.id many-to-one']);
        assert.deepEqual(warnings, []);
    });

    it('a REFERENCES written on a column is no foreign key on MySQL 8.4 (told), but one on MariaDB; an unnamed foreign key is <table>_ibfk_<n> after the highest one', () => {
        const text = `CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(100)) ENGINE=InnoDB;
CREATE TABLE posts (id INT PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE, author_id INT, FOREIGN KEY (author_id) REFERENCES users(id)) ENGINE=InnoDB;
ALTER TABLE posts ADD COLUMN editor_id INT REFERENCES users(id);`;
        const mysql = replayed(text, 'mysql');
        assert.deepEqual(relationsOf(mysql.tables), ['posts.author_id -> users.id many-to-one']);
        assert.deepEqual(mysql.warnings, [
            'schema.sql:2: posts.user_id: MySQL 8.4 ignores a REFERENCES written on the column (MariaDB creates the key), no relation drawn: FOREIGN KEY (user_id) REFERENCES ... creates one.',
            'schema.sql:3: posts.editor_id: MySQL 8.4 ignores a REFERENCES written on the column (MariaDB creates the key), no relation drawn: FOREIGN KEY (editor_id) REFERENCES ... creates one.',
        ]);
        // MariaDB: told by the header of its dump, or by the folder of the migrations
        const mariadb = ['posts.user_id -> users.id many-to-one cascade', 'posts.author_id -> users.id many-to-one', 'posts.editor_id -> users.id many-to-one'];
        assert.deepEqual(relationsOf(replayed(`-- MariaDB dump 10.19  Distrib 10.11.6-MariaDB, for debian-linux-gnu (x86_64)\n${text}`, 'mysql').tables), mariadb);
        const dir = project({ 'mariadb/migrations/1_init.sql': text });
        assert.deepEqual(relationsOf(parser.parse(path.join(dir, 'mariadb'), { git: false, details: true }).tables), mariadb);
        // MySQL 8.4 numbers the unnamed foreign keys after the highest one
        const { tables } = replayed(`CREATE TABLE a (id INT PRIMARY KEY) ENGINE=InnoDB;
CREATE TABLE t (id INT PRIMARY KEY, x INT, y INT, z INT, FOREIGN KEY (x) REFERENCES a(id), FOREIGN KEY (y) REFERENCES a(id)) ENGINE=InnoDB;
ALTER TABLE t DROP FOREIGN KEY t_ibfk_1;
ALTER TABLE t ADD FOREIGN KEY (z) REFERENCES a(id);
ALTER TABLE t DROP FOREIGN KEY t_ibfk_2;`, 'mysql');
        assert.deepEqual(relationsOf(tables), ['t.z -> a.id many-to-one']);
    });

    it('MySQL and MariaDB number the unnamed foreign keys of each statement from the highest one the table had before it: from 1 in a CREATE TABLE, in the order of the statement', () => {
        const text = `CREATE TABLE u (id INT PRIMARY KEY) ENGINE=InnoDB;
CREATE TABLE c3 (a INT, b INT, d INT, CONSTRAINT c3_ibfk_5 FOREIGN KEY (b) REFERENCES u(id), FOREIGN KEY (a) REFERENCES u(id), FOREIGN KEY (d) REFERENCES u(id)) ENGINE=InnoDB;
CREATE TABLE c4 (a INT, b INT, d INT, FOREIGN KEY (a) REFERENCES u(id), CONSTRAINT c4_ibfk_7 FOREIGN KEY (b) REFERENCES u(id), FOREIGN KEY (d) REFERENCES u(id)) ENGINE=InnoDB;
ALTER TABLE c4 ADD COLUMN e INT, ADD FOREIGN KEY (e) REFERENCES u(id);
CREATE TABLE c5 (a INT, b INT, d INT, FOREIGN KEY (a) REFERENCES u(id)) ENGINE=InnoDB;
ALTER TABLE c5 ADD CONSTRAINT c5_ibfk_9 FOREIGN KEY (b) REFERENCES u(id), ADD FOREIGN KEY (d) REFERENCES u(id);
CREATE TABLE c9 (a INT, FOREIGN KEY (a) REFERENCES u(id), d INT REFERENCES u(id), e INT, FOREIGN KEY (e) REFERENCES u(id)) ENGINE=InnoDB;
ALTER TABLE c3 DROP FOREIGN KEY c3_ibfk_1;
ALTER TABLE c4 DROP FOREIGN KEY c4_ibfk_8;
ALTER TABLE c4 DROP FOREIGN KEY c4_ibfk_2;
ALTER TABLE c5 DROP FOREIGN KEY c5_ibfk_2;
ALTER TABLE c9 DROP FOREIGN KEY c9_ibfk_2;`;
        const keys = (tables) => tables.flatMap(t => t.relations.map(r => `${t.table}.${r.foreignKey}`));
        // As MariaDB 11.8 (which creates the REFERENCES of c9.d) and MySQL 8.4 have them
        assert.deepEqual(keys(replayed(`-- MariaDB dump 10.19  Distrib 11.8.2-MariaDB\n${text}`, 'mysql').tables), ['c3.b', 'c3.d', 'c4.a', 'c4.b', 'c5.a', 'c5.b', 'c9.a', 'c9.e']);
        assert.deepEqual(keys(replayed(text, 'mysql').tables), ['c3.b', 'c3.d', 'c4.a', 'c4.b', 'c5.a', 'c5.b', 'c9.a']);
    });

    it('the names of the foreign keys as MySQL and MariaDB give them: CONSTRAINT without a name, a table renamed with its keys, the prefix as written, the index name of FOREIGN KEY idx', () => {
        const text = `CREATE TABLE u (id INT PRIMARY KEY) ENGINE=InnoDB;
CREATE TABLE c1 (id INT PRIMARY KEY, x INT, CONSTRAINT FOREIGN KEY (x) REFERENCES u(id)) ENGINE=InnoDB;
CREATE TABLE c2 (id INT PRIMARY KEY, x INT) ENGINE=InnoDB;
ALTER TABLE c2 ADD CONSTRAINT FOREIGN KEY (x) REFERENCES u(id);
CREATE TABLE old_orders (id INT PRIMARY KEY, x INT, y INT, FOREIGN KEY (x) REFERENCES u(id)) ENGINE=InnoDB;
ALTER TABLE old_orders RENAME TO orders;
ALTER TABLE orders ADD FOREIGN KEY (y) REFERENCES u(id);
ALTER TABLE orders DROP FOREIGN KEY orders_ibfk_1;
CREATE TABLE r1 (id INT PRIMARY KEY, x INT, y INT, FOREIGN KEY (x) REFERENCES u(id)) ENGINE=InnoDB;
RENAME TABLE r1 TO r2;
ALTER TABLE r2 ADD FOREIGN KEY (y) REFERENCES u(id);
ALTER TABLE r2 DROP FOREIGN KEY r2_ibfk_2;
CREATE TABLE a4 (id INT PRIMARY KEY, x INT, y INT, CONSTRAINT A4_IBFK_3 FOREIGN KEY (x) REFERENCES u(id)) ENGINE=InnoDB;
ALTER TABLE a4 ADD FOREIGN KEY (y) REFERENCES u(id);
ALTER TABLE a4 DROP FOREIGN KEY a4_ibfk_1;
CREATE TABLE a3 (id INT PRIMARY KEY, x INT, y INT, FOREIGN KEY fk_named_idx (y) REFERENCES u(id), FOREIGN KEY (x) REFERENCES u(id)) ENGINE=InnoDB;`;
        const names = (dump) => {
            const state = parser.replay([{ path: path.join(BASE, 'schema.sql'), rel: 'schema.sql', text: dump, sections: null }]);
            return [...state.tables.values()].flatMap(table => table.foreignKeys.map(fk => `${table.ref.name}.${fk.columns.join()} ${fk.name}`));
        };
        // As MySQL 8.4.11 names them (a3_ibfk_1 is y's, dropped)
        assert.deepEqual(names(`${text}\nALTER TABLE a3 DROP FOREIGN KEY a3_ibfk_1;`), ['c1.x c1_ibfk_1', 'c2.x c2_ibfk_1', 'orders.y orders_ibfk_2', 'r2.x r2_ibfk_1', 'a4.x A4_IBFK_3', 'a3.x a3_ibfk_2']);
        // As MariaDB 11.8.9 names them: FOREIGN KEY fk_named_idx is the name of the key
        assert.deepEqual(names(`-- MariaDB dump 10.19  Distrib 10.11.6-MariaDB\n${text}`), ['c1.x c1_ibfk_1', 'c2.x c2_ibfk_1', 'orders.y orders_ibfk_2', 'r2.x r2_ibfk_1', 'a4.x A4_IBFK_3', 'a3.y fk_named_idx', 'a3.x a3_ibfk_1']);
        // The unnamed CONSTRAINT UNIQUE and CHECK too, on a table and on a column
        const { tables, warnings } = replayed('CREATE TABLE u (id INT PRIMARY KEY) ENGINE=InnoDB;\nCREATE TABLE c3 (id INT PRIMARY KEY, x INT, y INT, z INT CONSTRAINT CHECK (z > 0), CONSTRAINT UNIQUE (y), CONSTRAINT UNIQUE KEY uz (z), CONSTRAINT CHECK (x > 0), CONSTRAINT FOREIGN KEY (x) REFERENCES u(id)) ENGINE=InnoDB;', 'mysql');
        assert.deepEqual(tableNamed(tables, 'c3').columns.map(column => [column.name, Boolean(column.unique)]), [['id', false], ['x', false], ['y', true], ['z', true]]);
        assert.deepEqual(relationsOf(tables), ['c3.x -> u.id many-to-one']);
        assert.deepEqual(warnings, []);
    });
});

// ---------------------------------------------------------------------------------------------

describe('sql parser: SQLite', () => {
    it('INTEGER PRIMARY KEY (the rowid) is NOT NULL, other primary keys accept NULL unless WITHOUT ROWID; untyped columns; brackets; AUTOINCREMENT', () => {
        const { tables } = replayed(`CREATE TABLE a ([id] INTEGER PRIMARY KEY AUTOINCREMENT, "b", \`c\` TEXT NOT NULL ON CONFLICT REPLACE);
CREATE TABLE b (code TEXT PRIMARY KEY, n INTEGER);
CREATE TABLE c (x INTEGER, y INTEGER, PRIMARY KEY (x, y));
CREATE TABLE d (k TEXT PRIMARY KEY, v BLOB) WITHOUT ROWID, STRICT;
CREATE TABLE e (id integer not null primary key, t datetime default (datetime('now')) not null);`, 'sqlite');
        assert.deepEqual(shape(tables), { a: 'id* b? c', b: 'code?* n?', c: 'x?* y?*', d: 'k* v?', e: 'id* t' });
        assert.deepEqual(tables[0].columns, [{ name: 'id', type: 'integer', primary: true, autoIncrement: true }, { name: 'b', type: '', nullable: true }, { name: 'c', type: 'text' }]);
        assert.deepEqual(tableNamed(tables, 'e').columns[1], { name: 't', type: 'datetime', defaultRaw: "(datetime('now'))" });
    });

    it('the rebuilt tables of prisma migrate and drizzle-kit: the foreign keys of the other tables follow the renamed table; indexes on schema.name', () => {
        const { tables } = replayed(`CREATE TABLE "User" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "name" TEXT);
CREATE TABLE "Post" ("id" INTEGER NOT NULL PRIMARY KEY, "authorId" INTEGER NOT NULL REFERENCES "User" ("id"));
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL, "email" TEXT);
INSERT INTO "new_User" ("id", "name") SELECT "id", "name" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX main.User_email_key ON "User"("email");
PRAGMA foreign_keys=ON;
CREATE TABLE __new_post (id integer PRIMARY KEY NOT NULL, title text);
DROP TABLE Post;
ALTER TABLE __new_post RENAME TO Post;
ALTER TABLE Post RENAME COLUMN title TO subject;`, 'sqlite');
        assert.deepEqual(shape(tables), { User: 'id* name email?', Post: 'id* subject?' });
        assert.equal(tables[0].columns[2].unique, true);
    });

    it('triggers and virtual tables (FTS) are no tables; libSQL ALTER COLUMN ... TO (drizzle-kit for Turso)', () => {
        const { tables, warnings } = replayed(`CREATE TABLE t (id integer PRIMARY KEY, body text);
CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN INSERT INTO t_fts (rowid, body) VALUES (new.id, new.body); END;
CREATE VIRTUAL TABLE t_fts USING fts5(body, content='t');
ALTER TABLE t ALTER COLUMN "body" TO "text" text NOT NULL DEFAULT '';`, 'sqlite');
        assert.deepEqual(tables[0].columns, [{ name: 'id', type: 'integer', primary: true }, { name: 'text', type: 'text', default: '' }]);
        assert.deepEqual(warnings, []);
    });

    it('PRIMARY KEY (id) of an INTEGER column is the rowid too, NOT NULL; INTEGER PRIMARY KEY DESC and INTEGER(11) are not', () => {
        const { tables } = replayed(`CREATE TABLE a (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE b (id INTEGER, name TEXT, PRIMARY KEY (id));
CREATE TABLE c (id INTEGER PRIMARY KEY DESC, name TEXT);
CREATE TABLE d (id INTEGER, name TEXT, PRIMARY KEY (id DESC));
CREATE TABLE e (id INT, name TEXT, PRIMARY KEY (id));
CREATE TABLE f (a INTEGER, b INTEGER, PRIMARY KEY (a, b));
CREATE TABLE h (id INTEGER(11) PRIMARY KEY, name TEXT);
CREATE TABLE i (id INTEGER UNSIGNED PRIMARY KEY, name TEXT);
CREATE TABLE j (id INTEGER UNSIGNED, name TEXT, PRIMARY KEY (id));
CREATE TABLE k (id INTEGER SIGNED PRIMARY KEY, name TEXT);
CREATE TABLE l (id "INTEGER", name TEXT, PRIMARY KEY (id));
CREATE TABLE m (id integer PRIMARY KEY, name TEXT);`, 'sqlite');
        // As sqlite3 stores a NULL id: the rowid (a type that is INTEGER alone), or NULL
        assert.deepEqual(shape(tables), { a: 'id* name?', b: 'id* name?', c: 'id?* name?', d: 'id* name?', e: 'id?* name?', f: 'a?* b?*', h: 'id?* name?', i: 'id?* name?', j: 'id?* name?', k: 'id?* name?', l: 'id* name?', m: 'id* name?' });
    });
});

// ---------------------------------------------------------------------------------------------

describe('sql parser: warnings', () => {
    it('only for what could change tables, with the file and the line: tables that no file creates, columns that do not exist, statements not understood', () => {
        const { tables, warnings } = replayed(`CREATE TABLE t (id int);
ALTER TABLE ghosts ADD COLUMN name text;
ALTER TABLE phantoms ALTER COLUMN x SET NOT NULL;
ALTER TABLE phantoms ENABLE ROW LEVEL SECURITY;
ALTER TABLE t ALTER COLUMN missing SET NOT NULL, DROP COLUMN gone, RENAME COLUMN absent TO present;
ALTER TABLE t ADD COLUMN id int;
ALTER TABLE t FROBNICATE;
CREATE TABLE t (id bigint);
CREATE TABLE IF NOT EXISTS t (other int);
CREATE TABLE copy AS SELECT * FROM t;
CREATE TABLE typed OF some_type;
CREATE TABLE like_ghost (LIKE ghosts_too);
CREATE INDEX ON unknown_table (id);
DROP TABLE nope;
DROP TABLE IF EXISTS nope;
CREATE TABLE ;
CREATE TABLE broken (id int, CONSTRAINT x FOREIGN KEY (id));
CREATE UNIQUE INDEX bad;`);
        // A table whose LIKE could not be read is created with its other columns
        assert.deepEqual(shape(tables), { ghosts: 'name?', t: 'id?', like_ghost: '', broken: 'id?' });
        assert.deepEqual(warnings, [
            'schema.sql:2: ALTER TABLE ghosts on a table that no file creates: table added.',
            'schema.sql:3: ALTER TABLE phantoms: no file creates this table, skipped.',
            'schema.sql:5: ALTER TABLE t: column missing does not exist, ALTER COLUMN skipped.',
            'schema.sql:5: ALTER TABLE t: column gone does not exist, DROP COLUMN skipped.',
            'schema.sql:5: ALTER TABLE t: column absent does not exist, RENAME COLUMN skipped.',
            'schema.sql:6: ALTER TABLE t: column id already exists, ADD COLUMN skipped.',
            'schema.sql:7: ALTER TABLE t: FROBNICATE not understood, skipped.',
            'schema.sql:8: table t is created again, its previous definition is replaced.',
            'schema.sql:10: CREATE TABLE copy AS ... skipped: its columns come from a query.',
            'schema.sql:11: CREATE TABLE typed OF ... skipped: its columns come from a type.',
            'schema.sql:12: CREATE TABLE like_ghost: LIKE a table that no file creates, skipped.',
            'schema.sql:13: CREATE INDEX on unknown_table: no file creates this table, skipped.',
            'schema.sql:14: DROP TABLE nope: no file creates this table, skipped.',
            'schema.sql:16: CREATE TABLE not understood, skipped: CREATE TABLE',
            'schema.sql:17: CREATE TABLE broken: constraint not understood, skipped: CONSTRAINT x FOREIGN KEY (id)',
            'schema.sql:18: CREATE INDEX not understood, skipped: CREATE UNIQUE INDEX bad',
        ]);
        assert.deepEqual(tableNamed(tables, 't').columns, [{ name: 'id', type: 'bigint', nullable: true }], 'the second definition');
    });

    it('a long statement is shown up to 60 characters; the problems of a file come after its statements', () => {
        const { warnings } = replayed(`ALTER TABLE t1 ADD x int;\nALTER TABLE t1 ${'ALTER COLUMN x DO SOMETHING VERY LONG AND UNKNOWN '.repeat(3)};\nSELECT 'never closed;\n`);
        assert.deepEqual(warnings, [
            'schema.sql:1: ALTER TABLE t1 on a table that no file creates: table added.',
            'schema.sql:2: ALTER TABLE t1: ALTER COLUMN x DO SOMETHING VERY LONG AND UNKNOWN ALTER COLU... not understood, skipped.',
            'schema.sql:3: string not closed: the end of the file is skipped.',
        ]);
    });

    it('a REFERENCES that cannot be read, a BEGIN that no END closes: told, not passed over in silence', () => {
        const { tables, warnings } = replayed('CREATE TABLE a (id int PRIMARY KEY);\nCREATE TABLE b (id int, a_id int REFERENCES (id));\nCREATE TRIGGER t AFTER INSERT ON a BEGIN\n  SELECT 1;\nCREATE TABLE c (id int);\n', 'sqlite');
        assert.deepEqual(shape(tables), { a: 'id?*', b: 'id? a_id?' });
        assert.deepEqual(warnings, [
            'schema.sql:2: column a_id: REFERENCES not understood, no relation drawn: REFERENCES (id)',
            'schema.sql:3: a BEGIN that no END closes: the end of the file is read as the body of this statement.',
        ]);
    });
});

// ---------------------------------------------------------------------------------------------

describe('sql parser: source lines, git status and unsaved editors', () => {
    const INIT = 'CREATE TABLE users (\n  id bigint PRIMARY KEY,\n  email text NOT NULL\n);\n\nCREATE TABLE posts (\n  id bigint PRIMARY KEY,\n  author_id bigint REFERENCES users (id)\n);\n';
    const statuses = (result) => result.tables.map(t => [t.table, t.git, ...t.columns.map(c => `${c.name}=${c.git}`)]);
    const migration = (name) => path.join('supabase', 'migrations', name);

    it('the line of the CREATE TABLE for the table, of the column definition, or of the last statement of another migration that changed or renamed it', () => {
        const dir = project({
            [migration('1_init.sql')]: `${INIT}ALTER TABLE users ALTER COLUMN email TYPE varchar(200);\n`,
            [migration('2_more.sql')]: 'ALTER TABLE users ADD COLUMN name text;\nALTER TABLE posts ALTER COLUMN author_id SET NOT NULL;\nALTER TABLE posts RENAME COLUMN author_id TO user_id;\n',
        });
        const { tables } = parser.parse(dir, { git: false, columnSources: true });
        assert.deepEqual(tables.map(t => [t.source, ...t.columns.map(c => `${c.name}@${c.source.file.slice(-10)}:${c.source.line}`)]), [
            [{ file: 'supabase/migrations/1_init.sql', line: 1 }, 'id@1_init.sql:2', 'email@1_init.sql:3', 'name@2_more.sql:1'],
            [{ file: 'supabase/migrations/1_init.sql', line: 6 }, 'id@1_init.sql:7', 'user_id@2_more.sql:3'],
        ]);
        assert.ok(parser.parse(dir, { git: false }).tables.every(t => t.columns.every(c => c.source === undefined)));
    });

    it('git status: committed, a new migration marks the tables it changes modified and its columns new, a migration that is not committed is new', () => {
        const dir = project({ [migration('1_init.sql')]: INIT });
        git(dir, 'init', '-q');
        assert.deepEqual(statuses(parser.parse(dir)), [
            ['users', 'untracked', 'id=untracked', 'email=untracked'],
            ['posts', 'untracked', 'id=untracked', 'author_id=untracked'],
        ], 'no commit yet');
        commitAll(dir);
        assert.deepEqual(statuses(parser.parse(dir)), [
            ['users', 'committed', 'id=committed', 'email=committed'],
            ['posts', 'committed', 'id=committed', 'author_id=committed'],
        ]);
        writeFiles(dir, { [migration('2_more.sql')]: 'ALTER TABLE users ADD COLUMN name text;\nCREATE INDEX posts_author ON posts (author_id);\nCREATE TABLE tags (id int);\n' });
        assert.deepEqual(statuses(parser.parse(dir)), [
            ['users', 'modified', 'id=committed', 'email=committed', 'name=untracked'],
            ['posts', 'modified', 'id=committed', 'author_id=committed'],
            ['tags', 'untracked', 'id=untracked'],
        ]);
        // A dropped column: its table is modified
        commitAll(dir);
        writeFiles(dir, { [migration('3_drop.sql')]: 'ALTER TABLE users DROP COLUMN name;\n' });
        assert.deepEqual(statuses(parser.parse(dir))[0], ['users', 'modified', 'id=committed', 'email=committed']);
    });

    it('a dump: a changed line of a table, or of a later ALTER TABLE of the same file, marks it modified; a table added to the committed file is new, with its columns', () => {
        const dump = `${INIT}\nALTER TABLE ONLY users ALTER COLUMN id SET DEFAULT nextval('users_id_seq'::regclass);\n`;
        const dir = project({ 'db/structure.sql': dump });
        git(dir, 'init', '-q');
        commitAll(dir);
        const file = path.join(dir, 'db', 'structure.sql');
        fs.writeFileSync(file, dump.replace("nextval('users_id_seq'::regclass)", "nextval('users_id_seq2'::regclass)").replace('CREATE TABLE posts', 'CREATE TABLE drafts (\n  id bigint,\n  body text\n);\n\nCREATE TABLE posts'));
        assert.deepEqual(statuses(parser.parse(dir)), [
            ['users', 'modified', 'id=modified', 'email=committed'],
            ['drafts', 'untracked', 'id=untracked', 'body=untracked'],
            ['posts', 'committed', 'id=committed', 'author_id=committed'],
        ]);
        // The source of a column stays its definition, not the ALTER TABLE at the end of the dump
        assert.deepEqual(parser.parse(dir, { git: false, columnSources: true }).tables[0].columns[0].source, { file: 'db/structure.sql', line: 2 });
    });

    it('unsaved editors: the text of a migration being typed is read, its new lines are unsaved; without git, only them', () => {
        const dir = project({ [migration('1_init.sql')]: INIT });
        git(dir, 'init', '-q');
        commitAll(dir);
        const file = path.join(dir, migration('1_init.sql'));
        const typed = INIT.replace('  email text NOT NULL\n', '  email text NOT NULL,\n  bio text\n');
        assert.deepEqual(statuses(parser.parse(dir, { overrides: new Map([[file, typed]]) })), [
            ['users', 'unsaved', 'id=committed', 'email=unsaved', 'bio=unsaved'],
            ['posts', 'committed', 'id=committed', 'author_id=committed'],
        ]);
        assert.deepEqual(statuses(parser.parse(dir, { overrides: new Map([[file, typed]]), git: false })), [
            ['users', 'unsaved', 'id=undefined', 'email=unsaved', 'bio=unsaved'],
            ['posts', undefined, 'id=undefined', 'author_id=undefined'],
        ]);
    });

    it('the git cache is reused until it is cleared; git: false gives no git keys; a folder outside a repository neither, without warning', () => {
        const dir = project({ [migration('1_init.sql')]: INIT });
        git(dir, 'init', '-q');
        commitAll(dir);
        const gitCache = new Map();
        assert.equal(parser.parse(dir, { gitCache }).tables[0].git, 'committed');
        assert.equal(gitCache.size, 1);
        writeFiles(dir, { [migration('2_tags.sql')]: 'CREATE TABLE tags (id int);\n' });
        assert.equal(parser.parse(dir, { gitCache }).tables[2].git, 'committed', 'the cache is kept');
        assert.equal(parser.parse(dir, { gitCache: new Map() }).tables[2].git, 'untracked');
        assert.ok(parser.parse(dir, { git: false }).tables.every(t => t.git === undefined && t.columns.every(c => c.git === undefined)));
        const outside = parser.parse(project({ [migration('1_init.sql')]: INIT }));
        assert.deepEqual(outside.warnings, []);
        assert.ok(outside.tables.every(t => t.git === undefined));
    });
});

// ---------------------------------------------------------------------------------------------

describe('sql parser: until (the schema right after a migration)', () => {
    it('a file name, the folder of a migration, or a path from the migrations folder; a name between two migrations; before the first one, no table', () => {
        const dir = project({
            'migrations/1_a.up.sql': 'CREATE TABLE a (id int);\n',
            'migrations/2_b.up.sql': 'CREATE TABLE b (id int);\n',
            'migrations/10_c.up.sql': 'CREATE TABLE c (id int);\n',
        });
        const after = (until) => parser.parse(dir, { git: false, until }).tables.map(t => t.table);
        assert.deepEqual(after('1_a.up.sql'), ['a']);
        assert.deepEqual(after('2_b.up.sql'), ['a', 'b']);
        assert.deepEqual(after('10_c.up.sql'), ['a', 'b', 'c']);
        assert.deepEqual(after('3_x.up.sql'), ['a', 'b'], 'by the version number of the tool');
        assert.deepEqual(after('0_before.up.sql'), []);
        const prisma = project({ 'prisma/migrations/20240101_a/migration.sql': 'CREATE TABLE a (id int);\n', 'prisma/migrations/20240102_b/migration.sql': 'CREATE TABLE b (id int);\n' });
        assert.deepEqual(parser.parse(prisma, { git: false, until: '20240101_a' }).tables.map(t => t.table), ['a']);
        assert.deepEqual(parser.parse(prisma, { git: false, until: '20240101_a/migration.sql' }).tables.map(t => t.table), ['a']);
        const flyway = project({ 'db/migration/V1__a.sql': 'CREATE TABLE a (id int);\n', 'db/migration/V1_5__b.sql': 'CREATE TABLE b (id int);\n', 'db/migration/V10__c.sql': 'CREATE TABLE c (id int);\n' });
        assert.deepEqual(parser.parse(flyway, { git: false, until: 'V2__x.sql' }).tables.map(t => t.table), ['a', 'b']);
    });
});

// ---------------------------------------------------------------------------------------------

describe('sql parser: robustness', () => {
    it('nesting 20000 deep, a 200k-character string, 50000 columns, files not closed: read quickly, without a stack overflow', () => {
        const inputs = [
            `CREATE TABLE d (a int DEFAULT ${'('.repeat(20000)}1${')'.repeat(20000)}, b int CHECK ${'('.repeat(20000)}1${')'.repeat(20000)}, c int);`,
            `DO $$ BEGIN ${'IF x THEN '.repeat(5000)}CREATE TABLE z (id int); ${'END IF; '.repeat(5000)}END $$;`,
            `CREATE TABLE w (a text DEFAULT '${'x'.repeat(200000)}', b int);`,
            `CREATE TABLE g (${'a int, '.repeat(50000)}b int);`,
            `CREATE TABLE o (a text DEFAULT 'never closed, b int);\n${'CREATE TABLE p (id int);\n'.repeat(2000)}`,
        ];
        const started = Date.now();
        const results = inputs.map(text => replayed(text));
        assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
        assert.deepEqual(results.map(r => shape(r.tables)), [{ d: 'a? b? c?' }, { z: 'id?' }, { w: 'a? b?' }, { g: 'a? b?' }, { o: 'a?' }]);
    });

    it('a dump of 60 MB of data (mysqldump, pg_dump --inserts, COPY, sqlite3 .dump): its tables in a few hundred milliseconds, without holding its data as tokens', () => {
        const build = (head, count, row, tail) => {
            const parts = [head];
            for (let k = 0; k < count; k++) {
                parts.push(row(k));
            }
            parts.push(tail);
            return parts.join('');
        };
        // Strings with what would end a statement or start a comment, and the table names of the schema
        const rows = (k) => Array.from({ length: 50 }, (_, n) => `(${k * 50 + n},'it\\'s ${n}; -- no /* no */ # no \\\\ CREATE TABLE fake (id int);',${n}.5,NULL)`).join(',');
        const dumps = [
            ['mysql', build('CREATE TABLE `a` (`id` int NOT NULL, `b` text, `c` double, `d` int, PRIMARY KEY (`id`)) ENGINE=InnoDB;\nLOCK TABLES `a` WRITE;\n/*!40000 ALTER TABLE `a` DISABLE KEYS */;\n', 8000, k => `INSERT INTO \`a\` VALUES ${rows(k)};\n`,
                '/*!40000 ALTER TABLE `a` ENABLE KEYS */;\nUNLOCK TABLES;\nCREATE TABLE `z` (`id` int NOT NULL, `a_id` int, PRIMARY KEY (`id`), CONSTRAINT `z_a` FOREIGN KEY (`a_id`) REFERENCES `a` (`id`)) ENGINE=InnoDB;\n')],
            ['postgresql', build('CREATE TABLE public.a (id integer NOT NULL, b text, c double precision, d integer);\n', 200000, k => `INSERT INTO public.a VALUES (${k}, 'it''s ${k}; -- no /* no */ $$ CREATE TABLE fake (id int);', ${k}.5, NULL);\n`,
                'ALTER TABLE ONLY public.a ADD CONSTRAINT a_pkey PRIMARY KEY (id);\nCREATE TABLE public.z (id integer PRIMARY KEY, a_id integer REFERENCES public.a(id));\n')],
            ['postgresql', build('CREATE TABLE public.a (id integer NOT NULL, b text, c double precision, d integer);\nCOPY public.a (id, b, c, d) FROM stdin;\n', 400000, k => `${k}\tit's ${k}; -- no \\\\.\tCREATE TABLE fake (id int);\t\\N\n`,
                '\\.\n\nALTER TABLE ONLY public.a ADD CONSTRAINT a_pkey PRIMARY KEY (id);\nCREATE TABLE public.z (id integer PRIMARY KEY, a_id integer REFERENCES public.a(id));\n')],
            ['sqlite', build('PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE a (id INTEGER PRIMARY KEY, b TEXT, c REAL, d INTEGER);\n', 250000, k => `INSERT INTO a VALUES(${k},'it''s ${k}; -- no /* no */ [no CREATE TABLE fake (id int);',${k}.5,NULL);\n`,
                'CREATE TABLE z (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id));\nCOMMIT;\n')],
        ];
        assert.ok(dumps.reduce((size, [, text]) => size + text.length, 0) > 60e6);
        const before = process.memoryUsage().rss;
        const started = Date.now();
        const results = dumps.map(([dialect, text]) => replayed(text, dialect));
        const elapsed = Date.now() - started;
        const grown = (process.memoryUsage().rss - before) / 1048576;
        for (const result of results) {
            assert.deepEqual(shape(result.tables), { a: 'id* b? c? d?', z: 'id* a_id?' });
            assert.deepEqual(relationsOf(result.tables), ['z.a_id -> a.id many-to-one']);
            assert.deepEqual(result.warnings, []);
        }
        assert.ok(elapsed < 1500, `${elapsed} ms`);
        assert.ok(grown < 256, `${Math.round(grown)} MB more`);
    });

    it('a UTF-8 byte order mark and CRLF line endings', () => {
        const dir = project({ 'schema.sql': '\uFEFFCREATE TABLE a (\r\n  id int PRIMARY KEY,\r\n  name text\r\n);\r\n' });
        assert.deepEqual(parser.parse(dir, { git: false, columnSources: true }).tables[0], {
            table: 'a',
            columns: [{ name: 'id', type: 'int', primary: true, source: { file: 'schema.sql', line: 2 } }, { name: 'name', type: 'text', nullable: true, source: { file: 'schema.sql', line: 3 } }],
            relations: [],
            source: { file: 'schema.sql', line: 1 },
        });
    });

    it('does not depend on vscode, and never runs the SQL nor a file of the project', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', '..', 'parsers', 'sql.js'), 'utf8');
        assert.doesNotMatch(source, /require\(['"]vscode['"]\)/);
        assert.doesNotMatch(source, /child_process|\beval\(|new Function|vm\.|import\(/);
    });
});

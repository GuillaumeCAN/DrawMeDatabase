const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parse } = require('../../parsers/laravel');
const { ParserError } = require('../../parsers/errors');

const fixture = (name) => path.join(__dirname, '..', 'fixtures', 'laravel', name);

// Expected column: c('id', 'bigIncrements', 'pk'), c('bio', 'text', 'null')
function c(name, type, ...flags) {
    const column = { name, type };
    if (flags.includes('pk')) {
        column.primary = true;
    }
    if (flags.includes('null')) {
        column.nullable = true;
    }
    return column;
}

const rel = (foreignKey, on, references = 'id', type = 'many-to-one') => ({ foreignKey, references, on, type });
const oneToOne = (foreignKey, on, references = 'id') => rel(foreignKey, on, references, 'one-to-one');

// Temporary Laravel project holding the given migrations ({ fileName: phpSource })
const tempDirs = [];
function project(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmdb-laravel-'));
    tempDirs.push(dir);
    const migrations = path.join(dir, 'database', 'migrations');
    fs.mkdirSync(migrations, { recursive: true });
    for (const [name, source] of Object.entries(files)) {
        fs.writeFileSync(path.join(migrations, name), source);
    }
    return dir;
}
after(() => tempDirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

// Anonymous-class migration with the given up() and down() bodies
const migration = (up, down = '') => `<?php

use App\\Models\\User;
use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
${up}
    }

    public function down(): void
    {
${down}
    }
};
`;

// Parses migrations given as up() bodies, run in the given order
function parseUp(...ups) {
    const files = {};
    ups.forEach((up, i) => {
        files[`2025_01_${String(i + 1).padStart(2, '0')}_000000_migration_${i + 1}.php`] = migration(up);
    });
    return parse(project(files));
}

const table = (result, name) => result.tables.find(t => t.table === name);

const LARAVEL_13_TABLES = [
    {
        table: 'users',
        columns: [
            c('id', 'bigIncrements', 'pk'), c('name', 'string'), c('email', 'string'),
            c('email_verified_at', 'timestamp', 'null'), c('password', 'string'), c('remember_token', 'string', 'null'),
            c('created_at', 'timestamp', 'null'), c('updated_at', 'timestamp', 'null'),
        ],
        relations: [],
    },
    {
        table: 'password_reset_tokens',
        columns: [c('email', 'string', 'pk'), c('token', 'string'), c('created_at', 'timestamp', 'null')],
        relations: [],
    },
    {
        table: 'sessions',
        columns: [
            c('id', 'string', 'pk'), c('user_id', 'foreignId', 'null'), c('ip_address', 'string', 'null'),
            c('user_agent', 'text', 'null'), c('payload', 'longText'), c('last_activity', 'integer'),
        ],
        relations: [],
    },
    {
        table: 'cache',
        columns: [c('key', 'string', 'pk'), c('value', 'mediumText'), c('expiration', 'bigInteger')],
        relations: [],
    },
    {
        table: 'cache_locks',
        columns: [c('key', 'string', 'pk'), c('owner', 'string'), c('expiration', 'bigInteger')],
        relations: [],
    },
    {
        table: 'jobs',
        columns: [
            c('id', 'bigIncrements', 'pk'), c('queue', 'string'), c('payload', 'longText'),
            c('attempts', 'unsignedSmallInteger'), c('reserved_at', 'unsignedInteger', 'null'),
            c('available_at', 'unsignedInteger'), c('created_at', 'unsignedInteger'),
        ],
        relations: [],
    },
    {
        table: 'job_batches',
        columns: [
            c('id', 'string', 'pk'), c('name', 'string'), c('total_jobs', 'integer'), c('pending_jobs', 'integer'),
            c('failed_jobs', 'integer'), c('failed_job_ids', 'longText'), c('options', 'mediumText', 'null'),
            c('cancelled_at', 'integer', 'null'), c('created_at', 'integer'), c('finished_at', 'integer', 'null'),
        ],
        relations: [],
    },
    {
        table: 'failed_jobs',
        columns: [
            c('id', 'bigIncrements', 'pk'), c('uuid', 'string'), c('connection', 'string'), c('queue', 'string'),
            c('payload', 'longText'), c('exception', 'longText'), c('failed_at', 'timestamp'),
        ],
        relations: [],
    },
];

describe('laravel parser: fixtures', () => {
    it('parses the Laravel 13 default migrations', () => {
        assert.deepEqual(parse(fixture('laravel13-default')), { tables: LARAVEL_13_TABLES, warnings: [] });
    });

    it('parses a typical app (constrained foreign ids, foreignIdFor, pivot, morphs, soft deletes)', () => {
        assert.deepEqual(parse(fixture('blog-app')), {
            tables: [
                ...LARAVEL_13_TABLES,
                {
                    table: 'categories',
                    columns: [
                        c('id', 'bigIncrements', 'pk'), c('parent_id', 'foreignId', 'null'), c('name', 'string'),
                        c('slug', 'string'), c('created_at', 'timestamp', 'null'), c('updated_at', 'timestamp', 'null'),
                    ],
                    relations: [rel('parent_id', 'categories')],
                },
                {
                    table: 'posts',
                    columns: [
                        c('id', 'bigIncrements', 'pk'), c('user_id', 'foreignId'), c('category_id', 'foreignId', 'null'),
                        c('title', 'string'), c('slug', 'string'), c('body', 'longText'), c('status', 'enum'),
                        c('published_at', 'timestamp', 'null'), c('deleted_at', 'timestamp', 'null'),
                        c('created_at', 'timestamp', 'null'), c('updated_at', 'timestamp', 'null'),
                    ],
                    relations: [rel('user_id', 'users'), rel('category_id', 'categories')],
                },
                {
                    table: 'comments',
                    columns: [
                        c('id', 'bigIncrements', 'pk'), c('post_id', 'foreignId'), c('author_id', 'foreignId', 'null'),
                        c('reply_to_id', 'foreignId', 'null'), c('body', 'text'), c('is_approved', 'boolean'),
                        c('created_at', 'timestamp', 'null'), c('updated_at', 'timestamp', 'null'),
                    ],
                    relations: [rel('post_id', 'posts'), rel('author_id', 'users'), rel('reply_to_id', 'comments')],
                },
                {
                    table: 'tags',
                    columns: [
                        c('id', 'bigIncrements', 'pk'), c('name', 'string'),
                        c('created_at', 'timestamp', 'null'), c('updated_at', 'timestamp', 'null'),
                    ],
                    relations: [],
                },
                {
                    table: 'post_tag',
                    columns: [c('post_id', 'foreignId', 'pk'), c('tag_id', 'foreignId', 'pk')],
                    relations: [rel('post_id', 'posts'), rel('tag_id', 'tags')],
                },
                {
                    table: 'images',
                    columns: [
                        c('id', 'uuid', 'pk'), c('imageable_type', 'string'), c('imageable_id', 'unsignedBigInteger'),
                        c('path', 'string'), c('size', 'unsignedInteger'), c('metadata', 'json', 'null'),
                        c('created_at', 'timestamp', 'null'), c('updated_at', 'timestamp', 'null'),
                    ],
                    relations: [],
                },
                {
                    table: 'profiles',
                    columns: [
                        c('id', 'bigIncrements', 'pk'), c('user_id', 'foreignId'), c('website', 'string', 'null'),
                        c('bio', 'text', 'null'), c('created_at', 'timestamp', 'null'), c('updated_at', 'timestamp', 'null'),
                    ],
                    relations: [oneToOne('user_id', 'users')],
                },
                {
                    table: 'personal_access_tokens',
                    columns: [
                        c('id', 'bigIncrements', 'pk'), c('tokenable_type', 'string'), c('tokenable_id', 'unsignedBigInteger'),
                        c('name', 'text'), c('token', 'string'), c('abilities', 'text', 'null'),
                        c('last_used_at', 'timestamp', 'null'), c('expires_at', 'timestamp', 'null'),
                        c('created_at', 'timestamp', 'null'), c('updated_at', 'timestamp', 'null'),
                    ],
                    relations: [],
                },
            ],
            warnings: [],
        });
    });

    it('parses a legacy (pre Laravel 8) project with named classes and foreign()->references()->on()', () => {
        assert.deepEqual(parse(fixture('legacy-app')), {
            tables: [
                {
                    table: 'users',
                    columns: [
                        c('id', 'increments', 'pk'), c('name', 'string'), c('email', 'string'), c('password', 'string'),
                        c('remember_token', 'string', 'null'), c('created_at', 'timestamp', 'null'),
                        c('updated_at', 'timestamp', 'null'), c('phone', 'string', 'null'),
                    ],
                    relations: [],
                },
                {
                    table: 'password_resets',
                    columns: [c('email', 'string'), c('token', 'string'), c('created_at', 'timestamp', 'null')],
                    relations: [],
                },
                {
                    table: 'orders',
                    columns: [
                        c('id', 'increments', 'pk'), c('user_id', 'integer'), c('shipper_id', 'unsignedInteger', 'null'),
                        c('courier_id', 'unsignedInteger', 'null'), c('total', 'decimal'),
                        c('created_at', 'timestamp', 'null'), c('updated_at', 'timestamp', 'null'),
                        c('reference', 'string', 'null'),
                    ],
                    relations: [rel('user_id', 'users'), rel('shipper_id', 'users'), rel('courier_id', 'users')],
                },
                {
                    table: 'products',
                    columns: [
                        c('id', 'bigIncrements', 'pk'), c('sku', 'string'), c('label', 'string'),
                        c('price', 'unsignedDecimal'), c('deleted_at', 'timestamp', 'null'),
                    ],
                    relations: [],
                },
                {
                    table: 'order_items',
                    columns: [
                        c('order_id', 'unsignedInteger', 'pk'), c('product_id', 'unsignedBigInteger', 'pk'),
                        c('quantity', 'smallInteger'),
                    ],
                    relations: [rel('order_id', 'orders'), rel('product_id', 'products')],
                },
            ],
            warnings: [],
        });
    });

    it('replays a Schema::table history (add, rename, change, drop, table rename) with down(): void', () => {
        assert.deepEqual(parse(fixture('history-app')), {
            tables: [
                {
                    table: 'writers',
                    columns: [
                        c('id', 'bigIncrements', 'pk'), c('name', 'string'), c('display_name', 'string'),
                        c('bio', 'text', 'null'), c('created_at', 'timestamp', 'null'), c('updated_at', 'timestamp', 'null'),
                        c('phone', 'string'), c('country', 'string', 'null'),
                    ],
                    relations: [],
                },
                {
                    table: 'books',
                    columns: [
                        c('id', 'bigIncrements', 'pk'), c('author_id', 'unsignedBigInteger'),
                        c('editor_id', 'foreignId', 'null'), c('title', 'string'), c('isbn', 'string'),
                    ],
                    relations: [rel('author_id', 'writers')],
                },
                {
                    table: 'awards',
                    columns: [
                        c('id', 'bigIncrements', 'pk'), c('writer_id', 'foreignId'), c('book_id', 'foreignId', 'null'),
                        c('title', 'string'), c('year', 'year'),
                    ],
                    relations: [rel('writer_id', 'writers'), rel('book_id', 'books')],
                },
            ],
            warnings: [],
        });
    });

    it('handles quotes, comments, closure variants, nested calls, heredocs and $schema variables', () => {
        assert.deepEqual(parse(fixture('syntax-variants')), {
            tables: [
                {
                    table: 'users',
                    columns: [c('id', 'bigIncrements', 'pk'), c('email', 'string'), c('name', 'string'), c('nickname', 'string')],
                    relations: [],
                },
                {
                    table: 'posts',
                    columns: [
                        c('id', 'bigIncrements', 'pk'), c('user_id', 'foreignId'), c('title', 'string'),
                        c('currency', 'string'), c('token', 'string'), c('suffix', 'string'), c('summary', 'text'),
                        c('price', 'decimal'), c('spaced', 'string'), c('status', 'enum'), c('a', 'string'),
                        c('b', 'string'), c('reviewed_at', 'dateTime', 'null'), c('subtitle', 'string', 'null'),
                        c('excerpt', 'string'), c('cover', 'string'), c('canonical_url', 'string', 'null'),
                    ],
                    relations: [rel('user_id', 'users')],
                },
                {
                    table: 'audits',
                    columns: [
                        c('id', 'bigIncrements', 'pk'), c('auditable_type', 'string'), c('auditable_id', 'unsignedBigInteger'),
                        c('causer_type', 'string', 'null'), c('causer_id', 'uuid', 'null'),
                    ],
                    relations: [],
                },
                { table: 'settings', columns: [c('key', 'string', 'pk'), c('value', 'json')], relations: [] },
                { table: 'flags', columns: [c('id', 'ulid', 'pk'), c('enabled', 'boolean')], relations: [] },
                {
                    table: 'telescope_entries',
                    columns: [
                        c('sequence', 'bigIncrements', 'pk'), c('uuid', 'uuid'), c('batch_id', 'uuid'),
                        c('family_hash', 'string', 'null'), c('should_display_on_index', 'boolean'), c('type', 'string'),
                        c('content', 'longText'), c('created_at', 'dateTime', 'null'),
                    ],
                    relations: [],
                },
                {
                    table: 'telescope_entries_tags',
                    columns: [c('entry_uuid', 'uuid', 'pk'), c('tag', 'string', 'pk')],
                    relations: [rel('entry_uuid', 'telescope_entries', 'uuid')],
                },
                { table: 'telescope_monitoring', columns: [c('tag', 'string', 'pk')], relations: [] },
            ],
            warnings: [],
        });
    });

    it('skips dynamic names with a warning per skipped statement', () => {
        const file = '2025_02_01_000000_create_dynamic_tables.php';
        assert.deepEqual(parse(fixture('dynamic-names')), {
            tables: [
                {
                    table: 'measures',
                    columns: [c('id', 'bigIncrements', 'pk'), c('unit', 'string'), c('owner_id', 'foreignId')],
                    relations: [],
                },
                { table: 'users', columns: [c('locale', 'string')], relations: [] },
            ],
            warnings: [
                `${file}:14: Schema::create($tableNames['roles']) skipped: dynamic table name`,
                `${file}:19: Schema::create('logs_' . $suffix) skipped: dynamic table name`,
                `${file}:23: Schema::create("{$suffix}_events") skipped: dynamic table name`,
                `${file}:30: integer($dimension) skipped: dynamic column name`,
                `${file}:33: foreign key on measures.owner_id skipped: unknown referenced table or column`,
                `${file}:34: unknown Blueprint method userstamps() ignored`,
                `${file}:37: Schema::table('users') on a table that no migration creates, table added`,
                `${file}:39: renameColumn('surname', 'last_name') skipped: users.surname is unknown`,
            ],
        });
    });
});

describe('laravel parser: input files', () => {
    it('throws a ParserError when database/migrations is missing', () => {
        const base = fixture('no-migrations');
        assert.throws(() => parse(base), (error) => {
            assert.ok(error instanceof ParserError);
            assert.equal(error.message, `Laravel migrations folder not found: ${path.join(base, 'database', 'migrations')}`);
            return true;
        });
    });

    it('throws a ParserError when the migrations folder has no PHP file', () => {
        const base = fixture('empty-migrations');
        assert.throws(() => parse(base), (error) => {
            assert.ok(error instanceof ParserError);
            assert.equal(error.message, `No PHP migration files found in ${path.join(base, 'database', 'migrations')}`);
            return true;
        });
    });

    it('reads top-level files only, sorted by name like php artisan migrate', () => {
        const dir = project({
            '2025_02_01_000000_rename.php': migration("        Schema::rename('first', 'second');"),
            '2025_01_01_000000_create.php': migration("        Schema::create('first', function (Blueprint $table) { $table->id(); });"),
            'notes.txt': "Schema::create('not_php', function ($t) {});",
        });
        fs.mkdirSync(path.join(dir, 'database', 'migrations', 'tenant'));
        fs.writeFileSync(
            path.join(dir, 'database', 'migrations', 'tenant', '2025_01_01_000000_tenant.php'),
            migration("        Schema::create('tenant_only', function (Blueprint $table) { $table->id(); });"),
        );
        assert.deepEqual(parse(dir).tables, [{ table: 'second', columns: [c('id', 'bigIncrements', 'pk')], relations: [] }]);
    });

    it('skips folders named like PHP files', () => {
        const dir = project({ '2025_01_01_000000_create.php': migration("        Schema::create('kept', function (Blueprint $table) { $table->id(); });") });
        fs.mkdirSync(path.join(dir, 'database', 'migrations', '2025_01_02_000000_folder.php'));
        assert.deepEqual(parse(dir).tables.map(t => t.table), ['kept']);
    });

    it('R-L9 skips broken symbolic links (test skipped where links cannot be created)', (context) => {
        const dir = project({ '2025_01_01_000000_create.php': migration("        Schema::create('kept', function (Blueprint $table) { $table->id(); });") });
        try {
            fs.symlinkSync(path.join(dir, 'missing.php'), path.join(dir, 'database', 'migrations', '2025_01_03_000000_broken.php'));
        } catch (error) {
            // Windows needs Developer Mode or administrator rights to create symbolic links
            if (error.code === 'EPERM' || error.code === 'EACCES') {
                context.skip('symbolic links cannot be created here');
                return;
            }
            throw error;
        }
        assert.deepEqual(parse(dir).tables.map(t => t.table), ['kept']);
    });

    it('warns about PHP files without an up() method', () => {
        const result = parse(project({ '2025_01_01_000000_helpers.php': '<?php\n\nfunction helper() {}\n' }));
        assert.deepEqual(result, { tables: [], warnings: ['2025_01_01_000000_helpers.php:1: no up() method found, file skipped'] });
    });

    it('handles CRLF line endings', () => {
        const source = migration("        Schema::create('notes', function (Blueprint $table) {\n            $table->id();\n            $table->text('body')\n                ->nullable();\n        });").replace(/\n/g, '\r\n');
        const result = parse(project({ '2025_01_01_000000_notes.php': source }));
        assert.deepEqual(result.tables, [{ table: 'notes', columns: [c('id', 'bigIncrements', 'pk'), c('body', 'text', 'null')], relations: [] }]);
    });

    it('only emits the keys of the pivot format', () => {
        for (const name of ['blog-app', 'legacy-app', 'history-app', 'syntax-variants']) {
            for (const t of parse(fixture(name)).tables) {
                assert.deepEqual(Object.keys(t), ['table', 'columns', 'relations']);
                for (const column of t.columns) {
                    assert.ok(Object.keys(column).every(key => ['name', 'type', 'primary', 'nullable'].includes(key)), JSON.stringify(column));
                    assert.ok(column.primary === undefined || column.primary === true);
                    assert.ok(column.nullable === undefined || column.nullable === true);
                }
                for (const relation of t.relations) {
                    assert.deepEqual(Object.keys(relation), ['foreignKey', 'references', 'on', 'type']);
                }
            }
        }
    });

    it('is deterministic', () => {
        assert.deepEqual(parse(fixture('blog-app')), parse(fixture('blog-app')));
    });
});

describe('laravel parser: audit findings', () => {
    it('L-H1 id(), timestamps(), rememberToken() and softDeletes() expand to their columns', () => {
        const result = parseUp(`
        Schema::create('users', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->rememberToken();
            $table->softDeletes();
            $table->timestamps();
        });
        Schema::create('events', function (Blueprint $table) {
            $table->id('event_id');
            $table->timestampsTz();
            $table->softDeletesTz('removed_at');
        });
        Schema::create('logs', function (Blueprint $table) {
            $table->integer('id', true);
            $table->nullableTimestamps();
            $table->softDeletesDatetime();
            $table->datetimes();
        });`);
        assert.deepEqual(result.tables, [
            {
                table: 'users',
                columns: [
                    c('id', 'bigIncrements', 'pk'), c('name', 'string'), c('remember_token', 'string', 'null'),
                    c('deleted_at', 'timestamp', 'null'), c('created_at', 'timestamp', 'null'), c('updated_at', 'timestamp', 'null'),
                ],
                relations: [],
            },
            {
                table: 'events',
                columns: [
                    c('event_id', 'bigIncrements', 'pk'), c('created_at', 'timestampTz', 'null'),
                    c('updated_at', 'timestampTz', 'null'), c('removed_at', 'timestampTz', 'null'),
                ],
                relations: [],
            },
            {
                table: 'logs',
                columns: [
                    c('id', 'integer', 'pk'), c('created_at', 'dateTime', 'null'), c('updated_at', 'dateTime', 'null'),
                    c('deleted_at', 'dateTime', 'null'),
                ],
                relations: [],
            },
        ]);
    });

    it('L-H2 foreignId()->constrained() and foreignIdFor() create columns and relations', () => {
        const result = parseUp(`
        Schema::create('users', function (Blueprint $table) {
            $table->id();
        });
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->foreignId('editor_id')->constrained('users');
            $table->foreignIdFor(User::class, 'reviewer_id')->constrained();
            $table->foreignIdFor(\\App\\Models\\BlogPost::class)->constrained();
            $table->foreignIdFor(User::class, 'watcher_id');
            $table->foreignId('owner_id')->constrained(table: 'users', column: 'id', indexName: 'posts_owner_fk');
            $table->foreignUuid('team_uuid')->constrained(column: 'uuid');
            $table->foreignUlid('tenant_id')->constrained();
            $table->foreignId('approver_id')->references('id')->on('users');
            $table->unsignedBigInteger('plain_id')->constrained();
        });`);
        assert.deepEqual(table(result, 'posts'), {
            table: 'posts',
            columns: [
                c('id', 'bigIncrements', 'pk'), c('user_id', 'foreignId'), c('editor_id', 'foreignId'),
                c('reviewer_id', 'foreignId'), c('blog_post_id', 'foreignId'), c('watcher_id', 'foreignId'),
                c('owner_id', 'foreignId'), c('team_uuid', 'foreignUuid'), c('tenant_id', 'foreignUlid'),
                c('approver_id', 'foreignId'), c('plain_id', 'unsignedBigInteger'),
            ],
            relations: [
                rel('user_id', 'users'), rel('editor_id', 'users'), rel('reviewer_id', 'users'),
                rel('blog_post_id', 'blog_posts'), rel('owner_id', 'users'), rel('team_uuid', 'teams', 'uuid'),
                rel('tenant_id', 'tenants'), rel('approver_id', 'users'),
            ],
        });
        assert.deepEqual(result.warnings, []);
    });

    it('L-H2 constrained() without a table pluralizes the column name like Laravel', () => {
        const cases = {
            category_id: 'categories', person_id: 'people', address_id: 'addresses', status_id: 'statuses',
            child_id: 'children', box_id: 'boxes', leaf_id: 'leaves', company_id: 'companies', key_id: 'keys',
            data_id: 'data', media_id: 'media', analysis_id: 'analyses', parent_category_id: 'parent_categories',
            hero_id: 'heroes', bus_id: 'buses', criterion_id: 'criteria', woman_id: 'women', owner: 'owners',
            stadium_id: 'stadiums', epoch_id: 'epochs', homework_id: 'homework', software_id: 'software', user_data_id: 'user_datas',
        };
        const lines = Object.keys(cases).map(column => `            $table->foreignId('${column}')->constrained();`).join('\n');
        const result = parseUp(`
        Schema::create('links', function (Blueprint $table) {
${lines}
            $table->foreignIdFor('App\\Models\\Person')->constrained();
            $table->foreignUuidFor(\\App\\Models\\TeamMember::class)->constrained();
        });`);
        const links = table(result, 'links');
        assert.deepEqual(
            Object.fromEntries(links.relations.map(r => [r.foreignKey, r.on])),
            { ...cases, person_id: 'people', team_member_id: 'team_members' },
        );
        assert.deepEqual(links.columns.slice(-1), [c('team_member_id', 'foreignUuid')]);
    });

    it('L-H2 modifiers after constrained() do not change the column, as in Laravel', () => {
        const result = parseUp(`
        Schema::create('posts', function (Blueprint $table) {
            $table->foreignId('user_id')->nullable()->constrained();
            $table->foreignId('editor_id')->constrained('users')->nullable();
        });`);
        assert.deepEqual(table(result, 'posts').columns, [c('user_id', 'foreignId', 'null'), c('editor_id', 'foreignId')]);
    });

    it('L-H3 down(): void is never applied, only up() is parsed', () => {
        const result = parse(fixture('history-app'));
        const writers = table(result, 'writers');
        assert.ok(writers.columns.some(col => col.name === 'display_name'));
        assert.ok(!writers.columns.some(col => ['nickname', 'legacy_code', 'age'].includes(col.name)));
        assert.equal(table(result, 'authors'), undefined);

        const single = parseUp(`
        Schema::create('users', function (Blueprint $table) {
            $table->string('name');
        });`);
        assert.deepEqual(single.tables, [{ table: 'users', columns: [c('name', 'string')], relations: [] }]);
    });

    it('L-H4 ->change() is found anywhere in the chain, including multi-line chains', () => {
        const result = parseUp(`
        Schema::create('profiles', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->text('name');
            $table->string('bio');
            $table->string('motto')->nullable();
            $table->string('website');
            $table->integer('age');
        });`, `
        Schema::table('profiles', function (Blueprint $table) {
            $table->string('id', 36)->change();
            $table->string('name', 50)->nullable()->change();
            $table->text('bio')->change();
            $table->text('motto')->change();
            $table->text('website')
                ->nullable()
                ->change();
            $table->bigInteger('age')->unsigned()->change();
            $table->string('nickname')->nullable()->change();
        });`);
        assert.deepEqual(table(result, 'profiles').columns, [
            c('id', 'string', 'pk'), c('name', 'string', 'null'), c('bio', 'text'), c('motto', 'text'),
            c('website', 'text', 'null'), c('age', 'bigInteger'), c('nickname', 'string', 'null'),
        ]);
    });

    it('L-H5 double-quoted table, column and relation names are read', () => {
        const result = parseUp(`
        Schema::create("posts", function (Blueprint $table) {
            $table->string("title");
            $table->text('body');
        });
        Schema::create('tags', function (Blueprint $table) {
            $table->string("label");
            $table->unsignedBigInteger("post_id");
            $table->foreign("post_id")->references("id")->on("posts");
            $table->foreignId("author_id")->constrained("users", "id");
        });
        Schema::table("tags", function (Blueprint $table) {
            $table->renameColumn("label", "name");
            $table->dropColumn("author_id");
        });`);
        assert.deepEqual(result.tables, [
            { table: 'posts', columns: [c('title', 'string'), c('body', 'text')], relations: [] },
            { table: 'tags', columns: [c('name', 'string'), c('post_id', 'unsignedBigInteger')], relations: [rel('post_id', 'posts')] },
        ]);
    });

    it('L-H6 index, unique, foreign and drop/rename commands never create columns', () => {
        const result = parseUp(`
        Schema::create('members', function (Blueprint $table) {
            $table->id();
            $table->string('email');
            $table->string('old_name');
            $table->timestamps();
            $table->index('created_at');
            $table->unique('email', 'members_email_unique');
            $table->fullText('old_name');
            $table->engine('InnoDB');
            $table->charset('utf8mb4');
            $table->collation('utf8mb4_unicode_ci');
            $table->comment('Members');
        });
        Schema::create('articles', function (Blueprint $table) {
            $table->id();
            $table->string('slug')->unique();
            $table->unsignedBigInteger('member_id');
            $table->foreign('member_id')->references('id')->on('members');
        });`, `
        Schema::table('members', function (Blueprint $table) {
            $table->renameColumn('old_name', 'new_name');
            $table->index(['email', 'new_name']);
            $table->index('updated_at');
            $table->dropTimestamps();
            $table->renameIndex('members_email_unique', 'members_mail_unique');
        });
        Schema::table('articles', function (Blueprint $table) {
            $table->dropForeign('articles_member_id_foreign');
            $table->dropIndex('articles_slug_index');
            $table->dropUnique('articles_slug_unique');
            $table->dropFullText(['slug']);
            $table->spatialIndex('slug');
        });`);
        assert.deepEqual(result, {
            tables: [
                { table: 'members', columns: [c('id', 'bigIncrements', 'pk'), c('email', 'string'), c('new_name', 'string')], relations: [] },
                { table: 'articles', columns: [c('id', 'bigIncrements', 'pk'), c('slug', 'string'), c('member_id', 'unsignedBigInteger')], relations: [] },
            ],
            warnings: [],
        });
    });

    it('L-H7 Schema::rename, drop and dropIfExists update the tables and their relations', () => {
        const result = parseUp(`
        Schema::create('members', function (Blueprint $table) {
            $table->id();
            $table->string('email');
        });
        Schema::create('temp_imports', function (Blueprint $table) {
            $table->string('payload');
        });
        Schema::create('legacy_logs', function (Blueprint $table) {
            $table->foreignId('member_id')->constrained();
        });
        Schema::create('posts', function (Blueprint $table) {
            $table->foreignId('member_id')->constrained();
            $table->foreignId('import_id')->constrained('temp_imports');
        });`, `
        Schema::rename('members', 'accounts');
        Schema::dropIfExists('temp_imports');
        Schema::drop('legacy_logs');
        Schema::table('accounts', function (Blueprint $table) {
            $table->string('nickname');
        });`, `
        Schema::create('x', function (Blueprint $table) {
            $table->string('old_a');
        });
        Schema::dropIfExists('x');
        Schema::create('x', function (Blueprint $table) {
            $table->string('new_b');
        });
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
        });`);
        assert.deepEqual(result.tables, [
            { table: 'accounts', columns: [c('id', 'bigIncrements', 'pk'), c('email', 'string'), c('nickname', 'string')], relations: [] },
            { table: 'x', columns: [c('new_b', 'string')], relations: [] },
            { table: 'posts', columns: [c('id', 'bigIncrements', 'pk')], relations: [] },
        ]);
        assert.deepEqual(result.warnings, ['2025_01_03_000000_migration_3.php:20: table posts is created again, its previous definition is replaced']);
    });

    it('L-H7 Schema::rename keeps relations of other tables pointing to the renamed table', () => {
        const result = parseUp(`
        Schema::create('members', function (Blueprint $table) {
            $table->id();
        });
        Schema::create('posts', function (Blueprint $table) {
            $table->foreignId('member_id')->constrained();
        });
        Schema::rename('members', 'accounts');
        Schema::table('accounts', function (Blueprint $table) {
            $table->rename('users');
        });`);
        assert.deepEqual(result.tables.map(t => t.table), ['users', 'posts']);
        assert.deepEqual(table(result, 'posts').relations, [rel('member_id', 'users')]);
    });

    it('L-H8 dropColumn accepts arrays and variadic arguments, and the drop helpers work', () => {
        const result = parseUp(`
        Schema::create('x', function (Blueprint $table) {
            $table->string('a');
            $table->string('b');
            $table->string('c');
            $table->string('p');
            $table->string('q');
            $table->string('r');
            $table->string('s');
            $table->string('keep');
            $table->morphs('taggable');
            $table->rememberToken();
            $table->softDeletes();
            $table->softDeletes('archived_at');
            $table->timestamps();
        });
        Schema::table('x', function (Blueprint $table) {
            $table->dropColumn(['a', 'b']);
            $table->dropColumn('c');
            $table->dropColumn('p', 'q');
            $table->dropColumn("r");
            $table->dropMorphs('taggable');
            $table->dropRememberToken();
            $table->dropSoftDeletes();
            $table->dropSoftDeletes('archived_at');
            $table->dropTimestamps();
        });
        Schema::dropColumns('x', ['s']);`);
        assert.deepEqual(result.tables, [{ table: 'x', columns: [c('keep', 'string')], relations: [] }]);
    });

    it('L-H9 parse() takes the resolved framework path and does not need vscode', () => {
        assert.deepEqual(parse(fixture(path.join('monorepo', 'backend'))).tables, [
            { table: 'projects', columns: [c('id', 'bigIncrements', 'pk'), c('name', 'string')], relations: [] },
        ]);
        assert.throws(() => parse(fixture('monorepo')), ParserError);
    });

    it('L-H10 nested closures, braces in comments and every closure signature are handled', () => {
        const result = parseUp(`
        Schema::create('products', function (Blueprint $table) {
            $table->string('sku');
            collect(['width', 'height'])->each(function ($dim) use ($table) {
                $table->integer($dim);
            });
            $table->string('name'); // see issue #12 });
            $table->foreignId('category_id')->constrained();
        });
        Schema::create('a', function (Blueprint $table): void { $table->string('x'); });
        Schema::create('b', static function (Blueprint $table) { $table->string('x'); });
        Schema::create('c', function (Blueprint $table) use ($len) { $table->string('x'); });
        Schema::create('d', function ($table) { $table->string('x'); });
        Schema::create('e', function (Blueprint $t) { $t->string('x'); });
        Schema::connection('pgsql')->create('f', function (Blueprint $table) { $table->string('x'); });
        Schema::create('g', fn (Blueprint $table) => $table->string('x'));
        \\Illuminate\\Support\\Facades\\Schema::create('h', function (Blueprint $table) { $table->string('x'); });
        Schema::table('a', function (Blueprint $table) {
            $table->after('x', function (Blueprint $table) {
                $table->string('y');
            });
            $table->string('z');
        });`);
        assert.deepEqual(table(result, 'products'), {
            table: 'products',
            columns: [c('sku', 'string'), c('name', 'string'), c('category_id', 'foreignId')],
            relations: [rel('category_id', 'categories')],
        });
        assert.deepEqual(result.tables.slice(1).map(t => [t.table, t.columns.map(col => col.name)]), [
            ['a', ['x', 'y', 'z']], ['b', ['x']], ['c', ['x']], ['d', ['x']], ['e', ['x']], ['f', ['x']], ['g', ['x']], ['h', ['x']],
        ]);
        assert.deepEqual(result.warnings, ['2025_01_01_000000_migration_1.php:16: integer($dim) skipped: dynamic column name']);
    });

    it('L-H11 a named class down() with several Schema blocks is ignored', () => {
        const source = `<?php

use Illuminate\\Database\\Migrations\\Migration;

class AddProfileColumns extends Migration
{
    public function up()
    {
        Schema::create('teams', function (Blueprint $table) {
            $table->increments('id');
            $table->string('logo')->nullable();
        });
    }

    public function down()
    {
        Schema::table('teams', function (Blueprint $table) {
            $table->dropColumn('logo');
        });
        Schema::table('teams', function (Blueprint $table) {
            $table->dropColumn('id');
        });
        Schema::create('ghost', function (Blueprint $table) {
            $table->string('boo');
        });
    }
}
`;
        assert.deepEqual(parse(project({ '2019_01_01_000000_add_profile_columns.php': source })).tables, [
            { table: 'teams', columns: [c('id', 'increments', 'pk'), c('logo', 'string', 'null')], relations: [] },
        ]);
    });

    it("L-NEW1 values with $' or $& (defaults, comments) are not copied to the output", () => {
        const result = parseUp(`
        Schema::create('currencies', function (Blueprint $table) {
            $table->string('symbol', 5)->default('$');
            $table->string('token', 64)->default('$&');
            $table->string('suffix', 10)->default("$'")->comment('Price in $');
        });`);
        assert.deepEqual(result.tables, [
            { table: 'currencies', columns: [c('symbol', 'string'), c('token', 'string'), c('suffix', 'string')], relations: [] },
        ]);
        assert.ok(!JSON.stringify(result).includes('$'));
    });

    it('L-NEW2 a </script> default value is not copied to the output', () => {
        const result = parseUp(`
        Schema::create('notes', function (Blueprint $table) {
            $table->string('label', 255)->default('</script><img src=x onerror="document.title=1">');
        });`);
        assert.deepEqual(result.tables, [{ table: 'notes', columns: [c('label', 'string')], relations: [] }]);
        assert.ok(!JSON.stringify(result).includes('<'));
    });

    it('L-NEW3 multi-line and reversed foreign()->references()->on() chains are parsed', () => {
        const result = parseUp(`
        Schema::create('orders', function (Blueprint $table) {
            $table->unsignedBigInteger('seller_id');
            $table->foreign('seller_id')
                  ->references('id')
                  ->on('users');
            $table->unsignedBigInteger('courier_id');
            $table->foreign('courier_id')->on('users')->references('id')->onDelete('cascade');
            $table->unsignedBigInteger('buyer_id');
            $table->foreign('buyer_id')->references('id')->on('users')->cascadeOnDelete();
            $table->unsignedBigInteger('warehouse_code');
            $table->unsignedBigInteger('warehouse_site');
            $table->foreign(['warehouse_code', 'warehouse_site'])->references(['code', 'site'])->on('warehouses');
            $table->unsignedBigInteger('broken_id');
            $table->foreign('broken_id')->references('id');
        });`);
        assert.deepEqual(table(result, 'orders').relations, [
            rel('seller_id', 'users'), rel('courier_id', 'users'), rel('buyer_id', 'users'),
            rel('warehouse_code', 'warehouses', 'code'), rel('warehouse_site', 'warehouses', 'site'),
        ]);
        assert.deepEqual(result.warnings, [
            '2025_01_01_000000_migration_1.php:26: foreign key on orders skipped: dynamic or missing columns, references() or on()',
        ]);
    });

    it('L-NEW4 arguments without spaces, padded or spread over several lines are parsed', () => {
        const result = parseUp(`
        Schema::create('settings', function (Blueprint $table) {
            $table->decimal('price',8,2);
            $table->enum('status', [
                'draft',
                'published',
            ])->default('draft');
            $table->string( 'spaced' );
            $table  ->  string  (  'loose'  )  ->  nullable  (  );
            $table->string(
                'wrapped',
                100
            );
            $table->string(column: 'named', length: 20);
        });`);
        assert.deepEqual(table(result, 'settings').columns, [
            c('price', 'decimal'), c('status', 'enum'), c('spaced', 'string'), c('loose', 'string', 'null'),
            c('wrapped', 'string'), c('named', 'string'),
        ]);
    });

    it('L-NEW5 commented-out code is ignored', () => {
        const result = parseUp(`
        Schema::create('users', function (Blueprint $table) {
            $table->id();
            // $table->string('old_username');
            # $table->string('hash_comment');
            /* $table->integer('karma'); */
            $table->string('email'); /* $table->dropColumn('email'); */
        });
        /*
        Schema::create('ghost_table', function (Blueprint $table) {
            $table->string('boo');
        });
        */
        // Schema::drop('users');`);
        assert.deepEqual(result.tables, [{ table: 'users', columns: [c('id', 'bigIncrements', 'pk'), c('email', 'string')], relations: [] }]);
    });

    it('L-NEW6 two statements on one line give two columns and no free-text field', () => {
        const result = parseUp(`
        Schema::create('sessions', function (Blueprint $table) {
            $table->string('ip_address', 45)->nullable();
            $table->string('a', 10); $table->string('b', 20);
        });`);
        assert.deepEqual(table(result, 'sessions').columns, [c('ip_address', 'string', 'null'), c('a', 'string'), c('b', 'string')]);
    });

    it('L-NEW7 relations are removed with their column or constraint', () => {
        const result = parseUp(`
        Schema::create('articles', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('member_id');
            $table->foreign('member_id')->references('id')->on('members');
            $table->foreignId('author_id')->constrained('members');
            $table->foreignId('editor_id')->constrained('members');
            $table->foreignId('reviewer_id')->constrained('members');
            $table->foreignId('owner_id')->constrained('members', 'id', 'articles_owner_fk');
            $table->foreignIdFor(User::class)->constrained();
            $table->foreignId('kept_id')->constrained('members');
        });
        Schema::table('articles', function (Blueprint $table) {
            $table->dropForeign('articles_member_id_foreign');
            $table->dropColumn('member_id');
            $table->dropForeign(['author_id']);
            $table->dropConstrainedForeignId('editor_id');
            $table->dropColumn('reviewer_id');
            $table->dropForeign('articles_owner_fk');
            $table->dropConstrainedForeignIdFor(User::class);
        });`);
        assert.deepEqual(table(result, 'articles'), {
            table: 'articles',
            columns: [c('id', 'bigIncrements', 'pk'), c('author_id', 'foreignId'), c('owner_id', 'foreignId'), c('kept_id', 'foreignId')],
            relations: [rel('kept_id', 'members')],
        });
    });

    it('L-NEW8 renaming an unknown column is skipped with a warning; renames follow relations', () => {
        const result = parseUp(`
        Schema::create('users', function (Blueprint $table) {
            $table->id();
            $table->string('email');
        });
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->timestamps();
            $table->foreignId('user_id')->constrained();
        });
        Schema::table('posts', function (Blueprint $table) {
            $table->renameColumn('created_at', 'published_at');
            $table->renameColumn('nonexistent','renamed');
            $table->renameColumn('user_id', 'author_id');
        });
        Schema::table('users', function (Blueprint $table) {
            $table->renameColumn('id', 'user_key');
        });`);
        assert.deepEqual(result, {
            tables: [
                { table: 'users', columns: [c('user_key', 'bigIncrements', 'pk'), c('email', 'string')], relations: [] },
                {
                    table: 'posts',
                    columns: [
                        c('id', 'bigIncrements', 'pk'), c('published_at', 'timestamp', 'null'),
                        c('updated_at', 'timestamp', 'null'), c('author_id', 'foreignId'),
                    ],
                    relations: [rel('author_id', 'users', 'user_key')],
                },
            ],
            warnings: ["2025_01_01_000000_migration_1.php:24: renameColumn('nonexistent', 'renamed') skipped: posts.nonexistent is unknown"],
        });
    });

    it('L-NEW9 morphs helpers expand to _type and _id columns without relation', () => {
        const result = parseUp(`
        Schema::create('tags', function (Blueprint $table) {
            $table->morphs('taggable');
            $table->nullableMorphs('owner');
            $table->uuidMorphs('subject');
            $table->nullableUuidMorphs('causer');
            $table->ulidMorphs('target');
            $table->nullableUlidMorphs('origin');
            $table->numericMorphs('legacy');
            $table->foreignUuid('team_id')->constrained();
        });`);
        assert.deepEqual(result.tables, [{
            table: 'tags',
            columns: [
                c('taggable_type', 'string'), c('taggable_id', 'unsignedBigInteger'),
                c('owner_type', 'string', 'null'), c('owner_id', 'unsignedBigInteger', 'null'),
                c('subject_type', 'string'), c('subject_id', 'uuid'),
                c('causer_type', 'string', 'null'), c('causer_id', 'uuid', 'null'),
                c('target_type', 'string'), c('target_id', 'ulid'),
                c('origin_type', 'string', 'null'), c('origin_id', 'ulid', 'null'),
                c('legacy_type', 'string'), c('legacy_id', 'unsignedBigInteger'),
                c('team_id', 'foreignUuid'),
            ],
            relations: [rel('team_id', 'teams')],
        }]);
    });

    it('L-NEW10 dynamic table names and Schema::table on unknown tables give warnings', () => {
        const result = parseUp(`
        $tableNames = config('permission.table_names');
        Schema::create($tableNames['permissions'], function (Blueprint $table) {
            $table->bigIncrements('id');
        });
        Schema::table('personal_access_tokens', function (Blueprint $table) {
            $table->string('note');
        });
        Schema::rename('ghosts', 'spirits');`);
        assert.deepEqual(result, {
            tables: [{ table: 'personal_access_tokens', columns: [c('note', 'string')], relations: [] }],
            warnings: [
                "2025_01_01_000000_migration_1.php:14: Schema::create($tableNames['permissions']) skipped: dynamic table name",
                "2025_01_01_000000_migration_1.php:17: Schema::table('personal_access_tokens') on a table that no migration creates, table added",
                "2025_01_01_000000_migration_1.php:20: Schema::rename('ghosts', 'spirits') skipped: table ghosts is unknown",
            ],
        });
    });
});

describe('laravel parser: relation types and keys', () => {
    it('a unique or sole-primary foreign key is one-to-one, other foreign keys are many-to-one', () => {
        const result = parseUp(`
        Schema::create('profiles', function (Blueprint $table) {
            $table->foreignId('user_id')->unique()->constrained();
            $table->foreignId('avatar_id')->constrained('images');
            $table->foreignId('country_id')->constrained();
            $table->unique('avatar_id');
            $table->unique(['country_id', 'user_id']);
        });
        Schema::create('passports', function (Blueprint $table) {
            $table->foreignId('person_id')->primary()->constrained();
        });
        Schema::create('role_user', function (Blueprint $table) {
            $table->foreignId('role_id')->constrained();
            $table->foreignId('user_id')->constrained();
            $table->primary(['role_id', 'user_id']);
        });`);
        assert.deepEqual(result.tables.map(t => t.relations), [
            [oneToOne('user_id', 'users'), oneToOne('avatar_id', 'images'), rel('country_id', 'countries')],
            [oneToOne('person_id', 'people')],
            [rel('role_id', 'roles'), rel('user_id', 'users')],
        ]);
    });

    it('dropUnique turns a one-to-one back into a many-to-one', () => {
        const result = parseUp(`
        Schema::create('profiles', function (Blueprint $table) {
            $table->foreignId('user_id')->unique()->constrained();
            $table->foreignId('team_id')->unique()->constrained();
        });
        Schema::table('profiles', function (Blueprint $table) {
            $table->dropUnique(['user_id']);
            $table->dropUnique('profiles_team_id_unique');
        });`);
        assert.deepEqual(table(result, 'profiles').relations, [rel('user_id', 'users'), rel('team_id', 'teams')]);
    });

    it('primary keys come from increments, ->primary(), primary([...]) and ->autoIncrement()', () => {
        const result = parseUp(`
        Schema::create('a', function (Blueprint $table) {
            $table->primary('code');
            $table->string('code', 8);
            $table->unsignedInteger('counter')->autoIncrement();
            $table->smallIncrements('small');
        });
        Schema::table('a', function (Blueprint $table) {
            $table->dropPrimary();
            $table->primary(['code', 'small']);
            $table->string('label')->nullable(false);
            $table->string('note')->nullable(true);
        });`);
        assert.deepEqual(table(result, 'a').columns, [
            c('code', 'string', 'pk'), c('counter', 'unsignedInteger'), c('small', 'smallIncrements', 'pk'),
            c('label', 'string'), c('note', 'string', 'null'),
        ]);
    });

    it('accepts PHP method names in any case and old Laravel column types', () => {
        const result = parseUp(`
        Schema::create('places', function (Blueprint $table) {
            $table->ID();
            $table->DateTime('seen_at');
            $table->point('location');
            $table->unsignedDecimal('price', 8, 2);
            $table->ipAddress();
            $table->macAddress('device_mac');
            $table->addColumn('integer', 'legacy_count');
            $table->Timestamps();
        });`);
        assert.deepEqual(table(result, 'places').columns, [
            c('id', 'bigIncrements', 'pk'), c('seen_at', 'dateTime'), c('location', 'point'), c('price', 'unsignedDecimal'),
            c('ip_address', 'ipAddress'), c('device_mac', 'macAddress'), c('legacy_count', 'integer'),
            c('created_at', 'timestamp', 'null'), c('updated_at', 'timestamp', 'null'),
        ]);
    });

    it('reads $this->schema set in the constructor (Telescope 4 migrations)', () => {
        const source = `<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

class CreateTelescopeEntriesTable extends Migration
{
    protected $schema;

    public function __construct()
    {
        $this->schema = Schema::connection($this->getConnection());
    }

    public function up()
    {
        $this->schema->create('telescope_entries', function (Blueprint $table) {
            $table->bigIncrements('sequence');
            $table->uuid('uuid');
        });
    }

    public function down()
    {
        $this->schema->dropIfExists('telescope_entries');
    }
}
`;
        assert.deepEqual(parse(project({ '2018_08_08_100000_create_telescope_entries_table.php': source })), {
            tables: [{ table: 'telescope_entries', columns: [c('sequence', 'bigIncrements', 'pk'), c('uuid', 'uuid')], relations: [] }],
            warnings: [],
        });
    });

    it('a Blueprint drop() inside Schema::table removes the table and the relations to it', () => {
        const result = parseUp(`
        Schema::create('teams', function (Blueprint $table) {
            $table->id();
        });
        Schema::create('users', function (Blueprint $table) {
            $table->foreignId('team_id')->constrained();
        });
        Schema::table('teams', function (Blueprint $table) {
            $table->dropIfExists();
        });`);
        assert.deepEqual(result.tables, [{ table: 'users', columns: [c('team_id', 'foreignId')], relations: [] }]);
    });
});

describe('laravel parser: review findings', () => {
    it('R-L1 Schema calls in methods called from up() are applied where they are called', () => {
        const source = `<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        $this->createUsers();
        Schema::table('users', function (Blueprint $table) {
            $table->string('email');
        });
        self::createPosts();
        static::CreateTags();
        $this->loop();
        $this->getConnection();
    }

    private function createUsers(): void
    {
        Schema::create('users', function (Blueprint $table) {
            $table->id();
        });
    }

    private static function createPosts(): void
    {
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained();
        });
    }

    protected static function createTags()
    {
        Schema::create('tags', function (Blueprint $table) {
            $table->string('name');
        });
    }

    private function loop(): void
    {
        $this->loop();
        $this->up();
        Schema::create('loops', function (Blueprint $table) {
            $table->id();
        });
    }

    private function unused(): void
    {
        Schema::create('ghosts', function (Blueprint $table) {
            $table->id();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('users');
    }
};
`;
        assert.deepEqual(parse(project({ '2025_01_01_000000_create_with_helpers.php': source })), {
            tables: [
                { table: 'users', columns: [c('id', 'bigIncrements', 'pk'), c('email', 'string')], relations: [] },
                { table: 'posts', columns: [c('id', 'bigIncrements', 'pk'), c('user_id', 'foreignId')], relations: [rel('user_id', 'users')] },
                { table: 'tags', columns: [c('name', 'string')], relations: [] },
                { table: 'loops', columns: [c('id', 'bigIncrements', 'pk')], relations: [] },
            ],
            warnings: [],
        });
    });

    it('R-L2 Schema::whenTable*() callbacks are applied like Schema::table()', () => {
        const result = parseUp(`
        Schema::create('users', function (Blueprint $table) {
            $table->id();
        });
        Schema::whenTableDoesntHaveColumn('users', 'phone', function (Blueprint $table) {
            $table->string('phone');
        });
        Schema::whenTableHasColumn('users', 'id', function (Blueprint $table) {
            $table->string('nickname');
        });
        Schema::whenTableDoesntHaveIndex('users', ['email'], function (Blueprint $table) {
            $table->string('email')->unique();
        });
        Schema::whenTableHasIndex('users', 'users_email_unique', fn (Blueprint $table) => $table->dropColumn('nickname'));`);
        assert.deepEqual(result, {
            tables: [{ table: 'users', columns: [c('id', 'bigIncrements', 'pk'), c('phone', 'string'), c('email', 'string')], relations: [] }],
            warnings: [],
        });
    });

    it('R-L3 removeColumn() only takes back a column added by the same Blueprint', () => {
        const result = parseUp(`
        Schema::create('users', function (Blueprint $table) {
            $table->id();
            $table->string('email');
            $table->string('draft');
            $table->foreignId('team_id')->constrained();
            $table->removeColumn('draft');
            $table->removeColumn('team_id');
        });
        Schema::table('users', function (Blueprint $table) {
            $table->removeColumn('email');
            $table->removeColumn('id');
            $table->string('tmp');
            $table->removeColumn('tmp');
        });`);
        assert.deepEqual(result, {
            tables: [{ table: 'users', columns: [c('id', 'bigIncrements', 'pk'), c('email', 'string')], relations: [] }],
            warnings: [],
        });
    });

    it('R-L4 keywords and class names are case-insensitive; the $schema facade may be fully qualified', () => {
        const result = parseUp(`
        schema::create('a', Function (Blueprint $table) { $table->id(); });
        SCHEMA::create('b', FN (Blueprint $table) => $table->id());
        Schema::create('c', static FUNCTION (Blueprint $table) USE ($x) {
            $table->foreignIdFor(User::CLASS)->constrained();
        });
        $schema = \\Illuminate\\Support\\Facades\\Schema::connection($this->getConnection());
        $schema->create('d', function (Blueprint $table) { $table->id(); });`);
        assert.deepEqual(result, {
            tables: [
                { table: 'a', columns: [c('id', 'bigIncrements', 'pk')], relations: [] },
                { table: 'b', columns: [c('id', 'bigIncrements', 'pk')], relations: [] },
                { table: 'c', columns: [c('user_id', 'foreignId')], relations: [rel('user_id', 'users')] },
                { table: 'd', columns: [c('id', 'bigIncrements', 'pk')], relations: [] },
            ],
            warnings: [],
        });
    });

    it('R-L5 dropForeign() and dropUnique() with a dynamic argument are skipped with a warning', () => {
        const result = parseUp(`
        Schema::create('posts', function (Blueprint $table) {
            $table->foreignId('user_id')->unique()->constrained();
        });
        Schema::table('posts', function (Blueprint $table) use ($fk, $uq) {
            $table->dropForeign($fk);
            $table->dropUnique($uq);
            $table->dropForeign(['user_id', $other]);
        });`);
        const file = '2025_01_01_000000_migration_1.php';
        assert.deepEqual(result, {
            tables: [{ table: 'posts', columns: [c('user_id', 'foreignId')], relations: [oneToOne('user_id', 'users')] }],
            warnings: [
                `${file}:17: dropForeign() skipped: dynamic index name`,
                `${file}:18: dropUnique() skipped: dynamic index name`,
                `${file}:19: dropForeign() skipped: dynamic index name`,
            ],
        });
    });

    it('R-L6 warnings are single-line, quote at most about 60 characters and name a dynamic model', () => {
        const result = parseUp(`
        Schema::create('users', function (Blueprint $table) {
            $table->string(sprintf(
                '%s_name',
                $prefix
            ));
            $table->string($this->prefix . '_with_a_very_long_expression_that_goes_on_and_on');
            $table->foreignIdFor(config('auth.providers.users.model'));
            $table->dropForeignIdFor($model);
        });`);
        const file = '2025_01_01_000000_migration_1.php';
        assert.deepEqual(result.warnings, [
            `${file}:14: string(sprintf( '%s_name', $prefix )) skipped: dynamic column name`,
            `${file}:18: string($this->prefix . '_with_a_very_long_expression_that_goes_o...) skipped: dynamic column name`,
            `${file}:19: foreignIdFor(config('auth.providers.users.model')) skipped: dynamic model`,
            `${file}:20: dropForeignIdFor($model) skipped: dynamic model`,
        ]);
    });

    it('R-L7 reads the files php artisan migrate reads (*_*.php, no dotfile)', () => {
        const dir = project({
            '2025_01_01_000000_create.php': migration("        Schema::create('kept', function (Blueprint $table) { $table->id(); });"),
            'helpers.php': migration("        Schema::create('not_a_migration', function (Blueprint $table) { $table->id(); });"),
            '._2025_01_01_000000_create.php': '\u0000\u0005\u0016\u0007Mac OS X        \u0000\u0002',
        });
        assert.deepEqual(parse(dir), { tables: [{ table: 'kept', columns: [c('id', 'bigIncrements', 'pk')], relations: [] }], warnings: [] });

        const helpersOnly = project({ 'helpers.php': migration('') });
        assert.throws(() => parse(helpersOnly), ParserError);
    });

    it('R-L8 degenerate inputs give no broken output: self-rename, empty references, columns or names', () => {
        const result = parseUp(`
        Schema::create('a', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('b_id');
            $table->foreign('b_id')->references([])->on('b');
            $table->foreign([])->references('id')->on('b');
            $table->string('');
            $table->addColumn('', 'x');
        });
        Schema::rename('a', 'a');
        Schema::table('a', function (Blueprint $table) { $table->rename('a'); });
        Schema::create('', function (Blueprint $table) { $table->id(); });`);
        const file = '2025_01_01_000000_migration_1.php';
        assert.deepEqual(result, {
            tables: [{ table: 'a', columns: [c('id', 'bigIncrements', 'pk'), c('b_id', 'unsignedBigInteger')], relations: [] }],
            warnings: [
                `${file}:16: foreign key on a skipped: dynamic or missing columns, references() or on()`,
                `${file}:17: foreign key on a skipped: dynamic or missing columns, references() or on()`,
                `${file}:18: string('') skipped: empty column name`,
                `${file}:19: addColumn() skipped: empty column type`,
                `${file}:23: Schema::create('') skipped: empty table name`,
            ],
        });
    });

    it('R-L10 foreignUlidFor, nullableTimestampsTz, softDeletesTz and their drop helpers', () => {
        const create = `
        Schema::create('teams', function (Blueprint $table) {
            $table->ulid('id')->primary();
        });
        Schema::create('events', function (Blueprint $table) {
            $table->id();
            $table->foreignUlidFor(\\App\\Models\\Team::class)->constrained();
            $table->foreignIdFor(User::class)->constrained();
            $table->nullableTimestampsTz();
            $table->softDeletesTz();
        });`;
        assert.deepEqual(table(parseUp(create), 'events'), {
            table: 'events',
            columns: [
                c('id', 'bigIncrements', 'pk'), c('team_id', 'foreignUlid'), c('user_id', 'foreignId'),
                c('created_at', 'timestampTz', 'null'), c('updated_at', 'timestampTz', 'null'), c('deleted_at', 'timestampTz', 'null'),
            ],
            relations: [rel('team_id', 'teams'), rel('user_id', 'users')],
        });

        const result = parseUp(create, `
        Schema::table('events', function (Blueprint $table) {
            $table->dropForeignIdFor(User::class);
            $table->dropTimestampsTz();
            $table->dropSoftDeletesTz();
        });`);
        assert.deepEqual(table(result, 'events'), {
            table: 'events',
            columns: [c('id', 'bigIncrements', 'pk'), c('team_id', 'foreignUlid')],
            relations: [rel('team_id', 'teams')],
        });
        assert.deepEqual(result.warnings, []);
    });

    it('R-L11 nullableNumericMorphs has its own expansion, like the other morphs helpers', () => {
        const result = parseUp(`
        Schema::create('notes', function (Blueprint $table) {
            $table->nullableNumericMorphs('notable');
        });`);
        assert.deepEqual(result.tables, [{
            table: 'notes',
            columns: [c('notable_type', 'string', 'null'), c('notable_id', 'unsignedBigInteger', 'null')],
            relations: [],
        }]);
    });
});

describe('laravel parser: names matching Object.prototype keys', () => {
    it('infers constrained() and foreignIdFor() tables for a Constructor model', () => {
        const result = parseUp(`
        Schema::create('constructors', function (Blueprint $table) {
            $table->id();
        });
        Schema::create('results', function (Blueprint $table) {
            $table->foreignId('constructor_id')->constrained();
            $table->foreignIdFor(Constructor::class, 'builder_id')->constrained();
        });`);
        assert.deepEqual(table(result, 'results').relations, [rel('constructor_id', 'constructors'), rel('builder_id', 'constructors')]);
        assert.deepEqual(result.warnings, []);
    });
});

describe('laravel parser: final review', () => {
    it('follows helper methods declared by reference or with a union return type', () => {
        const source = `<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        $this->createUsers();
        $this->createPosts();
    }

    private function &createUsers()
    {
        Schema::create('users', function (Blueprint $table) { $table->id(); });
    }

    private function createPosts(): int | null
    {
        Schema::create('posts', function (Blueprint $table) { $table->id(); });
        return null;
    }
};
`;
        const result = parse(project({ '2024_01_01_000000_helpers.php': source }));
        assert.deepEqual(result.tables.map(t => t.table), ['users', 'posts']);
        assert.deepEqual(result.warnings, []);
    });

    it('never emits empty names (renameColumn, rename, foreign, references)', () => {
        const result = parseUp(`
        Schema::create('a', function (Blueprint $table) {
            $table->string('name');
            $table->unsignedBigInteger('b_id');
            $table->foreign('')->references('id')->on('b');
            $table->foreign('b_id')->references('')->on('b');
        });
        Schema::table('a', function (Blueprint $table) {
            $table->renameColumn('name', '');
            $table->rename('');
        });`);
        assert.deepEqual(result.tables, [{
            table: 'a',
            columns: [c('name', 'string'), c('b_id', 'unsignedBigInteger')],
            relations: [],
        }]);
        assert.equal(result.warnings.length, 4);
    });
});

# Pivot format

Every parser (`parsers/laravel.js`, `parsers/symfony.js`, `parsers/prisma.js`, `parsers/drizzle.js`, `parsers/sql.js`, see [parsers.md](parsers.md)) returns the schema in the same format, the "pivot". The viewers only read this format: a new framework only needs a parser that produces it, and declares what it reads (`sources()`). The JSON viewer shows it as is.

```js
parse(basePath, options) // → { tables, warnings }
```

- `basePath`: the framework root (the workspace folder, or the `DrawMeDatabase.frameworkPath` folder).
- `options`:
  - `git: false` skips the git status;
  - `overrides`: a `Map` of absolute file path → text of an editor not saved yet, read instead of the file (live diagram);
  - `gitCache`: a `Map` kept between parses: git runs again only once it is cleared (the extension clears it when files change on disk or in the repository, not while the user types);
  - `columnSources: true`: each column gets `source: { file, line }` (where it is declared);
  - `until` (Laravel, SQL): a migration (its file name; for SQL also the folder of a migration that has one, or its path from the migrations folder), the schema right after it. A name that is none of them keeps the migrations ordered before it, by the order of the tool. Laravel with a schema dump: the dump and the migrations it does not list, up to `until`; for a migration that the dump lists, the migration files alone;
  - `details: true`: the column details, indexes and referential actions below (for exports and tools; the JSON viewer does not ask for them).
- A missing migrations or entities folder, a folder without PHP files, no Prisma schema, no Drizzle schema file, or no SQL file, throws a `ParserError` (`parsers/errors.js`), whose message is shown to the user as is.
- The parser of a framework root is chosen by the registry (`parsers/registry.js`): the `DrawMeDatabase.framework` setting, else the best `detect()` score. Its id is `framework` in the API.

## `tables`

One object per table, in the order of the code (migrations by file name, entities by file path, Prisma models and Drizzle tables by file path, then in the order of the file; SQL: in the order the files and their statements create them, a table created again at the end):

```json
{
  "table": "posts",
  "columns": [
    { "name": "id", "type": "bigIncrements", "primary": true },
    { "name": "user_id", "type": "foreignId" },
    { "name": "published_at", "type": "timestamp", "nullable": true }
  ],
  "relations": [
    { "foreignKey": "user_id", "references": "id", "on": "users", "type": "many-to-one" }
  ],
  "source": { "file": "database/migrations/2025_03_01_100100_create_posts_table.php", "line": 14 }
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `table` | string | Table name, as in the database. Prisma: the `@@map` name (else the model name), prefixed with its `@@schema` unless it is the default schema of the database (`auth.users`; `public` on PostgreSQL and CockroachDB, `dbo` on SQL Server). Drizzle: the name given to `pgTable()` (`mysqlTable()`, `sqliteTable()`, `singlestoreTable()`), with the prefix of a table creator (``pgTableCreator((name) => `app_${name}`)``), prefixed with the schema of `pgSchema('auth').table()`. SQL: the name created by the statements, unquoted names folded to lower case on PostgreSQL, prefixed with its schema unless it is the default one (`public` on PostgreSQL, the current database on MySQL, `main` on SQLite): `auth.users` |
| `columns` | array | The columns, in the order of the code |
| `relations` | array | The foreign keys of this table |
| `git` | string, optional | Git status of the table: `unsaved` (its declaration or a column changed in an editor and not saved), `untracked` (declaration not in HEAD: new, ignored or staged-new), `modified` (a column changed since HEAD), `committed`. Missing outside a git repository, or with `git: false`, unless an editor is not saved. Prisma: the declaration is the whole `model` block, so a changed relation or a removed field marks the table `modified`; a model added to a schema file that is in HEAD (its `model` line and every line of its body new) is `untracked`, with its columns, as in a new file. Drizzle: the declaration is the whole `const users = pgTable(...)` statement (its keys and indexes too), and a table added to a file that is in HEAD is `untracked` the same way. SQL: the declaration is the `CREATE TABLE` statement and the later statements that change the table (`ALTER TABLE`, `CREATE INDEX`...): a change in a migration that is not committed marks it `modified`, a `CREATE TABLE` added to a committed file (a dump) is `untracked` with its columns |
| `source` | object, optional | Where the table is declared: `file` relative to `basePath` (with `/`), `line` from 1. Laravel: the `Schema::create()` (or the first `Schema::table()` of a table no migration creates). Symfony: the entity class. Prisma: the `model` line. Drizzle: the line of the variable of the table (`export const users = pgTable(`). SQL: the line of the `CREATE TABLE` (of the `ALTER TABLE` that added a table no file creates); the tables of a Laravel schema dump: their `CREATE TABLE` in the dump. A click on the table in the diagram opens this file; the extension only opens files inside `basePath`, or among the sources of the parser (a Prisma schema that `prisma.config.ts` sets outside of the framework folder: `file` then starts with `../`). |

### Columns

| Field | Type | Meaning |
|-------|------|---------|
| `name` | string | Column name |
| `type` | string | The name the stack gives to the type. Laravel: the Blueprint method (`string`, `foreignId`...). Symfony: the Doctrine type (`string`, `datetime_immutable`...). Prisma: the type of the field as written (`String`, `DateTime`, the name of an enum, `Unsupported("circle")`), with `[]` for a scalar list (`String[]`); the native type of the database (`@db.VarChar(255)`) is the `nativeType` detail, so that the type stays the one the developers read in the schema. Drizzle: the column builder (`varchar`, `timestamp`, `serial`, a `customType` by its name), the name of the `pgEnum` of an enum column (`schema.name` for an enum of a `pgSchema`), `enum` for `mysqlEnum()`, with `[]` per `.array()`. SQL: the type as written, in lower case and without its arguments (`varchar`, `character varying`, `timestamp with time zone`, `bigint`), with `[]` per dimension of an array, the name of an enum type (`CREATE TYPE ... AS ENUM`) or of a domain, without the default schema; `enum` and `set` for MySQL's; `''` for an untyped SQLite column. The tables of a Laravel schema dump have the SQL types of the dump |
| `primary` | `true`, optional | Part of the primary key |
| `nullable` | `true`, optional | Accepts `NULL` (drawn as `type?`). Prisma: the optional fields (`String?`), and the scalar lists, which `prisma migrate` creates without `NOT NULL`. Drizzle: the columns without `.notNull()`, except the primary keys (and the columns of a composite primary key, but on SQLite), the serial and identity columns. SQL: the columns without `NOT NULL`, except the columns of the primary key (on SQLite: only an `INTEGER PRIMARY KEY`, or in a `WITHOUT ROWID` table), the serial and identity columns |
| `git` | string, optional | Status of the lines that declare the column (Laravel: the statement that created, changed or renamed it last; Symfony: the property; Prisma: the field; Drizzle: the key of the column, in the file of the object it is spread from; SQL: its definition, or the last statement of a later migration that changed or renamed it, with the statements of its own file that changed it, such as the `ALTER TABLE ... SET DEFAULT` of a dump): `committed`, `modified`, `untracked` or `unsaved`, like the table |

### Relations

| Field | Type | Meaning |
|-------|------|---------|
| `foreignKey` | string | Column of this table (for `many-to-many`, the join column of this side: `A` for the implicit many-to-many of Prisma) |
| `references` | string | Referenced column |
| `on` | string | Referenced table (it may be missing from `tables`: the diagram then draws it without columns) |
| `type` | string | `many-to-one` (default when missing), `one-to-one` (unique foreign key; Prisma: the `fields` of `@relation` are `@unique`, `@id`, or a `@@unique` / `@@id` of the same fields) or `many-to-many` (Doctrine join table, Prisma implicit many-to-many). Prisma gives one relation per column of a composite foreign key, on the side of `@relation(fields: [...])`. Drizzle: the `.references()` of the columns, then the `foreignKey()` of the extra config (one relation per column); `relations()` and `defineRelations()` are relations of the ORM, not foreign keys, and are not read. SQL: the `REFERENCES` of the columns and the `FOREIGN KEY` constraints, one relation per column; one-to-one when the columns of the key are the primary key or have a unique constraint or index (not a partial one); without referenced columns, the primary key of the referenced table |
| `via` | string, optional | `many-to-many` only: the join table. Prisma: `_AToB` (`A` and `B` the two models by name, `A` holding the relation) or `_Name` for `@relation("Name")`, in the schema of `A` |

## `warnings`

Strings, one per skipped construct, written to the **DrawMeDatabase** output: `file:line: message` for Laravel (`2024_01_01_000000_create_users_table.php:12: renameColumn('a', '') skipped: empty name`) Prisma (`prisma/schema.prisma:40: view UserInfo skipped: views are not drawn.`) and Drizzle (`src/db/schema.ts:12: table drafts is not exported: drizzle-kit does not create it, skipped.`) and SQL (`supabase/migrations/20240101000000_init.sql:12: ALTER TABLE profiles on a table that no file creates: table added.`), `file: message` for Symfony. SQL warns only about what could change the tables: the statements on a table no file creates, a column that does not exist, a statement or a constraint not understood, `CREATE TABLE ... AS SELECT`, dynamic SQL in a `DO` block, a string or a comment not closed; the functions, triggers, policies, grants, views and data are passed over silently. The text and line numbers are checked by the unit tests.

## Details (option `details: true`)

Only what the code declares is given; a field that is missing means "not declared" (the database default applies). Prisma gives what `prisma migrate` writes to the database: not the values Prisma Client generates (`uuid()`, `cuid()`, `nanoid()`, `ulid()`, `@updatedAt`), nor the `Json` and `Bytes` defaults on MySQL, which it does not write; the defaults of scalar lists (`@default([])`) are not given either. Drizzle gives what drizzle-kit writes: not the values Drizzle computes on insert or update (`$defaultFn()`, `$onUpdate()`), nor values computed when the schema is loaded (`.default(new Date())`); the defaults of arrays are not given. SQL gives what the statements declare, as the database keeps it: the value of a literal default (its casts left out, a number for a numeric column: `'0'` of a MySQL dump is `0`), else the expression as written (`defaultRaw`).

**Columns**

| Field | Type | Meaning |
|-------|------|---------|
| `length` | integer | Length of a string or binary column (Laravel `string('name', 100)`, Doctrine `length:`, Prisma `@db.VarChar(100)`, `@db.Char(3)`, `@db.VarBinary(16)`..., Drizzle `{ length: 100 }`, a `customType` whose SQL type is `varchar(21)`, SQL `varchar(100)`, `character(3)`, `bit varying(8)`, MySQL `text(1000)`) |
| `precision`, `scale` | integer | Decimal and float columns (Laravel `decimal('total', 10, 2)`, Doctrine `precision:` / `scale:`, Prisma `@db.Decimal(10, 2)`, Drizzle `numeric({ precision: 10, scale: 2 })`, SQL `numeric(10, 2)`, MySQL `double(8, 2)`) |
| `unsigned` | `true` | Unsigned integer or decimal (Laravel `unsigned*` types and `->unsigned()`, Doctrine `options: ['unsigned' => true]`, Prisma `@db.UnsignedInt`..., Drizzle `{ unsigned: true }`, MySQL `UNSIGNED`) |
| `default` | string, number, boolean or `null` | Default value written in the code (`->default(...)`, Doctrine `options: ['default' => ...]`, Prisma `@default(...)`, an enum value as stored in the database, Drizzle `.default(...)`, the JSON text of the value for a JSON column, SQL: a literal `DEFAULT`, without its casts: `'draft'::text` is `draft`). A key present with `null` means `DEFAULT NULL` |
| `defaultRaw` | string | Default as an SQL expression: `CURRENT_TIMESTAMP` for `->useCurrent()` and Prisma `now()`, the text of `DB::raw('...')` / `new Expression('...')` and of Prisma `dbgenerated("...")`, an integer that a JavaScript number cannot hold exactly (Prisma `BigInt @default(9007199254740993)`). Drizzle: the SQL of ``.default(sql`...`)`` as written, and the SQL drizzle-kit writes for `.defaultNow()` (`now()` on PostgreSQL, `(now())` on MySQL) and `.defaultRandom()` (`gen_random_uuid()`). SQL: the expression of a `DEFAULT` that is not a literal, as written (`now()`, `CURRENT_TIMESTAMP`, `(uuid())`), and a literal integer that a JavaScript number cannot hold |
| `onUpdateCurrent` | `true` | `->useCurrentOnUpdate()`, Drizzle `.onUpdateNow()`, SQL `ON UPDATE CURRENT_TIMESTAMP` (MySQL) |
| `values` | array of strings | Allowed values of an enum or set column (Laravel `enum('status', [...])`; Doctrine: the cases of a backed `enumType`, when the enum is in the project; Prisma: the values of the enum as stored, `@map` applied; Drizzle: the values of a `pgEnum` or a `mysqlEnum`, an array or a TypeScript enum; the `{ enum: [...] }` of a text column only types it in TypeScript and is not given; SQL: the values of the enum type of the column (`CREATE TYPE ... AS ENUM`, after the `ALTER TYPE ... ADD VALUE`), of a MySQL `enum(...)` or `set(...)`) |
| `unique` | `true` | The column alone is unique (`->unique()`, a one-column unique index, Doctrine `unique: true`, Prisma `@unique` or `@@unique([field])`, Drizzle `.unique()`, a `unique().on(t.a)` or `uniqueIndex().on(t.a)`, SQL: a `UNIQUE` constraint or a unique index (not a partial one) of the column alone) |
| `autoIncrement` | `true` | Auto-incremented (Laravel `id()`, `*Increments()`, `->autoIncrement()`; Doctrine `#[ORM\GeneratedValue]` with the IDENTITY or AUTO strategy; Prisma `@default(autoincrement())`, `@default(sequence())`, and an `Int @id` on SQLite, which `prisma migrate` writes `INTEGER PRIMARY KEY AUTOINCREMENT`; Drizzle: `serial()`, the identity columns, `.autoincrement()`, `.primaryKey({ autoIncrement: true })`; SQL: `serial` and `bigserial`, `GENERATED ... AS IDENTITY`, `AUTO_INCREMENT`, `AUTOINCREMENT`, a `DEFAULT nextval(...)` of a dump) |
| `comment` | string | `->comment('...')`, Doctrine `options: ['comment' => ...]`, SQL `COMMENT 'x'` (MySQL), `COMMENT ON COLUMN ... IS 'x'` (PostgreSQL) |
| `nativeType` | string | The native type declared for the database, as the stack writes it. Prisma: the `@db.*` attribute without `@db.` (`VarChar(255)`, `Decimal(10, 2)`, `Uuid`, `Timestamptz(3)`), or the type of `Unsupported("...")` (`circle`). Drizzle: the SQL type of a `customType`, when its `dataType()` returns a constant (`citext`, `varchar(21)`). Missing: the default type of the database for `type` |

**Tables**

| Field | Type | Meaning |
|-------|------|---------|
| `indexes` | array | `{ columns: [names], type: 'index' \| 'unique' \| 'fulltext' \| 'spatial', name? }`, in the order of the code. One-column unique indexes are given as the column's `unique` instead. Laravel: `index()`, `unique()`, `fullText()`, `spatialIndex()` (statements and column modifiers), minus `dropIndex()` / `dropUnique()`...; Doctrine: `#[ORM\Index]`, `#[ORM\UniqueConstraint]` (or the `indexes` / `uniqueConstraints` of `#[ORM\Table]`); Prisma: `@@index`, `@@unique` of several fields, `@@fulltext`, named by their `map:`; Drizzle: the `index()`, `uniqueIndex()` and `unique()` of the extra config, named by their argument, an SQL expression given as written, its columns by name (`lower(email)`); SQL: `CREATE [UNIQUE] INDEX`, MySQL `KEY`, `FULLTEXT KEY`, `SPATIAL KEY`, the `UNIQUE` constraints of several columns, the partial unique indexes (`WHERE ...`, which make no column unique) and the exclusion constraints (`EXCLUDE`, type `index`), an expression as written (`lower(email)`), named when the code names them |

**Relations**

| Field | Type | Meaning |
|-------|------|---------|
| `onDelete`, `onUpdate` | string | Referential action, lower case: `cascade`, `set null`, `restrict`, `no action`, `set default`. Laravel: `cascadeOnDelete()`, `nullOnDelete()`, `restrictOnDelete()`, `noActionOnDelete()`, `onDelete('...')`, and the `OnUpdate` ones; Doctrine: `JoinColumn(onDelete: '...')`; Prisma: the `onDelete` / `onUpdate` of `@relation`, else the ones `prisma migrate` writes: `onDelete` `set null` when a field of the foreign key is optional, else `restrict` (`no action` on SQL Server), `onUpdate` `cascade`; `cascade` for the join tables of the implicit many-to-many (`no action` when a model is joined to itself on SQL Server); Drizzle: the `onDelete` / `onUpdate` of `.references()` and `foreignKey()`, else `no action`, as drizzle-kit writes it; SQL: the `ON DELETE` / `ON UPDATE` of the statement (missing: not declared, `no action` for the database) |


# Pivot format

Every parser (`parsers/laravel.js`, `parsers/symfony.js`, see [parsers.md](parsers.md)) returns the schema in the same format, the "pivot". The viewers only read this format: a new framework only needs a parser that produces it, and declares what it reads (`sources()`). The JSON viewer shows it as is.

```js
parse(basePath, options) // → { tables, warnings }
```

- `basePath`: the framework root (the workspace folder, or the `DrawMeDatabase.frameworkPath` folder).
- `options`:
  - `git: false` skips the git status;
  - `overrides`: a `Map` of absolute file path → text of an editor not saved yet, read instead of the file (live diagram);
  - `gitCache`: a `Map` kept between parses: git runs again only once it is cleared (the extension clears it when files change on disk or in the repository, not while the user types);
  - `columnSources: true`: each column gets `source: { file, line }` (where it is declared);
  - `until` (Laravel): a migration file name, the schema right after it;
  - `details: true`: the column details, indexes and referential actions below (for exports and tools; the JSON viewer does not ask for them).
- A missing migrations or entities folder, or a folder without PHP files, throws a `ParserError` (`parsers/errors.js`), whose message is shown to the user as is.
- The parser of a framework root is chosen by the registry (`parsers/registry.js`): the `DrawMeDatabase.framework` setting, else the best `detect()` score. Its id is `framework` in the API.

## `tables`

One object per table, in the order of the code (migrations by file name, entities by file path):

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
| `table` | string | Table name, as in the database |
| `columns` | array | The columns, in the order of the code |
| `relations` | array | The foreign keys of this table |
| `git` | string, optional | Git status of the table: `unsaved` (its declaration or a column changed in an editor and not saved), `untracked` (declaration not in HEAD: new, ignored or staged-new), `modified` (a column changed since HEAD), `committed`. Missing outside a git repository, or with `git: false`, unless an editor is not saved |
| `source` | object, optional | Where the table is declared: `file` relative to `basePath` (with `/`), `line` from 1. Laravel: the `Schema::create()` (or the first `Schema::table()` of a table no migration creates). Symfony: the entity class. A click on the table in the diagram opens this file; the extension only opens files inside `basePath`. |

### Columns

| Field | Type | Meaning |
|-------|------|---------|
| `name` | string | Column name |
| `type` | string | The name the stack gives to the type. Laravel: the Blueprint method (`string`, `foreignId`...). Symfony: the Doctrine type (`string`, `datetime_immutable`...) |
| `primary` | `true`, optional | Part of the primary key |
| `nullable` | `true`, optional | Accepts `NULL` (drawn as `type?`) |
| `git` | string, optional | Status of the lines that declare the column (Laravel: the statement that created, changed or renamed it last; Symfony: the property): `committed`, `modified`, `untracked` or `unsaved`, like the table |

### Relations

| Field | Type | Meaning |
|-------|------|---------|
| `foreignKey` | string | Column of this table (for `many-to-many`, the join column of this side) |
| `references` | string | Referenced column |
| `on` | string | Referenced table (it may be missing from `tables`: the diagram then draws it without columns) |
| `type` | string | `many-to-one` (default when missing), `one-to-one` (unique foreign key) or `many-to-many` (Doctrine join table) |
| `via` | string, optional | `many-to-many` only: the join table |

## `warnings`

Strings, one per skipped construct, written to the **DrawMeDatabase** output: `file:line: message` for Laravel (`2024_01_01_000000_create_users_table.php:12: renameColumn('a', '') skipped: empty name`), `file: message` for Symfony. The text and line numbers are checked by the unit tests.

## Details (option `details: true`)

Only what the code declares is given; a field that is missing means "not declared" (the database default applies).

**Columns**

| Field | Type | Meaning |
|-------|------|---------|
| `length` | integer | Length of a string or binary column (Laravel `string('name', 100)`, Doctrine `length:`) |
| `precision`, `scale` | integer | Decimal and float columns (Laravel `decimal('total', 10, 2)`, Doctrine `precision:` / `scale:`) |
| `unsigned` | `true` | Unsigned integer or decimal (Laravel `unsigned*` types and `->unsigned()`, Doctrine `options: ['unsigned' => true]`) |
| `default` | string, number, boolean or `null` | Default value written in the code (`->default(...)`, Doctrine `options: ['default' => ...]`). A key present with `null` means `DEFAULT NULL` |
| `defaultRaw` | string | Default as an SQL expression: `CURRENT_TIMESTAMP` for `->useCurrent()`, the text of `DB::raw('...')` / `new Expression('...')` |
| `onUpdateCurrent` | `true` | `->useCurrentOnUpdate()` (MySQL `ON UPDATE CURRENT_TIMESTAMP`) |
| `values` | array of strings | Allowed values of an enum or set column (Laravel `enum('status', [...])`; Doctrine: the cases of a backed `enumType`, when the enum is in the project) |
| `unique` | `true` | The column alone is unique (`->unique()`, a one-column unique index, Doctrine `unique: true`) |
| `autoIncrement` | `true` | Auto-incremented (Laravel `id()`, `*Increments()`, `->autoIncrement()`; Doctrine `#[ORM\GeneratedValue]` with the IDENTITY or AUTO strategy) |
| `comment` | string | `->comment('...')`, Doctrine `options: ['comment' => ...]` |

**Tables**

| Field | Type | Meaning |
|-------|------|---------|
| `indexes` | array | `{ columns: [names], type: 'index' \| 'unique' \| 'fulltext' \| 'spatial', name? }`, in the order of the code. One-column unique indexes are given as the column's `unique` instead. Laravel: `index()`, `unique()`, `fullText()`, `spatialIndex()` (statements and column modifiers), minus `dropIndex()` / `dropUnique()`...; Doctrine: `#[ORM\Index]`, `#[ORM\UniqueConstraint]` (or the `indexes` / `uniqueConstraints` of `#[ORM\Table]`) |

**Relations**

| Field | Type | Meaning |
|-------|------|---------|
| `onDelete`, `onUpdate` | string | Referential action, lower case: `cascade`, `set null`, `restrict`, `no action`, `set default`. Laravel: `cascadeOnDelete()`, `nullOnDelete()`, `restrictOnDelete()`, `noActionOnDelete()`, `onDelete('...')`, and the `OnUpdate` ones; Doctrine: `JoinColumn(onDelete: '...')` |


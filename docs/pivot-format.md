# Pivot format

Both parsers (`parsers/laravel.js`, `parsers/symfony.js`) return the schema in the same format, the "pivot". The viewers only read this format: a new framework only needs a parser that produces it. The JSON viewer shows it as is.

```js
parse(basePath, options) // → { tables, warnings }
```

- `basePath`: the framework root (the workspace folder, or the `DrawMeDatabase.frameworkPath` folder).
- `options`:
  - `git: false` skips the git status;
  - `overrides`: a `Map` of absolute file path → text of an editor not saved yet, read instead of the file (live diagram);
  - `gitCache`: a `Map` kept between parses: git runs again only once it is cleared (the extension clears it when files change on disk or in the repository, not while the user types).
- A missing migrations or entities folder, or a folder without PHP files, throws a `ParserError` (`parsers/errors.js`), whose message is shown to the user as is.

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
| `type` | string | Laravel: the Blueprint method (`string`, `foreignId`...). Symfony: the Doctrine type (`string`, `datetime_immutable`...) |
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

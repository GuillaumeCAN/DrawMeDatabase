# Parsers

DrawMeDatabase reads the schema of the database from the code of a project. Each supported stack (a framework or an ORM) has a parser module in `parsers/`, listed in the registry `parsers/registry.js`. Everything else (the diagram, the Schema view, the search, the exports, the inspector, the click on a table, the git status of the tables and columns) only reads what the parsers return, the [pivot format](pivot-format.md), and the sources they declare. A new stack is a new parser module and one line in the registry.

| id | label | reads | detected by |
|----|-------|-------|-------------|
| `laravel` | Laravel | `database/migrations/*.php`, in file name order (not the sub-folders), after the schema dump of `php artisan schema:dump` when there is one (`database/schema/<connection>-schema.dump` or `.sql` of the default connection: `DB_CONNECTION` of `.env`, else the default of `config/database.php`; the only dump when it cannot be told): the dump is loaded first, then the migrations it does not list, as `php artisan migrate` does on a new database | `artisan` and `laravel/framework` in the `require` of `composer.json` |
| `symfony` | Symfony | `src/Entity/**/*.php` (Doctrine entities) | `bin/console` and `symfony/framework-bundle` (or another `symfony/*` package except the polyfills) in the `require` of `composer.json` |
| `prisma` | Prisma | The Prisma schema where the Prisma CLI looks for it: the `schema` of the config object of `prisma.config.ts` (read, not run), else `prisma.schema` of `package.json` (Prisma 5 and 6: Prisma 7 ignores it, so it is then read only when there is no schema at a default location), else `schema.prisma`, `prisma/schema.prisma`, then the multi-file folder `prisma/schema/` (`**/*.prisma`). Also `package.json` and the config file, which can move it | A schema and `prisma` or `@prisma/client` in the `dependencies` or `devDependencies` of `package.json`, or a Prisma config file (100); the schema alone, or a config file (or a `prisma.schema` of `package.json` with the package) whose schema is missing (50). The package alone is no Prisma project: the root of a monorepo whose schema is in a package gets the advice to set `DrawMeDatabase.frameworkPath` |
| `drizzle` | Drizzle | The schema files of the `schema` of `drizzle.config.ts` (`.js`, `.json`, `.mjs`...; read, not run): a file, a folder (its files), a glob or an array of them, relative to the framework folder as drizzle-kit runs there; else the first usual location (`src/db/schema.ts`, the `src/db/schema/` folder, `src/schema.ts`, `db/schema.ts`, `drizzle/schema.ts`...). Also the files they import or re-export (relative paths, the path aliases of `tsconfig.json`), the imports whose file does not exist yet (watched for their creation), `package.json`, the config file and `tsconfig.json` | A config file whose schema files exist, or a schema at a usual location with `drizzle-orm` or `drizzle-kit` in `package.json` (100); a config file whose schema is missing, or a schema at a usual location that imports `drizzle-orm` without the package (50). The package alone is no Drizzle project (a monorepo root) |
| `sql` | SQL | The SQL files of the first layout found, replayed in the order of their tool: `supabase/migrations/<timestamp>_<name>.sql` (by name, the other files skipped with a warning); Flyway's `V<version>__<name>.sql` in `src/main/resources/db/migration`, `db/migration`, `sql`... and their sub-folders (by version: `V1.1` = `V1_1`, `V10` after `V2`; `R__` and `U__` left out); dbmate's `db/migrations/<version>_<name>.sql` with `-- migrate:up` (by name, the up section); golang-migrate's `<version>_<name>.up.sql` (by version number); goose's `-- +goose Up` files (by version number); diesel's `migrations/<name>/up.sql`; the output of prisma migrate (`prisma/migrations/<name>/migration.sql`, the dialect of `migration_lock.toml`) and of drizzle-kit (`drizzle/`, in the order of `meta/_journal.json`, or the folders of drizzle-kit 1.0) when that stack is not detected; numbered migrations (`migrations/001_name.sql`, sqlx, Atlas...); Rails' `db/structure.sql`; a dump (`schema.sql`, `structure.sql`, `dump.sql`... at the root, then in `db/`). The folders are also looked for in the framework folder itself (`DrawMeDatabase.frameworkPath` set to the folder of the migrations), and, when the setting chooses `sql`, any `.sql` file of it, by name | The migrations of a tool or Rails' `db/structure.sql` (45), a dump or migrations in the framework folder itself (40): below the frameworks, so that a project whose SQL is the output of Laravel, Prisma or Drizzle (or a side script) is read with its framework; `DrawMeDatabase.framework` set to `sql` reads its SQL (the history of `prisma/migrations`) |

## The contract

A parser module exports:

```js
module.exports = {
    id: 'laravel',            // stack id: lower case, stable (settings, API, getSchema().framework)
    label: 'Laravel',         // shown to the user (views, messages, Markdown export)
    detect(basePath) { },     // → score, 0 = not this stack
    sources(basePath, options) { }, // → { folders, files, extensions }: what it reads
    parse(basePath, options) { }, // → { tables, warnings }: the pivot format
};
```

`basePath` is the framework root: the workspace folder, or the folder of the `DrawMeDatabase.frameworkPath` setting.

### `id` and `label`

- `id`: `[a-z][a-z0-9-]*`, never `auto` (the value of the setting that detects). It is a value of the `DrawMeDatabase.framework` setting and of `framework` in the API (`getSchema()`, `parseSchema()`), so it never changes once released.
- `label`: the name of the stack as its users write it (`Laravel`, `Symfony`, `Prisma`, `Drizzle`, `SQL`). It is shown in the Schema view and the summary of the diagram (`Laravel · blog`), in the Markdown export (`Generated by DrawMeDatabase from the Laravel code`), and the messages list the labels of the registry (`No supported project (Laravel, Symfony) found in ...`).

### `detect(basePath)` → score

A number: `0` (or anything that is not a positive finite number) when the folder is not a project of this stack, else how sure the parser is. The registry asks every parser and keeps the best score; on a tie, the first parser of the registry wins (Laravel before Symfony, as before 1.8.0, then the parsers added later: Prisma, Drizzle, SQL).

| Score | Meaning | Examples |
|-------|---------|----------|
| `100` | The marker file of the stack and its main package | `artisan` + `laravel/framework`; `bin/console` + `symfony/framework-bundle`; a Prisma schema + `prisma` in `package.json`; a `drizzle.config.ts` and its schema files |
| `80` | The marker file and a package of the family | `bin/console` + `symfony/console` |
| `50` | Only the schema file, or the configuration without its schema | a `schema.prisma` without the `prisma` package; a `prisma.config.ts` whose schema is missing (`parse()` then tells where it looked) |
| `1`-`49` | A weak hint, or a stack whose files are often the output of another one | SQL: the migrations of a SQL tool (45), a dump (40) |

- Keep it fast: the registry calls it for every parser before each reading of the schema (small files only, no recursive scan of the project).
- It must not throw for a missing folder or file: it returns `0`. It may throw a `ParserError` (`parsers/errors.js`) for a file it cannot read (an invalid `composer.json`): the error is shown to the user when no other parser recognizes the folder, else it is written to the output as a warning (`composer.json in "..." could not be read: ... (detection of Laravel, Symfony)`), so that a broken project is not silently drawn with another stack.
- A package alone is a weak sign: at the root of a monorepo, the package of the stack is often listed while the schema is in a sub-folder. Score `0` there, so that the user is told to set `DrawMeDatabase.frameworkPath`, rather than an error of the parser.
- A project that matches several stacks is drawn with the best one; the output lists the others (`Frameworks found: laravel (100), symfony (100)`), and the `DrawMeDatabase.framework` setting chooses another one. When the setting names a parser, `detect()` is not called at all.

### `sources(basePath, options)` → `{ folders, files, extensions }`

What the parser reads, without reading it (no exception, even when the folders are missing). `options.overrides` is the `Map` of the unsaved editors (absolute path → text), as for `parse()`: a parser whose sources depend on a configuration file reads its unsaved text there (an unsaved `prisma.config.ts` that moves the schema moves the sources, so the new schema file is followed while typing); the other ones ignore it.

| Field | Type | Meaning |
|-------|------|---------|
| `folders` | array of `{ path, recursive, pattern? }` | Folders whose files are read. `recursive: false`: the files directly in the folder (Laravel), `true`: its sub-folders too (Symfony). `pattern` (optional): only the files whose path from the folder matches this glob (`**/schema.ts`; `*`, `?`, `**`, `[...]`, `{a,b}`), as the schema glob of a `drizzle.config.ts`, or an import whose file does not exist yet (`{columns,columns.*}`). A string is a folder that is not recursive |
| `files` | array of strings | Single files read, whatever their extension: a schema file (`prisma/schema.prisma`), a dump (`db/structure.sql`, the schema dump of Laravel), a configuration file that changes the result (`prisma.config.ts`, `drizzle.config.ts`, the journal of drizzle-kit). They may be missing |
| `extensions` | array of strings | Extensions of the files of `folders` (`['.php']`); none: every file |

Paths are absolute, or relative to `basePath`; `registry.getSources(id, basePath)` gives them absolute, with the extensions starting with `.`. The extension uses them for:

- the **file watcher** of the live refresh (`DrawMeDatabase.autoRefresh`): a glob per folder (`*.php`, `**/*.php`, `**/*.sql`, or its `pattern`) and per file, `registry.watchPatterns(sources)`;
- the **unsaved editors**: the text of the dirty editors of the sources (`registry.covers(sources, file)`) goes to `parse()` as `options.overrides`, and the diagram follows the typing;
- the **git status**: `createStatusReader(sources, options)` (`parsers/git.js`) runs `git status` and `git diff HEAD` on these folders (whole, whatever their `pattern`) and files only (the missing ones left out), once per reading while the cache is kept. Keep the sources narrow: a whole project folder lists every ignored file (`node_modules`, `.venv`).

`parse()` may read other files than its sources (an enum declared elsewhere), but their changes do not refresh the diagram.

### `parse(basePath, options)` → `{ tables, warnings }`

The tables in the pivot format, and the warnings (strings) written to the DrawMeDatabase output; see [pivot-format.md](pivot-format.md) for the format and the options (`git`, `overrides`, `gitCache`, `columnSources`, `details`, `until`). In short:

- read `options.overrides.get(absolutePath)` instead of the file when it is set (an unsaved editor);
- give each table and column its `source: { file, line }` (with `columnSources`), and its `git` status from `createStatusReader(sources(basePath), { git: options.git !== false, overrides: options.overrides, cache: options.gitCache })` and `tableStatus()` of `parsers/git.js`. Where several declarations share a file (the models of a Prisma schema, the tables of a Drizzle file, the tables of a SQL dump), `reader.addedOf(file)(line)` tells the lines that are not in HEAD, so that a declaration added to a committed file is `untracked`, not `modified`; `changedStatus(declaration, changes)` gives the status of a declaration that later statements changed (the `ALTER TABLE` of a SQL migration);
- throw a `ParserError` with a message for the user when there is nothing to read (`No src/Entity folder found in ...`): the message is shown as is;
- keep `type` the name the stack gives to the column type (the Blueprint method, the Doctrine type, the Prisma scalar): the diagram draws any string.

## The registry (`parsers/registry.js`)

| Function | Returns |
|----------|---------|
| `getParsers()` | The parser modules, in the order of detection (loaded on first use) |
| `getParser(id)` | The parser of a stack id, or `undefined` |
| `labels()` | The labels, in the same order |
| `detect(basePath, { framework })` | `{ framework, forced, matches, errors }`: the id of the best parser (or `'Unknown'`), `forced: true` when `framework` names a parser (it then wins without detection), the parsers that recognize the folder, best first (`{ id, label, score }`), and the ones that threw while another one recognized it (`{ id, label, message }`) |
| `detectFramework(basePath, { framework })` | `detect(...).framework` |
| `getSources(id, basePath, { overrides })` | The cleaned `sources()` of a parser (`overrides`: the unsaved editors) |
| `covers(sources, file)`, `watchPatterns(sources)` | Whether a file is one of the sources; the globs that watch them |
| `createRegistry(parsers)` | Another registry with these parsers (modules, or functions that return them), for the tests |

The extension and its API (`detectFramework`, `parseSchema`, `getFrameworks`, `getSources`, see [api.md](api.md)) only go through the registry.

## Adding a stack

1. `parsers/<id>.js` with the GPL header, exporting the contract above. Shared helpers: `parsers/git.js` (git status, unsaved editors), `parsers/errors.js` (`ParserError`), `parsers/composer.js` (PHP projects). `parsers/php-utils.js` scans PHP code only; `parsers/ts-utils.js` reads TypeScript and JavaScript (tokens, expressions, the imports, exports and declarations of a module) without running it; `parsers/sql.js` replays SQL (`scanStatements()`, `replay()`, and `readDump()` for a stack that keeps a dump of its schema, as Laravel does).
2. A line in `MODULES` of `parsers/registry.js`, after the existing ones (they win the ties).
3. `package.json`: the id in the `enum` of `DrawMeDatabase.framework`, its `enumDescriptions` in `package.nls.json` and `package.nls.fr.json` (`setting.framework.<id>`: what it reads). A unit test checks that the enum lists `auto` and every parser.
4. Optionally the text of the button that opens the file of a table, `inspector.open.<id>` in `views/i18n.js` (English and French; `Open the file` otherwise). A table whose source is a `.sql` or `.dump` file (a Laravel schema dump) says `Open the SQL file` whatever the stack (`openKey()` of `views/inspector.js`, used by the Schema view too).
5. Fixtures in `test/fixtures/<id>/` and unit tests `test/unit/<id>.test.js` (tables, relations, warnings with their text, details, git status, unsaved editors), plus the detection in `test/unit/registry.test.js`.
6. README: the stack in *Features* and its limits in *Known limitations*; CHANGELOG.

The outputs of the existing parsers must not change: compare them on every fixture before and after.

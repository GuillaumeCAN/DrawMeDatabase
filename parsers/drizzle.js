//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Reads the Drizzle ORM schema of a project (drizzle-orm 0.x and 1.0: pgTable, mysqlTable,
// sqliteTable, singlestoreTable) and returns the tables drizzle-kit creates from it. The schema
// files are found where drizzle.config.ts says (else at the usual locations) and are read as text:
// unlike drizzle-kit, which imports them, DrawMeDatabase never runs the TypeScript of the project,
// nor its drizzle.config.ts.

const fs = require('fs');
const path = require('path');
const { ParserError } = require('./errors');
const { createStatusReader, tableStatus, changedStatus } = require('./git');
const { scanModule, blockReturns, blockDeclarations, blockChanges, hasNestedReturn, createLineLocator, cook } = require('./ts-utils');

// Packages of a project that uses Drizzle ORM
const PACKAGES = ['drizzle-orm', 'drizzle-kit'];
// Config files: the default ones of drizzle-kit (.ts, .js, .json), then the other script extensions
const CONFIG_FILES = ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.json', 'drizzle.config.mts', 'drizzle.config.mjs', 'drizzle.config.cts', 'drizzle.config.cjs'];
// Files drizzle-kit reads as schema files, and the extensions tried for an import without one
const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
// Where the schema usually is, when no config file sets it (a folder: its files, as drizzle-kit
// reads a folder)
const DEFAULT_LOCATIONS = [
    'src/db/schema.ts', 'src/db/schema.js', 'src/db/schema',
    'src/schema.ts', 'src/schema.js', 'src/schema',
    'db/schema.ts', 'db/schema.js', 'db/schema',
    'drizzle/schema.ts', 'drizzle/schema.js',
    'schema.ts', 'schema',
];
// Functions of drizzle-orm, by name, and their dialect
const TABLE_FUNCTIONS = new Map([['pgTable', 'pg'], ['mysqlTable', 'mysql'], ['sqliteTable', 'sqlite'], ['singlestoreTable', 'singlestore']]);
const TABLE_CREATORS = new Map([['pgTableCreator', 'pg'], ['mysqlTableCreator', 'mysql'], ['sqliteTableCreator', 'sqlite'], ['singlestoreTableCreator', 'singlestore']]);
const SCHEMA_FUNCTIONS = new Map([['pgSchema', 'pg'], ['mysqlSchema', 'mysql'], ['mysqlDatabase', 'mysql'], ['singlestoreSchema', 'singlestore']]);
const VIEW_FUNCTIONS = new Set(['pgView', 'pgMaterializedView', 'mysqlView', 'sqliteView', 'singlestoreView']);
// drizzle-orm 1.0: snakeCase.table(...), camelCase.schema('auth').table(...)
const CASING_OBJECTS = new Map([['snakeCase', 'snake_case'], ['camelCase', 'camelCase']]);
const CASINGS = new Set(['snake_case', 'camelCase']);
// Calls chained on a table that return it (pgTable(...).enableRLS()), or on a view
const TABLE_METHODS = new Set(['enableRLS']);
const VIEW_METHODS = new Set(['as', 'existing', 'with', 'withNoData', 'using', 'tablespace', 'algorithm', 'sqlSecurity', 'withCheckOption']);
// The dialect of a module of drizzle-orm
const DIALECT_MODULES = new Map([['pg-core', 'pg'], ['mysql-core', 'mysql'], ['sqlite-core', 'sqlite'], ['singlestore-core', 'singlestore']]);
// Builders whose column is never null and auto-incremented
const SERIALS = new Map([['pg', new Set(['serial', 'bigserial', 'smallserial'])], ['mysql', new Set(['serial'])], ['singlestore', new Set(['serial'])]]);
// Builders of enum columns with their values (the pgEnum columns are read apart)
const INLINE_ENUMS = new Set(['mysqlEnum', 'singlestoreEnum']);
// Builders whose precision and scale are those of a number
const DECIMAL_BUILDERS = new Set(['numeric', 'decimal', 'double', 'doublePrecision', 'float', 'real']);
// Builders whose default is written as JSON
const JSON_BUILDERS = new Set(['json', 'jsonb']);
// Calls on a column in an index that keep the column (t.name.asc().nullsLast().op('text_ops'))
const INDEX_COLUMN_METHODS = new Set(['asc', 'desc', 'nullsFirst', 'nullsLast', 'op']);
// Functions of the extra config of a table that are read, and the ones skipped without a warning
// (as the other functions of drizzle-orm: crudPolicy...)
const EXTRA_FUNCTIONS = new Set(['primaryKey', 'foreignKey', 'index', 'uniqueIndex', 'unique']);
const SKIPPED_EXTRAS = new Set(['check', 'pgPolicy']);
// The tables of drizzle-orm/supabase (supabase/rls.ts) that a schema references without creating
// them: their name, and the names of their columns by key
const SUPABASE_TABLES = new Map([
    ['authUsers', { table: 'auth.users', columns: { id: 'id', email: 'email', phone: 'phone', emailConfirmedAt: 'email_confirmed_at', phoneConfirmedAt: 'phone_confirmed_at', lastSignInAt: 'last_sign_in_at', createdAt: 'created_at', updatedAt: 'updated_at' } }],
    ['realtimeMessages', { table: 'realtime.messages', columns: { id: 'id', topic: 'topic', extension: 'extension' } }],
]);
const ACTIONS = new Set(['cascade', 'restrict', 'no action', 'set null', 'set default']);
// The schema of the tables written without their schema name
const DEFAULT_SCHEMAS = new Map([['pg', 'public']]);
// Details of a column (option `details`), in the order of docs/pivot-format.md
const DETAIL_KEYS = ['length', 'precision', 'scale', 'unsigned', 'default', 'defaultRaw', 'onUpdateCurrent', 'values', 'unique', 'autoIncrement', 'nativeType'];
// Depth of the helpers inlined, of the aliases followed and of the values computed
const MAX_DEPTH = 32;
// The keys and indexes an extra config may give, its spreads read (a helper that spreads another
// one twice, and so on, gives twice as many at each level)
const MAX_EXTRA_ITEMS = 1000;
// Files read at most for one schema (imports followed)
const MAX_FILES = 2000;

const toPosix = (filePath) => filePath.split(path.sep).join('/');
const sameSet = (a, b) => a.length === b.length && a.every(item => b.includes(item));
const isScript = (file) => SCRIPT_EXTENSIONS.some(extension => file.endsWith(extension)) && !/\.d\.[cm]?ts$/.test(file);

const stat = (filePath) => {
    try {
        return fs.statSync(filePath);
    } catch {
        return null;
    }
};
const isFile = (filePath) => Boolean(stat(filePath)?.isFile());
const isDirectory = (filePath) => Boolean(stat(filePath)?.isDirectory());

// The text of a file: the unsaved editor when there is one, null when it cannot be read
function readText(filePath, overrides) {
    if (overrides && overrides.has(filePath)) {
        return overrides.get(filePath);
    }
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }
}

// The casing of drizzle-orm (src/casing.ts): the column names of the keys of the objects
const words = (input) => input.replace(/['\u2019]/g, '').match(/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/g) || [];
const toSnakeCase = (input) => words(input).map(word => word.toLowerCase()).join('_');
const toCamelCase = (input) => words(input).reduce((name, word, i) => name + (i === 0 ? word.toLowerCase() : `${word[0].toUpperCase()}${word.slice(1)}`), '');
const applyCasing = (casing, key) => (casing === 'snake_case' ? toSnakeCase(key) : casing === 'camelCase' ? toCamelCase(key) : key);

// The major version of a range of package.json ('^0.45.1', '1.0.0-rc.4', 'workspace:^1.0.0'),
// undefined when it does not tell one ('latest', 'catalog:')
function majorVersion(range) {
    const match = typeof range === 'string' ? /^\s*(?:workspace:|npm:[^@\s]+@)?[\^~>=v\s]*(\d+)/.exec(range) : null;
    return match ? Number(match[1]) : undefined;
}

// package.json: { packages: the dependencies and devDependencies, major: the major version of
// drizzle-kit (else drizzle-orm) when its range tells it, error }
function readPackage(basePath, overrides) {
    const text = readText(path.resolve(basePath, 'package.json'), overrides);
    if (text === null) {
        return { packages: [], major: undefined, error: null };
    }
    let pkg;
    try {
        pkg = JSON.parse(text.replace(/^\ufeff/, ''));
    } catch (err) {
        return { packages: [], major: undefined, error: err.message };
    }
    const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
    const versions = { ...object(pkg && pkg.devDependencies), ...object(pkg && pkg.dependencies) };
    const packages = [...Object.keys(object(pkg && pkg.dependencies)), ...Object.keys(object(pkg && pkg.devDependencies))];
    const major = ['drizzle-kit', 'drizzle-orm'].map(name => majorVersion(versions[name])).find(value => value !== undefined);
    return { packages, major, error: null };
}

// ---------------------------------------------------------------------------------------------
// Modules: the files read, scanned once while their text does not change

// Scans of the files (absolute path → { text, scan }): sources() and parse() read the same files
const scanCache = new Map();
function scanText(file, text) {
    const cached = scanCache.get(file);
    if (cached && cached.text === text) {
        return cached.scan;
    }
    if (scanCache.size >= 1000) {
        scanCache.clear();
    }
    const scan = scanModule(text);
    scanCache.set(file, { text, scan });
    return scan;
}

// Strips the comments and trailing commas of a JSON with comments (tsconfig.json)
function parseJsonc(text) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') {
                j += text[j] === '\\' ? 2 : 1;
            }
            out += text.slice(i, j + 1);
            i = j;
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') {
                i++;
            }
        } else if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? text.length : end + 1;
        } else {
            out += c;
        }
    }
    return JSON.parse(out.replace(/^\ufeff/, '').replace(/,(\s*[}\]])/g, '$1'));
}

// The path aliases of the tsconfig.json of basePath (compilerOptions.paths; its unsaved editor
// when there is one): [{ prefix, suffix, targets }], targets absolute with the `*` kept
function readAliases(basePath, overrides = null) {
    const file = path.resolve(basePath, 'tsconfig.json');
    let config;
    try {
        config = parseJsonc(readText(file, overrides));
    } catch {
        return [];
    }
    const options = config && typeof config.compilerOptions === 'object' && config.compilerOptions ? config.compilerOptions : {};
    const paths = options.paths && typeof options.paths === 'object' ? options.paths : {};
    const base = path.resolve(path.dirname(file), typeof options.baseUrl === 'string' ? options.baseUrl : '.');
    return Object.entries(paths)
        .filter(([pattern, targets]) => Array.isArray(targets) && (pattern.match(/\*/g) || []).length <= 1)
        .map(([pattern, targets]) => {
            const star = pattern.indexOf('*');
            return {
                prefix: star === -1 ? pattern : pattern.slice(0, star),
                suffix: star === -1 ? null : pattern.slice(star + 1),
                targets: targets.filter(target => typeof target === 'string').map(target => path.resolve(base, target)),
            };
        });
}

// The file of a module path without its extension (or with a .js extension that stands for a .ts
// file), or of a folder with an index file; null when there is none
function resolveFile(candidate) {
    if (isFile(candidate) && isScript(candidate)) {
        return candidate;
    }
    const swapped = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'], '.jsx': ['.tsx'] }[path.extname(candidate)];
    for (const extension of swapped || []) {
        const file = candidate.slice(0, -path.extname(candidate).length) + extension;
        if (isFile(file)) {
            return file;
        }
    }
    for (const extension of SCRIPT_EXTENSIONS) {
        if (isFile(candidate + extension)) {
            return candidate + extension;
        }
    }
    if (isDirectory(candidate)) {
        for (const extension of SCRIPT_EXTENSIONS) {
            const file = path.join(candidate, `index${extension}`);
            if (isFile(file)) {
                return file;
            }
        }
    }
    return null;
}

// The paths an import of `dir` names, before the extensions and index files are tried: a relative
// path, or the targets of the path aliases of tsconfig.json that match it; [] for a package
// (drizzle-orm...)
function specifierPaths(dir, specifier, aliases) {
    if (typeof specifier !== 'string' || specifier === '') {
        return [];
    }
    if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
        return [path.resolve(dir, specifier)];
    }
    const paths = [];
    for (const alias of aliases) {
        let rest = null;
        if (alias.suffix === null) {
            rest = specifier === alias.prefix ? '' : null;
        } else if (specifier.startsWith(alias.prefix) && specifier.endsWith(alias.suffix) && specifier.length >= alias.prefix.length + alias.suffix.length) {
            rest = specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
        }
        if (rest !== null) {
            paths.push(...alias.targets.map(target => (alias.suffix === null ? target : target.replace('*', rest))));
        }
    }
    return paths;
}

// The file an import of `dir` names: a relative path, or a path alias of tsconfig.json; null for a
// package (drizzle-orm...) or a file that does not exist
function resolveSpecifier(dir, specifier, aliases) {
    for (const candidate of specifierPaths(dir, specifier, aliases)) {
        const file = resolveFile(candidate);
        if (file) {
            return file;
        }
    }
    return null;
}

// resolveSpecifier(dir, specifier) for one reading of the schema (sources() or parse()): each
// import is looked for once, not once per name read through it (`export * from` barrels)
function createResolver(aliases) {
    const cache = new Map();
    return (dir, specifier) => {
        const key = `${dir}\0${specifier}`;
        if (!cache.has(key)) {
            cache.set(key, resolveSpecifier(dir, specifier, aliases));
        }
        return cache.get(key);
    };
}

// The files a module imports or re-exports (value imports: `import type` is left out)
function importedSources(scan) {
    return [...new Set([...[...scan.imports.values()].map(entry => entry.source), ...scan.stars, ...[...scan.exports.values()].filter(entry => entry.source !== undefined).map(entry => entry.source)])];
}

// The files reached from `files` through their imports and re-exports, the files first. The paths
// of the imports of the project that do not exist yet (a file being created) go to `missing`.
function reachableFiles(files, overrides, resolver, aliases, missing = null) {
    const seen = new Set(files);
    const queue = [...files];
    for (let i = 0; i < queue.length && seen.size < MAX_FILES; i++) {
        const text = readText(queue[i], overrides);
        if (text === null) {
            continue;
        }
        for (const source of importedSources(scanText(queue[i], text))) {
            const file = resolver(path.dirname(queue[i]), source);
            if (file && !seen.has(file) && seen.size < MAX_FILES) {
                seen.add(file);
                queue.push(file);
            } else if (!file && missing) {
                missing.push(...specifierPaths(path.dirname(queue[i]), source, aliases));
            }
        }
    }
    return queue;
}

// The folders that watch the creation of the imports that do not exist yet ('./columns' of
// src/db/schema.ts): the folder of the import (or its nearest existing parent in basePath) with
// the files an import of that path resolves to (columns.ts, columns.ts for columns.js...,
// columns/index.ts), as a pattern of the folder. A path with the characters of a glob is not
// watched.
function missingFolders(basePath, missing) {
    const folders = [];
    // At most 100 paths (a path alias `*` of tsconfig.json makes one of each import of a package)
    for (const candidate of [...new Set(missing)].slice(0, 100)) {
        let base = path.dirname(candidate);
        while (!isDirectory(base) && base !== path.dirname(base)) {
            base = path.dirname(base);
        }
        const fromBase = path.relative(basePath, base);
        const relative = toPosix(path.relative(base, candidate));
        if (!isDirectory(base) || /[*?[\]{}!,\\]/.test(relative) || (base !== path.dirname(candidate) && (fromBase.startsWith('..') || path.isAbsolute(fromBase)))) {
            continue;
        }
        const segments = relative.split('/');
        const name = segments.pop();
        const stem = name.replace(/\.(?:[cm]?jsx?)$/, '');
        const prefix = segments.map(segment => `${segment}/`).join('');
        const names = [...new Set([name, `${name}.*`, `${stem}.*`])];
        folders.push({ path: base, recursive: segments.length > 0, pattern: `${prefix}{${names.join(',')}}` });
        folders.push({ path: base, recursive: true, pattern: `${prefix}${name}/index.*` });
    }
    return folders;
}

// ---------------------------------------------------------------------------------------------
// Where the schema is

// The config file of a project (drizzle.config.ts...), or null
function findConfigFile(basePath) {
    for (const name of CONFIG_FILES) {
        const file = path.resolve(basePath, name);
        if (isFile(file)) {
            return file;
        }
    }
    return null;
}

// The value of a path expression of a config file, without running it: a string literal, an array
// of them, or path.join() / path.resolve() / join() / resolve() of strings, __dirname and
// import.meta.dirname (the folder of the config file). undefined for anything else.
function configValue(module, node, configDir, depth = 0) {
    if (!node || depth > MAX_DEPTH) {
        return undefined;
    }
    if (node.type === 'String') {
        return node.value;
    }
    if (node.type === 'Template') {
        return node.expressions.length === 0 ? cook(node.quasis[0]) : undefined;
    }
    if (node.type === 'Array') {
        const items = node.elements.map(element => configValue(module, element, configDir, depth + 1));
        return items.every(item => typeof item === 'string') ? items : undefined;
    }
    if (node.type === 'Identifier') {
        if (node.name === '__dirname') {
            return configDir;
        }
        const declaration = module.declarations.get(node.name);
        return declaration && declaration.kind === 'variable' ? configValue(module, declaration.init, configDir, depth + 1) : undefined;
    }
    if (node.type === 'Member' && node.property === 'dirname' && node.object.type === 'Member' && node.object.property === 'meta' && node.object.object.type === 'Identifier' && node.object.object.name === 'import') {
        return configDir;
    }
    if (node.type === 'Call') {
        const callee = node.callee;
        const name = callee.type === 'Identifier' ? callee.name : callee.type === 'Member' && callee.object.type === 'Identifier' && ['path', 'node_path', 'nodePath'].includes(callee.object.name) ? callee.property : null;
        if (name === 'join' || name === 'resolve') {
            const parts = node.args.map(arg => configValue(module, arg, configDir, depth + 1));
            if (parts.length === 0 || !parts.every(part => typeof part === 'string')) {
                return undefined;
            }
            return name === 'resolve' ? path.resolve(configDir, ...parts) : path.join(...parts);
        }
    }
    return undefined;
}

// The config object of a config script: { properties: Map(key → node), module } of the object given
// to defineConfig() or exported (`export default {`, `module.exports =`, or a variable they name),
// null when the config is built by code
function configObject(scan) {
    const exported = scan.defaultExport || (scan.assignments.find(a => a.target === 'module.exports') || {}).value || null;
    const properties = new Map();
    const read = (node, depth) => {
        if (!node || depth > MAX_DEPTH) {
            return false;
        }
        if (node.type === 'Call' && node.callee.type === 'Identifier' && node.callee.name === 'defineConfig') {
            return read(node.args[0], depth + 1);
        }
        if (node.type === 'Identifier') {
            const declaration = scan.declarations.get(node.name);
            return Boolean(declaration && declaration.kind === 'variable') && read(declaration.init, depth + 1);
        }
        if (node.type !== 'Object') {
            return false;
        }
        for (const property of node.properties) {
            if (property.kind === 'init' && !property.computed) {
                properties.set(property.key, property.value);
            } else if (property.kind === 'spread') {
                read(property.value, depth + 1);
            }
        }
        return true;
    };
    return read(exported, 0) ? properties : null;
}

// The settings of a config file that DrawMeDatabase reads: { schema: [paths] | null, computed,
// casing, casingComputed }. computed: the schema is set but cannot be read without running the
// file; casingComputed: the casing neither.
function readConfig(configFile, text) {
    const configDir = path.dirname(configFile);
    if (configFile.endsWith('.json')) {
        let json;
        try {
            json = JSON.parse(text.replace(/^\ufeff/, ''));
        } catch {
            return { schema: null, computed: true, casing: undefined };
        }
        const schema = typeof json.schema === 'string' ? [json.schema] : Array.isArray(json.schema) && json.schema.every(item => typeof item === 'string') ? json.schema : null;
        return { schema, computed: json.schema !== undefined && !schema, casing: CASINGS.has(json.casing) ? json.casing : undefined, casingComputed: json.casing !== undefined && !CASINGS.has(json.casing) };
    }
    const scan = scanText(configFile, text);
    const properties = configObject(scan);
    if (!properties) {
        // A config built by code: a schema key somewhere cannot be read without running it
        return { schema: null, computed: /\bschema\s*:/.test(text), casing: undefined };
    }
    const value = properties.has('schema') ? configValue(scan, properties.get('schema'), configDir) : undefined;
    const schema = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null;
    const casingNode = properties.get('casing');
    const casing = casingNode ? configValue(scan, casingNode, configDir) : undefined;
    return { schema, computed: properties.has('schema') && !schema, casing: CASINGS.has(casing) ? casing : undefined, casingComputed: Boolean(casingNode) && !CASINGS.has(casing) };
}

// A glob segment as a regular expression (`*.ts`, `{a,b}.ts`, `[ab]*`)
function segmentPattern(segment) {
    let source = '';
    for (let i = 0; i < segment.length; i++) {
        const c = segment[i];
        if (c === '*') {
            source += '[^/]*';
        } else if (c === '?') {
            source += '[^/]';
        } else if (c === '[') {
            const end = segment.indexOf(']', i + 1);
            if (end === -1) {
                source += '\\[';
            } else {
                source += `[${segment.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
                i = end;
            }
        } else if (c === '{') {
            const end = segment.indexOf('}', i + 1);
            if (end === -1) {
                source += '\\{';
            } else {
                source += `(?:${segment.slice(i + 1, end).split(',').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^/]*')).join('|')})`;
                i = end;
            }
        } else {
            source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${source}$`);
}

const GLOB_CHARACTERS = /[*?[{]/;

// The patterns of the braces of a glob, as glob expands them first ('db/{a,b/c}.ts' → 'db/a.ts',
// 'db/b/c.ts'), at most 64
function expandBraces(pattern) {
    const open = pattern.indexOf('{');
    if (open === -1) {
        return [pattern];
    }
    let depth = 0;
    let close = -1;
    const commas = [];
    for (let i = open; i < pattern.length; i++) {
        if (pattern[i] === '{') {
            depth++;
        } else if (pattern[i] === '}' && --depth === 0) {
            close = i;
            break;
        } else if (pattern[i] === ',' && depth === 1) {
            commas.push(i);
        }
    }
    if (close === -1 || commas.length === 0) {
        return [pattern];
    }
    const bounds = [open, ...commas, close];
    const results = [];
    for (let i = 0; i + 1 < bounds.length && results.length < 64; i++) {
        const expanded = `${pattern.slice(0, open)}${pattern.slice(bounds[i] + 1, bounds[i + 1])}${pattern.slice(close + 1)}`;
        results.push(...expandBraces(expanded).slice(0, 64 - results.length));
    }
    return results;
}

// The files and folders that a schema path of drizzle.config.ts names, relative to basePath (the
// folder drizzle-kit runs in): a file, a folder, or a glob. { matches: [absolute paths], base,
// recursive, pattern } with the folder to watch, and the glob from it when it reaches its
// sub-folders (`**/schema.ts`, `*/schema.ts`).
function expandSchemaPath(basePath, entry) {
    const absolute = path.resolve(basePath, entry);
    if (!GLOB_CHARACTERS.test(entry)) {
        const info = stat(absolute);
        return { matches: info ? [absolute] : [], base: info && info.isDirectory() ? absolute : null, recursive: false };
    }
    const segments = toPosix(absolute).split('/');
    const first = segments.findIndex(segment => GLOB_CHARACTERS.test(segment));
    const base = segments.slice(0, first).join('/') || '/';
    const rest = segments.slice(first);
    const matches = [];
    let visited = 0;
    const walk = (dir, index) => {
        if (visited++ > 20000) {
            return;
        }
        const segment = rest[index];
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        if (segment === '**') {
            if (index + 1 < rest.length) {
                walk(dir, index + 1);
            } else {
                // A final `**` matches the folder and each of its sub-folders, whose files
                // drizzle-kit reads (and the files in them, the same ones)
                matches.push(dir);
            }
            for (const item of entries) {
                if (item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules') {
                    walk(path.join(dir, item.name), index);
                }
            }
            return;
        }
        const pattern = segmentPattern(segment);
        for (const item of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
            if ((item.name.startsWith('.') && !segment.startsWith('.')) || !pattern.test(item.name)) {
                continue;
            }
            const full = path.join(dir, item.name);
            if (index === rest.length - 1) {
                matches.push(full);
            } else if (item.isDirectory() || (item.isSymbolicLink() && isDirectory(full))) {
                walk(full, index + 1);
            }
        }
    };
    walk(path.resolve(base), 0);
    // A glob of one segment watches the files of its folder, `**` the files of its sub-folders too
    const recursive = rest.length > 1 || rest[0] === '**';
    return { matches: [...new Set(matches)].sort(), base: path.resolve(base), recursive, pattern: rest.length > 1 ? rest.join('/') : null };
}

// The schema files of matched paths, as drizzle-kit lists them: a file, or the files directly in a
// folder, with a script extension
function schemaFilesOf(matches) {
    const files = [];
    for (const match of matches) {
        const info = stat(match);
        if (info && info.isDirectory()) {
            let names = [];
            try {
                names = fs.readdirSync(match).sort();
            } catch {
                names = [];
            }
            files.push(...names.map(name => path.join(match, name)).filter(file => isFile(file) && isScript(file)));
        } else if (info && isScript(match)) {
            files.push(match);
        }
    }
    return files;
}

// Where the schema of basePath is: the schema of the config file, else the first usual location
// with schema files. { files, folders (to watch: [{ path, recursive }]), configFile, configName,
// origin (the config file that set the schema, or null), entries (the paths of the config),
// casing, major, warnings, packages }
function locateSchema(basePath, overrides = null) {
    const warnings = [];
    const configFile = findConfigFile(basePath);
    const configName = configFile ? toPosix(path.relative(basePath, configFile)) : null;
    const pkg = readPackage(basePath, overrides);
    const located = { files: [], folders: [], configFile, configName, origin: null, entries: [], casing: undefined, major: pkg.major, warnings, packages: pkg.packages };
    if (configFile) {
        const text = readText(configFile, overrides);
        const config = text === null ? { schema: null, computed: false } : readConfig(configFile, text);
        if (config.casingComputed) {
            warnings.push(`${configName}: the casing is computed, it cannot be read without running the file: the columns are named after the keys of the objects.`);
        }
        if (config.casing) {
            if (pkg.major >= 1) {
                warnings.push(`${configName}: drizzle-kit ${pkg.major} ignores the casing of the config file: the columns are named after the keys of the objects, as it does (snakeCase.table() sets a casing).`);
            } else {
                located.casing = config.casing;
            }
        }
        if (config.schema) {
            located.origin = configName;
            located.entries = config.schema;
            const files = [];
            for (const entry of config.schema) {
                const found = [];
                for (const pattern of expandBraces(entry)) {
                    const expanded = expandSchemaPath(basePath, pattern);
                    // A glob through sub-folders: the files it matches, and the files of the
                    // folders it matches (not every script of its base folder: src/**/schema.ts)
                    const folders = !expanded.base ? []
                        : expanded.pattern ? [expanded.pattern, `${expanded.pattern}/*`].map(glob => ({ path: expanded.base, recursive: true, pattern: glob }))
                            : [{ path: expanded.base, recursive: expanded.recursive }];
                    for (const folder of folders) {
                        if (!located.folders.some(f => f.path === folder.path && f.recursive === folder.recursive && f.pattern === folder.pattern)) {
                            located.folders.push(folder);
                        }
                    }
                    found.push(...schemaFilesOf(expanded.matches));
                }
                if (found.length === 0 && config.schema.length > 1) {
                    warnings.push(`${configName}: no schema file matches ${entry}.`);
                }
                files.push(...found);
            }
            located.files = [...new Set(files)];
            return located;
        }
        if (config.computed) {
            warnings.push(`${configName}: the schema path is computed, it cannot be read without running the file: the usual locations are read.`);
        }
    }
    for (const location of DEFAULT_LOCATIONS) {
        const full = path.resolve(basePath, location);
        const info = stat(full);
        const files = info ? schemaFilesOf([full]) : [];
        if (files.length > 0) {
            located.files = files;
            if (info.isDirectory()) {
                located.folders.push({ path: full, recursive: false });
            }
            return located;
        }
    }
    return located;
}

// The sources of a located schema (docs/parsers.md): the schema files and the files they import
// (relative imports and path aliases), the folders of the config (each usual location while there
// is no schema), package.json, the config file and tsconfig.json (its path aliases). missing: the
// paths of the imports that do not exist yet, watched for their creation.
function sourcesOf(basePath, location, reached, missing = []) {
    const folders = [...location.folders];
    const files = [...(reached || [])];
    if (location.files.length === 0 && location.entries.length === 0) {
        for (const name of DEFAULT_LOCATIONS) {
            if (path.extname(name)) {
                files.push(path.resolve(basePath, name));
            } else {
                folders.push({ path: path.resolve(basePath, name), recursive: false });
            }
        }
    }
    for (const folder of missingFolders(basePath, missing)) {
        if (!folders.some(f => f.path === folder.path && f.pattern === folder.pattern)) {
            folders.push(folder);
        }
    }
    files.push(path.resolve(basePath, 'package.json'), location.configFile || path.resolve(basePath, 'drizzle.config.ts'), path.resolve(basePath, 'tsconfig.json'));
    return { folders, files: [...new Set(files)], extensions: SCRIPT_EXTENSIONS };
}

// ---------------------------------------------------------------------------------------------
// Values of the code, without running it

// A reference to an expression: { module, node, env } (env: Map of the parameters of an inlined
// helper → the reference of their argument, or a marker value). A value: { kind: 'node', module,
// node, env, decl } (an expression; decl: its declaration), 'external' ({ source, name }: an import
// of a package), 'namespace' ({ module } or { source }), 'enum' (a TypeScript enum), 'builders' and
// 'builder' (the column builders given to a callback), 'self' and 'column' (the table given to the
// extra config callback), 'member' (a property that cannot be read), 'local' ({ name }: a local
// variable of a helper whose value cannot be read), 'unknown' ({ name }).
function createProgram(basePath, overrides, resolver) {
    const modules = new Map();

    const load = (file) => {
        if (modules.has(file)) {
            return modules.get(file);
        }
        const text = modules.size < MAX_FILES ? readText(file, overrides) : null;
        const module = text === null ? null : { file, rel: toPosix(path.relative(basePath, file)), dir: path.dirname(file), scan: scanText(file, text), lineAt: createLineLocator(text) };
        modules.set(file, module);
        return module;
    };
    const resolveSource = (module, source) => {
        const file = resolver(module.dir, source);
        return file ? load(file) : null;
    };

    const unknown = (name) => ({ kind: 'unknown', name });
    const declValue = (module, decl) => {
        if (decl.kind === 'enum') {
            return { kind: 'enum', module, decl };
        }
        if (decl.kind === 'function') {
            if (!decl.node) {
                decl.node = { type: 'Function', params: decl.params, body: decl.body, start: decl.start, end: decl.end };
            }
            return { kind: 'node', module, node: decl.node, env: null, decl };
        }
        return decl.init ? { kind: 'node', module, node: decl.init, env: null, decl } : unknown(decl.name);
    };
    // The declaration of `export default <expression>`, made once per module
    const defaultDecl = (module) => {
        const node = module.scan.defaultExport;
        if (!node) {
            return null;
        }
        if (!module.defaultDecl) {
            module.defaultDecl = { kind: 'variable', name: 'default', init: node, start: node.start, end: node.end, nameStart: node.start, exported: true };
        }
        return module.defaultDecl;
    };

    const lookup = (module, name, depth) => {
        const decl = module.scan.declarations.get(name);
        if (decl) {
            return declValue(module, decl);
        }
        const imported = module.scan.imports.get(name);
        return imported ? importValue(module, imported, depth + 1) : null;
    };
    const importValue = (module, { source, imported }, depth) => {
        const target = resolveSource(module, source);
        if (!target) {
            return imported === '*' ? { kind: 'namespace', source } : { kind: 'external', source, name: imported };
        }
        return imported === '*' ? { kind: 'namespace', module: target } : (resolveExport(target, imported, depth + 1) || unknown(imported));
    };
    // The value a module exports under `name`, or null. The values found through `export * from`
    // are kept: a name of a barrel (index.ts) is looked for once in its modules.
    const exportCache = new Map();
    const resolveExport = (module, name, depth = 0) => {
        const key = `${module.file}\0${name}`;
        if (exportCache.has(key)) {
            return exportCache.get(key);
        }
        const search = { seen: new Set(), limited: false };
        const value = findExport(module, name, depth, search);
        // A search stopped by the depth may find the name from a shallower lookup
        if (!search.limited) {
            exportCache.set(key, value);
        }
        return value;
    };
    const findExport = (module, name, depth, search) => {
        const key = `${module.file}\0${name}`;
        if (depth > MAX_DEPTH) {
            search.limited = true;
            return null;
        }
        if (search.seen.has(key)) {
            return null;
        }
        search.seen.add(key);
        if (name === 'default') {
            const decl = defaultDecl(module);
            return decl ? declValue(module, decl) : null;
        }
        const entry = module.scan.exports.get(name);
        if (entry) {
            if (entry.local !== undefined) {
                return lookup(module, entry.local, depth + 1);
            }
            const target = resolveSource(module, entry.source);
            if (!target) {
                return entry.imported === '*' ? { kind: 'namespace', source: entry.source } : { kind: 'external', source: entry.source, name: entry.imported };
            }
            return entry.imported === '*' ? { kind: 'namespace', module: target } : findExport(target, entry.imported, depth + 1, search);
        }
        const decl = module.scan.declarations.get(name);
        if (decl && decl.exported) {
            return declValue(module, decl);
        }
        // CommonJS: exports.users = ..., module.exports = { users }
        const common = module.scan.commonExports.get(name);
        if (common) {
            return declValue(module, common);
        }
        for (const source of module.scan.stars) {
            const target = resolveSource(module, source);
            const value = target ? findExport(target, name, depth + 1, search) : null;
            if (value) {
                return value;
            }
        }
        return null;
    };
    // The values a module exports, for drizzle-kit, which keeps the tables among them: its exported
    // declarations, `export { ... }`, `export * from` (not `export * as`), `export default`, and
    // the exports of CommonJS. [{ value, module }], each declaration once
    const exportedValues = (module, seen = new Set()) => {
        if (seen.has(module.file) || seen.size > MAX_FILES) {
            return [];
        }
        seen.add(module.file);
        const values = [];
        // An exported alias (export const posts = articles) is the value it names
        const push = (value) => {
            if (value) {
                values.push(value.kind === 'node' && (value.node.type === 'Identifier' || value.node.type === 'Member') ? resolve(value) : value);
            }
        };
        for (const decl of module.scan.order) {
            if (decl.exported) {
                push(declValue(module, decl));
            }
        }
        for (const decl of module.scan.commonExports.values()) {
            push(declValue(module, decl));
        }
        for (const [name, entry] of module.scan.exports) {
            if (entry.imported !== '*') {
                push(entry.local !== undefined ? lookup(module, entry.local, 0) : resolveExport(module, name, 0));
            }
        }
        const decl = defaultDecl(module);
        if (decl) {
            push(declValue(module, decl));
        }
        for (const source of module.scan.stars) {
            const target = resolveSource(module, source);
            if (target) {
                values.push(...exportedValues(target, seen).filter(value => !(value.decl && value.decl.name === 'default')));
            }
        }
        return values;
    };

    // The value of a reference, through the parameters of the inlined helpers, the declarations,
    // the imports and the members of objects
    const resolve = (ref, depth = 0) => {
        if (!ref || !ref.node || depth > MAX_DEPTH) {
            return unknown(null);
        }
        const { module, node, env } = ref;
        if (node.type === 'Identifier') {
            if (env && env.has(node.name)) {
                const bound = env.get(node.name);
                return bound.kind ? bound : resolve(bound, depth + 1);
            }
            const value = module ? lookup(module, node.name, depth) : null;
            if (!value) {
                return unknown(node.name);
            }
            return value.kind === 'node' && (value.node.type === 'Identifier' || value.node.type === 'Member') ? resolve(value, depth + 1) : value;
        }
        if (node.type === 'Member') {
            return member(resolve({ module, node: node.object, env }, depth + 1), node.property, depth + 1);
        }
        return { kind: 'node', module, node, env, decl: ref.decl };
    };
    // The property `name` of a value
    const member = (object, name, depth) => {
        if (object.kind === 'namespace') {
            return object.module ? (resolveExport(object.module, name) || unknown(name)) : { kind: 'external', source: object.source, name };
        }
        if (object.kind === 'builders') {
            return { kind: 'builder', name };
        }
        if (object.kind === 'self') {
            return { kind: 'column', table: object.table, key: name };
        }
        if (object.kind === 'enum') {
            const index = object.decl.members.findIndex(m => m.name === name);
            if (index === -1) {
                return unknown(name);
            }
            const init = object.decl.members[index].init;
            if (init) {
                return resolve({ module: object.module, node: init, env: null }, depth + 1);
            }
            // Members without an initializer: the number after the previous one
            const value = constant(object);
            return value && value.value ? { kind: 'node', module: object.module, node: { type: 'Number', value: value.value[name], raw: String(value.value[name]) }, env: null } : unknown(name);
        }
        if (object.kind === 'node' && object.node.type === 'Object') {
            const properties = object.node.properties;
            for (let i = properties.length - 1; i >= 0; i--) {
                const property = properties[i];
                if (property.kind === 'init' && !property.computed && property.key === name) {
                    return resolve({ module: object.module, node: property.value, env: object.env }, depth + 1);
                }
                if (property.kind === 'spread') {
                    const spread = resolve({ module: object.module, node: property.value, env: object.env }, depth + 1);
                    const found = spread.kind === 'node' && spread.node.type === 'Object' ? member(spread, name, depth + 1) : null;
                    if (found && found.kind !== 'unknown') {
                        return found;
                    }
                }
            }
            return unknown(name);
        }
        return { kind: 'member', object, name };
    };

    // The value of a constant expression: { value } (a string, number, boolean, null, array or
    // object of them), or undefined when it is computed at run time
    const constant = (ref, depth = 0) => {
        if (!ref || depth > MAX_DEPTH) {
            return undefined;
        }
        const value = ref.kind ? ref : resolve(ref, depth + 1);
        if (value.kind === 'unknown' && value.name === 'undefined') {
            return { value: undefined };
        }
        if (value.kind === 'enum') {
            const object = {};
            let next = 0;
            for (const m of value.decl.members) {
                const item = m.init ? constant({ module: value.module, node: m.init, env: null }, depth + 1) : { value: next };
                if (!item) {
                    return undefined;
                }
                object[m.name] = item.value;
                next = typeof item.value === 'number' ? item.value + 1 : next;
            }
            return { value: object };
        }
        if (value.kind !== 'node') {
            return undefined;
        }
        const { module, node, env } = value;
        const sub = (child) => constant({ module, node: child, env }, depth + 1);
        switch (node.type) {
            case 'String':
                return { value: node.value };
            case 'Number':
                return { value: node.value, raw: node.raw, bigint: node.bigint };
            case 'Literal':
                return { value: node.value };
            case 'Template': {
                let text = cook(node.quasis[0]);
                for (let i = 0; i < node.expressions.length; i++) {
                    const part = sub(node.expressions[i]);
                    if (!part || (typeof part.value === 'object' && part.value !== null)) {
                        return undefined;
                    }
                    text += String(part.value) + cook(node.quasis[i + 1] || '');
                }
                return { value: text };
            }
            case 'Unary': {
                const argument = sub(node.argument);
                if (argument && typeof argument.value === 'number' && (node.operator === '-' || node.operator === '+')) {
                    return { value: node.operator === '-' ? -argument.value : argument.value, raw: argument.raw === undefined ? undefined : `${node.operator === '-' ? '-' : ''}${argument.raw}`, bigint: argument.bigint };
                }
                return undefined;
            }
            case 'Binary': {
                if (node.operator === '??' || node.operator === '||') {
                    const left = sub(node.left);
                    if (!left) {
                        return undefined;
                    }
                    return (node.operator === '??' ? left.value === null || left.value === undefined : !left.value) ? sub(node.right) : left;
                }
                if (node.operator !== '+') {
                    return undefined;
                }
                const left = sub(node.left);
                const right = sub(node.right);
                if (!left || !right || [left.value, right.value].some(v => typeof v === 'object' && v !== null)) {
                    return undefined;
                }
                return { value: left.value + right.value };
            }
            case 'Array': {
                const items = [];
                for (const element of node.elements) {
                    if (element.type === 'Spread') {
                        const spread = sub(element.argument);
                        if (!spread || !Array.isArray(spread.value)) {
                            return undefined;
                        }
                        items.push(...spread.value);
                    } else {
                        const item = sub(element);
                        if (!item) {
                            return undefined;
                        }
                        items.push(item.value);
                    }
                }
                return { value: items };
            }
            case 'Object': {
                const object = {};
                for (const property of node.properties) {
                    if (property.kind === 'init' && !property.computed) {
                        const item = sub(property.value);
                        if (!item) {
                            return undefined;
                        }
                        object[property.key] = item.value;
                    } else if (property.kind === 'spread') {
                        const spread = sub(property.value);
                        if (!spread || typeof spread.value !== 'object' || spread.value === null) {
                            return undefined;
                        }
                        Object.assign(object, spread.value);
                    } else {
                        return undefined;
                    }
                }
                return { value: object };
            }
            case 'Call': {
                // Object.values(Enum), Object.keys(...)
                const callee = node.callee;
                if (callee.type === 'Member' && callee.object.type === 'Identifier' && callee.object.name === 'Object' && ['values', 'keys'].includes(callee.property) && node.args.length === 1) {
                    const object = sub(node.args[0]);
                    if (object && object.value && typeof object.value === 'object' && !Array.isArray(object.value)) {
                        // The reverse mappings of numeric enums are not values
                        return { value: callee.property === 'values' ? Object.values(object.value) : Object.keys(object.value) };
                    }
                }
                return undefined;
            }
            default:
                return undefined;
        }
    };
    // The properties of an object literal whose values are constants ({ length: 255 }): a plain
    // object of them (the others left out), or null when the value is not an object literal
    const constantProperties = (ref) => {
        const value = resolve(ref);
        if (value.kind !== 'node' || value.node.type !== 'Object') {
            return null;
        }
        const object = {};
        for (const property of value.node.properties) {
            if (property.kind === 'init' && !property.computed) {
                const item = constant({ module: value.module, node: property.value, env: value.env });
                if (item) {
                    object[property.key] = item.value;
                }
            }
        }
        return object;
    };

    // The body of a function value as an expression: its expression, or the single `return` of
    // its block; null otherwise
    const functionBody = (node) => {
        if (!node || (node.type !== 'Arrow' && node.type !== 'Function')) {
            return null;
        }
        if (node.body.type !== 'Block') {
            return node.body;
        }
        const returns = blockReturns(node.body);
        return returns.length === 1 && !hasNestedReturn(node.body) ? returns[0] : null;
    };
    // A local changed by the statements of its block before the return (`name = 'b'`, `cols.b =
    // text('b')`, `list.push(index().on(t.b))`, `Object.assign(cols, more)`): its value at the
    // return, as an expression ({ ...cols, b: text('b') }, [...list, index().on(t.b)]), or null
    // when it cannot be read. Made once per local.
    const changedValue = (local, entry) => {
        if (entry.node !== undefined) {
            return entry.node;
        }
        let node = entry.unreadable ? null : local.init;
        for (const change of entry.unreadable ? [] : entry.changes) {
            if (change.type === 'assign') {
                node = change.value;
                continue;
            }
            const isObject = change.type === 'property' || change.type === 'merge';
            if (!node || (node.type === (isObject ? 'Array' : 'Object'))) {
                // A property of an array, an item of an object, or of nothing
                node = null;
                break;
            }
            const literal = node.type === (isObject ? 'Object' : 'Array');
            const range = { start: Math.min(node.start, change.start), end: Math.max(node.end, change.end) };
            if (isObject) {
                const before = literal ? node.properties : [{ kind: 'spread', value: node, start: node.start, end: node.end }];
                const added = change.type === 'property' ? [{ kind: 'init', key: change.key, computed: false, value: change.value, start: change.start, end: change.end }]
                    : change.sources.map(source => ({ kind: 'spread', value: source, start: source.start, end: source.end }));
                node = { type: 'Object', properties: [...before, ...added], ...range };
            } else {
                const before = literal ? node.elements : [{ type: 'Spread', argument: node, start: node.start, end: node.end }];
                node = { type: 'Array', elements: change.type === 'push' ? [...before, ...change.items] : [...change.items, ...before], ...range };
            }
        }
        entry.node = node;
        return node;
    };
    // Binds into `env` the local variables and functions of the block of a function value (`const
    // col = (n) => text(n)` before its `return`), which resolve in that same environment, with the
    // changes of their block; the names of a destructuring, of a declaration without a value, or of
    // a local changed in a way that cannot be read, are locals that cannot be read. params: the
    // parameters bound in env are changed too (`cols.extra = text()` on an argument): their argument
    // is then bound under a name of its own. Returns env.
    const bindLocals = (value, env, params = false) => {
        if (value.node.body && value.node.body.type === 'Block') {
            const names = value.node.params.filter(param => param.name).map(param => param.name);
            const changes = blockChanges(value.node.body, names);
            for (const name of params ? names : []) {
                const entry = changes.get(name);
                if (entry && env.has(name)) {
                    const argument = `\0${name}`;
                    const first = entry.changes && entry.changes[0];
                    env.set(argument, env.get(name));
                    const node = changedValue({ name, init: { type: 'Identifier', name: argument, start: first ? first.start : 0, end: first ? first.start : 0 } }, entry);
                    env.set(name, node ? { module: value.module, node, env } : { kind: 'local', name });
                }
            }
            for (const local of blockDeclarations(value.node.body)) {
                if (!env.has(local.name)) {
                    const node = changes.has(local.name) ? changedValue(local, changes.get(local.name)) : local.init;
                    env.set(local.name, node ? { module: value.module, node, env } : { kind: 'local', name: local.name });
                }
            }
        }
        return env;
    };
    // Whether an object value has the property `key`, as a default value of a destructuring sees
    // it: true, false (a property set to undefined is missing too), or null when it cannot be known
    // (not an object literal, a spread or a key that cannot be read)
    const hasProperty = (object, key, depth = 0) => {
        if (!object || object.kind !== 'node' || object.node.type !== 'Object' || depth > MAX_DEPTH) {
            return null;
        }
        const properties = object.node.properties;
        for (let i = properties.length - 1; i >= 0; i--) {
            const property = properties[i];
            const ref = property.value ? { module: object.module, node: property.value, env: object.env } : null;
            if (property.computed || property.kind === 'unknown') {
                return null;
            }
            if (property.kind === 'spread') {
                const found = hasProperty(resolve(ref, depth + 1), key, depth + 1);
                if (found !== false) {
                    return found;
                }
            } else if (property.key === key) {
                const item = property.kind === 'init' ? constant(ref, depth + 1) : null;
                return !(item && item.value === undefined);
            }
        }
        return false;
    };
    // The environment of a call of a function value: its parameters bound to the arguments, and
    // the locals of its block
    const bind = (value, args) => {
        const env = new Map();
        value.node.params.forEach((param, i) => {
            let arg = args[i] && args[i].node && args[i].node.type !== 'Spread' ? args[i] : null;
            if (param.names && !arg && param.default) {
                // ({ size = 1 } = {}) called without its argument
                arg = { module: value.module, node: param.default, env };
            }
            if (param.name && arg) {
                env.set(param.name, arg);
            } else if (param.name && param.default) {
                env.set(param.name, { module: value.module, node: param.default, env: value.env });
            } else if (param.name) {
                // A missing argument is undefined
                env.set(param.name, { module: value.module, node: { type: 'Literal', value: undefined, start: 0, end: 0 }, env: null });
            } else if (param.names && arg) {
                // A destructured parameter ({ name, length = 64 }): the properties of the argument,
                // or their default value when the argument has no such property
                const object = param.names.some(name => name.default) ? resolve(arg) : null;
                for (const { key, local, default: fallback } of param.names) {
                    if (fallback && hasProperty(object, key) === false) {
                        env.set(local, { module: value.module, node: fallback, env });
                    } else {
                        env.set(local, { module: arg.module, node: { type: 'Member', object: arg.node, property: key, start: arg.node.start, end: arg.node.end }, env: arg.env });
                    }
                }
            } else if (param.names || param.rest) {
                // Without its argument, or a rest parameter: names that cannot be read
                for (const name of param.names ? param.names.map(item => item.local) : [param.rest]) {
                    env.set(name, { kind: 'local', name });
                }
            }
        });
        bindLocals(value, env, true);
        // The free names of a nested function still resolve where it is declared
        if (value.env) {
            for (const [name, bound] of value.env) {
                if (!env.has(name)) {
                    env.set(name, bound);
                }
            }
        }
        return env;
    };

    return { load, resolve, resolveExport, exportedValues, constant, constantProperties, functionBody, bind, bindLocals, modules };
}

// The name of a function of drizzle-orm (or of another package, or not imported at all) that a value
// is: 'pgTable', 'varchar'...; null for the declarations of the project
const externalName = (value) => {
    if (value && value.kind === 'external' && value.name !== '*' && value.name !== 'default') {
        return value.name;
    }
    return value && value.kind === 'unknown' && value.name ? value.name : null;
};
// The dialect of an import of drizzle-orm ('drizzle-orm/pg-core' → 'pg'), else of a function name
function dialectOf(value, fallback) {
    const match = value && value.kind === 'external' ? /^drizzle-orm\/([\w-]+)/.exec(value.source) : null;
    return (match && DIALECT_MODULES.get(match[1])) || fallback;
}
const isSqlTag = (value) => externalName(value) === 'sql';

// ---------------------------------------------------------------------------------------------
// Parser contract (docs/parsers.md)

module.exports.id = 'drizzle';
module.exports.label = 'Drizzle';

// 100 for a Drizzle config file whose schema files exist, or for a schema at a usual location with
// drizzle-orm or drizzle-kit in package.json; 50 for a config file whose schema is missing (parse()
// tells where it was looked for), or a schema at a usual location that imports drizzle-orm without
// the package. The package alone is not a Drizzle project: the root of a monorepo whose schema is
// in a package; the user is then told to set DrawMeDatabase.frameworkPath.
module.exports.detect = function (basePath) {
    if (typeof basePath !== 'string' || !isDirectory(basePath)) {
        return 0;
    }
    const location = locateSchema(basePath);
    if (location.configFile) {
        return location.files.length > 0 ? 100 : 50;
    }
    if (location.files.length === 0) {
        return 0;
    }
    if (location.packages.some(name => PACKAGES.includes(name))) {
        return 100;
    }
    return location.files.some(file => /\bfrom\s*['"]drizzle-orm(?:\/[\w-]+)?['"]/.test(readText(file) || '')) ? 50 : 0;
};

// The files read: the schema files and the files they import, the folders of the schema set in the
// config (its files, or the files its glob matches in its sub-folders: `**/schema.ts`), package.json,
// the config file and tsconfig.json, and the imports that do not exist yet (watched for their
// creation).
// options.overrides (the text of the unsaved editors): an unsaved drizzle.config.ts that moves the
// schema, or a schema file that imports another file, moves the sources too.
function sources(basePath, options = {}) {
    const overrides = (options && options.overrides) || null;
    const location = locateSchema(basePath, overrides);
    const aliases = readAliases(basePath, overrides);
    const missing = [];
    const reached = reachableFiles(location.files, overrides, createResolver(aliases), aliases, missing);
    return sourcesOf(basePath, location, reached, missing);
}
module.exports.sources = sources;

// ---------------------------------------------------------------------------------------------
// Tables

// Returns { tables, warnings }. Options:
// - git: false skips the git status
// - overrides: Map of absolute file path → text of an unsaved editor, read instead of the file
// - gitCache: Map kept between parses, to run git again only once it is cleared
// - columnSources: true adds the line of each column (source: { file, line })
// - details: true adds the column details (length, default...), the indexes and the referential
//   actions (docs/pivot-format.md)
module.exports.parse = function (basePath, options = {}) {
    const overrides = options.overrides || null;
    const location = locateSchema(basePath, overrides);
    const warnings = [...location.warnings];
    if (location.files.length === 0) {
        if (location.origin) {
            throw new ParserError(`The Drizzle schema set in ${location.origin} was not found: ${location.entries.join(', ')} (from ${basePath})`);
        }
        throw new ParserError(`No Drizzle schema found in ${basePath}: DrawMeDatabase reads the schema set in drizzle.config.ts (or .js, .json), else src/db/schema.ts, src/schema.ts, db/schema.ts, drizzle/schema.ts or a schema folder.`);
    }
    const aliases = readAliases(basePath, overrides);
    const resolver = createResolver(aliases);
    const program = createProgram(basePath, overrides, resolver);
    const { resolve, constant, constantProperties, functionBody, bind, bindLocals } = program;
    const at = (module, offset) => `${module.rel}:${module.lineAt(offset)}`;
    const schemaModules = location.files.map(file => program.load(file)).filter(Boolean);

    // The owner of `.table()`: a schema (pgSchema('auth'), snakeCase.schema('auth')) or a casing
    // object of drizzle-orm 1.0 (snakeCase): { dialect, schema, casing, computed } (computed: the
    // schema name is not a constant), or null
    const ownerOf = (ref, depth) => {
        const value = resolve(ref, depth + 1);
        const name = externalName(value);
        if (name && CASING_OBJECTS.has(name) && value.kind === 'external') {
            return { dialect: dialectOf(value, 'pg'), casing: CASING_OBJECTS.get(name), schema: null };
        }
        if (value.kind !== 'node' || value.node.type !== 'Call') {
            return null;
        }
        const calleeRef = { module: value.module, node: value.node.callee, env: value.env };
        const argRef = (i) => (value.node.args[i] ? { module: value.module, node: value.node.args[i], env: value.env } : null);
        const casingOf = (i) => {
            const casing = argRef(i) && constant(argRef(i));
            return casing && CASINGS.has(casing.value) ? casing.value : undefined;
        };
        const schemaName = () => {
            const schema = argRef(0) && constant(argRef(0));
            return schema && typeof schema.value === 'string' ? schema.value : null;
        };
        const fn = externalName(resolve(calleeRef, depth + 1));
        // source: the code of the schema, which names the table
        const source = { module: value.module, start: value.node.start, end: value.node.end };
        if (fn && SCHEMA_FUNCTIONS.has(fn)) {
            return { dialect: dialectOf(resolve(calleeRef, depth + 1), SCHEMA_FUNCTIONS.get(fn)), schema: schemaName(), casing: casingOf(1), computed: !schemaName(), source };
        }
        if (value.node.callee.type === 'Member' && value.node.callee.property === 'schema') {
            const owner = ownerOf({ module: value.module, node: value.node.callee.object, env: value.env }, depth + 1);
            if (owner && owner.casing && !owner.schema) {
                return { ...owner, schema: schemaName(), computed: !schemaName(), source };
            }
        }
        return null;
    };
    // The table function a callee is: { kind: 'table', dialect, schema, casing, prefix } (prefix:
    // the reference of the function of a table creator), { kind: 'view' }, { kind: 'wrapper', value }
    // (a function of the project, to inline), or null
    const tableFunction = (calleeRef, depth) => {
        const callee = calleeRef.node;
        if (callee.type === 'Member') {
            const objectRef = { ...calleeRef, node: callee.object };
            if (callee.property === 'table' || callee.property === 'view' || callee.property === 'materializedView') {
                const owner = ownerOf(objectRef, depth);
                if (owner) {
                    return callee.property === 'table' ? { kind: 'table', ...owner } : { kind: 'view' };
                }
            }
            if (callee.property === 'withRLS') {
                const inner = tableFunction(objectRef, depth + 1);
                if (inner && inner.kind === 'table') {
                    return inner;
                }
            }
        }
        const value = resolve(calleeRef, depth + 1);
        const name = externalName(value);
        if (name && TABLE_FUNCTIONS.has(name)) {
            return { kind: 'table', dialect: dialectOf(value, TABLE_FUNCTIONS.get(name)), schema: null };
        }
        if (name && VIEW_FUNCTIONS.has(name)) {
            return { kind: 'view' };
        }
        if (value.kind === 'node' && value.node.type === 'Call') {
            // const createTable = pgTableCreator((name) => `app_${name}`)
            const creatorRef = { module: value.module, node: value.node.callee, env: value.env };
            const creatorValue = resolve(creatorRef, depth + 1);
            const creator = externalName(creatorValue);
            if (creator && TABLE_CREATORS.has(creator)) {
                const casingRef = value.node.args[1] ? { module: value.module, node: value.node.args[1], env: value.env } : null;
                const casing = casingRef && constant(casingRef);
                return {
                    kind: 'table',
                    dialect: dialectOf(creatorValue, TABLE_CREATORS.get(creator)),
                    schema: null,
                    casing: casing && CASINGS.has(casing.value) ? casing.value : undefined,
                    prefix: value.node.args[0] ? { module: value.module, node: value.node.args[0], env: value.env } : null,
                };
            }
            // A view: pgView('name').as(...)
            let root = value.node;
            while (root.type === 'Call' && root.callee.type === 'Member') {
                root = root.callee.object;
            }
            if (root.type === 'Call' && VIEW_FUNCTIONS.has(externalName(resolve({ module: value.module, node: root.callee, env: value.env }, depth + 1)))) {
                return { kind: 'view' };
            }
        }
        if (value.kind === 'node' && (value.node.type === 'Arrow' || value.node.type === 'Function')) {
            return { kind: 'wrapper', value };
        }
        return null;
    };
    // The table call of an expression: { fn, args: [references], ref } or { view: true }, or null
    const tableCall = (ref, depth = 0) => {
        if (depth > MAX_DEPTH || !ref.node) {
            return null;
        }
        let node = ref.node;
        while (node.type === 'Call' && node.callee.type === 'Member' && (TABLE_METHODS.has(node.callee.property) || VIEW_METHODS.has(node.callee.property)) && node.callee.object.type === 'Call') {
            node = node.callee.object;
        }
        if (node.type !== 'Call') {
            return null;
        }
        const fn = tableFunction({ module: ref.module, node: node.callee, env: ref.env }, depth);
        if (!fn) {
            return null;
        }
        if (fn.kind === 'view') {
            return { view: true };
        }
        const args = node.args.map(arg => (arg.type === 'Spread' ? null : { module: ref.module, node: arg, env: ref.env }));
        if (fn.kind === 'wrapper') {
            const body = functionBody(fn.value.node);
            const inner = body ? tableCall({ module: fn.value.module, node: body, env: bind(fn.value, args) }, depth + 1) : null;
            // wrappers: the functions of the project that make the table, which may name it
            return inner && !inner.view ? { ...inner, wrappers: [{ module: fn.value.module, start: fn.value.node.start, end: fn.value.node.end }, ...(inner.wrappers || [])] } : inner;
        }
        return { fn, args, ref: { ...ref, node } };
    };

    // -----------------------------------------------------------------------------------------
    // Tables: their columns and keys, read once per declaration

    const models = new Map();
    const modelOf = (value) => {
        const key = value.decl || value.node;
        if (models.has(key)) {
            return models.get(key);
        }
        models.set(key, null);
        const call = value.kind === 'node' ? tableCall(value) : null;
        const model = call && !call.view ? buildTable(value, call) : null;
        models.set(key, model);
        return model;
    };

    const buildTable = (value, call) => {
        const decl = value.decl || { name: 'default', start: value.node.start, end: value.node.end, nameStart: value.node.start };
        const module = value.module;
        const { fn, args } = call;
        // nameSources: the code outside of the declaration that names the table (the prefix of a
        // table creator, the pgSchema() of its schema, a wrapper, a constant), for its git status
        // extraSources: the code outside of the declaration that makes its extra config (a helper)
        const model = { decl, module, dialect: fn.dialect, columns: [], indexes: [], primaryKeys: [], uniques: [], foreignKeys: [], nameSources: [], extraSources: [], valid: true };
        const addNameSource = (source) => {
            if (source && source.module && !(source.module === module && source.start >= decl.start && source.end <= decl.end)) {
                model.nameSources.push({ module: source.module, start: source.start, end: source.end });
            }
        };
        const location = at(module, decl.nameStart);
        // The name: a constant, with the prefix of a table creator and the schema
        const name = args[0] && constant(args[0]);
        if (!name || typeof name.value !== 'string' || name.value === '') {
            warnings.push(`${location}: ${decl.name}: the table name is computed, table skipped.`);
            model.valid = false;
            return model;
        }
        const nameValue = resolve(args[0]);
        if (nameValue.kind === 'node') {
            addNameSource({ module: nameValue.module, start: nameValue.node.start, end: nameValue.node.end });
        }
        (call.wrappers || []).forEach(addNameSource);
        addNameSource(fn.source);
        let table = name.value;
        if (fn.prefix) {
            const prefixValue = resolve(fn.prefix);
            if (prefixValue.kind === 'node') {
                addNameSource({ module: prefixValue.module, start: prefixValue.node.start, end: prefixValue.node.end });
            }
            const body = prefixValue.kind === 'node' ? functionBody(prefixValue.node) : null;
            const prefixed = body && constant({ module: prefixValue.module, node: body, env: bind(prefixValue, [{ module, node: { type: 'String', value: table } }]) });
            if (prefixed && typeof prefixed.value === 'string') {
                table = prefixed.value;
            } else {
                warnings.push(`${location}: ${decl.name}: the name prefix of the table creator is computed, the table is named ${table}.`);
            }
        }
        if (fn.computed) {
            warnings.push(`${location}: ${decl.name}: the schema name is computed, the table is named ${table}.`);
        }
        const defaultSchema = DEFAULT_SCHEMAS.get(fn.dialect);
        model.table = fn.schema && fn.schema !== defaultSchema ? `${fn.schema}.${table}` : table;
        // drizzle-kit leaves out the tables of another MySQL database (mysqlSchema('analytics'))
        model.otherDatabase = Boolean(fn.schema) && (fn.dialect === 'mysql' || fn.dialect === 'singlestore');
        const casing = fn.casing || locationCasing;
        model.casing = casing;

        // Columns: the object (or the callback that returns it), its spreads (an object that spreads
        // itself is read once). As in JavaScript, a key written again (`{ ...base, id: uuid() }`)
        // keeps the place of the first one and takes the last value.
        const entries = new Map();
        const visiting = new Set();
        const collect = (ref, depth) => {
            const object = resolve(ref, depth + 1);
            if (depth > MAX_DEPTH || object.kind !== 'node' || visiting.has(object.node)) {
                return false;
            }
            if (object.node.type === 'Arrow' || object.node.type === 'Function') {
                // (d) => ({ id: d.integer() }), ({ integer }) => ({ id: integer() })
                const env = new Map();
                const param = object.node.params[0];
                if (param && param.name) {
                    env.set(param.name, { kind: 'builders' });
                } else if (param && param.names) {
                    param.names.forEach(({ key: builder, local }) => env.set(local, { kind: 'builder', name: builder }));
                }
                bindLocals(object, env);
                for (const [name, bound] of object.env || []) {
                    if (!env.has(name)) {
                        env.set(name, bound);
                    }
                }
                const body = functionBody(object.node);
                return Boolean(body) && collect({ module: object.module, node: body, env }, depth + 1);
            }
            if (object.node.type === 'Call') {
                // ...timestamps(): a helper that returns the columns
                const helper = resolve({ module: object.module, node: object.node.callee, env: object.env }, depth + 1);
                const body = helper.kind === 'node' ? functionBody(helper.node) : null;
                return Boolean(body) && collect({ module: helper.module, node: body, env: bind(helper, object.node.args.map(arg => ({ module: object.module, node: arg, env: object.env }))) }, depth + 1);
            }
            if (object.node.type !== 'Object') {
                return false;
            }
            visiting.add(object.node);
            for (const property of object.node.properties) {
                if (property.kind === 'init' && !property.computed) {
                    entries.set(property.key, { key: property.key, ref: { module: object.module, node: property.value, env: object.env }, module: object.module, start: property.start, end: property.end });
                } else if (property.kind === 'spread') {
                    if (!collect({ module: object.module, node: property.value, env: object.env }, depth + 1)) {
                        warnings.push(`${at(object.module, property.start)}: ${model.table}: ...${sourceText(object.module, property.value)} cannot be read, its columns are skipped.`);
                    }
                } else if (property.kind !== 'method') {
                    warnings.push(`${at(object.module, property.start)}: ${model.table}: a computed column key cannot be read, column skipped.`);
                }
            }
            visiting.delete(object.node);
            return true;
        };
        if (!args[1] || !collect(args[1], 0)) {
            warnings.push(`${location}: ${model.table}: the columns cannot be read.`);
        }
        for (const entry of entries.values()) {
            const column = readColumn(entry, model, casing);
            if (column) {
                model.columns.push(column);
            }
        }
        // The extra config: keys, indexes, foreign keys
        if (args[2]) {
            readExtras(args[2], model);
        }
        return model;
    };
    const locationCasing = location.casing;

    // The text of a node, for the warnings (at most 40 characters)
    const sourceText = (module, node) => {
        const cached = scanCache.get(module.file);
        const file = cached ? cached.text : readText(module.file, overrides);
        const text = file === null ? '' : file.slice(node.start, node.end).replace(/\s+/g, ' ');
        return text.length > 40 ? `${text.slice(0, 40)}...` : text;
    };

    // A column value as a builder call and its chained calls, in the order of the code: { builder:
    // { name, enumValue, custom, args }, calls: [{ name, args }], sources }, or null. Helpers of the
    // project are inlined (`id: idColumn()`, `id: nanoId('id')`), shared builders followed (`id:
    // id`); sources: where their code is ({ module, start, end }), for the git status of the column.
    const flatten = (ref, depth = 0) => {
        if (depth > MAX_DEPTH || !ref.node) {
            return null;
        }
        const node = ref.node;
        const refOf = (child) => ({ module: ref.module, node: child, env: ref.env });
        if (node.type === 'Call') {
            const args = node.args.map(arg => (arg.type === 'Spread' ? null : refOf(arg)));
            const callee = node.callee;
            if (callee.type === 'Member') {
                const object = resolve(refOf(callee.object), depth + 1);
                if (object.kind === 'builders' || (object.kind === 'namespace' && !object.module)) {
                    return { builder: { name: callee.property, args }, calls: [], sources: [] };
                }
                if (object.kind === 'namespace' && object.module) {
                    return builderOf(resolve(refOf(callee), depth + 1), callee.property, args, depth);
                }
                if (object.kind === 'node' && object.node.type === 'Object') {
                    // columns.id(): a helper in an object of helpers
                    return builderOf(resolve(refOf(callee), depth + 1), callee.property, args, depth);
                }
                const inner = flatten(refOf(callee.object), depth + 1);
                if (!inner) {
                    return null;
                }
                inner.calls.push({ name: callee.property, args });
                return inner;
            }
            if (callee.type === 'Identifier') {
                return builderOf(resolve(refOf(callee), depth + 1), callee.name, args, depth);
            }
            return null;
        }
        if (node.type === 'Identifier' || node.type === 'Member') {
            const value = resolve(ref, depth + 1);
            const inner = value.kind === 'node' && value.node !== node ? flatten(value, depth + 1) : null;
            if (inner) {
                inner.sources.push({ module: value.module, start: value.node.start, end: value.node.end });
            }
            return inner;
        }
        return null;
    };
    // The builder of a call of `value` (named `local` in the code) with `args`. A local variable of
    // a helper that cannot be read, or a value that is no function (a parameter without its
    // argument), is no builder: null.
    const builderOf = (value, local, args, depth) => {
        if (value.kind === 'builder') {
            return { builder: { name: value.name, args }, calls: [], sources: [] };
        }
        if (value.kind === 'local') {
            return null;
        }
        if (value.kind === 'node') {
            const node = value.node;
            const source = { module: value.module, start: node.start, end: node.end };
            if (node.type === 'Arrow' || node.type === 'Function') {
                const body = functionBody(node);
                const inner = body ? flatten({ module: value.module, node: body, env: bind(value, args) }, depth + 1) : null;
                if (inner) {
                    inner.sources.push(source);
                }
                return inner;
            }
            if (node.type === 'Call') {
                const calleeRef = { module: value.module, node: node.callee, env: value.env };
                const fn = externalName(resolve(calleeRef, depth + 1));
                // const role = pgEnum('role', [...]) and pgSchema('auth').enum(...)
                if (fn === 'pgEnum' || (node.callee.type === 'Member' && node.callee.property === 'enum' && ownerOf({ module: value.module, node: node.callee.object, env: value.env }, depth))) {
                    return { builder: { name: local, enumValue: enumOf(value), args }, calls: [], sources: [source] };
                }
                if (fn === 'customType') {
                    return { builder: { name: local, custom: customOf(value), args }, calls: [], sources: [source] };
                }
                return { builder: { name: local, args }, calls: [], sources: [source] };
            }
            return null;
        }
        const name = externalName(value);
        return { builder: { name: name || local, args }, calls: [], sources: [] };
    };
    // The values and the name of a pgEnum: { name, values }
    const enumOf = (value) => {
        const args = value.node.args.map(arg => ({ module: value.module, node: arg, env: value.env }));
        const name = args[0] && constant(args[0]);
        let values = args[1] && constant(args[1]);
        values = values && Array.isArray(values.value) ? values.value : values && values.value && typeof values.value === 'object' ? Object.values(values.value) : undefined;
        let enumName = name && typeof name.value === 'string' ? name.value : undefined;
        const callee = value.node.callee;
        if (enumName !== undefined && callee.type === 'Member' && callee.property === 'enum') {
            const owner = ownerOf({ module: value.module, node: callee.object, env: value.env }, 0);
            if (owner && owner.schema && owner.schema !== DEFAULT_SCHEMAS.get(owner.dialect)) {
                enumName = `${owner.schema}.${enumName}`;
            }
        }
        return { name: enumName, values: values && values.every(v => typeof v === 'string') ? values : undefined };
    };
    // The SQL type of a customType: { dataType } when its dataType() returns a constant
    const customOf = (value) => {
        const options = value.node.args[0] ? resolve({ module: value.module, node: value.node.args[0], env: value.env }) : null;
        if (!options || options.kind !== 'node' || options.node.type !== 'Object') {
            return {};
        }
        const property = options.node.properties.find(p => (p.kind === 'init' || p.kind === 'method') && p.key === 'dataType');
        const fn = property && resolve({ module: options.module, node: property.value, env: options.env });
        const body = fn && fn.kind === 'node' ? functionBody(fn.node) : null;
        const dataType = body && constant({ module: fn.module, node: body, env: bind(fn, []) });
        return { dataType: dataType && typeof dataType.value === 'string' ? dataType.value : undefined };
    };

    // A column of the object of a table: { key, name, type, notNull, primary, unique, details,
    // module, start, end (of its key and value), references } or null
    const readColumn = (entry, model, casing) => {
        const label = `${model.table}.${entry.key}`;
        const location = at(entry.module, entry.start);
        const flat = flatten(entry.ref);
        if (!flat) {
            warnings.push(`${location}: ${label}: column not understood, skipped.`);
            return null;
        }
        const { builder, calls } = flat;
        const args = builder.args.filter(Boolean);
        // The name (first argument) and the options (an object argument)
        let name;
        let optionsRef = null;
        const inlineEnum = INLINE_ENUMS.has(builder.name);
        // The values of mysqlEnum(): an array, or an object (a TypeScript enum)
        const isValues = (value) => value.kind === 'enum' || (value.kind === 'node' && (value.node.type === 'Array' || (inlineEnum && value.node.type === 'Object')));
        const isOptions = (value) => value.kind === 'node' && value.node.type === 'Object' && !inlineEnum;
        const first = args[0];
        if (first) {
            const value = resolve(first);
            if (isOptions(value)) {
                optionsRef = first;
            } else if (!isValues(value)) {
                const constantName = constant(first);
                if (constantName && typeof constantName.value === 'string') {
                    name = constantName.value;
                } else if (!(constantName && constantName.value === undefined)) {
                    warnings.push(`${location}: ${label}: the column name is computed, the key is used.`);
                }
                if (args[1] && isOptions(resolve(args[1]))) {
                    optionsRef = args[1];
                }
            }
        }
        const options = optionsRef ? constantProperties(optionsRef) || {} : {};
        const column = {
            key: entry.key,
            name: name !== undefined && name !== '' ? name : applyCasing(casing, entry.key),
            type: builder.name,
            notNull: false,
            primary: false,
            unique: false,
            details: {},
            module: entry.module,
            start: entry.start,
            end: entry.end,
            // The code of the helpers and shared builders that make it, out of its own lines
            sources: flat.sources.filter(source => !(source.module === entry.module && source.start >= entry.start && source.end <= entry.end)),
            references: [],
        };
        const details = column.details;
        if (builder.enumValue) {
            column.type = builder.enumValue.name || builder.name;
            if (builder.enumValue.values) {
                details.values = builder.enumValue.values;
            }
        } else if (inlineEnum) {
            column.type = 'enum';
            const valuesRef = args.find(arg => isValues(resolve(arg)));
            const values = valuesRef && constant(valuesRef);
            const list = values && Array.isArray(values.value) ? values.value : values && values.value && typeof values.value === 'object' ? Object.values(values.value) : null;
            if (list && list.every(v => typeof v === 'string')) {
                details.values = list;
            }
        }
        if (builder.custom && builder.custom.dataType) {
            details.nativeType = builder.custom.dataType;
            const sized = /^(?:var)?char\s*\(\s*(\d+)\s*\)$/i.exec(builder.custom.dataType);
            if (sized) {
                details.length = Number(sized[1]);
            }
        }
        if (Number.isInteger(options.length)) {
            details.length = options.length;
        }
        if (DECIMAL_BUILDERS.has(builder.name) && Number.isInteger(options.precision)) {
            details.precision = options.precision;
            if (Number.isInteger(options.scale)) {
                details.scale = options.scale;
            }
        }
        if (options.unsigned === true) {
            details.unsigned = true;
        }
        const serials = SERIALS.get(model.dialect);
        if (serials && serials.has(builder.name)) {
            column.notNull = true;
            details.autoIncrement = true;
        }
        let dimensions = 0;
        for (const call of calls) {
            const callArgs = call.args.filter(Boolean);
            switch (call.name) {
                case 'notNull':
                    column.notNull = true;
                    break;
                case 'primaryKey': {
                    column.primary = true;
                    column.notNull = true;
                    const config = callArgs[0] ? constantProperties(callArgs[0]) : null;
                    if (config && config.autoIncrement === true) {
                        details.autoIncrement = true;
                    }
                    break;
                }
                case 'unique':
                    column.unique = true;
                    break;
                case 'default':
                    delete details.default;
                    delete details.defaultRaw;
                    Object.assign(details, callArgs[0] ? defaultOf(callArgs[0], dimensions > 0, JSON_BUILDERS.has(builder.name) || options.mode === 'json') : {});
                    break;
                case 'defaultNow':
                    // The SQL of drizzle-orm, as drizzle-kit writes it
                    delete details.default;
                    details.defaultRaw = model.dialect === 'pg' ? 'now()'
                        : model.dialect === 'sqlite' ? '(cast((julianday(\'now\') - 2440587.5)*86400000 as integer))'
                            : model.dialect === 'singlestore' && builder.name === 'timestamp' ? 'CURRENT_TIMESTAMP' : '(now())';
                    break;
                case 'defaultRandom':
                    delete details.default;
                    details.defaultRaw = 'gen_random_uuid()';
                    break;
                case 'onUpdateNow':
                    details.onUpdateCurrent = true;
                    break;
                case 'autoincrement':
                    details.autoIncrement = true;
                    break;
                case 'generatedAlwaysAsIdentity':
                case 'generatedByDefaultAsIdentity':
                    details.autoIncrement = true;
                    column.notNull = true;
                    break;
                case 'array': {
                    const dims = callArgs[0] && constant(callArgs[0]);
                    dimensions += dims && typeof dims.value === 'string' && /^(\[\])+$/.test(dims.value) ? dims.value.length / 2 : 1;
                    break;
                }
                case 'references':
                    column.references.push({ fn: callArgs[0], config: callArgs[1] ? constantProperties(callArgs[1]) || {} : {}, module: entry.module, start: entry.start });
                    break;
                default:
                    break;
            }
        }
        // The length and the enum values of an array are those of its items (varchar(10)[])
        column.type += '[]'.repeat(dimensions);
        return column;
    };

    // The SQL of a sql`...` template, its substitutions written by `substitute` (null: not a
    // column) or as constants, or of sql.raw('...') with a constant; null when it is not a
    // template or a substitution is computed
    const sqlText = (ref, substitute = () => null) => {
        const value = resolve(ref);
        if (value.kind === 'node' && value.node.type === 'Call' && value.node.callee.type === 'Member' && value.node.callee.property === 'raw' && value.node.args.length === 1
            && isSqlTag(resolve({ module: value.module, node: value.node.callee.object, env: value.env }))) {
            const raw = constant({ module: value.module, node: value.node.args[0], env: value.env });
            return raw && typeof raw.value === 'string' ? raw.value : null;
        }
        if (value.kind !== 'node' || value.node.type !== 'Tagged' || !isSqlTag(resolve({ module: value.module, node: value.node.tag, env: value.env }))) {
            return null;
        }
        const quasi = value.node.quasi;
        let text = cook(quasi.quasis[0]);
        for (let i = 0; i < quasi.expressions.length; i++) {
            const subRef = { module: value.module, node: quasi.expressions[i], env: value.env };
            const column = substitute(subRef);
            const part = column === null ? constant(subRef) : { value: column };
            if (!part || part.value === undefined || (typeof part.value === 'object' && part.value !== null)) {
                return null;
            }
            text += String(part.value) + cook(quasi.quasis[i + 1] || '');
        }
        return text;
    };

    // The default of `.default(value)`: { default } for a constant, { defaultRaw } for sql`...` and
    // sql.raw('...') (the SQL as written), {} for a value computed at run time
    const defaultOf = (ref, isArray, isJson) => {
        const value = resolve(ref);
        if (value.kind === 'node' && (value.node.type === 'Tagged' || value.node.type === 'Call')) {
            const text = sqlText(value);
            if (text !== null || value.node.type === 'Tagged') {
                return text === null ? {} : { defaultRaw: text };
            }
        }
        const item = constant(value);
        if (!item || item.value === undefined) {
            return {};
        }
        if (isJson) {
            // drizzle-orm writes the JSON of the value
            return isArray ? {} : { default: JSON.stringify(item.value) };
        }
        if (typeof item.value === 'number' && (item.bigint || (Number.isInteger(item.value) && !Number.isSafeInteger(item.value)))) {
            return { defaultRaw: String(item.raw).replace(/[n_]/g, '') };
        }
        if (item.value !== null && typeof item.value === 'object') {
            // An array column: the default is an SQL array literal, not given
            return isArray ? {} : { default: JSON.stringify(item.value) };
        }
        return { default: item.value };
    };

    // The key of a column of the table in its extra config (t.email, t.email.desc().op('...'), a
    // destructured name, users.email for the table itself), or null (an SQL expression)
    const columnKey = (ref, model) => {
        let node = ref.node;
        while (node && node.type === 'Call' && node.callee.type === 'Member' && INDEX_COLUMN_METHODS.has(node.callee.property)) {
            node = node.callee.object;
        }
        const value = resolve({ ...ref, node });
        if (value.kind === 'column') {
            return value.key;
        }
        if (value.kind === 'member' && value.object.kind === 'node' && (value.object.decl === model.decl)) {
            return value.name;
        }
        return null;
    };
    // The tables of drizzle-orm/supabase that a schema references without creating them
    // (authUsers: auth.users), one model each
    const stubs = new Map();
    const stubModel = (name) => {
        if (!stubs.has(name)) {
            const known = SUPABASE_TABLES.get(name);
            stubs.set(name, { table: known.table, columns: Object.entries(known.columns).map(([key, column]) => ({ key, name: column })), casing: undefined, valid: true });
        }
        return stubs.get(name);
    };
    // The table and the key of a column of another table (users.id): { model, key } or null
    const foreignColumn = (ref, depth = 0) => {
        let value = resolve(ref);
        if (value.kind === 'node' && (value.node.type === 'Arrow' || value.node.type === 'Function') && depth === 0) {
            const body = functionBody(value.node);
            if (!body) {
                return null;
            }
            value = resolve({ module: value.module, node: body, env: bind(value, []) });
        }
        if (value.kind === 'column') {
            return { model: value.table, key: value.key };
        }
        // authUsers.id of drizzle-orm/supabase
        if (value.kind === 'member' && value.object.kind === 'external' && /^drizzle-orm\/supabase(?:\/|$)/.test(value.object.source) && SUPABASE_TABLES.has(value.object.name)) {
            return { model: stubModel(value.object.name), key: value.name };
        }
        if (value.kind !== 'member' || value.object.kind !== 'node') {
            return null;
        }
        const target = modelOf(value.object);
        return target && target.valid ? { model: target, key: value.name } : null;
    };

    // The value of an expression, the calls of the functions of the project inlined (a helper that
    // returns the indexes of a table): their returned expression, with their parameters bound to
    // the arguments; { kind: 'opaque' } for a function of the project that cannot be read. track:
    // called with each function inlined.
    const evaluate = (ref, depth = 0, track = null) => {
        const value = ref.kind ? ref : resolve(ref, depth + 1);
        if (depth > MAX_DEPTH || value.kind !== 'node' || value.node.type !== 'Call') {
            return value;
        }
        const callee = resolve({ module: value.module, node: value.node.callee, env: value.env }, depth + 1);
        if (callee.kind !== 'node' || (callee.node.type !== 'Arrow' && callee.node.type !== 'Function')) {
            return value;
        }
        if (track) {
            track(callee);
        }
        const body = functionBody(callee.node);
        if (!body) {
            return { kind: 'opaque' };
        }
        const args = value.node.args.map(arg => ({ module: value.module, node: arg, env: value.env }));
        return evaluate({ module: callee.module, node: body, env: bind(callee, args) }, depth + 1, track);
    };

    // The extra config of a table (third argument): primary keys, unique constraints and indexes,
    // foreign keys. As drizzle-orm reads it: the items of the array it returns, a nested array
    // flattened once (extraConfig.flat(1)), or the values of the object it returns (before 0.29);
    // the spreads and the helpers of the project are followed. Policies and checks are skipped; an
    // item that cannot be read is told.
    const readExtras = (ref, model) => {
        // Each warning once (a helper spread twice that cannot be read is told once)
        const toldOnce = new Set();
        const told = (itemRef, text) => {
            const warning = `${at(itemRef.module, itemRef.node.start)}: ${model.table}: ${text}`;
            if (!toldOnce.has(warning)) {
                toldOnce.add(warning);
                warnings.push(warning);
            }
        };
        // The code outside of the declaration that the extra config is made of (a helper of
        // another file, its locals), for the git status of the table
        const track = (value) => {
            if (value && value.kind === 'node' && value.module && value.node.end > value.node.start
                && !(value.module === model.module && value.node.start >= model.decl.start && value.node.end <= model.decl.end)) {
                model.extraSources.push({ module: value.module, start: value.node.start, end: value.node.end });
            }
        };
        const evaluated = (itemRef) => {
            const value = evaluate(itemRef, 0, track);
            track(value);
            return value;
        };
        const fn = evaluated(ref);
        const env = new Map();
        if (fn.kind === 'node' && (fn.node.type === 'Arrow' || fn.node.type === 'Function')) {
            const param = fn.node.params[0];
            if (param && param.name) {
                env.set(param.name, { kind: 'self', table: model });
            } else if (param && param.names) {
                param.names.forEach(({ key, local }) => env.set(local, { kind: 'column', table: model, key }));
            }
            bindLocals(fn, env);
            for (const [name, bound] of fn.env || []) {
                if (!env.has(name)) {
                    env.set(name, bound);
                }
            }
        }
        const body = fn.kind === 'node' ? functionBody(fn.node) : null;
        const list = body ? evaluated({ module: fn.module, node: body, env }) : null;
        if (!list || list.kind !== 'node' || (list.node.type !== 'Array' && list.node.type !== 'Object')) {
            told(ref, 'the extra config cannot be read, its keys and indexes are skipped.');
            return;
        }
        // The arrays and objects being expanded: a spread of one of them (a helper that spreads
        // itself, `const l = [...l]`) never ends when run, it is told instead of being read again
        const expanding = new Set();
        let count = 0;
        // The spread of an array or object `spread` (written at itemRef) read by `expand`, or the
        // reason it is not: unread 'self', 'many' (more items than an extra config holds), or true
        const expandSpread = (spread, itemRef, type, depth, expand) => {
            if (spread.kind === 'node' && expanding.has(spread.node)) {
                return [{ ...itemRef, unread: 'self' }];
            }
            if (spread.kind !== 'node' || spread.node.type !== type || depth >= MAX_DEPTH) {
                return [{ ...itemRef, unread: true }];
            }
            if (count > MAX_EXTRA_ITEMS) {
                return [{ ...itemRef, unread: 'many' }];
            }
            expanding.add(spread.node);
            const items = expand(spread, depth + 1);
            expanding.delete(spread.node);
            return items;
        };
        // The items of an array, its spreads read (`unread`: a spread that cannot be read), in the
        // order of the code
        const arrayItems = (array, depth) => {
            const items = [];
            for (const element of array.node.elements) {
                const itemRef = { module: array.module, node: element.type === 'Spread' ? element.argument : element, env: array.env };
                if (element.type === 'Spread') {
                    for (const item of expandSpread(evaluated(itemRef), itemRef, 'Array', depth, arrayItems)) {
                        items.push(item);
                    }
                } else {
                    count++;
                    items.push(itemRef);
                }
            }
            return items;
        };
        // The values of an object, its spreads read
        const objectValues = (object, depth) => {
            const values = [];
            for (const property of object.node.properties) {
                const itemRef = property.value ? { module: object.module, node: property.value, env: object.env } : null;
                if (itemRef && property.kind === 'init') {
                    count++;
                    values.push(itemRef);
                } else if (itemRef && property.kind === 'spread') {
                    for (const value of expandSpread(evaluated(itemRef), itemRef, 'Object', depth, objectValues)) {
                        values.push(value);
                    }
                }
            }
            return values;
        };
        const listItems = (value) => {
            expanding.add(value.node);
            const items = value.node.type === 'Array' ? arrayItems(value, 0) : objectValues(value, 0);
            expanding.delete(value.node);
            return items;
        };
        // An item, unless it is a spread that cannot be read; nested: in a nested array
        const readItem = (itemRef, nested) => {
            if (itemRef.unread === 'many') {
                told(ref, `the extra config gives more than ${MAX_EXTRA_ITEMS} keys and indexes, the others are skipped.`);
                return;
            }
            if (itemRef.unread) {
                const spread = `...${sourceText(itemRef.module, itemRef.node)}`;
                told(itemRef, itemRef.unread === 'self' ? `${spread} spreads itself without end, its keys and indexes are skipped.` : `${spread} cannot be read, its keys and indexes are skipped.`);
                return;
            }
            const item = evaluated(itemRef);
            if (list.node.type === 'Array' && item.kind === 'node' && item.node.type === 'Array') {
                // A nested array, flattened once by drizzle-orm
                if (nested) {
                    told(itemRef, 'an array nested twice in the extra config is ignored by drizzle-kit, skipped.');
                } else {
                    listItems(item).forEach(innerRef => readItem(innerRef, true));
                }
                return;
            }
            readExtra(item, itemRef, model, evaluated);
        };
        listItems(list).forEach(itemRef => readItem(itemRef, false));
    };
    // An item of the extra config (`value`, written at itemRef), its helpers inlined by `evaluated`
    const readExtra = (value, itemRef, model, evaluated) => {
        const location = at(itemRef.module, itemRef.node.start);
        const notRead = () => warnings.push(`${location}: ${model.table}: ${sourceText(itemRef.module, itemRef.node)} in the extra config cannot be read, skipped.`);
        if (value.kind === 'node' && value.node.type === 'Object') {
            warnings.push(`${location}: ${model.table}: an object in the extra config is ignored by drizzle-kit, skipped.`);
            return;
        }
        // The chain: index('name').on(t.a).where(...), its calls with their arguments; a helper of
        // the project at its root is inlined (tenantIndex(t).where(...))
        const calls = [];
        let current = value;
        let root = null;
        for (let depth = 0; !root; depth++) {
            if (current.kind !== 'node' || depth > MAX_DEPTH) {
                notRead();
                return;
            }
            const scope = current;
            const refOf = (child) => ({ module: scope.module, node: child, env: scope.env });
            const chain = [];
            let node = scope.node;
            // pg.index(...): the function of a namespace, not a call on a chain
            while (node.type === 'Call' && node.callee.type === 'Member' && resolve(refOf(node.callee.object)).kind !== 'namespace') {
                chain.unshift({ name: node.callee.property, args: node.args.map(refOf) });
                node = node.callee.object;
            }
            calls.unshift(...chain);
            if (node.type !== 'Call') {
                notRead();
                return;
            }
            const callee = resolve(refOf(node.callee));
            if (callee.kind === 'node' && (callee.node.type === 'Arrow' || callee.node.type === 'Function')) {
                current = evaluated(refOf(node));
            } else {
                root = { callee, args: node.args.map(refOf) };
            }
        }
        const fn = externalName(root.callee);
        if (!EXTRA_FUNCTIONS.has(fn)) {
            // Checks, policies (pgPolicy, crudPolicy of drizzle-orm/neon...) are not drawn
            if (!SKIPPED_EXTRAS.has(fn) && !(root.callee.kind === 'external' && /^drizzle-orm(?:\/|$)/.test(root.callee.source))) {
                notRead();
            }
            return;
        }
        const { args } = root;
        const keysOf = (refs) => {
            const keys = refs.map(item => columnKey(item, model));
            return keys.every(Boolean) ? keys : null;
        };
        const onCall = calls.find(call => call.name === 'on' || call.name === 'onOnly' || call.name === 'using');
        // The columns of an index: { key } of a column, or { expression }: the SQL of an expression
        // (lower(email)), its columns by name; null when one cannot be read
        const indexColumns = () => {
            const items = (onCall.name === 'using' ? onCall.args.slice(1) : onCall.args).map(item => {
                const key = columnKey(item, model);
                if (key) {
                    return { key };
                }
                const expression = sqlText(item, (sub) => {
                    const column = columnKey(sub, model);
                    const found = column && model.columns.find(c => c.key === column);
                    return column ? (found ? found.name : applyCasing(model.casing, column)) : null;
                });
                return expression !== null ? { expression } : null;
            });
            return items.every(Boolean) ? items : null;
        };
        const nameOf = (i = 0) => {
            const name = args[i] && constant(args[i]);
            return name && typeof name.value === 'string' ? name.value : undefined;
        };
        if (fn === 'primaryKey') {
            const config = args[0] && resolve(args[0]);
            let keys;
            let pkName;
            if (config && config.kind === 'node' && config.node.type === 'Object') {
                const columns = config.node.properties.find(p => p.kind === 'init' && p.key === 'columns');
                const list = columns && resolve({ module: config.module, node: columns.value, env: config.env });
                keys = list && list.kind === 'node' && list.node.type === 'Array' ? keysOf(list.node.elements.map(e => ({ module: list.module, node: e, env: list.env }))) : null;
                const nameProperty = config.node.properties.find(p => p.kind === 'init' && p.key === 'name');
                const name = nameProperty && constant({ module: config.module, node: nameProperty.value, env: config.env });
                pkName = name && typeof name.value === 'string' ? name.value : undefined;
            } else {
                // primaryKey(t.a, t.b), the form of drizzle-orm before 0.29
                keys = keysOf(args);
            }
            if (!keys || keys.length === 0) {
                warnings.push(`${location}: ${model.table}: the columns of the primary key cannot be read.`);
                return;
            }
            model.primaryKeys.push({ keys, name: pkName });
            return;
        }
        if (fn === 'foreignKey') {
            const config = args[0] && resolve(args[0]);
            if (!config || config.kind !== 'node' || config.node.type !== 'Object') {
                warnings.push(`${location}: ${model.table}: the foreign key cannot be read, relation skipped.`);
                return;
            }
            const property = (key) => {
                const found = config.node.properties.find(p => p.kind === 'init' && p.key === key);
                const list = found && resolve({ module: config.module, node: found.value, env: config.env });
                return list && list.kind === 'node' && list.node.type === 'Array' ? list.node.elements.map(e => ({ module: list.module, node: e, env: list.env })) : null;
            };
            const columns = property('columns');
            const foreign = property('foreignColumns');
            const keys = columns && keysOf(columns);
            if (!keys || !foreign || foreign.length !== keys.length) {
                warnings.push(`${location}: ${model.table}: the columns of the foreign key cannot be read, relation skipped.`);
                return;
            }
            const actions = {};
            for (const call of calls) {
                if (call.name === 'onDelete' || call.name === 'onUpdate') {
                    const action = call.args[0] && constant(call.args[0]);
                    if (action && typeof action.value === 'string') {
                        actions[call.name] = action.value.toLowerCase();
                    }
                }
            }
            model.foreignKeys.push({ keys, foreign, actions, module: itemRef.module, start: itemRef.node.start });
            return;
        }
        // index(), uniqueIndex(), unique(): without .on(), drizzle-kit creates nothing
        if (!onCall) {
            return;
        }
        const items = indexColumns();
        if (!items || items.length === 0) {
            warnings.push(`${location}: ${model.table}: the columns of the index cannot be read, index skipped.`);
            return;
        }
        const type = fn === 'index' ? 'index' : 'unique';
        // A partial unique index (.where()) makes no column unique, as in the SQL drizzle-kit writes
        const partial = calls.some(call => call.name === 'where');
        if (type === 'unique' && !partial && items.every(item => item.key)) {
            model.uniques.push(items.map(item => item.key));
        }
        model.indexes.push({ items, type, name: nameOf(0), partial });
    };

    // -----------------------------------------------------------------------------------------
    // The tables drizzle-kit creates: the tables exported by the schema files

    const created = [];
    const seenDecls = new Set();
    const exported = new Set();
    for (const module of schemaModules) {
        for (const value of program.exportedValues(module)) {
            if (value.kind !== 'node') {
                continue;
            }
            const key = value.decl || value.node;
            exported.add(key);
            if (seenDecls.has(key)) {
                continue;
            }
            const call = tableCall(value);
            if (call && call.view) {
                seenDecls.add(key);
                const viewModule = value.module;
                warnings.push(`${at(viewModule, value.decl ? value.decl.nameStart : value.node.start)}: view ${value.decl ? value.decl.name : 'default'} skipped: views are not drawn.`);
                continue;
            }
            if (call) {
                seenDecls.add(key);
                const model = modelOf(value);
                if (model && model.valid && model.otherDatabase) {
                    warnings.push(`${at(model.module, model.decl.nameStart)}: table ${model.table} skipped: drizzle-kit does not create the tables of another database (${model.dialect === 'mysql' ? 'mysqlSchema' : 'singlestoreSchema'}()).`);
                } else if (model && model.valid) {
                    created.push(model);
                }
            }
        }
    }
    // Tables declared in the schema files without being exported: drizzle-kit does not see them
    for (const module of program.modules.values()) {
        if (!module || !location.files.includes(module.file)) {
            continue;
        }
        for (const decl of module.scan.order) {
            if (decl.kind === 'variable' && decl.init && !exported.has(decl) && tableCall({ module, node: decl.init, env: null })) {
                const call = tableCall({ module, node: decl.init, env: null });
                if (!call.view) {
                    warnings.push(`${at(module, decl.nameStart)}: table ${decl.name} is not exported: drizzle-kit does not create it, skipped.`);
                }
            }
        }
    }
    created.sort((a, b) => (a.module.rel < b.module.rel ? -1 : a.module.rel > b.module.rel ? 1 : a.decl.start - b.decl.start));

    // Git status (and unsaved changes) of lines of the schema files and of the files they import
    const reached = reachableFiles(location.files, overrides, resolver, aliases);
    const loaded = [...program.modules.values()].filter(Boolean).map(module => module.file);
    const reader = createStatusReader(sourcesOf(basePath, location, [...new Set([...reached, ...loaded])]), { git: options.git !== false, overrides, cache: options.gitCache });
    if (reader.warning) {
        warnings.push(reader.warning);
    }
    const linesOf = (module, start, end) => [module.lineAt(start), module.lineAt(Math.max(end - 1, start))];
    // A table added to a file that is in HEAD: every line of its declaration that holds code (not
    // only closing brackets, which may match older lines) is new. The tokens of the declaration
    // are found by a binary search: a schema of many tables in one file (drizzle-kit pull) stays fast.
    const isNewDeclaration = (model) => {
        const added = reader.addedOf(model.module.file);
        const { tokens } = model.module.scan.ctx;
        let low = 0;
        let high = tokens.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (tokens[mid].start < model.decl.start) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        const lines = new Set();
        for (let i = low; i < tokens.length && tokens[i].start < model.decl.end; i++) {
            const token = tokens[i];
            if (token.end <= model.decl.end && !(token.type === 'punct' && [')', ']', '}', ',', ';'].includes(token.value))) {
                lines.add(model.module.lineAt(token.start));
            }
        }
        return lines.size > 0 && [...lines].every(line => added(line));
    };
    // The status of code that makes a table or a column outside of its lines (a helper, the prefix
    // of a table creator): its lines as they are
    const sourceStatus = (source) => reader.statusOf(source.module.file)(...linesOf(source.module, source.start, source.end));

    const tables = [];
    const seenNames = new Map();
    for (const model of created) {
        const first = model.module.lineAt(model.decl.start);
        const [, last] = linesOf(model.module, model.decl.start, model.decl.end);
        const newDeclaration = isNewDeclaration(model);
        const statusIn = (module, start, end) => {
            const [a, b] = linesOf(module, start, end);
            const status = reader.statusOf(module.file)(a, b);
            return status === 'modified' && newDeclaration && module === model.module && start >= model.decl.start && end <= model.decl.end ? 'untracked' : status;
        };
        if (seenNames.has(model.table)) {
            warnings.push(`Table "${model.table}" is declared twice (${seenNames.get(model.table)} and ${model.module.rel}).`);
        } else {
            seenNames.set(model.table, model.module.rel);
        }
        const columnOf = (key) => model.columns.find(column => column.key === key);
        const nameOf = (key) => (columnOf(key) ? columnOf(key).name : applyCasing(model.casing, key));
        // Composite primary keys: their columns are never null (pg, MySQL)
        const primaryKeys = model.primaryKeys.map(pk => pk.keys);
        for (const keys of primaryKeys) {
            for (const key of keys) {
                const column = columnOf(key);
                if (column) {
                    column.primary = true;
                    if (model.dialect !== 'sqlite') {
                        column.notNull = true;
                    }
                }
            }
        }
        const singleUnique = (key) => {
            const column = columnOf(key);
            return Boolean(column && column.unique) || model.uniques.some(set => set.length === 1 && set[0] === key);
        };
        const ownPrimary = model.columns.filter(column => column.primary).map(column => column.key);
        const isUnique = (keys) => (keys.length === 1 && (singleUnique(keys[0]) || (ownPrimary.length === 1 && ownPrimary[0] === keys[0])))
            || model.uniques.some(set => sameSet(set, keys))
            || (ownPrimary.length > 0 && sameSet(ownPrimary, keys));

        const table = { table: model.table, columns: [], relations: [] };
        for (const column of model.columns) {
            const out = { name: column.name, type: column.type };
            if (column.primary) {
                out.primary = true;
            }
            if (!column.notNull) {
                out.nullable = true;
            }
            // Its lines, and the code of the helpers that make it (a changed helper changes it)
            const status = changedStatus(statusIn(column.module, column.start, column.end), column.sources.map(sourceStatus));
            if (status) {
                out.git = status;
            }
            if (options.columnSources) {
                out.source = { file: column.module.rel, line: column.module.lineAt(column.start) };
            }
            if (options.details) {
                const details = { ...column.details };
                if (singleUnique(column.key)) {
                    details.unique = true;
                }
                DETAIL_KEYS.filter(key => key in details).forEach(key => {
                    out[key] = details[key];
                });
            }
            table.columns.push(out);
        }
        // Relations: the references() of the columns, then the foreign keys of the extra config
        const actionsOf = (config) => {
            const pick = (value) => (typeof value === 'string' && ACTIONS.has(value.toLowerCase()) ? value.toLowerCase() : 'no action');
            return { onDelete: pick(config.onDelete), onUpdate: pick(config.onUpdate) };
        };
        for (const column of model.columns) {
            for (const reference of column.references) {
                const target = reference.fn && foreignColumn(reference.fn);
                if (!target) {
                    warnings.push(`${at(reference.module, reference.start)}: ${model.table}.${column.key}: the referenced column cannot be read, relation skipped.`);
                    continue;
                }
                const targetColumn = target.model.columns.find(c => c.key === target.key);
                table.relations.push({
                    foreignKey: column.name,
                    references: targetColumn ? targetColumn.name : applyCasing(target.model.casing, target.key),
                    on: target.model.table,
                    type: isUnique([column.key]) ? 'one-to-one' : 'many-to-one',
                    ...(options.details ? actionsOf(reference.config) : {}),
                });
            }
        }
        for (const fk of model.foreignKeys) {
            const targets = fk.foreign.map(ref => foreignColumn(ref, 1));
            if (targets.some(target => !target) || targets.some(target => target.model !== targets[0].model)) {
                warnings.push(`${at(fk.module, fk.start)}: ${model.table}: the referenced columns of the foreign key cannot be read, relation skipped.`);
                continue;
            }
            const unique = isUnique(fk.keys);
            fk.keys.forEach((key, i) => {
                const target = targets[i];
                const targetColumn = target.model.columns.find(c => c.key === target.key);
                table.relations.push({
                    foreignKey: nameOf(key),
                    references: targetColumn ? targetColumn.name : applyCasing(target.model.casing, target.key),
                    on: target.model.table,
                    type: unique ? 'one-to-one' : 'many-to-one',
                    ...(options.details ? actionsOf(fk.actions) : {}),
                });
            });
        }

        table.source = { file: model.module.rel, line: model.module.lineAt(model.decl.nameStart) };
        const declarationStatus = reader.statusOf(model.module.file)(first, last);
        // A changed name (the prefix of its table creator changed in another file), or a changed
        // helper of its extra config (a key, an index), changes the table
        const sourceKeys = new Set();
        const outside = [...model.nameSources, ...model.extraSources].filter(source => {
            const key = `${source.module.file}\0${source.start}\0${source.end}`;
            return !sourceKeys.has(key) && sourceKeys.add(key);
        });
        const git = tableStatus(declarationStatus === 'modified' && newDeclaration ? 'untracked' : declarationStatus, [...table.columns.map(c => c.git), ...outside.map(sourceStatus)]);
        if (git) {
            table.git = git;
        }
        if (options.details) {
            const indexes = model.indexes
                .filter(index => !(index.type === 'unique' && !index.partial && index.items.length === 1 && index.items[0].key))
                .map(index => ({ columns: index.items.map(item => (item.key ? nameOf(item.key) : item.expression)), type: index.type, ...(index.name ? { name: index.name } : {}) }));
            if (indexes.length > 0) {
                table.indexes = indexes;
            }
        }
        tables.push(table);
    }
    return { tables, warnings };
};

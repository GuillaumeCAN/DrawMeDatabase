//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Reads the Prisma schema of a project (Prisma ORM 5 to 7: schema.prisma, prisma/schema.prisma, a
// multi-file schema folder, or the schema set in prisma.config.ts or package.json) and returns the
// tables its models create, as `prisma migrate` does. The schema is read as text: prisma.config.ts
// is never run.

const fs = require('fs');
const path = require('path');
const { ParserError } = require('./errors');
const { createStatusReader, tableStatus } = require('./git');

// Scalar types of Prisma (Unsupported("...") is read apart)
const SCALARS = new Set(['String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes']);
const ACTIONS = new Map([
    ['Cascade', 'cascade'],
    ['Restrict', 'restrict'],
    ['NoAction', 'no action'],
    ['SetNull', 'set null'],
    ['SetDefault', 'set default'],
]);
// Packages of a project that uses Prisma ORM
const PACKAGES = ['prisma', '@prisma/client'];
// Config files, in the order of the Prisma CLI (c12 in Prisma 6, @prisma/config in Prisma 7)
const CONFIG_EXTENSIONS = ['.js', '.ts', '.mjs', '.cjs', '.mts', '.cts'];
const CONFIG_FILES = [
    ...CONFIG_EXTENSIONS.map(extension => `prisma.config${extension}`),
    ...CONFIG_EXTENSIONS.map(extension => `.config/prisma${extension}`),
];
// The default locations of the Prisma CLI, then the folder the multi-file schemas use (Prisma
// 6.7+), which projects give to the CLI with --schema
const DEFAULT_FILES = ['schema.prisma', 'prisma/schema.prisma'];
const DEFAULT_FOLDER = 'prisma/schema';
// The schema of the tables written without their schema name, per provider (@@schema)
const DEFAULT_SCHEMAS = new Map([['postgresql', 'public'], ['postgres', 'public'], ['cockroachdb', 'public'], ['sqlserver', 'dbo']]);
// Native types (@db.X) whose argument is a length, or a precision and a scale; unsigned MySQL integers
const LENGTH_TYPES = new Set(['VarChar', 'Char', 'NVarChar', 'NChar', 'String', 'Bit', 'VarBit', 'Binary', 'VarBinary']);
const DECIMAL_TYPES = new Set(['Decimal', 'Numeric']);
const UNSIGNED_TYPES = /^Unsigned(?:TinyInt|SmallInt|MediumInt|Int|BigInt)$/;
// Block attributes of the indexes, and their type (docs/pivot-format.md)
const INDEX_TYPES = new Map([['index', 'index'], ['unique', 'unique'], ['fulltext', 'fulltext']]);
// Details of a column (option `details`), in the order of docs/pivot-format.md
const DETAIL_KEYS = ['length', 'precision', 'scale', 'unsigned', 'default', 'defaultRaw', 'values', 'unique', 'autoIncrement', 'nativeType'];
// Nesting of the values of attributes, at most ([a, b(sort: Desc)] is 2)
const MAX_DEPTH = 32;
// Block headers: `model User {`, at the start of a line
const BLOCK_HEADER = /^[ \t]*(model|view|enum|type|datasource|generator)[ \t]+([A-Za-z_]\w*)[ \t]*\{/gm;

const toPosix = (filePath) => filePath.split(path.sep).join('/');
const blank = (text) => text.replace(/[^\r\n]/g, ' ');
const sameSet = (a, b) => a.length === b.length && a.every(item => b.includes(item));

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

// ---------------------------------------------------------------------------------------------
// Where the schema is

// The Prisma config file of a project (prisma.config.ts...), or null
function findConfigFile(basePath) {
    for (const name of CONFIG_FILES) {
        const file = path.resolve(basePath, name);
        if (isFile(file)) {
            return file;
        }
    }
    return null;
}

// The TypeScript or JavaScript text without its comments (strings and template literals kept)
function stripScriptComments(text) {
    let out = '';
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"' || c === '\'' || c === '`') {
            let j = i + 1;
            while (j < text.length && text[j] !== c) {
                j += text[j] === '\\' ? 2 : 1;
            }
            out += text.slice(i, j + 1);
            i = j + 1;
        } else if (c === '/' && text[i + 1] === '/') {
            const end = text.indexOf('\n', i);
            i = end === -1 ? text.length : end;
        } else if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            out += ' ';
            i = end === -1 ? text.length : end + 2;
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

// The value of a path expression of a config file, without running it: a string literal, or
// path.join() / path.resolve() / join() / resolve() of string literals, __dirname and
// import.meta.dirname (the folder of the config file). null for anything else.
function scriptPath(expression, configDir) {
    const text = expression.trim();
    const literal = /^(['"`])((?:\\.|(?!\1)[^\\])*)\1$/s.exec(text);
    if (literal) {
        return literal[1] === '`' && literal[2].includes('${') ? null : literal[2].replace(/\\(.)/g, '$1');
    }
    if (text === '__dirname' || text === 'import.meta.dirname') {
        return configDir;
    }
    const call = /^(?:(?:path|node_path|nodePath)\s*\.\s*)?(join|resolve)\s*\(([\s\S]*)\)$/.exec(text);
    if (!call) {
        return null;
    }
    const parts = [];
    let depth = 0;
    let start = 0;
    let quote = null;
    const args = call[2];
    for (let i = 0; i <= args.length; i++) {
        const c = args[i];
        if (quote) {
            if (c === '\\') {
                i++;
            } else if (c === quote) {
                quote = null;
            }
        } else if (c === '"' || c === '\'' || c === '`') {
            quote = c;
        } else if (c === '(' || c === '[') {
            depth++;
        } else if (c === ')' || c === ']') {
            depth--;
        } else if ((c === ',' && depth === 0) || i === args.length) {
            if (args.slice(start, i).trim() !== '') {
                parts.push(args.slice(start, i));
            }
            start = i + 1;
        }
    }
    const values = parts.map(part => scriptPath(part, configDir));
    if (values.length === 0 || values.includes(null)) {
        return null;
    }
    return call[1] === 'resolve' ? path.resolve(configDir, ...values) : path.join(...values);
}

// A key of an object literal (`schema:`, `'schema':`, `"schema":`, or the shorthand `schema,`), at
// the start of a property
const keyPattern = (key) => new RegExp(`(?:${key}|'${key}'|"${key}")\\s*(:|,|\\})`, 'y');

// The end of the expression of code from `from`: the next `,` or closing bracket outside of
// brackets and strings
function expressionEnd(code, from) {
    let depth = 0;
    let quote = null;
    let end = from;
    for (; end < code.length; end++) {
        const c = code[end];
        if (quote) {
            if (c === '\\') {
                end++;
            } else if (c === quote) {
                quote = null;
            }
        } else if (c === '"' || c === '\'' || c === '`') {
            quote = c;
        } else if (c === '(' || c === '[' || c === '{') {
            depth++;
        } else if (c === ')' || c === ']' || c === '}') {
            if (depth === 0) {
                break;
            }
            depth--;
        } else if (c === ',' && depth === 0) {
            break;
        }
    }
    return end;
}

// The offset of the `{` of the config object: the object given to defineConfig() or exported by
// default (`export default {`, `module.exports = {`), or the object of the variable they name
// (`export default config`); -1 when the config is built by code (a function call)
function configObject(code) {
    const literal = /\bdefineConfig\s*\(\s*\{|\bexport\s+default\s*\{|\bmodule\.exports\s*=\s*\{/.exec(code);
    if (literal) {
        return literal.index + literal[0].length - 1;
    }
    const named = /\b(?:defineConfig\s*\(|export\s+default\b|module\.exports\s*=)\s*([A-Za-z_$][\w$]*)(?![\w$]|\s*\()/g;
    let match;
    while ((match = named.exec(code))) {
        const name = match[1].replace(/\$/g, '\\$');
        const declaration = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*(?::[^=]*)?=\\s*(?:defineConfig\\s*\\(\\s*)?\\{`).exec(code);
        if (declaration) {
            return declaration.index + declaration[0].length - 1;
        }
    }
    return -1;
}

// The property `key` of the object literal at code[open] = '{', not the ones of the objects and
// functions nested in it (the options of a driver adapter): { value, at } with the expression as
// written and its offset (value null for a shorthand property without its `const key = ...`), or
// null when the object has no such property
function objectProperty(code, open, key) {
    const KEY = keyPattern(key);
    let depth = 0;
    let quote = null;
    // At the start of a property: after the `{` or a `,` of the object
    let start = true;
    for (let i = open + 1; i < code.length; i++) {
        const c = code[i];
        if (quote) {
            if (c === '\\') {
                i++;
            } else if (c === quote) {
                quote = null;
            }
            continue;
        }
        if (depth === 0 && start && !/\s/.test(c)) {
            start = false;
            KEY.lastIndex = i;
            const found = KEY.exec(code);
            if (found && found[1] === ':') {
                const from = i + found[0].length;
                return { value: code.slice(from, expressionEnd(code, from)), at: from };
            }
            if (found) {
                // Shorthand property: the value of `const key = ...` in the same file
                const declaration = new RegExp(`\\b(?:const|let|var)\\s+${key}\\s*=\\s*([^;\\n]+)`).exec(code);
                return { value: declaration ? declaration[1] : null, at: declaration ? declaration.index + declaration[0].length - declaration[1].length : -1 };
            }
        }
        if (c === '"' || c === '\'' || c === '`') {
            quote = c;
        } else if (c === '(' || c === '[' || c === '{') {
            depth++;
        } else if (c === ')' || c === ']' || c === '}') {
            if (depth === 0) {
                return null;
            }
            depth--;
        } else if (c === ',' && depth === 0) {
            start = true;
        }
    }
    return null;
}

// The schema of a Prisma config file: { path } (absolute, relative paths resolved from the folder of
// the config file, as Prisma does), { computed: true } when it cannot be read without running the
// file, or null when the file sets no schema. Only the `schema` of the config object counts.
function configSchema(configFile, text) {
    const code = stripScriptComments(text);
    const configDir = path.dirname(configFile);
    const open = configObject(code);
    if (open === -1) {
        // A config built by code: a schema key somewhere cannot be read without running it
        return /(?:^|[{,\s])(?:schema|'schema'|"schema")\s*[:,}]/.test(code) ? { computed: true } : null;
    }
    const property = objectProperty(code, open, 'schema');
    if (!property) {
        return null;
    }
    const resolved = property.value === null ? null : scriptPath(property.value, configDir);
    return resolved === null ? { computed: true } : { path: path.resolve(configDir, resolved) };
}

// The folder of the migrations set in a Prisma config file (`migrations: { path: 'db/migrations' }`,
// relative to the folder of the config file, as Prisma reads it): an absolute path, or null when it
// sets none or cannot be read without running it
function configMigrations(configFile, text) {
    const code = stripScriptComments(text);
    const configDir = path.dirname(configFile);
    const open = configObject(code);
    const migrations = open === -1 ? null : objectProperty(code, open, 'migrations');
    if (!migrations || migrations.value === null) {
        return null;
    }
    const brace = migrations.at + (migrations.value.length - migrations.value.trimStart().length);
    const folder = code[brace] === '{' ? objectProperty(code, brace, 'path') : null;
    const resolved = folder && folder.value !== null ? scriptPath(folder.value, configDir) : null;
    return resolved === null ? null : path.resolve(configDir, resolved);
}

// The major version of a range of package.json ('^7.10.1', '~6.19', '>=7', 'workspace:^7.0.0'),
// undefined when it does not tell one ('latest', 'catalog:')
function majorVersion(range) {
    const match = typeof range === 'string' ? /^\s*(?:workspace:|npm:[^@\s]+@)?[\^~>=v\s]*(\d+)/.exec(range) : null;
    return match ? Number(match[1]) : undefined;
}

// package.json: { packages: names of the dependencies and devDependencies, major: the major
// version of prisma (else @prisma/client) when its range tells it, schema: its "prisma.schema"
// (absolute), error: why it could not be read }
function readPackage(basePath, overrides) {
    const file = path.resolve(basePath, 'package.json');
    const text = readText(file, overrides);
    if (text === null) {
        return { packages: [], major: undefined, schema: undefined, error: null };
    }
    let pkg;
    try {
        pkg = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (err) {
        return { packages: [], major: undefined, schema: undefined, error: err.message };
    }
    const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
    const versions = { ...object(pkg && pkg.devDependencies), ...object(pkg && pkg.dependencies) };
    const packages = [...Object.keys(object(pkg && pkg.dependencies)), ...Object.keys(object(pkg && pkg.devDependencies))];
    const major = PACKAGES.map(name => majorVersion(versions[name])).find(value => value !== undefined);
    const schema = object(pkg && pkg.prisma).schema;
    return { packages, major, schema: typeof schema === 'string' && schema.trim() ? path.resolve(basePath, schema.trim()) : undefined, error: null };
}

// Where the schema of basePath is, in the order of the Prisma CLI: the schema of the config file,
// else "prisma.schema" of package.json (Prisma 5 and 6), else schema.prisma, prisma/schema.prisma,
// then the prisma/schema folder. Prisma 7 no longer reads package.json: its "prisma.schema" is then
// read only when there is no schema at a default location, with a warning. { path, folder, exists,
// origin, configFile, warnings }: origin is the file that set the path (the config file or
// package.json), or null for a default location.
function locateSchema(basePath, overrides = null) {
    const warnings = [];
    const configFile = findConfigFile(basePath);
    const configName = configFile ? toPosix(path.relative(basePath, configFile)) : null;
    const located = (filePath, origin) => {
        const info = stat(filePath);
        return { path: filePath, folder: Boolean(info && info.isDirectory()), exists: Boolean(info), origin, configFile, warnings };
    };

    if (configFile) {
        const text = readText(configFile, overrides);
        const schema = text === null ? null : configSchema(configFile, text);
        if (schema && schema.path) {
            return located(schema.path, configName);
        }
        if (schema && schema.computed) {
            warnings.push(`${configName}: the schema path is computed, it cannot be read without running the file: the default locations are read.`);
        }
    }
    const pkg = readPackage(basePath, overrides);
    if (pkg.error) {
        warnings.push(`package.json could not be read: ${pkg.error}`);
    }
    const prisma7 = pkg.major >= 7;
    if (pkg.schema && !prisma7) {
        return located(pkg.schema, 'package.json');
    }
    const defaultLocation = () => {
        for (const name of DEFAULT_FILES) {
            const filePath = path.resolve(basePath, name);
            if (isFile(filePath)) {
                return filePath;
            }
        }
        const folder = path.resolve(basePath, DEFAULT_FOLDER);
        return isDirectory(folder) ? folder : null;
    };
    const found = defaultLocation();
    if (pkg.schema) {
        warnings.push(found
            ? `package.json: Prisma ${pkg.major} ignores "prisma.schema" (the schema is set in prisma.config.ts): ${toPosix(path.relative(basePath, found))} is read, as the Prisma CLI does.`
            : `package.json: Prisma ${pkg.major} ignores "prisma.schema" (the schema is set in prisma.config.ts), there is no schema at the default locations: the one of package.json is read.`);
    }
    if (found) {
        return located(found, null);
    }
    if (pkg.schema) {
        return located(pkg.schema, 'package.json');
    }
    return { path: null, folder: false, exists: false, origin: null, configFile, warnings };
}

// The .prisma files of a folder and of its sub-folders, sorted by path (links followed, as the
// Prisma CLI does, each folder once)
function listSchemaFiles(dir) {
    const files = [];
    const seen = new Set();
    const walk = (folder) => {
        let real;
        try {
            real = fs.realpathSync(folder);
        } catch {
            return;
        }
        if (seen.has(real)) {
            return;
        }
        seen.add(real);
        let entries;
        try {
            entries = fs.readdirSync(folder);
        } catch {
            return;
        }
        for (const name of entries) {
            const entry = path.join(folder, name);
            const info = stat(entry);
            if (info && info.isDirectory()) {
                walk(entry);
            } else if (info && info.isFile() && name.endsWith('.prisma')) {
                files.push(entry);
            }
        }
    };
    walk(dir);
    return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// The sources of a located schema (docs/parsers.md): the schema file or folder (each default
// location while there is none, so that creating it refreshes the diagram), package.json and the
// config file, which can move the schema
function sourcesOf(basePath, location) {
    const folders = [];
    const files = [];
    if (location.path && location.folder) {
        folders.push({ path: location.path, recursive: true });
    } else if (location.path) {
        files.push(location.path);
    } else {
        files.push(...DEFAULT_FILES.map(name => path.resolve(basePath, name)));
        folders.push({ path: path.resolve(basePath, DEFAULT_FOLDER), recursive: true });
    }
    files.push(path.resolve(basePath, 'package.json'), location.configFile || path.resolve(basePath, 'prisma.config.ts'));
    return { folders, files, extensions: ['.prisma'] };
}

// ---------------------------------------------------------------------------------------------
// Prisma Schema Language

// The text with its comments (`//`, `///` and `/* */`) blanked (`code`), and a copy where the
// content of the strings is blanked too (`mask`), so that attributes and braces are found by plain
// scanning. Offsets and line breaks are kept.
function maskSchema(text) {
    const code = [];
    const mask = [];
    let last = 0;
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"' && text[j] !== '\n') {
                j += text[j] === '\\' && text[j + 1] !== '\n' ? 2 : 1;
            }
            const end = text[j] === '"' ? j + 1 : j;
            code.push(text.slice(last, end));
            mask.push(text.slice(last, i + 1), blank(text.slice(i + 1, text[j] === '"' ? j : end)), text[j] === '"' ? '"' : '');
            last = i = end;
        } else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
            let end;
            if (text[i + 1] === '/') {
                end = text.indexOf('\n', i);
                end = end === -1 ? text.length : end;
            } else {
                end = text.indexOf('*/', i + 2);
                end = end === -1 ? text.length : end + 2;
            }
            const comment = blank(text.slice(i, end));
            code.push(text.slice(last, i), comment);
            mask.push(text.slice(last, i), comment);
            last = i = end;
        } else {
            i++;
        }
    }
    code.push(text.slice(last));
    mask.push(text.slice(last));
    return { code: code.join(''), mask: mask.join('') };
}

// Line number (from 1) of an offset of `text`
function createLineLocator(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            starts.push(i + 1);
        }
    }
    return (offset) => {
        let low = 0;
        let high = starts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (starts[mid] <= offset) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return low + 1;
    };
}

// Reads a value of the schema language from text[i]: a string, a number, a constant (`Cascade`,
// `true`), a list or a function call (`now()`, `dbgenerated("...")`). Returns { value, end }, or
// null when the text is not a value. Values: { kind: 'string', value }, { kind: 'number', text },
// { kind: 'constant', name }, { kind: 'list', items }, { kind: 'call', name, args }. Values nested
// deeper than MAX_DEPTH are not read (no schema nests them, and the stack stays small).
function readValue(text, i, depth = 0) {
    if (depth > MAX_DEPTH) {
        return null;
    }
    while (i < text.length && /[ \t]/.test(text[i])) {
        i++;
    }
    const c = text[i];
    if (c === '"') {
        let j = i + 1;
        while (j < text.length && text[j] !== '"') {
            if (text[j] === '\n') {
                return null;
            }
            j += text[j] === '\\' ? 2 : 1;
        }
        if (j >= text.length) {
            return null;
        }
        const raw = text.slice(i + 1, j);
        let value;
        try {
            value = JSON.parse(`"${raw}"`);
        } catch {
            value = raw.replace(/\\(.)/g, '$1');
        }
        return { value: { kind: 'string', value }, end: j + 1 };
    }
    if (c === '[') {
        const items = [];
        let j = i + 1;
        for (;;) {
            while (j < text.length && /[ \t]/.test(text[j])) {
                j++;
            }
            if (text[j] === ']') {
                return { value: { kind: 'list', items }, end: j + 1 };
            }
            const item = readValue(text, j, depth + 1);
            if (!item) {
                return null;
            }
            items.push(item.value);
            j = item.end;
            while (j < text.length && /[ \t]/.test(text[j])) {
                j++;
            }
            if (text[j] === ',') {
                j++;
            } else if (text[j] !== ']') {
                return null;
            }
        }
    }
    const number = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (number) {
        return { value: { kind: 'number', text: number[0] }, end: i + number[0].length };
    }
    const name = /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*/.exec(text.slice(i));
    if (!name) {
        return null;
    }
    let j = i + name[0].length;
    let k = j;
    while (k < text.length && /[ \t]/.test(text[k])) {
        k++;
    }
    if (text[k] === '(') {
        const args = readArguments(text, k, depth + 1);
        return args ? { value: { kind: 'call', name: name[0], args: args.args }, end: args.end } : null;
    }
    return { value: { kind: 'constant', name: name[0] }, end: j };
}

// Reads the arguments of text[i] = '(': { args: [{ name, value }], end } (name: null when the
// argument is not named), or null when they cannot be read
function readArguments(text, i, depth = 0) {
    const args = [];
    let j = i + 1;
    for (;;) {
        while (j < text.length && /[ \t]/.test(text[j])) {
            j++;
        }
        if (text[j] === ')') {
            return { args, end: j + 1 };
        }
        const named = /^([A-Za-z_]\w*)[ \t]*:/.exec(text.slice(j));
        if (named) {
            j += named[0].length;
        }
        const item = readValue(text, j, depth);
        if (!item) {
            return null;
        }
        args.push({ name: named ? named[1] : null, value: item.value });
        j = item.end;
        while (j < text.length && /[ \t]/.test(text[j])) {
            j++;
        }
        if (text[j] === ',') {
            j++;
        } else if (text[j] !== ')') {
            return null;
        }
    }
}

// The attributes of text from `i` (`@id @default(now())`, or `@@index([a, b])` with prefix '@@'):
// [{ name, args }], or null when the rest of the text is not a list of attributes
function readAttributes(text, i, prefix = '@') {
    const attributes = [];
    for (;;) {
        while (i < text.length && /\s/.test(text[i])) {
            i++;
        }
        if (i >= text.length) {
            return attributes;
        }
        if (!text.startsWith(prefix, i) || (prefix === '@' && text[i + 1] === '@')) {
            return null;
        }
        const name = /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*/.exec(text.slice(i + prefix.length));
        if (!name) {
            return null;
        }
        i += prefix.length + name[0].length;
        let k = i;
        while (k < text.length && /[ \t]/.test(text[k])) {
            k++;
        }
        let args = [];
        if (text[k] === '(') {
            const read = readArguments(text, k);
            if (!read) {
                return null;
            }
            args = read.args;
            i = read.end;
        }
        attributes.push({ name: name[0], args });
    }
}

// An argument of an attribute: the named one, else the unnamed one at `position`
function argument(attribute, name, position = 0) {
    if (!attribute) {
        return undefined;
    }
    const named = attribute.args.find(arg => arg.name === name);
    if (named) {
        return named.value;
    }
    const unnamed = attribute.args.filter(arg => arg.name === null);
    return position === null ? undefined : unnamed[position] && unnamed[position].value;
}

const stringOf = (value) => (value && value.kind === 'string' ? value.value : undefined);
// The names of a list of fields ([a, b(sort: Desc)]), or of a field written alone (@@index(a))
const fieldName = (value) => (value && (value.kind === 'constant' || value.kind === 'call') ? value.name : null);
const fieldList = (value) => (value && value.kind === 'list' ? value.items.map(fieldName) : [fieldName(value)]).filter(Boolean);
// The text of a value, as written (arguments of a native type: `255`, `Max`)
const valueText = (value) => (value.kind === 'number' ? value.text : value.kind === 'constant' ? value.name : value.kind === 'string' ? JSON.stringify(value.value) : '');

// The blocks of a schema file: [{ kind, name, file, rel, first, last, lines }]. lines: the lines of
// the body with their number, as written (`code`, comments blanked) and masked (`mask`).
function readBlocks(file, rel, text, warnings) {
    const { code, mask } = maskSchema(text.replace(/^\uFEFF/, ''));
    const lineAt = createLineLocator(code);
    const headers = [...mask.matchAll(BLOCK_HEADER)];
    const blocks = [];
    headers.forEach((header, index) => {
        const open = header.index + header[0].length - 1;
        const next = index + 1 < headers.length ? headers[index + 1].index : mask.length;
        let close = mask.indexOf('}', open + 1);
        // The line of the closing brace, else the line before the next block
        let last;
        if (close === -1 || close > next) {
            warnings.push(`${rel}:${lineAt(header.index)}: ${header[1]} ${header[2]} is not closed.`);
            close = next;
            last = lineAt(Math.max(close - 1, open));
        } else {
            last = lineAt(close);
        }
        const lines = [];
        let offset = open + 1;
        for (const segment of mask.slice(open + 1, close).split('\n')) {
            if (segment.trim() !== '') {
                const start = offset + segment.search(/\S/);
                // The end of the code: a string not closed yet (being typed) is blank in the mask
                const end = offset + code.slice(offset, offset + segment.length).trimEnd().length;
                lines.push({ code: code.slice(start, end), mask: mask.slice(start, end), line: lineAt(start) });
            }
            offset += segment.length + 1;
        }
        blocks.push({ kind: header[1], name: header[2], file, rel, first: lineAt(header.index), last, lines });
    });
    return blocks;
}

// The datasource block of the blocks of a schema (several datasource blocks are an error for
// Prisma: the first one) and its provider: { datasource, provider }
function datasourceOf(blocks) {
    const datasource = blocks.find(block => block.kind === 'datasource');
    const settings = new Map();
    for (const line of datasource ? datasource.lines : []) {
        const setting = /^([A-Za-z_]\w*)[ \t]*=/.exec(line.mask);
        const value = setting && readValue(line.code, setting[0].length);
        if (value) {
            settings.set(setting[1], value.value);
        }
    }
    return { datasource, provider: stringOf(settings.get('provider')) };
}

// A field of a model: { name, type, list, optional, native (Unsupported), attributes, line }, or
// null when the line is not a field
function readField(line) {
    const head = /^([A-Za-z_]\w*)[ \t]+([A-Za-z_]\w*)/.exec(line.mask);
    if (!head) {
        return null;
    }
    let i = head[0].length;
    let native;
    if (head[2] === 'Unsupported') {
        // Unsupported("type"): a line being typed (`Unsupported`, `Unsupported("geo`) is not a field
        const open = /^[ \t]*\(/.exec(line.mask.slice(i));
        const args = open ? readArguments(line.code, i + open[0].length - 1) : null;
        native = args ? stringOf(argument({ args: args.args }, null)) : undefined;
        if (native === undefined) {
            return null;
        }
        i = args.end;
    }
    const modifiers = /^(\[\])?(\?)?/.exec(line.mask.slice(i));
    i += modifiers[0].length;
    // The attributes may follow the type without a space (`Int@id`), as the Prisma CLI accepts
    if (i < line.mask.length && !/[\s@]/.test(line.mask[i])) {
        return null;
    }
    const attributes = readAttributes(line.code, i);
    if (!attributes) {
        return null;
    }
    return { name: head[1], type: head[2], list: Boolean(modifiers[1]), optional: Boolean(modifiers[2]), native, attributes, line: line.line };
}

// ---------------------------------------------------------------------------------------------
// Parser contract (docs/parsers.md)

module.exports.id = 'prisma';
module.exports.label = 'Prisma';

// 100 for a schema with prisma or @prisma/client in package.json (or a Prisma config file), 50 for
// the schema alone, or for a config file or a "prisma.schema" of package.json whose schema is
// missing (parse() tells where it was looked for). The package alone is not a Prisma project: the
// root of a monorepo whose schema is in a package, or an app that uses the client of another
// package; the user is then told to set DrawMeDatabase.frameworkPath. The schema is looked for
// where the Prisma CLI looks.
module.exports.detect = function (basePath) {
    if (typeof basePath !== 'string' || !isDirectory(basePath)) {
        return 0;
    }
    const location = locateSchema(basePath);
    const marked = Boolean(location.configFile) || readPackage(basePath).packages.some(name => PACKAGES.includes(name));
    if (location.exists) {
        return marked ? 100 : 50;
    }
    return marked && (location.configFile || location.origin) ? 50 : 0;
};

// The files read: the schema file, or the .prisma files of the schema folder and its sub-folders,
// plus package.json and the config file. options.overrides (the text of the unsaved editors): an
// unsaved prisma.config.ts or package.json that moves the schema moves the sources too.
function sources(basePath, options = {}) {
    return sourcesOf(basePath, locateSchema(basePath, (options && options.overrides) || null));
}
module.exports.sources = sources;

// The databases of the providers of a datasource
const PROVIDERS = { postgresql: 'postgresql', postgres: 'postgresql', mysql: 'mysql', sqlite: 'sqlite', sqlserver: 'sqlserver', cockroachdb: 'cockroachdb', mongodb: 'mongodb' };

// The database of the schema (docs/api.md): the provider of its datasource, or null
module.exports.dialect = function (basePath, options = {}) {
    const overrides = (options && options.overrides) || null;
    const location = typeof basePath === 'string' ? locateSchema(basePath, overrides) : null;
    if (!location || !location.path || !location.exists) {
        return null;
    }
    const blocks = [];
    for (const file of location.folder ? listSchemaFiles(location.path) : [location.path]) {
        const text = readText(file, overrides);
        if (text !== null) {
            blocks.push(...readBlocks(file, toPosix(path.relative(basePath, file)), text, []));
        }
    }
    const { provider } = datasourceOf(blocks);
    return provider && Object.prototype.hasOwnProperty.call(PROVIDERS, provider) ? PROVIDERS[provider] : null;
};

// The migrations of prisma migrate (docs/api.md, getMigrations()): the SQL of the folder set in the
// config file (migrations.path), else of the migrations folder next to the schema (prisma/migrations
// for prisma/schema.prisma; for a schema folder, its migrations sub-folder, else the one next to
// it), as the SQL reader replays them, in their order (framework: 'sql'); null without migrations
module.exports.migrations = function (basePath, options = {}) {
    if (typeof basePath !== 'string' || !isDirectory(basePath)) {
        return null;
    }
    const overrides = (options && options.overrides) || null;
    const location = locateSchema(basePath, overrides);
    const text = location.configFile ? readText(location.configFile, overrides) : null;
    const configured = text === null ? null : configMigrations(location.configFile, text);
    const folders = configured ? [configured]
        : location.path && location.exists && location.folder ? [path.join(location.path, 'migrations'), path.join(path.dirname(location.path), 'migrations')]
            : location.path && location.exists ? [path.join(path.dirname(location.path), 'migrations')]
                : [path.resolve(basePath, 'prisma', 'migrations')];
    const folder = folders.find(isDirectory);
    return folder ? require('./sql').stackMigrations(basePath, folder, 'prisma', overrides) : null;
};

// ---------------------------------------------------------------------------------------------
// Tables

// Returns { tables, warnings }. Options:
// - git: false skips the git status
// - overrides: Map of absolute file path → text of an unsaved editor, read instead of the file
// - gitCache: Map kept between parses, to run git again only once it is cleared
// - columnSources: true adds the line of each field (source: { file, line })
// - details: true adds the column details (native type, length, default...), the indexes and the
//   referential actions (docs/pivot-format.md)
module.exports.parse = function (basePath, options = {}) {
    const overrides = options.overrides || null;
    const location = locateSchema(basePath, overrides);
    const warnings = [...location.warnings];
    if (!location.path) {
        throw new ParserError(`No Prisma schema found in ${basePath}: DrawMeDatabase reads schema.prisma, prisma/schema.prisma, the prisma/schema folder, or the schema set in prisma.config.ts or in the "prisma" section of package.json.`);
    }
    if (!location.exists) {
        throw new ParserError(`The Prisma schema set in ${location.origin} was not found: ${location.path}`);
    }
    const files = location.folder ? listSchemaFiles(location.path) : [location.path];
    if (files.length === 0) {
        throw new ParserError(`No .prisma files found in ${location.path}`);
    }

    const blocks = [];
    for (const file of files) {
        const text = readText(file, overrides);
        if (text !== null) {
            blocks.push(...readBlocks(file, toPosix(path.relative(basePath, file)), text, warnings));
        }
    }
    const at = (block, line) => `${block.rel}:${line}`;

    // Datasource: the provider (several datasource blocks are an error for Prisma: the first one)
    const { datasource, provider } = datasourceOf(blocks);
    // The native types are prefixed with the name of the datasource (@db.VarChar for `datasource db`)
    const nativePrefix = `${datasource ? datasource.name : 'db'}.`;
    if (provider === 'mongodb') {
        warnings.push(`${at(datasource, datasource.first)}: the mongodb provider stores documents, not tables: the models are not drawn.`);
        return { tables: [], warnings };
    }
    const defaultSchema = DEFAULT_SCHEMAS.get(provider);

    // Enums: their values, as stored in the database (@map)
    const enums = new Map();
    for (const block of blocks.filter(b => b.kind === 'enum')) {
        const values = [];
        for (const line of block.lines) {
            const value = /^([A-Za-z_]\w*)/.exec(line.mask);
            if (value && !line.mask.startsWith('@@')) {
                const attributes = readAttributes(line.code, value[0].length) || [];
                const map = stringOf(argument(attributes.find(a => a.name === 'map'), 'name'));
                values.push({ name: value[1], value: map !== undefined ? map : value[1] });
            }
        }
        enums.set(block.name, values);
    }
    const skippedTypes = new Set();
    for (const block of blocks.filter(b => b.kind === 'view' || b.kind === 'type')) {
        skippedTypes.add(block.name);
        warnings.push(block.kind === 'view'
            ? `${at(block, block.first)}: view ${block.name} skipped: views are not drawn.`
            : `${at(block, block.first)}: composite type ${block.name} skipped: composite types are not tables.`);
    }

    // Models: their fields and block attributes
    const models = new Map();
    for (const block of blocks.filter(b => b.kind === 'model')) {
        if (models.has(block.name)) {
            warnings.push(`${at(block, block.first)}: model ${block.name} is declared twice, skipped.`);
            continue;
        }
        const model = { name: block.name, block, fields: [], attributes: [] };
        for (const line of block.lines) {
            if (line.mask.startsWith('@@')) {
                const attributes = readAttributes(line.code, 0, '@@');
                if (attributes) {
                    model.attributes.push(...attributes.map(attribute => ({ ...attribute, line: line.line })));
                    continue;
                }
            } else {
                const field = readField(line);
                if (field) {
                    model.fields.push(field);
                    continue;
                }
            }
            const shown = line.code.trim();
            warnings.push(`${at(block, line.line)}: line not understood, skipped: ${shown.length > 60 ? `${shown.slice(0, 60)}...` : shown}`);
        }
        const blockAttribute = (name) => model.attributes.find(a => a.name === name);
        const schema = stringOf(argument(blockAttribute('schema'), 'name'));
        const table = stringOf(argument(blockAttribute('map'), 'name')) || model.name;
        model.schema = schema;
        model.table = schema && schema !== defaultSchema ? `${schema}.${table}` : table;
        const id = blockAttribute('id');
        model.idFields = id ? fieldList(argument(id, 'fields')) : model.fields.filter(f => f.attributes.some(a => a.name === 'id')).map(f => f.name);
        models.set(model.name, model);
    }

    const fieldOf = (model, name) => model && model.fields.find(f => f.name === name);
    const hasAttribute = (field, name) => Boolean(field) && field.attributes.some(a => a.name === name);
    const columnName = (model, name) => {
        const field = fieldOf(model, name);
        const map = field && stringOf(argument(field.attributes.find(a => a.name === 'map'), 'name'));
        return map || name;
    };
    const relationOf = (field) => field.attributes.find(a => a.name === 'relation');
    const relationName = (field) => stringOf(argument(relationOf(field), 'name')) || '';
    const relationFields = (field) => fieldList(argument(relationOf(field), 'fields', null));
    // The column of the single id of a model (the join tables of implicit many-to-many reference it)
    const idColumn = (model) => columnName(model, model.idFields[0] || 'id');

    // Git status (and unsaved changes) of lines of the schema files, null when unknown
    const reader = createStatusReader(sourcesOf(basePath, location), { git: options.git !== false, overrides, cache: options.gitCache });
    if (reader.warning) {
        warnings.push(reader.warning);
    }
    const statusOf = (block, first, last) => reader.statusOf(block.file)(first, last);
    // A model added to a file that is in HEAD: its model line and every line of its body are new
    // (the closing brace and the blank lines may match older ones), so its table and its columns
    // are new ('untracked'), not 'modified'
    const isNewBlock = (block) => {
        const added = reader.addedOf(block.file);
        return added(block.first) && block.lines.every(line => added(line.line));
    };

    const tables = [];
    const seenTables = new Map();
    const manyToMany = new Set();
    for (const model of models.values()) {
        const { block } = model;
        const newBlock = isNewBlock(block);
        // The line status of the declaration and of the fields, new when the whole model is
        const blockStatus = (first, last) => {
            const status = statusOf(block, first, last);
            return status === 'modified' && newBlock ? 'untracked' : status;
        };
        if (seenTables.has(model.table)) {
            warnings.push(`Table "${model.table}" is mapped twice (${seenTables.get(model.table)} and ${block.rel}).`);
        } else {
            seenTables.set(model.table, block.rel);
        }
        const table = { table: model.table, columns: [], relations: [] };
        const uniques = model.attributes.filter(a => a.name === 'unique').map(a => fieldList(argument(a, 'fields')));
        const isUnique = (names) => (names.length === 1 && ['unique', 'id'].some(name => hasAttribute(fieldOf(model, names[0]), name)))
            || uniques.some(set => sameSet(set, names))
            || (model.idFields.length > 0 && sameSet(model.idFields, names));

        // A relation field: a foreign key on the side of @relation(fields: ...), a join table for an
        // implicit many-to-many, nothing on the other side of a one-to-many or one-to-one
        const addRelation = (owner, field, targetModel, label) => {
            const fields = relationFields(field);
            if (fields.length > 0) {
                if (!targetModel) {
                    warnings.push(`${at(block, field.line)}: ${label}: model ${field.type} not found.`);
                }
                const references = fieldList(argument(relationOf(field), 'references', null));
                const unique = isUnique(fields);
                const optional = fields.some(name => fieldOf(owner, name)?.optional);
                const declared = (key) => {
                    const value = argument(relationOf(field), key, null);
                    return value && value.kind === 'constant' ? ACTIONS.get(value.name) : undefined;
                };
                // The actions prisma migrate writes when none is declared
                const onDelete = declared('onDelete') || (optional ? 'set null' : provider === 'sqlserver' ? 'no action' : 'restrict');
                const onUpdate = declared('onUpdate') || 'cascade';
                fields.forEach((name, i) => {
                    const referenced = references[i] || (targetModel && targetModel.idFields[i]) || 'id';
                    table.relations.push({
                        foreignKey: columnName(owner, name),
                        references: targetModel ? columnName(targetModel, referenced) : referenced,
                        on: targetModel ? targetModel.table : field.type,
                        type: unique ? 'one-to-one' : 'many-to-one',
                        ...(options.details ? { onDelete, onUpdate } : {}),
                    });
                });
                return;
            }
            if (!targetModel) {
                warnings.push(`${at(block, field.line)}: ${label}: model ${field.type} not found, relation skipped.`);
                return;
            }
            const name = relationName(field);
            const others = targetModel.fields.filter(f => f !== field && f.type === owner.name && relationName(f) === name);
            const other = others.find(f => relationFields(f).length > 0) || others[0];
            if (other && relationFields(other).length > 0) {
                // The other side holds the foreign key
                return;
            }
            if (!other) {
                warnings.push(`${at(block, field.line)}: ${label}: ${targetModel.name} has no field for the other side of the relation, skipped.`);
                return;
            }
            if (!field.list || !other.list) {
                warnings.push(`${at(block, field.line)}: ${label}: neither side of the relation has fields: [...], skipped.`);
                return;
            }
            // Implicit many-to-many: Prisma's join table _AToB (or _Name), A the first model by name,
            // in the schema of A, its columns A and B referencing the ids
            const [a, b] = [owner.name, targetModel.name].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
            const key = name || `${a}To${b}`;
            if (owner.name !== a || manyToMany.has(key)) {
                return;
            }
            manyToMany.add(key);
            const schema = owner.schema && owner.schema !== defaultSchema ? `${owner.schema}.` : '';
            // SQL Server cannot cascade the two keys of a table that joins a model to itself
            const action = provider === 'sqlserver' && a === b ? 'no action' : 'cascade';
            table.relations.push({
                foreignKey: 'A',
                references: idColumn(owner),
                on: models.get(b).table,
                type: 'many-to-many',
                via: `${schema}_${key}`,
                ...(options.details ? { onDelete: action, onUpdate: action } : {}),
            });
        };

        for (const field of model.fields) {
            const label = `${model.name}.${field.name}`;
            const target = models.get(field.type);
            if (target || (relationOf(field) && !SCALARS.has(field.type) && !enums.has(field.type) && !skippedTypes.has(field.type))) {
                addRelation(model, field, target, label);
                continue;
            }
            if (skippedTypes.has(field.type)) {
                continue;
            }
            if (!SCALARS.has(field.type) && !enums.has(field.type) && field.type !== 'Unsupported') {
                warnings.push(`${at(block, field.line)}: ${label}: unknown type ${field.type}, field skipped.`);
                continue;
            }
            const type = field.type === 'Unsupported' ? `Unsupported(${JSON.stringify(field.native)})` : field.type;
            const column = { name: columnName(model, field.name), type: field.list ? `${type}[]` : type };
            if (hasAttribute(field, 'id') || model.idFields.includes(field.name)) {
                column.primary = true;
            }
            // Prisma creates the scalar lists without NOT NULL
            if (field.optional || field.list) {
                column.nullable = true;
            }
            const status = blockStatus(field.line, field.line);
            if (status) {
                column.git = status;
            }
            if (options.columnSources) {
                column.source = { file: block.rel, line: field.line };
            }
            if (options.details) {
                const details = columnDetails(field, enums.get(field.type), provider, nativePrefix);
                if (uniques.some(set => set.length === 1 && set[0] === field.name)) {
                    details.unique = true;
                }
                // SQLite: Prisma writes an Int @id as INTEGER PRIMARY KEY AUTOINCREMENT
                if (provider === 'sqlite' && field.type === 'Int' && !field.list && hasAttribute(field, 'id')) {
                    details.autoIncrement = true;
                }
                DETAIL_KEYS.filter(key => key in details).forEach(key => {
                    column[key] = details[key];
                });
            }
            table.columns.push(column);
        }

        // The table: its block (a field or a relation changed, added or removed) and its columns
        table.source = { file: block.rel, line: block.first };
        const git = tableStatus(blockStatus(block.first, block.last), table.columns.map(c => c.git));
        if (git) {
            table.git = git;
        }
        if (options.details) {
            const indexes = [];
            for (const attribute of model.attributes) {
                const type = INDEX_TYPES.get(attribute.name);
                const names = type ? fieldList(argument(attribute, 'fields')) : [];
                if (names.length === 0 || (type === 'unique' && names.length === 1)) {
                    continue;
                }
                const name = stringOf(argument(attribute, 'map', null));
                indexes.push({ columns: names.map(n => columnName(model, n)), type, ...(name ? { name } : {}) });
            }
            if (indexes.length > 0) {
                table.indexes = indexes;
            }
        }
        tables.push(table);
    }
    return { tables, warnings };
};

// Details of a scalar field (option `details`): native type, length, precision, unsigned, default,
// enum values, unique, auto-increment. Values generated by Prisma Client (uuid(), cuid(), nanoid(),
// ulid(), @updatedAt), and the Json and Bytes defaults on MySQL, which Prisma does not write to the
// database, are left out. nativePrefix: the name of the datasource and a dot ('db.'), which
// prefixes the native types.
function columnDetails(field, enumValues, provider, nativePrefix = 'db.') {
    const details = {};
    const native = field.attributes.find(a => a.name.startsWith(nativePrefix));
    if (native) {
        const name = native.name.slice(nativePrefix.length);
        const args = native.args.map(arg => arg.value);
        const numbers = args.map(value => (value.kind === 'number' && /^\d+$/.test(value.text) ? Number(value.text) : undefined));
        if (LENGTH_TYPES.has(name) && numbers.length === 1 && numbers[0] !== undefined) {
            details.length = numbers[0];
        }
        if (DECIMAL_TYPES.has(name) && numbers[0] !== undefined) {
            details.precision = numbers[0];
            if (numbers[1] !== undefined) {
                details.scale = numbers[1];
            }
        }
        if (UNSIGNED_TYPES.test(name)) {
            details.unsigned = true;
        }
        details.nativeType = args.length > 0 ? `${name}(${args.map(valueText).join(', ')})` : name;
    } else if (field.type === 'Unsupported') {
        details.nativeType = field.native;
    }

    const mapped = (name) => {
        const value = enumValues && enumValues.find(v => v.name === name);
        return value ? value.value : name;
    };
    const clientSide = provider === 'mysql' && (field.type === 'Json' || field.type === 'Bytes');
    const value = clientSide ? undefined : argument(field.attributes.find(a => a.name === 'default'), 'value');
    if (value && value.kind === 'string') {
        details.default = enumValues ? mapped(value.value) : value.value;
    } else if (value && value.kind === 'number') {
        // A number JavaScript cannot hold exactly (BigInt) is written as an SQL expression
        const number = Number(value.text);
        if (/^-?\d+$/.test(value.text) && !Number.isSafeInteger(number)) {
            details.defaultRaw = value.text;
        } else {
            details.default = number;
        }
    } else if (value && value.kind === 'constant') {
        details.default = value.name === 'true' || value.name === 'false' ? value.name === 'true' : mapped(value.name);
    } else if (value && value.kind === 'call') {
        if (value.name === 'now') {
            details.defaultRaw = 'CURRENT_TIMESTAMP';
        } else if (value.name === 'dbgenerated' && stringOf(argument({ args: value.args }, null)) !== undefined) {
            details.defaultRaw = stringOf(argument({ args: value.args }, null));
        } else if (value.name === 'autoincrement' || value.name === 'sequence') {
            details.autoIncrement = true;
        }
    }
    if (enumValues) {
        details.values = enumValues.map(v => v.value);
    }
    if (field.attributes.some(a => a.name === 'unique')) {
        details.unique = true;
    }
    return details;
}

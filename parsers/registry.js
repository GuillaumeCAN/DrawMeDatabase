//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// The parsers of DrawMeDatabase, one per stack (framework or ORM), and the detection of the stack
// of a folder. Each parser module follows the contract of docs/parsers.md:
//   { id, label, detect(basePath) → score, sources(basePath, { overrides }) → { folders, files, extensions },
//     parse(basePath, options) → { tables, warnings },
//     optional: dialect(basePath, { overrides }) → id | null, migrations(basePath, { overrides }) → { root, framework, migrations } | null }
// A new stack is a new module in the list below.

const path = require('path');

const UNKNOWN = 'Unknown';

// The databases a parser may tell (dialect()): the SQL of the project is written for one of them
const DIALECTS = ['postgresql', 'mysql', 'mariadb', 'sqlite', 'sqlserver', 'cockroachdb', 'singlestore', 'mongodb'];

// In the order of detection: the first one wins a tie. Loaded on first use (require() runs each
// time, Node keeps the modules)
const MODULES = [
    () => require('./laravel'),
    () => require('./symfony'),
    () => require('./prisma'),
    () => require('./drizzle'),
    () => require('./sql'),
];

const list = (value) => (Array.isArray(value) ? value : []);
const nonEmpty = (value) => typeof value === 'string' && value !== '';

// A registry of the parsers `entries` (modules, or functions that return them), in the order of
// detection. The extension uses the one of MODULES; the tests make their own.
function createRegistry(entries) {
    // Every parser, in the order of detection
    const getParsers = () => entries.map(entry => (typeof entry === 'function' ? entry() : entry));

    // The parser of a stack id ('laravel'...), or undefined
    const getParser = (id) => (nonEmpty(id) ? getParsers().find(parser => parser.id === id) : undefined);

    // The labels of the supported stacks, in the order of detection (['Laravel', 'Symfony'])
    const labels = () => getParsers().map(parser => parser.label);

    // The stack of the framework root basePath: { framework, forced, matches, errors }.
    // - framework: the id of the parser, or 'Unknown';
    // - forced: true when options.framework names a parser (the DrawMeDatabase.framework setting),
    //   which wins without detection; 'auto', or a value that names no parser, detects;
    // - matches: the parsers that recognize the folder, best first ({ id, label, score }), the
    //   order of the list breaking ties;
    // - errors: the parsers that threw ({ id, label, message }), in the order of the list.
    // A parser that throws (an invalid composer.json...) recognizes nothing; its error is thrown
    // when no other parser recognizes the folder, else it is in `errors`, for the output.
    const detect = (basePath, options = {}) => {
        const framework = options && typeof options === 'object' ? options.framework : undefined;
        const forced = framework !== 'auto' ? getParser(framework) : undefined;
        if (forced) {
            return { framework: forced.id, forced: true, matches: [], errors: [] };
        }
        const found = [];
        const errors = [];
        if (nonEmpty(basePath)) {
            getParsers().forEach((parser, index) => {
                try {
                    const score = Number(parser.detect(basePath));
                    if (Number.isFinite(score) && score > 0) {
                        found.push({ id: parser.id, label: parser.label, score, index });
                    }
                } catch (err) {
                    errors.push({ parser, err });
                }
            });
        }
        if (found.length === 0 && errors.length > 0) {
            throw errors[0].err;
        }
        const matches = found
            .sort((a, b) => b.score - a.score || a.index - b.index)
            .map(({ id, label, score }) => ({ id, label, score }));
        return {
            framework: matches.length > 0 ? matches[0].id : UNKNOWN,
            forced: false,
            matches,
            errors: errors.map(({ parser, err }) => ({ id: parser.id, label: parser.label, message: err && err.message ? err.message : String(err) })),
        };
    };

    // The id of the stack of basePath ('laravel', 'symfony'...), or 'Unknown'. options.framework:
    // a parser id that wins over the detection, as the DrawMeDatabase.framework setting
    // (ParserError: invalid composer.json, when no parser recognizes the folder)
    const detectFramework = (basePath, options = {}) => detect(basePath, options).framework;

    // The sources of the parser `id` for basePath, cleaned: { folders: [{ path, recursive, pattern? }],
    // files, extensions }, with absolute paths and extensions starting with '.'. A folder given as
    // a string is not recursive; pattern, kept when it is a string: the glob of its files. undefined
    // for an unknown id. options.overrides (Map: absolute
    // path → text of an unsaved editor) goes to the parser, whose sources may depend on the text of
    // a configuration file (the schema path of an unsaved prisma.config.ts).
    const getSources = (id, basePath, options = {}) => {
        const parser = getParser(id);
        if (!parser) {
            return undefined;
        }
        const overrides = options && options.overrides instanceof Map ? options.overrides : null;
        const raw = (typeof parser.sources === 'function' && parser.sources(basePath, { overrides })) || {};
        const base = nonEmpty(basePath) ? basePath : '.';
        return {
            folders: list(raw.folders)
                .map(folder => (typeof folder === 'string' ? { path: folder, recursive: false } : folder))
                .filter(folder => folder && nonEmpty(folder.path))
                .map(folder => ({ path: path.resolve(base, folder.path), recursive: folder.recursive === true, ...(nonEmpty(folder.pattern) ? { pattern: folder.pattern } : {}) })),
            files: list(raw.files).filter(nonEmpty).map(file => path.resolve(base, file)),
            extensions: [...new Set(list(raw.extensions).filter(nonEmpty).map(extension => (extension.startsWith('.') ? extension : `.${extension}`)))],
        };
    };

    // The database the project of a framework root is for (one of DIALECTS), as its parser reads it
    // (the provider of a Prisma schema, the dialect of drizzle.config.ts, the connection of a Laravel
    // application...), or null when the parser cannot tell (or has no dialect()). options.overrides:
    // the unsaved editors. A parser that throws tells nothing.
    const getDialect = (id, basePath, options = {}) => {
        const parser = getParser(id);
        if (!parser || typeof parser.dialect !== 'function' || !nonEmpty(basePath)) {
            return null;
        }
        try {
            const dialect = parser.dialect(basePath, { overrides: options && options.overrides instanceof Map ? options.overrides : null });
            return DIALECTS.includes(dialect) ? dialect : null;
        } catch {
            return null;
        }
    };

    // The migrations of a framework root, in the order their tool runs them, cleaned: { root,
    // framework, migrations: [{ id, file, time? }] } (root, file: absolute paths; id: what the option
    // `until` of parse(root, framework) takes; time: seconds since 1970, when the migration tells
    // it), or null when the stack keeps no migrations the parsers replay (a dump, Symfony) or when
    // there are none. parse(root, framework, { until: id }) gives the schema right after one.
    const getMigrations = (id, basePath, options = {}) => {
        const parser = getParser(id);
        if (!parser || typeof parser.migrations !== 'function' || !nonEmpty(basePath)) {
            return null;
        }
        const raw = parser.migrations(basePath, { overrides: options && options.overrides instanceof Map ? options.overrides : null });
        if (!raw || !nonEmpty(raw.root) || !getParser(raw.framework) || !Array.isArray(raw.migrations)) {
            return null;
        }
        const migrations = raw.migrations
            .filter(migration => migration && nonEmpty(migration.id) && nonEmpty(migration.file))
            .map(migration => ({
                id: migration.id,
                file: path.resolve(raw.root, migration.file),
                ...(Number.isFinite(migration.time) ? { time: Math.floor(migration.time) } : {}),
            }));
        return migrations.length > 0 ? { root: path.resolve(raw.root), framework: raw.framework, migrations } : null;
    };

    return { getParsers, getParser, labels, detect, detectFramework, getSources, getDialect, getMigrations };
}

// ---------------------------------------------------------------------------------------------
// Sources: what a parser reads, for the file watcher, the unsaved editors and the git status

// A glob of the files of a folder (`**/schema.ts`, `db/{columns,columns.*}`) as a regular expression
// of their paths from the folder, with '/': `*` and `?` in a name, `**` any folders, `[...]` a
// class of characters, `{a,b}` alternatives. Kept per glob.
const globs = new Map();
function globRegExp(glob) {
    if (globs.has(glob)) {
        return globs.get(glob);
    }
    let i = 0;
    const read = (inBraces) => {
        let source = '';
        while (i < glob.length) {
            const c = glob[i];
            if (inBraces && (c === ',' || c === '}')) {
                break;
            }
            if (c === '*' && glob[i + 1] === '*') {
                i += 2;
                // '**/': any number of folders; a final '**': anything
                if (glob[i] === '/') {
                    i++;
                    source += '(?:[^/]*/)*';
                } else {
                    source += '.*';
                }
            } else if (c === '*') {
                i++;
                source += '[^/]*';
            } else if (c === '?') {
                i++;
                source += '[^/]';
            } else if (c === '[' && glob.indexOf(']', i + 1) !== -1) {
                const end = glob.indexOf(']', i + 1);
                source += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
                i = end + 1;
            } else if (c === '{') {
                i++;
                const alternatives = [read(true)];
                while (glob[i] === ',') {
                    i++;
                    alternatives.push(read(true));
                }
                i++;
                source += `(?:${alternatives.join('|')})`;
            } else {
                i++;
                source += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
            }
        }
        return source;
    };
    const regExp = new RegExp(`^${read(false)}$`);
    if (globs.size >= 1000) {
        globs.clear();
    }
    globs.set(glob, regExp);
    return regExp;
}

// Whether filePath is one of the sources (as getSources() gives them): one of the files, or a file
// of a folder (directly in it, or in a sub-folder of a recursive one; the files of its glob when
// it has a pattern) with one of the extensions (any file when there are none)
function covers(sources, filePath) {
    if (!sources || !nonEmpty(filePath)) {
        return false;
    }
    const file = path.resolve(filePath);
    if (list(sources.files).some(candidate => path.resolve(candidate) === file)) {
        return true;
    }
    const extensions = list(sources.extensions);
    if (extensions.length > 0 && !extensions.some(extension => file.endsWith(extension))) {
        return false;
    }
    return list(sources.folders).some(folder => {
        const dir = path.resolve(folder.path);
        if (nonEmpty(folder.pattern)) {
            const relative = path.relative(dir, file);
            return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) && globRegExp(folder.pattern).test(relative.split(path.sep).join('/'));
        }
        return folder.recursive ? file.startsWith(dir + path.sep) : path.dirname(file) === dir;
    });
}

// The glob patterns that watch the sources: [{ base, pattern }], the pattern relative to the
// absolute folder base ('*.php', '**/*.{prisma,ts}', 'schema.prisma', or the pattern of a folder)
function watchPatterns(sources) {
    if (!sources) {
        return [];
    }
    const names = list(sources.extensions).map(extension => extension.slice(1));
    const files = names.length === 0 ? '*' : names.length === 1 ? `*.${names[0]}` : `*.{${names.join(',')}}`;
    return [
        ...list(sources.folders).map(folder => ({ base: path.resolve(folder.path), pattern: nonEmpty(folder.pattern) ? folder.pattern : folder.recursive ? `**/${files}` : files })),
        ...list(sources.files).map(file => ({ base: path.dirname(path.resolve(file)), pattern: path.basename(file) })),
    ];
}

module.exports = { UNKNOWN, DIALECTS, createRegistry, covers, watchPatterns, globRegExp, ...createRegistry(MODULES) };

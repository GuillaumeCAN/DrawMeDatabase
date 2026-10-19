//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// The parsers of DrawMeDatabase, one per stack (framework or ORM), and the detection of the stack
// of a folder. Each parser module follows the contract of docs/parsers.md:
//   { id, label, detect(basePath) → score, sources(basePath) → { folders, files, extensions },
//     parse(basePath, options) → { tables, warnings } }
// A new stack is a new module in the list below.

const path = require('path');

const UNKNOWN = 'Unknown';

// In the order of detection: the first one wins a tie. Loaded on first use (require() runs each
// time, Node keeps the modules)
const MODULES = [
    () => require('./laravel'),
    () => require('./symfony'),
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

    // The stack of the framework root basePath: { framework, forced, matches }.
    // - framework: the id of the parser, or 'Unknown';
    // - forced: true when options.framework names a parser (the DrawMeDatabase.framework setting),
    //   which wins without detection; 'auto', or a value that names no parser, detects;
    // - matches: the parsers that recognize the folder, best first ({ id, label, score }), the
    //   order of the list breaking ties.
    // A parser that throws (an invalid composer.json...) recognizes nothing; its error is thrown
    // when no other parser recognizes the folder.
    const detect = (basePath, options = {}) => {
        const framework = options && typeof options === 'object' ? options.framework : undefined;
        const forced = framework !== 'auto' ? getParser(framework) : undefined;
        if (forced) {
            return { framework: forced.id, forced: true, matches: [] };
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
                    errors.push(err);
                }
            });
        }
        if (found.length === 0 && errors.length > 0) {
            throw errors[0];
        }
        const matches = found
            .sort((a, b) => b.score - a.score || a.index - b.index)
            .map(({ id, label, score }) => ({ id, label, score }));
        return { framework: matches.length > 0 ? matches[0].id : UNKNOWN, forced: false, matches };
    };

    // The id of the stack of basePath ('laravel', 'symfony'...), or 'Unknown'. options.framework:
    // a parser id that wins over the detection, as the DrawMeDatabase.framework setting
    // (ParserError: invalid composer.json, when no parser recognizes the folder)
    const detectFramework = (basePath, options = {}) => detect(basePath, options).framework;

    // The sources of the parser `id` for basePath, cleaned: { folders: [{ path, recursive }],
    // files, extensions }, with absolute paths and extensions starting with '.'. A folder given as
    // a string is not recursive. undefined for an unknown id.
    const getSources = (id, basePath) => {
        const parser = getParser(id);
        if (!parser) {
            return undefined;
        }
        const raw = (typeof parser.sources === 'function' && parser.sources(basePath)) || {};
        const base = nonEmpty(basePath) ? basePath : '.';
        return {
            folders: list(raw.folders)
                .map(folder => (typeof folder === 'string' ? { path: folder, recursive: false } : folder))
                .filter(folder => folder && nonEmpty(folder.path))
                .map(folder => ({ path: path.resolve(base, folder.path), recursive: folder.recursive === true })),
            files: list(raw.files).filter(nonEmpty).map(file => path.resolve(base, file)),
            extensions: [...new Set(list(raw.extensions).filter(nonEmpty).map(extension => (extension.startsWith('.') ? extension : `.${extension}`)))],
        };
    };

    return { getParsers, getParser, labels, detect, detectFramework, getSources };
}

// ---------------------------------------------------------------------------------------------
// Sources: what a parser reads, for the file watcher, the unsaved editors and the git status

// Whether filePath is one of the sources (as getSources() gives them): one of the files, or a file
// of a folder (directly in it, or in a sub-folder of a recursive one) with one of the extensions
// (any file when there are none)
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
        return folder.recursive ? file.startsWith(dir + path.sep) : path.dirname(file) === dir;
    });
}

// The glob patterns that watch the sources: [{ base, pattern }], the pattern relative to the
// absolute folder base ('*.php', '**/*.{prisma,ts}', 'schema.prisma')
function watchPatterns(sources) {
    if (!sources) {
        return [];
    }
    const names = list(sources.extensions).map(extension => extension.slice(1));
    const files = names.length === 0 ? '*' : names.length === 1 ? `*.${names[0]}` : `*.{${names.join(',')}}`;
    return [
        ...list(sources.folders).map(folder => ({ base: path.resolve(folder.path), pattern: folder.recursive ? `**/${files}` : files })),
        ...list(sources.files).map(file => ({ base: path.dirname(path.resolve(file)), pattern: path.basename(file) })),
    ];
}

module.exports = { UNKNOWN, createRegistry, covers, watchPatterns, ...createRegistry(MODULES) };

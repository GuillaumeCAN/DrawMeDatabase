//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Reads the schema of a database from SQL files: the migrations of a SQL migration tool, replayed in
// the order the tool applies them (Supabase, Flyway, dbmate, golang-migrate, goose, diesel, sqlx...,
// and the output of prisma migrate or drizzle-kit when that stack is not detected), or a dump of the
// schema (pg_dump, mysqldump, sqlite3 .schema, Rails db/structure.sql, a schema.sql). PostgreSQL
// first, with the basics of MySQL and SQLite. The SQL is read, never run: the statements that create
// or change tables (CREATE TABLE, ALTER TABLE, CREATE INDEX, CREATE TYPE ... AS ENUM, DROP...) are
// replayed, the others (functions, triggers, policies, grants, data) are passed over.

const fs = require('fs');
const path = require('path');
const { ParserError } = require('./errors');
const { createStatusReader, tableStatus, changedStatus } = require('./git');
const { createLineLocator } = require('./ts-utils');

// Details of a column (option `details`), in the order of docs/pivot-format.md
const DETAIL_KEYS = ['length', 'precision', 'scale', 'unsigned', 'default', 'defaultRaw', 'onUpdateCurrent', 'values', 'unique', 'autoIncrement', 'comment'];
// Detection scores: below the frameworks (50 and more), whose SQL files are often an output of theirs
const SCORE_MIGRATIONS = 45;
const SCORE_DUMP = 40;
// The tables of the migration tools themselves, not drawn (by name, in any schema)
const BOOKKEEPING = new Set(['schema_migrations', 'ar_internal_metadata', 'flyway_schema_history', 'schema_version', '_prisma_migrations', 'goose_db_version', '__drizzle_migrations', '__diesel_schema_migrations', '_sqlx_migrations', 'atlas_schema_revisions', 'pgmigrations']);
// PostgreSQL limits the names to 63 bytes (NAMEDATALEN - 1)
const MAX_NAME = 63;
// Excerpts of statements in the warnings
const EXCERPT = 60;
// Parentheses around a default value read at most
const MAX_DEPTH = 8;

const toPosix = (filePath) => filePath.split(path.sep).join('/');
const stat = (filePath) => {
    try {
        return fs.statSync(filePath);
    } catch {
        return null;
    }
};
const isFile = (filePath) => Boolean(stat(filePath)?.isFile());
const isDirectory = (filePath) => Boolean(stat(filePath)?.isDirectory());
// The path of a file once its symbolic links are followed, null when it cannot be read
const realPath = (filePath) => {
    try {
        return fs.realpathSync(filePath);
    } catch {
        return null;
    }
};
const list = (dir) => {
    try {
        return fs.readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    } catch {
        return [];
    }
};

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
// Tokens and statements

const isWordStart = (code) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code >= 128;
const isDigit = (code) => code >= 48 && code <= 57;
const isWordPart = (code) => isWordStart(code) || isDigit(code) || code === 36;
const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', 0: '\0', Z: '\x1a' };
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
// The MySQL version whose executable comments (/*!80003 ... */) are read as code: MySQL 8.4
const MYSQL_VERSION = 80499;

// The end of the line of text[i] (the offset of its '\n', or `to`)
function lineEnd(text, i, to) {
    const end = text.indexOf('\n', i);
    return end === -1 || end > to ? to : end;
}

// A quoted string or identifier from text[i] = quote: { value, end, closed }. The quote is escaped
// by doubling it; `backslash`: backslash escapes too (MySQL strings, PostgreSQL E'...')
function readQuoted(text, i, to, quote, backslash) {
    let value = '';
    let j = i + 1;
    let last = j;
    while (j < to) {
        const c = text[j];
        if (c === quote) {
            if (text[j + 1] === quote && j + 1 < to) {
                value += text.slice(last, j + 1);
                j += 2;
                last = j;
                continue;
            }
            return { value: value + text.slice(last, j), end: j + 1, closed: true };
        }
        if (backslash && c === '\\' && j + 1 < to) {
            const next = text[j + 1];
            value += text.slice(last, j) + (ESCAPES[next] !== undefined ? ESCAPES[next] : next);
            j += 2;
            last = j;
            continue;
        }
        j++;
    }
    return { value: value + text.slice(last, to), end: to, closed: false };
}

// Whether the tokens of a statement are a COPY ... FROM STDIN, whose data lines follow it
function isCopyFromStdin(tokens) {
    if (!isWord(tokens[0], 'COPY')) {
        return false;
    }
    for (let k = 1; k + 1 < tokens.length; k++) {
        if (isWord(tokens[k], 'FROM') && isWord(tokens[k + 1], 'STDIN')) {
            return true;
        }
    }
    return false;
}

// Markers of the up and down sections of the migration tools that keep both in one file, read in
// the `--` comments at the start of a line
const SECTION_MARKERS = {
    dbmate: { up: /^\s*migrate:up\b/, down: /^\s*migrate:down\b/ },
    goose: { up: /^\s*\+goose\s+up\b/i, down: /^\s*\+goose\s+down\b/i },
    pgmigrate: { up: /^\s*up\s+migration\b/i, down: /^\s*down\s+migration\b/i },
};

// The sections of a migration file: 'dbmate', 'goose' or 'pgmigrate' (node-pg-migrate) when it has
// their up marker, else null
function sectionsOf(text) {
    if (/^--\s*migrate:up\b/m.test(text)) {
        return 'dbmate';
    }
    if (/^--\s*\+goose\s+up\b/im.test(text)) {
        return 'goose';
    }
    if (/^--\s*up\s+migration\b/im.test(text)) {
        return 'pgmigrate';
    }
    return null;
}

// Splits SQL text into statements of tokens: { statements: [{ tokens, start, end, copy }],
// problems: [{ offset, message }] }. dialect: 'postgresql', 'mysql', 'sqlite' or 'unknown' (how
// strings, identifiers and comments are quoted). Comments are skipped, and so are the client
// commands (psql `\` commands, DELIMITER, which changes the end of the statements); the data of a
// COPY ... FROM STDIN is skipped, its range kept in `copy`. options: from, to (a part of the text),
// sections (only the up sections: see SECTION_MARKERS). Tokens: { type: 'word' (with `upper`),
// 'ident' (a quoted name), 'string', 'dollar' (a dollar-quoted text, with bodyStart and bodyEnd),
// 'number' or 'punct', value, start, end, prefix (of a string: 'e', 'x', 'b', 'n') }.
function scanStatements(text, dialect, options = {}) {
    const from = options.from || 0;
    const to = options.to === undefined ? text.length : options.to;
    const markers = options.sections ? SECTION_MARKERS[options.sections] : null;
    const mysql = dialect === 'mysql';
    const dollars = dialect === 'postgresql' || dialect === 'unknown';
    const brackets = dialect === 'sqlite';
    const nested = dialect === 'postgresql' || dialect === 'unknown';
    const statements = [];
    const problems = [];
    let tokens = [];
    let delimiter = ';';
    let active = !markers;
    // goose `-- +goose StatementBegin`: one statement until StatementEnd, whatever its semicolons
    let forced = false;
    // The BEGIN and CASE of the body of a trigger or a routine written without a DELIMITER (SQLite
    // triggers, PostgreSQL BEGIN ATOMIC), whose semicolons do not end the statement
    const body = [];
    let pendingEnd = false;
    let routine = null;
    let i = from;
    let lineStart = true;
    // Executable comments being read as code (MySQL /*!...*/)
    let executable = 0;

    const finish = () => {
        let copy = false;
        if (tokens.length > 0) {
            const statement = { tokens, start: tokens[0].start, end: tokens[tokens.length - 1].end, copy: null };
            statements.push(statement);
            copy = isCopyFromStdin(tokens) ? statement : false;
        }
        tokens = [];
        body.length = 0;
        pendingEnd = false;
        routine = null;
        forced = false;
        return copy;
    };
    const closeEnd = () => {
        if (pendingEnd) {
            pendingEnd = false;
            body.pop();
        }
    };
    const push = (token) => {
        if (!active) {
            return;
        }
        if (token.type === 'word') {
            if (pendingEnd) {
                pendingEnd = false;
                if (token.upper === 'CASE') {
                    if (body[body.length - 1] === 'CASE') {
                        body.pop();
                    }
                } else if (!['IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR'].includes(token.upper)) {
                    body.pop();
                }
            } else if (token.upper === 'BEGIN' || (token.upper === 'CASE' && body.length > 0)) {
                if (routine === null) {
                    routine = isWord(tokens[0], 'CREATE') && tokens.slice(0, 16).some(t => isWord(t, 'TRIGGER', 'FUNCTION', 'PROCEDURE', 'EVENT'));
                }
                if (routine) {
                    body.push(token.upper);
                }
            } else if (token.upper === 'END' && body.length > 0) {
                pendingEnd = true;
            }
        } else if (pendingEnd) {
            closeEnd();
        }
        tokens.push(token);
    };
    // Skips the data lines of a COPY ... FROM STDIN, up to the line `\.`
    const skipCopy = (statement) => {
        let start = lineEnd(text, i, to);
        start = start < to ? start + 1 : to;
        let j = start;
        while (j < to) {
            const end = lineEnd(text, j, to);
            if (text.slice(j, end).replace(/\r$/, '') === '\\.') {
                statement.copy = { start, end: j };
                i = end;
                return;
            }
            j = end + 1;
        }
        statement.copy = { start, end: to };
        i = to;
    };

    while (i < to) {
        const code = text.charCodeAt(i);
        if (code === 10) {
            lineStart = true;
            i++;
            continue;
        }
        if (code === 32 || code === 9 || code === 13 || code === 11 || code === 12 || code === 0xfeff) {
            i++;
            continue;
        }
        const c = text[i];
        const startOfLine = lineStart;
        lineStart = false;
        // Client commands, on a line of their own: psql's backslash commands (\connect, \restrict
        // of pg_dump 17.6...), and DELIMITER of the mysql client
        if (startOfLine && c === '\\' && tokens.length === 0) {
            i = lineEnd(text, i, to);
            continue;
        }
        if (startOfLine && (c === 'd' || c === 'D') && tokens.length === 0 && dialect !== 'postgresql') {
            const match = /^delimiter[ \t]+(\S+)[^\n]*/i.exec(text.slice(i, lineEnd(text, i, to)));
            if (match) {
                finish();
                delimiter = match[1];
                i += match[0].length;
                continue;
            }
        }
        // Comments, and the markers some tools write in them
        if (c === '-' && text[i + 1] === '-') {
            const end = lineEnd(text, i, to);
            const comment = text.slice(i + 2, end);
            if (/^>\s*statement-breakpoint/.test(comment)) {
                finish();
            } else if (markers && startOfLine) {
                if (markers.up.test(comment)) {
                    finish();
                    active = true;
                } else if (markers.down.test(comment)) {
                    finish();
                    active = false;
                } else if (options.sections === 'goose' && /^\s*\+goose\s+statementbegin\b/i.test(comment)) {
                    finish();
                    forced = true;
                } else if (options.sections === 'goose' && /^\s*\+goose\s+statementend\b/i.test(comment)) {
                    finish();
                }
            }
            i = end;
            continue;
        }
        if (c === '#' && mysql) {
            i = lineEnd(text, i, to);
            continue;
        }
        if (c === '*' && text[i + 1] === '/' && executable > 0) {
            // The end of a MySQL executable comment
            executable--;
            i += 2;
            continue;
        }
        if (c === '/' && text[i + 1] === '*' && mysql && text[i + 2] === '!') {
            // MySQL executable comments: /*!80003 SRID 0 */ is code for the versions after 8.0.3,
            // which every supported MySQL is
            const version = /^\d{5,6}/.exec(text.slice(i + 3, i + 9));
            if (!version || Number(version[0]) <= MYSQL_VERSION) {
                executable++;
                i += 3 + (version ? version[0].length : 0);
                continue;
            }
        }
        if (c === '/' && text[i + 1] === '*') {
            let depth = 1;
            let j = i + 2;
            while (j < to && depth > 0) {
                if (text[j] === '*' && text[j + 1] === '/') {
                    depth--;
                    j += 2;
                } else if (nested && text[j] === '/' && text[j + 1] === '*') {
                    depth++;
                    j += 2;
                } else {
                    j++;
                }
            }
            if (depth > 0) {
                problems.push({ offset: i, message: 'comment not closed: the end of the file is skipped.' });
                j = to;
            }
            i = Math.min(j, to);
            continue;
        }
        // The end of a statement
        if (delimiter !== ';' && text.startsWith(delimiter, i)) {
            finish();
            i += delimiter.length;
            continue;
        }
        if (c === ';' && delimiter === ';') {
            closeEnd();
            if (forced || body.length > 0) {
                push({ type: 'punct', value: ';', start: i, end: i + 1 });
                i++;
                continue;
            }
            i++;
            const copy = finish();
            if (copy) {
                skipCopy(copy);
            }
            continue;
        }
        // Strings and quoted names
        if (c === '\'' || (c === '"' && mysql)) {
            const read = readQuoted(text, i, to, c, mysql);
            if (!read.closed) {
                problems.push({ offset: i, message: 'string not closed: the end of the file is skipped.' });
            }
            push({ type: 'string', value: read.value, start: i, end: read.end });
            i = read.end;
            continue;
        }
        if (c === '"' || c === '`' || (c === '[' && brackets)) {
            const read = c === '[' ? (() => {
                const end = text.indexOf(']', i + 1);
                return end === -1 || end >= to ? { value: text.slice(i + 1, to), end: to, closed: false } : { value: text.slice(i + 1, end), end: end + 1, closed: true };
            })() : readQuoted(text, i, to, c, false);
            if (!read.closed) {
                problems.push({ offset: i, message: 'quoted name not closed: the end of the file is skipped.' });
            }
            push({ type: 'ident', value: read.value, start: i, end: read.end });
            i = read.end;
            continue;
        }
        if (c === '$' && dollars && (i === from || !isWordPart(text.charCodeAt(i - 1)))) {
            DOLLAR_TAG.lastIndex = i;
            const tag = DOLLAR_TAG.exec(text);
            if (tag) {
                const bodyStart = i + tag[0].length;
                let close = text.indexOf(tag[0], bodyStart);
                if (close === -1 || close + tag[0].length > to) {
                    problems.push({ offset: i, message: `dollar-quoted text (${tag[0]}) not closed: the end of the file is skipped.` });
                    close = to;
                }
                const end = Math.min(close + tag[0].length, to);
                push({ type: 'dollar', value: text.slice(bodyStart, close), start: i, end, bodyStart, bodyEnd: close });
                i = end;
                continue;
            }
        }
        if (isWordStart(code)) {
            let j = i + 1;
            while (j < to && isWordPart(text.charCodeAt(j))) {
                j++;
            }
            const word = text.slice(i, j);
            // Prefixed strings: E'...' (backslash escapes), X'...', B'...', N'...'
            if (j - i === 1 && text[j] === '\'' && /[EeXxBbNn]/.test(word)) {
                const prefix = word.toLowerCase();
                const read = readQuoted(text, j, to, '\'', prefix === 'e' || mysql);
                if (!read.closed) {
                    problems.push({ offset: i, message: 'string not closed: the end of the file is skipped.' });
                }
                push({ type: 'string', value: read.value, start: i, end: read.end, prefix });
                i = read.end;
                continue;
            }
            push({ type: 'word', value: word, upper: word.toUpperCase(), start: i, end: j });
            i = j;
            continue;
        }
        if (isDigit(code) || (c === '.' && isDigit(text.charCodeAt(i + 1)))) {
            NUMBER.lastIndex = i;
            const number = NUMBER.exec(text);
            let j = i + number[0].length;
            if (j < to && isWordStart(text.charCodeAt(j)) && !/^0[xX]/.test(text.slice(i, i + 2))) {
                // A name that starts with digits (MySQL: 1st_table)
                while (j < to && isWordPart(text.charCodeAt(j))) {
                    j++;
                }
                const word = text.slice(i, j);
                push({ type: 'word', value: word, upper: word.toUpperCase(), start: i, end: j });
            } else {
                if (/^0[xX]/.test(text.slice(i, i + 2))) {
                    j = i + 2;
                    while (j < to && /[0-9A-Fa-f]/.test(text[j])) {
                        j++;
                    }
                }
                push({ type: 'number', value: text.slice(i, j), start: i, end: j });
            }
            i = j;
            continue;
        }
        if (c === ':' && text[i + 1] === ':') {
            push({ type: 'punct', value: '::', start: i, end: i + 2 });
            i += 2;
            continue;
        }
        push({ type: 'punct', value: c, start: i, end: i + 1 });
        i++;
    }
    finish();
    return { statements, problems };
}

// ---------------------------------------------------------------------------------------------
// Reading tokens

const isWord = (token, ...words) => Boolean(token) && token.type === 'word' && (words.length === 0 || words.includes(token.upper));
const isPunct = (token, value) => Boolean(token) && token.type === 'punct' && token.value === value;
const isName = (token) => Boolean(token) && (token.type === 'word' || token.type === 'ident');

// A cursor on the tokens [from, end) of a statement: { tokens, i, end }
const cursorOf = (tokens, from = 0, end = tokens.length) => ({ tokens, i: from, end });
const peek = (c, k = 0) => (c.i + k < c.end ? c.tokens[c.i + k] : null);
// Consumes the words when the next tokens are these words (case-insensitive)
function accept(c, ...words) {
    for (let k = 0; k < words.length; k++) {
        if (!isWord(peek(c, k), words[k])) {
            return false;
        }
    }
    c.i += words.length;
    return true;
}
function acceptPunct(c, value) {
    if (isPunct(peek(c), value)) {
        c.i++;
        return true;
    }
    return false;
}

// The index of the token that closes the bracket at tokens[open] ('(' or '['), or `end` when it is
// not closed
function closing(tokens, open, end) {
    let depth = 0;
    for (let k = open; k < end; k++) {
        const t = tokens[k];
        if (t.type !== 'punct') {
            continue;
        }
        if (t.value === '(' || t.value === '[') {
            depth++;
        } else if (t.value === ')' || t.value === ']') {
            depth--;
            if (depth === 0) {
                return k;
            }
        }
    }
    return end;
}

// Skips a bracketed group at the cursor: true when there was one
function skipGroup(c) {
    if (isPunct(peek(c), '(') || isPunct(peek(c), '[')) {
        c.i = Math.min(closing(c.tokens, c.i, c.end) + 1, c.end);
        return true;
    }
    return false;
}

// The ranges [from, to) of the parts of tokens [from, end) separated by commas outside brackets
function splitCommas(tokens, from, end) {
    const parts = [];
    let depth = 0;
    let start = from;
    for (let k = from; k < end; k++) {
        const t = tokens[k];
        if (t.type !== 'punct') {
            continue;
        }
        if (t.value === '(' || t.value === '[') {
            depth++;
        } else if (t.value === ')' || t.value === ']') {
            depth--;
        } else if (t.value === ',' && depth === 0) {
            parts.push([start, k]);
            start = k + 1;
        }
    }
    if (start < end) {
        parts.push([start, end]);
    }
    return parts;
}

// The index of the first word of `words` at depth 0 in tokens [from, end), or `end`
function findWord(tokens, from, end, words) {
    let depth = 0;
    for (let k = from; k < end; k++) {
        const t = tokens[k];
        if (isPunct(t, '(') || isPunct(t, '[')) {
            depth++;
        } else if (isPunct(t, ')') || isPunct(t, ']')) {
            depth--;
        } else if (depth === 0 && t.type === 'word' && words.has(t.upper)) {
            return k;
        }
    }
    return end;
}

// The end of an expression at tokens[from]: the first word of `words` at its depth after its first
// token (DEFAULT NULL, DEFAULT (now()) NOT NULL), or `end`
function expressionEnd(tokens, from, end, words) {
    let depth = 0;
    for (let k = from; k < end; k++) {
        const t = tokens[k];
        if (isPunct(t, '(') || isPunct(t, '[')) {
            depth++;
        } else if (isPunct(t, ')') || isPunct(t, ']')) {
            depth--;
        } else if (k > from && depth === 0 && t.type === 'word' && words.has(t.upper)) {
            return k;
        }
    }
    return end;
}

// The text of tokens [from, to) as written, with one space where the code has spaces or comments
function textOf(text, tokens, from, to) {
    let out = '';
    for (let k = from; k < to; k++) {
        if (k > from && tokens[k].start > tokens[k - 1].end) {
            out += ' ';
        }
        out += text.slice(tokens[k].start, tokens[k].end);
    }
    return out;
}

function excerpt(value) {
    const shown = value.replace(/\s+/g, ' ').trim();
    return shown.length > EXCERPT ? `${shown.slice(0, EXCERPT)}...` : shown;
}

// The parts of a name at the cursor (schema.table, "a"."b", `db`.`t`): [{ value, quoted }], or null
function readName(c) {
    const parts = [];
    while (isName(peek(c))) {
        const t = peek(c);
        parts.push({ value: t.value, quoted: t.type === 'ident' });
        c.i++;
        if (isPunct(peek(c), '.') && isName(peek(c, 1))) {
            c.i++;
            continue;
        }
        break;
    }
    return parts.length > 0 ? parts : null;
}

// ---------------------------------------------------------------------------------------------
// Names and the schema state

// The replay state: the tables, the enum types and how names are read in this dialect
function createState(dialect, options = {}) {
    return {
        dialect,
        // Lookups: exact names on PostgreSQL (unquoted names are folded to lower case), else case-insensitive
        exact: dialect === 'postgresql',
        tables: new Map(),
        types: new Map(),
        // The tables not drawn (bookkeeping tables), so that their indexes and constraints are passed over
        skipped: new Set(),
        skip: options.skip || (() => false),
        searchPath: ['public'],
        database: null,
        warnings: [],
        rows: options.collect ? { table: options.collect, values: [] } : null,
    };
}

// A name part as stored by the database: PostgreSQL folds the unquoted names to lower case
const fold = (state, part) => (state.dialect === 'postgresql' && !part.quoted ? part.value.replace(/[A-Z]+/g, s => s.toLowerCase()) : part.value);
const defaultSchema = (state) => (state.dialect === 'postgresql' || state.dialect === 'unknown' ? 'public' : null);
const keyOf = (state, schema, name) => {
    const key = `${schema || ''}\u0000${name}`;
    return state.exact ? key : key.toLowerCase();
};

// A reference to a table or a type from its name parts: { schema, name }. The schema is null for
// the default one on MySQL (the current database) and SQLite (main); unqualified PostgreSQL names
// are looked up in the search path (`resolve`), or created in its first schema
function refOf(state, parts, { resolve = null } = {}) {
    const name = fold(state, parts[parts.length - 1]);
    let schema = parts.length > 1 ? fold(state, parts[parts.length - 2]) : null;
    if (state.dialect === 'mysql' && schema !== null && state.database !== null && keyOf(state, schema, '') === keyOf(state, state.database, '')) {
        schema = null;
    }
    if (state.dialect === 'sqlite' && schema !== null && schema.toLowerCase() === 'main') {
        schema = null;
    }
    if (schema === null && defaultSchema(state) !== null) {
        const path = state.searchPath.length > 0 ? state.searchPath : ['public'];
        const found = resolve ? path.find(candidate => resolve.has(keyOf(state, candidate, name))) : undefined;
        schema = found || path[0];
    }
    return { schema, name };
}
const tableRef = (state, parts) => refOf(state, parts, { resolve: state.tables });
const typeRef = (state, parts) => refOf(state, parts, { resolve: state.types });
const refKey = (state, ref) => keyOf(state, ref.schema, ref.name);
// The name of a table in the pivot format: prefixed with its schema unless it is the default one
const display = (state, ref) => (ref.schema && ref.schema !== defaultSchema(state) ? `${ref.schema}.${ref.name}` : ref.name);
const findTable = (state, ref) => state.tables.get(refKey(state, ref));
const sameName = (state, a, b) => (state.exact ? a === b : a.toLowerCase() === b.toLowerCase());

// PostgreSQL's default names of constraints and indexes (makeObjectName): `users_pkey`,
// `posts_author_id_fkey`, `users_email_key`, `users_email_idx`, truncated to 63 characters
function objectName(table, columns, label) {
    const name1 = table;
    const name2 = columns.length > 0 ? columns.join('_') : null;
    let name1chars = name1.length;
    let name2chars = name2 ? name2.length : 0;
    const available = MAX_NAME - (name2 ? 1 : 0) - (label ? label.length + 1 : 0);
    while (name1chars + name2chars > available) {
        if (name1chars > name2chars) {
            name1chars--;
        } else {
            name2chars--;
        }
    }
    return `${name1.slice(0, name1chars)}${name2 ? `_${name2.slice(0, name2chars)}` : ''}${label ? `_${label}` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// Tables

function createTable(ref, origin, source) {
    return {
        ref,
        columns: [],
        primaryKey: null,
        // Unique constraints and indexes, in the order of the code: { name, named, items: [{ column } |
        // { expression }], type: 'index' | 'unique' | 'fulltext' | 'spatial', partial, constraint }
        indexes: [],
        // { name, columns, target: ref, references, onDelete, onUpdate }
        foreignKeys: [],
        source,
        origin,
        // The statements that changed the table after it was created (git status)
        changes: [],
    };
}

const columnOf = (state, table, name) => table.columns.find(column => sameName(state, column.name, name));
const itemColumns = (index) => index.items.map(item => item.column || item.expression);
const plainColumns = (index) => (index.items.every(item => item.column) ? index.items.map(item => item.column) : null);
const sameColumns = (state, a, b) => a.length === b.length && a.every(name => b.some(other => sameName(state, other, name)));

// Adds a column at its place (MySQL FIRST / AFTER), or replaces the one of the same name
function placeColumn(state, table, column, position) {
    const existing = table.columns.findIndex(other => sameName(state, other.name, column.name));
    if (existing !== -1) {
        table.columns.splice(existing, 1);
    }
    let at = table.columns.length;
    if (position && position.first) {
        at = 0;
    } else if (position && position.after) {
        const after = table.columns.findIndex(other => sameName(state, other.name, position.after));
        at = after === -1 ? at : after + 1;
    } else if (existing !== -1) {
        at = existing;
    }
    table.columns.splice(at, 0, column);
}

// Drops a column: PostgreSQL and SQLite drop the indexes and constraints built on it, MySQL removes
// it from them (an index left without columns is dropped). Foreign keys of other tables that
// reference it are dropped too (PostgreSQL needs CASCADE, which the migration then has).
function dropColumn(state, table, name) {
    table.columns = table.columns.filter(column => !sameName(state, column.name, name));
    const uses = (names) => names.some(other => sameName(state, other, name));
    const shrink = state.dialect === 'mysql';
    if (table.primaryKey && uses(table.primaryKey.columns)) {
        table.primaryKey.columns = table.primaryKey.columns.filter(other => !sameName(state, other, name));
        if (!shrink || table.primaryKey.columns.length === 0) {
            table.primaryKey = null;
        }
    }
    table.indexes = table.indexes.filter(index => {
        if (!uses(index.items.filter(item => item.column).map(item => item.column))) {
            return true;
        }
        if (!shrink) {
            return false;
        }
        index.items = index.items.filter(item => !item.column || !sameName(state, item.column, name));
        return index.items.length > 0;
    });
    table.foreignKeys = table.foreignKeys.filter(fk => !uses(fk.columns));
    for (const other of state.tables.values()) {
        other.foreignKeys = other.foreignKeys.filter(fk => !(refKey(state, fk.target) === refKey(state, table.ref) && uses(fk.references)));
    }
}

function renameColumn(state, table, from, to) {
    const column = columnOf(state, table, from);
    if (!column) {
        return false;
    }
    column.name = to;
    const rename = (names) => names.map(name => (sameName(state, name, from) ? to : name));
    if (table.primaryKey) {
        table.primaryKey.columns = rename(table.primaryKey.columns);
    }
    for (const index of table.indexes) {
        index.items = index.items.map(item => (item.column && sameName(state, item.column, from) ? { column: to } : item));
    }
    for (const fk of table.foreignKeys) {
        fk.columns = rename(fk.columns);
    }
    for (const other of state.tables.values()) {
        for (const fk of other.foreignKeys) {
            if (refKey(state, fk.target) === refKey(state, table.ref)) {
                fk.references = rename(fk.references);
            }
        }
    }
    return true;
}

// Renames or moves a table: the foreign keys that reference it follow it
function moveTable(state, table, ref) {
    const oldKey = refKey(state, table.ref);
    state.tables.delete(oldKey);
    const replaced = findTable(state, ref);
    if (replaced && replaced !== table) {
        state.tables.delete(refKey(state, ref));
    }
    for (const other of state.tables.values()) {
        for (const fk of other.foreignKeys) {
            if (refKey(state, fk.target) === oldKey) {
                fk.target = ref;
            }
        }
    }
    for (const fk of table.foreignKeys) {
        if (refKey(state, fk.target) === oldKey) {
            fk.target = ref;
        }
    }
    table.ref = ref;
    state.tables.set(refKey(state, ref), table);
}

// Drops a table; with CASCADE (PostgreSQL), the foreign keys that reference it are dropped too
function dropTable(state, table, cascade) {
    state.tables.delete(refKey(state, table.ref));
    if (cascade) {
        for (const other of state.tables.values()) {
            other.foreignKeys = other.foreignKeys.filter(fk => refKey(state, fk.target) !== refKey(state, table.ref));
        }
    }
}

// Sets the primary key of a table: its columns are NOT NULL (on SQLite, only for an INTEGER PRIMARY
// KEY, or in a WITHOUT ROWID table)
function setPrimaryKey(state, table, name, columns) {
    table.primaryKey = { name: name || (state.dialect === 'mysql' ? 'PRIMARY' : objectName(table.ref.name, [], 'pkey')), columns: [...columns] };
    for (const columnName of columns) {
        const column = columnOf(state, table, columnName);
        if (column && state.dialect !== 'sqlite') {
            column.notNull = true;
        }
    }
}

// The default name of an index or a unique constraint, as the database gives it
function indexName(state, table, items, label) {
    const names = items.map(item => item.column || (/^[\w$]+/.exec(item.expression) || ['expr'])[0]);
    if (state.dialect === 'mysql') {
        let name = names[0] || 'index';
        for (let n = 2; table.indexes.some(index => index.name === name); n++) {
            name = `${names[0]}_${n}`;
        }
        return name;
    }
    return objectName(table.ref.name, names, label);
}

function addIndex(state, table, index) {
    if (index.name && table.indexes.some(other => other.name === index.name)) {
        table.indexes = table.indexes.filter(other => other.name !== index.name);
    }
    table.indexes.push(index);
}

// Drops the constraint `name` of a table: its primary key, a foreign key or a unique constraint.
// Returns whether one was found (check constraints are not kept)
function dropConstraint(state, table, name) {
    if (table.primaryKey && sameName(state, table.primaryKey.name, name)) {
        table.primaryKey = null;
        return true;
    }
    const fks = table.foreignKeys.length;
    table.foreignKeys = table.foreignKeys.filter(fk => !sameName(state, fk.name, name));
    if (table.foreignKeys.length !== fks) {
        return true;
    }
    const indexes = table.indexes.length;
    table.indexes = table.indexes.filter(index => !(index.name && sameName(state, index.name, name)));
    return table.indexes.length !== indexes;
}

// ---------------------------------------------------------------------------------------------
// Column definitions

// Words that end the type of a column (its constraints, MySQL's position...)
const TYPE_END = new Set(['CONSTRAINT', 'NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'COLLATE', 'GENERATED', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'COMMENT', 'ON', 'AS', 'CHARSET', 'VISIBLE', 'INVISIBLE', 'STORAGE', 'COLUMN_FORMAT', 'SRID', 'KEY', 'IDENTITY', 'COMPRESSION', 'ENGINE_ATTRIBUTE', 'SECONDARY_ENGINE_ATTRIBUTE', 'FIRST', 'AFTER', 'USING', 'DEFERRABLE', 'INITIALLY', 'MATCH']);
// Words that end a DEFAULT expression
const DEFAULT_END = new Set(['CONSTRAINT', 'NOT', 'NULL', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'COLLATE', 'GENERATED', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'COMMENT', 'ON', 'VISIBLE', 'INVISIBLE', 'STORAGE', 'COLUMN_FORMAT', 'SRID', 'KEY', 'IDENTITY', 'COMPRESSION', 'FIRST', 'AFTER', 'DEFAULT', 'CHARACTER', 'CHARSET', 'AS']);
// Types whose argument is a length, or a precision and a scale
const LENGTH_TYPE = /(?:^|\s)(?:n?var)?char(?:acter)?(?:\s+varying)?$|(?:^|\s)(?:var)?binary$|(?:^|\s)bit(?:\s+varying)?$|^(?:varbit|nvarchar|nchar|varchar2|nvarchar2|raw|text)$/;
const DECIMAL_TYPE = /^(?:decimal|numeric|dec|fixed|number|float|double|double precision|real)$/;
const NUMERIC_TYPE = /^(?:tinyint|smallint|mediumint|int|integer|bigint|int2|int4|int8|decimal|numeric|dec|fixed|number|float|float4|float8|double|double precision|real|money|smallserial|serial|bigserial|serial2|serial4|serial8|bool|boolean|bit|year)$/;
const SERIAL_TYPE = /^(?:smallserial|serial|bigserial|serial2|serial4|serial8)$/;

// The type of a column from the cursor up to `end`: { name, base, args, values, unsigned, enumKey }.
// name: as written, lower case (`character varying`, `timestamp with time zone`, `text[]`), the
// quoted parts kept as written, without the arguments and the default schema (`citext` for
// `public.citext`); an enum type of the schema gives its name, and its key in state.types.
function readType(ctx, c, end) {
    const { state } = ctx;
    let stop = findWord(c.tokens, c.i, end, TYPE_END);
    // MySQL: varchar(20) CHARACTER SET utf8mb4 (not PostgreSQL's character varying)
    for (let k = c.i + 1; k + 1 < stop; k++) {
        if (isWord(c.tokens[k], 'CHARACTER') && isWord(c.tokens[k + 1], 'SET')) {
            stop = k;
            break;
        }
    }
    const words = [];
    const parts = [];
    let args = null;
    let dims = 0;
    let unsigned = false;
    let quoted = false;
    for (let k = c.i; k < stop; k++) {
        const t = c.tokens[k];
        if (t.type === 'word' && (t.upper === 'UNSIGNED' || t.upper === 'SIGNED' || t.upper === 'ZEROFILL' || (t.upper === 'BINARY' && words.length > 0))) {
            unsigned = unsigned || t.upper === 'UNSIGNED';
        } else if (t.type === 'word' && t.upper === 'ARRAY') {
            dims++;
            if (isPunct(c.tokens[k + 1], '[')) {
                k = closing(c.tokens, k + 1, stop);
            }
        } else if (isName(t)) {
            quoted = quoted || t.type === 'ident';
            parts.push({ value: t.value, quoted: t.type === 'ident' });
            words.push(t.type === 'ident' ? t.value : t.value.toLowerCase());
        } else if (isPunct(t, '.')) {
            words.push('.');
        } else if (isPunct(t, '(')) {
            const close = closing(c.tokens, k, stop);
            if (args === null) {
                args = splitCommas(c.tokens, k + 1, close).map(([from, to]) => c.tokens.slice(from, to));
            }
            k = close;
        } else if (isPunct(t, '[')) {
            dims++;
            k = closing(c.tokens, k, stop);
        }
    }
    c.i = stop;
    let name = words.join(' ').replace(/ \. /g, '.');
    // Schema-qualified: the default schema and pg_catalog are left out
    const qualified = /^(.*)\.([^.]+)$/.exec(name);
    if (qualified && ['public', 'pg_catalog'].includes(qualified[1].toLowerCase())) {
        name = qualified[2];
    }
    const base = quoted ? name : name.toLowerCase();
    const type = { name, base, args: args || [], values: null, unsigned, enumKey: null };
    if ((base === 'enum' || base === 'set') && args) {
        type.values = args.filter(arg => arg.length === 1 && arg[0].type === 'string').map(arg => arg[0].value);
    } else if ((parts.length === 1 || (parts.length === 2 && words.includes('.'))) && state.types.size > 0) {
        // An enum type created by CREATE TYPE ... AS ENUM
        const ref = typeRef(state, parts);
        const key = refKey(state, ref);
        if (state.types.has(key)) {
            type.enumKey = key;
            type.name = display(state, ref);
        }
    }
    if (dims > 0) {
        type.name += '[]'.repeat(dims);
    }
    return type;
}

// The details that a type tells: length, precision and scale, unsigned, enum values
function typeDetails(type) {
    const details = {};
    const numbers = type.args.map(arg => (arg.length === 1 && arg[0].type === 'number' && /^\d+$/.test(arg[0].value) ? Number(arg[0].value) : undefined));
    if (LENGTH_TYPE.test(type.base) && numbers.length === 1 && numbers[0] !== undefined) {
        details.length = numbers[0];
    }
    if (DECIMAL_TYPE.test(type.base) && numbers.length >= 1 && numbers[0] !== undefined) {
        details.precision = numbers[0];
        if (numbers[1] !== undefined) {
            details.scale = numbers[1];
        }
    }
    if (type.unsigned) {
        details.unsigned = true;
    }
    if (type.values) {
        details.values = type.values;
    }
    return details;
}

const isNumericType = (type) => NUMERIC_TYPE.test(type.base) || /int$/.test(type.base);

// The default of a column from its expression tokens [from, to): { default } (a literal: string,
// number, boolean or null), { defaultRaw } (an SQL expression, as written), or { autoIncrement }
// for nextval() (a serial column of a dump)
function defaultOf(ctx, tokens, from, to, type) {
    let start = from;
    let end = to;
    // Parentheses around the whole expression (MySQL 8 `DEFAULT ('a')`), a few levels at most
    for (let depth = 0; depth < MAX_DEPTH && end - start >= 2 && isPunct(tokens[start], '(') && closing(tokens, start, end) === end - 1; depth++) {
        start++;
        end--;
    }
    const raw = () => ({ defaultRaw: textOf(ctx.text, tokens, from, to) });
    if (isWord(tokens[start], 'NEXTVAL') && isPunct(tokens[start + 1], '(')) {
        return { autoIncrement: true };
    }
    // A literal: [sign] value, with an optional charset introducer (_utf8mb4'x'), then casts (::text)
    let k = start;
    let sign = '';
    if ((isPunct(tokens[k], '-') || isPunct(tokens[k], '+')) && tokens[k + 1] && tokens[k + 1].type === 'number') {
        sign = tokens[k].value === '-' ? '-' : '';
        k++;
    }
    if (isWord(tokens[k]) && /^_\w+$/.test(tokens[k].value) && tokens[k + 1] && tokens[k + 1].type === 'string') {
        k++;
    }
    let literal = tokens[k];
    k++;
    if (isPunct(literal, '(') && tokens[k] && isPunct(tokens[k + 1], ')') && ['string', 'number'].includes(tokens[k].type)) {
        // (0)::numeric
        literal = tokens[k];
        k += 2;
    }
    // Casts: `::type` up to the end, the type made of names, dots, brackets and arguments
    while (k < end && isPunct(tokens[k], '::')) {
        k++;
        let depth = 0;
        while (k < end && !(depth === 0 && isPunct(tokens[k], '::'))) {
            const t = tokens[k];
            if (isPunct(t, '(') || isPunct(t, '[')) {
                depth++;
            } else if (isPunct(t, ')') || isPunct(t, ']')) {
                depth--;
            } else if (!(isName(t) || isPunct(t, '.') || (depth > 0 && (t.type === 'number' || isPunct(t, ','))))) {
                return raw();
            }
            k++;
        }
    }
    if (k !== end || !literal) {
        return raw();
    }
    if (literal.type === 'string' && !literal.prefix) {
        const value = literal.value;
        if (isNumericType(type) && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) {
            const number = Number(value);
            return /^[+-]?\d+$/.test(value.trim()) && !Number.isSafeInteger(number) ? { defaultRaw: value.trim() } : { default: number };
        }
        return { default: value };
    }
    if (literal.type === 'string' && (literal.prefix === 'n' || literal.prefix === 'e')) {
        return { default: literal.value };
    }
    if (literal.type === 'number' && /^\d/.test(literal.value) && !/^0[xX]/.test(literal.value)) {
        const number = Number(sign + literal.value);
        return /^\d+$/.test(literal.value) && !Number.isSafeInteger(number) ? { defaultRaw: sign + literal.value } : { default: number };
    }
    if (isWord(literal, 'TRUE', 'FALSE')) {
        return { default: literal.upper === 'TRUE' };
    }
    if (isWord(literal, 'NULL')) {
        return { default: null };
    }
    return raw();
}

// The referential action at the cursor (CASCADE, SET NULL...), lower case
function readAction(c) {
    if (accept(c, 'CASCADE')) {
        return 'cascade';
    }
    if (accept(c, 'RESTRICT')) {
        return 'restrict';
    }
    if (accept(c, 'NO', 'ACTION')) {
        return 'no action';
    }
    for (const action of ['NULL', 'DEFAULT']) {
        if (accept(c, 'SET', action)) {
            // PostgreSQL 15: SET NULL (columns)
            skipGroup(c);
            return `set ${action.toLowerCase()}`;
        }
    }
    return undefined;
}

// The column names of a list in parentheses at the cursor ((a, b)), or null
function readColumnList(ctx, c) {
    if (!isPunct(peek(c), '(')) {
        return null;
    }
    const close = closing(c.tokens, c.i, c.end);
    const names = splitCommas(c.tokens, c.i + 1, close).map(([from]) => (isName(c.tokens[from]) ? fold(ctx.state, { value: c.tokens[from].value, quoted: c.tokens[from].type === 'ident' }) : null)).filter(name => name !== null);
    c.i = Math.min(close + 1, c.end);
    return names;
}

// REFERENCES table [(columns)] [MATCH ...] [ON DELETE ...] [ON UPDATE ...] [DEFERRABLE...], the
// cursor after REFERENCES: { target, references, onDelete, onUpdate }, or null. The table is looked
// up when the key is declared (PostgreSQL keeps the table, not its name).
function readReferences(ctx, c) {
    const parts = readName(c);
    if (!parts) {
        return null;
    }
    const target = tableRef(ctx.state, parts);
    const references = readColumnList(ctx, c) || [];
    const fk = { target, references, onDelete: undefined, onUpdate: undefined };
    for (;;) {
        if (accept(c, 'MATCH')) {
            c.i++;
        } else if (accept(c, 'ON', 'DELETE')) {
            fk.onDelete = readAction(c);
        } else if (accept(c, 'ON', 'UPDATE')) {
            fk.onUpdate = readAction(c);
        } else if (accept(c, 'NOT', 'DEFERRABLE') || accept(c, 'DEFERRABLE') || accept(c, 'NOT', 'VALID') || accept(c, 'NOT', 'ENFORCED') || accept(c, 'ENFORCED')) {
            continue;
        } else if (accept(c, 'INITIALLY')) {
            c.i++;
        } else {
            return fk;
        }
    }
}

// A column definition from the cursor up to `end` (name, type, constraints): { column, primary,
// unique, references, position }, or null when it has no name
function readColumn(ctx, c, end, origin) {
    const { state } = ctx;
    const { tokens } = c;
    const nameToken = peek(c);
    if (!isName(nameToken)) {
        return null;
    }
    c.i++;
    const column = {
        name: fold(state, { value: nameToken.value, quoted: nameToken.type === 'ident' }),
        type: '',
        typeInfo: null,
        enumKey: null,
        notNull: false,
        details: {},
        origin,
        declaredIn: origin ? origin.path : null,
        changes: [],
    };
    const type = readType(ctx, c, end);
    applyType(column, type);
    const result = { column, primary: false, unique: null, references: null, position: null, primaryName: null };
    let constraintName = null;
    while (c.i < end) {
        const t = tokens[c.i];
        if (accept(c, 'CONSTRAINT')) {
            const parts = readName(c);
            constraintName = parts ? fold(state, parts[parts.length - 1]) : null;
            continue;
        }
        if (accept(c, 'NOT', 'NULL')) {
            column.notNull = true;
        } else if (accept(c, 'NULL')) {
            column.notNull = false;
        } else if (accept(c, 'DEFAULT')) {
            const stop = expressionEnd(tokens, c.i, end, DEFAULT_END);
            applyDefault(column, defaultOf(ctx, tokens, c.i, stop, column.typeInfo));
            c.i = stop;
        } else if (accept(c, 'PRIMARY', 'KEY') || (state.dialect === 'mysql' && accept(c, 'KEY'))) {
            result.primary = true;
            result.primaryName = constraintName;
            accept(c, 'ASC') || accept(c, 'DESC');
        } else if (accept(c, 'UNIQUE')) {
            accept(c, 'KEY') || accept(c, 'INDEX');
            accept(c, 'NULLS', 'NOT', 'DISTINCT') || accept(c, 'NULLS', 'DISTINCT');
            result.unique = { name: constraintName };
        } else if (accept(c, 'REFERENCES')) {
            const fk = readReferences(ctx, c);
            if (fk) {
                result.references = { ...fk, name: constraintName };
            }
        } else if (accept(c, 'CHECK')) {
            skipGroup(c);
            accept(c, 'NO', 'INHERIT');
        } else if (accept(c, 'COLLATE')) {
            readName(c) || c.i++;
        } else if (accept(c, 'GENERATED')) {
            if (accept(c, 'ALWAYS', 'AS', 'IDENTITY') || accept(c, 'BY', 'DEFAULT', 'AS', 'IDENTITY')) {
                column.notNull = true;
                column.details.autoIncrement = true;
                skipGroup(c);
            } else {
                accept(c, 'ALWAYS');
                accept(c, 'AS');
                skipGroup(c);
                accept(c, 'STORED') || accept(c, 'VIRTUAL');
            }
        } else if (isWord(t, 'AS') && isPunct(tokens[c.i + 1], '(')) {
            // MySQL and SQLite generated columns: AS (expression) [STORED | VIRTUAL]
            c.i++;
            skipGroup(c);
            accept(c, 'STORED') || accept(c, 'VIRTUAL') || accept(c, 'PERSISTENT');
        } else if (accept(c, 'AUTO_INCREMENT') || accept(c, 'AUTOINCREMENT')) {
            column.details.autoIncrement = true;
        } else if (accept(c, 'IDENTITY')) {
            column.details.autoIncrement = true;
            skipGroup(c);
        } else if (accept(c, 'COMMENT')) {
            const comment = peek(c);
            if (comment && comment.type === 'string') {
                column.details.comment = comment.value;
                c.i++;
            }
        } else if (accept(c, 'ON', 'UPDATE')) {
            const stop = expressionEnd(tokens, c.i, end, DEFAULT_END);
            if (isWord(tokens[c.i], 'CURRENT_TIMESTAMP', 'NOW', 'LOCALTIMESTAMP', 'LOCALTIME')) {
                column.details.onUpdateCurrent = true;
            }
            c.i = stop;
        } else if (accept(c, 'ON', 'CONFLICT')) {
            c.i++;
        } else if (accept(c, 'CHARACTER', 'SET') || accept(c, 'CHARSET') || accept(c, 'STORAGE') || accept(c, 'COLUMN_FORMAT') || accept(c, 'COMPRESSION') || accept(c, 'SRID')) {
            c.i++;
        } else if (accept(c, 'ENGINE_ATTRIBUTE') || accept(c, 'SECONDARY_ENGINE_ATTRIBUTE')) {
            acceptPunct(c, '=');
            c.i++;
        } else if (accept(c, 'FIRST')) {
            result.position = { first: true };
        } else if (accept(c, 'AFTER')) {
            const after = peek(c);
            if (isName(after)) {
                result.position = { after: fold(state, { value: after.value, quoted: after.type === 'ident' }) };
                c.i++;
            }
        } else {
            c.i++;
        }
        constraintName = isWord(t, 'CONSTRAINT') ? constraintName : null;
    }
    if (SERIAL_TYPE.test(column.typeInfo.base) || (state.dialect === 'mysql' && column.typeInfo.base === 'serial')) {
        column.notNull = true;
        column.details.autoIncrement = true;
        if (state.dialect === 'mysql') {
            column.details.unsigned = true;
            result.unique = result.unique || { name: null };
        }
    }
    return result;
}

// The type of a column: its name and the details it tells (the other details are kept)
function applyType(column, type) {
    column.type = type.name;
    column.typeInfo = type;
    column.enumKey = type.enumKey;
    for (const key of ['length', 'precision', 'scale', 'unsigned', 'values']) {
        delete column.details[key];
    }
    Object.assign(column.details, typeDetails(type));
}

function applyDefault(column, value) {
    delete column.details.default;
    delete column.details.defaultRaw;
    if ('autoIncrement' in value) {
        column.details.autoIncrement = true;
        return;
    }
    Object.assign(column.details, value);
}

// One item of an index, tokens [from, to): { column } or { expression }, an expression as written
// (without the parentheses around it); the operator class, the order, the collation and MySQL's
// prefix length (name(10)) are left out
function indexItem(ctx, tokens, from, to) {
    const first = tokens[from];
    const second = tokens[from + 1];
    const columnName = (token) => ({ column: fold(ctx.state, { value: token.value, quoted: token.type === 'ident' }) });
    if (isPunct(first, '(')) {
        return { expression: textOf(ctx.text, tokens, from + 1, closing(tokens, from, to)) };
    }
    if (isName(first) && isPunct(second, '(')) {
        const prefix = tokens[from + 2] && tokens[from + 2].type === 'number' && isPunct(tokens[from + 3], ')');
        return prefix ? columnName(first) : { expression: textOf(ctx.text, tokens, from, Math.min(closing(tokens, from + 1, to) + 1, to)) };
    }
    return isName(first) ? columnName(first) : { expression: textOf(ctx.text, tokens, from, to) };
}

// The items of an index or a key at the cursor ('(' a, lower(b), c DESC ')'): [{ column } |
// { expression }]
function readIndexItems(ctx, c) {
    if (!isPunct(peek(c), '(')) {
        return null;
    }
    const close = closing(c.tokens, c.i, c.end);
    const items = splitCommas(c.tokens, c.i + 1, close).map(([from, to]) => indexItem(ctx, c.tokens, from, to));
    c.i = Math.min(close + 1, c.end);
    return items;
}

// Whether the item at the cursor of a CREATE TABLE is a constraint or an index, not a column (a
// column may be named key, index or fulltext on PostgreSQL)
function isConstraintItem(c) {
    const t = peek(c);
    if (isWord(t, 'CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK')) {
        return true;
    }
    if (isWord(t, 'LIKE')) {
        return isName(peek(c, 1));
    }
    if (isWord(t, 'EXCLUDE')) {
        return isWord(peek(c, 1), 'USING') || isPunct(peek(c, 1), '(');
    }
    if (isWord(t, 'KEY', 'INDEX', 'FULLTEXT', 'SPATIAL')) {
        // [FULLTEXT | SPATIAL] KEY [name] [USING method] (columns)
        let k = 1;
        if (isWord(t, 'FULLTEXT', 'SPATIAL') && isWord(peek(c, k), 'KEY', 'INDEX')) {
            k++;
        }
        if (isName(peek(c, k)) && !isWord(peek(c, k), 'USING')) {
            k++;
        }
        if (isWord(peek(c, k), 'USING')) {
            k += 2;
        }
        return isPunct(peek(c, k), '(') && (isName(peek(c, k + 1)) || isPunct(peek(c, k + 1), '('));
    }
    return false;
}

// A table constraint or index (in a CREATE TABLE, or after ALTER TABLE ... ADD) from the cursor up
// to `end`. Returns false when it is not understood.
function applyConstraint(ctx, table, c, end, origin) {
    const { state } = ctx;
    let name = null;
    if (accept(c, 'CONSTRAINT')) {
        const parts = readName(c);
        name = parts ? fold(state, parts[parts.length - 1]) : null;
    }
    if (accept(c, 'PRIMARY', 'KEY')) {
        if (accept(c, 'USING', 'INDEX')) {
            // PostgreSQL: PRIMARY KEY USING INDEX index: the index becomes the key
            return promoteIndex(ctx, table, c, name, 'primary');
        }
        if (isName(peek(c)) && !isPunct(peek(c), '(')) {
            accept(c, 'USING') && c.i++;
        }
        const items = readIndexItems(ctx, c);
        if (!items) {
            return false;
        }
        setPrimaryKey(state, table, name, items.map(item => item.column || item.expression));
        return true;
    }
    if (accept(c, 'UNIQUE')) {
        if (accept(c, 'USING', 'INDEX')) {
            return promoteIndex(ctx, table, c, name, 'unique');
        }
        accept(c, 'KEY') || accept(c, 'INDEX');
        let indexNameToken = null;
        if (isName(peek(c)) && !isWord(peek(c), 'USING', 'NULLS')) {
            indexNameToken = readName(c);
        }
        accept(c, 'USING') && c.i++;
        accept(c, 'NULLS', 'NOT', 'DISTINCT') || accept(c, 'NULLS', 'DISTINCT');
        const items = readIndexItems(ctx, c);
        if (!items) {
            return false;
        }
        const given = name || (indexNameToken ? fold(state, indexNameToken[indexNameToken.length - 1]) : null);
        addIndex(state, table, { name: given || indexName(state, table, items, 'key'), named: Boolean(given), items, type: 'unique', partial: false, constraint: true });
        return true;
    }
    if (accept(c, 'FOREIGN', 'KEY')) {
        if (isName(peek(c))) {
            const parts = readName(c);
            name = name || fold(state, parts[parts.length - 1]);
        }
        const columns = readColumnList(ctx, c);
        if (!columns || !accept(c, 'REFERENCES')) {
            return false;
        }
        const fk = readReferences(ctx, c);
        if (!fk) {
            return false;
        }
        addForeignKey(state, table, { ...fk, name, columns });
        return true;
    }
    if (accept(c, 'CHECK')) {
        c.i = end;
        return true;
    }
    if (accept(c, 'EXCLUDE')) {
        // PostgreSQL: EXCLUDE [USING gist] (element WITH operator, ...) [WHERE ...]: an index
        if (accept(c, 'USING')) {
            c.i++;
        }
        if (!isPunct(peek(c), '(')) {
            return false;
        }
        const close = closing(c.tokens, c.i, end);
        const items = splitCommas(c.tokens, c.i + 1, close).map(([from, to]) => indexItem(ctx, c.tokens, from, findWord(c.tokens, from, to, new Set(['WITH']))));
        const partial = findWord(c.tokens, close, end, new Set(['WHERE'])) < end;
        addIndex(state, table, { name: name || indexName(state, table, items, 'excl'), named: Boolean(name), items, type: 'index', partial, constraint: true });
        c.i = end;
        return true;
    }
    if (isWord(peek(c), 'KEY', 'INDEX', 'FULLTEXT', 'SPATIAL')) {
        let type = 'index';
        if (accept(c, 'FULLTEXT')) {
            type = 'fulltext';
        } else if (accept(c, 'SPATIAL')) {
            type = 'spatial';
        }
        accept(c, 'KEY') || accept(c, 'INDEX');
        let parts = null;
        if (isName(peek(c)) && !isWord(peek(c), 'USING')) {
            parts = readName(c);
        }
        accept(c, 'USING') && c.i++;
        const items = readIndexItems(ctx, c);
        if (!items) {
            return false;
        }
        const given = parts ? fold(state, parts[parts.length - 1]) : null;
        addIndex(state, table, { name: given || indexName(state, table, items, 'idx'), named: Boolean(given), items, type, partial: false, constraint: false });
        return true;
    }
    if (accept(c, 'LIKE')) {
        // PostgreSQL: (LIKE source [INCLUDING ...]): the columns of another table
        const parts = readName(c);
        const source = parts ? findTable(state, tableRef(state, parts)) : null;
        if (!source) {
            return false;
        }
        // MySQL copies everything but the foreign keys; PostgreSQL the columns, and what INCLUDING adds
        const options = c.tokens.slice(c.i, end).filter(t => t.type === 'word').map(t => t.upper);
        const including = (what) => state.dialect === 'mysql' || (options.includes('INCLUDING') && (options.includes('ALL') || options.includes(what)));
        copyColumns(source, table, origin, { defaults: including('DEFAULTS'), indexes: including('INDEXES') || including('CONSTRAINTS') });
        c.i = end;
        return true;
    }
    return false;
}

// Copies the columns of a table (CREATE TABLE ... LIKE, INHERITS)
function copyColumns(source, table, origin, { defaults = false, indexes = false } = {}) {
    for (const column of source.columns) {
        const details = { ...column.details };
        if (!defaults) {
            delete details.default;
            delete details.defaultRaw;
            delete details.autoIncrement;
        }
        table.columns.push({ ...column, details, origin, declaredIn: origin.path, changes: [], inCreate: true });
    }
    if (indexes) {
        if (source.primaryKey) {
            table.primaryKey = { name: objectName(table.ref.name, [], 'pkey'), columns: [...source.primaryKey.columns] };
        }
        table.indexes.push(...source.indexes.map(index => ({ ...index, items: index.items.map(item => ({ ...item })), named: false })));
    }
}

// PRIMARY KEY USING INDEX / UNIQUE USING INDEX (PostgreSQL, supabase db diff): the index becomes
// the constraint, under the name of the constraint
function promoteIndex(ctx, table, c, name, kind) {
    const { state } = ctx;
    const parts = readName(c);
    if (!parts) {
        return false;
    }
    const indexKey = fold(state, parts[parts.length - 1]);
    const index = table.indexes.find(other => other.name && sameName(state, other.name, indexKey));
    if (!index) {
        return false;
    }
    if (kind === 'primary') {
        table.indexes = table.indexes.filter(other => other !== index);
        setPrimaryKey(state, table, name || index.name, itemColumns(index));
    } else {
        index.name = name || index.name;
        index.named = true;
        index.constraint = true;
        index.type = 'unique';
    }
    return true;
}

function addForeignKey(state, table, fk) {
    const name = fk.name || (state.dialect === 'mysql'
        ? `${table.ref.name}_ibfk_${table.foreignKeys.length + 1}`
        : objectName(table.ref.name, fk.columns, 'fkey'));
    table.foreignKeys = table.foreignKeys.filter(other => !(other.name && sameName(state, other.name, name)));
    table.foreignKeys.push({ ...fk, name });
}

// Applies the constraints written on a column: its primary key, unique, references
function applyColumnConstraints(ctx, table, read) {
    const { state } = ctx;
    const { column } = read;
    if (read.primary) {
        setPrimaryKey(state, table, read.primaryName, [column.name]);
        if (state.dialect === 'sqlite' && (column.typeInfo.base === 'integer' || table.withoutRowid)) {
            column.notNull = true;
        }
    }
    if (read.unique) {
        addIndex(state, table, { name: read.unique.name || indexName(state, table, [{ column: column.name }], 'key'), named: Boolean(read.unique.name), items: [{ column: column.name }], type: 'unique', partial: false, constraint: true });
    }
    if (read.references) {
        addForeignKey(state, table, { ...read.references, columns: [column.name] });
    }
}

// ---------------------------------------------------------------------------------------------
// Statements

// The range of lines of tokens [from, to) of the file of ctx: { path, first, last }
const rangeOf = (ctx, tokens, from, to) => ({ path: ctx.file.path, first: ctx.lineAt(tokens[from].start), last: ctx.lineAt(tokens[Math.max(from, to - 1)].end - 1) });
const warnAt = (ctx, token, message) => ctx.state.warnings.push(`${ctx.file.rel}:${ctx.lineAt(token.start)}: ${message}`);

// A change of a column by a later statement: in another file than the one that declares it, the
// statement becomes its origin (its source and git status: the statement that changed or renamed
// it last, as for Laravel's migrations); in the file that declares it (a dump, a migration that
// creates then alters a table), its line is only added to its git status
function touchColumn(ctx, column, range) {
    if (column.declaredIn === range.path) {
        column.changes.push(range);
    } else {
        column.origin = range;
        column.changes = [];
        column.inCreate = false;
    }
}

const touchTable = (table, range) => {
    table.changes.push(range);
};

// Applies one statement
function applyStatement(ctx, tokens) {
    const first = tokens[0];
    if (!isWord(first)) {
        return;
    }
    const c = cursorOf(tokens, 1);
    switch (first.upper) {
        case 'CREATE':
            return createStatement(ctx, c);
        case 'ALTER':
            return alterStatement(ctx, c);
        case 'DROP':
            return dropStatement(ctx, c);
        case 'RENAME':
            return renameStatement(ctx, c);
        case 'COMMENT':
            return commentStatement(ctx, c);
        case 'DO':
            return doStatement(ctx, c);
        case 'SET':
            return setStatement(ctx, c);
        case 'SELECT':
            return selectStatement(ctx, c);
        case 'USE':
            if (isName(peek(c))) {
                ctx.state.database = peek(c).value;
            }
            return undefined;
        case 'INSERT':
        case 'REPLACE':
            return insertStatement(ctx, c);
        default:
            // Data, transactions, grants, PRAGMA, VACUUM...: no change of the tables
            return undefined;
    }
}

// The kinds of objects of CREATE: TABLE, INDEX and TYPE are read, the others passed over
const CREATE_KINDS = new Set(['TABLE', 'INDEX', 'TYPE', 'VIEW', 'FUNCTION', 'PROCEDURE', 'TRIGGER', 'EVENT', 'SEQUENCE', 'EXTENSION', 'SCHEMA', 'DATABASE', 'POLICY', 'ROLE', 'USER', 'GROUP', 'DOMAIN', 'AGGREGATE', 'OPERATOR', 'CAST', 'COLLATION', 'CONVERSION', 'PUBLICATION', 'SUBSCRIPTION', 'RULE', 'SERVER', 'STATISTICS', 'TABLESPACE', 'LANGUAGE', 'TRANSFORM', 'ACCESS', 'TEXT', 'MAPPING', 'LOGFILE']);

// CREATE [modifiers] kind ...: the modifiers before the kind (OR REPLACE, TEMPORARY, UNIQUE,
// ALGORITHM=..., DEFINER=...) are kept
function createStatement(ctx, c) {
    const { tokens } = c;
    const modifiers = new Set();
    let k = c.i;
    for (; k < c.end && k < c.i + 24 && !(isWord(tokens[k]) && CREATE_KINDS.has(tokens[k].upper)); k++) {
        if (isWord(tokens[k])) {
            modifiers.add(tokens[k].upper);
        }
    }
    const kind = tokens[k];
    if (k >= c.end || !isWord(kind) || !CREATE_KINDS.has(kind.upper)) {
        return;
    }
    c.i = k + 1;
    if (kind.upper === 'TABLE') {
        if (modifiers.has('TEMP') || modifiers.has('TEMPORARY') || modifiers.has('VIRTUAL') || modifiers.has('FOREIGN')) {
            // Temporary tables do not stay, virtual (SQLite FTS) and foreign tables are not tables of the database
            notTable(ctx, c);
            return;
        }
        createTableStatement(ctx, c, kind, modifiers.has('REPLACE'));
    } else if (kind.upper === 'INDEX') {
        createIndexStatement(ctx, c, kind, modifiers);
    } else if (kind.upper === 'TYPE') {
        createTypeStatement(ctx, c);
    } else if (kind.upper === 'VIEW' || kind.upper === 'SEQUENCE') {
        notTable(ctx, c);
    }
}

// A relation that is not drawn (a view, a materialized view, a sequence, a partition...): the
// statements on it (its indexes, its owner) are passed over without a warning
function notTable(ctx, c) {
    const { state } = ctx;
    accept(c, 'IF', 'NOT', 'EXISTS');
    const parts = readName(c);
    if (parts) {
        state.skipped.add(refKey(state, refOf(state, parts)));
    }
}

// CREATE TABLE [IF NOT EXISTS] name (columns and constraints) [options] | AS query | LIKE other |
// PARTITION OF parent
function createTableStatement(ctx, c, keyword, replace) {
    const { state } = ctx;
    const { tokens } = c;
    const ifNotExists = accept(c, 'IF', 'NOT', 'EXISTS');
    const parts = readName(c);
    if (!parts) {
        warnAt(ctx, keyword, `CREATE TABLE not understood, skipped: ${excerpt(textOf(ctx.text, tokens, 0, c.end))}`);
        return;
    }
    const ref = refOf(state, parts);
    const key = refKey(state, ref);
    if (state.skip(ref)) {
        state.skipped.add(key);
        return;
    }
    const existing = state.tables.get(key);
    if (existing && ifNotExists) {
        return;
    }
    const range = rangeOf(ctx, tokens, 0, c.end);
    const source = { file: ctx.file.rel, line: range.first };
    const table = createTable(ref, range, source);
    table.statementLines = linesOf(ctx, tokens, 0, c.end);
    if (accept(c, 'PARTITION', 'OF')) {
        // A partition of a partitioned table: the parent is drawn
        state.skipped.add(key);
        return;
    }
    if (accept(c, 'LIKE')) {
        // MySQL: CREATE TABLE a LIKE b: its columns and indexes
        const sourceParts = readName(c);
        const from = sourceParts ? findTable(state, tableRef(state, sourceParts)) : null;
        if (!from) {
            warnAt(ctx, keyword, `CREATE TABLE ${display(state, ref)} LIKE a table that no file creates, skipped.`);
            return;
        }
        copyColumns(from, table, range, { defaults: true, indexes: true });
        registerTable(ctx, table, existing, keyword, replace);
        return;
    }
    if (!isPunct(peek(c), '(')) {
        if (isWord(peek(c), 'AS') || isWord(peek(c), 'SELECT')) {
            warnAt(ctx, keyword, `CREATE TABLE ${display(state, ref)} AS ... skipped: its columns come from a query.`);
        } else if (isWord(peek(c), 'OF')) {
            warnAt(ctx, keyword, `CREATE TABLE ${display(state, ref)} OF ... skipped: its columns come from a type.`);
        } else {
            warnAt(ctx, keyword, `CREATE TABLE ${display(state, ref)} not understood, skipped: ${excerpt(textOf(ctx.text, tokens, 0, c.end))}`);
        }
        return;
    }
    const close = closing(tokens, c.i, c.end);
    // Table options after the columns: WITHOUT ROWID (SQLite), INHERITS (parents)
    const after = cursorOf(tokens, close + 1, c.end);
    while (after.i < after.end) {
        if (accept(after, 'WITHOUT', 'ROWID')) {
            table.withoutRowid = true;
        } else if (accept(after, 'INHERITS')) {
            if (isPunct(peek(after), '(')) {
                const end = closing(tokens, after.i, after.end);
                for (const [from, to] of splitCommas(tokens, after.i + 1, end)) {
                    const parent = findTable(state, tableRef(state, readName(cursorOf(tokens, from, to)) || [{ value: '', quoted: true }]));
                    if (parent) {
                        copyColumns(parent, table, range, { defaults: true });
                    }
                }
                after.i = end + 1;
            }
        } else if (accept(after, 'AS')) {
            warnAt(ctx, keyword, `CREATE TABLE ${display(state, ref)} AS ... skipped: its columns come from a query.`);
            return;
        } else {
            after.i++;
        }
    }
    const items = splitCommas(tokens, c.i + 1, close);
    const constraints = [];
    for (const [from, to] of items) {
        const item = cursorOf(tokens, from, to);
        const itemRange = rangeOf(ctx, tokens, from, to);
        if (isConstraintItem(item) && isWord(tokens[from], 'LIKE')) {
            // The columns of another table, at the place of LIKE
            if (!applyConstraint(ctx, table, item, to, itemRange)) {
                warnAt(ctx, tokens[from], `CREATE TABLE ${display(state, ref)}: LIKE a table that no file creates, skipped.`);
            }
            continue;
        }
        if (isConstraintItem(item)) {
            constraints.push([from, to, itemRange]);
            continue;
        }
        const read = readColumn(ctx, item, to, itemRange);
        if (!read) {
            warnAt(ctx, tokens[from], `CREATE TABLE ${display(state, ref)}: column not understood, skipped: ${excerpt(textOf(ctx.text, tokens, from, to))}`);
            continue;
        }
        read.column.inCreate = true;
        placeColumn(state, table, read.column, null);
        applyColumnConstraints(ctx, table, read);
    }
    // The table constraints, once every column is known (their columns become NOT NULL...)
    for (const [from, to, itemRange] of constraints) {
        if (!applyConstraint(ctx, table, cursorOf(tokens, from, to), to, itemRange)) {
            warnAt(ctx, tokens[from], `CREATE TABLE ${display(state, ref)}: constraint not understood, skipped: ${excerpt(textOf(ctx.text, tokens, from, to))}`);
        }
    }
    if (table.withoutRowid && table.primaryKey) {
        for (const name of table.primaryKey.columns) {
            const column = columnOf(state, table, name);
            if (column) {
                column.notNull = true;
            }
        }
    }
    if (state.dialect !== 'mysql') {
        // PostgreSQL and SQLite drop a unique constraint that repeats the primary key or another one
        // of the same statement (id uuid UNIQUE ... PRIMARY KEY (id)); MySQL creates both
        const seen = table.primaryKey ? [table.primaryKey.columns] : [];
        table.indexes = table.indexes.filter(index => {
            const columns = index.constraint && index.type === 'unique' ? plainColumns(index) : null;
            if (!columns) {
                return true;
            }
            if (seen.some(set => set.length === columns.length && set.every((name, k) => sameName(state, name, columns[k])))) {
                return false;
            }
            seen.push(columns);
            return true;
        });
    }
    registerTable(ctx, table, existing, keyword, replace);
}

function registerTable(ctx, table, existing, keyword, replace) {
    const { state } = ctx;
    const key = refKey(state, table.ref);
    if (existing) {
        if (!replace) {
            warnAt(ctx, keyword, `table ${display(state, table.ref)} is created again, its previous definition is replaced.`);
        }
        state.tables.delete(key);
    }
    state.skipped.delete(key);
    state.tables.set(key, table);
}

// The lines that hold the tokens [from, to) of a statement (a table added to a committed file has
// all of them new)
function linesOf(ctx, tokens, from, to) {
    const lines = new Set();
    for (let k = from; k < to; k++) {
        lines.add(ctx.lineAt(tokens[k].start));
    }
    return [...lines];
}

// CREATE [UNIQUE | FULLTEXT | SPATIAL] INDEX [CONCURRENTLY] [IF NOT EXISTS] [name] [USING method]
// ON [ONLY] table [USING method] (items) [INCLUDE (...)] [WHERE ...]
function createIndexStatement(ctx, c, keyword, modifiers) {
    const { state } = ctx;
    const { tokens } = c;
    accept(c, 'CONCURRENTLY');
    accept(c, 'IF', 'NOT', 'EXISTS');
    let nameParts = null;
    if (!isWord(peek(c), 'ON')) {
        nameParts = readName(c);
    }
    if (accept(c, 'USING')) {
        c.i++;
    }
    if (!accept(c, 'ON')) {
        warnAt(ctx, keyword, `CREATE INDEX not understood, skipped: ${excerpt(textOf(ctx.text, tokens, 0, c.end))}`);
        return;
    }
    accept(c, 'ONLY');
    const parts = readName(c);
    if (!parts) {
        warnAt(ctx, keyword, `CREATE INDEX not understood, skipped: ${excerpt(textOf(ctx.text, tokens, 0, c.end))}`);
        return;
    }
    // SQLite: the schema qualifies the index, not the table
    const tableParts = state.dialect === 'sqlite' && nameParts && nameParts.length > 1 && parts.length === 1 ? [nameParts[0], parts[0]] : parts;
    const ref = tableRef(state, tableParts);
    if (state.skipped.has(refKey(state, ref))) {
        return;
    }
    const table = findTable(state, ref);
    if (!table) {
        warnAt(ctx, keyword, `CREATE INDEX on ${display(state, ref)}: no file creates this table, skipped.`);
        return;
    }
    if (accept(c, 'USING')) {
        c.i++;
    }
    const items = readIndexItems(ctx, c);
    if (!items) {
        warnAt(ctx, keyword, `CREATE INDEX on ${display(state, ref)} not understood, skipped: ${excerpt(textOf(ctx.text, tokens, 0, c.end))}`);
        return;
    }
    const partial = findWord(tokens, c.i, c.end, new Set(['WHERE'])) < c.end;
    const type = modifiers.has('UNIQUE') ? 'unique' : modifiers.has('FULLTEXT') ? 'fulltext' : modifiers.has('SPATIAL') ? 'spatial' : 'index';
    const given = nameParts ? fold(state, nameParts[nameParts.length - 1]) : null;
    addIndex(state, table, { name: given || indexName(state, table, items, 'idx'), named: Boolean(given), items, type, partial, constraint: false });
    touchTable(table, rangeOf(ctx, tokens, 0, c.end));
}

// CREATE TYPE name AS ENUM ('a', 'b'); the other types (composite, range, domain) are names only
function createTypeStatement(ctx, c) {
    const { state } = ctx;
    const parts = readName(c);
    if (!parts || !accept(c, 'AS', 'ENUM') || !isPunct(peek(c), '(')) {
        return;
    }
    const close = closing(c.tokens, c.i, c.end);
    const values = splitCommas(c.tokens, c.i + 1, close).map(([from]) => c.tokens[from]).filter(t => t.type === 'string').map(t => t.value);
    const ref = refOf(state, parts);
    state.types.set(refKey(state, ref), { ref, values });
}

// ALTER TABLE | TYPE | INDEX | SCHEMA ...; the other objects are passed over
function alterStatement(ctx, c) {
    accept(c, 'ONLINE');
    accept(c, 'IGNORE');
    const kind = peek(c);
    if (accept(c, 'TABLE')) {
        return alterTableStatement(ctx, c, kind);
    }
    if (accept(c, 'TYPE')) {
        return alterTypeStatement(ctx, c);
    }
    if (accept(c, 'INDEX')) {
        return alterIndexStatement(ctx, c);
    }
    if (accept(c, 'SCHEMA')) {
        return alterSchemaStatement(ctx, c);
    }
    return undefined;
}

// Actions of ALTER TABLE that change nothing drawn
const PASSIVE_ACTIONS = new Set(['OWNER', 'ENABLE', 'DISABLE', 'FORCE', 'NO', 'REPLICA', 'INHERIT', 'OF', 'NOT', 'VALIDATE', 'CLUSTER', 'RESET', 'ENGINE', 'AUTO_INCREMENT', 'DEFAULT', 'CHARACTER', 'CHARSET', 'COLLATE', 'COMMENT', 'CONVERT', 'ALGORITHM', 'LOCK', 'ROW_FORMAT', 'KEY_BLOCK_SIZE', 'STATS_PERSISTENT', 'STATS_AUTO_RECALC', 'STATS_SAMPLE_PAGES', 'PACK_KEYS', 'CHECKSUM', 'DELAY_KEY_WRITE', 'MAX_ROWS', 'MIN_ROWS', 'AVG_ROW_LENGTH', 'INSERT_METHOD', 'UNION', 'DATA', 'ORDER', 'DISCARD', 'IMPORT', 'TRUNCATE', 'COALESCE', 'REORGANIZE', 'EXCHANGE', 'ANALYZE', 'OPTIMIZE', 'REBUILD', 'REPAIR', 'REMOVE', 'UPGRADE', 'WITH', 'WITHOUT', 'SECONDARY_LOAD', 'SECONDARY_UNLOAD', 'DETACH', 'TABLESPACE', 'AUTOEXTEND_SIZE', 'ENCRYPTION', 'COMPRESSION', 'CONNECTION', 'PASSWORD', 'PARTITION', 'PARTITIONS']);

// ALTER TABLE [IF EXISTS] [ONLY] name [*] action [, action...]
function alterTableStatement(ctx, c, keyword) {
    const { state } = ctx;
    const { tokens } = c;
    const ifExists = accept(c, 'IF', 'EXISTS');
    accept(c, 'ONLY');
    const parts = readName(c);
    if (!parts) {
        warnAt(ctx, keyword, `ALTER TABLE not understood, skipped: ${excerpt(textOf(ctx.text, tokens, 0, c.end))}`);
        return;
    }
    acceptPunct(c, '*');
    const ref = tableRef(state, parts);
    if (state.skipped.has(refKey(state, ref))) {
        return;
    }
    const actions = splitCommas(tokens, c.i, c.end);
    let table = findTable(state, ref);
    if (!table) {
        if (ifExists) {
            return;
        }
        // An action that adds a column or a key adds the table, as Laravel does for Schema::table()
        const adds = actions.some(([from]) => isWord(tokens[from], 'ADD') && !isWord(tokens[from + 1], 'PARTITION'));
        const changes = actions.some(([from]) => isWord(tokens[from]) && !PASSIVE_ACTIONS.has(tokens[from].upper) && !(isWord(tokens[from], 'SET') && !isWord(tokens[from + 1], 'SCHEMA')));
        if (adds) {
            warnAt(ctx, keyword, `ALTER TABLE ${display(state, ref)} on a table that no file creates: table added.`);
            const range = rangeOf(ctx, tokens, 0, c.end);
            table = createTable(ref, range, { file: ctx.file.rel, line: range.first });
            table.statementLines = linesOf(ctx, tokens, 0, c.end);
            state.tables.set(refKey(state, ref), table);
        } else {
            if (changes) {
                warnAt(ctx, keyword, `ALTER TABLE ${display(state, ref)}: no file creates this table, skipped.`);
            }
            return;
        }
    }
    for (const [from, to] of actions) {
        if (!state.tables.has(refKey(state, table.ref))) {
            // Dropped or replaced by a previous action
            return;
        }
        const range = rangeOf(ctx, tokens, from, to);
        const effect = alterAction(ctx, table, cursorOf(tokens, from, to), range);
        if (effect === false) {
            warnAt(ctx, tokens[from], `ALTER TABLE ${display(state, table.ref)}: ${excerpt(textOf(ctx.text, tokens, from, to))} not understood, skipped.`);
        } else if (effect !== 'passive') {
            touchTable(table, range);
        }
    }
}

// One action of ALTER TABLE: true (applied), 'passive' (nothing drawn changes), false (not understood)
function alterAction(ctx, table, c, range) {
    const { state } = ctx;
    const { tokens } = c;
    const first = peek(c);
    if (!isWord(first)) {
        return false;
    }
    const nameAt = () => {
        const t = peek(c);
        if (!isName(t)) {
            return null;
        }
        c.i++;
        return fold(state, { value: t.value, quoted: t.type === 'ident' });
    };
    const missing = (name, what) => {
        warnAt(ctx, first, `ALTER TABLE ${display(state, table.ref)}: column ${name} does not exist, ${what} skipped.`);
        return 'passive';
    };

    if (accept(c, 'ADD')) {
        if (isWord(peek(c), 'PARTITION')) {
            return 'passive';
        }
        if (!accept(c, 'COLUMN') && isConstraintItem(c)) {
            return applyConstraint(ctx, table, c, c.end, range);
        }
        const ifNotExists = accept(c, 'IF', 'NOT', 'EXISTS');
        if (isPunct(peek(c), '(')) {
            // MySQL: ADD [COLUMN] (a int, b int)
            const close = closing(tokens, c.i, c.end);
            for (const [from, to] of splitCommas(tokens, c.i + 1, close)) {
                const item = cursorOf(tokens, from, to);
                if (isConstraintItem(item)) {
                    applyConstraint(ctx, table, item, to, range);
                    continue;
                }
                const read = readColumn(ctx, item, to, rangeOf(ctx, tokens, from, to));
                if (read) {
                    placeColumn(state, table, read.column, read.position);
                    applyColumnConstraints(ctx, table, read);
                }
            }
            return true;
        }
        const read = readColumn(ctx, c, c.end, range);
        if (!read) {
            return false;
        }
        if (columnOf(state, table, read.column.name)) {
            if (!ifNotExists) {
                warnAt(ctx, first, `ALTER TABLE ${display(state, table.ref)}: column ${read.column.name} already exists, ADD COLUMN skipped.`);
            }
            return 'passive';
        }
        placeColumn(state, table, read.column, read.position);
        applyColumnConstraints(ctx, table, read);
        return true;
    }

    if (accept(c, 'DROP')) {
        if (accept(c, 'CONSTRAINT')) {
            accept(c, 'IF', 'EXISTS');
            const name = nameAt();
            if (name === null) {
                return false;
            }
            dropConstraint(state, table, name);
            return true;
        }
        if (accept(c, 'PRIMARY', 'KEY')) {
            table.primaryKey = null;
            return true;
        }
        if (accept(c, 'FOREIGN', 'KEY')) {
            const name = nameAt();
            if (name === null) {
                return false;
            }
            table.foreignKeys = table.foreignKeys.filter(fk => !sameName(state, fk.name, name));
            return true;
        }
        if (accept(c, 'INDEX') || accept(c, 'KEY')) {
            const name = nameAt();
            if (name === null) {
                return false;
            }
            if (sameName(state, name, 'PRIMARY')) {
                table.primaryKey = null;
            }
            table.indexes = table.indexes.filter(index => !(index.name && sameName(state, index.name, name)));
            return true;
        }
        if (accept(c, 'CHECK') || isWord(peek(c), 'PARTITION', 'DEFAULT')) {
            return 'passive';
        }
        accept(c, 'COLUMN');
        const ifExists = accept(c, 'IF', 'EXISTS');
        const name = nameAt();
        if (name === null) {
            return false;
        }
        if (!columnOf(state, table, name)) {
            return ifExists ? 'passive' : missing(name, 'DROP COLUMN');
        }
        dropColumn(state, table, name);
        return true;
    }

    if (accept(c, 'ALTER')) {
        if (accept(c, 'CONSTRAINT') || accept(c, 'INDEX') || accept(c, 'CHECK')) {
            return 'passive';
        }
        accept(c, 'COLUMN');
        const name = nameAt();
        if (name === null) {
            return false;
        }
        const column = columnOf(state, table, name);
        if (!column) {
            return missing(name, 'ALTER COLUMN');
        }
        if (accept(c, 'TO')) {
            // libSQL (Turso): ALTER COLUMN a TO b definition, written by drizzle-kit
            const read = readColumn(ctx, c, c.end, range);
            if (!read) {
                return false;
            }
            renameColumn(state, table, name, read.column.name);
            redefineColumn(ctx, table, column, read, range);
            return true;
        }
        if (accept(c, 'SET', 'DATA', 'TYPE') || accept(c, 'TYPE')) {
            applyType(column, readType(ctx, c, c.end));
        } else if (accept(c, 'SET', 'DEFAULT')) {
            const stop = expressionEnd(tokens, c.i, c.end, DEFAULT_END);
            applyDefault(column, defaultOf(ctx, tokens, c.i, stop, column.typeInfo));
        } else if (accept(c, 'DROP', 'DEFAULT')) {
            delete column.details.default;
            delete column.details.defaultRaw;
        } else if (accept(c, 'SET', 'NOT', 'NULL')) {
            column.notNull = true;
        } else if (accept(c, 'DROP', 'NOT', 'NULL')) {
            column.notNull = false;
        } else if (accept(c, 'ADD', 'GENERATED')) {
            column.notNull = true;
            column.details.autoIncrement = true;
        } else if (accept(c, 'DROP', 'IDENTITY')) {
            delete column.details.autoIncrement;
        } else if (accept(c, 'DROP', 'EXPRESSION')) {
            // A generated column becomes a plain one
        } else if (isWord(peek(c), 'SET', 'RESET', 'OPTIONS')) {
            // SET STATISTICS, SET STORAGE, SET (n_distinct = ...), SET VISIBLE (MySQL), SET GENERATED...
            if (accept(c, 'SET', 'GENERATED')) {
                return true;
            }
            return 'passive';
        } else {
            return false;
        }
        touchColumn(ctx, column, range);
        return true;
    }

    if (accept(c, 'MODIFY')) {
        accept(c, 'COLUMN');
        const read = readColumn(ctx, c, c.end, range);
        if (!read) {
            return false;
        }
        const column = columnOf(state, table, read.column.name);
        if (!column) {
            return missing(read.column.name, 'MODIFY');
        }
        redefineColumn(ctx, table, column, read, range);
        return true;
    }

    if (accept(c, 'CHANGE')) {
        accept(c, 'COLUMN');
        const from = nameAt();
        const read = from === null ? null : readColumn(ctx, c, c.end, range);
        if (!read) {
            return false;
        }
        const column = columnOf(state, table, from);
        if (!column) {
            return missing(from, 'CHANGE');
        }
        renameColumn(state, table, from, read.column.name);
        redefineColumn(ctx, table, column, read, range);
        return true;
    }

    if (accept(c, 'RENAME')) {
        if (accept(c, 'CONSTRAINT')) {
            const from = nameAt();
            const to = accept(c, 'TO') ? nameAt() : null;
            if (from === null || to === null) {
                return false;
            }
            renameConstraint(state, table, from, to);
            return true;
        }
        if (accept(c, 'INDEX') || accept(c, 'KEY')) {
            const from = nameAt();
            const to = accept(c, 'TO') ? nameAt() : null;
            if (from === null || to === null) {
                return false;
            }
            renameConstraint(state, table, from, to);
            return true;
        }
        if (accept(c, 'TO') || accept(c, 'AS') || (isName(peek(c)) && !isWord(peek(c), 'COLUMN') && !isWord(peek(c, 1), 'TO') && !isPunct(peek(c, 1), '.'))) {
            const target = readName(c);
            if (!target) {
                return false;
            }
            const to = refOf(state, target);
            // PostgreSQL: RENAME TO keeps the schema of the table
            const ref = target.length === 1 && state.dialect !== 'mysql' ? { schema: table.ref.schema, name: to.name } : to;
            moveTable(state, table, ref);
            return true;
        }
        if (isName(peek(c)) && isPunct(peek(c, 1), '.')) {
            // MySQL: RENAME TO db.table without TO
            const target = readName(c);
            moveTable(state, table, refOf(state, target));
            return true;
        }
        accept(c, 'COLUMN');
        const from = nameAt();
        const to = accept(c, 'TO') ? nameAt() : null;
        if (from === null || to === null) {
            return false;
        }
        const column = columnOf(state, table, from);
        if (!column) {
            return missing(from, 'RENAME COLUMN');
        }
        renameColumn(state, table, from, to);
        touchColumn(ctx, column, range);
        return true;
    }

    if (accept(c, 'SET', 'SCHEMA')) {
        const schema = nameAt();
        if (schema === null) {
            return false;
        }
        moveTable(state, table, { schema, name: table.ref.name });
        return true;
    }

    if (accept(c, 'ATTACH', 'PARTITION')) {
        // The partition is a part of this table
        const parts = readName(c);
        const partition = parts ? findTable(state, tableRef(state, parts)) : null;
        if (partition && partition !== table) {
            state.tables.delete(refKey(state, partition.ref));
            state.skipped.add(refKey(state, partition.ref));
        }
        return true;
    }

    if (PASSIVE_ACTIONS.has(first.upper) || isWord(first, 'SET')) {
        return 'passive';
    }
    return false;
}

// MySQL MODIFY / CHANGE: the column gets the new definition, at its new place
function redefineColumn(ctx, table, column, read, range) {
    const { state } = ctx;
    column.type = read.column.type;
    column.typeInfo = read.column.typeInfo;
    column.enumKey = read.column.enumKey;
    column.notNull = read.column.notNull;
    column.details = read.column.details;
    touchColumn(ctx, column, range);
    if (read.position) {
        placeColumn(state, table, column, read.position);
    }
    read.column = column;
    applyColumnConstraints(ctx, table, read);
}

function renameConstraint(state, table, from, to) {
    if (table.primaryKey && sameName(state, table.primaryKey.name, from)) {
        table.primaryKey.name = to;
    }
    for (const fk of table.foreignKeys) {
        if (sameName(state, fk.name, from)) {
            fk.name = to;
        }
    }
    for (const index of table.indexes) {
        if (index.name && sameName(state, index.name, from)) {
            index.name = to;
            index.named = true;
        }
    }
}

// ALTER TYPE name ADD VALUE 'v' [BEFORE | AFTER 'w'] | RENAME VALUE 'a' TO 'b' | RENAME TO new |
// SET SCHEMA s
function alterTypeStatement(ctx, c) {
    const { state } = ctx;
    const parts = readName(c);
    if (!parts) {
        return;
    }
    const ref = typeRef(state, parts);
    const key = refKey(state, ref);
    const type = state.types.get(key);
    if (!type) {
        return;
    }
    if (accept(c, 'ADD', 'VALUE')) {
        accept(c, 'IF', 'NOT', 'EXISTS');
        const value = peek(c);
        if (!value || value.type !== 'string') {
            return;
        }
        c.i++;
        if (type.values.includes(value.value)) {
            return;
        }
        const where = isWord(peek(c), 'BEFORE', 'AFTER') ? peek(c).upper : null;
        const other = peek(c, 1);
        const at = where && other && other.type === 'string' ? type.values.indexOf(other.value) : -1;
        if (at === -1) {
            type.values.push(value.value);
        } else {
            type.values.splice(where === 'BEFORE' ? at : at + 1, 0, value.value);
        }
    } else if (accept(c, 'RENAME', 'VALUE')) {
        const from = peek(c);
        const to = peek(c, 2);
        if (from && to && from.type === 'string' && to.type === 'string' && isWord(peek(c, 1), 'TO')) {
            type.values = type.values.map(value => (value === from.value ? to.value : value));
        }
    } else if (accept(c, 'RENAME', 'TO') || accept(c, 'SET', 'SCHEMA')) {
        const renamed = isWord(c.tokens[c.i - 1], 'TO');
        const target = readName(c);
        if (!target) {
            return;
        }
        const newRef = renamed ? { schema: ref.schema, name: fold(state, target[target.length - 1]) } : { schema: fold(state, target[target.length - 1]), name: ref.name };
        state.types.delete(key);
        type.ref = newRef;
        const newKey = refKey(state, newRef);
        state.types.set(newKey, type);
        // The columns of this type follow it (PostgreSQL references the type, not its name)
        for (const table of state.tables.values()) {
            for (const column of table.columns) {
                if (column.enumKey === key) {
                    column.enumKey = newKey;
                    column.type = display(state, newRef) + (/(\[\])+$/.exec(column.type) || [''])[0];
                }
            }
        }
    }
}

// ALTER INDEX [IF EXISTS] name RENAME TO new
function alterIndexStatement(ctx, c) {
    const { state } = ctx;
    accept(c, 'IF', 'EXISTS');
    const parts = readName(c);
    if (!parts || !accept(c, 'RENAME', 'TO')) {
        return;
    }
    const target = readName(c);
    if (!target) {
        return;
    }
    const name = fold(state, parts[parts.length - 1]);
    const to = fold(state, target[target.length - 1]);
    for (const table of state.tables.values()) {
        for (const index of table.indexes) {
            if (index.name && sameName(state, index.name, name)) {
                index.name = to;
                index.named = true;
                return;
            }
        }
        if (table.primaryKey && sameName(state, table.primaryKey.name, name)) {
            table.primaryKey.name = to;
            return;
        }
    }
}

// ALTER SCHEMA a RENAME TO b: its tables and types follow it
function alterSchemaStatement(ctx, c) {
    const { state } = ctx;
    const from = readName(c);
    if (!from || !accept(c, 'RENAME', 'TO')) {
        return;
    }
    const to = readName(c);
    if (!to) {
        return;
    }
    const oldSchema = fold(state, from[0]);
    const newSchema = fold(state, to[0]);
    for (const table of [...state.tables.values()]) {
        if (table.ref.schema !== null && sameName(state, table.ref.schema, oldSchema)) {
            moveTable(state, table, { schema: newSchema, name: table.ref.name });
        }
    }
    for (const table of state.tables.values()) {
        for (const fk of table.foreignKeys) {
            if (fk.target.schema !== null && sameName(state, fk.target.schema, oldSchema)) {
                fk.target = { schema: newSchema, name: fk.target.name };
            }
        }
    }
}

// DROP TABLE | INDEX | TYPE | SCHEMA ...; the other objects are passed over
function dropStatement(ctx, c) {
    const { state } = ctx;
    const { tokens } = c;
    accept(c, 'TEMPORARY');
    const keyword = peek(c);
    if (accept(c, 'TABLE')) {
        const ifExists = accept(c, 'IF', 'EXISTS');
        const cascade = tokens.slice(c.i, c.end).some(t => isWord(t, 'CASCADE'));
        const end = findWord(tokens, c.i, c.end, new Set(['CASCADE', 'RESTRICT']));
        for (const [from, to] of splitCommas(tokens, c.i, end)) {
            const parts = readName(cursorOf(tokens, from, to));
            if (!parts) {
                continue;
            }
            const ref = tableRef(state, parts);
            const table = findTable(state, ref);
            if (table) {
                dropTable(state, table, cascade);
            } else if (!ifExists && !state.skipped.has(refKey(state, ref))) {
                warnAt(ctx, keyword, `DROP TABLE ${display(state, ref)}: no file creates this table, skipped.`);
            }
        }
        return;
    }
    if (accept(c, 'INDEX')) {
        accept(c, 'CONCURRENTLY');
        accept(c, 'IF', 'EXISTS');
        const onAt = findWord(tokens, c.i, c.end, new Set(['ON']));
        // MySQL: DROP INDEX name ON table
        const onTable = onAt < c.end ? findTable(state, tableRef(state, readName(cursorOf(tokens, onAt + 1, c.end)) || [{ value: '', quoted: true }])) : null;
        const end = findWord(tokens, c.i, onAt, new Set(['CASCADE', 'RESTRICT']));
        for (const [from, to] of splitCommas(tokens, c.i, end)) {
            const parts = readName(cursorOf(tokens, from, to));
            if (parts) {
                dropIndex(ctx, parts, onTable, rangeOf(ctx, tokens, 0, c.end));
            }
        }
        return;
    }
    if (accept(c, 'TYPE')) {
        accept(c, 'IF', 'EXISTS');
        const cascade = tokens.slice(c.i, c.end).some(t => isWord(t, 'CASCADE'));
        const end = findWord(tokens, c.i, c.end, new Set(['CASCADE', 'RESTRICT']));
        for (const [from, to] of splitCommas(tokens, c.i, end)) {
            const parts = readName(cursorOf(tokens, from, to));
            if (!parts) {
                continue;
            }
            const key = refKey(state, typeRef(state, parts));
            state.types.delete(key);
            if (cascade) {
                for (const table of state.tables.values()) {
                    for (const column of table.columns.filter(other => other.enumKey === key)) {
                        dropColumn(state, table, column.name);
                    }
                }
            }
        }
        return;
    }
    if (accept(c, 'SCHEMA') || accept(c, 'DATABASE')) {
        accept(c, 'IF', 'EXISTS');
        const end = findWord(tokens, c.i, c.end, new Set(['CASCADE', 'RESTRICT']));
        for (const [from, to] of splitCommas(tokens, c.i, end)) {
            const parts = readName(cursorOf(tokens, from, to));
            if (!parts) {
                continue;
            }
            const schema = fold(state, parts[0]);
            const dropped = state.dialect === 'mysql' && state.database !== null && sameName(state, schema, state.database) ? null : schema;
            for (const table of [...state.tables.values()]) {
                if ((table.ref.schema === null ? dropped === null : dropped !== null && sameName(state, table.ref.schema, dropped))) {
                    dropTable(state, table, true);
                }
            }
            for (const [key, type] of [...state.types]) {
                if (type.ref.schema !== null && dropped !== null && sameName(state, type.ref.schema, dropped)) {
                    state.types.delete(key);
                }
            }
        }
    }
}

// Drops the index `parts` (in the schema of its name, or of `onTable` for MySQL)
function dropIndex(ctx, parts, onTable, range) {
    const { state } = ctx;
    const name = fold(state, parts[parts.length - 1]);
    const schema = parts.length > 1 ? fold(state, parts[parts.length - 2]) : null;
    const tables = onTable ? [onTable] : [...state.tables.values()].filter(table => schema === null || table.ref.schema === null || sameName(state, table.ref.schema, schema));
    for (const table of tables) {
        const index = table.indexes.find(other => other.name && sameName(state, other.name, name));
        if (index) {
            table.indexes = table.indexes.filter(other => other !== index);
            touchTable(table, range);
            return;
        }
        if (onTable && sameName(state, name, 'PRIMARY')) {
            table.primaryKey = null;
            touchTable(table, range);
            return;
        }
    }
}

// MySQL: RENAME TABLE a TO b [, c TO d]
function renameStatement(ctx, c) {
    const { state } = ctx;
    const { tokens } = c;
    if (!accept(c, 'TABLE') && !accept(c, 'TABLES')) {
        return;
    }
    for (const [from, to] of splitCommas(tokens, c.i, c.end)) {
        const part = cursorOf(tokens, from, to);
        const source = readName(part);
        if (!source || !accept(part, 'TO')) {
            continue;
        }
        const target = readName(part);
        const table = findTable(state, tableRef(state, source));
        if (table && target) {
            moveTable(state, table, refOf(state, target));
            touchTable(table, rangeOf(ctx, tokens, from, to));
        }
    }
}

// COMMENT ON COLUMN table.column IS 'text' (the comment detail); the other comments are passed over
function commentStatement(ctx, c) {
    const { state } = ctx;
    const { tokens } = c;
    if (!accept(c, 'ON', 'COLUMN')) {
        return;
    }
    const parts = readName(c);
    if (!parts || parts.length < 2 || !accept(c, 'IS')) {
        return;
    }
    const table = findTable(state, tableRef(state, parts.slice(0, -1)));
    const column = table ? columnOf(state, table, fold(state, parts[parts.length - 1])) : null;
    const value = peek(c);
    if (!column || !value) {
        return;
    }
    if (value.type === 'string') {
        column.details.comment = value.value;
    } else if (isWord(value, 'NULL')) {
        delete column.details.comment;
    }
    touchColumn(ctx, column, rangeOf(ctx, tokens, 0, c.end));
}

// SET search_path = a, b (PostgreSQL): the schema of the unqualified names
function setStatement(ctx, c) {
    accept(c, 'SESSION') || accept(c, 'LOCAL');
    if (!accept(c, 'SEARCH_PATH') && !accept(c, 'SCHEMA')) {
        return;
    }
    acceptPunct(c, '=') || accept(c, 'TO');
    if (accept(c, 'DEFAULT')) {
        ctx.state.searchPath = ['public'];
        return;
    }
    const names = [];
    for (const [from] of splitCommas(c.tokens, c.i, c.end)) {
        const t = c.tokens[from];
        if (t && (isName(t) || t.type === 'string')) {
            names.push(...(t.type === 'string' ? t.value.split(',') : [t.value]).map(name => name.trim()));
        }
    }
    setSearchPath(ctx.state, names);
}

function setSearchPath(state, names) {
    state.searchPath = names.map(name => name.replace(/^"(.*)"$/, '$1')).filter(name => name !== '' && name !== '$user' && name.toLowerCase() !== 'pg_catalog');
}

// SELECT pg_catalog.set_config('search_path', '', false), as pg_dump writes it
function selectStatement(ctx, c) {
    const { tokens } = c;
    for (let k = c.i; k + 4 < c.end; k++) {
        if (isWord(tokens[k], 'SET_CONFIG') && isPunct(tokens[k + 1], '(') && tokens[k + 2].type === 'string' && tokens[k + 2].value.toLowerCase() === 'search_path' && tokens[k + 4] && tokens[k + 4].type === 'string') {
            setSearchPath(ctx.state, tokens[k + 4].value.split(','));
            return;
        }
    }
}

// INSERT INTO table [(columns)] VALUES (...), (...): the rows of the table that state.rows collects
// (the migrations listed by a Laravel schema dump)
function insertStatement(ctx, c) {
    const { state } = ctx;
    const { tokens } = c;
    if (!state.rows) {
        return;
    }
    accept(c, 'IGNORE');
    accept(c, 'INTO');
    const parts = readName(c);
    if (!parts || !sameName(state, refOf(state, parts).name, state.rows.table)) {
        return;
    }
    const columns = readColumnList(ctx, c);
    if (!accept(c, 'VALUES') && !accept(c, 'VALUE')) {
        return;
    }
    for (const [from, to] of splitCommas(tokens, c.i, c.end)) {
        if (!isPunct(tokens[from], '(')) {
            continue;
        }
        const values = splitCommas(tokens, from + 1, to - 1).map(([a, b]) => (b - a === 1 && ['string', 'number'].includes(tokens[a].type) ? tokens[a].value : null));
        state.rows.values.push(columns ? Object.fromEntries(columns.map((name, k) => [name, values[k]])) : values);
    }
}

// The rows of a COPY ... FROM STDIN of the table that state.rows collects
function copyRows(ctx, statement) {
    const { state } = ctx;
    if (!state.rows || !statement.copy) {
        return;
    }
    const c = cursorOf(statement.tokens, 1);
    const parts = readName(c);
    if (!parts || !sameName(state, refOf(state, parts).name, state.rows.table)) {
        return;
    }
    const columns = readColumnList(ctx, c);
    const data = ctx.text.slice(statement.copy.start, statement.copy.end);
    for (const line of data.split('\n')) {
        if (line.replace(/\r$/, '') === '') {
            continue;
        }
        const values = line.replace(/\r$/, '').split('\t').map(value => (value === '\\N' ? null : value.replace(/\\(.)/g, (whole, char) => (ESCAPES[char] !== undefined ? ESCAPES[char] : char))));
        state.rows.values.push(columns ? Object.fromEntries(columns.map((name, k) => [name, values[k]])) : values);
    }
}

// The statements of a PL/pgSQL block that are applied (after its control words: IF ... THEN...)
const PLPGSQL_STATEMENTS = new Set(['CREATE', 'ALTER', 'DROP', 'COMMENT', 'RENAME']);

// DO [LANGUAGE plpgsql] $$ ... $$: the DDL statements of the block are applied, as if every branch
// of its conditions ran (they mostly make a migration idempotent: IF NOT EXISTS (...) THEN CREATE
// TYPE ...), not the ones of its exception handlers. EXECUTE of a constant string is applied too;
// other dynamic SQL cannot be read.
function doStatement(ctx, c) {
    const { tokens } = c;
    const body = tokens.slice(c.i, c.end).find(t => t.type === 'dollar' || t.type === 'string');
    const language = tokens.slice(c.i, c.end).findIndex(t => isWord(t, 'LANGUAGE'));
    if (!body || (language !== -1 && !isWord(tokens[c.i + language + 1], 'PLPGSQL'))) {
        return;
    }
    if (body.type === 'string') {
        // DO 'BEGIN ... END': the block is on the line of the string
        const line = ctx.lineAt(body.start);
        applyBlock({ ...ctx, text: body.value, lineAt: () => line }, 0, body.value.length);
        return;
    }
    applyBlock(ctx, body.bodyStart, body.bodyEnd);
}

// Applies the DDL statements of a PL/pgSQL block text[from, to)
function applyBlock(ctx, from, to) {
    const { statements } = scanStatements(ctx.text, 'postgresql', { from, to });
    // The blocks (BEGIN ... END) of the code, and whether their exception handlers are being read
    const handlers = [];
    for (const statement of statements) {
        const { tokens } = statement;
        let k = 0;
        let skipped = false;
        // The control words before the statement
        for (;;) {
            const t = tokens[k];
            if (!t) {
                break;
            }
            if (isPunct(t, '<') && isPunct(tokens[k + 1], '<')) {
                // <<label>>
                k += 2;
                while (tokens[k] && !isPunct(tokens[k], '>')) {
                    k++;
                }
                k += 2;
            } else if (isWord(t, 'DECLARE')) {
                skipped = true;
                break;
            } else if (isWord(t, 'BEGIN')) {
                handlers.push(false);
                k++;
            } else if (isWord(t, 'EXCEPTION')) {
                if (handlers.length > 0) {
                    handlers[handlers.length - 1] = true;
                }
                k++;
            } else if (isWord(t, 'IF', 'ELSIF', 'ELSEIF', 'WHEN', 'WHILE', 'FOR', 'FOREACH')) {
                const then = findWord(tokens, k + 1, tokens.length, new Set(['THEN', 'LOOP']));
                k = then + 1;
            } else if (isWord(t, 'ELSE', 'LOOP', 'THEN')) {
                k++;
            } else if (isWord(t, 'END')) {
                if (isWord(tokens[k + 1], 'IF', 'LOOP', 'CASE')) {
                    k += 2;
                } else {
                    handlers.pop();
                    k++;
                    if (isWord(tokens[k]) && !PLPGSQL_STATEMENTS.has(tokens[k].upper)) {
                        // END label
                        k++;
                    }
                }
            } else {
                break;
            }
        }
        if (skipped || k >= tokens.length || handlers.includes(true)) {
            continue;
        }
        const t = tokens[k];
        if (isWord(t, 'EXECUTE')) {
            const rest = tokens.slice(k + 1);
            if (rest.length === 1 && (rest[0].type === 'string' || rest[0].type === 'dollar')) {
                applyDynamic(ctx, t, rest[0].value);
            } else if (rest.some(other => (other.type === 'string' || other.type === 'dollar') && /\b(?:TABLE|COLUMN|INDEX|TYPE)\b/i.test(other.value))) {
                warnAt(ctx, t, 'dynamic SQL (EXECUTE) skipped: it cannot be read without running it.');
            }
        } else if (isWord(t) && PLPGSQL_STATEMENTS.has(t.upper)) {
            applyStatement(ctx, tokens.slice(k));
        }
    }
}

// Applies SQL given as a string (EXECUTE 'ALTER TABLE ...', DO '...'): its statements are on the
// line of the string
function applyDynamic(ctx, at, sql) {
    const line = ctx.lineAt(at.start);
    const inner = { ...ctx, text: sql, lineAt: () => line };
    for (const statement of scanStatements(sql, 'postgresql').statements) {
        applyStatement(inner, statement.tokens);
    }
}

// ---------------------------------------------------------------------------------------------
// Replay

// The dialect of SQL files, from what only one dialect writes: 'postgresql', 'mysql', 'sqlite', or
// 'unknown' (read as PostgreSQL, without folding the names to lower case)
function sniffDialect(texts) {
    const sample = texts.join('\n').slice(0, 400000);
    const count = (re) => (sample.match(re) || []).length;
    const scores = {
        mysql: 3 * count(/\bENGINE\s*=/gi) + 3 * count(/\bAUTO_INCREMENT\b/gi) + 3 * count(/\/\*!\d{5}/g) + 3 * count(/\bDEFAULT\s+CHARSET\b/gi) + 2 * count(/\bLOCK\s+TABLES\b/gi) + count(/\bUNSIGNED\b/gi) + 2 * count(/\bCOLLATE\s*=?\s*utf8/gi),
        sqlite: 3 * count(/\bAUTOINCREMENT\b/gi) + 3 * count(/\bPRAGMA\b/gi) + 3 * count(/\bWITHOUT\s+ROWID\b/gi) + 2 * count(/\bsqlite_\w+/gi),
        postgresql: 2 * count(/\$\$|\$[A-Za-z_]\w*\$/g) + 2 * count(/::/g) + 2 * count(/\bCREATE\s+(?:TYPE|EXTENSION|SCHEMA|POLICY|SEQUENCE|DOMAIN)\b/gi) + 2 * count(/\b(?:BIG|SMALL)?SERIAL\b/gi)
            + count(/\b(?:jsonb|timestamptz|uuid|bytea)\b/gi) + 2 * count(/\bOWNER\s+TO\b/gi) + 3 * count(/\bpg_catalog\b/g) + 3 * count(/\bplpgsql\b/gi) + 2 * count(/\bAS\s+IDENTITY\b/gi) + count(/\bpublic\./g),
    };
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return best[1] > 0 ? best[0] : 'unknown';
}

// Replays SQL files in order. files: [{ path, rel, text, sections }]; options: dialect (else read
// from the files, else `hint`), skip(ref) (tables not drawn), collect (the name of a table whose
// inserted rows are kept: state.rows). Returns the state.
function replay(files, options = {}) {
    const sniffed = options.dialect || sniffDialect(files.map(file => file.text));
    const dialect = sniffed === 'unknown' && options.hint ? options.hint : sniffed;
    const state = createState(dialect, options);
    for (const file of files) {
        const text = file.text.replace(/^\uFEFF/, ' ');
        const ctx = { state, file, text, lineAt: createLineLocator(text) };
        state.searchPath = ['public'];
        const { statements, problems } = scanStatements(text, dialect, { sections: file.sections });
        for (const statement of statements) {
            applyStatement(ctx, statement.tokens);
            if (statement.copy) {
                copyRows(ctx, statement);
            }
        }
        for (const problem of problems) {
            state.warnings.push(`${file.rel}:${ctx.lineAt(problem.offset)}: ${problem.message}`);
        }
    }
    return state;
}

// ---------------------------------------------------------------------------------------------
// Pivot format

// The tables of a replay state with what declares them: [{ name, columns: [{ name, type, primary,
// nullable, unique, uniqueName, details, origin, changes, inCreate }], relations: [{ foreignKey,
// references, on, type, constraint, onDelete, onUpdate }], indexes: [{ columns, type, name, named }]
// (the one-column unique indexes are the `unique` of their column), source, origin, changes,
// statementLines }]. The pivot format is made from it, and Laravel's schema dumps go on with it.
function tableModels(state) {
    return [...state.tables.values()].map(table => {
        const primary = table.primaryKey ? table.primaryKey.columns : [];
        const uniqueSets = [
            ...(primary.length > 0 ? [primary] : []),
            ...table.indexes.filter(index => index.type === 'unique' && !index.partial && plainColumns(index)).map(plainColumns),
        ];
        const isUnique = (names) => uniqueSets.some(set => sameColumns(state, set, names));
        const singleUnique = (index) => index.type === 'unique' && !index.partial && index.items.length === 1 && Boolean(index.items[0].column);
        const columns = table.columns.map(column => {
            const inPrimary = primary.some(name => sameName(state, name, column.name));
            const unique = table.indexes.find(index => singleUnique(index) && sameName(state, index.items[0].column, column.name));
            const details = { ...column.details };
            if (column.enumKey && state.types.has(column.enumKey)) {
                details.values = [...state.types.get(column.enumKey).values];
            }
            return {
                name: column.name,
                type: column.type,
                primary: inPrimary,
                nullable: !(column.notNull || (inPrimary && state.dialect !== 'sqlite')),
                unique: Boolean(unique),
                uniqueName: unique ? unique.name : null,
                details,
                origin: column.origin,
                changes: column.changes,
                inCreate: column.inCreate === true,
            };
        });
        const relations = [];
        for (const fk of table.foreignKeys) {
            const target = findTable(state, fk.target);
            const references = fk.references.length > 0 ? fk.references : (target && target.primaryKey ? target.primaryKey.columns : fk.columns.map(() => 'id'));
            const type = isUnique(fk.columns) ? 'one-to-one' : 'many-to-one';
            fk.columns.forEach((name, k) => {
                relations.push({ foreignKey: name, references: references[k] || references[0] || 'id', on: display(state, target ? target.ref : fk.target), type, constraint: fk.name, onDelete: fk.onDelete, onUpdate: fk.onUpdate });
            });
        }
        return {
            name: display(state, table.ref),
            columns,
            relations,
            indexes: table.indexes.filter(index => !singleUnique(index)).map(index => ({ columns: itemColumns(index), type: index.type, name: index.name, named: index.named })),
            source: table.source,
            origin: table.origin,
            changes: table.changes,
            statementLines: table.statementLines || null,
        };
    });
}

// The tables of a replay state in the pivot format (docs/pivot-format.md). reader: the git status
// reader of the files (createStatusReader()), or null.
function toPivot(state, basePath, reader, options = {}) {
    const status = (range) => (reader && range ? reader.statusOf(range.path)(range.first, range.last) : null);
    const relative = (filePath) => toPosix(path.relative(basePath, filePath));
    return tableModels(state).map(table => {
        // A table added to a file that is in HEAD: every line of its CREATE statement is new
        const added = reader && table.statementLines ? reader.addedOf(table.origin.path) : null;
        const isNew = Boolean(added) && table.statementLines.every(line => added(line));
        const declared = (range, inStatement) => {
            const value = status(range);
            return value === 'modified' && isNew && inStatement ? 'untracked' : value;
        };
        const columns = table.columns.map(column => {
            const out = { name: column.name, type: column.type };
            if (column.primary) {
                out.primary = true;
            }
            if (column.nullable) {
                out.nullable = true;
            }
            const git = changedStatus(declared(column.origin, column.inCreate), column.changes.map(status));
            if (git) {
                out.git = git;
            }
            if (options.columnSources && column.origin) {
                out.source = { file: relative(column.origin.path), line: column.origin.first };
            }
            if (options.details) {
                const details = { ...column.details, ...(column.unique ? { unique: true } : {}) };
                DETAIL_KEYS.filter(key => key in details).forEach(key => {
                    out[key] = details[key];
                });
            }
            return out;
        });
        const relations = table.relations.map(relation => ({
            foreignKey: relation.foreignKey,
            references: relation.references,
            on: relation.on,
            type: relation.type,
            ...(options.details && relation.onDelete ? { onDelete: relation.onDelete } : {}),
            ...(options.details && relation.onUpdate ? { onUpdate: relation.onUpdate } : {}),
        }));
        const out = { table: table.name, columns, relations, source: table.source };
        // The changes made by other files mark the table modified, not new
        const git = tableStatus(changedStatus(declared(table.origin, true), table.changes.map(range => {
            const value = status(range);
            return value === 'untracked' ? 'modified' : value;
        })), columns.map(column => column.git));
        if (git) {
            out.git = git;
        }
        if (options.details && table.indexes.length > 0) {
            out.indexes = table.indexes.map(index => ({ columns: index.columns, type: index.type, ...(index.named ? { name: index.name } : {}) }));
        }
        return out;
    });
}

// ---------------------------------------------------------------------------------------------
// Where the SQL files are

// Orders of the migration tools: by file name, by version number (golang-migrate, goose, sqlx...:
// 2_b before 10_a), by Flyway version (V1.2.10 after V1.2.9)
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const compareDigits = (x, y) => {
    const a = x.replace(/^0+(?=\d)/, '');
    const b = y.replace(/^0+(?=\d)/, '');
    return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;
};
const versionOf = (name) => (/^\d+/.exec(name) || ['0'])[0];
const byVersion = (a, b) => compareDigits(versionOf(a.name), versionOf(b.name)) || byName(a, b);
function byFlywayVersion(a, b) {
    const parts = (file) => ((/^V([\d._]+?)__/.exec(file.name) || [null, '0'])[1]).split(/[._]/).filter(part => part !== '');
    const x = parts(a);
    const y = parts(b);
    for (let k = 0; k < Math.max(x.length, y.length); k++) {
        const difference = compareDigits(x[k] || '0', y[k] || '0');
        if (difference !== 0) {
            return difference;
        }
    }
    return byName(a, b);
}

const MIGRATION_FOLDERS = ['migrations', 'db/migrations', 'database/migrations', 'sql/migrations', 'sql/schema', 'db/schema'];
// The layouts read, in this order: the first one with files wins. folders: where the tool keeps
// them ('.': the framework folder itself); file: the names of its migrations (in the folder, or in
// its sub-folders with `recursive`); nested: the file of a migration that has a folder of its own;
// marker: the sections a file must have (dbmate, goose); stack: the ORM whose output it is.
const LAYOUTS = [
    { id: 'supabase', folders: ['supabase/migrations'], file: /^\d+_.*\.sql$/, order: byName, dialect: 'postgresql' },
    { id: 'flyway', folders: ['src/main/resources/db/migration', 'db/migration', 'sql', 'flyway/sql', 'migrations', '.'], recursive: true, file: /^V\d+(?:[._]\d+)*__.*\.sql$/, order: byFlywayVersion },
    { id: 'dbmate', folders: ['db/migrations', '.'], file: /^\d+_.*\.sql$/, marker: 'dbmate', order: byName },
    { id: 'golang-migrate', folders: [...MIGRATION_FOLDERS, '.'], file: /^\d+_.*[._]up\.sql$/, order: byVersion },
    { id: 'goose', folders: [...MIGRATION_FOLDERS, '.'], file: /^\d+_.*\.sql$/, marker: 'goose', order: byVersion },
    { id: 'diesel', folders: ['migrations'], nested: 'up.sql', order: byName },
    { id: 'prisma', folders: ['prisma/migrations', 'prisma/schema/migrations', 'migrations'], nested: 'migration.sql', lock: 'migration_lock.toml', order: byName, stack: 'prisma' },
    { id: 'drizzle', folders: ['drizzle', 'migrations', 'drizzle/migrations', 'src/db/migrations', 'src/drizzle', 'db/migrations', 'src/migrations'], journal: 'meta/_journal.json', order: byName, stack: 'drizzle' },
    { id: 'migrations', folders: [...MIGRATION_FOLDERS, 'sql', '.'], file: /^\d+[_.-].*\.sql$/, exclude: /[._-](?:down|undo|rollback|revert)\.sql$/i, order: byVersion },
    { id: 'rails', files: ['db/structure.sql'] },
    { id: 'dump', files: ['schema.sql', 'structure.sql', 'database.sql', 'dump.sql', 'db.sql', 'init.sql', 'db/schema.sql', 'db/database.sql', 'db/dump.sql', 'db/init.sql', 'sql/schema.sql'] },
];
const DIALECTS = { postgresql: 'postgresql', postgres: 'postgresql', cockroachdb: 'postgresql', mysql: 'mysql', singlestore: 'mysql', sqlite: 'sqlite', turso: 'sqlite' };

function readJson(filePath, overrides) {
    try {
        return JSON.parse((readText(filePath, overrides) || 'null').replace(/^\uFEFF/, ''));
    } catch {
        return null;
    }
}

// The migrations of drizzle-kit in a folder: those of its journal (meta/_journal.json), in its
// order; else drizzle-kit 1.0's folders (<timestamp>_<name>/migration.sql with its snapshot.json);
// else, in its default folder (drizzle), the 0000_name.sql files
function drizzleFiles(folder, isDefault, overrides) {
    const journal = path.join(folder, 'meta', '_journal.json');
    if (isFile(journal)) {
        const read = readJson(journal, overrides);
        const entries = read && Array.isArray(read.entries) ? read.entries : [];
        return entries
            .filter(entry => entry && typeof entry.tag === 'string' && !entry.tag.includes('/') && !entry.tag.includes('\\'))
            .sort((a, b) => (Number(a.idx) || 0) - (Number(b.idx) || 0))
            .map(entry => ({ path: path.join(folder, `${entry.tag}.sql`), name: `${entry.tag}.sql` }))
            .filter(file => isFile(file.path));
    }
    const nested = list(folder)
        .filter(name => /^\d{14}/.test(name) && isFile(path.join(folder, name, 'migration.sql')) && isFile(path.join(folder, name, 'snapshot.json')))
        .map(name => ({ path: path.join(folder, name, 'migration.sql'), name }));
    if (nested.length > 0 || !isDefault) {
        return nested;
    }
    return list(folder).filter(name => /^\d{4}_.*\.sql$/.test(name) && isFile(path.join(folder, name))).map(name => ({ path: path.join(folder, name), name }));
}

// The migration files of a layout in a folder, in the order the tool applies them: [{ path, name }]
// (name: the file name, or the folder of a migration that has one). quick: only the first file is
// read for the sections of dbmate and goose (detection).
function layoutFiles(layout, folderName, folder, overrides, quick) {
    let files = [];
    if (layout.id === 'drizzle') {
        files = drizzleFiles(folder, folderName === 'drizzle', overrides);
    } else if (layout.nested) {
        // prisma migrate needs its lock file in a folder of another name than prisma/...
        if (layout.lock && !folderName.startsWith('prisma/') && !isFile(path.join(folder, layout.lock))) {
            return [];
        }
        files = list(folder)
            .filter(name => /^\d/.test(name) && isFile(path.join(folder, name, layout.nested)))
            .map(name => ({ path: path.join(folder, name, layout.nested), name }));
    } else {
        const recursive = layout.recursive && folderName !== '.';
        // A folder reached again through symbolic links is read once, and a link to the folder
        // itself or to a parent of it (a loop) is not followed
        const root = recursive ? realPath(folder) || path.resolve(folder) : null;
        const seen = new Set([root]);
        const inLoop = (real) => !real || seen.has(real) || root.startsWith(real.endsWith(path.sep) ? real : real + path.sep);
        const walk = (dir, depth) => {
            for (const name of list(dir)) {
                const entry = path.join(dir, name);
                const info = stat(entry);
                if (info && info.isDirectory() && recursive && depth < 8 && !name.startsWith('.')) {
                    const real = realPath(entry);
                    if (inLoop(real)) {
                        continue;
                    }
                    seen.add(real);
                    walk(entry, depth + 1);
                } else if (info && info.isFile() && layout.file.test(name) && !(layout.exclude && layout.exclude.test(name))) {
                    files.push({ path: entry, name });
                }
            }
        };
        walk(folder, 0);
    }
    if (layout.marker && files.length > 0) {
        // dbmate and goose keep the up and down sections in one file, marked
        const sorted = [...files].sort(layout.order);
        const marked = (quick ? sorted.slice(0, 1) : sorted).some(file => sectionsOf(readText(file.path, overrides) || '') === layout.marker);
        if (!marked) {
            return [];
        }
    }
    // drizzle-kit: in the order of its journal (its files are listed in it)
    return layout.id === 'drizzle' ? files : files.sort(layout.order);
}

// The dialect that the output of an ORM tells: the provider of prisma migrate's lock file, the
// dialect of drizzle-kit's journal or snapshot
function stackDialect(layout, folder, files, overrides) {
    if (layout.lock) {
        const provider = /^\s*provider\s*=\s*"([^"]+)"/m.exec(readText(path.join(folder, layout.lock), overrides) || '');
        return provider ? DIALECTS[provider[1]] || null : null;
    }
    if (layout.journal) {
        const journal = readJson(path.join(folder, layout.journal), overrides);
        const snapshot = journal ? null : files.length > 0 && readJson(path.join(path.dirname(files[0].path), 'snapshot.json'), overrides);
        const dialect = (journal || snapshot || {}).dialect;
        return typeof dialect === 'string' ? DIALECTS[dialect] || null : null;
    }
    return null;
}

// The SQL files of basePath: { layout, folder, recursive, files: [{ path, name }], dialect, score },
// or null. options: overrides; stacks: (id) → whether the ORM is detected, whose output is then not
// taken for plain SQL (detection); quick: see layoutFiles(); any: the .sql files of basePath as a
// last resort, in name order (when the framework is set to sql).
function locate(basePath, options = {}) {
    const overrides = options.overrides || null;
    for (const layout of LAYOUTS) {
        if (layout.files) {
            for (const name of layout.files) {
                const file = path.resolve(basePath, name);
                if (isFile(file)) {
                    return { layout, folder: null, recursive: false, files: [{ path: file, name: path.basename(file) }], dialect: null, score: layout.id === 'rails' ? SCORE_MIGRATIONS : SCORE_DUMP };
                }
            }
            continue;
        }
        for (const name of layout.folders) {
            const folder = name === '.' ? path.resolve(basePath) : path.resolve(basePath, name);
            if (!isDirectory(folder)) {
                continue;
            }
            const files = layoutFiles(layout, name, folder, overrides, options.quick);
            if (files.length === 0) {
                continue;
            }
            if (layout.stack && options.stacks && options.stacks(layout.stack)) {
                break;
            }
            return {
                layout,
                folder,
                recursive: Boolean((layout.recursive || layout.nested || layout.journal) && name !== '.'),
                files,
                dialect: layout.dialect || stackDialect(layout, folder, files, overrides),
                score: name === '.' ? SCORE_DUMP : SCORE_MIGRATIONS,
            };
        }
    }
    if (options.any) {
        const files = list(basePath).filter(name => name.endsWith('.sql') && isFile(path.join(basePath, name))).map(name => ({ path: path.join(basePath, name), name }));
        if (files.length > 0) {
            return { layout: { id: 'files', order: byName }, folder: path.resolve(basePath), recursive: false, files, dialect: null, score: 0 };
        }
    }
    return null;
}

// The sources of a location (docs/parsers.md): the folder of the migrations (its sub-folders too
// for Flyway and the migrations that have a folder) or the dump, the lock file or journal of an
// ORM; every place looked for while there is none, so that creating one refreshes the diagram
function sourcesOf(basePath, location) {
    if (location && location.folder) {
        const files = [];
        if (location.layout.lock) {
            files.push(path.join(location.folder, location.layout.lock));
        }
        if (location.layout.journal) {
            files.push(path.join(location.folder, location.layout.journal));
        }
        return { folders: [{ path: location.folder, recursive: location.recursive }], files, extensions: ['.sql'] };
    }
    if (location) {
        return { folders: [], files: location.files.map(file => file.path), extensions: ['.sql'] };
    }
    const folders = [];
    const files = [];
    for (const layout of LAYOUTS) {
        for (const name of (layout.folders || []).filter(folder => folder !== '.')) {
            const folder = path.resolve(basePath, name);
            if (!folders.some(other => other.path === folder)) {
                folders.push({ path: folder, recursive: Boolean(layout.recursive || layout.nested || layout.journal) });
            }
        }
        files.push(...(layout.files || []).map(name => path.resolve(basePath, name)));
    }
    return { folders, files, extensions: ['.sql'] };
}

// The dialect that the folders of the migrations, or the name of the dump, tell (migrations/sqlite,
// migrate/postgres, mysql-schema.sql), for SQL that only one dialect would not tell
function pathDialect(location) {
    return namesDialect([...(location.folder ? location.folder.split(/[\\/]/).slice(-3) : []), ...location.files.slice(0, 1).map(file => path.basename(file.path, '.sql'))]);
}

// The dialect of the last of these names that tells one, or null
function namesDialect(names) {
    for (const name of [...names].reverse()) {
        const word = (/^(postgres(?:ql)?|pg(?:sql)?|mysql|mariadb|sqlite3?|libsql|turso)(?:\b|[-_])/i.exec(name) || [])[1];
        if (word) {
            return /^(?:postgres|pg)/i.test(word) ? 'postgresql' : /^(?:mysql|mariadb)/i.test(word) ? 'mysql' : 'sqlite';
        }
    }
    return null;
}

// Whether the stack `id` (prisma, drizzle) is detected in basePath: its SQL output is then not taken
// for a project of plain SQL
function stackDetected(basePath, id) {
    try {
        return Number(require(`./${id}`).detect(basePath)) > 0;
    } catch {
        return false;
    }
}

// The files to replay up to `until` (a migration name, a file name, or a path from the folder of the
// migrations): the migrations after it are skipped. A name that is none of them keeps the
// migrations the tool orders before it.
function filesUntil(location, until) {
    if (typeof until !== 'string') {
        return location.files;
    }
    const matches = (file) => file.name === until || path.basename(file.path) === until
        || (location.folder !== null && toPosix(path.relative(location.folder, file.path)) === toPosix(until));
    const at = location.files.findIndex(matches);
    if (at !== -1) {
        return location.files.slice(0, at + 1);
    }
    const order = location.layout.order || byName;
    const probe = { name: until, path: until };
    return location.files.filter(file => order(file, probe) <= 0);
}

// ---------------------------------------------------------------------------------------------
// Parser contract (docs/parsers.md)

module.exports.id = 'sql';
module.exports.label = 'SQL';

// 45 for the migrations of a SQL migration tool (supabase/migrations, Flyway's V1__*.sql, dbmate,
// golang-migrate's *.up.sql, goose, diesel, numbered migrations...) or Rails' db/structure.sql; 40
// for a dump (schema.sql, structure.sql... at the root or in db/) or migrations directly in the
// framework folder. Below the frameworks: a Laravel, Prisma or Drizzle project wins, and the output
// folders of prisma migrate and drizzle-kit are only read when their stack is not detected.
module.exports.detect = function (basePath) {
    if (typeof basePath !== 'string' || !isDirectory(basePath)) {
        return 0;
    }
    const location = locate(basePath, { stacks: (id) => stackDetected(basePath, id), quick: true });
    return location ? location.score : 0;
};

// The files read: the folder of the migrations (.sql files), or the dump; the places looked for
// while there is none
function sources(basePath, options = {}) {
    return sourcesOf(basePath, locate(basePath, { overrides: (options && options.overrides) || null, any: true }));
}
module.exports.sources = sources;

// Returns { tables, warnings }. Options:
// - git: false skips the git status
// - overrides: Map of absolute file path → text of an unsaved editor, read instead of the file
// - gitCache: Map kept between parses, to run git again only once it is cleared
// - columnSources: true adds the statement that declared or last changed each column (source)
// - until: a migration (a file name, the folder of a migration, or a path from the migrations
//   folder): the schema right after it, the later migrations skipped
// - details: true adds the column details (length, default...), the indexes and the referential
//   actions (docs/pivot-format.md)
module.exports.parse = function (basePath, options = {}) {
    const overrides = options.overrides || null;
    const location = locate(basePath, { overrides, any: true });
    if (!location) {
        throw new ParserError(`No SQL files found in ${basePath}: DrawMeDatabase reads the migrations of supabase/migrations, Flyway (db/migration/V1__*.sql), dbmate, golang-migrate (*.up.sql), goose, diesel, prisma migrate or drizzle-kit, Rails' db/structure.sql, or a dump (schema.sql, structure.sql...) at the root or in db/.`);
    }
    const files = [];
    const warnings = [];
    if (location.layout.id === 'supabase') {
        // The Supabase CLI skips the files whose name is not <timestamp>_<name>.sql, and tells it
        for (const name of list(location.folder).filter(other => other.endsWith('.sql') && !location.layout.file.test(other))) {
            warnings.push(`${toPosix(path.relative(basePath, path.join(location.folder, name)))}: skipped, as the Supabase CLI does: a migration is named <timestamp>_<name>.sql.`);
        }
    }
    for (const file of filesUntil(location, options.until)) {
        const text = readText(file.path, overrides);
        if (text !== null) {
            files.push({ path: file.path, rel: toPosix(path.relative(basePath, file.path)), text, sections: location.layout.files ? null : sectionsOf(text) });
        }
    }
    const state = replay(files, { dialect: location.dialect, hint: pathDialect(location), skip: (ref) => BOOKKEEPING.has(ref.name.toLowerCase()) || /^sqlite_/i.test(ref.name) });
    state.warnings.unshift(...warnings);
    const reader = createStatusReader(sourcesOf(basePath, location), { git: options.git !== false, overrides, cache: options.gitCache });
    if (reader.warning) {
        state.warnings.push(reader.warning);
    }
    return { tables: toPivot(state, basePath, reader, options), warnings: state.warnings };
};

// A schema dump read for another parser (the database/schema/<connection>-schema.sql of Laravel):
// { tables (see tableModels()), rows (of the table `collect`: [{ column: value }] or [[value]]),
// warnings, dialect }. file: { path, rel, text }; options: skip (names of tables not drawn, lower
// case, besides the tables of the migration tools), collect.
function readDump(file, options = {}) {
    const skip = new Set(options.skip || []);
    const state = replay([{ ...file, sections: null }], {
        hint: namesDialect([path.basename(file.path).replace(/\.\w+$/, '')]),
        skip: (ref) => skip.has(ref.name.toLowerCase()) || BOOKKEEPING.has(ref.name.toLowerCase()) || /^sqlite_/i.test(ref.name),
        collect: options.collect,
    });
    return { tables: tableModels(state), rows: state.rows ? state.rows.values : [], warnings: state.warnings, dialect: state.dialect };
}

// For the other parsers and the tests: the statements of SQL text, the replay of SQL files, their
// tables, where the SQL files of a project are, and a schema dump read for another parser
module.exports.scanStatements = scanStatements;
module.exports.sniffDialect = sniffDialect;
module.exports.replay = replay;
module.exports.toPivot = toPivot;
module.exports.locate = locate;
module.exports.readDump = readDump;

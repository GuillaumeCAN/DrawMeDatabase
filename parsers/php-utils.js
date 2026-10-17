//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Small helpers to scan PHP source code without a full parser.
// They know about string literals (quoted strings, heredoc, nowdoc) and comments,
// so that brackets, semicolons and commas inside them are not mistaken for code.

const OPENERS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);
const HEREDOC_START = /<<<[ \t]*(["']?)([A-Za-z_]\w*)\1\r?\n/y;

// Returns the index just after the literal starting at `i`, or -1 if no literal starts there
function skipLiteral(src, i) {
    const c = src[i];

    if (c === "'" || c === '"' || c === '`') {
        let j = i + 1;
        while (j < src.length) {
            if (src[j] === '\\') {
                j += 2;
            } else if (src[j] === c) {
                return j + 1;
            } else {
                j++;
            }
        }
        return src.length;
    }

    if (c === '<' && src.startsWith('<<<', i)) {
        HEREDOC_START.lastIndex = i;
        const match = HEREDOC_START.exec(src);
        if (match) {
            const closing = new RegExp(`\\n[ \\t]*${match[2]}\\b`, 'g');
            closing.lastIndex = HEREDOC_START.lastIndex - 1;
            const end = closing.exec(src);
            return end ? end.index + end[0].length : src.length;
        }
    }

    return -1;
}

// Replaces every character but line breaks with a space, to keep offsets and line numbers
const blank = (text) => text.replace(/[^\r\n]/g, ' ');

// Replaces comments with spaces (line breaks are kept), so offsets and line numbers don't move.
// `#[` starts an attribute, not a comment. With `keepDocComments`, `/** ... */` blocks are kept
// as they are, for annotation parsing.
function stripComments(src, { keepDocComments = false } = {}) {
    const chunks = [];
    let last = 0;
    let i = 0;

    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];

        const literalEnd = skipLiteral(src, i);
        if (literalEnd !== -1) {
            i = literalEnd;
            continue;
        }

        let end = -1;
        let keep = false;
        if (c === '/' && next === '*') {
            end = src.indexOf('*/', i + 2);
            end = end === -1 ? src.length : end + 2;
            keep = keepDocComments && src[i + 2] === '*' && src[i + 3] !== '/';
        } else if ((c === '/' && next === '/') || (c === '#' && next !== '[')) {
            end = i;
            while (end < src.length && src[end] !== '\n' && !src.startsWith('?>', end)) {
                end++;
            }
        }

        if (end === -1) {
            i++;
            continue;
        }

        if (!keep) {
            chunks.push(src.slice(last, i), blank(src.slice(i, end)));
            last = end;
        }
        i = end;
    }

    chunks.push(src.slice(last));
    return chunks.join('');
}

// Index of the bracket closing the one at `openIndex`, or -1. Expects code without comments.
function findMatching(src, openIndex) {
    if (!OPENERS[src[openIndex]]) {
        return -1;
    }

    const stack = [];
    let i = openIndex;
    while (i < src.length) {
        const literalEnd = skipLiteral(src, i);
        if (literalEnd !== -1) {
            i = literalEnd;
            continue;
        }

        const c = src[i];
        if (OPENERS[c]) {
            stack.push(OPENERS[c]);
        } else if (CLOSERS.has(c)) {
            if (stack.pop() !== c) {
                return -1;
            }
            if (stack.length === 0) {
                return i;
            }
        }
        i++;
    }
    return -1;
}

// Splits `src` on `separator` when it is outside brackets and literals.
// Pieces are trimmed and empty pieces are dropped. Expects code without comments.
function splitTopLevel(src, separator = ',') {
    const pieces = [];
    let depth = 0;
    let start = 0;
    let i = 0;

    while (i < src.length) {
        const literalEnd = skipLiteral(src, i);
        if (literalEnd !== -1) {
            i = literalEnd;
            continue;
        }

        const c = src[i];
        if (OPENERS[c]) {
            depth++;
        } else if (CLOSERS.has(c)) {
            depth--;
        } else if (c === separator && depth === 0) {
            pieces.push(src.slice(start, i));
            start = i + 1;
        }
        i++;
    }
    pieces.push(src.slice(start));

    return pieces.map(piece => piece.trim()).filter(piece => piece.length > 0);
}

const DOUBLE_QUOTE_ESCAPES = { n: '\n', t: '\t', r: '\r', v: '\v', e: '\x1b', f: '\f', '0': '\0', '\\': '\\', '$': '$', '"': '"' };

// Value of a quoted PHP string literal, or null if `text` is not one (or is interpolated)
function parseStringLiteral(text) {
    const value = text.trim();

    if (/^'(?:[^'\\]|\\[\s\S])*'$/.test(value)) {
        return value.slice(1, -1).replace(/\\(['\\])/g, '$1');
    }

    if (/^"(?:[^"\\]|\\[\s\S])*"$/.test(value)) {
        const body = value.slice(1, -1);
        if (/(^|[^\\])(\\\\)*\$[A-Za-z_{]/.test(body) || /(^|[^\\])(\\\\)*\{\$/.test(body)) {
            return null;
        }
        return body.replace(/\\([ntrvef0\\$"])/g, (_, c) => DOUBLE_QUOTE_ESCAPES[c]);
    }

    return null;
}

// Splits a call's argument list into [{ name, value }], `name` being set for named arguments
function parseArgs(argsSrc) {
    return splitTopLevel(argsSrc, ',').map(arg => {
        const named = /^([A-Za-z_]\w*)\s*:(?!:)\s*([\s\S]*)$/.exec(arg);
        return named ? { name: named[1], value: named[2].trim() } : { name: null, value: arg };
    });
}

// Elements of a `[...]` or `array(...)` literal as raw strings, or null if `text` is not one
function parseArrayLiteral(text) {
    const value = text.trim();
    let open = -1;
    if (value.startsWith('[')) {
        open = 0;
    } else {
        const match = /^array\s*\(/i.exec(value);
        if (match) {
            open = match[0].length - 1;
        }
    }

    if (open === -1 || findMatching(value, open) !== value.length - 1) {
        return null;
    }
    return splitTopLevel(value.slice(open + 1, -1), ',');
}

// Returns a function giving the 1-based line number of an offset in `src`
function createLineLocator(src) {
    const lineStarts = [0];
    for (let i = 0; i < src.length; i++) {
        if (src[i] === '\n') {
            lineStarts.push(i + 1);
        }
    }

    return (index) => {
        let low = 0;
        let high = lineStarts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (lineStarts[mid] <= index) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return low + 1;
    };
}

module.exports = {
    skipLiteral,
    stripComments,
    findMatching,
    splitTopLevel,
    parseStringLiteral,
    parseArgs,
    parseArrayLiteral,
    createLineLocator,
};

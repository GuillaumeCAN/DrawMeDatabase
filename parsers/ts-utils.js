//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Reads TypeScript and JavaScript code without running it, for the parsers of the ORMs whose schema
// is code (Drizzle): a tokenizer, a parser of expressions, and a scan of the top-level statements of
// a module (imports, exports, declarations). It is not a full TypeScript parser: the types are
// skipped, the statements other than declarations are passed over, and a construct it cannot read
// becomes an `Unknown` node instead of an error.

// Nesting read at most (templates in templates, calls in calls...): deeper code is Unknown
const MAX_DEPTH = 64;
// Punctuators of more than one character, longest first. '>' is always a token of its own, so that
// the end of nested generic types is found (`Array<Array<T>>`); '>=' and '>>' are read by the parser.
const PUNCTUATORS = ['...', '===', '!==', '**=', '<<=', '??=', '&&=', '||=', '=>', '==', '!=', '<=', '**', '++', '--', '<<', '&&', '||', '??', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='];
// Tokens after which a '/' starts a regular expression, not a division
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '=>', '&&', '||', '??', '==', '===', '!=', '!==', '<=', '+=', '-=', '*=', '/=', '%=', '...']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'instanceof', 'new', 'void', 'delete', 'throw', 'yield', 'await']);
// Binary operators and their precedence
const BINARY = new Map([
    ['??', 1], ['||', 2], ['&&', 3], ['|', 4], ['^', 5], ['&', 6],
    ['==', 7], ['!=', 7], ['===', 7], ['!==', 7],
    ['<', 8], ['>', 8], ['<=', 8], ['>=', 8], ['instanceof', 8], ['in', 8],
    ['<<', 9], ['>>', 9], ['>>>', 9],
    ['+', 10], ['-', 10], ['*', 11], ['/', 11], ['%', 11], ['**', 12],
]);
const UNARY = new Set(['!', '-', '+', '~', 'typeof', 'void', 'delete', 'await']);
// Words that start a statement: an expression never continues on them
const STATEMENT_WORDS = new Set(['import', 'export', 'const', 'let', 'var', 'function', 'class', 'enum', 'interface', 'type', 'declare', 'namespace', 'module', 'abstract', 'if', 'for', 'while', 'do', 'switch', 'try', 'return', 'throw', 'break', 'continue']);

const isIdentifierStart = (c) => /[A-Za-z_$\u00a0-\uffff]/.test(c);
const isIdentifierPart = (c) => /[\w$\u00a0-\uffff]/.test(c);

// ---------------------------------------------------------------------------------------------
// Tokens

// Decodes the escapes of the text of a string literal
function unescape(raw) {
    return raw.replace(/\\(?:u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|x([\da-fA-F]{2})|([0-7]{1,3})|(\r\n|[\s\S]))/g, (all, codePoint, unicode, hex, octal, char) => {
        if (codePoint || unicode || hex) {
            const value = parseInt(codePoint || unicode || hex, 16);
            return value <= 0x10ffff ? String.fromCodePoint(value) : '';
        }
        if (octal) {
            return octal === '0' ? '\0' : String.fromCharCode(parseInt(octal, 8));
        }
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
        if (char === '\n' || char === '\r\n' || char === '\r' || char === '\u2028' || char === '\u2029') {
            return '';
        }
        return Object.prototype.hasOwnProperty.call(escapes, char) ? escapes[char] : char;
    });
}

// The tokens of text from `start`: [{ type, value, start, end, newline }], type 'name', 'string'
// (value: the decoded text), 'number', 'template' ({ quasis: raw texts, subs: token lists of the
// ${...}), 'regex', 'punct'. newline: a line break before the token. With `inTemplate`, stops at the
// `}` that closes a ${...} substitution. Returns { tokens, end }.
function tokenizeFrom(text, start, inTemplate, depth) {
    const tokens = [];
    let i = start;
    let braces = 0;
    let newline = false;
    const push = (token) => {
        token.newline = newline;
        newline = false;
        tokens.push(token);
    };
    while (i < text.length) {
        const c = text[i];
        if (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') {
            newline = true;
            i++;
            continue;
        }
        if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === '\ufeff' || c === '\u00a0') {
            i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n' && text[i] !== '\r') {
                i++;
            }
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            const comment = text.slice(i, end === -1 ? text.length : end);
            if (/[\n\r\u2028\u2029]/.test(comment)) {
                newline = true;
            }
            i = end === -1 ? text.length : end + 2;
            continue;
        }
        if (c === '"' || c === '\'') {
            let j = i + 1;
            // A string not closed on its line (being typed) ends at the line break
            while (j < text.length && text[j] !== c && text[j] !== '\n') {
                j += text[j] === '\\' ? 2 : 1;
            }
            push({ type: 'string', value: unescape(text.slice(i + 1, Math.min(j, text.length))), start: i, end: Math.min(j + 1, text.length) });
            i = Math.min(j + 1, text.length);
            continue;
        }
        if (c === '`') {
            const template = readTemplate(text, i, depth);
            push({ type: 'template', quasis: template.quasis, subs: template.subs, start: i, end: template.end });
            i = template.end;
            continue;
        }
        if (/\d/.test(c) || (c === '.' && /\d/.test(text[i + 1] || ''))) {
            const number = /^(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/.exec(text.slice(i, i + 400));
            const raw = number ? number[0] : c;
            push({ type: 'number', value: raw, start: i, end: i + raw.length });
            i += raw.length;
            continue;
        }
        if (isIdentifierStart(c) || (c === '#' && isIdentifierStart(text[i + 1] || ''))) {
            let j = i + 1;
            while (j < text.length && isIdentifierPart(text[j])) {
                j++;
            }
            push({ type: 'name', value: text.slice(i, j), start: i, end: j });
            i = j;
            continue;
        }
        if (c === '/') {
            const previous = tokens[tokens.length - 1];
            const regex = !previous
                || (previous.type === 'punct' && REGEX_AFTER.has(previous.value))
                || (previous.type === 'name' && REGEX_KEYWORDS.has(previous.value));
            if (regex) {
                let j = i + 1;
                let inClass = false;
                while (j < text.length && text[j] !== '\n' && (inClass || text[j] !== '/')) {
                    if (text[j] === '\\') {
                        j++;
                    } else if (text[j] === '[') {
                        inClass = true;
                    } else if (text[j] === ']') {
                        inClass = false;
                    }
                    j++;
                }
                j++;
                while (j < text.length && /[a-z]/i.test(text[j])) {
                    j++;
                }
                push({ type: 'regex', value: text.slice(i, Math.min(j, text.length)), start: i, end: Math.min(j, text.length) });
                i = Math.min(j, text.length);
                continue;
            }
        }
        if (inTemplate) {
            if (c === '{') {
                braces++;
            } else if (c === '}') {
                if (braces === 0) {
                    return { tokens, end: i };
                }
                braces--;
            }
        }
        const punct = PUNCTUATORS.find(p => text.startsWith(p, i) && !(p === '?.' && /\d/.test(text[i + 2] || ''))) || (text.startsWith('?.', i) && !/\d/.test(text[i + 2] || '') ? '?.' : c);
        push({ type: 'punct', value: punct, start: i, end: i + punct.length });
        i += punct.length;
    }
    return { tokens, end: text.length };
}

// A template literal from text[i] = '`': { quasis, subs, end }. Substitutions nested deeper than
// MAX_DEPTH are not tokenized.
function readTemplate(text, i, depth) {
    const quasis = [];
    const subs = [];
    let j = i + 1;
    let chunk = j;
    while (j < text.length) {
        const c = text[j];
        if (c === '\\') {
            j += 2;
        } else if (c === '`') {
            quasis.push(text.slice(chunk, j));
            return { quasis, subs, end: j + 1 };
        } else if (c === '$' && text[j + 1] === '{') {
            quasis.push(text.slice(chunk, j));
            if (depth >= MAX_DEPTH) {
                // Too deep: the rest of the template is not read
                return { quasis, subs, end: text.length };
            }
            const inner = tokenizeFrom(text, j + 2, true, depth + 1);
            subs.push(inner.tokens);
            j = inner.end + 1;
            chunk = j;
        } else {
            j++;
        }
    }
    quasis.push(text.slice(chunk, text.length));
    return { quasis, subs, end: text.length };
}

// The tokens of a whole text (a UTF-8 BOM is skipped)
function tokenize(text) {
    return tokenizeFrom(String(text), 0, false, 0).tokens;
}

// For a token list, the index of the closing bracket of each opening one ('(', '[', '{'), the end
// of the list when it is not closed
function matchBrackets(tokens) {
    const match = new Int32Array(tokens.length).fill(-1);
    const stack = [];
    const closers = { ')': '(', ']': '[', '}': '{' };
    tokens.forEach((token, index) => {
        if (token.type !== 'punct') {
            return;
        }
        if (token.value === '(' || token.value === '[' || token.value === '{') {
            stack.push(index);
        } else if (closers[token.value]) {
            // A closer of another bracket (code being typed) closes the nearest matching one
            let at = stack.length - 1;
            while (at >= 0 && tokens[stack[at]].value !== closers[token.value]) {
                at--;
            }
            if (at !== -1) {
                while (stack.length > at) {
                    match[stack.pop()] = index;
                }
            }
        }
    });
    while (stack.length > 0) {
        match[stack.pop()] = tokens.length;
    }
    return match;
}

// A token list ready for the parser: { tokens, match }
function context(tokens) {
    return { tokens, match: matchBrackets(tokens) };
}

// ---------------------------------------------------------------------------------------------
// Expressions

const isPunct = (token, value) => Boolean(token) && token.type === 'punct' && token.value === value;
const isName = (token, value) => Boolean(token) && token.type === 'name' && (value === undefined || token.value === value);
// Whether two tokens touch (`>` `=` read as '>=')
const touches = (a, b) => Boolean(a && b) && a.end === b.start;

// The node of the tokens from..to (excluded) that cannot be read
const unknownNode = (ctx, from, to) => ({
    type: 'Unknown',
    start: ctx.tokens[Math.min(from, ctx.tokens.length - 1)] ? ctx.tokens[Math.min(from, ctx.tokens.length - 1)].start : 0,
    end: ctx.tokens[Math.max(Math.min(to, ctx.tokens.length) - 1, 0)] ? ctx.tokens[Math.max(Math.min(to, ctx.tokens.length) - 1, 0)].end : 0,
});

// The index after the bracket that opens at i
const after = (ctx, i) => (ctx.match[i] >= 0 ? ctx.match[i] + 1 : ctx.tokens.length);

// Tokens read at most to find the end of generic arguments (the brackets in them count as one)
const MAX_ANGLE_TOKENS = 1000;

// Skips generic arguments `<...>` at i: the index after the `>`, or -1 when the tokens are not type
// arguments (a comparison), or when they end after `end`. Results are kept per token.
function skipAngles(ctx, i, end) {
    if (!ctx.angles) {
        ctx.angles = new Map();
    }
    if (!ctx.angles.has(i)) {
        ctx.angles.set(i, findAngleEnd(ctx, i));
    }
    const close = ctx.angles.get(i);
    return close !== -1 && close <= end ? close : -1;
}

function findAngleEnd(ctx, i) {
    const end = ctx.tokens.length;
    let depth = 0;
    let j = i;
    for (let read = 0; j < end && read < MAX_ANGLE_TOKENS; read++) {
        const token = ctx.tokens[j];
        if (token.type === 'punct') {
            if (token.value === '<') {
                depth++;
            } else if (token.value === '>') {
                depth--;
                if (depth === 0) {
                    return j + 1;
                }
            } else if (token.value === '(' || token.value === '[' || token.value === '{') {
                j = after(ctx, j);
                continue;
            } else if ([';', ')', ']', '}', '&&', '||', '==', '===', '!=', '!=='].includes(token.value)) {
                return -1;
            }
        }
        j++;
    }
    return -1;
}

// Skips a type from i: the index after it. A type ends at a token that cannot continue it, at the
// bracket depth of i (',', ')', '=', a new statement...).
function skipType(ctx, i, end, depth = 0) {
    const { tokens } = ctx;
    if (depth > MAX_DEPTH) {
        return end;
    }
    let j = i;
    // A leading | or & of a multi-line union
    while (j < end && (isPunct(tokens[j], '|') || isPunct(tokens[j], '&'))) {
        j++;
    }
    for (;;) {
        if (j >= end) {
            return end;
        }
        const token = tokens[j];
        // Prefixes
        if (isName(token) && ['keyof', 'typeof', 'readonly', 'unique', 'infer', 'asserts', 'new', 'abstract'].includes(token.value)
            && j + 1 < end && (tokens[j + 1].type === 'name' || isPunct(tokens[j + 1], '(') || isPunct(tokens[j + 1], '[') || isPunct(tokens[j + 1], '{'))) {
            j++;
            continue;
        }
        // An atom
        if (isPunct(token, '(')) {
            j = after(ctx, j);
            // A function type
            if (isPunct(tokens[j], '=>')) {
                return skipType(ctx, j + 1, end, depth + 1);
            }
        } else if (isPunct(token, '[') || isPunct(token, '{')) {
            j = after(ctx, j);
        } else if (isPunct(token, '<')) {
            // Generic function type <T>(x: T) => T
            const next = skipAngles(ctx, j, end);
            j = next === -1 ? j + 1 : next;
            continue;
        } else if (token.type === 'name' || token.type === 'string' || token.type === 'number' || token.type === 'template') {
            j++;
            while (j + 1 < end && isPunct(tokens[j], '.') && tokens[j + 1].type === 'name') {
                j += 2;
            }
            if (isPunct(tokens[j], '<')) {
                const next = skipAngles(ctx, j, end);
                if (next !== -1) {
                    j = next;
                }
            }
        } else if (isPunct(token, '-') && tokens[j + 1] && tokens[j + 1].type === 'number') {
            j += 2;
        } else {
            return j;
        }
        // Postfixes: T[], T[K]
        while (j < end && isPunct(tokens[j], '[') && !tokens[j].newline) {
            j = after(ctx, j);
        }
        // Unions, intersections, conditional types
        if (j < end && (isPunct(tokens[j], '|') || isPunct(tokens[j], '&'))) {
            j++;
            continue;
        }
        if (j < end && isName(tokens[j], 'extends') && !tokens[j].newline) {
            j++;
            continue;
        }
        if (j < end && isName(tokens[j], 'is')) {
            j++;
            continue;
        }
        if (j < end && isPunct(tokens[j], '?') && depth >= 0) {
            // T extends U ? X : Y
            const consequent = skipType(ctx, j + 1, end, depth + 1);
            if (isPunct(tokens[consequent], ':')) {
                return skipType(ctx, consequent + 1, end, depth + 1);
            }
            return j;
        }
        return j;
    }
}

// Whether the tokens from i (a '(' or a name) start an arrow function: { paramsEnd, arrow } with
// the index of the '=>'
function arrowAt(ctx, i, end) {
    const { tokens } = ctx;
    let j = i;
    if (isName(tokens[j], 'async') && tokens[j + 1] && !tokens[j + 1].newline && (isPunct(tokens[j + 1], '(') || isName(tokens[j + 1]))) {
        j++;
    }
    if (isPunct(tokens[j], '<')) {
        const next = skipAngles(ctx, j, end);
        if (next === -1) {
            return null;
        }
        j = next;
    }
    if (isName(tokens[j]) && isPunct(tokens[j + 1], '=>')) {
        return { single: tokens[j].value, arrow: j + 1, start: i };
    }
    if (!isPunct(tokens[j], '(')) {
        return null;
    }
    const close = ctx.match[j];
    if (close < 0 || close >= end) {
        return null;
    }
    let k = close + 1;
    if (isPunct(tokens[k], ':')) {
        k = skipType(ctx, k + 1, end);
    }
    return isPunct(tokens[k], '=>') ? { params: [j + 1, close], arrow: k, start: i } : null;
}

// The top-level items of tokens from..to separated by commas: [[from, to]...]
function splitList(ctx, from, to) {
    const items = [];
    let start = from;
    let j = from;
    while (j < to) {
        const token = ctx.tokens[j];
        if (isPunct(token, '(') || isPunct(token, '[') || isPunct(token, '{')) {
            j = Math.min(after(ctx, j), to);
            continue;
        }
        // Generic arguments hold commas: `$type<Record<string, number>>()`, `(x: Map<K, V>)`
        if (isPunct(token, '<') && j > from && (ctx.tokens[j - 1].type === 'name' || isPunct(ctx.tokens[j - 1], '.'))) {
            const close = skipAngles(ctx, j, to);
            if (close !== -1) {
                j = close;
                continue;
            }
        }
        if (isPunct(token, ',')) {
            items.push([start, j]);
            start = j + 1;
        }
        j++;
    }
    if (start < to) {
        items.push([start, to]);
    }
    return items;
}

// The parameters of a function between from..to: [{ name } | { names: [{ key, local }] } | {}]
function readParams(ctx, from, to) {
    const { tokens } = ctx;
    return splitList(ctx, from, to).map(([a, b]) => {
        let j = a;
        while (j < b && (isName(tokens[j], 'public') || isName(tokens[j], 'private') || isName(tokens[j], 'protected') || isName(tokens[j], 'readonly'))) {
            j++;
        }
        if (isPunct(tokens[j], '...')) {
            return { rest: isName(tokens[j + 1]) ? tokens[j + 1].value : null };
        }
        if (isName(tokens[j])) {
            const param = { name: tokens[j].value };
            // A default value: (name = 'x')
            const equals = tokens.slice(j, b).findIndex(token => isPunct(token, '='));
            if (equals !== -1) {
                const parsed = parseExpression(ctx, j + equals + 1, b);
                param.default = parsed.node;
            }
            return param;
        }
        if (isPunct(tokens[j], '{')) {
            const close = Math.min(after(ctx, j) - 1, b);
            // { key }, { key: local }, and their default values ({ key = 1 }, { key: local = 1 })
            const names = splitList(ctx, j + 1, close).map(([c, d]) => {
                const renamed = isName(tokens[c]) && isPunct(tokens[c + 1], ':') && isName(tokens[c + 2]);
                if (!renamed && !(isName(tokens[c]) && c < d)) {
                    return null;
                }
                const name = { key: tokens[c].value, local: tokens[renamed ? c + 2 : c].value };
                const equals = renamed ? c + 3 : c + 1;
                if (equals < d && isPunct(tokens[equals], '=')) {
                    name.default = parseExpression(ctx, equals + 1, d).node;
                }
                return name;
            }).filter(Boolean);
            const param = { names };
            // The default value of the whole parameter: ({ size = 1 }: Options = {})
            let k = close + 1;
            if (isPunct(tokens[k], '?')) {
                k++;
            }
            if (isPunct(tokens[k], ':')) {
                k = skipType(ctx, k + 1, b);
            }
            if (k < b && isPunct(tokens[k], '=')) {
                param.default = parseExpression(ctx, k + 1, b).node;
            }
            return param;
        }
        return {};
    });
}

// The body of an arrow function or function at i: an expression node, or a Block
// { type: 'Block', ctx, from, to } (from..to: the tokens inside the braces)
function readBody(ctx, i, end, depth) {
    if (isPunct(ctx.tokens[i], '{')) {
        const close = Math.min(after(ctx, i) - 1, end);
        return { node: { type: 'Block', ctx, from: i + 1, to: close, start: ctx.tokens[i].start, end: ctx.tokens[Math.min(close, ctx.tokens.length - 1)].end }, next: Math.min(close + 1, end) };
    }
    return parseExpression(ctx, i, end, depth + 1);
}

// The expressions returned at the top level of a Block (not in its nested functions or blocks)
function blockReturns(block) {
    const { ctx, from, to } = block;
    const returns = [];
    let j = from;
    while (j < to) {
        const token = ctx.tokens[j];
        if (isPunct(token, '(') || isPunct(token, '[') || isPunct(token, '{')) {
            j = after(ctx, j);
            continue;
        }
        if (isName(token, 'return')) {
            const parsed = parseExpression(ctx, j + 1, to);
            returns.push(parsed.node);
            j = Math.max(parsed.next, j + 1);
            continue;
        }
        j++;
    }
    return returns;
}

// The names a destructuring pattern at i ('{' or '[') declares, its index after: { names, next }
function patternNames(ctx, i, end) {
    const { tokens } = ctx;
    const close = Math.min(after(ctx, i) - 1, end);
    const names = [];
    for (const [a, b] of splitList(ctx, i + 1, close)) {
        let j = a;
        if (isPunct(tokens[j], '...')) {
            j++;
        }
        // { key: local }, { key: { nested } }, [a, [b]]
        if (isPunct(tokens[i], '{') && isPunct(tokens[j + 1], ':')) {
            j += 2;
        }
        if (isPunct(tokens[j], '{') || isPunct(tokens[j], '[')) {
            names.push(...patternNames(ctx, j, b).names);
        } else if (isName(tokens[j])) {
            names.push(tokens[j].value);
        }
    }
    return { names, next: Math.min(close + 1, end) };
}

// The declarations at the top level of a Block (const, let, var, function), in the order of the
// code: [{ name, init, at }], init: the node of the value, or null when it cannot be read (a
// destructuring, a declaration without a value); at: the index of the token of the name (not for
// a destructuring). Kept on the block.
function blockDeclarations(block) {
    if (block.declarations) {
        return block.declarations;
    }
    const { ctx, from, to } = block;
    const { tokens } = ctx;
    const declarations = [];
    let j = from;
    while (j < to) {
        const token = tokens[j];
        const previous = tokens[j - 1];
        const statementStart = j === from || !(isPunct(previous, '.') || isPunct(previous, '?.'));
        if (statementStart && (isName(token, 'const') || isName(token, 'let') || isName(token, 'var')) && tokens[j + 1] && (isName(tokens[j + 1]) || isPunct(tokens[j + 1], '{') || isPunct(tokens[j + 1], '['))) {
            j++;
            for (;;) {
                let names;
                // A destructuring declares names whose values are not read
                let simple = false;
                const at = j;
                if (isPunct(tokens[j], '{') || isPunct(tokens[j], '[')) {
                    const pattern = patternNames(ctx, j, to);
                    names = pattern.names;
                    j = pattern.next;
                } else if (isName(tokens[j])) {
                    names = [tokens[j].value];
                    simple = true;
                    j++;
                } else {
                    break;
                }
                if (isPunct(tokens[j], '!')) {
                    j++;
                }
                if (isPunct(tokens[j], ':')) {
                    j = skipType(ctx, j + 1, to);
                }
                let init = null;
                if (isPunct(tokens[j], '=')) {
                    const parsed = parseExpression(ctx, j + 1, to);
                    init = parsed.node;
                    j = Math.max(parsed.next, j + 1);
                }
                for (const name of names) {
                    declarations.push(simple ? { name, init, at } : { name, init: null });
                }
                if (!isPunct(tokens[j], ',')) {
                    break;
                }
                j++;
            }
            continue;
        }
        if (statementStart && (isName(token, 'function') || (isName(token, 'async') && isName(tokens[j + 1], 'function')))) {
            const nameAt = isName(token, 'async') ? j + 2 : j + 1;
            const nameIndex = isPunct(tokens[nameAt], '*') ? nameAt + 1 : nameAt;
            const parsed = parseExpression(ctx, j, to);
            if (isName(tokens[nameIndex]) && parsed.node.type === 'Function') {
                declarations.push({ name: tokens[nameIndex].value, init: parsed.node, at: nameIndex });
            }
            j = Math.max(parsed.next, j + 1);
            continue;
        }
        if (isPunct(token, '(') || isPunct(token, '[') || isPunct(token, '{')) {
            j = after(ctx, j);
            continue;
        }
        j++;
    }
    block.declarations = declarations;
    return declarations;
}

// Words before the `(...)` of a statement whose `{` opens a block of statements
const BLOCK_STATEMENTS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

// The methods of an array that change it, besides push and unshift
const ARRAY_CHANGES = new Set(['pop', 'shift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);
// The assignment operators, and ++/--
const ASSIGNMENTS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '&=', '|=', '^=', '??=', '&&=', '||=', '++', '--']);
// Tokens after which a token on a new line starts a statement
const ENDS_EXPRESSION = new Set(['name', 'number', 'string', 'template', 'regex']);

// The changes made to the locals of a Block (blockDeclarations) by its statements before its
// top-level `return`: Map(name → { changes } | { unreadable: true }), only for the locals that are
// changed. A change is a statement of the top level of the block, run each time, with its start
// and end: { type: 'assign', value } (`name = value`), { type: 'property', key, value }
// (`name.key = value`, `name['key'] = value`), { type: 'push' | 'unshift', items }
// (`name.push(a, ...b)`), { type: 'merge', sources } (`Object.assign(name, a, b)`). A local changed
// in a way that cannot be read is unreadable: another operator, a change nested in an inner block,
// a condition, a loop or a function, a change that uses the local itself, another method that
// changes an array. params: the names of the parameters of the function of the block, changed the
// same way. Kept on the block.
function blockChanges(block, params = []) {
    if (block.changes) {
        return block.changes;
    }
    const { ctx, from, to } = block;
    const { tokens } = ctx;
    const changes = new Map();
    block.changes = changes;
    const declared = new Map();
    for (const declaration of blockDeclarations(block)) {
        if (declaration.at !== undefined && !declared.has(declaration.name)) {
            declared.set(declaration.name, declaration.at);
        }
    }
    for (const name of params) {
        if (!declared.has(name)) {
            declared.set(name, -1);
        }
    }
    if (declared.size === 0) {
        return changes;
    }
    const unreadable = (name) => changes.set(name, { unreadable: true });
    const add = (name, change) => {
        const entry = changes.get(name) || { changes: [] };
        if (!entry.unreadable) {
            entry.changes.push(change);
            changes.set(name, entry);
        }
    };
    // A use of a local at i (not a property `x.name`, not its declaration)
    const isLocal = (i) => isName(tokens[i]) && declared.has(tokens[i].value) && declared.get(tokens[i].value) !== i
        && !isPunct(tokens[i - 1], '.') && !isPunct(tokens[i - 1], '?.');
    // Whether the local at i is changed there: assigned, a property of it assigned, a method that
    // changes an array called on it, or given to Object.assign() first
    const changesAt = (i) => {
        if (isPunct(tokens[i - 1], '++') || isPunct(tokens[i - 1], '--') || isName(tokens[i - 1], 'delete')) {
            return true;
        }
        if (isPunct(tokens[i - 1], '(') && isName(tokens[i - 2], 'assign') && isPunct(tokens[i - 3], '.') && isName(tokens[i - 4], 'Object')) {
            return true;
        }
        let j = i + 1;
        // (cols as any).x = 1
        if (isName(tokens[j], 'as') || isName(tokens[j], 'satisfies')) {
            j = skipType(ctx, j + 1, to);
            if (isPunct(tokens[j], ')') && isPunct(tokens[i - 1], '(')) {
                j++;
            }
        }
        let member = null;
        for (;;) {
            if (isPunct(tokens[j], '!')) {
                j++;
            } else if ((isPunct(tokens[j], '.') || isPunct(tokens[j], '?.')) && isName(tokens[j + 1])) {
                member = tokens[j + 1].value;
                j += 2;
            } else if (isPunct(tokens[j], '[') && !tokens[j].newline) {
                member = null;
                j = after(ctx, j);
            } else {
                break;
            }
        }
        const next = tokens[j];
        if (next && next.type === 'punct' && ASSIGNMENTS.has(next.value)) {
            return true;
        }
        return j > i + 1 && isPunct(next, '(') && (member === 'push' || member === 'unshift' || ARRAY_CHANGES.has(member));
    };
    // Whether the top-level token at i starts a statement; lastGroup: the last bracket group
    // skipped before it ({ open, close })
    const startsStatement = (i, lastGroup) => {
        if (i === from) {
            return true;
        }
        const previous = tokens[i - 1];
        if (isPunct(previous, ';') || isPunct(previous, '}')) {
            return true;
        }
        if (isPunct(previous, ')') && lastGroup && lastGroup.close === i - 1) {
            // if (...) name.push(x): a condition
            const before = tokens[lastGroup.open - 1];
            return !(isName(before) && BLOCK_STATEMENTS.has(before.value)) && Boolean(tokens[i].newline);
        }
        if (isName(previous) && ['else', 'do', 'return', 'throw', 'case', 'default', 'typeof', 'void', 'await', 'yield', 'in', 'of', 'instanceof', 'new'].includes(previous.value)) {
            return false;
        }
        return Boolean(tokens[i].newline) && (ENDS_EXPRESSION.has(previous.type) || isPunct(previous, ']') || isPunct(previous, ')'));
    };
    // Whether tokens a..b use the local `name`, except at `except`
    const uses = (a, b, name, except) => {
        for (let k = a; k < b; k++) {
            if (k !== except && isName(tokens[k], name) && !isPunct(tokens[k - 1], '.') && !isPunct(tokens[k - 1], '?.')) {
                return true;
            }
        }
        return false;
    };
    // The change of the statement at i (a top-level statement that starts with a local or with
    // Object.assign), or null when it changes nothing
    const statementChange = (i) => {
        const parsed = parseExpression(ctx, i, to);
        const node = parsed.node;
        const ends = parsed.next >= to || isPunct(tokens[parsed.next], ';') || Boolean(tokens[parsed.next].newline);
        const isLocalNode = (n) => Boolean(n) && n.type === 'Identifier' && declared.has(n.name);
        let name = null;
        let change = null;
        if (node.type === 'Assignment') {
            const target = node.target;
            const object = target.type === 'Member' || target.type === 'Index' ? target.object : target;
            if (!isLocalNode(object)) {
                return null;
            }
            name = object.name;
            const key = target.type === 'Member' ? target.property : target.type === 'Index' && target.index.type === 'String' ? target.index.value : null;
            if (node.operator === '=' && target.type === 'Identifier') {
                change = { type: 'assign', value: node.value, start: node.start, end: node.end };
            } else if (node.operator === '=' && key !== null && !target.optional) {
                change = { type: 'property', key, value: node.value, start: node.start, end: node.end };
            }
        } else if (node.type === 'Call' && node.callee.type === 'Member') {
            const callee = node.callee;
            if (isLocalNode(callee.object) && (callee.property === 'push' || callee.property === 'unshift' || ARRAY_CHANGES.has(callee.property))) {
                name = callee.object.name;
                if (!ARRAY_CHANGES.has(callee.property) && !callee.optional) {
                    change = { type: callee.property, items: node.args, start: node.start, end: node.end };
                }
            } else if (callee.object.type === 'Identifier' && callee.object.name === 'Object' && callee.property === 'assign' && isLocalNode(node.args[0])) {
                name = node.args[0].name;
                if (node.args.slice(1).every(arg => arg.type !== 'Spread')) {
                    change = { type: 'merge', sources: node.args.slice(1), start: node.start, end: node.end };
                }
            }
        }
        if (!name) {
            return null;
        }
        // A change that uses the local itself (`name = name + 'x'`, `list.push(...list)`)
        if (!change || !ends || uses(i, parsed.next, name, isName(tokens[i], 'Object') ? i + 4 : i)) {
            return { name, unreadable: true };
        }
        return { name, change, next: parsed.next };
    };
    // The statements of the top level before the return; top: the tokens of the top level
    const top = new Uint8Array(to);
    const handled = new Set();
    let returnAt = to;
    let lastGroup = null;
    for (let j = from; j < to;) {
        const token = tokens[j];
        top[j] = 1;
        if (isPunct(token, '(') || isPunct(token, '[') || isPunct(token, '{')) {
            const close = Math.min(after(ctx, j) - 1, to);
            lastGroup = { open: j, close };
            j = close + 1;
            continue;
        }
        if (isName(token, 'return') && returnAt === to) {
            returnAt = j;
        }
        const assign = isName(token, 'Object') && isPunct(tokens[j + 1], '.') && isName(tokens[j + 2], 'assign');
        const found = j < returnAt && (isLocal(j) || assign) && startsStatement(j, lastGroup) ? statementChange(j) : null;
        if (found) {
            handled.add(assign ? j + 4 : j);
            if (found.unreadable) {
                unreadable(found.name);
            } else {
                add(found.name, found.change);
            }
            j = Math.max(found.next || j + 1, j + 1);
            lastGroup = null;
            continue;
        }
        j++;
    }
    // Any other change cannot be read: nested in an inner block or a function, in a condition, in
    // an expression. The dead code after the return is left out, not the functions declared there.
    for (let j = from; j < to; j++) {
        if (isLocal(j) && !handled.has(j) && !(top[j] && j > returnAt) && changesAt(j)) {
            unreadable(tokens[j].value);
        }
    }
    return changes;
}

// Whether the block has `return` statements nested in its inner blocks (if, loops, switch, try),
// not counting the nested functions (`function f() { return 1 }`, `() => { return 1 }`), objects
// and classes, whose braces are skipped
function hasNestedReturn(block) {
    const { ctx, from, to } = block;
    const { tokens } = ctx;
    // Whether tokens a..b hold a return; nested: they are the statements of an inner block
    const scan = (a, b, nested) => {
        let group = null;
        for (let j = a; j < b; j++) {
            const token = tokens[j];
            if (nested && isName(token, 'return')) {
                return true;
            }
            if (isPunct(token, '(') || isPunct(token, '[')) {
                const close = Math.min(after(ctx, j) - 1, b);
                group = { open: j, close };
                j = close;
            } else if (isPunct(token, '{')) {
                const close = Math.min(after(ctx, j) - 1, b);
                const previous = tokens[j - 1];
                let before = group && group.close === j - 1 ? tokens[group.open - 1] : null;
                if (isName(before, 'await')) {
                    // for await (...)
                    before = tokens[group.open - 2];
                }
                const statements = j === a
                    || (previous && previous.type === 'punct' && [';', '{', '}', ':'].includes(previous.value))
                    || (isName(previous) && ['else', 'try', 'finally', 'do', 'catch'].includes(previous.value))
                    || (isName(before) && BLOCK_STATEMENTS.has(before.value));
                if (statements && scan(j + 1, close, true)) {
                    return true;
                }
                j = close;
            }
        }
        return false;
    };
    return scan(from, to, false);
}

// Reads an object literal at i = '{': { type: 'Object', properties }
function parseObject(ctx, i, depth) {
    const { tokens } = ctx;
    const close = Math.min(after(ctx, i) - 1, tokens.length);
    const properties = [];
    for (const [a, b] of splitList(ctx, i + 1, close)) {
        let j = a;
        const start = tokens[a].start;
        const end = tokens[b - 1].end;
        if (isPunct(tokens[j], '...')) {
            properties.push({ kind: 'spread', value: parseExpression(ctx, j + 1, b, depth + 1).node, start, end });
            continue;
        }
        // Modifiers of methods and accessors
        while (j + 1 < b && (isName(tokens[j], 'async') || isName(tokens[j], 'get') || isName(tokens[j], 'set') || isPunct(tokens[j], '*'))
            && !isPunct(tokens[j + 1], ':') && !isPunct(tokens[j + 1], '(') && !isPunct(tokens[j + 1], ',')) {
            j++;
        }
        let key = null;
        let computed = false;
        const keyToken = tokens[j];
        if (keyToken && (keyToken.type === 'name' || keyToken.type === 'string' || keyToken.type === 'number')) {
            key = keyToken.type === 'number' ? String(Number(keyToken.value.replace(/_/g, ''))) : keyToken.value;
            j++;
        } else if (isPunct(keyToken, '[')) {
            computed = true;
            j = after(ctx, j);
        } else {
            properties.push({ kind: 'unknown', start, end });
            continue;
        }
        // Optional key of a type (`a?: ...`) or a method
        if (isPunct(tokens[j], '?') || isPunct(tokens[j], '!')) {
            j++;
        }
        if (isPunct(tokens[j], ':')) {
            properties.push({ kind: 'init', key, computed, value: parseExpression(ctx, j + 1, b, depth + 1).node, start, end, keyStart: keyToken.start });
        } else if (isPunct(tokens[j], '(') || isPunct(tokens[j], '<')) {
            let open = j;
            if (isPunct(tokens[j], '<')) {
                open = skipAngles(ctx, j, b);
            }
            if (open === -1 || !isPunct(tokens[open], '(')) {
                properties.push({ kind: 'unknown', start, end });
                continue;
            }
            const paramsEnd = Math.min(after(ctx, open) - 1, b);
            let k = paramsEnd + 1;
            if (isPunct(tokens[k], ':')) {
                k = skipType(ctx, k + 1, b);
            }
            const body = readBody(ctx, k, b, depth);
            properties.push({ kind: 'method', key, computed, value: { type: 'Function', params: readParams(ctx, open + 1, paramsEnd), body: body.node, start, end }, start, end, keyStart: keyToken.start });
        } else if (!computed && keyToken.type === 'name' && j >= b) {
            properties.push({ kind: 'init', key, computed, shorthand: true, value: { type: 'Identifier', name: key, start: keyToken.start, end: keyToken.end }, start, end, keyStart: keyToken.start });
        } else if (!computed && keyToken.type === 'name' && isPunct(tokens[j], '=')) {
            // A default in a destructuring pattern
            properties.push({ kind: 'init', key, computed, shorthand: true, value: { type: 'Identifier', name: key, start: keyToken.start, end: keyToken.end }, start, end, keyStart: keyToken.start });
        } else {
            properties.push({ kind: 'unknown', start, end });
        }
    }
    return { node: { type: 'Object', properties, start: tokens[i].start, end: tokens[Math.min(close, tokens.length - 1)].end }, next: Math.min(close + 1, tokens.length) };
}

// Reads the arguments at i = '(': { args: [node], next }
function parseArguments(ctx, i, depth) {
    const close = Math.min(after(ctx, i) - 1, ctx.tokens.length);
    const args = splitList(ctx, i + 1, close).map(([a, b]) => {
        if (isPunct(ctx.tokens[a], '...')) {
            return { type: 'Spread', argument: parseExpression(ctx, a + 1, b, depth + 1).node, start: ctx.tokens[a].start, end: ctx.tokens[b - 1].end };
        }
        return parseExpression(ctx, a, b, depth + 1).node;
    });
    return { args, next: Math.min(close + 1, ctx.tokens.length) };
}

// A template token as a node: { type: 'Template', quasis, expressions }
function templateNode(token, depth) {
    return {
        type: 'Template',
        quasis: token.quasis,
        expressions: token.subs.map(sub => {
            const inner = context(sub);
            return sub.length > 0 ? parseExpression(inner, 0, sub.length, depth + 1).node : { type: 'Unknown', start: token.start, end: token.end };
        }),
        start: token.start,
        end: token.end,
    };
}

// A primary expression at i: { node, next }
function parsePrimary(ctx, i, end, depth) {
    const { tokens } = ctx;
    const token = tokens[i];
    if (!token || i >= end) {
        return { node: unknownNode(ctx, i, end), next: end };
    }
    const arrow = (token.type === 'name' || isPunct(token, '(') || isPunct(token, '<')) ? arrowAt(ctx, i, end) : null;
    if (arrow) {
        const params = arrow.single !== undefined ? [{ name: arrow.single }] : readParams(ctx, arrow.params[0], arrow.params[1]);
        const body = readBody(ctx, arrow.arrow + 1, end, depth);
        return { node: { type: 'Arrow', params, body: body.node, start: token.start, end: body.node.end }, next: body.next };
    }
    if (token.type === 'string') {
        return { node: { type: 'String', value: token.value, start: token.start, end: token.end }, next: i + 1 };
    }
    if (token.type === 'number') {
        const raw = token.value.replace(/_/g, '');
        const value = raw.endsWith('n') ? Number(raw.slice(0, -1)) : Number(raw);
        return { node: { type: 'Number', value, raw: token.value, bigint: raw.endsWith('n'), start: token.start, end: token.end }, next: i + 1 };
    }
    if (token.type === 'template') {
        return { node: templateNode(token, depth), next: i + 1 };
    }
    if (token.type === 'regex') {
        return { node: { type: 'Regex', value: token.value, start: token.start, end: token.end }, next: i + 1 };
    }
    if (token.type === 'name') {
        if (token.value === 'true' || token.value === 'false') {
            return { node: { type: 'Literal', value: token.value === 'true', start: token.start, end: token.end }, next: i + 1 };
        }
        if (token.value === 'null') {
            return { node: { type: 'Literal', value: null, start: token.start, end: token.end }, next: i + 1 };
        }
        if (token.value === 'new') {
            const callee = parsePostfix(ctx, i + 1, end, depth + 1, true);
            let next = callee.next;
            let args = [];
            if (isPunct(tokens[next], '(')) {
                const parsed = parseArguments(ctx, next, depth);
                args = parsed.args;
                next = parsed.next;
            }
            return { node: { type: 'New', callee: callee.node, args, start: token.start, end: tokens[next - 1].end }, next };
        }
        if (token.value === 'function' || (token.value === 'async' && isName(tokens[i + 1], 'function'))) {
            let j = token.value === 'async' ? i + 2 : i + 1;
            if (isPunct(tokens[j], '*')) {
                j++;
            }
            if (isName(tokens[j])) {
                j++;
            }
            if (!isPunct(tokens[j], '(')) {
                return { node: unknownNode(ctx, i, j), next: j };
            }
            const paramsEnd = Math.min(after(ctx, j) - 1, end);
            let k = paramsEnd + 1;
            if (isPunct(tokens[k], ':')) {
                k = skipType(ctx, k + 1, end);
            }
            const body = readBody(ctx, k, end, depth);
            return { node: { type: 'Function', params: readParams(ctx, j + 1, paramsEnd), body: body.node, start: token.start, end: body.node.end }, next: body.next };
        }
        if (token.value === 'class') {
            let j = i + 1;
            while (j < end && !isPunct(tokens[j], '{')) {
                j++;
            }
            const next = j < end ? Math.min(after(ctx, j), end) : end;
            return { node: unknownNode(ctx, i, next), next };
        }
        return { node: { type: 'Identifier', name: token.value, start: token.start, end: token.end }, next: i + 1 };
    }
    if (isPunct(token, '(')) {
        const close = Math.min(after(ctx, i) - 1, end);
        const inner = parseExpression(ctx, i + 1, close, depth + 1);
        // A sequence (a, b): its last expression
        let node = inner.node;
        let next = inner.next;
        while (next < close && isPunct(tokens[next], ',')) {
            const more = parseExpression(ctx, next + 1, close, depth + 1);
            node = more.node;
            next = more.next;
        }
        return { node: { ...node, parenthesized: true }, next: Math.min(close + 1, end) };
    }
    if (isPunct(token, '[')) {
        const close = Math.min(after(ctx, i) - 1, end);
        const elements = splitList(ctx, i + 1, close).map(([a, b]) => {
            if (isPunct(tokens[a], '...')) {
                return { type: 'Spread', argument: parseExpression(ctx, a + 1, b, depth + 1).node, start: tokens[a].start, end: tokens[b - 1].end };
            }
            return parseExpression(ctx, a, b, depth + 1).node;
        });
        return { node: { type: 'Array', elements, start: token.start, end: tokens[Math.min(close, tokens.length - 1)].end }, next: Math.min(close + 1, end) };
    }
    if (isPunct(token, '{')) {
        return parseObject(ctx, i, depth);
    }
    if (isPunct(token, '<')) {
        // A type assertion <T>expr
        const next = skipAngles(ctx, i, end);
        if (next !== -1) {
            return parseUnary(ctx, next, end, depth + 1);
        }
    }
    return { node: unknownNode(ctx, i, i + 1), next: i + 1 };
}

// A primary expression and its members, calls, tagged templates, non-null assertions and generic
// arguments: { node, next }. noCall: stops before a call (the callee of `new`).
function parsePostfix(ctx, i, end, depth, noCall = false) {
    const { tokens } = ctx;
    let { node, next } = parsePrimary(ctx, i, end, depth);
    if (node.type === 'Arrow' || node.type === 'Function') {
        return { node, next };
    }
    for (;;) {
        const token = tokens[next];
        if (next >= end || !token) {
            break;
        }
        if (isPunct(token, '.') && isName(tokens[next + 1])) {
            node = { type: 'Member', object: node, property: tokens[next + 1].value, start: node.start, end: tokens[next + 1].end };
            next += 2;
        } else if (isPunct(token, '?.') && isName(tokens[next + 1])) {
            node = { type: 'Member', object: node, property: tokens[next + 1].value, optional: true, start: node.start, end: tokens[next + 1].end };
            next += 2;
        } else if (isPunct(token, '?.') && isPunct(tokens[next + 1], '(') && !noCall) {
            const parsed = parseArguments(ctx, next + 1, depth);
            node = { type: 'Call', callee: node, args: parsed.args, optional: true, start: node.start, end: tokens[parsed.next - 1].end };
            next = parsed.next;
        } else if ((isPunct(token, '[') && !token.newline) || (isPunct(token, '?.') && isPunct(tokens[next + 1], '['))) {
            const open = isPunct(token, '[') ? next : next + 1;
            const close = Math.min(after(ctx, open) - 1, end);
            const index = parseExpression(ctx, open + 1, close, depth + 1);
            node = { type: 'Index', object: node, index: index.node, start: node.start, end: tokens[Math.min(close, tokens.length - 1)].end };
            next = Math.min(close + 1, end);
        } else if (isPunct(token, '(') && !noCall) {
            const parsed = parseArguments(ctx, next, depth);
            node = { type: 'Call', callee: node, args: parsed.args, start: node.start, end: tokens[parsed.next - 1].end };
            next = parsed.next;
        } else if (token.type === 'template') {
            node = { type: 'Tagged', tag: node, quasi: templateNode(token, depth), start: node.start, end: token.end };
            next++;
        } else if (isPunct(token, '!') && !token.newline) {
            // Non-null assertion ('!=' and '!==' are tokens of their own)
            next++;
        } else if (isPunct(token, '<') && !token.newline) {
            // Generic arguments of a call or a tagged template: f<T>(), sql<string>`...`
            const close = skipAngles(ctx, next, end);
            if (close !== -1 && (isPunct(tokens[close], '(') || (tokens[close] && tokens[close].type === 'template'))) {
                next = close;
            } else {
                break;
            }
        } else {
            break;
        }
    }
    return { node, next };
}

// A unary expression at i: { node, next }
function parseUnary(ctx, i, end, depth) {
    const token = ctx.tokens[i];
    if (depth > MAX_DEPTH) {
        return { node: unknownNode(ctx, i, end), next: end };
    }
    if (token && ((token.type === 'punct' && UNARY.has(token.value)) || (token.type === 'name' && UNARY.has(token.value) && ctx.tokens[i + 1] && !isPunct(ctx.tokens[i + 1], ':') && !isPunct(ctx.tokens[i + 1], ',') && !isPunct(ctx.tokens[i + 1], ')')))) {
        const argument = parseUnary(ctx, i + 1, end, depth + 1);
        return { node: { type: 'Unary', operator: token.value, argument: argument.node, start: token.start, end: argument.node.end }, next: argument.next };
    }
    if (token && (isPunct(token, '++') || isPunct(token, '--'))) {
        return parseUnary(ctx, i + 1, end, depth + 1);
    }
    const postfix = parsePostfix(ctx, i, end, depth);
    let { node, next } = postfix;
    // TypeScript: `as T`, `satisfies T`, and a postfix ++/--
    for (;;) {
        const t = ctx.tokens[next];
        if (next < end && t && t.type === 'name' && (t.value === 'as' || t.value === 'satisfies') && !t.newline) {
            next = skipType(ctx, next + 1, end);
        } else if (next < end && t && (isPunct(t, '++') || isPunct(t, '--')) && !t.newline) {
            next++;
        } else {
            break;
        }
    }
    return { node, next };
}

// The binary operator at i (with '>=' and '>>' made of touching '>' tokens): { operator, length }
function binaryAt(ctx, i, end) {
    const token = ctx.tokens[i];
    if (!token || i >= end) {
        return null;
    }
    if (isPunct(token, '>')) {
        let length = 1;
        let operator = '>';
        while (length < 3 && isPunct(ctx.tokens[i + length], '>') && touches(ctx.tokens[i + length - 1], ctx.tokens[i + length])) {
            operator += '>';
            length++;
        }
        if (isPunct(ctx.tokens[i + length], '=') && touches(ctx.tokens[i + length - 1], ctx.tokens[i + length])) {
            return length === 1 ? { operator: '>=', length: 2 } : null;
        }
        return { operator, length };
    }
    if ((token.type === 'punct' || token.type === 'name') && BINARY.has(token.value)) {
        return { operator: token.value, length: 1 };
    }
    return null;
}

// A binary expression of operators of at least `min` precedence: { node, next }
function parseBinary(ctx, i, end, depth, min = 1) {
    let { node, next } = parseUnary(ctx, i, end, depth);
    for (;;) {
        const op = binaryAt(ctx, next, end);
        if (!op || BINARY.get(op.operator) < min) {
            break;
        }
        const precedence = BINARY.get(op.operator);
        const right = parseBinary(ctx, next + op.length, end, depth + 1, op.operator === '**' ? precedence : precedence + 1);
        if (right.next === next + op.length) {
            break;
        }
        node = { type: 'Binary', operator: op.operator, left: node, right: right.node, start: node.start, end: right.node.end };
        next = right.next;
    }
    return { node, next };
}

// An expression at i, up to `end` (excluded): { node, next } with next the index after it (a `,`, a
// `;`, a closing bracket, or a token that cannot continue it, such as a new statement)
function parseExpression(ctx, i, end = ctx.tokens.length, depth = 0) {
    if (depth > MAX_DEPTH) {
        return { node: unknownNode(ctx, i, end), next: end };
    }
    const test = parseBinary(ctx, i, end, depth);
    let { node, next } = test;
    if (isPunct(ctx.tokens[next], '?') && next < end) {
        const consequent = parseExpression(ctx, next + 1, end, depth + 1);
        if (isPunct(ctx.tokens[consequent.next], ':')) {
            const alternate = parseExpression(ctx, consequent.next + 1, end, depth + 1);
            node = { type: 'Conditional', test: node, consequent: consequent.node, alternate: alternate.node, start: node.start, end: alternate.node.end };
            next = alternate.next;
        }
    }
    // An assignment: its value
    const token = ctx.tokens[next];
    if (next < end && token && token.type === 'punct' && ['=', '+=', '-=', '??=', '||=', '&&='].includes(token.value)) {
        const value = parseExpression(ctx, next + 1, end, depth + 1);
        node = { type: 'Assignment', operator: token.value, target: node, value: value.node, start: node.start, end: value.node.end };
        next = value.next;
    }
    return { node, next: Math.max(next, Math.min(i + 1, end)) };
}

// ---------------------------------------------------------------------------------------------
// Modules

// The top-level statements of a module that tell its bindings: {
//   imports: Map(local name → { source, imported: name | '*' | 'default' }),
//   exports: Map(exported name → { local } | { source, imported }),
//   stars: [source] (export * from), declarations: Map(name → declaration), defaultExport: node,
//   assignments: [{ target, value }] (module.exports = ...), order: [declaration] in code order,
//   commonExports: Map(name → declaration) of CommonJS (exports.x = ..., module.exports.x = ...,
//   the keys of module.exports = { ... }), the last one of a name }
// A declaration: { kind: 'variable' | 'function' | 'enum', name, init (variable), params and body
// (function), members (enum: [{ name, init }]), start, end, nameStart, exported }. Type-only
// imports and exports are left out. `const { a } = require('x')` and `const x = require('x')` are
// imports of a and x (a namespace).
function scanModule(text) {
    const tokens = tokenize(text);
    const ctx = context(tokens);
    const module = { imports: new Map(), exports: new Map(), stars: [], declarations: new Map(), defaultExport: null, assignments: [], order: [], commonExports: new Map(), ctx };
    const declare = (declaration) => {
        if (!module.declarations.has(declaration.name)) {
            module.declarations.set(declaration.name, declaration);
        }
        module.order.push(declaration);
    };
    const n = tokens.length;
    // The end of a statement that is not read: its `;`, or the next token that starts a statement
    // on a new line at the same depth
    const skipStatement = (i) => {
        let j = i + 1;
        while (j < n) {
            const token = tokens[j];
            if (isPunct(token, ';')) {
                return j + 1;
            }
            if (isPunct(token, '(') || isPunct(token, '[') || isPunct(token, '{')) {
                j = after(ctx, j);
                continue;
            }
            if (token.newline && token.type === 'name' && STATEMENT_WORDS.has(token.value)) {
                return j;
            }
            j++;
        }
        return n;
    };
    const stringAt = (j) => (tokens[j] && tokens[j].type === 'string' ? tokens[j].value : null);
    // Specifiers `{ a, b as c, type d }` at i = '{': [{ name, alias }] and the index after them
    const readSpecifiers = (i) => {
        const close = Math.min(after(ctx, i) - 1, n);
        const specifiers = splitList(ctx, i + 1, close).map(([a, b]) => {
            let j = a;
            if (isName(tokens[j], 'type') && b - a > 1) {
                return null;
            }
            const name = tokens[j] && (tokens[j].type === 'name' || tokens[j].type === 'string') ? tokens[j].value : null;
            j++;
            if (isName(tokens[j], 'as') && tokens[j + 1] && (tokens[j + 1].type === 'name' || tokens[j + 1].type === 'string')) {
                return name ? { name, alias: tokens[j + 1].value } : null;
            }
            return name ? { name, alias: name } : null;
        }).filter(Boolean);
        return { specifiers, next: close + 1 };
    };
    // The source of `require('source')` at node, else null
    const requireOf = (node) => (node && node.type === 'Call' && node.callee.type === 'Identifier' && node.callee.name === 'require' && node.args.length === 1 && node.args[0].type === 'String' ? node.args[0].value : null);
    // `const { a, b: c } = require('source')` at i = '{': the imports of a CommonJS module
    const readRequired = (i, source) => {
        const close = Math.min(after(ctx, i) - 1, n);
        for (const [a] of splitList(ctx, i + 1, close)) {
            // A rest element or a computed key is not read, nor a nested pattern
            if (!isName(tokens[a])) {
                continue;
            }
            const local = !isPunct(tokens[a + 1], ':') ? tokens[a].value : isName(tokens[a + 2]) ? tokens[a + 2].value : null;
            if (local) {
                module.imports.set(local, { source, imported: tokens[a].value });
            }
        }
    };
    // Variable declarators from i (after const/let/var)
    const readDeclarators = (i, statementStart, exported) => {
        let j = i;
        for (;;) {
            const nameToken = tokens[j];
            if (!nameToken) {
                return j;
            }
            const open = j;
            if (isPunct(nameToken, '{') || isPunct(nameToken, '[')) {
                // A destructuring: not read, except the imports of `require()`
                j = after(ctx, j);
            } else if (isName(nameToken)) {
                j++;
            } else {
                return skipStatement(j);
            }
            if (isPunct(tokens[j], '!')) {
                j++;
            }
            if (isPunct(tokens[j], ':')) {
                j = skipType(ctx, j + 1, n);
            }
            let init = null;
            if (isPunct(tokens[j], '=')) {
                const parsed = parseExpression(ctx, j + 1, n);
                init = parsed.node;
                j = parsed.next;
            }
            // CommonJS: `const { a } = require('x')` and `const x = require('x')` are imports
            const required = requireOf(init);
            if (required !== null && isPunct(nameToken, '{')) {
                readRequired(open, required);
            } else if (required !== null && isName(nameToken)) {
                module.imports.set(nameToken.value, { source: required, imported: '*' });
            } else if (isName(nameToken)) {
                declare({ kind: 'variable', name: nameToken.value, init, start: statementStart, end: tokens[j - 1] ? tokens[j - 1].end : nameToken.end, nameStart: nameToken.start, exported });
            }
            if (isPunct(tokens[j], ',')) {
                j++;
                continue;
            }
            return isPunct(tokens[j], ';') ? j + 1 : j;
        }
    };
    // A function declaration from i = 'function'
    const readFunction = (i, statementStart, exported) => {
        let j = i + 1;
        if (isPunct(tokens[j], '*')) {
            j++;
        }
        const nameToken = isName(tokens[j]) ? tokens[j] : null;
        if (nameToken) {
            j++;
        }
        if (isPunct(tokens[j], '<')) {
            const next = skipAngles(ctx, j, n);
            j = next === -1 ? j + 1 : next;
        }
        if (!isPunct(tokens[j], '(')) {
            return skipStatement(i);
        }
        const paramsEnd = after(ctx, j) - 1;
        let k = paramsEnd + 1;
        if (isPunct(tokens[k], ':')) {
            k = skipType(ctx, k + 1, n);
        }
        if (!isPunct(tokens[k], '{')) {
            // An overload signature
            return isPunct(tokens[k], ';') ? k + 1 : k;
        }
        const body = readBody(ctx, k, n, 0);
        if (nameToken) {
            declare({ kind: 'function', name: nameToken.value, params: readParams(ctx, j + 1, paramsEnd), body: body.node, start: statementStart, end: body.node.end, nameStart: nameToken.start, exported });
        }
        return body.next;
    };
    // An enum declaration from i = 'enum'
    const readEnum = (i, statementStart, exported) => {
        const nameToken = isName(tokens[i + 1]) ? tokens[i + 1] : null;
        if (!nameToken || !isPunct(tokens[i + 2], '{')) {
            return skipStatement(i);
        }
        const close = after(ctx, i + 2) - 1;
        const members = splitList(ctx, i + 3, close).map(([a, b]) => {
            const key = tokens[a] && (tokens[a].type === 'name' || tokens[a].type === 'string') ? tokens[a].value : null;
            const init = isPunct(tokens[a + 1], '=') ? parseExpression(ctx, a + 2, b).node : null;
            return key ? { name: key, init } : null;
        }).filter(Boolean);
        declare({ kind: 'enum', name: nameToken.value, members, start: statementStart, end: tokens[Math.min(close, n - 1)].end, nameStart: nameToken.start, exported });
        return close + 1;
    };

    let i = 0;
    while (i < n) {
        const token = tokens[i];
        const start = token.start;
        if (isPunct(token, ';')) {
            i++;
            continue;
        }
        if (isName(token, 'import') && !isPunct(tokens[i + 1], '(') && !isPunct(tokens[i + 1], '.')) {
            let j = i + 1;
            if (isName(tokens[j], 'type') && !isPunct(tokens[j + 1], ',') && !isName(tokens[j + 1], 'from')) {
                i = skipStatement(i);
                continue;
            }
            const bindings = [];
            if (isName(tokens[j]) && !isName(tokens[j], 'from')) {
                bindings.push({ local: tokens[j].value, imported: 'default' });
                j++;
                if (isPunct(tokens[j], ',')) {
                    j++;
                }
            }
            if (isPunct(tokens[j], '*') && isName(tokens[j + 1], 'as') && isName(tokens[j + 2])) {
                bindings.push({ local: tokens[j + 2].value, imported: '*' });
                j += 3;
            } else if (isPunct(tokens[j], '{')) {
                const read = readSpecifiers(j);
                bindings.push(...read.specifiers.map(s => ({ local: s.alias, imported: s.name })));
                j = read.next;
            }
            if (isName(tokens[j], 'from')) {
                j++;
            }
            const source = stringAt(j);
            if (source !== null) {
                for (const binding of bindings) {
                    module.imports.set(binding.local, { source, imported: binding.imported });
                }
            }
            i = skipStatement(j);
            continue;
        }
        if (isName(token, 'export')) {
            let j = i + 1;
            if (isName(tokens[j], 'type') && (isPunct(tokens[j + 1], '{') || isPunct(tokens[j + 1], '*'))) {
                i = skipStatement(i);
                continue;
            }
            if (isPunct(tokens[j], '*')) {
                if (isName(tokens[j + 1], 'as') && isName(tokens[j + 2]) && isName(tokens[j + 3], 'from') && stringAt(j + 4) !== null) {
                    module.exports.set(tokens[j + 2].value, { source: stringAt(j + 4), imported: '*' });
                } else if (isName(tokens[j + 1], 'from') && stringAt(j + 2) !== null) {
                    module.stars.push(stringAt(j + 2));
                }
                i = skipStatement(j);
                continue;
            }
            if (isPunct(tokens[j], '{')) {
                const read = readSpecifiers(j);
                const source = isName(tokens[read.next], 'from') ? stringAt(read.next + 1) : null;
                for (const s of read.specifiers) {
                    module.exports.set(s.alias, source !== null ? { source, imported: s.name } : { local: s.name });
                }
                i = skipStatement(read.next - 1);
                continue;
            }
            if (isName(tokens[j], 'default')) {
                j++;
                if (isName(tokens[j], 'function') || (isName(tokens[j], 'async') && isName(tokens[j + 1], 'function'))) {
                    const parsed = parseExpression(ctx, j, n);
                    module.defaultExport = parsed.node;
                    i = parsed.next;
                    continue;
                }
                const parsed = parseExpression(ctx, j, n);
                module.defaultExport = parsed.node;
                i = isPunct(tokens[parsed.next], ';') ? parsed.next + 1 : parsed.next;
                continue;
            }
            if (isName(tokens[j], 'declare')) {
                i = skipStatement(i);
                continue;
            }
            if (isName(tokens[j], 'const') && isName(tokens[j + 1], 'enum')) {
                j++;
            }
            if (isName(tokens[j], 'const') || isName(tokens[j], 'let') || isName(tokens[j], 'var')) {
                i = readDeclarators(j + 1, start, true);
                continue;
            }
            if (isName(tokens[j], 'async') && isName(tokens[j + 1], 'function')) {
                j++;
            }
            if (isName(tokens[j], 'function')) {
                i = readFunction(j, start, true);
                continue;
            }
            if (isName(tokens[j], 'enum')) {
                i = readEnum(j, start, true);
                continue;
            }
            i = skipStatement(i);
            continue;
        }
        if (isName(token, 'const') && isName(tokens[i + 1], 'enum')) {
            i = readEnum(i + 1, start, false);
            continue;
        }
        if ((isName(token, 'const') || isName(token, 'let') || isName(token, 'var')) && tokens[i + 1] && (isName(tokens[i + 1]) || isPunct(tokens[i + 1], '{') || isPunct(tokens[i + 1], '['))) {
            i = readDeclarators(i + 1, start, false);
            continue;
        }
        if (isName(token, 'function') || (isName(token, 'async') && isName(tokens[i + 1], 'function'))) {
            i = readFunction(isName(token, 'async') ? i + 1 : i, start, false);
            continue;
        }
        if (isName(token, 'enum') && isName(tokens[i + 1]) && isPunct(tokens[i + 2], '{')) {
            i = readEnum(i, start, false);
            continue;
        }
        // module.exports = ..., exports.x = ..., module.exports.x = ...
        if (isName(token, 'module') && isPunct(tokens[i + 1], '.') && isName(tokens[i + 2], 'exports') && isPunct(tokens[i + 3], '=')) {
            const parsed = parseExpression(ctx, i + 4, n);
            module.assignments.push({ target: 'module.exports', value: parsed.node });
            if (parsed.node.type === 'Object') {
                for (const property of parsed.node.properties) {
                    if (property.kind === 'init' && !property.computed) {
                        module.commonExports.set(property.key, { kind: 'variable', name: property.key, init: property.value, start: property.start, end: property.end, nameStart: property.keyStart, exported: true });
                    }
                }
            }
            i = Math.max(parsed.next, i + 4);
            continue;
        }
        const exportsAt = isName(token, 'exports') ? i + 1 : isName(token, 'module') && isPunct(tokens[i + 1], '.') && isName(tokens[i + 2], 'exports') ? i + 3 : -1;
        if (exportsAt !== -1 && isPunct(tokens[exportsAt], '.') && isName(tokens[exportsAt + 1]) && isPunct(tokens[exportsAt + 2], '=')) {
            const parsed = parseExpression(ctx, exportsAt + 3, n);
            const nameToken = tokens[exportsAt + 1];
            module.commonExports.set(nameToken.value, { kind: 'variable', name: nameToken.value, init: parsed.node, start, end: parsed.node.end, nameStart: nameToken.start, exported: true });
            i = Math.max(parsed.next, exportsAt + 3);
            continue;
        }
        if (isName(token) && STATEMENT_WORDS.has(token.value)) {
            i = skipStatement(i);
            continue;
        }
        // Another statement (a call, an if...): passed over
        const parsed = parseExpression(ctx, i, n);
        i = Math.max(parsed.next, i + 1);
    }
    return module;
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

module.exports = {
    MAX_DEPTH,
    cook: unescape,
    tokenize,
    context,
    parseExpression,
    scanModule,
    blockReturns,
    blockDeclarations,
    blockChanges,
    hasNestedReturn,
    createLineLocator,
};

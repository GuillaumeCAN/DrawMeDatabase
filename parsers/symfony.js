//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Reads the Doctrine entities of a Symfony project (src/Entity) and returns the tables they map.
// Attributes (#[ORM\...]) and legacy docblock annotations (@ORM\...) are both supported.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { ParserError } = require('./errors');
const {
    skipLiteral,
    stripComments,
    findMatching,
    splitTopLevel,
    parseStringLiteral,
    parseArgs,
    parseArrayLiteral,
    createLineLocator,
} = require('./php-utils');

const MAPPING_NAMESPACE = 'doctrine\\orm\\mapping\\';
const RELATION_KINDS = ['manytoone', 'onetoone', 'onetomany', 'manytomany'];

// Unnamed arguments we understand, in Doctrine's constructor order
const POSITIONAL = {
    column: ['name', 'type', 'length', 'precision', 'scale', 'unique', 'nullable'],
    table: ['name'],
    jointable: ['name'],
    joincolumn: ['name', 'referencedColumnName'],
    inheritancetype: ['value'],
    discriminatorcolumn: ['name', 'type'],
};

// Doctrine type inferred from the PHP type of a property (ORM's DefaultTypedFieldMapper).
// Maps, so that class names such as 'Constructor' are not looked up in Object.prototype.
const PHP_TYPES = new Map([
    ['string', 'string'],
    ['int', 'integer'],
    ['bool', 'boolean'],
    ['float', 'float'],
    ['array', 'json'],
]);
const DATE_TYPES = new Map([
    ['datetimeimmutable', 'datetime_immutable'],
    ['datetime', 'datetime'],
    ['datetimeinterface', 'datetime'],
    ['dateinterval', 'dateinterval'],
]);
const BUILTIN_TYPES = new Set(['mixed', 'object', 'iterable', 'callable', 'true', 'false', 'self', 'static', 'parent', 'void', 'never']);

// Modifiers, an optional type, then the name. The parts start and end on non-blank characters, so a
// long blank run (a masked comment) can only be matched one way: no catastrophic backtracking.
const PROPERTY = /^\s*((?:(?:(?:public|protected|private)(?:\(set\))?|static|readonly|var|final|abstract)\s+(?!\s))+)((?:[\w\\?|&()]+(?:\s+[\w\\?|&()]+)*)?)\s*(?:&\s*)?(?:\.\.\.\s*)?\$([A-Za-z_]\w*)/i;
// `function` keyword, but not a property named $function
const METHOD = /(?<![$\w])function\s+(?:&\s*)?([A-Za-z_]\w*)\s*\(/i;

// Options that keep git output stable whatever the user or repository config says
const GIT_OPTIONS = [
    '-c', 'core.quotepath=off',
    '-c', 'color.ui=never',
    '-c', 'core.fsmonitor=',
    '-c', 'diff.interHunkContext=0',
    '-c', 'diff.submodule=short',
    '-c', 'diff.suppressBlankEmpty=false',
    '--no-optional-locks',
    '--literal-pathspecs',
];

// Symfony's default naming strategy (underscore_number_aware): createdAt → created_at
const underscore = (name) => name.replace(/(?<=[a-z0-9])([A-Z])/g, '_$1').toLowerCase();
const shortName = (className) => className.slice(className.lastIndexOf('\\') + 1);
const unquoteName = (name) => (name ? name.replace(/`/g, '') : name);
const toPosix = (filePath) => filePath.split(path.sep).join('/');
const blank = (text) => text.replace(/[^\r\n]/g, ' ');

// ---------------------------------------------------------------------------------------------
// Source scanning

// Copy of `code` with literals and doc comments blanked (offsets kept), so that brackets and
// keywords can be found by plain scanning. Doc comments are also returned with their offsets.
function maskCode(code) {
    const docs = [];
    const chunks = [];
    let last = 0;
    let i = 0;

    while (i < code.length) {
        let end;
        if (code.startsWith('/**', i)) {
            end = code.indexOf('*/', i + 3);
            end = end === -1 ? code.length : end + 2;
            docs.push({ start: i, end, text: code.slice(i, end) });
        } else {
            end = skipLiteral(code, i);
        }

        if (end === -1) {
            i++;
            continue;
        }
        chunks.push(code.slice(last, i), blank(code.slice(i, end)));
        last = i = end;
    }
    chunks.push(code.slice(last));

    const mask = chunks.join('').replace(/<\?(?:php)?|\?>/gi, (tag) => ' '.repeat(tag.length));
    return { mask, docs };
}

// Splits mask[start, end) into items ending at a top-level `separator` (';' or ','). With ';',
// a '{...}' block also ends an item. Attribute groups '#[...]' are collected per item.
// Returns null on unbalanced brackets.
function scanItems(mask, start, end, separator) {
    const items = [];
    let item = { start, attrs: [] };
    let i = start;

    while (i < end) {
        const c = mask[i];
        if (c === separator) {
            items.push({ ...item, headEnd: i });
            item = { start: i + 1, attrs: [] };
            i++;
        } else if (c === '(' || c === '[' || c === '{') {
            const close = findMatching(mask, i);
            if (close === -1 || close >= end) {
                return null;
            }
            if (c === '[' && mask[i - 1] === '#') {
                item.attrs.push({ start: i - 1, end: close + 1 });
            }
            if (c === '{' && separator === ';') {
                items.push({ ...item, headEnd: i, blockEnd: close });
                item = { start: close + 1, attrs: [] };
            }
            i = close + 1;
        } else if (c === ')' || c === ']' || c === '}') {
            return null;
        } else {
            i++;
        }
    }

    if (mask.slice(item.start, end).trim() !== '') {
        items.push({ ...item, headEnd: end });
    }
    return items;
}

// Text of an item before its terminator, with its attribute groups blanked
function headText(mask, item) {
    let head = mask.slice(item.start, item.headEnd);
    for (const attr of item.attrs) {
        const from = attr.start - item.start;
        head = head.slice(0, from) + ' '.repeat(attr.end - attr.start) + head.slice(attr.end - item.start);
    }
    return head;
}

// Adds the aliases of a `use` statement to `uses` (lowercased alias → class name)
function addUses(uses, clause, group) {
    if (/^\s*(function|const)\s/i.test(clause)) {
        return;
    }
    const prefix = group === null ? '' : clause.trim().replace(/^\\/, '');
    for (const entry of splitTopLevel(group === null ? clause : group, ',')) {
        // `use function x` / `use const X` don't match: they import no class
        const match = /^\\?([A-Za-z_][\w\\]*)(?:\s+as\s+([A-Za-z_]\w*))?$/i.exec(entry);
        if (match) {
            const name = prefix + match[1];
            uses.set((match[2] || shortName(name)).toLowerCase(), name);
        }
    }
}

// Fully-qualified name of a class reference, following PHP's name resolution rules
function resolveClass(name, ctx) {
    if (name.startsWith('\\')) {
        return name.slice(1);
    }
    const lower = name.toLowerCase();
    if (lower === 'self' || lower === 'static') {
        return ctx.fqcn;
    }
    if (lower.startsWith('namespace\\')) {
        return ctx.namespace ? `${ctx.namespace}\\${name.slice(10)}` : name.slice(10);
    }
    const slash = name.indexOf('\\');
    const first = (slash === -1 ? name : name.slice(0, slash)).toLowerCase();
    if (ctx.uses.has(first)) {
        return ctx.uses.get(first) + (slash === -1 ? '' : name.slice(slash));
    }
    return ctx.namespace ? `${ctx.namespace}\\${name}` : name;
}

// Doctrine mapping name ('column', 'manytoone'...) of an attribute or annotation, or null
function mappingKind(name, ctx) {
    let fqcn = resolveClass(name, ctx).toLowerCase();
    const bare = name.replace(/^\\/, '').toLowerCase();
    if (bare.startsWith(MAPPING_NAMESPACE)) {
        fqcn = bare;
    } else if (!fqcn.startsWith(MAPPING_NAMESPACE) && bare.startsWith('orm\\') && !ctx.uses.has('orm')) {
        // ORM\X without its `use` statement: still the usual Doctrine alias
        fqcn = MAPPING_NAMESPACE + bare.slice(4);
    }
    if (!fqcn.startsWith(MAPPING_NAMESPACE)) {
        return null;
    }
    const kind = fqcn.slice(MAPPING_NAMESPACE.length);
    return kind.includes('\\') ? null : kind;
}

// Mappings of an attribute group's content: 'ORM\Id, ORM\Column(length: 36)'
function parseAttributeGroup(text, ctx) {
    const mappings = [];
    for (const entry of splitTopLevel(text, ',')) {
        const match = /^(\\?[A-Za-z_][\w\\]*)\s*(?:\(([\s\S]*)\))?$/.exec(entry);
        const kind = match && mappingKind(match[1], ctx);
        if (kind) {
            mappings.push({ kind, args: match[2] ? parseArgs(match[2]) : [], annotation: false, ctx });
        }
    }
    return mappings;
}

// Arguments of an annotation: 'type="string", length=255'
function parseAnnotationArgs(text) {
    return splitTopLevel(text, ',').map(entry => {
        const named = /^([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/.exec(entry);
        return named ? { name: named[1], value: named[2].trim() } : { name: null, value: entry };
    });
}

// Doctrine annotations (@ORM\Column(...)) found in a doc comment or in a nested annotation value
function parseAnnotations(text, ctx) {
    const mappings = [];
    const tag = /@(\\?[A-Za-z_][\w\\]*)/g;
    let match;

    while ((match = tag.exec(text)) !== null) {
        let args = '';
        const open = match.index + match[0].length;
        if (text[open] === '(') {
            const close = findMatching(text, open);
            if (close !== -1) {
                args = text.slice(open + 1, close);
                tag.lastIndex = close + 1;
            }
        }
        const kind = mappingKind(match[1], ctx);
        if (kind) {
            mappings.push({ kind, args: parseAnnotationArgs(args), annotation: true, ctx });
        }
    }
    return mappings;
}

// Mappings of a declaration: its attribute groups, then the annotations of its doc comments
function readMappings(unit, ctx, attrs, from, to) {
    const mappings = [];
    for (const attr of attrs) {
        mappings.push(...parseAttributeGroup(unit.code.slice(attr.start + 2, attr.end - 1), ctx));
    }
    for (const doc of unit.docs) {
        if (doc.start >= from && doc.end <= to) {
            const text = doc.text.slice(3, doc.text.endsWith('*/') ? -2 : undefined).replace(/^[ \t]*\*/gm, ' ');
            mappings.push(...parseAnnotations(text, ctx));
        }
    }
    return mappings;
}

// First and last lines of the non-blank code in [start, end)
function lineRange(unit, start, end) {
    const text = unit.code.slice(start, end);
    return [unit.line(start + text.search(/\S/)), unit.line(start + text.trimEnd().length - 1)];
}

// Adds the property declared by `item` (a class statement or a constructor parameter) to `cls`
function readProperty(unit, cls, item, head) {
    const match = PROPERTY.exec(head);
    if (!match) {
        return;
    }

    const nameOffset = item.start + match.index + match[0].length - match[3].length;
    cls.properties.push({
        name: match[3],
        type: match[2].replace(/\s+/g, ''),
        isStatic: /\bstatic\b/i.test(match[1]),
        // `public private(set)` stays visible to child classes
        isPrivate: /\bprivate\b(?!\()/i.test(match[1]),
        mappings: readMappings(unit, cls.ctx, item.attrs, item.start, nameOffset),
        lines: lineRange(unit, item.start, item.headEnd),
    });
}

// Reads the properties and the used traits of a class body, constructor-promoted properties included
function readClassBody(unit, cls, start, end) {
    const statements = scanItems(unit.mask, start, end, ';');
    if (!statements) {
        return false;
    }

    for (const statement of statements) {
        const head = headText(unit.mask, statement);
        const traits = /^\s*use\s+([\s\S]*)$/i.exec(head);
        if (traits) {
            cls.traits.push(...splitTopLevel(traits[1], ',').map(name => resolveClass(name, cls.ctx)));
            continue;
        }

        const method = METHOD.exec(head);
        if (!method) {
            // Not $function, nor a namespace segment (?\App\Function\Role $role)
            if (!/(?<![$\w\\])function\b(?!\\)/i.test(head)) {
                readProperty(unit, cls, statement, head);
            }
            continue;
        }
        if (method[1].toLowerCase() !== '__construct') {
            continue;
        }

        const open = statement.start + method.index + method[0].length - 1;
        const params = scanItems(unit.mask, open + 1, findMatching(unit.mask, open), ',');
        if (!params) {
            return false;
        }
        for (const param of params) {
            readProperty(unit, cls, param, headText(unit.mask, param));
        }
    }
    return true;
}

// Reads the classes, enums, traits and interfaces declared in mask[start, end)
function readScope(unit, start, end, namespace, classes) {
    const statements = scanItems(unit.mask, start, end, ';');
    if (!statements) {
        return false;
    }

    let ctx = { namespace, uses: new Map() };
    for (const statement of statements) {
        const head = headText(unit.mask, statement);
        const hasBlock = statement.blockEnd !== undefined;

        let match = /^\s*namespace(?:\s+([A-Za-z_\\][\w\\]*))?\s*$/i.exec(head);
        if (match) {
            ctx = { namespace: (match[1] || '').replace(/^\\/, ''), uses: new Map() };
            if (hasBlock && !readScope(unit, statement.headEnd + 1, statement.blockEnd, ctx.namespace, classes)) {
                return false;
            }
            continue;
        }

        match = /^\s*use\s+([\s\S]*)$/i.exec(head);
        if (match) {
            addUses(ctx.uses, match[1], hasBlock ? unit.mask.slice(statement.headEnd + 1, statement.blockEnd) : null);
            continue;
        }

        match = /(?<!\bnew\s+)(?:^|\s)(class|trait|interface|enum)\s+([A-Za-z_]\w*)([\s\S]*)$/i.exec(head);
        if (!match || !hasBlock) {
            continue;
        }

        const fqcn = ctx.namespace ? `${ctx.namespace}\\${match[2]}` : match[2];
        const classCtx = { ...ctx, fqcn };
        const backing = /^\s*:\s*(string|int)\b/i.exec(match[3]);
        const parent = /^\s*extends\s+(\\?[A-Za-z_][\w\\]*)/i.exec(match[3]);
        const cls = {
            kind: match[1].toLowerCase(),
            name: match[2],
            fqcn,
            ctx: classCtx,
            file: unit.file,
            lines: lineRange(unit, statement.start, statement.headEnd),
            backing: backing ? (backing[1].toLowerCase() === 'int' ? 'integer' : 'string') : null,
            parent: parent && match[1].toLowerCase() === 'class' ? resolveClass(parent[1], classCtx) : null,
            mappings: readMappings(unit, classCtx, statement.attrs, statement.start, statement.headEnd),
            properties: [],
            traits: [],
        };
        if (!readClassBody(unit, cls, statement.headEnd + 1, statement.blockEnd)) {
            return false;
        }
        classes.push(cls);
    }
    return true;
}

// Classes declared in one PHP file
function readFile(file, warnings) {
    // A BOM is replaced (not removed) so that offsets and lines don't move
    const source = fs.readFileSync(file.path, 'utf8').replace(/^\uFEFF/, ' ');
    const code = stripComments(source, { keepDocComments: true });
    const { mask, docs } = maskCode(code);
    const unit = { file, code, mask, docs, line: createLineLocator(code) };

    const classes = [];
    if (!readScope(unit, 0, mask.length, '', classes)) {
        warnings.push(`${file.rel}: unbalanced brackets, file skipped.`);
        return [];
    }
    return classes;
}

// Sorted list of the PHP files under `dir`, as { path, rel } (rel is relative to basePath)
function listPhpFiles(dir, basePath) {
    const files = [];
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.name.endsWith('.php') && (entry.isFile() || isFile(fullPath))) {
                files.push({ path: fullPath, rel: toPosix(path.relative(basePath, fullPath)) });
            }
        }
    };
    walk(dir);
    return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

const isFile = (filePath) => {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
};

const isDirectory = (dirPath) => {
    try {
        return fs.statSync(dirPath).isDirectory();
    } catch {
        return false;
    }
};

// ---------------------------------------------------------------------------------------------
// Mapping values

// Raw value of a mapping argument, by name or by position
function arg(mapping, name) {
    if (!mapping) {
        return undefined;
    }
    const named = mapping.args.find(a => a.name === name);
    if (named) {
        return named.value;
    }
    const positional = mapping.args.filter(a => a.name === null);
    const index = (POSITIONAL[mapping.kind] || []).indexOf(name);
    if (index !== -1 && positional[index]) {
        return positional[index].value;
    }
    if (name === 'targetEntity') {
        const constant = positional.find(a => /::\s*class$/i.test(a.value));
        return constant ? constant.value : undefined;
    }
    return undefined;
}

function stringValue(mapping, raw) {
    if (raw === undefined) {
        return null;
    }
    if (mapping.annotation) {
        const match = /^"([\s\S]*)"$/.exec(raw.trim());
        return match ? match[1].replace(/""/g, '"') : null;
    }
    return parseStringLiteral(raw);
}

function boolValue(raw) {
    if (raw === undefined) {
        return null;
    }
    const value = raw.trim().toLowerCase();
    return value === 'true' ? true : value === 'false' ? false : null;
}

// Class named by 'Foo::class', 'self::class' or a class name string, or null
function classValue(mapping, raw) {
    if (raw === undefined) {
        return null;
    }
    const constant = /^(\\?[A-Za-z_][\w\\]*)\s*::\s*class$/i.exec(raw.trim());
    if (constant) {
        return resolveClass(constant[1], mapping.ctx);
    }
    const text = stringValue(mapping, raw);
    if (!text) {
        return null;
    }
    // Doctrine resolves a name without namespace against the entity's namespace
    const name = text.replace(/^\\+/, '');
    return name.includes('\\') || !mapping.ctx.namespace ? name : `${mapping.ctx.namespace}\\${name}`;
}

// Members of a property type, null excluded: '?Post' → ['Post'], 'int|string' → ['int', 'string']
const typeNames = (phpType) => phpType.replace(/[?()]/g, '').split(/[|&]/).filter(n => n && n.toLowerCase() !== 'null');

// Class of a property type (?Post, Post|null, \App\Entity\Post, self), or null for builtin types
function typeClass(phpType, ctx) {
    const names = typeNames(phpType);
    if (names.length === 0) {
        return null;
    }
    const lower = names[0].toLowerCase();
    if (PHP_TYPES.has(lower) || (BUILTIN_TYPES.has(lower) && lower !== 'self' && lower !== 'static')) {
        return null;
    }
    return resolveClass(names[0], ctx);
}

// Doctrine type of a column: the explicit `type`, else inferred from the PHP type like Doctrine's
// DefaultTypedFieldMapper (a backed enum gives its backing type; enumType alone changes nothing)
function columnType(mapping, property, ctx, enums) {
    const raw = arg(mapping, 'type');
    if (raw !== undefined) {
        const text = stringValue(mapping, raw);
        if (text) {
            return shortName(text);
        }
        const constant = /^([\w\\]+)\s*::\s*([A-Za-z_]\w*)$/.exec(raw.trim());
        if (constant) {
            const owner = shortName(constant[1]);
            if (/^(name|class)$/i.test(constant[2]) && !/^types?$/i.test(owner)) {
                // Custom type class (UuidType::NAME → uuid, MoneyType::class → money)
                return underscore(owner.replace(/Type$/, '')) || 'string';
            }
            // Types::TEXT → text, Types::DATETIME_MUTABLE → datetime
            return constant[2].replace(/_MUTABLE$/, '').toLowerCase();
        }
    }

    // Untyped, union and intersection types: Doctrine's default
    const names = typeNames(property.type);
    if (names.length !== 1) {
        return 'string';
    }
    const lower = names[0].toLowerCase();
    if (PHP_TYPES.has(lower) || BUILTIN_TYPES.has(lower)) {
        return PHP_TYPES.get(lower) || 'string';
    }
    return DATE_TYPES.get(shortName(lower)) || enums.get(resolveClass(names[0], ctx).toLowerCase()) || 'string';
}

// Join columns declared on a property: JoinColumn / JoinColumns, or JoinTable(joinColumns: ...)
function joinColumns(mappings, joinTable) {
    const nested = (mapping, raw) => {
        if (raw === undefined) {
            return [];
        }
        if (mapping.annotation) {
            return parseAnnotations(raw, mapping.ctx).filter(m => m.kind === 'joincolumn');
        }
        return (parseArrayLiteral(raw) || [raw]).map(entry => {
            const match = /^new\s+(\\?[A-Za-z_][\w\\]*)\s*\(([\s\S]*)\)$/i.exec(entry.trim());
            return match && mappingKind(match[1], mapping.ctx) === 'joincolumn'
                ? { kind: 'joincolumn', args: parseArgs(match[2]), annotation: false, ctx: mapping.ctx }
                : null;
        }).filter(Boolean);
    };

    const list = joinTable ? nested(joinTable, arg(joinTable, 'joinColumns')) : [];
    for (const mapping of mappings) {
        if (mapping.kind === 'joincolumn') {
            list.push(mapping);
        } else if (mapping.kind === 'joincolumns' && mapping.args.length > 0) {
            list.push(...nested(mapping, mapping.args[0].value));
        }
    }

    return list.map(m => ({
        name: unquoteName(stringValue(m, arg(m, 'name'))),
        references: unquoteName(stringValue(m, arg(m, 'referencedColumnName'))),
        nullable: boolValue(arg(m, 'nullable')),
    }));
}

// ---------------------------------------------------------------------------------------------
// Git status

function git(cwd, args) {
    // Without the variables that change the diff output (context lines, external diff tool)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_(DIFF_OPTS|EXTERNAL_DIFF)$/i.test(key)));
    return childProcess.execFileSync('git', [...GIT_OPTIONS, ...args], {
        cwd,
        // English messages, for gitErrorReason
        env: { ...env, LC_ALL: 'C' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
        timeout: 15000,
        windowsHide: true,
    });
}

// Path of a '+++ ' diff header: git adds a tab after names with spaces and C-quotes special names
function diffPath(text) {
    const value = text.replace(/\t$/, '');
    if (!(value.length > 1 && value.startsWith('"') && value.endsWith('"'))) {
        return value;
    }
    const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
    const raw = Buffer.from(value.slice(1, -1), 'utf8');
    const bytes = [];
    for (let i = 0; i < raw.length; i++) {
        if (raw[i] !== 0x5c) {
            bytes.push(raw[i]);
            continue;
        }
        const next = raw[++i];
        if (next >= 0x30 && next <= 0x37) {
            bytes.push(parseInt(raw.toString('latin1', i, i + 3), 8));
            i += 2;
        } else {
            bytes.push(escapes[String.fromCharCode(next)] || next);
        }
    }
    return Buffer.from(bytes).toString('utf8');
}

// Changed lines per file of a `git diff --unified=0`: { isNew, lines: Set, deletions: [] }.
// Only '+' and '-' lines count: context lines, if git prints any, are not changes.
function parseDiff(output) {
    const files = new Map();
    let current = null;
    let inHeader = false;
    let isNew = false;
    let lineNumber = 0;

    for (const line of output.split('\n')) {
        if (line.startsWith('diff --git ')) {
            current = null;
            inHeader = true;
            isNew = false;
            continue;
        }
        if (inHeader && line.startsWith('--- ')) {
            isNew = line === '--- /dev/null';
            continue;
        }
        if (inHeader && line.startsWith('+++ ')) {
            const target = diffPath(line.slice(4));
            if (target !== '/dev/null') {
                current = { isNew, lines: new Set(), deletions: [] };
                files.set(target.replace(/^b\//, ''), current);
            }
            continue;
        }

        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk) {
            inHeader = false;
            // Number of the next new line (an empty new side gives the line before the removal)
            lineNumber = parseInt(hunk[1], 10) + (hunk[2] === '0' ? 1 : 0);
        } else if (current && !inHeader && line[0] === '+') {
            current.lines.add(lineNumber++);
        } else if (current && !inHeader && line[0] === '-') {
            // Line removed after line `lineNumber - 1`
            current.deletions.push(lineNumber - 1);
        } else if (line[0] === ' ') {
            lineNumber++;
        }
    }
    return files;
}

// Reads into `state` the files under `relDir` of the repository at `root` that are not in HEAD
// (untracked, ignored, staged-new) and the changed lines of the others, as paths from `root` prefixed
// with `prefix`. A changed submodule is read the same way, against its own HEAD.
function readRepository(root, relDir, prefix, hasHead, state) {
    const entries = git(root, ['status', '--porcelain=v1', '-z', '-uall', '--ignored', '--ignore-submodules=none', '--', relDir]).split('\0');
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.length < 4) {
            continue;
        }
        const xy = entry.slice(0, 2);
        const file = entry.slice(3);
        if (xy === '??' || xy === '!!' || 'ARC'.includes(xy[0]) || xy[1] === 'A') {
            state.notInHead.add(prefix + file);
        } else if (xy.includes('M') && fs.existsSync(path.join(root, file, '.git'))) {
            readRepository(path.join(root, file), '.', `${prefix}${file}/`, true, state);
        }
        if (xy[0] === 'R' || xy[0] === 'C') {
            i++; // the original path follows
        }
    }

    if (hasHead) {
        const diff = git(root, ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--text',
            '--unified=0', '--src-prefix=a/', '--dst-prefix=b/', '--', relDir]);
        for (const [file, change] of parseDiff(diff)) {
            state.changes.set(prefix + file, change);
        }
    }
}

// Returns a function (filePath) → (firstLine, lastLine) → 'committed' | 'modified' | 'untracked'.
// Throws when git is not usable for this folder.
function readGitStatus(entityDir) {
    const dir = fs.realpathSync(entityDir);
    const root = git(dir, ['rev-parse', '--show-toplevel']).trim();
    if (!root) {
        throw new Error('no work tree');
    }
    const relDir = toPosix(path.relative(root, dir)) || '.';
    if (relDir.startsWith('..')) {
        throw new Error('the entity folder is outside of the repository');
    }

    let hasHead = true;
    try {
        git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    } catch {
        hasHead = false;
    }

    const notInHead = new Set();
    const changes = new Map();
    readRepository(root, relDir, '', hasHead, { notInHead, changes });

    return (filePath) => {
        const rel = toPosix(path.relative(root, fs.realpathSync(filePath)));
        const change = changes.get(rel);
        const isNew = !hasHead || notInHead.has(rel) || Boolean(change && change.isNew);

        return (first, last) => {
            if (isNew) {
                return 'untracked';
            }
            if (change) {
                for (let line = first; line <= last; line++) {
                    if (change.lines.has(line)) {
                        return 'modified';
                    }
                }
                // Lines removed inside the declaration
                if (change.deletions.some(line => line >= first && line < last)) {
                    return 'modified';
                }
            }
            return 'committed';
        };
    };
}

function gitErrorReason(error) {
    if (error.code === 'ENOENT') {
        return 'git is not installed';
    }
    const stderr = String(error.stderr || '');
    if (/not a git repository/i.test(stderr)) {
        return 'not a git repository';
    }
    const firstLine = (stderr.trim() || error.message || '').split('\n')[0];
    return firstLine.replace(/^fatal:\s*/, '') || 'git failed';
}

// ---------------------------------------------------------------------------------------------
// Tables

// Returns { tables, warnings }. `options.git: false` skips the git status (e.g. untrusted workspace).
module.exports.parse = function (basePath, options = {}) {
    const entityDir = path.join(basePath, 'src', 'Entity');
    if (!isDirectory(entityDir)) {
        throw new ParserError(`No src/Entity folder found in ${basePath}.`);
    }
    const files = listPhpFiles(entityDir, basePath);
    if (files.length === 0) {
        throw new ParserError(`No PHP files found in ${entityDir}.`);
    }

    const warnings = [];
    const classes = [];
    for (const file of files) {
        classes.push(...readFile(file, warnings));
    }

    // Enum backing types, used for enum columns
    const enums = new Map();
    for (const cls of classes) {
        if (cls.kind === 'enum') {
            enums.set(cls.fqcn.toLowerCase(), cls.backing || 'string');
        }
    }

    // Entities and their table names
    const classMap = new Map(classes.map(c => [c.fqcn.toLowerCase(), c]));
    const entities = [];
    for (const cls of classes) {
        const kinds = new Set(cls.mappings.map(m => m.kind));
        if (cls.kind === 'class' && kinds.has('entity')) {
            const tableMapping = cls.mappings.find(m => m.kind === 'table');
            const table = unquoteName(stringValue(tableMapping, arg(tableMapping, 'name')));
            entities.push({ cls, table: table || underscore(cls.name) });
        } else if (cls.kind === 'class' && kinds.has('embeddable')) {
            warnings.push(`${cls.file.rel}: embeddable ${cls.name} is not supported, its fields are not shown.`);
        }
    }
    if (entities.length === 0) {
        warnings.push('No Doctrine entity found in src/Entity.');
        return { tables: [], warnings };
    }

    const byClass = new Map(entities.map(e => [e.cls.fqcn.toLowerCase(), e]));
    const findEntity = (className) => {
        const entity = byClass.get(className.toLowerCase());
        if (entity) {
            return entity;
        }
        const sameName = entities.filter(e => e.cls.name.toLowerCase() === shortName(className).toLowerCase());
        return sameName.length === 1 ? sameName[0] : null;
    };

    // Properties Doctrine maps for a class, like PHP reflection sees them: its own, those of its traits
    // (and of their traits), then those of its parents up to the first entity. A mapped superclass gives
    // all its fields, a plain parent class only those its children can see (not private). The nearest
    // declaration wins. Each property keeps its declaring class (names, git status) and the mapped class
    // that loads it (default join table names). Traits and parents outside src/Entity cannot be read.
    const reported = new Set();
    const warnOnce = (message) => {
        if (!reported.has(message)) {
            reported.add(message);
            warnings.push(message);
        }
    };
    // Results are kept per class, mapped class and visibility: a trait used by many traits is read once
    const memo = new Map();
    const ids = new Map(classes.map((c, i) => [c, i]));
    const collect = (cls, source, hidePrivate, path) => {
        const key = `${ids.get(cls)}:${ids.get(source)}:${hidePrivate}`;
        if (memo.has(key)) {
            return memo.get(key);
        }
        const names = new Set();
        // Drops the properties already declared nearer
        const keep = (list) => list.filter(entry => {
            const fresh = !names.has(entry.property.name);
            names.add(entry.property.name);
            return fresh;
        });

        // Fields a parent entity already maps are inherited from it, not mapped again (even when
        // the child uses the same trait)
        const parent = cls.parent && classMap.get(cls.parent.toLowerCase());
        const parentEntity = parent && byClass.has(parent.fqcn.toLowerCase()) && !path.includes(parent);
        if (parentEntity) {
            collect(parent, parent, true, [...path, parent]).forEach(entry => names.add(entry.property.name));
        }

        // Precedence as in PHP: the class's own declaration, then the inherited one, then its traits'
        const own = keep(cls.properties.filter(p => !(hidePrivate && p.isPrivate)).map(property => ({ property, owner: cls, source })));

        let inherited = [];
        if (cls.parent && !parent) {
            warnOnce(`${cls.file.rel}: ${cls.name} extends ${cls.parent}, which is not in src/Entity: its fields are not shown.`);
        } else if (parent && !parentEntity && !byClass.has(parent.fqcn.toLowerCase()) && !path.includes(parent)) {
            const mapped = parent.mappings.some(m => m.kind === 'mappedsuperclass');
            inherited = keep(collect(parent, mapped ? parent : source, !mapped, [...path, parent]));
        }

        const fromTraits = [];
        for (const name of cls.traits) {
            const trait = classMap.get(name.toLowerCase());
            if (!trait) {
                warnOnce(`${cls.file.rel}: ${cls.name} uses trait ${name}, which is not in src/Entity: its fields are not shown.`);
            } else if (!path.includes(trait)) {
                fromTraits.push(...keep(collect(trait, source, hidePrivate, [...path, trait])));
            }
        }
        memo.set(key, [...inherited, ...own, ...fromTraits]);
        return memo.get(key);
    };
    for (const entity of entities) {
        entity.properties = collect(entity.cls, entity.cls, false, [entity.cls]);
    }

    // Entity inheritance: the InheritanceType of the root entity says where the child fields go.
    // The parent entity may be above mapped superclasses or plain classes.
    const parentOf = (entity) => {
        for (let cls = entity.cls, depth = 0; cls && cls.parent && depth < classes.length; depth++) {
            const name = cls.parent.toLowerCase();
            if (byClass.has(name)) {
                return byClass.get(name);
            }
            cls = classMap.get(name);
        }
        return undefined;
    };
    for (const entity of entities) {
        const chain = [entity];
        for (let parent = parentOf(entity); parent && !chain.includes(parent); parent = parentOf(parent)) {
            chain.push(parent);
        }
        const root = chain[chain.length - 1];
        const inheritance = root.cls.mappings.find(m => m.kind === 'inheritancetype');
        const type = (stringValue(inheritance, arg(inheritance, 'value')) || '').toUpperCase();
        if (type === 'SINGLE_TABLE' || type === 'JOINED') {
            entity.root = root;
            entity.singleTable = type === 'SINGLE_TABLE' && root !== entity;
            if (entity.singleTable) {
                entity.table = root.table;
            }
        } else if (root !== entity) {
            warnings.push(`${entity.cls.file.rel}: ${entity.cls.name} extends the entity ${chain[1].cls.name}, which has no inheritance type: inherited fields are not shown.`);
        }
    }

    const seen = new Map();
    for (const entity of entities.filter(e => !e.singleTable)) {
        if (seen.has(entity.table)) {
            warnings.push(`Table "${entity.table}" is mapped twice (${seen.get(entity.table)} and ${entity.cls.file.rel}).`);
        } else {
            seen.set(entity.table, entity.cls.file.rel);
        }
    }

    let gitStatus = null;
    if (options.git !== false) {
        try {
            gitStatus = readGitStatus(entityDir);
        } catch (error) {
            // Outside a repository there is simply no git status: only real failures are reported
            const reason = gitErrorReason(error);
            if (reason !== 'not a git repository') {
                warnings.push(`Git status is not shown: ${reason}.`);
            }
        }
    }

    // Git status of lines of the file declaring `cls`
    const statusByFile = new Map();
    const statusOf = (cls, first, last) => {
        if (!statusByFile.has(cls.file.path)) {
            statusByFile.set(cls.file.path, gitStatus(cls.file.path));
        }
        return statusByFile.get(cls.file.path)(first, last);
    };

    const foreignKeys = [];
    for (const entity of entities) {
        const { cls } = entity;
        const table = { table: entity.table, columns: [], relations: [] };

        const addColumn = (column, property, owner) => {
            if (table.columns.some(c => c.name === column.name)) {
                return false;
            }
            if (gitStatus) {
                column.git = statusOf(owner, property.lines[0], property.lines[1]);
            }
            table.columns.push(column);
            return true;
        };

        // Types and target entities are resolved in the declaring class (its namespace and imports)
        for (const { property, owner, source } of entity.properties) {
            if (property.isStatic || property.mappings.length === 0) {
                continue;
            }
            const find = (kind) => property.mappings.find(m => m.kind === kind);
            const isId = Boolean(find('id'));
            const relationKind = RELATION_KINDS.find(kind => find(kind));
            const label = `${cls.name}.${property.name}`;

            if (find('column') || (isId && !relationKind)) {
                const mapping = find('column');
                const column = {
                    name: unquoteName(stringValue(mapping, arg(mapping, 'name'))) || underscore(property.name),
                    type: columnType(mapping, property, owner.ctx, enums),
                };
                if (isId) {
                    column.primary = true;
                }
                // Doctrine makes the fields of single-table children nullable
                if (boolValue(arg(mapping, 'nullable')) === true || entity.singleTable) {
                    column.nullable = true;
                }
                addColumn(column, property, owner);
                continue;
            }

            if (!relationKind) {
                if (find('embedded')) {
                    warnings.push(`${label}: embedded fields are not shown.`);
                }
                continue;
            }

            // Only the owning side holds the foreign key; inverse sides would duplicate the edge
            const relation = find(relationKind);
            if (relationKind === 'onetomany' || arg(relation, 'mappedBy') !== undefined) {
                continue;
            }

            let target = classValue(relation, arg(relation, 'targetEntity'));
            if (!target && relationKind !== 'manytomany') {
                // maker-bundle omits targetEntity: Doctrine uses the property type
                target = typeClass(property.type, owner.ctx);
            }
            if (!target) {
                warnings.push(`${label}: target entity not found, relation skipped.`);
                continue;
            }
            const targetEntity = findEntity(target);
            const targetTable = targetEntity ? targetEntity.table : underscore(shortName(target));

            if (relationKind === 'manytomany') {
                const joinTable = find('jointable');
                const joins = joinColumns(property.mappings, joinTable);
                const selfReferencing = Boolean(targetEntity) && targetEntity.cls === source;
                const join = joins[0] || {};
                const references = join.references || 'id';
                // Named after the class that maps the field (a mapped superclass maps its own)
                const ownerName = underscore(source.name);
                table.relations.push({
                    foreignKey: join.name || `${ownerName}_${joins.length === 0 && selfReferencing ? 'source' : references}`,
                    references,
                    on: targetTable,
                    type: 'many-to-many',
                    via: unquoteName(stringValue(joinTable, arg(joinTable, 'name')))
                        || `${ownerName}_${underscore(shortName(target))}`,
                });
                continue;
            }

            const joins = joinColumns(property.mappings, null);
            for (const join of joins.length > 0 ? joins : [{}]) {
                const column = { name: join.name || `${underscore(property.name)}_id`, type: null };
                const references = join.references || 'id';
                if (isId) {
                    column.primary = true;
                } else if (join.nullable !== false) {
                    column.nullable = true;
                }
                if (addColumn(column, property, owner)) {
                    foreignKeys.push({ column, targetEntity, references });
                }
                table.relations.push({
                    foreignKey: column.name,
                    references,
                    on: targetTable,
                    type: relationKind === 'manytoone' ? 'many-to-one' : 'one-to-one',
                });
            }
        }
        entity.output = table;
        entity.columns = table.columns;
    }

    // Inheritance: root tables get the discriminator column. Then single-table children add their columns
    // to the root table; joined children get the root's primary key, also a foreign key to the root table.
    for (const root of entities.filter(e => e.root === e)) {
        const mapping = root.cls.mappings.find(m => m.kind === 'discriminatorcolumn');
        const column = {
            name: unquoteName(stringValue(mapping, arg(mapping, 'name'))) || 'dtype',
            // No PHP type: the explicit type, else Doctrine's default (string)
            type: columnType(mapping, { type: '' }, root.cls.ctx, enums),
        };
        if (gitStatus) {
            column.git = statusOf(root.cls, ...root.cls.lines);
        }
        root.output.columns.push(column);
    }
    for (const entity of entities.filter(e => e.root && e.root !== e)) {
        const { root } = entity;
        if (entity.singleTable) {
            root.output.columns.push(...entity.output.columns.filter(c => !root.output.columns.some(r => r.name === c.name)));
            // Siblings may map the same association (often through a shared trait): one relation each
            root.output.relations.push(...entity.output.relations.filter(relation => !root.output.relations.some(r => (
                r.foreignKey === relation.foreignKey && r.on === relation.on && r.type === relation.type
            ))));
            entity.columns = root.output.columns;
            continue;
        }
        // The copied keys belong to the child table: the child class declaration gives their git status
        const keys = root.output.columns.filter(c => c.primary).map(c => {
            const key = { ...c, type: null };
            if (gitStatus) {
                key.git = statusOf(entity.cls, ...entity.cls.lines);
            }
            return key;
        });
        entity.output.columns.unshift(...keys);
        entity.output.relations.unshift(...keys.map(c => ({ foreignKey: c.name, references: c.name, on: root.table, type: 'one-to-one' })));
        foreignKeys.push(...keys.map(column => ({ column, targetEntity: root, references: column.name })));
    }

    // Foreign key columns take the type of the column they reference (which may be a foreign key too)
    let pending = foreignKeys;
    while (pending.length > 0) {
        const next = pending.filter(fk => {
            const target = fk.targetEntity && fk.targetEntity.columns.find(c => c.name === fk.references);
            if (target && target.type) {
                fk.column.type = target.type;
                return false;
            }
            return true;
        });
        if (next.length === pending.length) {
            break;
        }
        pending = next;
    }
    for (const fk of pending) {
        fk.column.type = 'integer';
    }

    return { tables: entities.filter(e => !e.singleTable).map(e => e.output), warnings };
};

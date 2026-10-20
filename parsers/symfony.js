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
const { ParserError } = require('./errors');
const { createStatusReader, tableStatus } = require('./git');
const { composerPackages } = require('./composer');
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

// Unnamed arguments we understand, in Doctrine's constructor order (ORM 3). The other arguments of
// JoinColumn (unique, nullable, onDelete) are read by name only.
const POSITIONAL = {
    column: ['name', 'type', 'length', 'precision', 'scale', 'unique', 'nullable', 'insertable', 'updatable', 'enumType', 'options'],
    table: ['name', 'schema', 'indexes', 'uniqueConstraints'],
    jointable: ['name'],
    joincolumn: ['name', 'referencedColumnName'],
    inheritancetype: ['value'],
    discriminatorcolumn: ['name', 'type', 'length', 'columnDefinition', 'enumType', 'options'],
    generatedvalue: ['strategy'],
    index: ['name', 'columns', 'fields', 'flags', 'options'],
    uniqueconstraint: ['name', 'columns', 'fields', 'options'],
};

// Details of a column (option `details`), in the order of docs/pivot-format.md
const DETAIL_KEYS = ['length', 'precision', 'scale', 'unsigned', 'default', 'defaultRaw', 'values', 'unique', 'autoIncrement', 'comment'];
// Details a foreign key column takes from the column it references, like its type
const KEY_DETAILS = ['length', 'precision', 'scale', 'unsigned'];
// GeneratedValue strategies that let the database number the rows (AUTO is IDENTITY or SEQUENCE)
const GENERATED = new Set(['AUTO', 'IDENTITY', 'SEQUENCE']);
const ACTIONS = new Set(['cascade', 'set null', 'restrict', 'no action', 'set default']);
// Defaults DBAL writes as SQL expressions instead of strings, by column type
// (AbstractPlatform::getDefaultValueDeclarationSQL)
const SQL_DEFAULTS = new Map([
    ...['datetime', 'datetime_immutable', 'datetimetz', 'datetimetz_immutable', 'datetime_utc', 'datetime_utc_immutable']
        .map(type => [type, 'CURRENT_TIMESTAMP']),
    ['date', 'CURRENT_DATE'],
    ['date_immutable', 'CURRENT_DATE'],
    ['time', 'CURRENT_TIME'],
    ['time_immutable', 'CURRENT_TIME'],
]);

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

        // Cases of an enum (allowed values of its columns); the value is undefined when it is not a literal
        const enumCase = cls.kind === 'enum' && /^\s*case\s+([A-Za-z_]\w*)\s*(=)?/i.exec(head);
        if (enumCase) {
            const value = enumCase[2] ? unit.code.slice(statement.start + enumCase[0].length, statement.headEnd) : '';
            const string = parseStringLiteral(value);
            cls.cases.push({ name: enumCase[1], value: string === null ? integerValue(value) : string });
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
            cases: [],
        };
        if (!readClassBody(unit, cls, statement.headEnd + 1, statement.blockEnd)) {
            return false;
        }
        classes.push(cls);
    }
    return true;
}

// Classes declared in one PHP file
function readFile(file, warnings, overrides) {
    // The text of an unsaved editor, else the file. A BOM is replaced (not removed) so that offsets
    // and lines don't move.
    const text = overrides && overrides.has(file.path) ? overrides.get(file.path) : fs.readFileSync(file.path, 'utf8');
    const source = text.replace(/^\uFEFF/, ' ');
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

// Decimal integer literal (1_000 included), else undefined
function integerValue(raw) {
    const text = (raw || '').trim();
    return /^[+-]?(?:0|[1-9](?:_?\d)*)$/.test(text) ? parseInt(text.replace(/_/g, ''), 10) : undefined;
}

// Value of a literal argument: string, number, boolean or null; undefined for anything else
// (constants, expressions). An enum case (Suit::Hearts, Suit::Hearts->value) gives its value.
function literalValue(mapping, raw, enumCases) {
    if (raw === undefined) {
        return undefined;
    }
    const text = raw.trim();
    if (/^["']/.test(text)) {
        const string = stringValue(mapping, text);
        return string === null ? undefined : string;
    }
    const integer = integerValue(text);
    if (integer !== undefined) {
        return integer;
    }
    if (/^[+-]?(?:(?:\d+\.\d*|\.\d+)(?:e[+-]?\d+)?|\d+e[+-]?\d+)$/i.test(text)) {
        return parseFloat(text);
    }
    const keyword = text.replace(/^\\/, '').toLowerCase();
    if (keyword === 'true' || keyword === 'false' || keyword === 'null') {
        return keyword === 'null' ? null : keyword === 'true';
    }
    const enumCase = !mapping.annotation && /^(\\?[A-Za-z_][\w\\]*)\s*::\s*([A-Za-z_]\w*)(?:\s*->\s*value)?$/.exec(text);
    const cases = enumCase && enumCases.get(resolveClass(enumCase[1], mapping.ctx).toLowerCase());
    const found = cases && cases.find(c => c.name === enumCase[2]);
    return found ? found.value : undefined;
}

// Raw elements of an array argument: [...] or array(...), {...} in annotations; null for anything else
function listValue(mapping, raw) {
    if (raw === undefined) {
        return null;
    }
    if (!mapping.annotation) {
        return parseArrayLiteral(raw);
    }
    const text = raw.trim();
    return text.startsWith('{') && findMatching(text, 0) === text.length - 1 ? splitTopLevel(text.slice(1, -1), ',') : null;
}

// Strings of an array argument (columns: ['a', 'b']), or null when it is missing or not only strings
function stringList(mapping, raw) {
    const list = listValue(mapping, raw);
    const strings = list && list.map(entry => stringValue(mapping, entry));
    return strings && !strings.includes(null) ? strings : null;
}

// Entries of a key/value array argument ('key' => value; "key"=value or "key": value in annotations),
// as a Map of key → raw value
function mapValue(mapping, raw) {
    const map = new Map();
    for (const entry of listValue(mapping, raw) || []) {
        const match = mapping.annotation
            ? /^("(?:[^"]|"")*"|[A-Za-z_]\w*)\s*[=:]\s*([\s\S]*)$/.exec(entry)
            : /^('(?:[^'\\]|\\[\s\S])*'|"(?:[^"\\]|\\[\s\S])*")\s*=>\s*([\s\S]*)$/.exec(entry);
        const key = match && (/^["']/.test(match[1]) ? stringValue(mapping, match[1]) : match[1]);
        if (key !== null) {
            map.set(key, match[2]);
        }
    }
    return map;
}

// Mappings of a kind nested in an argument: [new ORM\Index(...), ...], or {@ORM\Index(...), ...} in annotations
function nestedMappings(mapping, raw, kind) {
    if (raw === undefined) {
        return [];
    }
    if (mapping.annotation) {
        return parseAnnotations(raw, mapping.ctx).filter(m => m.kind === kind);
    }
    return (parseArrayLiteral(raw) || [raw]).map(entry => {
        const match = /^new\s+(\\?[A-Za-z_][\w\\]*)\s*\(([\s\S]*)\)$/i.exec(entry.trim());
        return match && mappingKind(match[1], mapping.ctx) === kind
            ? { kind, args: parseArgs(match[2]), annotation: false, ctx: mapping.ctx }
            : null;
    }).filter(Boolean);
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
    const list = joinTable ? nestedMappings(joinTable, arg(joinTable, 'joinColumns'), 'joincolumn') : [];
    for (const mapping of mappings) {
        if (mapping.kind === 'joincolumn') {
            list.push(mapping);
        } else if (mapping.kind === 'joincolumns' && mapping.args.length > 0) {
            list.push(...nestedMappings(mapping, mapping.args[0].value, 'joincolumn'));
        }
    }

    return list.map(m => ({
        name: unquoteName(stringValue(m, arg(m, 'name'))),
        references: unquoteName(stringValue(m, arg(m, 'referencedColumnName'))),
        nullable: boolValue(arg(m, 'nullable')),
        unique: boolValue(arg(m, 'unique')),
        onDelete: stringValue(m, arg(m, 'onDelete')),
        mapping: m,
    }));
}

// ---------------------------------------------------------------------------------------------
// Details (option `details`)

// unsigned, default and comment of the `options` of a Column, DiscriminatorColumn or JoinColumn
function optionDetails(mapping, type, enumCases) {
    const details = {};
    const options = mapping ? mapValue(mapping, arg(mapping, 'options')) : new Map();
    if (literalValue(mapping, options.get('unsigned'), enumCases) === true) {
        details.unsigned = true;
    }
    if (options.has('default')) {
        // A key present with null is DEFAULT NULL; constants and expressions are skipped
        const value = literalValue(mapping, options.get('default'), enumCases);
        if (value !== undefined && value === SQL_DEFAULTS.get(type)) {
            details.defaultRaw = value;
        } else if (value !== undefined) {
            details.default = value;
        }
    }
    const comment = literalValue(mapping, options.get('comment'), enumCases);
    if (typeof comment === 'string') {
        details.comment = comment;
    }
    return details;
}

// Details declared by the mapping of a column: length, precision, scale, options, allowed values and
// unique. `phpType` and `ctx` (the declaring class) give the enum Doctrine infers from the property type.
function columnDetails(mapping, phpType, ctx, type, enumCases) {
    const details = {};
    for (const name of ['length', 'precision', 'scale']) {
        const value = mapping ? integerValue(arg(mapping, name)) : undefined;
        if (value !== undefined && value >= 0) {
            details[name] = value;
        }
    }
    Object.assign(details, optionDetails(mapping, type, enumCases));

    // The values of a DBAL enum column, else the cases of the backed enum mapped by the column: its
    // enumType, or its PHP type when the column has no explicit type (Doctrine infers it only then)
    const values = mapping ? stringList(mapping, mapValue(mapping, arg(mapping, 'options')).get('values')) : null;
    let enumClass = mapping ? classValue(mapping, arg(mapping, 'enumType')) : null;
    if (!enumClass && arg(mapping, 'type') === undefined && typeNames(phpType).length === 1) {
        enumClass = resolveClass(typeNames(phpType)[0], ctx);
    }
    const cases = enumClass && enumCases.get(enumClass.toLowerCase());
    if (values && values.length > 0) {
        details.values = values;
    } else if (cases && cases.length > 0 && cases.every(c => c.value !== undefined)) {
        details.values = cases.map(c => String(c.value));
    }

    if (mapping && boolValue(arg(mapping, 'unique')) === true) {
        details.unique = true;
    }
    return details;
}

// ON DELETE of a foreign key: the onDelete of its join columns (the last one wins, as in Doctrine),
// in lower case; null when none is declared or the action is unknown
function onDeleteOf(joins) {
    let action = null;
    for (const join of joins) {
        const value = join.onDelete ? join.onDelete.trim().replace(/\s+/g, ' ').toLowerCase() : null;
        if (ACTIONS.has(value)) {
            action = value;
        }
    }
    return action;
}

// Index and UniqueConstraint attributes of a class, and the indexes / uniqueConstraints of its Table
// (attribute or annotation), in the order of the code: [{ type, name, columns | fields }]
function classIndexes(cls) {
    const read = (mapping) => {
        const flags = (stringList(mapping, arg(mapping, 'flags')) || []).map(flag => flag.toLowerCase());
        const type = mapping.kind === 'uniqueconstraint' ? 'unique'
            : flags.includes('fulltext') ? 'fulltext' : flags.includes('spatial') ? 'spatial' : 'index';
        const columns = stringList(mapping, arg(mapping, 'columns'));
        return {
            type,
            name: unquoteName(stringValue(mapping, arg(mapping, 'name'))),
            columns: columns && columns.map(unquoteName),
            fields: stringList(mapping, arg(mapping, 'fields')),
        };
    };

    const list = [];
    for (const mapping of cls.mappings) {
        if (mapping.kind === 'table') {
            list.push(...nestedMappings(mapping, arg(mapping, 'indexes'), 'index').map(read));
            list.push(...nestedMappings(mapping, arg(mapping, 'uniqueConstraints'), 'uniqueconstraint').map(read));
        } else if ((mapping.kind === 'index' || mapping.kind === 'uniqueconstraint') && !mapping.annotation) {
            // As annotations, @ORM\Index and @ORM\UniqueConstraint are only allowed inside @ORM\Table
            list.push(read(mapping));
        }
    }
    return list;
}

// Adds the details to a column, after its other keys, in the order of DETAIL_KEYS
function assignDetails(column, details) {
    for (const key of DETAIL_KEYS) {
        if (key in details) {
            column[key] = details[key];
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Parser contract (docs/parsers.md)

module.exports.id = 'symfony';
module.exports.label = 'Symfony';

// For bin/console: 100 with symfony/framework-bundle in the "require" of composer.json, 80 with
// another symfony/* package except the polyfills (they are pulled by many non-Symfony projects)
// (ParserError: invalid composer.json)
module.exports.detect = function (basePath) {
    const packages = composerPackages(basePath);
    if (!isFile(path.join(basePath, 'bin', 'console'))) {
        return 0;
    }
    if (packages.includes('symfony/framework-bundle')) {
        return 100;
    }
    return packages.some(name => name.startsWith('symfony/') && !name.startsWith('symfony/polyfill-')) ? 80 : 0;
};

// The files read: the PHP files of src/Entity and its sub-folders
function sources(basePath) {
    return {
        folders: [{ path: path.resolve(basePath, 'src', 'Entity'), recursive: true }],
        files: [],
        extensions: ['.php'],
    };
}
module.exports.sources = sources;

// The databases of the schemes of a Doctrine DATABASE_URL, and of the drivers of doctrine.yaml
const URL_SCHEMES = new Map([
    ['postgresql', 'postgresql'], ['postgres', 'postgresql'], ['pgsql', 'postgresql'], ['pdo-pgsql', 'postgresql'],
    ['mysql', 'mysql'], ['mysql2', 'mysql'], ['mysqli', 'mysql'], ['pdo-mysql', 'mysql'], ['mariadb', 'mariadb'],
    ['sqlite', 'sqlite'], ['sqlite3', 'sqlite'], ['pdo-sqlite', 'sqlite'],
    ['sqlsrv', 'sqlserver'], ['mssql', 'sqlserver'], ['pdo-sqlsrv', 'sqlserver'],
]);
const DOCTRINE_DRIVERS = new Map([['pdo_pgsql', 'postgresql'], ['pgsql', 'postgresql'], ['pdo_mysql', 'mysql'], ['mysqli', 'mysql'], ['pdo_sqlite', 'sqlite'], ['sqlite3', 'sqlite'], ['pdo_sqlsrv', 'sqlserver'], ['sqlsrv', 'sqlserver']]);

// The last value of a variable in a .env file (the commented lines left out), or undefined
function envValue(text, name) {
    let value;
    for (const match of text.matchAll(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*(?:"([^"\\n]*)"|'([^'\\n]*)'|([^\\s#]*))`, 'gm'))) {
        value = match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3];
    }
    return value;
}

// The database of the application (docs/api.md): the scheme of DATABASE_URL in the .env files, in
// the order Symfony reads them (.env.<APP_ENV>.local, .env.<APP_ENV>, .env.local, .env), MariaDB
// told by its serverVersion; else the driver (and server_version) of
// config/packages/doctrine.yaml; null when they do not tell (a URL set by the environment)
module.exports.dialect = function (basePath) {
    if (typeof basePath !== 'string') {
        return null;
    }
    const read = (...file) => {
        try {
            return fs.readFileSync(path.join(basePath, ...file), 'utf8');
        } catch {
            return '';
        }
    };
    const mariadb = (text) => /mariadb/i.test(text);
    const appEnv = envValue(read('.env.local'), 'APP_ENV') || envValue(read('.env'), 'APP_ENV') || 'dev';
    const files = /^[\w-]+$/.test(appEnv) ? [`.env.${appEnv}.local`, `.env.${appEnv}`, '.env.local', '.env'] : ['.env.local', '.env'];
    for (const file of files) {
        const url = envValue(read(file), 'DATABASE_URL');
        if (url !== undefined) {
            const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
            const dialect = scheme ? URL_SCHEMES.get(scheme[1].toLowerCase()) || null : null;
            return dialect === 'mysql' && /[?&]serverVersion=[^&]*mariadb/i.test(url) ? 'mariadb' : dialect;
        }
    }
    const doctrine = read('config', 'packages', 'doctrine.yaml').replace(/#.*$/gm, '');
    const driver = /^[ \t]+driver[ \t]*:[ \t]*["']?(\w+)/m.exec(doctrine);
    const dialect = driver ? DOCTRINE_DRIVERS.get(driver[1].toLowerCase()) || null : null;
    const version = /^[ \t]+server_version[ \t]*:[ \t]*["']?([^"'\n]+)/m.exec(doctrine);
    return dialect === 'mysql' && version && mariadb(version[1]) ? 'mariadb' : dialect;
};

// ---------------------------------------------------------------------------------------------
// Tables

// Returns { tables, warnings }. Options:
// - git: false skips the git status (e.g. untrusted workspace)
// - overrides: Map of absolute file path → text of an unsaved editor, read instead of the file
// - gitCache: Map kept between parses, to run git again only once it is cleared
// - columnSources: true adds the declaration of each column (source: { file, line }), for the
//   tools that point at a column (not shown in the JSON viewer)
// - details: true adds the column details (length, default...), the indexes of each table and the
//   ON DELETE of the relations (docs/pivot-format.md), for exports and tools
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
        classes.push(...readFile(file, warnings, options.overrides));
    }

    // Enum backing types, used for enum columns, and the cases of the backed enums (details)
    const enums = new Map();
    const enumCases = new Map();
    for (const cls of classes) {
        if (cls.kind === 'enum') {
            enums.set(cls.fqcn.toLowerCase(), cls.backing || 'string');
            if (cls.backing) {
                enumCases.set(cls.fqcn.toLowerCase(), cls.cases);
            }
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
            entity.inSingleTable = type === 'SINGLE_TABLE';
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

    // Git status (and unsaved changes) of lines of the file declaring `cls`, null when unknown
    const reader = createStatusReader(sources(basePath), { git: options.git !== false, overrides: options.overrides, cache: options.gitCache });
    if (reader.warning) {
        warnings.push(reader.warning);
    }
    const statusOf = (cls, first, last) => reader.statusOf(cls.file.path)(first, last);
    const setStatus = (target, status) => {
        if (status) {
            target.git = status;
        }
    };

    const foreignKeys = [];
    // Details of each column (option `details`), added once every column is known so that they come
    // after the other keys
    const detailsOf = new Map();
    for (const entity of entities) {
        const { cls } = entity;
        const table = { table: entity.table, columns: [], relations: [] };
        // Column names of each mapped property, for the indexes declared with `fields`
        entity.fieldColumns = new Map();
        entity.extraIndexes = [];
        // The entity class, opened by a click in the diagram
        const source = { file: cls.file.rel, line: cls.lines[0] };

        const addColumn = (column, property, owner) => {
            if (table.columns.some(c => c.name === column.name)) {
                return false;
            }
            setStatus(column, statusOf(owner, property.lines[0], property.lines[1]));
            if (options.columnSources) {
                column.source = { file: owner.file.rel, line: property.lines[0] };
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
                entity.fieldColumns.set(property.name, [column.name]);
                if (addColumn(column, property, owner) && options.details) {
                    const details = columnDetails(mapping, property.type, owner.ctx, column.type, enumCases);
                    const generated = find('generatedvalue');
                    const strategy = generated && arg(generated, 'strategy') !== undefined
                        ? (stringValue(generated, arg(generated, 'strategy')) || '').toUpperCase()
                        : 'AUTO';
                    if (isId && generated && GENERATED.has(strategy)) {
                        details.autoIncrement = true;
                    }
                    detailsOf.set(column, details);
                }
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
                // Doctrine's default join columns cascade
                const onDelete = joins.length === 0 ? 'cascade' : onDeleteOf(joins);
                table.relations.push({
                    foreignKey: join.name || `${ownerName}_${joins.length === 0 && selfReferencing ? 'source' : references}`,
                    references,
                    on: targetTable,
                    type: 'many-to-many',
                    via: unquoteName(stringValue(joinTable, arg(joinTable, 'name')))
                        || `${ownerName}_${underscore(shortName(target))}`,
                    ...(options.details && onDelete ? { onDelete } : {}),
                });
                continue;
            }

            const joins = joinColumns(property.mappings, null);
            const onDelete = onDeleteOf(joins);
            // An owning one-to-one is unique (one join column) or gets a unique constraint (several),
            // except in a single-table hierarchy (ClassMetadata::validateAndCompleteOneToOneMapping)
            const oneToOneUnique = relationKind === 'onetoone' && !entity.inSingleTable;
            const names = [];
            for (const join of joins.length > 0 ? joins : [{}]) {
                const column = { name: join.name || `${underscore(property.name)}_id`, type: null };
                const references = join.references || 'id';
                names.push(column.name);
                if (isId) {
                    column.primary = true;
                } else if (join.nullable !== false) {
                    column.nullable = true;
                }
                if (addColumn(column, property, owner)) {
                    foreignKeys.push({ column, targetEntity, references });
                    if (options.details) {
                        const details = optionDetails(join.mapping, null, enumCases);
                        if (join.unique === true || (oneToOneUnique && joins.length <= 1 && !isId)) {
                            details.unique = true;
                        }
                        detailsOf.set(column, details);
                    }
                }
                table.relations.push({
                    foreignKey: column.name,
                    references,
                    on: targetTable,
                    type: relationKind === 'manytoone' ? 'many-to-one' : 'one-to-one',
                    ...(options.details && onDelete ? { onDelete } : {}),
                });
            }
            entity.fieldColumns.set(property.name, names);
            if (oneToOneUnique && names.length > 1) {
                entity.extraIndexes.push({ type: 'unique', name: `${property.name}_uniq`, columns: names });
            }
        }
        table.source = source;
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
        setStatus(column, statusOf(root.cls, ...root.cls.lines));
        root.output.columns.push(column);
        if (options.details) {
            detailsOf.set(column, columnDetails(mapping, '', root.cls.ctx, column.type, enumCases));
        }
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
            setStatus(key, statusOf(entity.cls, ...entity.cls.lines));
            // Same mapping as the root key, but not auto-incremented (SchemaTool)
            if (detailsOf.has(c)) {
                const details = { ...detailsOf.get(c) };
                delete details.autoIncrement;
                detailsOf.set(key, details);
            }
            return key;
        });
        entity.output.columns.unshift(...keys);
        // Doctrine deletes the child row with the root row
        entity.output.relations.unshift(...keys.map(c => ({
            foreignKey: c.name,
            references: c.name,
            on: root.table,
            type: 'one-to-one',
            ...(options.details ? { onDelete: 'cascade' } : {}),
        })));
        foreignKeys.push(...keys.map(column => ({ column, targetEntity: root, references: column.name })));
    }

    // Foreign key columns take the type of the column they reference (which may be a foreign key too),
    // and its length, precision, scale and unsigned (details) unless their JoinColumn sets them
    let pending = foreignKeys;
    while (pending.length > 0) {
        const next = pending.filter(fk => {
            const target = fk.targetEntity && fk.targetEntity.columns.find(c => c.name === fk.references);
            if (target && target.type) {
                fk.column.type = target.type;
                if (options.details) {
                    const inherited = detailsOf.get(target) || {};
                    const details = detailsOf.get(fk.column) || {};
                    for (const key of KEY_DETAILS.filter(k => k in inherited && !(k in details))) {
                        details[key] = inherited[key];
                    }
                    detailsOf.set(fk.column, details);
                }
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

    // Status of each table: its class declaration and its columns
    const tables = entities.filter(e => !e.singleTable);
    for (const entity of tables) {
        setStatus(entity.output, tableStatus(statusOf(entity.cls, ...entity.cls.lines), entity.output.columns.map(c => c.git)));
    }

    if (options.details) {
        for (const entity of tables) {
            addIndexes(entity, classMap, byClass, detailsOf);
            for (const column of entity.output.columns) {
                assignDetails(column, detailsOf.get(column) || {});
            }
        }
    }
    return { tables: tables.map(e => e.output), warnings };
};

// Indexes of an entity table (option `details`). The declarations of the entity come first, then its
// one-to-one unique constraints, then those of its mapped superclasses, nearest first (a name declared
// nearer wins, as in ClassMetadataFactory::addInheritedIndexes). Plain parent classes are skipped, an
// entity parent ends the chain. Single-table children are not tables: SchemaTool reads the indexes of
// the root entity only. One-column unique constraints become the `unique` detail of their column.
function addIndexes(entity, classMap, byClass, detailsOf) {
    const declarations = [...classIndexes(entity.cls), ...entity.extraIndexes];
    const visited = new Set();
    const parentClass = (cls) => cls.parent && classMap.get(cls.parent.toLowerCase());
    for (let cls = parentClass(entity.cls); cls && !byClass.has(cls.fqcn.toLowerCase()) && !visited.has(cls); cls = parentClass(cls)) {
        visited.add(cls);
        if (cls.mappings.some(m => m.kind === 'mappedsuperclass')) {
            declarations.push(...classIndexes(cls).filter(index => !index.name || !declarations.some(d => (
                d.name === index.name && (d.type === 'unique') === (index.type === 'unique')
            ))));
        }
    }

    const table = entity.output;
    const indexes = [];
    for (const index of declarations) {
        // `fields` are property names: their columns, or the join columns of an association
        const columns = index.columns || (index.fields || []).flatMap(field => entity.fieldColumns.get(field) || []);
        const column = columns.length === 1 && index.type === 'unique' && table.columns.find(c => c.name === columns[0]);
        if (column) {
            detailsOf.set(column, { ...detailsOf.get(column), unique: true });
        } else if (columns.length > 0) {
            indexes.push({ columns, type: index.type, ...(index.name ? { name: index.name } : {}) });
        }
    }
    if (indexes.length > 0) {
        table.indexes = indexes;
    }
}

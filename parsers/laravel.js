//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Laravel parser: replays database/migrations/*.php in filename order (like `php artisan migrate`)
// and keeps the state of every table. Only up() is read, with the migration's own methods it calls.

const fs = require('fs');
const path = require('path');
const { ParserError } = require('./errors');
const {
    skipLiteral,
    stripComments,
    findMatching,
    parseStringLiteral,
    parseArgs,
    parseArrayLiteral,
    createLineLocator,
} = require('./php-utils');

// Blueprint methods creating one column named by their first argument. point, polygon,
// unsignedDecimal... were removed in Laravel 11 but are kept for older migrations.
const COLUMN_METHODS = [
    'bigIncrements', 'increments', 'integerIncrements', 'mediumIncrements', 'smallIncrements', 'tinyIncrements',
    'char', 'string', 'tinyText', 'text', 'mediumText', 'longText',
    'integer', 'tinyInteger', 'smallInteger', 'mediumInteger', 'bigInteger',
    'unsignedInteger', 'unsignedTinyInteger', 'unsignedSmallInteger', 'unsignedMediumInteger', 'unsignedBigInteger',
    'foreignId', 'foreignUuid', 'foreignUlid',
    'float', 'double', 'decimal', 'unsignedFloat', 'unsignedDouble', 'unsignedDecimal', 'boolean',
    'enum', 'set', 'json', 'jsonb',
    'date', 'dateTime', 'dateTimeTz', 'time', 'timeTz', 'timestamp', 'timestampTz', 'year',
    'binary', 'uuid', 'ulid', 'ipAddress', 'macAddress',
    'geometry', 'geography', 'point', 'lineString', 'polygon', 'geometryCollection',
    'multiPoint', 'multiLineString', 'multiPolygon', 'multiPolygonZ',
    'computed', 'vector', 'tsvector', 'rawColumn',
];

// Column methods whose name argument is optional
const DEFAULT_NAMES = { uuid: 'uuid', ulid: 'ulid', ipAddress: 'ip_address', macAddress: 'mac_address' };

// Auto-increment columns are the primary key
const INCREMENTS = new Set(['bigIncrements', 'increments', 'integerIncrements', 'mediumIncrements', 'smallIncrements', 'tinyIncrements']);

// Integer methods taking ($column, $autoIncrement = false, ...)
const INTEGERS = new Set([
    'integer', 'tinyInteger', 'smallInteger', 'mediumInteger', 'bigInteger',
    'unsignedInteger', 'unsignedTinyInteger', 'unsignedSmallInteger', 'unsignedMediumInteger', 'unsignedBigInteger',
]);

// Methods returning a ForeignIdColumnDefinition (->constrained(), ->references()->on())
const FOREIGN_IDS = new Set(['foreignId', 'foreignUuid', 'foreignUlid', 'foreignIdFor', 'foreignUuidFor', 'foreignUlidFor']);

// Helpers expanding to one or more columns, handled in columnsFor()
const COLUMN_HELPERS = [
    'id', 'addColumn', 'foreignIdFor', 'foreignUuidFor', 'foreignUlidFor',
    'timestamps', 'nullableTimestamps', 'timestampsTz', 'nullableTimestampsTz', 'datetimes',
    'softDeletes', 'softDeletesTz', 'softDeletesDatetime', 'rememberToken',
    'morphs', 'numericMorphs', 'nullableMorphs', 'nullableNumericMorphs',
    'uuidMorphs', 'nullableUuidMorphs', 'ulidMorphs', 'nullableUlidMorphs',
];

// Other Blueprint methods handled in applyStatement()
const OTHER_METHODS = [
    'primary', 'unique', 'foreign', 'dropColumn', 'removeColumn', 'renameColumn',
    'dropTimestamps', 'dropTimestampsTz', 'dropSoftDeletes', 'dropSoftDeletesTz', 'dropRememberToken', 'dropMorphs',
    'dropForeign', 'dropConstrainedForeignId', 'dropForeignIdFor', 'dropConstrainedForeignIdFor',
    'dropUnique', 'dropPrimary', 'rename', 'drop', 'dropIfExists', 'after',
];

// Blueprint methods that never change columns or relations
const IGNORED_METHODS = [
    'index', 'fullText', 'spatialIndex', 'vectorIndex', 'rawIndex', 'dropIndex', 'dropFullText',
    'dropSpatialIndex', 'dropVectorIndex', 'renameIndex', 'engine', 'innoDb', 'charset', 'collation',
    'comment', 'temporary', 'create', 'getTable', 'getPrefix', 'getColumns', 'getCommands',
    'getAddedColumns', 'getChangedColumns',
];

const COLUMN_SET = new Set(COLUMN_METHODS);
const HELPER_SET = new Set(COLUMN_HELPERS);
const IGNORED_SET = new Set(IGNORED_METHODS);

// PHP method names are case-insensitive: map lower case to the documented spelling
const CANONICAL = new Map(
    [...COLUMN_METHODS, ...COLUMN_HELPERS, ...OTHER_METHODS, ...IGNORED_METHODS].map(name => [name.toLowerCase(), name]),
);

const canonical = (method) => CANONICAL.get(method.toLowerCase()) || method;
const isNull = (value) => value === undefined || /^null$/i.test(value.trim());
const isTrue = (value) => value !== undefined && /^true$/i.test(value.trim());
const isFalse = (value) => value !== undefined && /^false$/i.test(value.trim());

// --- English pluralizer, modeled on Laravel's Str::plural() (doctrine/inflector rules) ---

// Whole words left as they are (doctrine/inflector English uninflected list, Laravel's own list)
const UNCOUNTABLE = new Set([
    'advice', 'aircraft', 'amoyese', 'art', 'audio', 'baggage', 'bison', 'borghese', 'bream', 'breeches',
    'britches', 'buffalo', 'butter', 'cantus', 'carp', 'cattle', 'chassis', 'clippers', 'clothing', 'coal',
    'cod', 'coitus', 'compensation', 'congoese', 'contretemps', 'coreopsis', 'corps', 'cotton', 'data',
    'debris', 'deer', 'diabetes', 'djinn', 'education', 'eland', 'elk', 'emoji', 'equipment', 'evidence',
    'faroese', 'feedback', 'fish', 'flounder', 'flour', 'foochowese', 'food', 'furniture', 'gallows',
    'genevese', 'genoese', 'gilbertese', 'gold', 'headquarters', 'herpes', 'hijinks', 'homework',
    'hottentotese', 'impatience', 'information', 'innings', 'jackanapes', 'jeans', 'jedi', 'kin',
    'kiplingese', 'knowledge', 'kongoese', 'leather', 'love', 'lucchese', 'luggage', 'mackerel', 'maltese',
    'management', 'media', 'metadata', 'mews', 'money', 'moose', 'mumps', 'music', 'nankingese', 'news',
    'nexus', 'niasese', 'nutrition', 'offspring', 'oil', 'patience', 'pekingese', 'people', 'piedmontese',
    'pincers', 'pistoiese', 'plankton', 'pliers', 'pokemon', 'police', 'polish', 'portuguese', 'proceedings',
    'progress', 'rabies', 'rain', 'recommended', 'related', 'research', 'rhinoceros', 'rice', 'salmon',
    'sand', 'sarawakese', 'scissors', 'series', 'shavese', 'shears', 'sheep',
    'siemens', 'silk', 'sms', 'soap', 'spam', 'species', 'staff', 'sugar', 'swine', 'talent',
    'toothpaste', 'traffic', 'travel', 'trivia', 'trousers', 'trout', 'tuna', 'us', 'vermontese', 'vinegar',
    'weather', 'wenchowese', 'wheat', 'whiting', 'wildebeest', 'wood', 'wool', 'yengeese',
]);

const UNCOUNTABLE_SUFFIX = /^\w+(?:media|ware)$/i;

// Irregular plurals of whole words (doctrine/inflector), only those the rules below get wrong.
// A Map, so that names such as 'constructor' are not looked up in Object.prototype.
const IRREGULAR = new Map(Object.entries({
    alga: 'algae', atlas: 'atlases', blouse: 'blouses', cafe: 'cafes', canvas: 'canvases', chateau: 'chateaux',
    curriculum: 'curricula', die: 'dice', domino: 'dominoes', echo: 'echoes', epoch: 'epochs', gas: 'gases',
    genus: 'genera', goose: 'geese', graffito: 'graffiti', hippopotamus: 'hippopotami', human: 'humans',
    iris: 'irises', larva: 'larvae', leaf: 'leaves', lens: 'lenses', loaf: 'loaves', memorandum: 'memoranda',
    motto: 'mottoes', mythos: 'mythoi', niveau: 'niveaux', numen: 'numina', passerby: 'passersby',
    penis: 'penises', plateau: 'plateaux', safe: 'safes', stadium: 'stadiums', thief: 'thieves', tooth: 'teeth',
    tornado: 'tornadoes', trilby: 'trilbys', turf: 'turfs',
}));

// First matching rule wins (same order as doctrine/inflector)
const PLURAL_RULES = [
    [/(s)tatus$/i, '$1tatuses'],
    [/(quiz)$/i, '$1zes'],
    [/^(ox)$/i, '$1en'],
    [/([m|l])ouse$/i, '$1ice'],
    [/(matr|vert|ind)(ix|ex)$/i, '$1ices'],
    [/(x|ch|ss|sh)$/i, '$1es'],
    [/([^aeiouy]|qu)y$/i, '$1ies'],
    [/(hive|gulf)$/i, '$1s'],
    [/(?:([^f])fe|([lr])f)$/i, '$1$2ves'],
    [/sis$/i, 'ses'],
    [/([ti])um$/i, '$1a'],
    [/(tax)on$/i, '$1a'],
    [/(c)riterion$/i, '$1riteria'],
    [/(p)erson$/i, '$1eople'],
    [/(m)an$/i, '$1en'],
    [/(c)hild$/i, '$1hildren'],
    [/(f)oot$/i, '$1eet'],
    [/(buffal|her|potat|tomat|volcan)o$/i, '$1oes'],
    [/(alumn|bacill|cact|foc|fung|nucle|radi|stimul|syllab|termin|vir)us$/i, '$1i'],
    [/us$/i, 'uses'],
    [/(alias)$/i, '$1es'],
    [/(analys|ax|cris|test|thes)is$/i, '$1es'],
    [/s$/i, 's'],
    [/$/, 's'],
];

function plural(word) {
    const lower = word.toLowerCase();
    if (!/[A-Za-z0-9\u0080-\uffff]$/.test(word) || UNCOUNTABLE.has(lower) || UNCOUNTABLE_SUFFIX.test(word)) {
        return word;
    }
    let result;
    if (IRREGULAR.has(lower)) {
        result = IRREGULAR.get(lower);
        result = word[0] === lower[0] ? result : result[0].toUpperCase() + result.slice(1);
    } else {
        const [pattern, replacement] = PLURAL_RULES.find(([rule]) => rule.test(word));
        result = word.replace(pattern, replacement);
    }
    // Pluralizer::matchCase() for upper-case words
    return word !== lower && word === word.toUpperCase() ? result.toUpperCase() : result;
}

// Str::snake()
const snake = (name) => name.replace(/(.)(?=[A-Z])/g, '$1_').toLowerCase();

// Str::beforeLast()
function beforeLast(subject, search) {
    const index = subject.lastIndexOf(search);
    return search === '' || index === -1 ? subject : subject.slice(0, index);
}

// Class basename of a `User::class`, `'App\Models\User'` or `new User` expression, or null
function modelName(value) {
    if (value === undefined) {
        return null;
    }
    const text = value.trim();
    const match = /^\\?((?:\w+\\)*\w+)::class$/i.exec(text) || /^new\s+\\?((?:\w+\\)*\w+)\s*(?:\(\s*\))?$/i.exec(text);
    const name = match ? match[1] : parseStringLiteral(text);
    if (!name || !/^\\?(?:\w+\\)*\w+$/.test(name)) {
        return null;
    }
    return name.slice(name.lastIndexOf('\\') + 1);
}

// Model::getForeignKey() and Model::getTable() with Laravel's defaults
const modelForeignKey = (model) => snake(model) + '_id';
function modelTable(model) {
    const words = snake(model).split('_');
    words.push(plural(words.pop()));
    return words.join('_');
}

// Default index name, as Blueprint::createIndexName() builds it
const indexName = (table, columns, type) => `${table}_${columns.join('_')}_${type}`.toLowerCase().replace(/[-.]/g, '_');

// --- Scanning helpers ---

// 1 for every offset inside a string literal, so that regex matches there are ignored
function literalMask(code) {
    const mask = new Uint8Array(code.length);
    let i = 0;
    while (i < code.length) {
        const end = skipLiteral(code, i);
        if (end === -1) {
            i++;
        } else {
            mask.fill(1, i, end);
            i = end;
        }
    }
    return mask;
}

// Next match of the global regex `re` in [from, to) that is not inside a string literal
function findNext(ctx, re, from, to) {
    re.lastIndex = from;
    let match;
    while ((match = re.exec(ctx.code)) !== null && match.index < to) {
        if (!ctx.mask[match.index]) {
            return match;
        }
        re.lastIndex = match.index + 1;
    }
    return null;
}

// Warnings are kept on one line
function warn(ctx, index, message) {
    ctx.state.warnings.push(`${ctx.file}:${ctx.lineAt(index)}: ${message.replace(/\s+/g, ' ')}`);
}

// Raw PHP code quoted in a warning, shortened to about 60 characters
function excerpt(value) {
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

// Argument `name`, or else the positional argument at `index` (raw PHP text, or undefined)
function arg(args, index, name) {
    const named = args.find(a => a.name === name);
    if (named) {
        return named.value;
    }
    const positional = args.filter(a => a.name === null);
    return index < positional.length ? positional[index].value : undefined;
}

// Strings of a 'name' or ['a', 'b'] argument, or null when one of them is not a literal
function stringList(value) {
    if (value === undefined) {
        return null;
    }
    const names = (parseArrayLiteral(value) || [value]).map(parseStringLiteral);
    return names.includes(null) ? null : names;
}

const CHAINED_CALL = /\s*\??->\s*(\w+)\s*\(/y;

// Reads `method(args)->modifier(...)->...` from the '(' at `open`: { calls: [{ method, args, from, to }], end }
function readChain(code, open, method) {
    const calls = [];
    for (;;) {
        const close = findMatching(code, open);
        if (close === -1) {
            return null;
        }
        calls.push({ method, args: parseArgs(code.slice(open + 1, close)), from: open + 1, to: close });
        CHAINED_CALL.lastIndex = close + 1;
        const next = CHAINED_CALL.exec(code);
        if (!next) {
            return { calls, end: close + 1 };
        }
        method = next[1];
        open = CHAINED_CALL.lastIndex - 1;
    }
}

// PHP keywords and class names are case-insensitive, hence the 'i' flags
const CLOSURE = /\b(function|fn)\s*&?\s*\(/gi;

// First closure in [from, to): { varName, from, to } with the body bounds, or null
function findClosure(ctx, from, to) {
    const { code } = ctx;
    const match = findNext(ctx, CLOSURE, from, to);
    if (!match) {
        return null;
    }
    const paramsOpen = match.index + match[0].length - 1;
    const paramsClose = findMatching(code, paramsOpen);
    if (paramsClose === -1 || paramsClose >= to) {
        return null;
    }
    const param = /\$(\w+)/.exec(code.slice(paramsOpen + 1, paramsClose));
    const varName = param ? param[1] : null;

    if (match[1].toLowerCase() === 'fn') {
        const arrow = /\s*(?::\s*\??[\w\\|]+\s*)?=>/y;
        arrow.lastIndex = paramsClose + 1;
        return arrow.exec(code) ? { varName, from: arrow.lastIndex, to } : null;
    }

    let i = paramsClose + 1;
    const use = /\s*use\s*\(/iy;
    use.lastIndex = i;
    if (use.exec(code)) {
        i = findMatching(code, use.lastIndex - 1) + 1;
        if (i === 0) {
            return null;
        }
    }
    const open = /\s*(?::\s*\??[\w\\|]+\s*)?\{/y;
    open.lastIndex = i;
    if (!open.exec(code)) {
        return null;
    }
    const close = findMatching(code, open.lastIndex - 1);
    return close === -1 ? null : { varName, from: open.lastIndex, to: close };
}

// --- Table state ---

const findTable = (state, name) => state.tables.find(t => t.name === name);
const newColumn = (name, type, flags = {}) => ({ name, type, primary: false, nullable: false, unique: false, ...flags });

function removeTable(state, name) {
    state.tables = state.tables.filter(t => t.name !== name);
}

function dropTable(state, name) {
    removeTable(state, name);
    for (const table of state.tables) {
        table.relations = table.relations.filter(r => r.on !== name);
    }
}

function renameTable(ctx, table, to, index) {
    const { state } = ctx;
    if (to === table.name) {
        return;
    }
    if (!to) {
        warn(ctx, index, `rename of table ${table.name} skipped: empty name`);
        return;
    }
    if (findTable(state, to)) {
        warn(ctx, index, `table ${table.name} renamed to the existing table ${to}, which is replaced`);
        removeTable(state, to);
    }
    for (const other of state.tables) {
        for (const relation of other.relations) {
            if (relation.on === table.name) {
                relation.on = to;
            }
        }
    }
    table.name = to;
}

// Adds a column, or updates it in place when it already exists
function addColumn(table, column, change) {
    const index = table.columns.findIndex(c => c.name === column.name);
    if (index === -1) {
        table.columns.push(column);
    } else if (change) {
        const existing = table.columns[index];
        existing.type = column.type;
        existing.nullable = column.nullable;
        existing.primary = existing.primary || column.primary;
        existing.unique = existing.unique || column.unique;
    } else {
        table.columns[index] = column;
    }
}

// Dropping a column also drops the foreign keys built on it
function dropColumns(table, names) {
    table.columns = table.columns.filter(c => !names.includes(c.name));
    table.relations = table.relations.filter(r => !names.includes(r.foreignKey));
}

function addRelation(table, relation) {
    const index = table.relations.findIndex(r => r.foreignKey === relation.foreignKey);
    if (index === -1) {
        table.relations.push(relation);
    } else {
        table.relations[index] = relation;
    }
}

function renameColumn(ctx, table, from, to, index) {
    const column = table.columns.find(c => c.name === from);
    if (!column) {
        warn(ctx, index, `renameColumn('${from}', '${to}') skipped: ${table.name}.${from} is unknown`);
        return;
    }
    if (!to) {
        warn(ctx, index, `renameColumn('${from}', '') skipped: empty name`);
        return;
    }
    column.name = to;
    for (const relation of table.relations) {
        if (relation.foreignKey === from) {
            relation.foreignKey = to;
        }
    }
    for (const other of ctx.state.tables) {
        for (const relation of other.relations) {
            if (relation.on === table.name && relation.references === from) {
                relation.references = to;
            }
        }
    }
}

// --- Blueprint statements ---

// Name argument of a column method, `fallback` when it is omitted, null (and a warning) otherwise
function columnName(ctx, value, method, fallback, index) {
    if (isNull(value)) {
        if (fallback === undefined) {
            warn(ctx, index, `${method}() without a column name skipped`);
            return null;
        }
        return fallback;
    }
    const name = parseStringLiteral(value);
    if (!name) {
        warn(ctx, index, `${method}(${excerpt(value)}) skipped: ${name === null ? 'dynamic' : 'empty'} column name`);
    }
    return name || null;
}

// Column of foreignIdFor(Model::class, column?) and the like, or null (and a warning)
function modelColumn(ctx, args, method, index) {
    const modelArg = arg(args, 0, 'model');
    const model = modelName(modelArg);
    const columnArg = arg(args, 1, 'column');
    if (!model && isNull(columnArg)) {
        warn(ctx, index, `${method}(${excerpt(modelArg || '')}) skipped: dynamic model`);
        return null;
    }
    return columnName(ctx, columnArg, method, model ? modelForeignKey(model) : undefined, index);
}

// Columns created by a column method or helper ([] when nothing can be added)
function columnsFor(ctx, method, args, index) {
    const nameArg = arg(args, 0, 'column');

    if (COLUMN_SET.has(method)) {
        const name = columnName(ctx, nameArg, method, DEFAULT_NAMES[method], index);
        if (name === null) {
            return [];
        }
        const autoIncrement = INCREMENTS.has(method) || (INTEGERS.has(method) && isTrue(arg(args, 1, 'autoIncrement')));
        return [newColumn(name, method, { primary: autoIncrement })];
    }

    switch (method) {
        case 'id': {
            const name = columnName(ctx, nameArg, method, 'id', index);
            return name === null ? [] : [newColumn(name, 'bigIncrements', { primary: true })];
        }
        case 'addColumn': {
            const type = parseStringLiteral(arg(args, 0, 'type') || '');
            const name = columnName(ctx, arg(args, 1, 'name'), method, undefined, index);
            if (!type) {
                warn(ctx, index, `addColumn() skipped: ${type === null ? 'dynamic' : 'empty'} column type`);
            }
            return !type || name === null ? [] : [newColumn(name, type)];
        }
        case 'foreignIdFor':
        case 'foreignUuidFor':
        case 'foreignUlidFor': {
            const name = modelColumn(ctx, args, method, index);
            return name === null ? [] : [newColumn(name, method.replace('For', ''))];
        }
        case 'timestamps':
        case 'nullableTimestamps':
        case 'timestampsTz':
        case 'nullableTimestampsTz':
        case 'datetimes': {
            const type = method === 'datetimes' ? 'dateTime' : method.endsWith('Tz') ? 'timestampTz' : 'timestamp';
            return ['created_at', 'updated_at'].map(name => newColumn(name, type, { nullable: true }));
        }
        case 'softDeletes':
        case 'softDeletesTz':
        case 'softDeletesDatetime': {
            const type = { softDeletes: 'timestamp', softDeletesTz: 'timestampTz', softDeletesDatetime: 'dateTime' }[method];
            const name = columnName(ctx, nameArg, method, 'deleted_at', index);
            return name === null ? [] : [newColumn(name, type, { nullable: true })];
        }
        case 'rememberToken':
            return [newColumn('remember_token', 'string', { nullable: true })];
        case 'morphs':
        case 'numericMorphs':
        case 'nullableMorphs':
        case 'nullableNumericMorphs':
        case 'uuidMorphs':
        case 'nullableUuidMorphs':
        case 'ulidMorphs':
        case 'nullableUlidMorphs': {
            // {name}_type + {name}_id, no relation (polymorphic)
            const name = columnName(ctx, arg(args, 0, 'name'), method, undefined, index);
            if (name === null) {
                return [];
            }
            const lower = method.toLowerCase();
            const idType = lower.includes('uuid') ? 'uuid' : lower.includes('ulid') ? 'ulid' : 'unsignedBigInteger';
            const nullable = method.startsWith('nullable');
            return [newColumn(`${name}_type`, 'string', { nullable }), newColumn(`${name}_id`, idType, { nullable })];
        }
        default:
            throw new Error(`COLUMN_HELPERS lists ${method}() but columnsFor() does not expand it`);
    }
}

// Applies ->nullable(), ->primary()... Modifiers after ->constrained() or ->references() belong to
// the foreign key, not to the column, so Laravel ignores them: so do we.
function applyModifiers(column, calls) {
    for (const call of calls) {
        const name = call.method.toLowerCase();
        if (name === 'constrained' || name === 'references') {
            break;
        }
        if (name === 'nullable') {
            column.nullable = !isFalse(arg(call.args, 0, 'value'));
        } else if (name === 'primary' || name === 'autoincrement') {
            column.primary = true;
        } else if (name === 'unique') {
            column.unique = true;
        }
    }
}

const findCall = (calls, name) => calls.find(call => call.method.toLowerCase() === name);
const firstArg = (call) => (call && call.args.length > 0 ? call.args[0].value : undefined);

// Relation of a foreignId-like column: ->constrained(table?, column?) or ->references(column)->on(table)
function foreignIdRelation(ctx, table, column, calls, model, index) {
    const constrained = findCall(calls, 'constrained');
    let references;
    let on;
    let constraint;

    if (constrained) {
        const tableArg = arg(constrained.args, 0, 'table');
        const columnArg = arg(constrained.args, 1, 'column');
        references = isNull(columnArg) ? 'id' : parseStringLiteral(columnArg);
        if (!isNull(tableArg)) {
            on = parseStringLiteral(tableArg);
        } else if (model !== undefined) {
            on = model ? modelTable(model) : null;
        } else if (references !== null) {
            on = plural(beforeLast(column, '_' + references));
        }
        constraint = parseStringLiteral(arg(constrained.args, 2, 'indexName') || '');
    } else {
        const referencesCall = findCall(calls, 'references');
        if (!referencesCall) {
            return;
        }
        references = parseStringLiteral(arg(referencesCall.args, 0, 'column') || '');
        on = parseStringLiteral(firstArg(findCall(calls, 'on')) || '');
        constraint = parseStringLiteral(arg(referencesCall.args, 1, 'indexName') || '');
    }

    if (!references || !on) {
        warn(ctx, index, `foreign key on ${table.name}.${column} skipped: unknown referenced table or column`);
        return;
    }
    addRelation(table, { foreignKey: column, references, on, constraint: constraint || indexName(table.name, [column], 'foreign') });
}

// $table->foreign('col' or ['a', 'b'], name?)->references(...)->on(...), in any order
function foreignRelation(ctx, table, head, calls, index) {
    const columns = stringList(arg(head.args, 0, 'columns'));
    const references = stringList(firstArg(findCall(calls, 'references')) || "'id'");
    const on = parseStringLiteral(firstArg(findCall(calls, 'on')) || '');
    if (!columns?.length || !references?.length || !on || columns.includes('') || references.includes('')) {
        warn(ctx, index, `foreign key on ${table.name} skipped: dynamic or missing columns, references() or on()`);
        return;
    }
    const constraint = parseStringLiteral(arg(head.args, 1, 'name') || '') || indexName(table.name, columns, 'foreign');
    columns.forEach((column, i) => {
        addRelation(table, { foreignKey: column, references: references[i] || references[0], on, constraint });
    });
}

// Argument of dropForeign() / dropUnique(): the columns (['col']) or the index name
// ('posts_user_id_foreign') as { columns, name }, or null (and a warning) when it is dynamic
function indexArgument(ctx, method, value, index) {
    const columns = parseArrayLiteral(value || '') ? stringList(value) : [];
    const name = parseStringLiteral(value || '');
    if (columns === null || (columns.length === 0 && name === null)) {
        warn(ctx, index, `${method}() skipped: dynamic index name`);
        return null;
    }
    return { columns, name };
}

// Removes the foreign keys on these columns, or the one with this (default or custom) name
function dropForeign(table, { columns, name }) {
    table.relations = table.relations.filter(relation => !columns.includes(relation.foreignKey)
        && relation.constraint !== name && indexName(table.name, [relation.foreignKey], 'foreign') !== name);
}

// Applies one `$table->method(...)->...` chain to `blueprint.table`
function applyStatement(ctx, blueprint, chain, index) {
    const { table } = blueprint;
    const [head, ...modifiers] = chain.calls;
    const method = canonical(head.method);
    const { args } = head;

    if (COLUMN_SET.has(method) || HELPER_SET.has(method)) {
        const columns = columnsFor(ctx, method, args, index);
        const change = modifiers.some(call => call.method.toLowerCase() === 'change');
        if (columns.length === 1) {
            applyModifiers(columns[0], modifiers);
        }
        for (const column of columns) {
            addColumn(table, column, change);
            if (!change) {
                blueprint.added.add(column.name);
            }
        }
        if (columns.length === 1 && FOREIGN_IDS.has(method)) {
            const model = method.endsWith('For') ? modelName(arg(args, 0, 'model')) : undefined;
            foreignIdRelation(ctx, table, columns[0].name, modifiers, model, index);
        }
        return;
    }

    switch (method) {
        case 'primary':
        case 'unique': {
            // Applied at the end of the closure, like Laravel runs index commands after the columns
            const columns = stringList(arg(args, 0, 'columns'));
            if (columns) {
                blueprint.indexes.push({ type: method, columns });
            }
            break;
        }
        case 'foreign':
            foreignRelation(ctx, table, head, modifiers, index);
            break;
        case 'dropColumn': {
            const names = args.map(a => stringList(a.value));
            if (names.includes(null)) {
                warn(ctx, index, `${method}() skipped: dynamic column name`);
            } else {
                dropColumns(table, names.flat());
            }
            break;
        }
        case 'removeColumn': {
            // Only takes back a column added earlier by this Blueprint, existing columns are kept
            const name = columnName(ctx, arg(args, 0, 'name'), method, undefined, index);
            if (name !== null && blueprint.added.delete(name)) {
                dropColumns(table, [name]);
            }
            break;
        }
        case 'renameColumn': {
            const from = parseStringLiteral(arg(args, 0, 'from') || '');
            const to = parseStringLiteral(arg(args, 1, 'to') || '');
            if (from === null || to === null) {
                warn(ctx, index, 'renameColumn() skipped: dynamic column name');
            } else {
                renameColumn(ctx, table, from, to, index);
            }
            break;
        }
        case 'dropTimestamps':
        case 'dropTimestampsTz':
            dropColumns(table, ['created_at', 'updated_at']);
            break;
        case 'dropSoftDeletes':
        case 'dropSoftDeletesTz': {
            const name = columnName(ctx, arg(args, 0, 'column'), method, 'deleted_at', index);
            if (name !== null) {
                dropColumns(table, [name]);
            }
            break;
        }
        case 'dropRememberToken':
            dropColumns(table, ['remember_token']);
            break;
        case 'dropMorphs': {
            const name = columnName(ctx, arg(args, 0, 'name'), method, undefined, index);
            if (name !== null) {
                dropColumns(table, [`${name}_type`, `${name}_id`]);
            }
            break;
        }
        case 'dropForeign': {
            const target = indexArgument(ctx, method, arg(args, 0, 'index'), index);
            if (target) {
                dropForeign(table, target);
            }
            break;
        }
        case 'dropConstrainedForeignId': {
            const name = columnName(ctx, arg(args, 0, 'column'), method, undefined, index);
            if (name !== null) {
                dropColumns(table, [name]);
            }
            break;
        }
        case 'dropForeignIdFor':
        case 'dropConstrainedForeignIdFor': {
            const name = modelColumn(ctx, args, method, index);
            if (name !== null) {
                dropColumns(table, [name]);
            }
            break;
        }
        case 'dropUnique': {
            const target = indexArgument(ctx, method, arg(args, 0, 'index'), index);
            if (target) {
                for (const column of table.columns) {
                    if (target.columns.includes(column.name) || indexName(table.name, [column.name], 'unique') === target.name) {
                        column.unique = false;
                    }
                }
            }
            break;
        }
        case 'dropPrimary':
            table.columns.forEach(column => { column.primary = false; });
            break;
        case 'rename': {
            const to = parseStringLiteral(arg(args, 0, 'to') || '');
            if (to === null) {
                warn(ctx, index, 'rename() skipped: dynamic table name');
            } else {
                blueprint.rename = { to, index };
            }
            break;
        }
        case 'drop':
        case 'dropIfExists':
            blueprint.drop = true;
            break;
        case 'after': {
            const closure = findClosure(ctx, head.from, head.to);
            if (closure && closure.varName) {
                applyClosureBody(ctx, blueprint, closure);
            }
            break;
        }
        default:
            if (!IGNORED_SET.has(method)) {
                warn(ctx, index, `unknown Blueprint method ${head.method}() ignored`);
            }
    }
}

// Runs every `$var->...;` chain found in a closure body
function applyClosureBody(ctx, blueprint, closure) {
    const statement = new RegExp(`\\$${closure.varName}\\b\\s*\\??->\\s*(\\w+)\\s*\\(`, 'g');
    let pos = closure.from;
    let match;
    while ((match = findNext(ctx, statement, pos, closure.to)) !== null) {
        const chain = readChain(ctx.code, match.index + match[0].length - 1, match[1]);
        if (!chain) {
            warn(ctx, match.index, 'unbalanced parentheses, rest of the closure skipped');
            return;
        }
        applyStatement(ctx, blueprint, chain, match.index);
        pos = chain.end;
    }
}

// Schema::create/table(name, closure)
function applyBlueprint(ctx, table, from, to, index) {
    const closure = findClosure(ctx, from, to);
    if (!closure || !closure.varName) {
        warn(ctx, index, `Blueprint closure of table ${table.name} not found, its columns are skipped`);
        return;
    }

    // `added`: columns created by this closure, the only ones removeColumn() can take back
    const blueprint = { table, indexes: [], added: new Set(), rename: null, drop: false };
    applyClosureBody(ctx, blueprint, closure);

    for (const { type, columns } of blueprint.indexes) {
        for (const column of table.columns.filter(c => columns.includes(c.name))) {
            if (type === 'primary') {
                column.primary = true;
            } else if (columns.length === 1) {
                column.unique = true;
            }
        }
    }
    if (blueprint.drop) {
        dropTable(ctx.state, table.name);
    } else if (blueprint.rename) {
        renameTable(ctx, table, blueprint.rename.to, blueprint.rename.index);
    }
}

// --- Schema calls ---

// Table name argument, or null (and a warning) when it is not a literal
function tableName(ctx, value, method, index) {
    const name = value === undefined ? null : parseStringLiteral(value);
    if (!name) {
        const reason = name === null ? 'dynamic' : 'empty';
        warn(ctx, index, `Schema::${method}(${excerpt(value || '')}) skipped: ${reason} table name`);
    }
    return name || null;
}

// Applies Schema::method(args) where the arguments are code[from, to). Returns false for unknown methods.
function applySchemaCall(ctx, method, from, to, index) {
    const { state, code } = ctx;
    const args = parseArgs(code.slice(from, to));

    switch (method.toLowerCase()) {
        // whenTableHasColumn('users', 'phone', callback)... run Schema::table() when a condition holds.
        // It cannot be evaluated statically, so the callback is applied as if it ran.
        case 'whentablehascolumn':
        case 'whentabledoesnthavecolumn':
        case 'whentablehasindex':
        case 'whentabledoesnthaveindex':
        case 'create':
        case 'table': {
            const name = tableName(ctx, arg(args, 0, 'table'), method, index);
            if (name === null) {
                return true;
            }
            let table = findTable(state, name);
            if (method.toLowerCase() === 'create') {
                if (table) {
                    warn(ctx, index, `table ${name} is created again, its previous definition is replaced`);
                    removeTable(state, name);
                }
                table = null;
            } else if (!table) {
                warn(ctx, index, `Schema::${method}('${name}') on a table that no migration creates, table added`);
            }
            if (!table) {
                table = { name, columns: [], relations: [] };
                state.tables.push(table);
            }
            applyBlueprint(ctx, table, from, to, index);
            return true;
        }
        case 'drop':
        case 'dropifexists': {
            const name = tableName(ctx, arg(args, 0, 'table'), method, index);
            if (name !== null) {
                dropTable(state, name);
            }
            return true;
        }
        case 'rename': {
            const name = tableName(ctx, arg(args, 0, 'from'), method, index);
            const to = name === null ? null : tableName(ctx, arg(args, 1, 'to'), method, index);
            const table = name === null ? null : findTable(state, name);
            if (to !== null && !table) {
                warn(ctx, index, `Schema::rename('${name}', '${to}') skipped: table ${name} is unknown`);
            } else if (to !== null) {
                renameTable(ctx, table, to, index);
            }
            return true;
        }
        case 'dropcolumns': {
            const name = tableName(ctx, arg(args, 0, 'table'), method, index);
            const columns = stringList(arg(args, 1, 'columns'));
            const table = name === null ? null : findTable(state, name);
            if (table && columns) {
                dropColumns(table, columns);
            } else if (table) {
                warn(ctx, index, 'Schema::dropColumns() skipped: dynamic column name');
            }
            return true;
        }
        default:
            return false;
    }
}

// What applyMethod() looks for: `Schema::method(`, the migration's own methods (`$this->method(`,
// `self::method(`, `static::method(`), and `$schema->method(` for each variable set to
// Schema::connection(...), `$this->schema` set in the constructor (Telescope) included
function schemaCallPattern(ctx) {
    const schemaVars = new Set();
    const assignment = /\$(this\s*->\s*)?(\w+)\s*=\s*\\?(?:\w+\\)*Schema\s*::\s*connection\s*\(/gi;
    let match;
    let pos = 0;
    while ((match = findNext(ctx, assignment, pos, ctx.code.length)) !== null) {
        schemaVars.add(match[1] ? `\\$this\\s*->\\s*${match[2]}` : `\\$${match[2]}`);
        pos = assignment.lastIndex;
    }
    const facadeCall = '(?<!\\$)\\bSchema\\s*::\\s*(\\w+)\\s*\\(';
    const ownCall = '(?:\\$this\\s*->|\\b(?:self|static)\\s*::)\\s*(\\w+)\\s*\\(';
    const varCall = schemaVars.size > 0 ? `|(?:${[...schemaVars].join('|')})\\b\\s*->\\s*(\\w+)\\s*\\(` : '';
    return new RegExp(`${facadeCall}|${ownCall}${varCall}`, 'gi');
}

// Applies every Schema call of the method `name` (body code[body.from, body.to)), in source order.
// The migration's own methods called there are applied where they are called; `calling` holds the
// methods being applied, so that recursive calls are not followed.
function applyMethod(ctx, name, body, calling) {
    const { code } = ctx;
    const chainedCall = /\s*->\s*(\w+)\s*\(/y;
    calling.add(name.toLowerCase());

    let pos = body.from;
    let match;
    while ((match = findNext(ctx, ctx.schemaCall, pos, body.to)) !== null) {
        let open = match.index + match[0].length - 1;

        if (match[2]) {
            const helper = calling.has(match[2].toLowerCase()) ? null : findMethodBody(ctx, match[2]);
            if (helper) {
                applyMethod(ctx, match[2], helper, calling);
            }
            // Its arguments are scanned too, like those of unknown Schema calls
            pos = open + 1;
            continue;
        }

        let method = match[1] || match[3];
        let close = findMatching(code, open);
        if (close !== -1 && method.toLowerCase() === 'connection') {
            chainedCall.lastIndex = close + 1;
            const chained = chainedCall.exec(code);
            if (chained) {
                method = chained[1];
                open = chainedCall.lastIndex - 1;
                close = findMatching(code, open);
            }
        }
        if (close === -1) {
            warn(ctx, match.index, `unbalanced parentheses, rest of ${name}() skipped`);
            break;
        }

        // Unknown calls (hasTable, withoutForeignKeyConstraints...) may wrap other Schema calls
        pos = applySchemaCall(ctx, method, open + 1, close, match.index) ? close + 1 : open + 1;
    }
    calling.delete(name.toLowerCase());
}

// Bounds of the body of the method `name` (case-insensitive, like PHP), or null
function findMethodBody(ctx, name) {
    const { code } = ctx;
    const declaration = new RegExp(`\\bfunction\\s+&?\\s*${name}\\s*\\(`, 'gi');
    // Optional return type: void, ?int, int|null, static, \Foo\Bar...
    const body = /\s*(?::\s*[\w\\?|&()]+(?:\s+[\w\\?|&()]+)*\s*)?\{/y;
    let pos = 0;
    let match;
    while ((match = findNext(ctx, declaration, pos, code.length)) !== null) {
        pos = match.index + 1;
        const paramsClose = findMatching(code, match.index + match[0].length - 1);
        if (paramsClose === -1) {
            continue;
        }
        body.lastIndex = paramsClose + 1;
        if (!body.exec(code)) {
            continue;
        }
        const close = findMatching(code, body.lastIndex - 1);
        if (close !== -1) {
            return { from: body.lastIndex, to: close };
        }
    }
    return null;
}

function applyMigration(state, file, source) {
    const code = stripComments(source);
    const ctx = { state, file, code, mask: literalMask(code), lineAt: createLineLocator(code) };
    const up = findMethodBody(ctx, 'up');
    if (!up) {
        warn(ctx, 0, 'no up() method found, file skipped');
        return;
    }
    ctx.schemaCall = schemaCallPattern(ctx);
    applyMethod(ctx, 'up', up, new Set());
}

// Internal table state to the pivot format of CONTRACT.md
function toPivot(table) {
    const primaryCount = table.columns.filter(c => c.primary).length;
    const isUnique = (name) => table.columns.some(c => c.name === name && (c.unique || (c.primary && primaryCount === 1)));

    return {
        table: table.name,
        columns: table.columns.map(c => {
            const column = { name: c.name, type: c.type };
            if (c.primary) {
                column.primary = true;
            }
            if (c.nullable) {
                column.nullable = true;
            }
            return column;
        }),
        relations: table.relations.map(r => ({
            foreignKey: r.foreignKey,
            references: r.references,
            on: r.on,
            type: isUnique(r.foreignKey) ? 'one-to-one' : 'many-to-one',
        })),
    };
}

// stat() that returns null for missing paths and broken links
function stat(file) {
    try {
        return fs.statSync(file);
    } catch {
        return null;
    }
}

module.exports.parse = function (basePath) {
    const migrationsPath = path.join(basePath, 'database', 'migrations');
    const folder = stat(migrationsPath);
    if (!folder || !folder.isDirectory()) {
        throw new ParserError(`Laravel migrations folder not found: ${migrationsPath}`);
    }

    // Same files as `php artisan migrate` (glob '*_*.php', so no dotfile), in the same order: by name
    const files = fs.readdirSync(migrationsPath)
        .filter(file => !file.startsWith('.') && file.includes('_') && file.endsWith('.php'))
        .filter(file => stat(path.join(migrationsPath, file))?.isFile())
        .sort();
    if (files.length === 0) {
        throw new ParserError(`No PHP migration files found in ${migrationsPath}`);
    }

    const state = { tables: [], warnings: [] };
    for (const file of files) {
        applyMigration(state, file, fs.readFileSync(path.join(migrationsPath, file), 'utf8'));
    }

    return { tables: state.tables.map(toPivot), warnings: state.warnings };
};

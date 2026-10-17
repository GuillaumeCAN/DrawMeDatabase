//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { generateMermaidER } = require('../../views/mermaid/generator');

// The Mermaid build bundled in the extension (devDependency, pinned): checks the generated text
// against its real erDiagram parser. Skipped when node_modules is not installed.
const MERMAID_ESM = path.join(__dirname, '..', '..', 'node_modules', 'mermaid', 'dist', 'mermaid.esm.mjs');
const mermaidInstalled = fs.existsSync(MERMAID_ESM);
let mermaidPromise;

// Entities are returned by label (the table name) instead of by generated id
async function parseWithMermaid(source) {
    if (!mermaidPromise) {
        mermaidPromise = import(pathToFileURL(MERMAID_ESM).href).then(module => {
            const mermaid = module.default;
            mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
            return mermaid;
        });
    }
    const mermaid = await mermaidPromise;
    await mermaid.parse(source);
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
    const byId = diagram.db.getEntities();
    const label = (id) => (Object.prototype.hasOwnProperty.call(byId, id) ? shown(byId[id].alias) : undefined);
    const entities = new Map(Object.keys(byId).map(id => [label(id), byId[id]]));
    const relationships = diagram.db.getRelationships().map(relation => ({
        ...relation,
        entityA: label(relation.entityA),
        entityB: label(relation.entityB),
        roleA: shown(relation.roleA),
    }));
    return { ids: Object.keys(byId), entities, relationships };
}

// The text Mermaid draws: it encodes '#123;' as 'ﬂ°°123¶ß' while parsing, then writes it back
// as '&#123;' in the SVG markup (decodeEntities), which the page reads as the character
const shown = (text) => String(text).replace(/ﬂ°°(\d+)¶ß/g, (match, code) => String.fromCharCode(Number(code)));

const lines = (source) => source.split('\n');

const USERS = {
    table: 'users',
    columns: [
        { name: 'id', type: 'bigIncrements', primary: true },
        { name: 'email', type: 'string' },
        { name: 'created_at', type: 'timestamp', nullable: true },
    ],
    relations: [],
};
const POSTS = {
    table: 'posts',
    columns: [
        { name: 'id', type: 'bigIncrements', primary: true },
        { name: 'user_id', type: 'unsignedBigInteger' },
        { name: 'title', type: 'string' },
    ],
    relations: [{ foreignKey: 'user_id', references: 'id', on: 'users', type: 'many-to-one' }],
};

// Every diagram built by the tests, parsed by Mermaid at the end
const generated = [];
const generate = (tables) => {
    const source = generateMermaidER(tables);
    generated.push(source);
    return source;
};

test('entities get an id and their name as label, attributes are "type name" with PK / FK keys', () => {
    assert.equal(generate([USERS, POSTS]), [
        'erDiagram',
        '  e1["users"] {',
        '    bigIncrements id PK',
        '    string email',
        '    timestamp created_at',
        '  }',
        '  e2["posts"] {',
        '    bigIncrements id PK',
        '    unsignedBigInteger user_id FK',
        '    string title',
        '  }',
        '  e1 ||--o{ e2 : "user_id"',
        '',
    ].join('\n'));
});

test('a primary key that is also a foreign key gets both keys', () => {
    const source = generate([USERS, {
        table: 'profiles',
        columns: [{ name: 'user_id', type: 'unsignedBigInteger', primary: true }],
        relations: [{ foreignKey: 'user_id', references: 'id', on: 'users', type: 'one-to-one' }],
    }]);
    assert.ok(lines(source).includes('    unsignedBigInteger user_id PK, FK'));
});

test('cardinalities follow the relation type', () => {
    const source = generate([
        USERS,
        POSTS,
        {
            table: 'profiles',
            columns: [{ name: 'id', type: 'integer', primary: true }, { name: 'user_id', type: 'integer' }],
            relations: [{ foreignKey: 'user_id', references: 'id', on: 'users', type: 'one-to-one' }],
        },
        {
            table: 'post',
            columns: [{ name: 'id', type: 'integer', primary: true }],
            relations: [{ foreignKey: 'post_id', references: 'id', on: 'tag', type: 'many-to-many', via: 'post_tag' }],
        },
        { table: 'tag', columns: [{ name: 'id', type: 'integer', primary: true }], relations: [] },
    ]);
    const output = lines(source);
    assert.ok(output.includes('  e1 ||--o{ e2 : "user_id"'), 'many-to-one (users -> posts)');
    assert.ok(output.includes('  e1 ||--o| e3 : "user_id"'), 'one-to-one (users -> profiles)');
    assert.ok(output.includes('  e4 }o--o{ e5 : "post_tag"'), 'many-to-many (post -> tag) uses via');
    // The join column of a many-to-many relation is not a column of the owning table
    assert.ok(output.includes('    integer id PK'));
    assert.ok(!source.includes('post_id'));
});

test('a relation without type is many-to-one (backward compatible)', () => {
    const source = generate([USERS, { table: 'posts', columns: [], relations: [{ foreignKey: 'user_id', references: 'id', on: 'users' }] }]);
    assert.ok(lines(source).includes('  e1 ||--o{ e2 : "user_id"'));
    const unknownType = generate([{ table: 'a', columns: [], relations: [{ foreignKey: 'b_id', references: 'id', on: 'b', type: 'whatever' }] }]);
    assert.ok(lines(unknownType).includes('  e2 ||--o{ e1 : "b_id"'));
});

test('many-to-many without via falls back to the foreign key label', () => {
    const source = generate([{ table: 'a', columns: [], relations: [{ foreignKey: 'a_id', references: 'id', on: 'b', type: 'many-to-many' }] }]);
    assert.ok(lines(source).includes('  e1 }o--o{ e2 : "a_id"'));
});

test('labels have their quotes stripped', () => {
    const source = generate([{ table: 'a', columns: [], relations: [{ foreignKey: '"b_id"', references: 'id', on: 'b' }] }]);
    assert.ok(lines(source).includes('  e2 ||--o{ e1 : "b_id"'));
    const percent = generate([{ table: 'a', columns: [], relations: [{ foreignKey: 'x%%{init}%%"\\', references: 'id', on: 'b' }] }]);
    assert.ok(lines(percent).includes('  e2 ||--o{ e1 : "x__{init}___"'));
});

test("'#' and ':' are written as Mermaid entity codes", () => {
    const source = generate([{ table: 'table#x;', columns: [], relations: [{ foreignKey: 'style:#f00;', references: 'id', on: 'b' }] }]);
    assert.deepEqual(lines(source).slice(1), [
        '  e1["table#35;x;"]',
        '  e2["b"]',
        '  e2 ||--o{ e1 : "style#58;#35;f00;"',
        '',
    ]);
});

test('identical edges are emitted once', () => {
    const relation = { foreignKey: 'user_id', references: 'id', on: 'users', type: 'many-to-one' };
    const source = generate([USERS, { table: 'posts', columns: [], relations: [relation, { ...relation }, { foreignKey: 'user_id', references: 'id', on: 'users' }] }]);
    assert.equal(lines(source).filter(line => line.includes('||--o{')).length, 1);
});

test('tables without columns and relation targets that are not tables are declared', () => {
    assert.equal(generate([{ table: 'cache', columns: [], relations: [] }]), 'erDiagram\n  e1["cache"]\n');
    assert.equal(generate([{ table: 'posts', columns: [], relations: [{ foreignKey: 'team_id', references: 'id', on: 'teams' }] }]),
        'erDiagram\n  e1["posts"]\n  e2["teams"]\n  e2 ||--o{ e1 : "team_id"\n');
});

test('duplicate table entries are merged', () => {
    const source = generate([
        { table: 'users', columns: [{ name: 'id', type: 'integer', primary: true }], relations: [] },
        { table: 'users', columns: [{ name: 'id', type: 'string' }, { name: 'phone', type: 'string' }], relations: [] },
    ]);
    assert.equal(source, 'erDiagram\n  e1["users"] {\n    integer id PK\n    string phone\n  }\n');
});

test('types are reduced to one Mermaid word', () => {
    const source = generate([{
        table: 'post',
        columns: [
            { name: 'tags', type: '\\Doctrine\\Common\\Collections\\Collection' },
            { name: 'items', type: 'Collection<int, Post>' },
            { name: 'subtitle', type: '?string' },
            { name: 'publishedAt', type: '\\DateTimeImmutable' },
            { name: 'price', type: 'decimal(8,2)' },
            { name: 'flag', type: 'uk' },
            { name: 'unknown_type', type: '' },
            { name: 'missing_type' },
        ],
        relations: [],
    }]);
    assert.deepEqual(lines(source).slice(2, 10), [
        '    Collection tags',
        '    Collection items',
        '    string subtitle',
        '    DateTimeImmutable publishedAt',
        '    decimal_8_2_ price',
        '    uk_ flag',
        '    unknown unknown_type',
        '    unknown missing_type',
    ]);
});

test('column names are sanitized', () => {
    const source = generate([{
        table: 'users',
        columns: [
            { name: '2fa_secret', type: 'string' },
            { name: 'pk', type: 'string' },
            { name: 'FK', type: 'string' },
            { name: 'first name', type: 'string' },
            { name: 'prénom', type: 'string' },
            { name: 'user-id', type: 'integer' },
            { name: '?', type: 'string' },
            { name: '_token', type: 'string' },
        ],
        relations: [],
    }]);
    assert.deepEqual(lines(source).slice(2, 10), [
        '    string _2fa_secret',
        '    string pk_',
        '    string FK_',
        '    string first_name',
        '    string prenom',
        '    integer user_id',
        '    string unnamed',
        '    string _token',
    ]);
});

// Words of the erDiagram grammar, and Object.prototype keys: Mermaid 10.9.8 keeps its entities in
// a plain object, so 'constructor' or '__proto__' used as an entity name breaks the whole diagram
const ODD_NAMES = ['end', 'one', 'u', 'to', '2fa', 'password reset tokens', 'erDiagram', 'MANY', 'user-roles',
    'style', 'classDef', 'accTitle', ...Object.getOwnPropertyNames(Object.prototype)];

test('any table name is only a quoted label', () => {
    const source = generate([
        ...ODD_NAMES.map(table => ({ table, columns: [{ name: 'id', type: 'integer' }], relations: [] })),
        { table: 'a"b%c\\d', columns: [], relations: [{ foreignKey: 'to_id', references: 'id', on: 'to' }] },
        { table: '', columns: [], relations: [] },
    ]);
    const output = lines(source);
    assert.ok(output.includes('  e1["end"] {'));
    assert.ok(output.includes('  e10["style"] {'));
    assert.ok(output.includes(`  e${ODD_NAMES.indexOf('constructor') + 1}["constructor"] {`));
    assert.ok(output.includes(`  e${ODD_NAMES.indexOf('__proto__') + 1}["__proto__"] {`));
    assert.ok(output.includes(`  e${ODD_NAMES.length + 1}["ab_c_d"]`));
    assert.ok(output.includes(`  e${ODD_NAMES.length + 2}["unnamed"]`));
    assert.ok(output.includes(`  e4 ||--o{ e${ODD_NAMES.length + 1} : "to_id"`));
});

test('names that are equal after cleaning stay distinct entities', () => {
    const source = generate([
        { table: 'a"b', columns: [], relations: [] },
        { table: 'ab', columns: [], relations: [] },
    ]);
    assert.equal(source, 'erDiagram\n  e1["ab"]\n  e2["ab"]\n');
});

test('invalid input does not throw', () => {
    assert.equal(generate(undefined), 'erDiagram\n');
    assert.equal(generate(null), 'erDiagram\n');
    assert.equal(generate({}), 'erDiagram\n');
    assert.equal(generate([null, 42, { table: 'x' }]), 'erDiagram\n  e1["x"]\n');
    assert.equal(generate([{ table: 'x', columns: [null], relations: [null, { foreignKey: 'a' }] }]), 'erDiagram\n  e1["x"]\n');
    // A relation without foreign key still gets the (mandatory) label, empty
    assert.equal(generate([{ table: 'x', columns: [], relations: [{ on: 'y' }] }]), 'erDiagram\n  e1["x"]\n  e2["y"]\n  e2 ||--o{ e1 : ""\n');
});

test('every generated diagram is accepted by Mermaid 10.9.8', { skip: !mermaidInstalled && 'node_modules/mermaid is not installed' }, async () => {
    assert.ok(generated.length > 10);
    for (const source of generated) {
        await assert.doesNotReject(parseWithMermaid(source), source);
    }
});

test('Mermaid reads the attributes and cardinalities as intended', { skip: !mermaidInstalled && 'node_modules/mermaid is not installed' }, async () => {
    const { entities, relationships } = await parseWithMermaid(generateMermaidER([
        USERS,
        POSTS,
        { table: 'profiles', columns: [], relations: [{ foreignKey: 'user_id', references: 'id', on: 'users', type: 'one-to-one' }] },
        { table: 'post', columns: [], relations: [{ foreignKey: 'post_id', references: 'id', on: 'tag', type: 'many-to-many', via: 'post_tag' }] },
    ]));

    assert.deepEqual(entities.get('posts').attributes[1],
        { attributeType: 'unsignedBigInteger', attributeName: 'user_id', attributeKeyTypeList: ['FK'] });
    assert.deepEqual(entities.get('users').attributes[0],
        { attributeType: 'bigIncrements', attributeName: 'id', attributeKeyTypeList: ['PK'] });

    // relSpec.cardB is the marker next to entityA, cardA the one next to entityB
    const relation = (a, b) => relationships.find(r => r.entityA === a && r.entityB === b);
    assert.deepEqual(relation('users', 'posts').relSpec, { cardA: 'ZERO_OR_MORE', relType: 'IDENTIFYING', cardB: 'ONLY_ONE' });
    assert.deepEqual(relation('users', 'profiles').relSpec, { cardA: 'ZERO_OR_ONE', relType: 'IDENTIFYING', cardB: 'ONLY_ONE' });
    assert.deepEqual(relation('post', 'tag').relSpec, { cardA: 'ZERO_OR_MORE', relType: 'IDENTIFYING', cardB: 'ZERO_OR_MORE' });
    assert.equal(relation('post', 'tag').roleA, 'post_tag');
});

test('Mermaid keeps every odd table name, and shows labels as written', { skip: !mermaidInstalled && 'node_modules/mermaid is not installed' }, async () => {
    const names = [...ODD_NAMES, 'table#x;', 'x&#60;y', 'R&D', 'fk#1;'];
    const { ids, entities, relationships } = await parseWithMermaid(generateMermaidER([
        ...names.map(table => ({ table, columns: [{ name: 'id', type: 'integer', primary: true }], relations: [] })),
        { table: 'links', columns: [], relations: names.map(on => ({ foreignKey: `${on}_id`, references: 'id', on })) },
        { table: 'styles', columns: [], relations: [{ foreignKey: 'style:#f00;', references: 'id', on: 'end' }] },
    ]));

    assert.equal(ids.length, names.length + 2);
    for (const name of names) {
        assert.deepEqual(entities.get(name).attributes, [{ attributeType: 'integer', attributeName: 'id', attributeKeyTypeList: ['PK'] }], name);
        assert.ok(relationships.some(r => r.entityA === name && r.entityB === 'links' && r.roleA === `${name}_id`), name);
    }
    assert.ok(relationships.some(r => r.entityA === 'end' && r.entityB === 'styles' && r.roleA === 'style:#f00;'));
});

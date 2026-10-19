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

const { generateMermaidER, buildDiagram } = require('../../views/mermaid/generator');

// The Mermaid build bundled in the extension (devDependency, pinned): checks the generated text
// against its real erDiagram parser. Skipped when node_modules is not installed.
const MERMAID_PACKAGE = path.join(__dirname, '..', '..', 'node_modules', 'mermaid');
const MERMAID_ESM = path.join(MERMAID_PACKAGE, 'dist', 'mermaid.esm.mjs');
const mermaidInstalled = fs.existsSync(MERMAID_ESM);
const mermaidVersion = mermaidInstalled ? require(path.join(MERMAID_PACKAGE, 'package.json')).version : 'not installed';
const skip = !mermaidInstalled && 'node_modules/mermaid is not installed';
let mermaidPromise;

// Entities are returned by label (the table name) instead of by id
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
    // Relationships name entities by their internal id ('entity-users-0')
    const byInternalId = new Map([...byId.values()].map(entity => [entity.id, entity]));
    const label = (entity) => (entity ? shown(entity.alias || entity.label) : undefined);
    const entities = new Map([...byId.values()].map(entity => [label(entity), entity]));
    const relationships = diagram.db.getRelationships().map(relation => ({
        ...relation,
        entityA: label(byInternalId.get(relation.entityA)),
        entityB: label(byInternalId.get(relation.entityB)),
        roleA: shown(relation.roleA),
    }));
    return { ids: [...byId.keys()], entities, relationships };
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
const generate = (tables, options) => {
    const source = generateMermaidER(tables, options);
    generated.push(source);
    return source;
};

test('tables are entities named after them, attributes are "type name" with PK / FK keys', () => {
    assert.equal(generate([USERS, POSTS]), [
        'erDiagram',
        '  users {',
        '    bigIncrements id PK',
        '    string email',
        '    timestamp? created_at',
        '  }',
        '  posts {',
        '    bigIncrements id PK',
        '    unsignedBigInteger user_id FK',
        '    string title',
        '  }',
        '  users ||--o{ posts : "user_id"',
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
    assert.ok(output.includes('  users ||--o{ posts : "user_id"'), 'many-to-one (users -> posts)');
    assert.ok(output.includes('  users ||--o| profiles : "user_id"'), 'one-to-one (users -> profiles)');
    assert.ok(output.includes('  post }o--o{ tag : "post_tag"'), 'many-to-many (post -> tag) uses via');
    // The join column of a many-to-many relation is not a column of the owning table
    assert.ok(output.includes('    integer id PK'));
    assert.ok(!source.includes('post_id'));
});

test('a relation without type is many-to-one (backward compatible)', () => {
    const source = generate([USERS, { table: 'posts', columns: [], relations: [{ foreignKey: 'user_id', references: 'id', on: 'users' }] }]);
    assert.ok(lines(source).includes('  users ||--o{ posts : "user_id"'));
    const unknownType = generate([{ table: 'a', columns: [], relations: [{ foreignKey: 'b_id', references: 'id', on: 'b', type: 'whatever' }] }]);
    assert.ok(lines(unknownType).includes('  b ||--o{ a : "b_id"'));
});

test('many-to-many without via falls back to the foreign key label', () => {
    const source = generate([{ table: 'a', columns: [], relations: [{ foreignKey: 'a_id', references: 'id', on: 'b', type: 'many-to-many' }] }]);
    assert.ok(lines(source).includes('  a }o--o{ b : "a_id"'));
});

test('labels have their quotes stripped', () => {
    const source = generate([{ table: 'a', columns: [], relations: [{ foreignKey: '"b_id"', references: 'id', on: 'b' }] }]);
    assert.ok(lines(source).includes('  b ||--o{ a : "b_id"'));
    const percent = generate([{ table: 'a', columns: [], relations: [{ foreignKey: 'x%%{init}%%"\\', references: 'id', on: 'b' }] }]);
    assert.ok(lines(percent).includes('  b ||--o{ a : "x__{init}___"'));
});

test("'#' and ':' are written as Mermaid entity codes", () => {
    const source = generate([{ table: 'table#x;', columns: [], relations: [{ foreignKey: 'style:#f00;', references: 'id', on: 'b' }] }]);
    assert.deepEqual(lines(source).slice(1), [
        '  t1["table#35;x;"]',
        '  b',
        '  b ||--o{ t1 : "style#58;#35;f00;"',
        '',
    ]);
});

test('"direction LR" in a name is not read as a direction statement', () => {
    const source = generate([{ table: 'direction LR', columns: [], relations: [{ foreignKey: 'x direction tb', references: 'id', on: 'b' }] }]);
    assert.deepEqual(lines(source).slice(1), [
        '  t1["direction_LR"]',
        '  b',
        '  b ||--o{ t1 : "x direction_tb"',
        '',
    ]);
});

// Two '~' are read as a generic type (List~T~): the lexer took '"~ default: a~b"' for a type word
test("only the first '~' of a text is written as is, the next ones as the look-alike '∼'", () => {
    const { gitLabel } = require('../../views/mermaid/generator');
    const source = generate([{
        table: 'a~b~c',
        columns: [
            { name: 'email', type: 'string', note: '~ default a~b' },
            { name: 'name', type: 'List~T~', note: 'x ~y~ z~' },
            { name: 'title', type: 'string', note: '~ one tilde' },
        ],
        relations: [{ foreignKey: 'k~1~', references: 'id', on: 'b' }],
    }], { marks: true });
    assert.deepEqual(lines(source).slice(1), [
        '  t1["a~b∼c"] {',
        '    string email "~ default a∼b"',
        '    List_T_ name "x ~y∼ z∼"',
        '    string title "~ one tilde"',
        '  }',
        '  b',
        '  b ||--o{ t1 : "k~1∼"',
        '',
    ]);
    assert.equal(gitLabel('unsaved', { unsaved: '~non~ enregistré~' }), '● ~non∼ enregistré∼');
});

test('identical edges are emitted once', () => {
    const relation = { foreignKey: 'user_id', references: 'id', on: 'users', type: 'many-to-one' };
    const source = generate([USERS, { table: 'posts', columns: [], relations: [relation, { ...relation }, { foreignKey: 'user_id', references: 'id', on: 'users' }] }]);
    assert.equal(lines(source).filter(line => line.includes('||--o{')).length, 1);
});

test('tables without columns and relation targets that are not tables are declared', () => {
    assert.equal(generate([{ table: 'cache', columns: [], relations: [] }]), 'erDiagram\n  cache\n');
    assert.equal(generate([{ table: 'posts', columns: [], relations: [{ foreignKey: 'team_id', references: 'id', on: 'teams' }] }]),
        'erDiagram\n  posts\n  teams\n  teams ||--o{ posts : "team_id"\n');
});

test('duplicate table entries are merged', () => {
    const source = generate([
        { table: 'users', columns: [{ name: 'id', type: 'integer', primary: true }], relations: [] },
        { table: 'users', columns: [{ name: 'id', type: 'string' }, { name: 'phone', type: 'string' }], relations: [] },
    ]);
    assert.equal(source, 'erDiagram\n  users {\n    integer id PK\n    string phone\n  }\n');
});

test('types are reduced to one Mermaid word, nullable ones end with "?"', () => {
    const source = generate([{
        table: 'post',
        columns: [
            { name: 'tags', type: '\\Doctrine\\Common\\Collections\\Collection' },
            { name: 'items', type: 'Collection<int, Post>' },
            { name: 'subtitle', type: '?string' },
            { name: 'publishedAt', type: '\\DateTimeImmutable', nullable: true },
            { name: 'price', type: 'decimal(8,2)' },
            { name: 'flag', type: 'uk' },
            { name: 'status', type: 'enum(draft, published)' },
            { name: 'cost', type: '$money' },
            { name: 'unknown_type', type: '' },
            { name: 'missing_type' },
            { name: 'not_nullable', type: 'string', nullable: false },
        ],
        relations: [],
    }]);
    assert.deepEqual(lines(source).slice(2, 13), [
        '    Collection tags',
        '    Collection items',
        '    string? subtitle',
        '    DateTimeImmutable? publishedAt',
        '    decimal(8,2) price',
        '    _uk flag',
        '    enum(draft,_published) status',
        '    _money cost',
        '    unknown unknown_type',
        '    unknown missing_type',
        '    string not_nullable',
    ]);
});

test('column names keep their letters, accents included, and are made valid', () => {
    const source = generate([{
        table: 'users',
        columns: [
            { name: '2fa_secret', type: 'string' },
            { name: 'pk', type: 'string' },
            { name: 'FK', type: 'string' },
            { name: 'uk-code', type: 'string' },
            { name: 'pk_id', type: 'string' },
            { name: 'first name', type: 'string' },
            { name: 'prénom', type: 'string' },
            { name: '名前', type: 'string' },
            { name: 'user-id', type: 'integer' },
            { name: 'a$b#c', type: 'string' },
            { name: '?', type: 'string' },
            { name: '_token', type: 'string' },
        ],
        relations: [],
    }]);
    assert.deepEqual(lines(source).slice(2, 14), [
        '    string _2fa_secret',
        '    string _pk',
        '    string _FK',
        '    string _uk-code',
        '    string pk_id',
        '    string first_name',
        '    string prénom',
        '    string 名前',
        '    integer user-id',
        '    string a_b_c',
        '    string unnamed',
        '    string _token',
    ]);
});

// Words of the erDiagram grammar, and Object.prototype keys (Mermaid 10 kept its entities in a
// plain object, where 'constructor' or '__proto__' broke the whole diagram)
const ODD_NAMES = ['end', 'one', 'u', 'to', '2fa', 'password reset tokens', 'erDiagram', 'MANY', 'user-roles',
    'style', 'classDef', 'accTitle', ...Object.getOwnPropertyNames(Object.prototype)];

test('odd table names get a generated id and keep their name as label', () => {
    const source = generate([
        ...ODD_NAMES.map(table => ({ table, columns: [{ name: 'id', type: 'integer' }], relations: [] })),
        { table: 'a"b%c\\d', columns: [], relations: [{ foreignKey: 'to_id', references: 'id', on: 'to' }] },
        { table: '', columns: [], relations: [] },
    ]);
    const output = lines(source);
    assert.ok(output.includes('  t1["end"] {'));
    assert.ok(output.includes('  t4["to"] {'));
    assert.ok(output.includes('  t7["erDiagram"] {'));
    assert.ok(output.includes('  t8["MANY"] {'));
    assert.ok(output.includes('  t10["style"] {'));
    assert.ok(output.includes('  constructor {'), 'plain words are used as ids');
    assert.ok(output.some(line => /^ {2}t\d+\["__proto__"\] \{$/.test(line)));
    assert.ok(output.some(line => /^ {2}t\d+\["ab_c_d"\]$/.test(line)));
    assert.ok(output.some(line => /^ {2}t\d+\["unnamed"\]$/.test(line)));
    assert.ok(output.some(line => /^ {2}t4 \|\|--o\{ t\d+ : "to_id"$/.test(line)));
});

test('ids stay unique: case-insensitive duplicates and tables named like generated ids', () => {
    assert.equal(generate([
        { table: 'Users', columns: [], relations: [] },
        { table: 'users', columns: [], relations: [] },
        { table: 't1', columns: [], relations: [] },
        { table: 'my table', columns: [], relations: [] },
    ]), 'erDiagram\n  Users\n  t2["users"]\n  t1\n  t3["my table"]\n');
});

test('names that are equal after cleaning stay distinct entities', () => {
    const source = generate([
        { table: 'a"b', columns: [], relations: [] },
        { table: 'ab', columns: [], relations: [] },
    ]);
    assert.equal(source, 'erDiagram\n  t1["ab"]\n  ab\n');
});

test('the direction option adds a direction statement', () => {
    assert.ok(lines(generate([USERS, POSTS], { direction: 'LR' })).includes('  direction LR'));
    assert.equal(lines(generate([USERS], { direction: 'TB' }))[1], '  direction TB');
    assert.ok(!generate([USERS], { direction: 'sideways' }).includes('direction'));
});

test('the highlight option marks the matching tables and dims the others', () => {
    const source = generate([USERS, POSTS, { table: 'tags', columns: [], relations: [] }], { highlight: ['posts', 'tags'] });
    assert.ok(lines(source).includes('  class posts,tags match'));
    assert.ok(lines(source).includes('  class users dimmed'));
    assert.ok(!generate([USERS], { highlight: [] }).includes('class '));
    assert.ok(!generate([USERS], { highlight: ['users'] }).includes('dimmed'));
});

test('buildDiagram lists the entities with their id and table', () => {
    const { source, entities } = buildDiagram([POSTS, { table: 'my table', columns: [], relations: [] }]);
    assert.equal(source, generateMermaidER([POSTS, { table: 'my table', columns: [], relations: [] }]));
    assert.deepEqual(entities, [
        { id: 'posts', table: 'posts', declared: true },
        { id: 't1', table: 'my table', declared: true },
        { id: 'users', table: 'users', declared: false },
    ]);
});

test('invalid input does not throw', () => {
    assert.equal(generate(undefined), 'erDiagram\n');
    assert.equal(generate(null), 'erDiagram\n');
    assert.equal(generate({}), 'erDiagram\n');
    assert.equal(generate([null, 42, { table: 'x' }]), 'erDiagram\n  x\n');
    assert.equal(generate([{ table: 'x', columns: [null], relations: [null, { foreignKey: 'a' }] }]), 'erDiagram\n  x\n');
    // A relation without foreign key still gets the (mandatory) label, empty
    assert.equal(generate([{ table: 'x', columns: [], relations: [{ on: 'y' }] }]), 'erDiagram\n  x\n  y\n  y ||--o{ x : ""\n');
});

test(`every generated diagram is accepted by Mermaid ${mermaidVersion}`, { skip }, async () => {
    assert.ok(generated.length > 10);
    for (const source of generated) {
        await assert.doesNotReject(parseWithMermaid(source), source);
    }
});

test('Mermaid reads the attributes and cardinalities as intended', { skip }, async () => {
    const { entities, relationships } = await parseWithMermaid(generateMermaidER([
        USERS,
        POSTS,
        { table: 'profiles', columns: [], relations: [{ foreignKey: 'user_id', references: 'id', on: 'users', type: 'one-to-one' }] },
        { table: 'post', columns: [], relations: [{ foreignKey: 'post_id', references: 'id', on: 'tag', type: 'many-to-many', via: 'post_tag' }] },
    ]));

    const attribute = ({ type, name, keys }) => ({ type, name, keys });
    assert.deepEqual(attribute(entities.get('posts').attributes[1]), { type: 'unsignedBigInteger', name: 'user_id', keys: ['FK'] });
    assert.deepEqual(attribute(entities.get('users').attributes[0]), { type: 'bigIncrements', name: 'id', keys: ['PK'] });
    assert.deepEqual(attribute(entities.get('users').attributes[2]), { type: 'timestamp?', name: 'created_at', keys: [] });

    // relSpec.cardB is the marker next to entityA, cardA the one next to entityB
    const relation = (a, b) => relationships.find(r => r.entityA === a && r.entityB === b);
    assert.deepEqual(relation('users', 'posts').relSpec, { cardA: 'ZERO_OR_MORE', relType: 'IDENTIFYING', cardB: 'ONLY_ONE' });
    assert.deepEqual(relation('users', 'profiles').relSpec, { cardA: 'ZERO_OR_ONE', relType: 'IDENTIFYING', cardB: 'ONLY_ONE' });
    assert.deepEqual(relation('post', 'tag').relSpec, { cardA: 'ZERO_OR_MORE', relType: 'IDENTIFYING', cardB: 'ZERO_OR_MORE' });
    assert.equal(relation('post', 'tag').roleA, 'post_tag');
});

test('Mermaid reads accented and non-Latin names as written', { skip }, async () => {
    const { entities } = await parseWithMermaid(generateMermaidER([{
        table: 'clients',
        columns: [
            { name: 'prénom', type: 'string' },
            { name: '名前', type: 'string', nullable: true },
            { name: 'créé_le', type: 'datetime_immutable' },
        ],
        relations: [],
    }, { table: 'utilisateurs créés', columns: [{ name: 'id', type: 'integer', primary: true }], relations: [] }]));
    assert.deepEqual(entities.get('clients').attributes.map(({ type, name }) => `${type} ${name}`),
        ['string prénom', 'string? 名前', 'datetime_immutable créé_le']);
    assert.ok(entities.has('utilisateurs créés'));
});

test('Mermaid keeps every odd table name, and shows labels as written', { skip }, async () => {
    const names = [...ODD_NAMES, 'table#x;', 'x&#60;y', 'R&D', 'fk#1;', 'Users', 'users'];
    const { ids, entities, relationships } = await parseWithMermaid(generateMermaidER([
        ...names.map(table => ({ table, columns: [{ name: 'id', type: 'integer', primary: true }], relations: [] })),
        { table: 'links', columns: [], relations: names.map(on => ({ foreignKey: `${on}_id`, references: 'id', on })) },
        { table: 'styles', columns: [], relations: [{ foreignKey: 'style:#f00;', references: 'id', on: 'end' }] },
    ]));

    assert.equal(ids.length, names.length + 2);
    for (const name of names) {
        assert.deepEqual(entities.get(name).attributes.map(({ type, name: column, keys }) => ({ type, column, keys })),
            [{ type: 'integer', column: 'id', keys: ['PK'] }], name);
        assert.ok(relationships.some(r => r.entityA === name && r.entityB === 'links' && r.roleA === `${name}_id`), name);
    }
    assert.ok(relationships.some(r => r.entityA === 'end' && r.entityB === 'styles' && r.roleA === 'style:#f00;'));
});

test('Mermaid applies the highlight classes', { skip }, async () => {
    const { entities } = await parseWithMermaid(generateMermaidER([USERS, POSTS], { highlight: ['users'] }));
    assert.match(entities.get('users').cssClasses, /\bmatch\b/);
    assert.match(entities.get('posts').cssClasses, /\bdimmed\b/);
});

// diagram.js finds the table of a clicked node from its DOM id, '<svg id>-' + this entity id
test('Mermaid names entity nodes "entity-<id>-<n>" (a click on a table opens its file)', { skip }, async () => {
    const { entities } = await parseWithMermaid(generateMermaidER([USERS, POSTS, { table: 'my table', columns: [], relations: [] }]));
    assert.match(entities.get('users').id, /^entity-users-\d+$/);
    assert.match(entities.get('posts').id, /^entity-posts-\d+$/);
    assert.match(entities.get('my table').id, /^entity-t1-\d+$/);
});

const GIT_TABLES = [
    {
        table: 'users',
        git: 'modified',
        columns: [{ name: 'id', type: 'integer', primary: true, git: 'committed' }, { name: 'email', type: 'string', git: 'unsaved' }],
        relations: [],
    },
    { table: 'posts', git: 'untracked', columns: [{ name: 'id', type: 'integer', git: 'untracked' }], relations: [] },
    { table: 'tags', git: 'committed', columns: [{ name: 'id', type: 'integer', git: 'committed' }], relations: [] },
];

test('the git option adds the status of the tables (classes) and of the uncommitted columns (comments)', () => {
    const { gitLabel } = require('../../views/mermaid/generator');
    const source = generate(GIT_TABLES, { git: true });
    const output = lines(source);
    assert.ok(output.includes(`    string email "${gitLabel('unsaved')}"`));
    assert.ok(output.includes(`    integer id "${gitLabel('untracked')}"`));
    assert.ok(output.includes('    integer id PK'), 'committed columns have no comment');
    assert.ok(output.includes('  class posts gitNew'));
    assert.ok(output.includes('  class users gitModified'));
    assert.ok(!source.includes('tags git'), 'committed tables have no class');
    assert.ok(!generate(GIT_TABLES).includes(gitLabel('unsaved')), 'off by default (exports)');
});

test('Mermaid reads the git comments, and a table keeps both its search and git classes', { skip }, async () => {
    const { gitLabel } = require('../../views/mermaid/generator');
    const { entities } = await parseWithMermaid(generateMermaidER(GIT_TABLES, { git: true, highlight: ['posts'] }));
    assert.equal(entities.get('users').attributes[1].comment, gitLabel('unsaved'));
    assert.match(entities.get('posts').cssClasses, /\bmatch\b/);
    assert.match(entities.get('posts').cssClasses, /\bgitNew\b/);
    assert.match(entities.get('users').cssClasses, /\bdimmed\b.*\bgitModified\b|\bgitModified\b.*\bdimmed\b/);
});

test('the marks option: a CSS class per marked table and a comment per noted column', () => {
    const tables = [
        { table: 'users', mark: 'diffChanged', columns: [{ name: 'id', type: 'integer', primary: true }, { name: 'email', type: 'string', note: '~ type: text → string' }], relations: [] },
        { table: 'posts', mark: 'diffAdded', columns: [{ name: 'id', type: 'integer', note: '+ added' }], relations: [] },
        { table: 'tags', mark: 'bad mark"', columns: [], relations: [] },
    ];
    const source = generate(tables, { marks: true });
    const output = lines(source);
    assert.ok(output.includes('    string email "~ type#58; text → string"'));
    assert.ok(output.includes('    integer id "+ added"'));
    assert.ok(output.includes('  class users diffChanged'));
    assert.ok(output.includes('  class posts diffAdded'));
    assert.ok(!source.includes('bad mark'), 'only plain class names');
    assert.ok(!generate(tables).includes('diffAdded'), 'off by default');
});

// Pro's comparison notes start with '~': a default value or a type holding another '~' made
// Mermaid reject the whole diagram ("Expecting 'ATTRIBUTE_WORD', '?', got 'BLOCK_STOP'")
test("Mermaid reads the notes and labels holding two '~', and shows them", { skip }, async () => {
    const { entities, relationships } = await parseWithMermaid(generateMermaidER([{
        table: 'a~b~c',
        columns: [
            { name: 'email', type: 'string', note: '~ default: a~b' },
            { name: 'path', type: 'string', note: '~ default: ~/a → ~/b' },
            { name: 'name', type: 'string', note: 'x ~y~ z' },
        ],
        relations: [{ foreignKey: 'k~1~', references: 'id', on: 'b' }],
    }], { marks: true }));
    const table = entities.get('a~b∼c');
    assert.ok(table, 'the table label');
    // One '~' left: Mermaid draws '~x~' as '<x>' (parseGenericTypes), never a single '~'
    assert.deepEqual(table.attributes.map(attribute => shown(attribute.comment)),
        ['~ default: a∼b', '~ default: ∼/a → ∼/b', 'x ~y∼ z']);
    assert.equal(relationships[0].roleA, 'k~1∼');
});

test('the keysOnly option keeps the primary and foreign keys of each table', () => {
    const output = lines(generate([USERS, POSTS], { keysOnly: true }));
    assert.ok(output.includes('    bigIncrements id PK'));
    assert.ok(output.includes('    unsignedBigInteger user_id FK'));
    assert.ok(!output.some(line => /\b(email|title|created_at)\b/.test(line)), 'the other columns are left out');
    const keyless = lines(generate([{ table: 'logs', columns: [{ name: 'message', type: 'text' }], relations: [] }], { keysOnly: true }));
    assert.ok(keyless.includes('  logs'), 'a table without key is drawn without columns');
});

test('relationLabels: false draws the links without the name of their foreign key', () => {
    assert.ok(lines(generate([USERS, POSTS])).includes('  users ||--o{ posts : "user_id"'));
    assert.ok(lines(generate([USERS, POSTS], { relationLabels: false })).includes('  users ||--o{ posts : ""'));
});

test('gitLabels writes the git status in another language, as safe Mermaid text', () => {
    const { gitLabel } = require('../../views/mermaid/generator');
    const labels = { untracked: 'nouveau', modified: 'modifié', unsaved: 'non "enregistré"' };
    const output = lines(generate(GIT_TABLES, { git: true, gitLabels: labels }));
    assert.ok(output.includes(`    string email "${gitLabel('unsaved', labels)}"`));
    assert.ok(output.includes(`    integer id "${gitLabel('untracked', labels)}"`));
    assert.ok(!gitLabel('unsaved', labels).includes('"'), 'quotes are removed');
    assert.equal(gitLabel('modified', {}), gitLabel('modified'), 'English when a word is missing');
});

test('Mermaid reads the diagrams of the keysOnly, relationLabels and gitLabels options', { skip }, async () => {
    const { entities, relationships } = await parseWithMermaid(generateMermaidER([USERS, POSTS], { keysOnly: true, relationLabels: false }));
    assert.deepEqual(entities.get('posts').attributes.map(attribute => attribute.name), ['id', 'user_id']);
    assert.equal(relationships[0].roleA, '');
    const { gitLabel } = require('../../views/mermaid/generator');
    const labels = { untracked: 'nouveau', modified: 'modifié', unsaved: 'non enregistré' };
    const french = await parseWithMermaid(generateMermaidER(GIT_TABLES, { git: true, gitLabels: labels }));
    assert.equal(french.entities.get('users').attributes[1].comment, gitLabel('unsaved', labels));
});

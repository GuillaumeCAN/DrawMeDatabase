//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

const test = require('node:test');
const assert = require('node:assert/strict');

const { filterTables } = require('../../views/search');

const table = (name, columns, relations = []) => ({ table: name, columns: columns.map(column => ({ name: column, type: 'string' })), relations });
const rel = (foreignKey, on) => ({ foreignKey, references: 'id', on, type: 'many-to-one' });

const TABLES = [
    table('users', ['id', 'email']),
    table('posts', ['id', 'user_id', 'category_id'], [rel('user_id', 'users'), rel('category_id', 'categories')]),
    table('categories', ['id', 'name']),
    table('comments', ['id', 'post_id', 'user_id'], [rel('post_id', 'posts'), rel('user_id', 'users')]),
    table('tags', ['id', 'label']),
    table('sessions', ['id', 'payload'], [rel('team_id', 'teams')]),
];

const names = (tables) => tables.map(t => t.table);

test('an empty query keeps every table', () => {
    for (const query of ['', '   ', undefined, null]) {
        const result = filterTables(TABLES, query);
        assert.deepEqual(names(result.tables), names(TABLES));
        assert.deepEqual(result.matches, []);
    }
});

test('matching tables come with the tables they reference and the tables that reference them', () => {
    const result = filterTables(TABLES, 'Post');
    assert.deepEqual(result.matches, ['posts', 'comments'], 'by table name, and by column name (comments.post_id)');
    assert.deepEqual(names(result.tables), ['users', 'posts', 'categories', 'comments']);
    assert.deepEqual(result.neighbours.sort(), ['categories', 'users']);
});

test('only the relations between the tables shown are kept', () => {
    const result = filterTables(TABLES, 'categories');
    assert.deepEqual(names(result.tables), ['posts', 'categories']);
    // posts.user_id points to users, which is not shown
    assert.deepEqual(result.tables.find(t => t.table === 'posts').relations, [rel('category_id', 'categories')]);
});

test('a relation to a table that is not parsed stays, for the diagram to declare it', () => {
    const result = filterTables(TABLES, 'sess');
    assert.deepEqual(result.tables, [table('sessions', ['id', 'payload'], [rel('team_id', 'teams')])]);
    assert.deepEqual(result.neighbours, ['teams']);
});

test('no match, and invalid input', () => {
    assert.deepEqual(filterTables(TABLES, 'nothing'), { tables: [], matches: [], neighbours: [] });
    assert.deepEqual(filterTables(undefined, 'x'), { tables: [], matches: [], neighbours: [] });
    assert.deepEqual(names(filterTables([null, 42, table('a', ['x'])], 'a').tables), ['a']);
});

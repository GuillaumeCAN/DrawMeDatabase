//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { tableInfo } = require('../../views/inspector');

const SCHEMA = {
    project: { name: 'shop', framework: 'laravel' },
    tables: [
        {
            table: 'users',
            columns: [{ name: 'id', type: 'bigIncrements', primary: true, git: 'committed' }],
            relations: [],
            source: { file: 'database/migrations/0001_create_users_table.php', line: 14 },
        },
        {
            table: 'posts',
            git: 'modified',
            columns: [
                { name: 'id', type: 'bigIncrements', primary: true },
                { name: 'user_id', type: 'foreignId', git: 'unsaved', source: { file: 'database/migrations/0002_create_posts_table.php', line: 16 } },
                { name: 'title', type: 'string', nullable: true, git: 'weird' },
            ],
            relations: [{ foreignKey: 'user_id', references: 'id', on: 'users', type: 'many-to-one' }],
        },
        {
            table: 'post_tag',
            columns: [],
            relations: [{ foreignKey: 'post_id', references: 'id', on: 'posts', type: 'many-to-many', via: 'post_tag' }],
        },
    ],
};

describe('inspector: the info of a table', () => {
    it('lists its columns with their keys, types, git status and source line', () => {
        const info = tableInfo(SCHEMA, 'posts');
        assert.equal(info.table, 'posts');
        assert.equal(info.git, 'modified');
        assert.equal(info.framework, 'laravel');
        assert.equal(info.source, null);
        assert.deepEqual(info.columns, [
            { name: 'id', type: 'bigIncrements', nullable: false, primary: true, foreign: false, git: null, source: null },
            { name: 'user_id', type: 'foreignId', nullable: false, primary: false, foreign: true, git: 'unsaved', source: { file: 'database/migrations/0002_create_posts_table.php', line: 16 } },
            { name: 'title', type: 'string', nullable: true, primary: false, foreign: false, git: null, source: null },
        ], 'committed and unknown statuses are not shown');
    });

    it('gives the relations both ways', () => {
        assert.deepEqual(tableInfo(SCHEMA, 'posts').outgoing, [{ column: 'user_id', on: 'users', references: 'id', type: 'many-to-one' }]);
        assert.deepEqual(tableInfo(SCHEMA, 'posts').incoming, [{ table: 'post_tag', column: 'post_tag', references: 'id', type: 'many-to-many' }]);
        const users = tableInfo(SCHEMA, 'users');
        assert.deepEqual(users.incoming, [{ table: 'posts', column: 'user_id', references: 'id', type: 'many-to-one' }]);
        assert.deepEqual(users.source, { file: 'database/migrations/0001_create_users_table.php', line: 14 });
    });

    it('is null for a table that is not in the schema', () => {
        assert.equal(tableInfo(SCHEMA, 'missing'), null);
        assert.equal(tableInfo(null, 'users'), null);
        assert.equal(tableInfo({ tables: 'x' }, 'users'), null);
    });
});

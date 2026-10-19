//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// The reader of TypeScript and JavaScript code (parsers/ts-utils.js): tokens, expressions and the
// top-level statements of a module, without running the code.

const test = require('node:test');
const assert = require('node:assert/strict');

const { tokenize, context, parseExpression, scanModule, blockReturns, blockDeclarations, hasNestedReturn, createLineLocator, cook } = require('../../parsers/ts-utils');

// A node without its offsets, for the comparisons
const strip = (node) => JSON.parse(JSON.stringify(node, (key, value) => (['start', 'end', 'keyStart', 'ctx', 'parenthesized'].includes(key) ? undefined : value)));
const expression = (text) => {
    const ctx = context(tokenize(text));
    return strip(parseExpression(ctx, 0).node);
};
const values = (text) => tokenize(text).map(token => (token.type === 'template' ? ['template', token.quasis, token.subs.map(sub => sub.map(t => t.value))] : [token.type, token.value]));

test('tokens: strings and their escapes, numbers, names, comments skipped, a UTF-8 BOM', () => {
    assert.deepEqual(values('\uFEFFconst a = \'it\\\'s\' + "\\u00e9\\n" // comment ( {\n/* { */ 1_000 0x1F 2n .5'), [
        ['name', 'const'], ['name', 'a'], ['punct', '='], ['string', 'it\'s'], ['punct', '+'], ['string', '\u00e9\n'],
        ['number', '1_000'], ['number', '0x1F'], ['number', '2n'], ['number', '.5'],
    ]);
    // A string not closed on its line (being typed) ends there
    assert.deepEqual(values("a('b\nc)"), [['name', 'a'], ['punct', '('], ['string', 'b'], ['name', 'c'], ['punct', ')']]);
    assert.equal(cook('a\\tb\\`c\\${d}'), 'a\tb`c${d}');
});

test('tokens: templates and their substitutions, nested; regular expressions told from divisions', () => {
    const [tag, template] = tokenize('sql`lower(${t.email}) = ${`x${1}`}`');
    assert.equal(tag.value, 'sql');
    assert.deepEqual(template.quasis, ['lower(', ') = ', '']);
    assert.deepEqual(template.subs[0].map(t => t.value), ['t', '.', 'email']);
    assert.deepEqual([template.subs[1][0].type, template.subs[1][0].quasis, template.subs[1][0].subs.map(sub => sub.map(t => t.value))], ['template', ['x', ''], [['1']]]);
    assert.deepEqual(values('a / b / c').map(v => v[0]), ['name', 'punct', 'name', 'punct', 'name']);
    assert.deepEqual(values('x = /[/}]+/g.test(y)').slice(0, 3), [['name', 'x'], ['punct', '='], ['regex', '/[/}]+/g']]);
    assert.deepEqual(values('return /a/'), [['name', 'return'], ['regex', '/a/']]);
});

test('tokens: > is always a token of its own, so that nested generics end (Array<Array<T>>)', () => {
    assert.deepEqual(values('Array<Array<T>>=').map(v => v[1]), ['Array', '<', 'Array', '<', 'T', '>', '>', '=']);
    assert.deepEqual(values('a?.b ?? c ?.5').map(v => v[1]), ['a', '?.', 'b', '??', 'c', '?', '.5']);
});

test('expressions: calls and members chained, generic arguments, as / satisfies / ! skipped', () => {
    assert.deepEqual(expression("varchar('email', { length: 255 }).$type<Record<string, Array<number>>>().notNull()!"), {
        type: 'Call',
        callee: {
            type: 'Member',
            object: {
                type: 'Call',
                callee: { type: 'Member', object: { type: 'Call', callee: { type: 'Identifier', name: 'varchar' }, args: [{ type: 'String', value: 'email' }, { type: 'Object', properties: [{ kind: 'init', key: 'length', computed: false, value: { type: 'Number', value: 255, raw: '255', bigint: false } }] }] }, property: '$type' },
                args: [],
            },
            property: 'notNull',
        },
        args: [],
    });
    assert.deepEqual(expression("['a', 'b'] as const satisfies readonly string[]"), { type: 'Array', elements: [{ type: 'String', value: 'a' }, { type: 'String', value: 'b' }] });
    assert.deepEqual(expression('a < b'), { type: 'Binary', operator: '<', left: { type: 'Identifier', name: 'a' }, right: { type: 'Identifier', name: 'b' } });
    assert.deepEqual(expression('a >= b').operator, '>=');
    assert.deepEqual(expression('x ?? (y || z)').operator, '??');
    assert.deepEqual(expression('sql<string>`now()`'), { type: 'Tagged', tag: { type: 'Identifier', name: 'sql' }, quasi: { type: 'Template', quasis: ['now()'], expressions: [] } });
});

test('expressions: arrow functions (typed parameters, return types, destructuring, blocks), functions, objects', () => {
    assert.deepEqual(expression('(): AnyPgColumn => users.id'), { type: 'Arrow', params: [], body: { type: 'Member', object: { type: 'Identifier', name: 'users' }, property: 'id' } });
    assert.deepEqual(expression('(name: string, length = 8, { a, b: c }: Opts, ...rest) => name').params, [{ name: 'name' }, { name: 'length', default: { type: 'Number', value: 8, raw: '8', bigint: false } }, { names: [{ key: 'a', local: 'a' }, { key: 'b', local: 'c' }] }, { rest: 'rest' }]);
    assert.deepEqual(expression('t => [t.a]').params, [{ name: 't' }]);
    const block = parseExpression(context(tokenize('(t) => { if (x) { return 1; } return { a: t }; }')), 0).node;
    assert.equal(block.body.type, 'Block');
    assert.deepEqual(blockReturns(block.body).map(strip), [{ type: 'Object', properties: [{ kind: 'init', key: 'a', computed: false, value: { type: 'Identifier', name: 't' } }] }]);
    assert.deepEqual(expression("{ a, 'b': 1, [c]: 2, ...d, e() { return 'x'; }, get f() { return 1; } }").properties.map(p => [p.kind, p.key, p.shorthand || false]), [
        ['init', 'a', true], ['init', 'b', false], ['init', null, false], ['spread', undefined, false], ['method', 'e', false], ['method', 'f', false],
    ]);
    assert.equal(expression('function (a) { return a; }').type, 'Function');
});

test('expressions: what cannot be read is Unknown, deep nesting is cut, nothing throws', () => {
    assert.equal(expression(')').type, 'Unknown');
    const deep = `${'f('.repeat(5000)}${')'.repeat(5000)}`;
    assert.equal(expression(deep).type, 'Call');
    for (const text of ['(', '{ a: ', 'a.', '<', '`${', 'a ? b', 'x as', '() =>']) {
        assert.ok(expression(text), text);
    }
});

test('modules: imports (default, named, aliases, namespaces), type-only imports left out', () => {
    const module = scanModule("import def, { a, b as c, type T } from './x';\nimport * as ns from \"pkg\";\nimport type { U } from './types';\nimport './side-effect';\nconst lazy = import('./lazy');\n");
    assert.deepEqual([...module.imports], [
        ['def', { source: './x', imported: 'default' }],
        ['a', { source: './x', imported: 'a' }],
        ['c', { source: './x', imported: 'b' }],
        ['ns', { source: 'pkg', imported: '*' }],
    ]);
});

test('modules: exports (declarations, lists, re-exports, star, star as, default), type-only exports left out', () => {
    const module = scanModule("export const a = 1, b = 2;\nexport let c;\nexport function f(x: number): number { return x; }\nexport async function g() {}\nexport enum E { A = 'a', B }\nexport const enum F { X }\nexport { a as aa, b };\nexport { x, y as z } from './other';\nexport * from './all';\nexport * as space from './space';\nexport type { T } from './types';\nexport type V = string;\nexport interface I { a: string }\nexport default defineConfig({ schema: './s.ts' });\n");
    assert.deepEqual([...module.declarations.keys()], ['a', 'b', 'c', 'f', 'g', 'E', 'F']);
    assert.ok([...module.declarations.values()].every(declaration => declaration.exported));
    assert.deepEqual(module.declarations.get('E').members.map(m => m.name), ['A', 'B']);
    assert.deepEqual([...module.exports], [
        ['aa', { local: 'a' }],
        ['b', { local: 'b' }],
        ['x', { source: './other', imported: 'x' }],
        ['z', { source: './other', imported: 'y' }],
        ['space', { source: './space', imported: '*' }],
    ]);
    assert.deepEqual(module.stars, ['./all']);
    assert.equal(module.defaultExport.type, 'Call');
});

test('modules: declarations among other statements (classes, types, ifs, calls), without semicolons; module.exports', () => {
    const module = scanModule("type A = { a: string; b: number }\ninterface B { c(): void }\nclass C { m() { const hidden = 1 } }\nif (x) { const inner = 2 }\nconfig({ path: '.env' })\nconst a = 1\nconst { d, e } = obj\nlet f = a\n  .b()\nmodule.exports = { schema: './s.ts' }\n");
    assert.deepEqual([...module.declarations.keys()], ['a', 'f']);
    assert.equal(strip(module.declarations.get('f').init).type, 'Call');
    assert.deepEqual(module.assignments.map(a => [a.target, a.value.type]), [['module.exports', 'Object']]);
});

test('modules: CommonJS: require() as imports (destructured, renamed, a namespace), exports.x =, module.exports.x =, the keys of module.exports = { ... }', () => {
    const module = scanModule("const { sqliteTable, integer: int } = require('drizzle-orm/sqlite-core');\nconst helpers = require('./helpers');\nconst users = sqliteTable('users', {});\nexports.posts = sqliteTable('posts', {});\nmodule.exports.users = users;\nmodule.exports = { tags, extra: 1 };\n");
    assert.deepEqual([...module.imports], [
        ['sqliteTable', { source: 'drizzle-orm/sqlite-core', imported: 'sqliteTable' }],
        ['int', { source: 'drizzle-orm/sqlite-core', imported: 'integer' }],
        ['helpers', { source: './helpers', imported: '*' }],
    ]);
    assert.deepEqual([...module.declarations.keys()], ['users']);
    assert.deepEqual([...module.commonExports].map(([name, declaration]) => [name, declaration.name, declaration.init.type, declaration.exported]), [
        ['posts', 'posts', 'Call', true],
        ['users', 'users', 'Identifier', true],
        ['tags', 'tags', 'Identifier', true],
        ['extra', 'extra', 'Number', true],
    ]);
    assert.deepEqual(module.assignments.map(a => a.target), ['module.exports']);
});

test('blocks: the declarations at the top level of a function block (const, let, var, destructuring, functions), not those of its nested blocks and functions', () => {
    const text = "function f(a) {\n  const x = 1, y = a;\n  let { b, c: d, ...rest } = a;\n  var [e, [f2]] = a;\n  function g() { const hidden = 1; return hidden; }\n  if (a) { const inner = 2; }\n  const h = () => { const deep = 3; };\n  obj.const = 4;\n  let later;\n  return x;\n}";
    const node = parseExpression(context(tokenize(text)), 0).node;
    assert.deepEqual(blockDeclarations(node.body).map(d => [d.name, d.init ? d.init.type : null]), [
        ['x', 'Number'], ['y', 'Identifier'], ['b', null], ['d', null], ['rest', null], ['e', null], ['f2', null], ['g', 'Function'], ['h', 'Arrow'], ['later', null],
    ]);
    assert.equal(blockDeclarations(node.body), blockDeclarations(node.body), 'read once');
});

test('blocks: the returns nested in inner blocks (if, loops, switch, try), not in nested functions, objects or classes', () => {
    const nested = (text) => hasNestedReturn(parseExpression(context(tokenize(text)), 0).node.body);
    assert.equal(nested('() => { if (a) { return 1; } return 2; }'), true);
    assert.equal(nested('() => { for (const x of y) { return x; } return 2; }'), true);
    assert.equal(nested('() => { switch (a) { case 1: { return 1; } } return 2; }'), true);
    assert.equal(nested('() => { try { return 1; } finally { x(); } }'), true);
    assert.equal(nested('() => { function f() { return 1; } const g = () => { return 2; }; return f(); }'), false);
    assert.equal(nested('() => { const o = { m() { return 1; } }; class C { m() { return 1; } } return o; }'), false);
});

test('line locator: lines from 1, CRLF line endings', () => {
    const lineAt = createLineLocator('a\r\nb\nc');
    assert.deepEqual([0, 2, 3, 5, 6].map(lineAt), [1, 1, 2, 3, 3]);
});

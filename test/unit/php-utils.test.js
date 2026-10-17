const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    stripComments,
    findMatching,
    splitTopLevel,
    parseStringLiteral,
    parseArgs,
    parseArrayLiteral,
    createLineLocator,
} = require('../../parsers/php-utils');

describe('stripComments', () => {
    it('blanks line and block comments but keeps offsets and line breaks', () => {
        const src = "$a = 1; // one\n# two\n/* three\nfour */ $b = 2;";
        const out = stripComments(src);
        assert.equal(out.length, src.length);
        assert.equal(out.split('\n').length, src.split('\n').length);
        assert.ok(!out.includes('one') && !out.includes('two') && !out.includes('four'));
        assert.ok(out.includes('$b = 2;'));
    });

    it('keeps attributes and comment markers inside strings', () => {
        const src = "#[ORM\\Column]\n$s = '// not a comment'; $t = \"# nor /* this */\";";
        assert.equal(stripComments(src), src);
    });

    it('keeps doc comments only when asked', () => {
        const src = '/** @ORM\\Column */ /* plain */ $a;';
        assert.ok(stripComments(src, { keepDocComments: true }).includes('@ORM\\Column'));
        assert.ok(!stripComments(src, { keepDocComments: true }).includes('plain'));
        assert.ok(!stripComments(src).includes('@ORM'));
    });

    it('skips heredoc and nowdoc bodies', () => {
        const src = "$a = <<<EOT\n// kept\nEOT;\n$b = <<<'SQL'\n/* kept */\nSQL;\n// gone";
        const out = stripComments(src);
        assert.ok(out.includes('// kept') && out.includes('/* kept */'));
        assert.ok(!out.includes('gone'));
    });

    it('handles CRLF line endings', () => {
        const src = "$a; // x\r\n$b;";
        assert.equal(stripComments(src), "$a;     \r\n$b;");
    });
});

describe('findMatching', () => {
    it('matches nested brackets and ignores brackets in strings', () => {
        const src = "f(['a' => ')'], function () { return '}'; })";
        assert.equal(findMatching(src, 1), src.length - 1);
        assert.equal(findMatching(src, 2), src.indexOf(']'));
    });

    it('returns -1 when unbalanced or not on an opener', () => {
        assert.equal(findMatching('f(a', 1), -1);
        assert.equal(findMatching('f(a]', 1), -1);
        assert.equal(findMatching('abc', 0), -1);
    });
});

describe('splitTopLevel', () => {
    it('splits on top-level separators only', () => {
        assert.deepEqual(
            splitTopLevel("'a', ['b', 'c'], f(1, 2), 'd,e', "),
            ["'a'", "['b', 'c']", 'f(1, 2)', "'d,e'"],
        );
        assert.deepEqual(splitTopLevel("$a->b('x;y'); $c->d(); ;", ';'), ["$a->b('x;y')", '$c->d()']);
    });
});

describe('parseStringLiteral', () => {
    it('reads single and double quoted strings', () => {
        assert.equal(parseStringLiteral("'users'"), 'users');
        assert.equal(parseStringLiteral("'it\\'s'"), "it's");
        assert.equal(parseStringLiteral('"posts"'), 'posts');
        assert.equal(parseStringLiteral('"a\\"b\\$c"'), 'a"b$c');
    });

    it('returns null for non literals and interpolated strings', () => {
        assert.equal(parseStringLiteral('$table'), null);
        assert.equal(parseStringLiteral("'a' . 'b'"), null);
        assert.equal(parseStringLiteral('"prefix_$name"'), null);
        assert.equal(parseStringLiteral('"{$name}"'), null);
        assert.equal(parseStringLiteral('User::class'), null);
    });
});

describe('parseArgs', () => {
    it('separates named and positional arguments', () => {
        assert.deepEqual(parseArgs("targetEntity: Post::class, mappedBy: 'post', cascade: ['persist', 'remove']"), [
            { name: 'targetEntity', value: 'Post::class' },
            { name: 'mappedBy', value: "'post'" },
            { name: 'cascade', value: "['persist', 'remove']" },
        ]);
        assert.deepEqual(parseArgs("'name', 100"), [
            { name: null, value: "'name'" },
            { name: null, value: '100' },
        ]);
        assert.deepEqual(parseArgs("Foo::class, true ? 'a' : 'b'"), [
            { name: null, value: 'Foo::class' },
            { name: null, value: "true ? 'a' : 'b'" },
        ]);
    });
});

describe('parseArrayLiteral', () => {
    it('reads short and long array syntax', () => {
        assert.deepEqual(parseArrayLiteral("['a', 'b']"), ["'a'", "'b'"]);
        assert.deepEqual(parseArrayLiteral("array('a', [1, 2])"), ["'a'", '[1, 2]']);
        assert.deepEqual(parseArrayLiteral('[]'), []);
    });

    it('returns null when not a single array literal', () => {
        assert.equal(parseArrayLiteral("'a'"), null);
        assert.equal(parseArrayLiteral("['a'] + ['b']"), null);
    });
});

describe('createLineLocator', () => {
    it('gives 1-based line numbers', () => {
        const src = 'a\nbb\n\nccc';
        const lineAt = createLineLocator(src);
        assert.equal(lineAt(0), 1);
        assert.equal(lineAt(2), 2);
        assert.equal(lineAt(5), 3);
        assert.equal(lineAt(src.length - 1), 4);
    });
});

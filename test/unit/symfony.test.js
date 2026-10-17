const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const { parse } = require('../../parsers/symfony');
const { ParserError } = require('../../parsers/errors');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'symfony', 'blog');
const TMP = fs.realpathSync(os.tmpdir());

// Isolate the parser's git calls from the developer's config, and from a stray repo above TMP
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CEILING_DIRECTORIES = TMP;

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

const created = [];
after(() => {
    for (const dir of created) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// Temporary project with the given files ({ 'src/Entity/Post.php': '...' })
function project(files = {}) {
    const dir = fs.mkdtempSync(path.join(TMP, 'dmdb-symfony-'));
    created.push(dir);
    writeFiles(dir, files);
    return dir;
}

function writeFiles(dir, files) {
    for (const [rel, content] of Object.entries(files)) {
        const filePath = path.join(dir, rel);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    }
}

function copyFixture(target, fixture = FIXTURE) {
    fs.cpSync(fixture, target, { recursive: true });
    return target;
}

function git(cwd, ...args) {
    return childProcess.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
        cwd,
        env: GIT_ENV,
        stdio: 'pipe',
        encoding: 'utf8',
    });
}

function commitAll(cwd, message = 'commit') {
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', message);
}

// PHP source of an entity file in App\Entity
function php(body, namespace = 'App\\Entity') {
    return `<?php\n\nnamespace ${namespace};\n\nuse Doctrine\\ORM\\Mapping as ORM;\n\n${body}\n`;
}

const ID = '    #[ORM\\Id]\n    #[ORM\\GeneratedValue]\n    #[ORM\\Column]\n    private ?int $id = null;\n';

function parseEntities(files) {
    const entityFiles = {};
    for (const [name, content] of Object.entries(files)) {
        entityFiles[`src/Entity/${name}`] = content;
    }
    return parse(project(entityFiles));
}

// Runs `fn` with extra environment variables, restored afterwards
function withEnv(vars, fn) {
    const saved = { ...process.env };
    Object.assign(process.env, vars);
    try {
        return fn();
    } finally {
        for (const key of Object.keys(vars)) {
            if (key in saved) {
                process.env[key] = saved[key];
            } else {
                delete process.env[key];
            }
        }
    }
}

// GIT_CONFIG_* variables that set the given config, as a user's ~/.gitconfig would
const gitConfigEnv = (config) => Object.assign({ GIT_CONFIG_COUNT: String(Object.keys(config).length) },
    ...Object.entries(config).map(([key, value], i) => ({ [`GIT_CONFIG_KEY_${i}`]: key, [`GIT_CONFIG_VALUE_${i}`]: value })));

const table = (result, name) => result.tables.find(t => t.table === name);
const columnNames = (result, name) => table(result, name).columns.map(c => c.name);
const stripGit = (tables) => tables.map(t => ({
    ...t,
    columns: t.columns.map(c => Object.fromEntries(Object.entries(c).filter(([key]) => key !== 'git'))),
}));
const gitOf = (result) => Object.fromEntries(result.tables.flatMap(t => t.columns.map(c => [`${t.table}.${c.name}`, c.git])));

const BLOG_TABLES = [
    {
        table: 'blog_article',
        columns: [
            { name: 'id', type: 'integer', primary: true },
            { name: 'headline_text', type: 'string' },
            { name: 'top10_rank', type: 'integer', nullable: true },
            { name: 'writer_ref', type: 'integer', nullable: true },
        ],
        relations: [
            { foreignKey: 'writer_ref', references: 'id', on: 'user', type: 'many-to-one' },
        ],
    },
    {
        table: 'category',
        columns: [
            { name: 'id', type: 'integer', primary: true },
            { name: 'parent_id', type: 'integer', nullable: true },
            { name: 'name', type: 'string' },
            { name: 'slug', type: 'string' },
        ],
        relations: [
            { foreignKey: 'parent_id', references: 'id', on: 'category', type: 'many-to-one' },
        ],
    },
    {
        table: 'comment',
        columns: [
            { name: 'id', type: 'integer', primary: true },
            { name: 'body', type: 'text' },
            { name: 'post_id', type: 'integer' },
            { name: 'author_id', type: 'integer', nullable: true },
        ],
        relations: [
            { foreignKey: 'post_id', references: 'id', on: 'post', type: 'many-to-one' },
            { foreignKey: 'author_id', references: 'id', on: 'user', type: 'many-to-one' },
        ],
    },
    {
        table: 'legacy_note',
        columns: [
            { name: 'id', type: 'integer', primary: true },
            { name: 'note_text', type: 'text', nullable: true },
            { name: 'post_ref', type: 'integer' },
        ],
        relations: [
            { foreignKey: 'post_ref', references: 'id', on: 'post', type: 'many-to-one' },
            { foreignKey: 'legacy_note_id', references: 'id', on: 'tag', type: 'many-to-many', via: 'legacy_note_tags' },
        ],
    },
    {
        table: 'post',
        columns: [
            { name: 'id', type: 'integer', primary: true },
            { name: 'title', type: 'string' },
            { name: 'content', type: 'text' },
            { name: 'created_at', type: 'datetime_immutable' },
            { name: 'published_at', type: 'datetime_immutable', nullable: true },
            { name: 'status', type: 'string' },
            { name: 'author_id', type: 'integer' },
            { name: 'category_id', type: 'integer', nullable: true },
            // From TimestampableTrait
            { name: 'updated_at', type: 'datetime_immutable', nullable: true },
        ],
        relations: [
            { foreignKey: 'post_id', references: 'id', on: 'tag', type: 'many-to-many', via: 'post_tag' },
            { foreignKey: 'author_id', references: 'id', on: 'user', type: 'many-to-one' },
            { foreignKey: 'category_id', references: 'id', on: 'category', type: 'many-to-one' },
        ],
    },
    {
        table: 'profile',
        columns: [
            { name: 'id', type: 'integer', primary: true },
            { name: 'bio', type: 'text', nullable: true },
            { name: 'birth_date', type: 'date', nullable: true },
        ],
        relations: [],
    },
    {
        table: 'tag',
        columns: [
            { name: 'id', type: 'integer', primary: true },
            { name: 'name', type: 'string' },
        ],
        relations: [],
    },
    {
        table: 'user',
        columns: [
            { name: 'id', type: 'integer', primary: true },
            { name: 'email', type: 'string' },
            { name: 'roles', type: 'json' },
            { name: 'password', type: 'string' },
            { name: 'is_verified', type: 'boolean' },
            { name: 'profile_id', type: 'integer', nullable: true },
        ],
        relations: [
            { foreignKey: 'profile_id', references: 'id', on: 'profile', type: 'one-to-one' },
        ],
    },
];

describe('symfony parser: blog fixture', () => {
    it('returns the exact schema of the maker-bundle style blog (no git outside a repository)', () => {
        const dir = copyFixture(project());
        assert.deepEqual(parse(dir), { tables: BLOG_TABLES, warnings: [] });
    });

    it('marks every column committed once the fixture is committed', () => {
        const dir = copyFixture(project());
        git(dir, 'init', '-q');
        commitAll(dir);

        const result = parse(dir);
        assert.deepEqual(result.warnings, []);
        assert.deepEqual(stripGit(result.tables), BLOG_TABLES);
        assert.ok(result.tables.every(t => t.columns.every(c => c.git === 'committed')));
    });

    it('never emits a backslash or a Collection type', () => {
        const { tables } = parse(copyFixture(project()));
        for (const column of tables.flatMap(t => t.columns)) {
            assert.doesNotMatch(column.type, /\\|Collection/);
            assert.deepEqual(Object.keys(column).filter(k => !['name', 'type', 'primary', 'nullable', 'git'].includes(k)), []);
        }
    });

    it('does not depend on vscode nor simple-git', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', '..', 'parsers', 'symfony.js'), 'utf8');
        assert.doesNotMatch(source, /require\(['"](vscode|simple-git)['"]\)/);
        assert.doesNotMatch(source, /\bexecSync\b/);
    });
});

describe('symfony parser: errors and warnings', () => {
    it('throws a ParserError when src/Entity is missing', () => {
        assert.throws(() => parse(project({ 'composer.json': '{}' })), ParserError);
    });

    it('throws a ParserError when src/Entity has no PHP file', () => {
        assert.throws(() => parse(project({ 'src/Entity/README.md': 'nothing' })), ParserError);
    });

    it('warns when no class is a Doctrine entity', () => {
        const result = parseEntities({ 'Money.php': php('final class Money\n{\n    private int $amount;\n}') });
        assert.deepEqual(result, { tables: [], warnings: ['No Doctrine entity found in src/Entity.'] });
    });

    it('skips a file with unbalanced brackets and keeps the others', () => {
        const result = parseEntities({
            'Broken.php': php('#[ORM\\Entity]\nclass Broken\n{\n    public function x() {\n'),
            'Tag.php': php(`#[ORM\\Entity]\nclass Tag\n{\n${ID}}`),
        });
        assert.deepEqual(result.tables.map(t => t.table), ['tag']);
        assert.ok(result.warnings.includes('src/Entity/Broken.php: unbalanced brackets, file skipped.'));
    });

    it('handles a UTF-8 BOM and CRLF line endings', () => {
        const source = `\uFEFF${php(`#[ORM\\Entity]\nclass Tag\n{\n${ID}\n    #[ORM\\Column(length: 50)]\n    private ?string $name = null;\n}`)}`;
        const result = parseEntities({ 'Tag.php': source.replace(/\n/g, '\r\n') });
        assert.deepEqual(stripGit(result.tables), [{
            table: 'tag',
            columns: [{ name: 'id', type: 'integer', primary: true }, { name: 'name', type: 'string' }],
            relations: [],
        }]);
    });
});

describe('symfony parser: audit findings', () => {
    it('S-H1 maker relations without targetEntity use the property type (ManyToOne, bare #[ORM\\ManyToOne], owning OneToOne)', () => {
        const result = parseEntities({
            'Comment.php': php(`#[ORM\\Entity]\nclass Comment\n{\n${ID}
    #[ORM\\ManyToOne(inversedBy: 'comments')]
    #[ORM\\JoinColumn(nullable: false)]
    private ?Post $post = null;

    #[ORM\\ManyToOne]
    private ?Coupon $coupon = null;

    #[ORM\\OneToOne(inversedBy: 'comment', cascade: ['persist', 'remove'])]
    private ?Attachment $attachment = null;
}`),
            'Post.php': php(`#[ORM\\Entity]\nclass Post\n{\n${ID}}`),
        });

        assert.deepEqual(stripGit([table(result, 'comment')]), [{
            table: 'comment',
            columns: [
                { name: 'id', type: 'integer', primary: true },
                { name: 'post_id', type: 'integer' },
                { name: 'coupon_id', type: 'integer', nullable: true },
                { name: 'attachment_id', type: 'integer', nullable: true },
            ],
            relations: [
                { foreignKey: 'post_id', references: 'id', on: 'post', type: 'many-to-one' },
                { foreignKey: 'coupon_id', references: 'id', on: 'coupon', type: 'many-to-one' },
                { foreignKey: 'attachment_id', references: 'id', on: 'attachment', type: 'one-to-one' },
            ],
        }]);
    });

    it('S-H2 only mapped properties become columns, whatever their visibility, type or declaration style', () => {
        const result = parseEntities({
            'Item.php': php(`#[ORM\\Entity]\nclass Item\n{\n${ID}
    #[ORM\\Column(length: 20)]
    protected ?string $status = null;

    #[ORM\\Column]
    public readonly string $code;

    /** @ORM\\Column(type="string") */
    #[ORM\\Column(type: 'string')]
    private int|string $reference;

    #[ORM\\Column(type: 'integer')]
    var $legacy;

    #[ORM\\Column]
    private static int $counter = 0;

    private bool $dirty = false;

    #[ORM\\OneToMany(targetEntity: Line::class, mappedBy: 'item')]
    private \\Doctrine\\Common\\Collections\\Collection $lines;

    /*
    #[ORM\\Column]
    private ?string $legacyCode = null;
    */

    // #[ORM\\Column] private ?string $commented = null;

    public function __construct(#[ORM\\Id, ORM\\Column(length: 36)] private string $uuid, #[ORM\\Column] private int $level = 0, private string $notMapped = '')
    {
    }
}`),
        });

        assert.deepEqual(stripGit(result.tables)[0].columns, [
            { name: 'id', type: 'integer', primary: true },
            { name: 'status', type: 'string' },
            { name: 'code', type: 'string' },
            { name: 'reference', type: 'string' },
            { name: 'legacy', type: 'integer' },
            { name: 'uuid', type: 'string', primary: true },
            { name: 'level', type: 'integer' },
        ]);
    });

    it('S-H3 table and column names follow Table(name), backtick quoting and the underscore_number_aware strategy', () => {
        const result = parseEntities({
            'BlogPost.php': php(`#[ORM\\Entity]\nclass BlogPost\n{\n${ID}
    #[ORM\\Column]
    private ?\\DateTimeImmutable $createdAt = null;

    #[ORM\\Column]
    private ?string $address2Line = null;

    #[ORM\\Column(name: '\`select\`')]
    private ?string $selectValue = null;
}`),
            'Product.php': php(`#[ORM\\Entity]\n#[ORM\\Table(name: 'shop_product')]\nclass Product\n{\n${ID}}`),
            'Order.php': php("#[ORM\\Entity]\n#[ORM\\Table(name: '`order`')]\nclass Order\n{\n" + ID + '}'),
            'LegacyNote.php': php(`/**\n * @ORM\\Entity\n * @ORM\\Table(name="legacy_note")\n */\nclass LegacyNote\n{\n    /** @ORM\\Id @ORM\\Column(type="integer") */\n    private $id;\n}`),
        });

        assert.deepEqual(result.tables.map(t => t.table), ['blog_post', 'legacy_note', 'order', 'shop_product']);
        assert.deepEqual(columnNames(result, 'blog_post'), ['id', 'created_at', 'address2_line', 'select']);
    });

    it('S-H4 entities in subfolders of src/Entity are found, files sorted by path', () => {
        const result = parseEntities({
            'Blog/Article.php': php(`#[ORM\\Entity]\nclass Article\n{\n${ID}}`, 'App\\Entity\\Blog'),
            'Shop/Deep/Invoice.php': php(`#[ORM\\Entity]\nclass Invoice\n{\n${ID}}`, 'App\\Entity\\Shop\\Deep'),
            'Author.php': php(`#[ORM\\Entity]\nclass Author\n{\n${ID}}`),
            'Zone.php': php(`#[ORM\\Entity]\nclass Zone\n{\n${ID}}`),
        });
        assert.deepEqual(result.tables.map(t => t.table), ['author', 'article', 'invoice', 'zone']);
    });

    it('S-H5 annotation entities (typed or untyped properties) give their columns and relations', () => {
        const result = parseEntities({
            'LegacyNote.php': php(`/**
 * @ORM\\Entity(repositoryClass="App\\Repository\\LegacyNoteRepository")
 */
class LegacyNote
{
    /**
     * @ORM\\Id
     * @ORM\\GeneratedValue
     * @ORM\\Column(type="bigint")
     */
    private $id;

    /**
     * The note's text, see foo@example.com
     * @ORM\\Column(type="string", name="body", length=255, nullable=true)
     */
    private $text;

    /**
     * @ORM\\ManyToOne(targetEntity="App\\Entity\\Post")
     * @ORM\\JoinColumn(name="post_ref", referencedColumnName="id", nullable=false)
     */
    private ?Post $post = null;

    /**
     * @ORM\\ManyToOne(targetEntity="LegacyNote")
     * @ORM\\JoinColumns({
     *     @ORM\\JoinColumn(name="parent_ref")
     * })
     */
    private $parent;

    /**
     * @ORM\\ManyToMany(targetEntity="Post", inversedBy="notes")
     * @ORM\\JoinTable(name="note_post",
     *     joinColumns={@ORM\\JoinColumn(name="note_ref", referencedColumnName="id")},
     *     inverseJoinColumns={@ORM\\JoinColumn(name="post_ref", referencedColumnName="id")}
     * )
     */
    private $posts;
}`),
            'Post.php': php(`/** @ORM\\Entity */\nclass Post\n{\n    /** @ORM\\Id @ORM\\Column(type="integer") */\n    private $id;\n}`),
        });

        assert.deepEqual(stripGit([table(result, 'legacy_note')]), [{
            table: 'legacy_note',
            columns: [
                { name: 'id', type: 'bigint', primary: true },
                { name: 'body', type: 'string', nullable: true },
                { name: 'post_ref', type: 'integer' },
                { name: 'parent_ref', type: 'bigint', nullable: true },
            ],
            relations: [
                { foreignKey: 'post_ref', references: 'id', on: 'post', type: 'many-to-one' },
                { foreignKey: 'parent_ref', references: 'id', on: 'legacy_note', type: 'many-to-one' },
                { foreignKey: 'note_ref', references: 'id', on: 'post', type: 'many-to-many', via: 'note_post' },
            ],
        }]);
    });

    it('S-H6 a folder outside any git repository parses, without git keys and without git warning', () => {
        const result = parse(copyFixture(project()));
        assert.deepEqual(result.warnings.filter(w => w.startsWith('Git')), []);
        assert.ok(result.tables.every(t => t.columns.every(c => !('git' in c))));
    });

    it('S-H6 git can be turned off by the caller (no git key, no warning)', () => {
        const dir = copyFixture(project());
        git(dir, 'init', '-q');
        commitAll(dir);
        assert.deepEqual(parse(dir, { git: false }), { tables: BLOG_TABLES, warnings: [] });
    });

    it('S-H6 a missing git executable is a warning, not a failure', () => {
        const dir = copyFixture(project());
        git(dir, 'init', '-q');
        commitAll(dir);
        const savedPath = process.env.PATH;
        process.env.PATH = project();
        try {
            const result = parse(dir);
            assert.deepEqual(result.warnings, ['Git status is not shown: git is not installed.']);
            assert.deepEqual(result.tables, BLOG_TABLES);
        } finally {
            process.env.PATH = savedPath;
        }
    });

    it('S-H7a S-H10 paths are matched from the repository root when the project is a subfolder (monorepo)', () => {
        const root = project({ 'README.md': 'monorepo\n' });
        const app = copyFixture(path.join(root, 'apps', 'backend'));
        git(root, 'init', '-q');
        commitAll(root);
        writeFiles(app, { 'src/Entity/Invoice.php': php(`#[ORM\\Entity]\nclass Invoice\n{\n${ID}}`) });
        const tag = path.join(app, 'src', 'Entity', 'Tag.php');
        fs.writeFileSync(tag, fs.readFileSync(tag, 'utf8').replace('length: 50, unique: true', 'length: 80, unique: true'));

        const status = gitOf(parse(app));
        assert.equal(status['invoice.id'], 'untracked');
        assert.equal(status['tag.name'], 'modified');
        assert.equal(status['tag.id'], 'committed');
        assert.equal(status['post.title'], 'committed');
    });

    it('S-H7b a wholly untracked src/Entity folder marks every column untracked', () => {
        const dir = copyFixture(project({ 'composer.json': '{}\n', 'src/Kernel.php': '<?php\n' }));
        git(dir, 'init', '-q');
        git(dir, 'add', 'composer.json', 'src/Kernel.php');
        git(dir, 'commit', '-q', '-m', 'init');

        const result = parse(dir);
        assert.deepEqual(stripGit(result.tables), BLOG_TABLES);
        assert.ok(result.tables.every(t => t.columns.every(c => c.git === 'untracked')));
    });

    it('S-H7b a repository without any commit marks every column untracked', () => {
        const dir = copyFixture(project());
        git(dir, 'init', '-q');
        git(dir, 'add', '-A');

        const result = parse(dir);
        assert.deepEqual(result.warnings, []);
        assert.ok(result.tables.every(t => t.columns.every(c => c.git === 'untracked')));
    });

    it('S-H7c staged new files are untracked, staged edits are modified', () => {
        const dir = copyFixture(project());
        git(dir, 'init', '-q');
        commitAll(dir);
        writeFiles(dir, { 'src/Entity/Invoice.php': php(`#[ORM\\Entity]\nclass Invoice\n{\n${ID}}`) });
        const comment = path.join(dir, 'src', 'Entity', 'Comment.php');
        fs.writeFileSync(comment, fs.readFileSync(comment, 'utf8')
            .replace('    #[ORM\\ManyToOne]\n', '    #[ORM\\Column(nullable: true)]\n    private ?int $score = null;\n\n    #[ORM\\ManyToOne]\n'));
        git(dir, 'add', '-A');

        const status = gitOf(parse(dir));
        assert.equal(status['invoice.id'], 'untracked');
        assert.equal(status['comment.score'], 'modified');
        assert.equal(status['comment.body'], 'committed');
        assert.equal(status['comment.author_id'], 'committed');
    });

    it('S-H7c ignored and intent-to-add files are not committed', () => {
        const dir = copyFixture(project({ '.gitignore': 'src/Entity/Draft.php\n' }));
        git(dir, 'init', '-q');
        commitAll(dir);
        writeFiles(dir, {
            'src/Entity/Draft.php': php(`#[ORM\\Entity]\nclass Draft\n{\n${ID}}`),
            'src/Entity/Later.php': php(`#[ORM\\Entity]\nclass Later\n{\n${ID}}`),
        });
        git(dir, 'add', '-N', 'src/Entity/Later.php');

        const status = gitOf(parse(dir));
        assert.equal(status['draft.id'], 'untracked');
        assert.equal(status['later.id'], 'untracked');
        assert.equal(status['post.id'], 'committed');
    });

    it('S-NEW1 entity file names are never run by a shell', () => {
        const dir = copyFixture(project());
        const weird = path.join(dir, 'src', 'Entity', '$(touch INJECTED).php');
        fs.writeFileSync(weird, php(`#[ORM\\Entity]\nclass Weird\n{\n${ID}}`));
        git(dir, 'init', '-q');
        commitAll(dir);
        fs.appendFileSync(weird, '\n');
        fs.writeFileSync(weird, fs.readFileSync(weird, 'utf8').replace('    #[ORM\\Column]\n    private ?int $id', '    #[ORM\\Column(type: \'bigint\')]\n    private ?int $id'));

        const result = parse(dir);
        assert.equal(gitOf(result)['weird.id'], 'modified');
        for (const place of [dir, path.join(dir, 'src', 'Entity'), process.cwd()]) {
            assert.equal(fs.existsSync(path.join(place, 'INJECTED')), false, `INJECTED created in ${place}`);
        }
    });

    it('S-NEW1 file names that git quotes (double quote, space, accents) keep their status', { skip: process.platform === 'win32' }, () => {
        const dir = project();
        const names = ['Quote"Break.php', 'Has Space.php', 'Été.php'];
        writeFiles(dir, Object.fromEntries(names.map((name, i) => [`src/Entity/${name}`, php(`#[ORM\\Entity]\nclass E${i}\n{\n${ID}\n    #[ORM\\Column]\n    private ?int $weight = null;\n}`)])));
        git(dir, 'init', '-q');
        commitAll(dir);
        for (const name of names) {
            const file = path.join(dir, 'src', 'Entity', name);
            fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('private ?int $weight', 'private ?float $weight'));
        }

        const status = gitOf(parse(dir));
        for (const i of [0, 1, 2]) {
            assert.equal(status[`e${i}.weight`], 'modified', names[i]);
            assert.equal(status[`e${i}.id`], 'committed', names[i]);
        }
    });

    it('S-NEW2 an untracked Post.php.orig does not make Post.php untracked', () => {
        const dir = copyFixture(project());
        git(dir, 'init', '-q');
        commitAll(dir);
        const post = path.join(dir, 'src', 'Entity', 'Post.php');
        fs.copyFileSync(post, `${post}.orig`);
        fs.copyFileSync(path.join(dir, 'src', 'Entity', 'Tag.php'), path.join(dir, 'src', 'Entity', 'Tag.php.bak'));

        const result = parse(dir);
        assert.ok(result.tables.every(t => t.columns.every(c => c.git === 'committed')));
    });

    it('S-H8 one edge per association, with its cardinality, from the owning side only', () => {
        const result = parse(copyFixture(project()));
        const edges = result.tables.flatMap(t => t.relations.map(r => `${t.table}.${r.foreignKey} ${r.type} ${r.on}${r.via ? ` via ${r.via}` : ''}`));
        assert.deepEqual(edges, [
            'blog_article.writer_ref many-to-one user',
            'category.parent_id many-to-one category',
            'comment.post_id many-to-one post',
            'comment.author_id many-to-one user',
            'legacy_note.post_ref many-to-one post',
            'legacy_note.legacy_note_id many-to-many tag via legacy_note_tags',
            'post.post_id many-to-many tag via post_tag',
            'post.author_id many-to-one user',
            'post.category_id many-to-one category',
            'user.profile_id one-to-one profile',
        ]);
        // Inverse sides (Tag.posts, User.posts, Profile.user, Post.comments, Category.children) add nothing
        assert.deepEqual(table(result, 'tag').relations, []);
        assert.deepEqual(table(result, 'profile').relations, []);
    });

    it('S-H9 grouped, multi-line, imported and fully-qualified attributes; string and FQCN targets', () => {
        const result = parseEntities({
            'Order.php': `<?php

namespace App\\Entity;

use Doctrine\\Common\\Collections\\Collection;
use Doctrine\\ORM\\Mapping as ORM;
use Doctrine\\ORM\\Mapping\\ManyToOne;
use Doctrine\\ORM\\Mapping\\{Column as Col, JoinColumn};
use function App\\Util\\{Col, Order};

#[ORM\\Entity]
#[ORM\\Table(name: '\`order\`')]
class Order
{
    #[ORM\\Id, ORM\\GeneratedValue, ORM\\Column]
    private ?int $id = null;

    #[ORM\\ManyToOne(targetEntity: Customer::class, inversedBy: 'orders'), ORM\\JoinColumn(nullable: false)]
    private ?Customer $customer = null;

    #[ORM\\OneToMany(
        targetEntity: OrderLine::class,
        mappedBy: "order",
        cascade: ['persist', 'remove'],
        orphanRemoval: true,
    )]
    private Collection $lines;

    #[ORM\\ManyToOne(targetEntity: 'App\\Entity\\Warehouse')]
    private ?Warehouse $warehouse = null;

    #[ORM\\ManyToOne(targetEntity: \\App\\Entity\\Carrier::class)]
    private $carrier;

    #[ManyToOne(targetEntity: "Coupon")]
    #[JoinColumn(name: 'coupon_code', referencedColumnName: 'code')]
    private $coupon;

    #[\\Doctrine\\ORM\\Mapping\\Column(type: 'string', options: ['comment' => 'a;b]})'])]
    private ?string $note = null;

    #[Col('total_cents', 'integer')]
    private int $total = 0;
}`,
            'Coupon.php': php(`#[ORM\\Entity]\nclass Coupon\n{\n${ID}\n    #[ORM\\Column(length: 12, unique: true)]\n    private string $code;\n}`),
        });

        assert.deepEqual(stripGit([table(result, 'order')]), [{
            table: 'order',
            columns: [
                { name: 'id', type: 'integer', primary: true },
                { name: 'customer_id', type: 'integer' },
                { name: 'warehouse_id', type: 'integer', nullable: true },
                { name: 'carrier_id', type: 'integer', nullable: true },
                { name: 'coupon_code', type: 'string', nullable: true },
                { name: 'note', type: 'string' },
                { name: 'total_cents', type: 'integer' },
            ],
            relations: [
                { foreignKey: 'customer_id', references: 'id', on: 'customer', type: 'many-to-one' },
                { foreignKey: 'warehouse_id', references: 'id', on: 'warehouse', type: 'many-to-one' },
                { foreignKey: 'carrier_id', references: 'id', on: 'carrier', type: 'many-to-one' },
                { foreignKey: 'coupon_code', references: 'code', on: 'coupon', type: 'many-to-one' },
            ],
        }]);
    });

    it('S-NEW3 self::class and ?self point to the entity itself (ManyToOne and ManyToMany)', () => {
        const result = parseEntities({
            'Category.php': php(`#[ORM\\Entity]\n#[ORM\\Table(name: 'categories')]\nclass Category\n{\n${ID}
    #[ORM\\ManyToOne(targetEntity: self::class, inversedBy: 'children')]
    private ?self $parent = null;

    #[ORM\\OneToMany(targetEntity: self::class, mappedBy: 'parent')]
    private $children;

    #[ORM\\ManyToOne(inversedBy: 'aliases')]
    private ?self $canonical = null;

    #[ORM\\ManyToMany(targetEntity: self::class)]
    private $related;

    #[ORM\\ManyToMany(targetEntity: Customer::class)]
    private $customers;
}`),
            'Customer.php': php(`#[ORM\\Entity]\nclass Customer\n{\n${ID}}`),
        });

        // Checked against Doctrine ORM 3.7: default join tables and join columns use the class
        // names, not Table(name); a self-referencing ManyToMany uses <class>_source
        assert.deepEqual(table(result, 'categories').relations, [
            { foreignKey: 'parent_id', references: 'id', on: 'categories', type: 'many-to-one' },
            { foreignKey: 'canonical_id', references: 'id', on: 'categories', type: 'many-to-one' },
            { foreignKey: 'category_source', references: 'id', on: 'categories', type: 'many-to-many', via: 'category_category' },
            { foreignKey: 'category_id', references: 'id', on: 'customer', type: 'many-to-many', via: 'category_customer' },
        ]);
        assert.ok(!result.tables.some(t => t.table === 'self'));
    });

    it('S-H11 column types are Doctrine types: explicit, Types:: constants, enums, custom types or inferred', () => {
        const result = parseEntities({
            'Event.php': `<?php

namespace App\\Entity;

use App\\Enum\\Unknown;
use Doctrine\\DBAL\\Types\\Types;
use Doctrine\\ORM\\Mapping as ORM;
use Symfony\\Bridge\\Doctrine\\Types\\UuidType;
use Symfony\\Component\\Uid\\Uuid;

#[ORM\\Entity]
class Event
{
    #[ORM\\Id]
    #[ORM\\Column(type: UuidType::NAME)]
    private ?Uuid $id = null;

    #[ORM\\Column(type: Types::TEXT)]
    private ?string $description = null;

    #[ORM\\Column(type: Types::DATETIME_MUTABLE)]
    private ?\\DateTime $startsAt = null;

    #[ORM\\Column(type: \\Doctrine\\DBAL\\Types\\Types::DATE_IMMUTABLE)]
    private ?\\DateTimeImmutable $day = null;

    #[ORM\\Column(type: 'decimal', precision: 10, scale: 2)]
    private ?string $price = null;

    #[ORM\\Column]
    private array $roles = [];

    #[ORM\\Column]
    private ?bool $active = null;

    #[ORM\\Column]
    private ?float $ratio = null;

    #[ORM\\Column]
    private ?\\DateTimeInterface $endsAt = null;

    #[ORM\\Column]
    private ?\\DateInterval $duration = null;

    #[ORM\\Column]
    private ?Priority $priority = null;

    #[ORM\\Column(enumType: Unknown::class)]
    private ?Unknown $unknown = null;

    #[ORM\\Column]
    private $untyped;
}

enum Priority: int
{
    case Low = 1;
}`,
        });

        assert.deepEqual(stripGit(result.tables)[0].columns.map(c => `${c.name}:${c.type}`), [
            'id:uuid',
            'description:text',
            'starts_at:datetime',
            'day:date_immutable',
            'price:decimal',
            'roles:json',
            'active:boolean',
            'ratio:float',
            'ends_at:datetime',
            'duration:dateinterval',
            'priority:integer',
            'unknown:string',
            'untyped:string',
        ]);
    });

    it('S-H11 foreign key columns take the type of the referenced key', () => {
        const result = parseEntities({
            'Badge.php': php(`#[ORM\\Entity]\nclass Badge\n{\n    #[ORM\\Id, ORM\\Column(length: 36)]\n    private string $uuid;\n}`),
            'Holder.php': php(`#[ORM\\Entity]\nclass Holder\n{\n${ID}
    #[ORM\\ManyToOne]
    #[ORM\\JoinColumn(referencedColumnName: 'uuid')]
    private ?Badge $badge = null;

    #[ORM\\Id]
    #[ORM\\OneToOne]
    private ?Profile $profile = null;
}`),
            'Profile.php': php(`#[ORM\\Entity]\nclass Profile\n{\n    #[ORM\\Id, ORM\\Column(type: 'bigint')]\n    private ?int $id = null;\n}`),
            'Stamp.php': php(`#[ORM\\Entity]\nclass Stamp\n{\n${ID}
    #[ORM\\ManyToOne]
    #[ORM\\JoinColumn(referencedColumnName: 'profile_id')]
    private ?Holder $holder = null;
}`),
        });

        assert.deepEqual(stripGit([table(result, 'holder')])[0].columns, [
            { name: 'id', type: 'integer', primary: true },
            { name: 'badge_id', type: 'string', nullable: true },
            { name: 'profile_id', type: 'bigint', primary: true },
        ]);
        assert.deepEqual(stripGit([table(result, 'stamp')])[0].columns[1], { name: 'holder_id', type: 'bigint', nullable: true });
    });

    it('S-NEW4 a change on the attribute line only marks the column modified', () => {
        const dir = copyFixture(project());
        git(dir, 'init', '-q');
        commitAll(dir);
        const post = path.join(dir, 'src', 'Entity', 'Post.php');
        fs.writeFileSync(post, fs.readFileSync(post, 'utf8')
            .replace('#[ORM\\Column(length: 255)]', '#[ORM\\Column(length: 100)]')
            .replace("    #[ORM\\ManyToOne(inversedBy: 'posts')]\n    #[ORM\\JoinColumn(nullable: false)]\n", "    #[ORM\\ManyToOne(inversedBy: 'posts')]\n"));

        const status = gitOf(parse(dir));
        assert.equal(status['post.title'], 'modified');
        assert.equal(status['post.author_id'], 'modified');
        assert.equal(status['post.content'], 'committed');
        assert.equal(status['post.id'], 'committed');
        assert.equal(status['post.category_id'], 'committed');
    });

    it('S-NEW5 user git config (colors, hidden untracked files, diff prefixes) does not change the result', () => {
        const dir = copyFixture(project());
        git(dir, 'init', '-q');
        commitAll(dir);
        writeFiles(dir, { 'src/Entity/Fresh.php': php(`#[ORM\\Entity]\nclass Fresh\n{\n${ID}}`) });
        const tag = path.join(dir, 'src', 'Entity', 'Tag.php');
        fs.writeFileSync(tag, fs.readFileSync(tag, 'utf8').replace('length: 50,', 'length: 60,'));

        // diff.noprefix would hide diff.mnemonicPrefix, so they are tried separately
        const configs = [{
            'color.ui': 'always',
            'color.diff': 'always',
            'status.showUntrackedFiles': 'no',
            'diff.noprefix': 'true',
            'diff.relative': 'true',
            'diff.external': 'false',
            'core.quotepath': 'true',
        }, {
            'diff.mnemonicPrefix': 'true',
            'status.relativePaths': 'true',
        }];
        for (const config of configs) {
            const saved = { ...process.env };
            Object.entries(config).forEach(([key, value], i) => {
                process.env[`GIT_CONFIG_KEY_${i}`] = key;
                process.env[`GIT_CONFIG_VALUE_${i}`] = value;
            });
            process.env.GIT_CONFIG_COUNT = String(Object.keys(config).length);
            try {
                const status = gitOf(parse(dir));
                assert.equal(status['fresh.id'], 'untracked', JSON.stringify(config));
                assert.equal(status['tag.name'], 'modified', JSON.stringify(config));
                assert.equal(status['tag.id'], 'committed', JSON.stringify(config));
            } finally {
                for (const key of Object.keys(process.env)) {
                    if (!(key in saved)) {
                        delete process.env[key];
                    }
                }
            }
        }
    });

    it('S-NEW6 enums, traits, interfaces, embeddables and mapped superclasses are not tables', () => {
        const result = parseEntities({
            'Address.php': php('#[ORM\\Embeddable]\nclass Address\n{\n    #[ORM\\Column(length: 255)]\n    private ?string $street = null;\n}'),
            'BaseEntity.php': php(`#[ORM\\MappedSuperclass]\nabstract class BaseEntity\n{\n${ID}}`),
            'HasName.php': php('interface HasName\n{\n    public function getName(): string;\n}'),
            'OrderStatus.php': php("enum OrderStatus: string\n{\n    case New = 'new';\n}"),
            'PlainTrait.php': php('trait PlainTrait\n{\n    private int $cache = 0;\n}'),
            'Shop.php': php(`#[ORM\\Entity]\nclass Shop extends BaseEntity implements HasName\n{\n    use PlainTrait, TimestampableTrait;\n
    #[ORM\\Embedded(class: Address::class)]
    private Address $address;

    public function getName(): string
    {
        return 'shop';
    }
}`),
            'TimestampableTrait.php': php('trait TimestampableTrait\n{\n    #[ORM\\Column]\n    private ?\\DateTimeImmutable $updatedAt = null;\n}'),
        });

        // The fields of the mapped superclass and of the traits belong to the entity (see SYM-V1)
        assert.deepEqual(stripGit(result.tables), [{
            table: 'shop',
            columns: [{ name: 'id', type: 'integer', primary: true }, { name: 'updated_at', type: 'datetime_immutable' }],
            relations: [],
        }]);
        assert.deepEqual(result.warnings.filter(w => !w.startsWith('Git')), [
            'src/Entity/Address.php: embeddable Address is not supported, its fields are not shown.',
            'Shop.address: embedded fields are not shown.',
        ]);
    });

    describe('S-NEW9 git runs a fixed number of processes, without a shell', () => {
        let calls;
        before(() => {
            calls = mock.method(childProcess, 'execFileSync');
        });
        after(() => mock.restoreAll());

        it('uses at most 4 git calls for the whole entity folder', () => {
            const dir = copyFixture(project());
            git(dir, 'init', '-q');
            commitAll(dir);
            calls.mock.resetCalls();

            parse(dir);
            const gitCalls = calls.mock.calls.filter(call => call.arguments[0] === 'git');
            assert.ok(gitCalls.length <= 4, `${gitCalls.length} git calls`);
            for (const call of gitCalls) {
                assert.ok(Array.isArray(call.arguments[1]));
                assert.ok(!call.arguments[2] || !call.arguments[2].shell);
            }
        });
    });
});

describe('symfony parser: review findings', () => {
    const ENUMS = {
        'Enum/Status.php': php('enum Status: int\n{\n    case Draft = 0;\n}', 'App\\Entity\\Enum'),
        'Enum/Suit.php': php("enum Suit: string\n{\n    case Hearts = 'H';\n}", 'App\\Entity\\Enum'),
    };
    const ENTITY_HEADER = '<?php\n\nnamespace App\\Entity;\n\nuse App\\Entity\\Enum\\Status;\nuse App\\Entity\\Enum\\Suit;\nuse Doctrine\\DBAL\\Types\\Types;\nuse Doctrine\\ORM\\Mapping as ORM;\n\n';
    const typesOf = (result, name) => table(result, name).columns.map(c => `${c.name}:${c.type}`);

    it('SYM-R1 properties named like PHP keywords ($function, $class, $fn...) are read', () => {
        const result = parseEntities({
            'Employee.php': php(`#[ORM\\Entity]\nclass Employee\n{\n${ID}
    // job function, e.g. "Accountant"
    #[ORM\\Column(length: 100)]
    private ?string $function = null;

    #[ORM\\Column]
    private ?string $class = null;

    #[ORM\\Column]
    private ?string $fn = null;

    #[ORM\\Column]
    private ?int $static = null;

    #[ORM\\Column]
    protected ?bool $readonly = null;

    #[ORM\\Column]
    public ?string $use = null;

    #[ORM\\Column]
    private ?string $namespace = null;

    #[ORM\\Column(type: 'string')]
    var $var;

    public function __construct(#[ORM\\Column] private string $enum = '')
    {
    }

    public function function(): ?string
    {
        return $this->function;
    }
}`),
        });
        assert.deepEqual(columnNames(result, 'employee'), ['id', 'function', 'class', 'fn', 'static', 'readonly', 'use', 'namespace', 'var', 'enum']);
    });

    it('SYM-R2 long blank runs (50k-character comments) in declarations parse in well under a second', () => {
        // Comments are blanked before matching: the old PROPERTY regex took hours on `private <blanks> const`
        const blanks = `/*${' '.repeat(50000)}*/`;
        const dir = project({
            'src/Entity/Big.php': php(`/**${'\n *'.repeat(20000)}\n */\n#[ORM\\Entity]\nclass ${blanks} Big ${blanks} extends ${blanks} Base\n{\n${ID}
    private ${blanks} const ${blanks} LIMIT = 1;

    public ${blanks} function ${blanks} check(): void
    {
    }

    #[ORM\\Column]
    private ${blanks} ?string ${blanks} $name = null;
}`),
            'src/Entity/Base.php': php('abstract class Base\n{\n}'),
            // A file being edited may not be valid PHP yet
            'src/Entity/Draft.php': php(`class Draft\n{\n    public ${blanks} function ${blanks} = 1;\n}\nnamespace ${blanks} App ${blanks} Entity;`),
        });

        const started = Date.now();
        const result = parse(dir, { git: false });
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 1000, `${elapsed} ms`);
        assert.deepEqual(typesOf(result, 'big'), ['id:integer', 'name:string']);
    });

    it('SYM-R3 diff.interHunkContext and GIT_DIFF_OPTS do not mark the unchanged columns between two edits', () => {
        const dir = copyFixture(project());
        git(dir, 'init', '-q');
        commitAll(dir);
        const post = path.join(dir, 'src', 'Entity', 'Post.php');
        fs.writeFileSync(post, fs.readFileSync(post, 'utf8')
            .replace('#[ORM\\Column(length: 255)]', '#[ORM\\Column(length: 200)]')
            .replace('    #[ORM\\ManyToOne]\n    private ?Category', "    #[ORM\\ManyToOne(fetch: 'EAGER')]\n    private ?Category"));

        for (const env of [gitConfigEnv({ 'diff.interHunkContext': '40', 'diff.context': '10' }), { GIT_DIFF_OPTS: '--unified=5' }]) {
            const status = withEnv(env, () => gitOf(parse(dir)));
            const modified = Object.keys(status).filter(key => key.startsWith('post.') && status[key] !== 'committed');
            assert.deepEqual(modified, ['post.title', 'post.category_id'], JSON.stringify(env));
        }
    });

    it('SYM-R4 SYM-V1 traits and parent classes outside src/Entity are named in a warning, also when used by a trait or a parent', () => {
        const result = parseEntities({
            'Article.php': `<?php

namespace App\\Entity;

use App\\Model\\BaseEntity;
use App\\Model\\SoftDeletableTrait;
use Doctrine\\ORM\\Mapping as ORM;
use Gedmo\\Timestampable\\Traits\\TimestampableEntity;

#[ORM\\Entity]
class Article extends BaseEntity
{
    use TimestampableEntity, SoftDeletableTrait;
    use HasSlug {
        HasSlug::slug as protected;
    }

    #[ORM\\Column(length: 255)]
    private ?string $title = null;
}`,
            'HasSlug.php': php('trait HasSlug\n{\n    use \\Gedmo\\Sluggable\\SluggableTrait;\n\n    private ?string $slugCache = null;\n}'),
            'AbstractPage.php': php('abstract class AbstractPage extends \\App\\Model\\BaseEntity\n{\n    use \\App\\Model\\SoftDeletableTrait;\n\n    #[ORM\\Column]\n    protected ?string $path = null;\n}'),
            'Page.php': php('#[ORM\\Entity]\nclass Page extends AbstractPage\n{\n    use HasSlug;\n\n    #[ORM\\Column]\n    private ?string $title = null;\n}'),
            'UnusedTrait.php': php('trait UnusedTrait\n{\n    use \\Gedmo\\Blameable\\BlameableTrait;\n\n    #[ORM\\Column]\n    private ?int $counter = null;\n}'),
        });

        assert.deepEqual(typesOf(result, 'article'), ['title:string']);
        assert.deepEqual(typesOf(result, 'page'), ['path:string', 'title:string']);
        // Each warning once, by the file that uses the missing class; nothing for the unused trait
        assert.deepEqual(result.warnings.filter(w => !w.startsWith('Git')), [
            'src/Entity/Article.php: Article extends App\\Model\\BaseEntity, which is not in src/Entity: its fields are not shown.',
            'src/Entity/Article.php: Article uses trait Gedmo\\Timestampable\\Traits\\TimestampableEntity, which is not in src/Entity: its fields are not shown.',
            'src/Entity/Article.php: Article uses trait App\\Model\\SoftDeletableTrait, which is not in src/Entity: its fields are not shown.',
            'src/Entity/HasSlug.php: HasSlug uses trait Gedmo\\Sluggable\\SluggableTrait, which is not in src/Entity: its fields are not shown.',
            'src/Entity/AbstractPage.php: AbstractPage extends App\\Model\\BaseEntity, which is not in src/Entity: its fields are not shown.',
            'src/Entity/AbstractPage.php: AbstractPage uses trait App\\Model\\SoftDeletableTrait, which is not in src/Entity: its fields are not shown.',
        ]);
    });

    it('SYM-R5 class and union PHP types follow Doctrine: backed enum → backing type, anything else → string', () => {
        const result = parseEntities({
            ...ENUMS,
            'Page.php': `${ENTITY_HEADER}use App\\Enum\\Outside;\nuse Money\\Money;\n\n#[ORM\\Entity]\nclass Page\n{\n${ID}
    #[ORM\\Column]
    private ?Status $status = null;

    #[ORM\\Column]
    private ?Suit $suit = null;

    #[ORM\\Column]
    private ?Outside $outside = null;

    #[ORM\\Column]
    private ?\\DateTimeZone $timezone = null;

    #[ORM\\Column]
    private ?Money $price = null;

    #[ORM\\Column]
    private int|string $code = 0;

    #[ORM\\Column]
    private int|null $count = null;

    #[ORM\\Column]
    private true $flag = true;
}`,
        });
        // Checked against Doctrine ORM 3.7 (Outside is an int enum declared outside src/Entity: unknown here)
        assert.deepEqual(typesOf(result, 'page'), [
            'id:integer', 'status:integer', 'suit:string', 'outside:string', 'timezone:string',
            'price:string', 'code:string', 'count:integer', 'flag:string',
        ]);
    });

    it('SYM-R6 enumType does not change the type inferred from the PHP type (enum array → json)', () => {
        const result = parseEntities({
            ...ENUMS,
            'Hand.php': `${ENTITY_HEADER}#[ORM\\Entity]\nclass Hand\n{\n${ID}
    /**
     * @return Suit[]
     */
    #[ORM\\Column(enumType: Suit::class)]
    private array $suits = [];

    #[ORM\\Column(enumType: Status::class)]
    private ?Status $status = null;

    #[ORM\\Column(enumType: Status::class)]
    private ?string $label = null;

    #[ORM\\Column(enumType: Status::class)]
    private $legacy;
}`,
        });
        assert.deepEqual(typesOf(result, 'hand'), ['id:integer', 'suits:json', 'status:integer', 'label:string', 'legacy:string']);
    });

    it('SYM-R7 every Types::*_MUTABLE constant gives the DBAL type name (DATETIME_UTC_MUTABLE → datetime_utc)', () => {
        const constants = ['DATETIME_UTC_MUTABLE', 'DATETIME_UTC_IMMUTABLE', 'DATETIMETZ_MUTABLE', 'TIME_MUTABLE', 'DATE_MUTABLE', 'SIMPLE_ARRAY'];
        const result = parseEntities({
            'Shift.php': `${ENTITY_HEADER}#[ORM\\Entity]\nclass Shift\n{\n${ID}${constants.map((constant, i) => `
    #[ORM\\Column(type: Types::${constant})]
    private $field${i};
`).join('')}}`,
        });
        assert.deepEqual(typesOf(result, 'shift').slice(1), [
            'field0:datetime_utc', 'field1:datetime_utc_immutable', 'field2:datetimetz', 'field3:time', 'field4:date', 'field5:simple_array',
        ]);
    });

    it('SYM-R8 a custom type given as SomeType::class gives a readable type name', () => {
        const result = parseEntities({
            'Book.php': `${ENTITY_HEADER}use App\\Doctrine\\MoneyType;\n\n#[ORM\\Entity]\nclass Book\n{\n${ID}
    #[ORM\\Column(type: MoneyType::class)]
    private ?Money $cost = null;

    #[ORM\\Column(type: \\App\\Doctrine\\GeoPointType::class, nullable: true)]
    private ?Point $place = null;
}`,
        });
        assert.deepEqual(typesOf(result, 'book'), ['id:integer', 'cost:money', 'place:geo_point']);
    });

    describe('SYM-R9 entity inheritance', () => {
        const PERSON = php(`#[ORM\\Entity]
#[ORM\\InheritanceType('SINGLE_TABLE')]
#[ORM\\DiscriminatorColumn(name: 'kind', type: 'string')]
#[ORM\\DiscriminatorMap(['person' => Person::class, 'customer' => Customer::class, 'vip' => VipCustomer::class])]
class Person
{
${ID.replace('private', 'protected')}
    #[ORM\\Column(length: 100)]
    protected ?string $name = null;
}`);
        const VEHICLE = php(`#[ORM\\Entity]
#[ORM\\InheritanceType('JOINED')]
#[ORM\\DiscriminatorColumn(name: 'discr', type: 'string', length: 30)]
#[ORM\\DiscriminatorMap(['vehicle' => Vehicle::class, 'car' => Car::class, 'sports' => SportsCar::class])]
class Vehicle
{
    #[ORM\\Id]
    #[ORM\\Column(type: 'bigint')]
    protected ?string $id = null;

    #[ORM\\Column]
    protected ?int $wheels = null;
}`);
        const FILES = {
            'Animal.php': php(`/**\n * @ORM\\Entity\n * @ORM\\InheritanceType("SINGLE_TABLE")\n */\nclass Animal\n{\n${ID}}`),
            'Car.php': php(`#[ORM\\Entity]\nclass Car extends Vehicle\n{\n    #[ORM\\Column]\n    private ?int $doors = null;\n\n    #[ORM\\ManyToOne]\n    private ?Employee $driver = null;\n}`),
            'Customer.php': php(`#[ORM\\Entity]\nclass Customer extends Person
{
    #[ORM\\Column(length: 20)]
    private ?string $loyaltyCard = null;

    #[ORM\\ManyToOne]
    #[ORM\\JoinColumn(nullable: false)]
    private ?Employee $manager = null;

    #[ORM\\ManyToMany(targetEntity: Employee::class)]
    private $contacts;
}`),
            'Dog.php': php('#[ORM\\Entity]\nclass Dog extends Animal\n{\n    #[ORM\\Column]\n    private bool $barks = true;\n}'),
            'Employee.php': php(`#[ORM\\Entity]\nclass Employee\n{\n    #[ORM\\Id, ORM\\GeneratedValue, ORM\\Column(type: 'bigint')]\n    private ?string $id = null;\n}`),
            'Person.php': PERSON,
            'Purchase.php': php(`#[ORM\\Entity]\nclass Purchase\n{\n${ID}\n    #[ORM\\ManyToOne]\n    private ?Customer $customer = null;\n\n    #[ORM\\ManyToOne]\n    private ?SportsCar $car = null;\n}`),
            'SportsCar.php': php('#[ORM\\Entity]\nclass SportsCar extends Car\n{\n    #[ORM\\Column]\n    private ?int $topSpeed = null;\n}'),
            'Vehicle.php': VEHICLE,
            'VipCustomer.php': php('#[ORM\\Entity]\nclass VipCustomer extends Customer\n{\n    #[ORM\\Column]\n    private int $level = 0;\n}'),
        };

        it('single-table children share the root table, joined children get the root key (checked against Doctrine ORM 3.7)', () => {
            const result = parseEntities(FILES);
            assert.deepEqual(result.warnings, []);
            assert.deepEqual(result.tables, [
                {
                    table: 'animal',
                    columns: [
                        { name: 'id', type: 'integer', primary: true },
                        { name: 'dtype', type: 'string' },
                        { name: 'barks', type: 'boolean', nullable: true },
                    ],
                    relations: [],
                },
                {
                    table: 'car',
                    columns: [
                        { name: 'id', type: 'bigint', primary: true },
                        { name: 'doors', type: 'integer' },
                        { name: 'driver_id', type: 'bigint', nullable: true },
                    ],
                    relations: [
                        { foreignKey: 'id', references: 'id', on: 'vehicle', type: 'one-to-one' },
                        { foreignKey: 'driver_id', references: 'id', on: 'employee', type: 'many-to-one' },
                    ],
                },
                { table: 'employee', columns: [{ name: 'id', type: 'bigint', primary: true }], relations: [] },
                {
                    table: 'person',
                    columns: [
                        { name: 'id', type: 'integer', primary: true },
                        { name: 'name', type: 'string' },
                        { name: 'kind', type: 'string' },
                        { name: 'loyalty_card', type: 'string', nullable: true },
                        { name: 'manager_id', type: 'bigint' },
                        { name: 'level', type: 'integer', nullable: true },
                    ],
                    relations: [
                        { foreignKey: 'manager_id', references: 'id', on: 'employee', type: 'many-to-one' },
                        { foreignKey: 'customer_id', references: 'id', on: 'employee', type: 'many-to-many', via: 'customer_employee' },
                    ],
                },
                {
                    table: 'purchase',
                    columns: [
                        { name: 'id', type: 'integer', primary: true },
                        { name: 'customer_id', type: 'integer', nullable: true },
                        { name: 'car_id', type: 'bigint', nullable: true },
                    ],
                    relations: [
                        { foreignKey: 'customer_id', references: 'id', on: 'person', type: 'many-to-one' },
                        { foreignKey: 'car_id', references: 'id', on: 'sports_car', type: 'many-to-one' },
                    ],
                },
                {
                    table: 'sports_car',
                    columns: [{ name: 'id', type: 'bigint', primary: true }, { name: 'top_speed', type: 'integer' }],
                    relations: [{ foreignKey: 'id', references: 'id', on: 'vehicle', type: 'one-to-one' }],
                },
                {
                    table: 'vehicle',
                    columns: [
                        { name: 'id', type: 'bigint', primary: true },
                        { name: 'wheels', type: 'integer' },
                        { name: 'discr', type: 'string' },
                    ],
                    relations: [],
                },
            ]);
        });

        it('inherited columns keep the git status of the file that declares them', () => {
            const dir = project(Object.fromEntries(Object.entries(FILES).map(([name, content]) => [`src/Entity/${name}`, content])));
            git(dir, 'init', '-q');
            commitAll(dir);
            writeFiles(dir, {
                'src/Entity/Customer.php': FILES['Customer.php'].replace('length: 20', 'length: 30'),
                'src/Entity/Vehicle.php': VEHICLE.replace('length: 30', 'length: 40'),
            });

            const status = gitOf(parse(dir));
            assert.equal(status['person.loyalty_card'], 'modified');
            assert.equal(status['vehicle.discr'], 'modified');
            for (const key of ['person.name', 'person.kind', 'person.level', 'vehicle.id', 'car.id', 'car.doors']) {
                assert.equal(status[key], 'committed', key);
            }
        });

        it('a root entity without children still gets its discriminator column', () => {
            const result = parseEntities({
                'Lonely.php': `${ENTITY_HEADER}#[ORM\\Entity]\n#[ORM\\InheritanceType(value: 'JOINED')]\n#[ORM\\DiscriminatorColumn('kind', Types::SMALLINT)]\nclass Lonely\n{\n${ID}}`,
                'Single.php': php(`/**\n * @ORM\\Entity\n * @ORM\\InheritanceType("SINGLE_TABLE")\n * @ORM\\DiscriminatorColumn(name="type")\n */\nclass Single\n{\n${ID}}`),
            });
            assert.deepEqual(typesOf(result, 'lonely'), ['id:integer', 'kind:smallint']);
            assert.deepEqual(typesOf(result, 'single'), ['id:integer', 'type:string']);
        });

        it('an entity extending an entity without InheritanceType keeps its table, with a warning', () => {
            const result = parseEntities({
                'Base.php': php(`#[ORM\\Entity]\nclass Base\n{\n${ID}}`),
                'Sub.php': php('#[ORM\\Entity]\nclass Sub extends Base\n{\n    #[ORM\\Column]\n    private ?int $extra = null;\n}'),
            });
            assert.deepEqual(typesOf(result, 'sub'), ['extra:integer']);
            assert.ok(result.warnings.includes('src/Entity/Sub.php: Sub extends the entity Base, which has no inheritance type: inherited fields are not shown.'));
        });

        it('SYM-V4 the primary key copied into a joined child table has the git status of the child class', () => {
            const { 'SportsCar.php': sportsCar, ...committed } = FILES;
            const dir = project(Object.fromEntries(Object.entries(committed).map(([name, content]) => [`src/Entity/${name}`, content])));
            git(dir, 'init', '-q');
            commitAll(dir);
            writeFiles(dir, {
                'src/Entity/SportsCar.php': sportsCar,
                'src/Entity/Car.php': FILES['Car.php'].replace('#[ORM\\Entity]', "#[ORM\\Entity(readOnly: false)]"),
            });

            const status = gitOf(parse(dir));
            assert.equal(status['sports_car.id'], 'untracked');
            assert.equal(status['sports_car.top_speed'], 'untracked');
            assert.equal(status['car.id'], 'modified');
            assert.equal(status['car.doors'], 'committed');
            assert.equal(status['vehicle.id'], 'committed');
        });
    });

    it('SYM-R10 entities inside a git submodule nested in src/Entity get their own status', () => {
        const lib = project({ 'Tag.php': php(`#[ORM\\Entity]\n#[ORM\\Table(name: 'shared_tag')]\nclass Tag\n{\n${ID}\n    #[ORM\\Column(length: 50)]\n    private ?string $name = null;\n}`, 'App\\Entity\\Shared') });
        git(lib, 'init', '-q');
        commitAll(lib);
        const dir = copyFixture(project());
        git(dir, 'init', '-q');
        commitAll(dir);
        git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'src/Entity/Shared');
        commitAll(dir, 'submodule');

        const shared = path.join(dir, 'src', 'Entity', 'Shared');
        writeFiles(shared, {
            'Tag.php': fs.readFileSync(path.join(shared, 'Tag.php'), 'utf8').replace('length: 50', 'length: 60'),
            'Badge.php': php(`#[ORM\\Entity]\nclass Badge\n{\n${ID}}`, 'App\\Entity\\Shared'),
        });

        for (const env of [{}, gitConfigEnv({ 'diff.ignoreSubmodules': 'all' })]) {
            const status = withEnv(env, () => gitOf(parse(dir)));
            assert.equal(status['shared_tag.name'], 'modified', JSON.stringify(env));
            assert.equal(status['shared_tag.id'], 'committed', JSON.stringify(env));
            assert.equal(status['badge.id'], 'untracked', JSON.stringify(env));
            assert.equal(status['tag.name'], 'committed', JSON.stringify(env));
        }
    });

    it('SYM-R11 files that .gitattributes marks as binary (-diff) still show their modified columns', () => {
        const dir = copyFixture(project({ '.gitattributes': '*.php -diff\n' }));
        git(dir, 'init', '-q');
        commitAll(dir);
        const tag = path.join(dir, 'src', 'Entity', 'Tag.php');
        fs.writeFileSync(tag, fs.readFileSync(tag, 'utf8').replace('length: 50,', 'length: 60,'));

        const status = gitOf(parse(dir));
        assert.equal(status['tag.name'], 'modified');
        assert.equal(status['tag.id'], 'committed');
    });

    it('SYM-R12 the parser and its tests contain no raw invisible characters', () => {
        for (const file of [path.join(__dirname, '..', '..', 'parsers', 'symfony.js'), __filename]) {
            assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /[\u00AD\u200B-\u200F\u2028\u2029\u2060\uFEFF]/, file);
        }
    });
});

describe('symfony parser: traits and parent classes (SYM-V1)', () => {
    // Each table was checked against the schema of Doctrine ORM 3.7 (SchemaTool)
    const INHERITED = path.join(__dirname, '..', 'fixtures', 'symfony', 'inherited');
    let result;
    before(() => {
        result = parse(INHERITED, { git: false });
    });

    it('reads the inherited fixture without warning', () => {
        assert.deepEqual(result.warnings, []);
        assert.deepEqual(result.tables.map(t => t.table), ['author', 'book', 'branch', 'edition', 'invoice', 'label', 'library', 'note', 'shop_library']);
    });

    it('an entity gets the mapped fields of the traits it uses, after its own', () => {
        assert.deepEqual(table(result, 'book').columns, [
            { name: 'id', type: 'integer', primary: true },
            { name: 'title', type: 'string' },
            { name: 'code', type: 'string' },
        ]);
    });

    it('a trait used by a trait gives its fields too', () => {
        assert.deepEqual(table(result, 'note').columns, [
            { name: 'id', type: 'integer', primary: true },
            { name: 'updated_at', type: 'datetime_immutable', nullable: true },
            { name: 'created_at', type: 'datetime_immutable' },
        ]);
    });

    it('a mapped superclass gives all its fields, private ones included, and names the join tables of its associations', () => {
        assert.deepEqual(table(result, 'invoice'), {
            table: 'invoice',
            columns: [
                { name: 'id', type: 'integer', primary: true },
                { name: 'version', type: 'integer' },
                { name: 'number', type: 'string' },
            ],
            relations: [{ foreignKey: 'base_record_id', references: 'id', on: 'label', type: 'many-to-many', via: 'base_record_label' }],
        });
    });

    it('a plain abstract parent gives the fields its children can see: not its private ones, nor those of its traits', () => {
        assert.deepEqual(table(result, 'author').columns, [
            { name: 'name', type: 'string' },
            { name: 'id', type: 'integer', primary: true },
        ]);
    });

    it('a property redeclared by the entity keeps the entity mapping (over its parent and its trait)', () => {
        assert.deepEqual(table(result, 'edition').columns, [
            { name: 'id', type: 'integer', primary: true },
            { name: 'label', type: 'text' },
            { name: 'isbn', type: 'string' },
        ]);
    });

    it('a trait in another namespace resolves types and target entities with its own use statements', () => {
        // Branch is in App\Entity, next to another Library entity: the trait imports App\Entity\Shop\Library
        assert.deepEqual(table(result, 'branch'), {
            table: 'branch',
            columns: [
                { name: 'id', type: 'integer', primary: true },
                { name: 'library_id', type: 'bigint', nullable: true },
                { name: 'level', type: 'integer' },
            ],
            relations: [{ foreignKey: 'library_id', references: 'id', on: 'shop_library', type: 'many-to-one' }],
        });
    });

    it('a trait column gets the git status of its lines in the trait file', () => {
        const dir = copyFixture(project(), INHERITED);
        git(dir, 'init', '-q');
        commitAll(dir);
        const trait = path.join(dir, 'src', 'Entity', 'HasCode.php');
        fs.writeFileSync(trait, fs.readFileSync(trait, 'utf8').replace('length: 20', 'length: 25'));

        const status = gitOf(parse(dir));
        assert.equal(status['book.code'], 'modified');
        assert.equal(status['book.id'], 'committed');
        assert.equal(status['book.title'], 'committed');
        // Edition redeclares $code in its own file
        assert.equal(status['edition.isbn'], 'committed');
        assert.equal(status['branch.level'], 'committed');
    });

    it('a single-table child gets the fields of its traits as nullable columns, a joined child above a mapped superclass gets the root key', () => {
        const result = parseEntities({
            'Animal.php': php(`#[ORM\\Entity]\n#[ORM\\InheritanceType('SINGLE_TABLE')]\nclass Animal\n{\n${ID}}`),
            'Dog.php': php('#[ORM\\Entity]\nclass Dog extends Animal\n{\n    use Barks;\n}'),
            'Barks.php': php('trait Barks\n{\n    #[ORM\\Column]\n    private bool $loud = true;\n}'),
            'Vehicle.php': php(`#[ORM\\Entity]\n#[ORM\\InheritanceType('JOINED')]\nclass Vehicle\n{\n${ID.replace('private', 'protected')}}`),
            'Motor.php': php('#[ORM\\MappedSuperclass]\nabstract class Motor extends Vehicle\n{\n    #[ORM\\Column]\n    private ?int $power = null;\n}'),
            'Car.php': php('#[ORM\\Entity]\nclass Car extends Motor\n{\n    #[ORM\\Column]\n    private ?int $doors = null;\n}'),
        });
        assert.deepEqual(result.warnings, []);
        assert.deepEqual(table(result, 'animal').columns, [
            { name: 'id', type: 'integer', primary: true },
            { name: 'dtype', type: 'string' },
            { name: 'loud', type: 'boolean', nullable: true },
        ]);
        assert.deepEqual(table(result, 'car'), {
            table: 'car',
            columns: [
                { name: 'id', type: 'integer', primary: true },
                { name: 'power', type: 'integer' },
                { name: 'doors', type: 'integer' },
            ],
            relations: [{ foreignKey: 'id', references: 'id', on: 'vehicle', type: 'one-to-one' }],
        });
    });

    it('cyclic traits and parents (invalid PHP) do not loop', () => {
        const result = parseEntities({
            'A.php': php('trait A\n{\n    use B;\n\n    #[ORM\\Column]\n    private ?int $a = null;\n}'),
            'B.php': php('trait B\n{\n    use A;\n\n    #[ORM\\Column]\n    private ?int $b = null;\n}'),
            'P.php': php('abstract class P extends Q\n{\n    #[ORM\\Column]\n    protected ?int $p = null;\n}'),
            'Q.php': php('abstract class Q extends P\n{\n}'),
            'Item.php': php(`#[ORM\\Entity]\nclass Item extends P\n{\n    use A;\n${ID}}`),
        });
        assert.deepEqual(columnNames(result, 'item'), ['p', 'id', 'a', 'b']);
    });

    it('traits that each use all the previous ones are read once (no exponential walk)', () => {
        const files = {};
        for (let i = 0; i < 24; i++) {
            const uses = i === 0 ? '' : `    use ${Array.from({ length: i }, (_, j) => `T${j}`).join(', ')};\n\n`;
            files[`T${i}.php`] = php(`trait T${i}\n{\n${uses}    #[ORM\\Column]\n    protected ?int $f${i} = null;\n}`);
        }
        files['Item.php'] = php(`#[ORM\\Entity]\nclass Item\n{\n    use T23;\n${ID}}`);

        const started = Date.now();
        const result = parseEntities(files);
        assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
        assert.equal(table(result, 'item').columns.length, 25);
    });
});

describe('symfony parser: round 2 findings', () => {
    it('SYM-V2 diff.submodule=diff or log does not change the status of the files of a submodule', () => {
        const lib = project({ 'Tag.php': php(`#[ORM\\Entity]\n#[ORM\\Table(name: 'shared_tag')]\nclass Tag\n{\n${ID}}`, 'App\\Entity\\Shared') });
        git(lib, 'init', '-q');
        commitAll(lib);
        const dir = copyFixture(project());
        git(dir, 'init', '-q');
        commitAll(dir);
        git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'src/Entity/Shared');
        commitAll(dir, 'submodule');
        // Committed in the submodule, not yet recorded by the superproject: compared with the submodule HEAD
        const shared = path.join(dir, 'src', 'Entity', 'Shared');
        writeFiles(shared, { 'Badge.php': php(`#[ORM\\Entity]\nclass Badge\n{\n${ID}}`, 'App\\Entity\\Shared') });
        commitAll(shared);

        for (const env of [{}, gitConfigEnv({ 'diff.submodule': 'diff' }), gitConfigEnv({ 'diff.submodule': 'log' })]) {
            const status = withEnv(env, () => gitOf(parse(dir)));
            assert.equal(status['badge.id'], 'committed', JSON.stringify(env));
            assert.equal(status['shared_tag.id'], 'committed', JSON.stringify(env));
        }
    });

    it('SYM-V3 GIT_DIFF_OPTS with diff.suppressBlankEmpty does not shift the changed lines', () => {
        const dir = copyFixture(project());
        git(dir, 'init', '-q');
        commitAll(dir);
        const post = path.join(dir, 'src', 'Entity', 'Post.php');
        // The changed line follows a blank line, which suppressBlankEmpty prints as an empty line
        fs.writeFileSync(post, fs.readFileSync(post, 'utf8').replace('#[ORM\\Column(length: 255)]', '#[ORM\\Column(length: 200)]'));

        const env = { GIT_DIFF_OPTS: '--unified=5', ...gitConfigEnv({ 'diff.suppressBlankEmpty': 'true' }) };
        const status = withEnv(env, () => gitOf(parse(dir)));
        assert.equal(status['post.title'], 'modified');
        assert.equal(status['post.id'], 'committed');
        assert.equal(status['post.content'], 'committed');
    });

    describe('SYM-V2 SYM-V3 git runs without the diff variables of the user', () => {
        let calls;
        before(() => {
            calls = mock.method(childProcess, 'execFileSync');
        });
        after(() => mock.restoreAll());

        it('drops GIT_DIFF_OPTS and GIT_EXTERNAL_DIFF from the environment of git', () => {
            const dir = copyFixture(project());
            git(dir, 'init', '-q');
            commitAll(dir);
            calls.mock.resetCalls();

            withEnv({ GIT_DIFF_OPTS: '--unified=5', GIT_EXTERNAL_DIFF: 'false' }, () => parse(dir));
            const gitCalls = calls.mock.calls.filter(call => call.arguments[0] === 'git');
            assert.ok(gitCalls.length > 0);
            for (const call of gitCalls) {
                assert.deepEqual(Object.keys(call.arguments[2].env).filter(key => /^GIT_(DIFF_OPTS|EXTERNAL_DIFF)$/i.test(key)), []);
            }
        });
    });

    it('SYM-V5 a property typed with a namespace segment named like a keyword (\\App\\Entity\\Function\\Role) is read', () => {
        const result = parseEntities({
            'Employee.php': php(`#[ORM\\Entity]\nclass Employee\n{\n${ID}
    #[ORM\\ManyToOne]
    private ?\\App\\Entity\\Function\\Role $role = null;

    #[ORM\\ManyToOne]
    private ?Function\\Role $deputy = null;

    #[ORM\\Column(length: 100)]
    private ?string $function = null;
}`),
            'Function/Role.php': php(`#[ORM\\Entity]\nclass Role\n{\n${ID}}`, 'App\\Entity\\Function'),
        });
        assert.deepEqual(columnNames(result, 'employee'), ['id', 'role_id', 'deputy_id', 'function']);
        assert.deepEqual(table(result, 'employee').relations.map(r => `${r.foreignKey} -> ${r.on}`), ['role_id -> role', 'deputy_id -> role']);
        assert.deepEqual(result.warnings, []);
    });
});

describe('symfony parser: names matching Object.prototype keys', () => {
    it('reads relations to a Constructor entity and columns typed with a Constructor enum', () => {
        const result = parseEntities({
            'Constructor.php': php(`#[ORM\\Entity]\nclass Constructor\n{\n${ID}}`),
            'Maker.php': php('enum Maker: int\n{\n    case Acme = 1;\n}'),
            'Result.php': php(`#[ORM\\Entity]\nclass Result\n{\n${ID}\n    #[ORM\\ManyToOne]\n    private ?Constructor $constructor = null;\n\n    #[ORM\\Column(enumType: Maker::class)]\n    private ?Maker $maker = null;\n}`),
        });
        assert.deepEqual(table(result, 'result'), {
            table: 'result',
            columns: [
                { name: 'id', type: 'integer', primary: true },
                { name: 'constructor_id', type: 'integer', nullable: true },
                { name: 'maker', type: 'integer' },
            ],
            relations: [{ foreignKey: 'constructor_id', references: 'id', on: 'constructor', type: 'many-to-one' }],
        });
        assert.deepEqual(result.warnings, []);
    });
});

describe('symfony parser: trait and parent precedence (checked against Doctrine ORM 3.7)', () => {
    const STAMPS = php('trait Stamps\n{\n    #[ORM\\Column]\n    protected ?\\DateTimeImmutable $createdAt = null;\n}');

    it('an inherited field wins over the same field of a trait, as in PHP', () => {
        const result = parseEntities({
            'Base.php': php("abstract class Base\n{\n    #[ORM\\Column(name: 'from_parent')]\n    public ?string $val = null;\n}"),
            'Named.php': php("trait Named\n{\n    #[ORM\\Column(name: 'from_trait')]\n    public ?string $val = null;\n}"),
            'Item.php': php(`#[ORM\\Entity]\nclass Item extends Base\n{\n    use Named;\n\n${ID}}`),
        });
        assert.deepEqual(columnNames(result, 'item'), ['from_parent', 'id']);
    });

    it('a child entity using the trait of its parent entity does not map its fields twice', () => {
        const result = parseEntities({
            'Stamps.php': STAMPS,
            'Vehicle.php': php(`#[ORM\\Entity]\n#[ORM\\InheritanceType('JOINED')]\nclass Vehicle\n{\n    use Stamps;\n\n${ID}}`),
            'Bike.php': php('#[ORM\\Entity]\nclass Bike extends Vehicle\n{\n    use Stamps;\n\n    #[ORM\\Column]\n    private int $gears = 0;\n}'),
        });
        assert.deepEqual(columnNames(result, 'bike'), ['id', 'gears']);
        assert.deepEqual(columnNames(result, 'vehicle'), ['id', 'created_at', 'dtype']);
    });

    it('single-table siblings mapping the same association add one relation to the root table', () => {
        const hasOffice = php('trait HasOffice\n{\n    #[ORM\\ManyToOne]\n    protected ?Office $office = null;\n}');
        const result = parseEntities({
            'HasOffice.php': hasOffice,
            'Office.php': php(`#[ORM\\Entity]\nclass Office\n{\n${ID}}`),
            'Person.php': php(`#[ORM\\Entity]\n#[ORM\\InheritanceType('SINGLE_TABLE')]\nclass Person\n{\n${ID}}`),
            'Employee.php': php('#[ORM\\Entity]\nclass Employee extends Person\n{\n    use HasOffice;\n}'),
            'Customer.php': php('#[ORM\\Entity]\nclass Customer extends Person\n{\n    use HasOffice;\n}'),
        });
        assert.deepEqual(table(result, 'person').relations, [
            { foreignKey: 'office_id', references: 'id', on: 'office', type: 'many-to-one' },
        ]);
    });
});

//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectFramework } = require('../../parsers/parser');
const { ParserError } = require('../../parsers/errors');

let tmpRoot;

test.before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmdb-detect-'));
});

test.after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Creates a project folder with the given files (relative path -> content)
function project(name, files) {
    const dir = path.join(tmpRoot, name);
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), content);
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

const composer = (dependencies, extra = {}) => JSON.stringify({ name: 'acme/app', require: dependencies, ...extra }, null, 4);

test('detects Laravel: artisan + laravel/framework', () => {
    const dir = project('laravel', {
        artisan: '#!/usr/bin/env php',
        'composer.json': composer({ php: '^8.2', 'laravel/framework': '^12.0' }),
    });
    assert.equal(detectFramework(dir), 'laravel');
});

test('detects Symfony: bin/console + symfony/framework-bundle', () => {
    const dir = project('symfony', {
        'bin/console': '#!/usr/bin/env php',
        'composer.json': composer({ php: '>=8.2', 'symfony/framework-bundle': '7.4.*', 'doctrine/orm': '^3.3' }),
    });
    assert.equal(detectFramework(dir), 'symfony');
});

test('detects Symfony with another symfony/* package', () => {
    const dir = project('symfony-console', {
        'bin/console': '',
        'composer.json': composer({ 'symfony/console': '^7.4', 'doctrine/orm': '^3.3' }),
    });
    assert.equal(detectFramework(dir), 'symfony');
});

test('a symfony polyfill alone is not Symfony', () => {
    const dir = project('polyfill', {
        'bin/console': '',
        'composer.json': composer({ 'symfony/polyfill-mbstring': '^1.31' }),
    });
    assert.equal(detectFramework(dir), 'Unknown');
});

test('packages only in require-dev are ignored', () => {
    const dir = project('require-dev', {
        artisan: '',
        'bin/console': '',
        'composer.json': composer({ php: '^8.2' }, { 'require-dev': { 'laravel/framework': '^12.0', 'symfony/framework-bundle': '^7.4' } }),
    });
    assert.equal(detectFramework(dir), 'Unknown');
});

test('Laravel needs artisan, Symfony needs bin/console', () => {
    const noArtisan = project('no-artisan', { 'composer.json': composer({ 'laravel/framework': '^12.0' }) });
    assert.equal(detectFramework(noArtisan), 'Unknown');
    const noConsole = project('no-console', { 'composer.json': composer({ 'symfony/framework-bundle': '^7.4' }) });
    assert.equal(detectFramework(noConsole), 'Unknown');
});

test('Laravel wins when both markers are present', () => {
    const dir = project('both', {
        artisan: '',
        'bin/console': '',
        'composer.json': composer({ 'laravel/framework': '^12.0', 'symfony/console': '^7.4' }),
    });
    assert.equal(detectFramework(dir), 'laravel');
});

test('unknown project, missing composer.json or missing folder', () => {
    assert.equal(detectFramework(project('empty', {})), 'Unknown');
    assert.equal(detectFramework(project('no-composer', { artisan: '' })), 'Unknown');
    assert.equal(detectFramework(path.join(tmpRoot, 'does-not-exist')), 'Unknown');
    assert.equal(detectFramework(''), 'Unknown');
    assert.equal(detectFramework(undefined), 'Unknown');
});

test('invalid composer.json is reported with the reason', () => {
    const trailingComma = project('bad-json', {
        artisan: '',
        'composer.json': '{"require": {"laravel/framework": "^12.0",}}',
    });
    assert.throws(() => detectFramework(trailingComma), error => error instanceof ParserError
        && error.message.startsWith(`composer.json in "${trailingComma}" could not be read: `)
        && /JSON/.test(error.message));

    const empty = project('empty-json', { artisan: '', 'composer.json': '' });
    assert.throws(() => detectFramework(empty), ParserError);
});

test('composer.json without a usable "require" is Unknown', () => {
    for (const [name, content] of [['null-json', 'null'], ['array-require', '{"require": ["laravel/framework"]}'], ['no-require', '{}']]) {
        assert.equal(detectFramework(project(name, { artisan: '', 'composer.json': content })), 'Unknown', name);
    }
});

test('composer.json with a UTF-8 BOM is read', () => {
    const laravel = project('bom-laravel', {
        artisan: '',
        'composer.json': '\uFEFF' + composer({ 'laravel/framework': '^12.0' }),
    });
    assert.equal(detectFramework(laravel), 'laravel');

    const symfony = project('bom-symfony', {
        'bin/console': '',
        'composer.json': Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(composer({ 'symfony/framework-bundle': '^7.4' }))]),
    });
    assert.equal(detectFramework(symfony), 'symfony');
});

test('artisan must be a file', () => {
    const dir = project('artisan-dir', {
        'artisan/readme.txt': '',
        'composer.json': composer({ 'laravel/framework': '^12.0' }),
    });
    assert.equal(detectFramework(dir), 'Unknown');
});

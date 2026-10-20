//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const i18n = require('../../views/i18n');
const appearance = require('../../views/appearance');

const ROOT = path.join(__dirname, '..', '..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');
const placeholders = (text) => (text.match(/\{\w+\}/g) || []).sort();

describe('i18n: strings', () => {
    it('every language has the same keys, with the same placeholders', () => {
        const english = Object.keys(i18n.STRINGS.en).sort();
        for (const language of i18n.LANGUAGES) {
            assert.deepEqual(Object.keys(i18n.STRINGS[language]).sort(), english, language);
            for (const key of english) {
                assert.deepEqual(placeholders(i18n.STRINGS[language][key]), placeholders(i18n.STRINGS.en[key]), `${language} ${key}`);
                assert.ok(i18n.STRINGS[language][key].trim(), `${language} ${key} is empty`);
            }
        }
    });

    it('plurals have both forms', () => {
        for (const key of Object.keys(i18n.STRINGS.en)) {
            const plural = /\.(one|other)$/.exec(key);
            if (plural) {
                const base = key.slice(0, -plural[0].length);
                assert.ok(i18n.STRINGS.en[`${base}.one`] && i18n.STRINGS.en[`${base}.other`], base);
            }
        }
    });

    it('the keys of the page exist (data-i18n attributes and t() calls)', () => {
        const t = i18n.translator('en');
        const page = read('views', 'index.html');
        const attributes = [...page.matchAll(/data-i18n(?:-title|-label|-placeholder)?="([^"]+)"/g)].map(match => match[1]);
        assert.ok(attributes.length > 10);
        const scripts = ['views/app.js', 'views/mermaid/diagram.js', 'views/inspector.js'].map(file => read(file)).join('\n');
        const calls = [...scripts.matchAll(/\bt[r]?\('([\w.-]+)'/g)].map(match => match[1]);
        assert.ok(calls.length > 30);
        for (const key of [...attributes, ...calls]) {
            assert.ok(t.has(key), key);
        }
    });

    it('the keys built at run time exist', () => {
        const t = i18n.translator('en');
        const keys = [
            ...['untracked', 'modified', 'unsaved'].flatMap(status => [`legend.${status}`, `legend.${status}.title`, `git.label.${status}`]),
            'direction.TB', 'direction.LR', 'panel.direction.TB', 'panel.direction.LR',
            ...appearance.THEMES.map(theme => `panel.theme.${theme}`),
            ...Object.keys(appearance.PALETTES).map(name => `palette.${name}`),
            ...appearance.COLOR_KEYS.map(key => `color.${key}`),
            ...appearance.FONTS.map(font => `font.${font}`),
            ...['auto', ...i18n.LANGUAGES].map(language => `language.${language}`),
            ...['licensed', 'development', 'trial', 'expired', 'buy', 'enter', 'manage', 'discover'].map(kind => `panel.license.${kind}`),
            ...['svg', 'png', 'mmd', 'md', 'json'].map(format => `format.${format}`),
            ...['untracked', 'modified', 'unsaved'].map(status => `inspector.git.${status}`),
            ...['many-to-one', 'one-to-one', 'many-to-many'].map(type => `inspector.relation.${type}`),
            ...['details', 'history', 'actions'].map(key => `inspector.pro.${key}`),
            'inspector.open.laravel', 'inspector.open.symfony',
            ...['columns', 'relations', 'referencedBy'].map(key => `inspector.summary.${key}`),
        ];
        for (const key of keys) {
            assert.ok(t.has(key), key);
        }
    });

    it('the tools and exports of DrawMeDatabase Pro listed by the extension have their texts', () => {
        const source = read('extension.js');
        const list = (name) => JSON.parse(new RegExp(`const ${name} = (\\[[^\\]]+\\])`).exec(source)[1].replace(/'/g, '"'));
        const t = i18n.translator('en');
        for (const id of list('PRO_TOOLS')) {
            assert.ok(t.has(`tool.${id}`) && t.has(`tool.${id}.hint`), id);
        }
        for (const id of list('PRO_EXPORTS')) {
            assert.ok(t.has(`export.${id}`), id);
        }
    });

    it('the messages of the extension exist', () => {
        const t = i18n.translator('en');
        const keys = [...read('extension.js').matchAll(/\btr\('([\w.-]+)'/g)].map(match => match[1]);
        assert.ok(keys.length > 10);
        for (const key of keys) {
            assert.ok(t.has(key), key);
        }
    });
});

describe('i18n: translator', () => {
    it('resolves the language of the setting, else the one of VS Code, else English', () => {
        assert.equal(i18n.resolveLanguage('fr', 'en-US'), 'fr');
        assert.equal(i18n.resolveLanguage('auto', 'fr-ca'), 'fr');
        assert.equal(i18n.resolveLanguage('auto', 'fr'), 'fr');
        assert.equal(i18n.resolveLanguage('auto', 'de'), 'en');
        assert.equal(i18n.resolveLanguage(undefined, undefined), 'en');
        assert.equal(i18n.resolveLanguage('xx', 'zh-tw'), 'en');
    });

    it('replaces the parameters and picks the plural form of the language', () => {
        const en = i18n.translator('en');
        const fr = i18n.translator('fr');
        assert.equal(en('summary.tables', { count: 1 }), '1 table');
        assert.equal(en('summary.tables', { count: 0 }), '0 tables');
        assert.equal(fr('summary.warnings', { count: 0 }), '0 avertissement', 'French: singular for 0');
        assert.equal(fr('summary.warnings', { count: 2 }), '2 avertissements');
        assert.equal(fr('search.count', { count: 3, total: 9 }), '3 sur 9');
        assert.equal(en('diagram.noMatch', { query: '$& {total}' }), 'No table or column matches "$& {total}".', 'parameters are inserted as is');
        assert.equal(fr.language, 'fr');
        assert.equal(i18n.translator('xx').language, 'en');
    });

    it('falls back to English, then to the key', () => {
        i18n.register({ en: { 'test.only.english': 'Only in English' } });
        assert.equal(i18n.translator('fr')('test.only.english'), 'Only in English');
        assert.equal(i18n.translator('fr')('test.unknown'), 'test.unknown');
        assert.equal(i18n.translator('fr').has('test.unknown'), false);
    });

    it('register() adds the strings of other extensions without replacing existing ones', () => {
        i18n.register({ en: { 'test.pro.title': 'Canvas', 'tab.diagram': 'Changed' }, fr: { 'test.pro.title': 'Canevas' }, de: { 'test.pro.title': 'x' } });
        i18n.register(null);
        assert.equal(i18n.translator('fr')('test.pro.title'), 'Canevas');
        assert.equal(i18n.translator('en')('tab.diagram'), 'Diagram');
        assert.equal(i18n.STRINGS.de, undefined);
    });
});

describe('i18n: package.json', () => {
    it('the commands and settings are translated in package.nls.*.json', () => {
        const pkg = read('package.json');
        const keys = [...pkg.matchAll(/"%([\w.-]+)%"/g)].map(match => match[1]);
        assert.ok(keys.length > 20);
        const english = JSON.parse(read('package.nls.json'));
        const french = JSON.parse(read('package.nls.fr.json'));
        assert.deepEqual(Object.keys(french).sort(), Object.keys(english).sort());
        for (const key of keys) {
            assert.ok(english[key] && french[key], key);
        }
    });

    it('the language setting lists the languages of the strings', () => {
        const settings = JSON.parse(read('package.json')).contributes.configuration.properties;
        assert.deepEqual(settings['DrawMeDatabase.language'].enum, ['auto', ...i18n.LANGUAGES]);
    });
});

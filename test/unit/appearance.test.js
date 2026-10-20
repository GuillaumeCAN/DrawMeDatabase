//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const appearance = require('../../views/appearance');

const classes = (...names) => ({ contains: (name) => names.includes(name) });

describe('appearance: settings', () => {
    it('keeps the valid values and replaces the others by their default', () => {
        assert.deepEqual(appearance.sanitize(undefined), { ...appearance.DEFAULTS, colors: {} });
        assert.deepEqual(appearance.sanitize({
            theme: 'light', palette: 'ocean', font: 'custom', customFont: 'Inter', fontSize: 16, grid: false,
            colors: { header: '#AABBCC', line: 'red', unknown: '#000000', accent: '#123456' },
        }), {
            theme: 'light', palette: 'ocean', font: 'custom', customFont: 'Inter', fontSize: 16, grid: false,
            colors: { header: '#aabbcc', accent: '#123456' },
        });
        const invalid = appearance.sanitize({ theme: 'blue', palette: 'toString', font: 'comic', fontSize: 'big', colors: ['#000000'] });
        assert.deepEqual(invalid, { ...appearance.DEFAULTS, colors: {} });
    });

    it('clamps the text size and cleans the font name', () => {
        assert.equal(appearance.sanitize({ fontSize: 3 }).fontSize, appearance.FONT_SIZE.min);
        assert.equal(appearance.sanitize({ fontSize: 99 }).fontSize, appearance.FONT_SIZE.max);
        assert.equal(appearance.sanitize({ fontSize: 14.6 }).fontSize, 15);
        assert.equal(appearance.sanitize({ customFont: '"Fira Sans"; } body { color: red' }).customFont, '"Fira Sans" body color red');
        assert.equal(appearance.sanitize({ customFont: 'x'.repeat(500) }).customFont.length, 120);
        assert.equal(appearance.sanitize({ customFont: 42 }).customFont, '');
    });
});

describe('appearance: palettes and themes', () => {
    it('every palette has a light and a dark version, in #rrggbb colors of known keys', () => {
        for (const [name, palette] of Object.entries(appearance.PALETTES)) {
            assert.deepEqual(Object.keys(palette).sort(), ['dark', 'light'], name);
            assert.deepEqual(Object.keys(palette.light).sort(), Object.keys(palette.dark).sort(), name);
            for (const colors of [palette.light, palette.dark]) {
                for (const [key, value] of Object.entries(colors)) {
                    assert.ok(appearance.COLOR_KEYS.includes(key), `${name}.${key}`);
                    assert.ok(appearance.isColor(value), `${name}.${key} ${value}`);
                }
            }
        }
        assert.deepEqual(appearance.PALETTES.vscode, { light: {}, dark: {} }, 'the VS Code palette keeps the theme colors');
    });

    it('the theme is the forced one, else the one of VS Code', () => {
        assert.equal(appearance.themeKind({ theme: 'light' }, classes('vscode-dark')), 'light');
        assert.equal(appearance.themeKind({ theme: 'dark' }, classes('vscode-light')), 'dark');
        assert.equal(appearance.themeKind({ theme: 'auto' }, classes('vscode-light')), 'light');
        assert.equal(appearance.themeKind({ theme: 'auto' }, classes('vscode-dark')), 'dark');
        assert.equal(appearance.themeKind({ theme: 'auto' }, classes('vscode-high-contrast')), 'hc-dark');
        assert.equal(appearance.themeKind({ theme: 'auto' }, classes('vscode-high-contrast', 'vscode-high-contrast-light')), 'hc-light');
        assert.equal(appearance.themeKind(null, null), 'dark');
    });

    it('the colors are the palette of the theme, then the custom ones; high contrast keeps its own', () => {
        const settings = { palette: 'forest', colors: { accent: '#ff0000' } };
        assert.deepEqual(appearance.paletteColors(settings, 'light'), { ...appearance.PALETTES.forest.light, accent: '#ff0000' });
        assert.deepEqual(appearance.paletteColors(settings, 'dark'), { ...appearance.PALETTES.forest.dark, accent: '#ff0000' });
        assert.deepEqual(appearance.paletteColors(settings, 'hc-dark'), { accent: '#ff0000' });
    });

    it('the font of the drawings', () => {
        assert.equal(appearance.fontFamily({ font: 'default' }), appearance.UI_FONT);
        assert.equal(appearance.fontFamily({ font: 'editor' }, '"Fira Code", monospace'), '"Fira Code", monospace');
        assert.match(appearance.fontFamily({ font: 'editor' }, ''), /monospace$/);
        assert.equal(appearance.fontFamily({ font: 'custom', customFont: 'Inter' }), `Inter, ${appearance.UI_FONT}`);
        assert.equal(appearance.fontFamily({ font: 'custom', customFont: '' }), appearance.UI_FONT);
        assert.match(appearance.fontFamily({ font: 'serif' }), /serif$/);
    });
});

describe('appearance: package.json', () => {
    it('the settings list the same values', () => {
        const settings = require(path.join(__dirname, '..', '..', 'package.json')).contributes.configuration.properties;
        assert.deepEqual(settings['DrawMeDatabase.theme'].enum, appearance.THEMES);
        assert.deepEqual(settings['DrawMeDatabase.palette'].enum, Object.keys(appearance.PALETTES));
        assert.deepEqual(settings['DrawMeDatabase.font'].enum, appearance.FONTS);
        assert.deepEqual(Object.keys(settings['DrawMeDatabase.colors'].properties), appearance.COLOR_KEYS);
        assert.equal(settings['DrawMeDatabase.fontSize'].minimum, appearance.FONT_SIZE.min);
        assert.equal(settings['DrawMeDatabase.fontSize'].maximum, appearance.FONT_SIZE.max);
        assert.equal(settings['DrawMeDatabase.fontSize'].default, appearance.FONT_SIZE.default);
    });
});

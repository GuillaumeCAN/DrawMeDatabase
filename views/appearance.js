//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Appearance of the pages: theme (like VS Code, light or dark), palette, custom colors, font and
// grid, from the DrawMeDatabase settings. The extension validates the settings with sanitize()
// (require); the pages apply them with apply() (window.DrawMeDatabaseAppearance), and the drawings
// read the result with colors() and font().
(function (root) {
    'use strict';

    const THEMES = ['auto', 'light', 'dark'];
    const FONTS = ['default', 'editor', 'sans', 'serif', 'mono', 'custom'];
    const COLOR_KEYS = ['background', 'header', 'text', 'border', 'line', 'accent', 'gitNew', 'gitModified', 'gitUnsaved'];
    const FONT_SIZE = { min: 10, max: 20, default: 13 };

    const UI_FONT = 'system-ui, -apple-system, "Segoe UI", Ubuntu, Roboto, "Helvetica Neue", Arial, sans-serif';
    const FONT_STACKS = {
        default: UI_FONT,
        sans: 'Inter, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
        mono: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace',
    };

    // Colors of each palette, for the light and the dark themes ('vscode': the colors of the theme)
    const PALETTES = {
        vscode: { light: {}, dark: {} },
        ocean: {
            light: { header: '#dbeafe', border: '#93c5fd', line: '#2563eb', accent: '#1d4ed8' },
            dark: { header: '#172a46', border: '#2f5d8f', line: '#60a5fa', accent: '#3b82f6' },
        },
        forest: {
            light: { header: '#dcfce7', border: '#86efac', line: '#16a34a', accent: '#15803d' },
            dark: { header: '#14301f', border: '#2e6b45', line: '#4ade80', accent: '#22c55e' },
        },
        sunset: {
            light: { header: '#ffedd5', border: '#fdba74', line: '#ea580c', accent: '#c2410c' },
            dark: { header: '#3b2216', border: '#8a4b2a', line: '#fb923c', accent: '#f97316' },
        },
        violet: {
            light: { header: '#ede9fe', border: '#c4b5fd', line: '#7c3aed', accent: '#6d28d9' },
            dark: { header: '#2a2147', border: '#5b4b9a', line: '#a78bfa', accent: '#8b5cf6' },
        },
        graphite: {
            light: { background: '#f5f5f5', header: '#e5e5e5', text: '#171717', border: '#a3a3a3', line: '#525252', accent: '#171717' },
            dark: { background: '#141414', header: '#262626', text: '#f5f5f5', border: '#525252', line: '#a3a3a3', accent: '#e5e5e5' },
        },
        paper: {
            light: { background: '#fbf7ef', header: '#efe4cf', text: '#3d3527', border: '#cdbb98', line: '#8a7350', accent: '#b45309' },
            dark: { background: '#1f1b16', header: '#2f281f', text: '#eadfc8', border: '#5c4f3c', line: '#b49a72', accent: '#f59e0b' },
        },
    };

    const DEFAULTS = Object.freeze({ theme: 'auto', palette: 'vscode', colors: Object.freeze({}), font: 'default', customFont: '', fontSize: FONT_SIZE.default, grid: true });

    const isColor = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

    // A font family typed by the user, kept to the characters of font names
    function cleanFontName(value) {
        return typeof value === 'string' ? value.replace(/[^\p{L}\p{N} ,"'_-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    }

    // Custom colors: the known keys, as lower case #rrggbb
    function sanitizeColors(value) {
        const colors = {};
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const key of COLOR_KEYS) {
                if (isColor(value[key])) {
                    colors[key] = value[key].toLowerCase();
                }
            }
        }
        return colors;
    }

    // The appearance settings, every unknown or invalid value replaced by its default
    function sanitize(input) {
        const value = input && typeof input === 'object' ? input : {};
        const size = Number(value.fontSize);
        return {
            theme: THEMES.includes(value.theme) ? value.theme : DEFAULTS.theme,
            palette: Object.prototype.hasOwnProperty.call(PALETTES, value.palette) ? value.palette : DEFAULTS.palette,
            colors: sanitizeColors(value.colors),
            font: FONTS.includes(value.font) ? value.font : DEFAULTS.font,
            customFont: cleanFontName(value.customFont),
            fontSize: Number.isFinite(size) ? Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, Math.round(size))) : DEFAULTS.fontSize,
            grid: value.grid !== false,
        };
    }

    // 'light', 'dark', 'hc-light' or 'hc-dark': the forced theme, else the one of VS Code (classes
    // of <body>)
    function themeKind(appearance, classList) {
        if (appearance && (appearance.theme === 'light' || appearance.theme === 'dark')) {
            return appearance.theme;
        }
        const has = (name) => Boolean(classList && classList.contains(name));
        if (has('vscode-high-contrast-light')) {
            return 'hc-light';
        }
        if (has('vscode-high-contrast')) {
            return 'hc-dark';
        }
        return has('vscode-light') ? 'light' : 'dark';
    }

    // The colors set by the palette and the custom colors, for a theme kind. High contrast themes
    // keep their own colors: only the custom ones apply.
    function paletteColors(appearance, kind) {
        const settings = sanitize(appearance);
        const contrast = kind === 'hc-light' || kind === 'hc-dark';
        const base = contrast ? {} : PALETTES[settings.palette][kind === 'light' ? 'light' : 'dark'];
        return { ...base, ...settings.colors };
    }

    // The CSS font-family of the drawings
    function fontFamily(appearance, editorFont) {
        const settings = sanitize(appearance);
        if (settings.font === 'editor') {
            return editorFont || FONT_STACKS.mono;
        }
        if (settings.font === 'custom') {
            return settings.customFont ? `${settings.customFont}, ${UI_FONT}` : UI_FONT;
        }
        return FONT_STACKS[settings.font] || UI_FONT;
    }

    const cssName = (key) => `--dmdb-color-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;

    // Page side: applies the appearance to <body> (data-dmdb-theme, --dmdb-color-*, --dmdb-font-*,
    // class dmdb-no-grid). To call again when VS Code changes its theme ('auto' follows it).
    let current = DEFAULTS;
    function apply(appearance, element) {
        const body = element || document.body;
        current = sanitize(appearance);
        if (current.theme === 'auto') {
            delete body.dataset.dmdbTheme;
        } else {
            body.dataset.dmdbTheme = current.theme;
        }
        const colors = paletteColors(current, themeKind(current, body.classList));
        for (const key of COLOR_KEYS) {
            if (colors[key]) {
                body.style.setProperty(cssName(key), colors[key]);
            } else {
                body.style.removeProperty(cssName(key));
            }
        }
        const editorFont = getComputedStyle(body).getPropertyValue('--vscode-editor-font-family').trim();
        body.style.setProperty('--dmdb-font-family', fontFamily(current, editorFont));
        body.style.setProperty('--dmdb-font-size', `${current.fontSize}px`);
        body.classList.toggle('dmdb-no-grid', !current.grid);
        return current;
    }

    // Page side: the colors of the drawings, from the CSS variables of <body> (custom colors first,
    // then the VS Code theme, then fallbacks)
    function colors(element) {
        const body = element || document.body;
        const style = getComputedStyle(body);
        const pick = (names, fallback) => {
            for (const name of names) {
                const value = style.getPropertyValue(name).trim();
                if (value) {
                    return value;
                }
            }
            return fallback;
        };
        const kind = themeKind(current, body.classList);
        const dark = kind === 'dark' || kind === 'hc-dark';
        const contrast = kind === 'hc-dark' || kind === 'hc-light';
        const background = pick([cssName('background'), '--vscode-editor-background'], dark ? '#1f1f1f' : '#ffffff');
        const text = pick([cssName('text'), '--vscode-editor-foreground', '--vscode-foreground'], dark ? '#cccccc' : '#3b3b3b');
        return {
            kind,
            dark,
            contrast,
            background,
            text,
            border: contrast
                ? pick([cssName('border'), '--vscode-contrastBorder', '--vscode-focusBorder'], text)
                : pick([cssName('border'), '--vscode-editorWidget-border', '--vscode-widget-border', '--vscode-panel-border'], dark ? '#454545' : '#c8c8c8'),
            header: pick([cssName('header'), '--vscode-editorWidget-background', '--vscode-sideBar-background'], dark ? '#252526' : '#f3f3f3'),
            line: contrast ? pick([cssName('line')], text) : pick([cssName('line'), '--vscode-descriptionForeground', '--vscode-editorLineNumber-foreground'], dark ? '#9d9d9d' : '#717171'),
            stripe: contrast ? background : pick(['--vscode-list-hoverBackground', '--vscode-editor-lineHighlightBackground'], dark ? '#2a2d2e' : '#f0f0f0'),
            accent: pick([cssName('accent'), '--vscode-focusBorder'], '#0078d4'),
        };
    }

    // Page side: the font of the drawings
    function font(element) {
        const style = getComputedStyle(element || document.body);
        return {
            family: style.getPropertyValue('--dmdb-font-family').trim() || UI_FONT,
            size: parseInt(style.getPropertyValue('--dmdb-font-size'), 10) || FONT_SIZE.default,
        };
    }

    const api = { THEMES, FONTS, COLOR_KEYS, FONT_SIZE, PALETTES, DEFAULTS, UI_FONT, isColor, sanitize, sanitizeColors, themeKind, paletteColors, fontFamily, apply, colors, font };
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.DrawMeDatabaseAppearance = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);

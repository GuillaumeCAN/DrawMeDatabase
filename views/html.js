//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Node-side helpers that fill the webview templates (no 'vscode' dependency, unit tested)

const crypto = require('crypto');

function getNonce() {
    return crypto.randomBytes(18).toString('base64');
}

function escapeAttribute(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Mermaid injects a <style> element into its SVG, hence 'unsafe-inline' for styles only.
// blob: images: the PNG export draws the SVG on a canvas.
function buildCsp(cspSource, nonce) {
    return [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src ${cspSource} 'unsafe-inline'`,
        `img-src ${cspSource} data: blob:`,
        `font-src ${cspSource}`,
    ].join('; ');
}

// Replaces {{KEY}} placeholders in one pass with a function replacer: inserted values are
// never re-scanned and '$&', "$'"... in them are kept as is. Unknown keys are left untouched.
function fillTemplate(template, values) {
    return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, key) => (
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : placeholder
    ));
}

// Scripts of the page (views/index.html), in loading order
const SCRIPTS = [
    ['vendor', 'mermaid.min.js'],
    ['mermaid', 'generator.js'],
    ['mermaid', 'zoom.js'],
    ['exporters.js'],
    ['mermaid', 'diagram.js'],
    ['json', 'json.js'],
    ['app.js'],
];

// Fills the page template (views/index.html). viewUri(...segments) returns the webview URI of
// a file of views/. The schema is not in the page: the extension posts it once the page is ready.
function buildPage(template, { cspSource, viewUri }) {
    const nonce = getNonce();
    const uri = (...segments) => escapeAttribute(viewUri(...segments));
    return fillTemplate(template, {
        CSP: escapeAttribute(buildCsp(cspSource, nonce)),
        NONCE: nonce,
        THEME_CSS: uri('theme.css'),
        SCRIPTS: SCRIPTS.map(segments => `    <script nonce="${nonce}" src="${uri(...segments)}"></script>`).join('\n'),
    });
}

module.exports = { SCRIPTS, getNonce, escapeAttribute, buildCsp, fillTemplate, buildPage };

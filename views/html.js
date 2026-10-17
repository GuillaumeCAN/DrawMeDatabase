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

// JSON for a <script type="application/json"> element: with '<' escaped, the data can never
// close the element ('</script>') or open a comment ('<!--'). Read back with JSON.parse.
function serializeData(data) {
    return JSON.stringify(data === undefined ? null : data)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

function escapeAttribute(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Mermaid injects a <style> element into its SVG, hence 'unsafe-inline' for styles only
function buildCsp(cspSource, nonce) {
    return [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src ${cspSource} 'unsafe-inline'`,
        `img-src ${cspSource} data:`,
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

// Fills a viewer template (views/<viewer>/template.html). viewUri(...segments) returns the
// webview URI of a file of views/, data is the list of tables.
function buildPage(template, { viewer, cspSource, viewUri, data }) {
    const nonce = getNonce();
    const uri = (...segments) => escapeAttribute(viewUri(...segments));
    return fillTemplate(template, {
        CSP: escapeAttribute(buildCsp(cspSource, nonce)),
        NONCE: nonce,
        THEME_CSS: uri('theme.css'),
        MERMAID_JS: uri('vendor', 'mermaid.min.js'),
        GENERATOR_JS: uri('mermaid', 'generator.js'),
        COMMON_JS: uri('common.js'),
        VIEWER_JS: uri(viewer, `${viewer}.js`),
        DATA: serializeData(data),
    });
}

module.exports = { getNonce, serializeData, escapeAttribute, buildCsp, fillTemplate, buildPage };

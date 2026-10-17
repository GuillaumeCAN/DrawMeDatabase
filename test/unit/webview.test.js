//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = require('../../views/html');

const VIEWS = path.join(__dirname, '..', '..', 'views');

// Values that broke the 1.1.1 templating ('$' patterns) or escaped the data <script>
const NASTY = "price in $, $& $' $` $$ </script><script>document.title='pwned'</script> <!-- \u2028\u2029 {{NONCE}}";
const TABLES = [{
    table: 'posts',
    columns: [{ name: 'body', type: NASTY }],
    relations: [{ foreignKey: 'user_id', references: 'id', on: 'users', type: 'many-to-one' }],
}];

// Fills a real template the way extension.js does
function build(viewer, tables) {
    const template = fs.readFileSync(path.join(VIEWS, viewer, 'template.html'), 'utf8');
    const page = html.buildPage(template, {
        viewer,
        cspSource: 'https://*.vscode-cdn.net',
        viewUri: (...segments) => `https://file+.vscode-resource.vscode-cdn.net/ext/views/${segments.join('/')}`,
        data: tables,
    });
    // The nonce of the CSP, which every script element must carry
    const nonce = /&#39;nonce-([^&]+)&#39;/.exec(page)[1];
    return { page, nonce };
}

test('serializeData output cannot close or comment out its <script> element', () => {
    const json = html.serializeData(TABLES);
    assert.ok(!json.includes('<'));
    assert.ok(!json.includes('\u2028') && !json.includes('\u2029'));
    assert.deepEqual(JSON.parse(json), TABLES);
    assert.equal(html.serializeData(undefined), 'null');
});

test('fillTemplate keeps $ patterns and does not re-scan inserted values', () => {
    const out = html.fillTemplate('A {{DATA}} B {{NONCE}} C {{OTHER}}', { DATA: "$' $& {{NONCE}}", NONCE: 'n0' });
    assert.equal(out, "A $' $& {{NONCE}} B n0 C {{OTHER}}");
});

test('escapeAttribute escapes HTML attribute characters', () => {
    assert.equal(html.escapeAttribute(`a&b"c'd<e>f`), 'a&amp;b&quot;c&#39;d&lt;e&gt;f');
});

test('buildCsp is strict with a nonce', () => {
    assert.equal(html.buildCsp('https://*.vscode-cdn.net', 'abc'), [
        "default-src 'none'",
        "script-src 'nonce-abc'",
        "style-src https://*.vscode-cdn.net 'unsafe-inline'",
        'img-src https://*.vscode-cdn.net data:',
        'font-src https://*.vscode-cdn.net',
    ].join('; '));
    assert.notEqual(html.getNonce(), html.getNonce());
    assert.match(html.getNonce(), /^[A-Za-z0-9+/=]{16,}$/);
});

for (const viewer of ['mermaid', 'json']) {
    test(`${viewer} template: data round-trips, no inline script or handler`, () => {
        const { page, nonce } = build(viewer, TABLES);

        assert.ok(!build(viewer, []).page.includes('{{'), 'every placeholder is filled');
        assert.match(page, /<html lang="en">/);
        assert.match(page, /<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;nonce-/);
        assert.ok(!/\son[a-z]+\s*=/i.test(page), 'no inline event handler');
        assert.ok(!page.includes('fa-'), 'no Font Awesome class');
        assert.ok(page.includes('DrawMeDatabase - by Guillaume Cancalon ©'));

        // Every executable script is external and carries the nonce
        const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
        const executable = scripts.filter(([, attrs]) => !/type="application\/json"/.test(attrs));
        assert.ok(executable.length >= 2);
        for (const [, attrs, body] of executable) {
            assert.ok(attrs.includes(`nonce="${nonce}"`) && /src="https:/.test(attrs), attrs);
            assert.equal(body.trim(), '');
        }

        // The data element is intact and parses back to the tables
        const data = scripts.filter(([, attrs]) => /id="dmdb-data"/.test(attrs));
        assert.equal(data.length, 1);
        assert.deepEqual(JSON.parse(data[0][2]), TABLES);
    });
}

test('the mermaid template loads Mermaid before the viewer scripts', () => {
    const { page } = build('mermaid', []);
    const order = ['vendor/mermaid.min.js', 'mermaid/generator.js', 'common.js', 'mermaid/mermaid.js'].map(file => page.indexOf(file));
    assert.ok(order.every(index => index > 0));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
});

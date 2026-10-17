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

// Values that broke the 1.1.1 templating ('$' patterns)
const NASTY = "price in $, $& $' $` $$ </script><script>document.title='pwned'</script> {{NONCE}}";

// Fills the real template the way extension.js does
function build(cspSource = 'https://*.vscode-cdn.net') {
    const template = fs.readFileSync(path.join(VIEWS, 'index.html'), 'utf8');
    const page = html.buildPage(template, {
        cspSource,
        viewUri: (...segments) => `https://file+.vscode-resource.vscode-cdn.net/ext/views/${segments.join('/')}`,
    });
    // The nonce of the CSP, which every script element must carry
    const nonce = /&#39;nonce-([^&]+)&#39;/.exec(page)[1];
    return { page, nonce };
}

test('fillTemplate keeps $ patterns and does not re-scan inserted values', () => {
    const out = html.fillTemplate('A {{DATA}} B {{NONCE}} C {{OTHER}}', { DATA: NASTY, NONCE: 'n0' });
    assert.equal(out, `A ${NASTY} B n0 C {{OTHER}}`);
});

test('escapeAttribute escapes HTML attribute characters', () => {
    assert.equal(html.escapeAttribute(`a&b"c'd<e>f`), 'a&amp;b&quot;c&#39;d&lt;e&gt;f');
});

test('buildCsp is strict with a nonce', () => {
    assert.equal(html.buildCsp('https://*.vscode-cdn.net', 'abc'), [
        "default-src 'none'",
        "script-src 'nonce-abc'",
        "style-src https://*.vscode-cdn.net 'unsafe-inline'",
        'img-src https://*.vscode-cdn.net data: blob:',
        'font-src https://*.vscode-cdn.net',
    ].join('; '));
    assert.notEqual(html.getNonce(), html.getNonce());
    assert.match(html.getNonce(), /^[A-Za-z0-9+/=]{16,}$/);
});

test('the page: every placeholder filled, strict CSP, no inline script or handler', () => {
    const { page, nonce } = build();

    assert.ok(!page.includes('{{'), 'every placeholder is filled');
    assert.match(page, /<html lang="en">/);
    assert.match(page, /<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;nonce-/);
    assert.ok(!/\son[a-z]+\s*=/i.test(page), 'no inline event handler');
    assert.ok(!page.includes('fa-'), 'no Font Awesome class');
    assert.ok(page.includes('DrawMeDatabase - by Guillaume Cancalon ©'));
    assert.ok(!page.includes('dmdb-data'), 'the schema is posted, not embedded');

    // Every script is external and carries the nonce
    const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, html.SCRIPTS.length);
    for (const [, attrs, body] of scripts) {
        assert.ok(attrs.includes(`nonce="${nonce}"`) && /src="https:/.test(attrs), attrs);
        assert.equal(body.trim(), '');
    }
});

test('the page loads Mermaid, then the helpers, then the viewers, then app.js', () => {
    const { page } = build();
    const order = ['vendor/mermaid.min.js', 'mermaid/generator.js', 'mermaid/zoom.js', 'exporters.js', 'mermaid/diagram.js', 'json/json.js', 'app.js']
        .map(file => page.indexOf(`/views/${file}"`));
    assert.ok(order.every(index => index > 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('every script of the page exists (Mermaid once installed)', () => {
    for (const segments of html.SCRIPTS) {
        if (segments[0] === 'vendor') {
            continue;
        }
        assert.ok(fs.existsSync(path.join(VIEWS, ...segments)), segments.join('/'));
    }
});

test('the toolbar controls used by app.js are in the page', () => {
    const { page } = build();
    const app = fs.readFileSync(path.join(VIEWS, 'app.js'), 'utf8');
    const ids = [...app.matchAll(/\$\('([a-z-]+)'\)/g)].map(match => match[1]);
    assert.ok(ids.length > 10);
    for (const id of ids) {
        assert.ok(page.includes(`id="${id}"`), id);
    }
});

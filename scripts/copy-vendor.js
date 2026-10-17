//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Copies the pinned Mermaid build from node_modules into views/vendor/ (loaded by the webview).
// Runs on 'postinstall' (lenient) and 'vscode:prepublish' (--strict: fails if Mermaid is missing
// or not the version pinned in package.json, so a .vsix is never built without it).

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const strict = process.argv.includes('--strict');
const mermaidDir = path.join(root, 'node_modules', 'mermaid');
const source = path.join(mermaidDir, 'dist', 'mermaid.min.js');
const targetDir = path.join(root, 'views', 'vendor');

function fail(message) {
    if (strict) {
        console.error(`copy-vendor: ${message}`);
        process.exit(1);
    }
    console.warn(`copy-vendor: ${message} (skipped)`);
    process.exit(0);
}

if (!fs.existsSync(source)) {
    fail(`${path.relative(root, source)} not found, run "npm install" first`);
}

const expected = require(path.join(root, 'package.json')).devDependencies.mermaid;
const installed = require(path.join(mermaidDir, 'package.json'));
if (installed.version !== expected) {
    fail(`mermaid ${installed.version} is installed but package.json pins ${expected}`);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, path.join(targetDir, 'mermaid.min.js'));

// The npm package has no LICENSE file: ship a notice next to the bundled file
const notice = [
    `mermaid.min.js is Mermaid ${installed.version} (${installed.repository.url}),`,
    `Copyright (c) ${installed.author} and the Mermaid contributors, released under the ${installed.license} license:`,
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and',
    'associated documentation files (the "Software"), to deal in the Software without restriction,',
    'including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,',
    'and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,',
    'subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all copies or substantial',
    'portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT',
    'LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN',
    'NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,',
    'WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE',
    'SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
    '',
    'Third-party code bundled inside mermaid.min.js keeps its own @license headers.',
    '',
].join('\n');
fs.writeFileSync(path.join(targetDir, 'mermaid.LICENSE.txt'), notice);

console.log(`copy-vendor: mermaid ${installed.version} copied to views/vendor/`);

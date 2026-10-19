//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// JSON viewer: the parsed tables, colored like code (DOM text nodes only, never parsed as HTML)
(function () {
    'use strict';

    // Strings (keys when followed by ':'), numbers, true / false / null, punctuation
    const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g;

    function create(output) {
        let text = '';

        function append(content, className) {
            if (!className) {
                output.appendChild(document.createTextNode(content));
                return;
            }
            const span = document.createElement('span');
            span.className = className;
            span.textContent = content;
            output.appendChild(span);
        }

        return {
            render(tables) {
                text = window.DrawMeDatabaseExport.jsonFile(tables);
                output.textContent = '';
                let index = 0;
                for (const match of text.matchAll(TOKEN)) {
                    append(text.slice(index, match.index));
                    const [, string, colon, number, literal, punctuation] = match;
                    if (string) {
                        append(string, colon ? 'json-key' : 'json-string');
                        if (colon) {
                            append(colon, 'json-punctuation');
                        }
                    } else if (number) {
                        append(number, 'json-number');
                    } else if (literal) {
                        append(literal, 'json-literal');
                    } else {
                        append(punctuation, 'json-punctuation');
                    }
                    index = match.index + match[0].length;
                }
                append(text.slice(index));
            },
            get text() {
                return text;
            },
        };
    }

    window.DrawMeDatabaseJson = { create };
})();

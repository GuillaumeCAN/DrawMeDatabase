//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Mermaid viewer: renders the diagram built by generator.js with the bundled Mermaid library
(function () {
    'use strict';

    const container = document.getElementById('mermaid-diagram');
    const app = window.DrawMeDatabase;

    // Readable error, with optional details in a <pre> (text only, never parsed as HTML)
    function showError(message, details, source) {
        container.textContent = '';
        const paragraph = document.createElement('p');
        paragraph.className = 'error';
        paragraph.textContent = message;
        container.appendChild(paragraph);
        if (details) {
            const pre = document.createElement('pre');
            pre.textContent = details;
            container.appendChild(pre);
        }
        if (source) {
            const label = document.createElement('p');
            label.textContent = 'Generated Mermaid source:';
            container.appendChild(label);
            const pre = document.createElement('pre');
            pre.textContent = source;
            container.appendChild(pre);
        }
    }

    const errorText = (err) => (err && err.message ? err.message : String(err));

    if (!container) {
        return;
    }
    if (!app || app.error) {
        showError('Unable to read the schema data.', app && app.error ? errorText(app.error) : '');
        return;
    }
    if (typeof mermaid === 'undefined' || !window.DrawMeDatabaseMermaid) {
        showError('The Mermaid library could not be loaded.');
        return;
    }

    const source = window.DrawMeDatabaseMermaid.generateMermaidER(app.data);

    // Mermaid theme from the VS Code theme kind (class set by VS Code on <body>)
    function mermaidTheme() {
        const classes = document.body.classList;
        return classes.contains('vscode-light') || classes.contains('vscode-high-contrast-light') ? 'default' : 'dark';
    }

    let renderedTheme = null;

    async function render() {
        const theme = mermaidTheme();
        renderedTheme = theme;
        // Natural size (readable text), the container scrolls when the diagram is bigger.
        // maxTextSize: the default (50 000 characters) is reached by schemas of about 150 tables.
        mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme,
            maxTextSize: 1000000,
            er: { useMaxWidth: false },
        });

        try {
            await mermaid.parse(source);
        } catch (err) {
            showError('Mermaid could not read the generated diagram.', errorText(err), source);
            return;
        }

        try {
            // Rendered inside the container so the page styles apply while Mermaid measures the text
            const { svg, bindFunctions } = await mermaid.render('dmdb-svg', source, container);
            container.innerHTML = svg;
            if (bindFunctions) {
                bindFunctions(container);
            }
        } catch (err) {
            showError('Mermaid could not draw the diagram.', errorText(err), source);
        }
    }

    // One render at a time (initialize() changes the global Mermaid configuration)
    let queue = Promise.resolve();
    const scheduleRender = () => {
        queue = queue.then(render);
    };

    // Draw again when the user switches between a light and a dark theme
    new MutationObserver(() => {
        if (mermaidTheme() !== renderedTheme) {
            scheduleRender();
        }
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

    scheduleRender();
})();

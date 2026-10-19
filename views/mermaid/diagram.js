//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Diagram viewer: draws the tables with the bundled Mermaid library, in the colors of the
// VS Code theme, inside the zoomable stage. Also exports the drawing as SVG or PNG.
(function () {
    'use strict';

    const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Ubuntu, Roboto, "Helvetica Neue", Arial, sans-serif';
    // Largest PNG export, in pixels (browsers refuse bigger canvases)
    const MAX_PNG_SIDE = 16384;
    const MAX_PNG_AREA = 120e6;

    const errorText = (err) => (err && err.message ? err.message : String(err));

    function themeKind() {
        const classes = document.body.classList;
        if (classes.contains('vscode-high-contrast-light')) {
            return 'hc-light';
        }
        if (classes.contains('vscode-high-contrast')) {
            return 'hc-dark';
        }
        return classes.contains('vscode-light') ? 'light' : 'dark';
    }

    // The first VS Code color variable that is set, else the fallback
    function color(names, fallback) {
        const style = getComputedStyle(document.body);
        for (const name of names) {
            const value = style.getPropertyValue(name).trim();
            if (value) {
                return value;
            }
        }
        return fallback;
    }

    // Mermaid's "base" theme filled with the colors of the current VS Code theme
    function mermaidTheme() {
        const kind = themeKind();
        const dark = kind === 'dark' || kind === 'hc-dark';
        const contrast = kind === 'hc-dark' || kind === 'hc-light';
        const background = color(['--vscode-editor-background'], dark ? '#1f1f1f' : '#ffffff');
        const foreground = color(['--vscode-editor-foreground', '--vscode-foreground'], dark ? '#cccccc' : '#3b3b3b');
        const border = contrast
            ? color(['--vscode-contrastBorder', '--vscode-focusBorder'], foreground)
            : color(['--vscode-editorWidget-border', '--vscode-widget-border', '--vscode-panel-border'], dark ? '#454545' : '#c8c8c8');
        const header = color(['--vscode-editorWidget-background', '--vscode-sideBar-background'], dark ? '#252526' : '#f3f3f3');
        const line = contrast ? foreground : color(['--vscode-descriptionForeground', '--vscode-editorLineNumber-foreground'], dark ? '#9d9d9d' : '#717171');
        const stripe = contrast ? background : color(['--vscode-list-hoverBackground', '--vscode-editor-lineHighlightBackground'], dark ? '#2a2d2e' : '#f0f0f0');
        return {
            theme: 'base',
            darkMode: dark,
            themeVariables: {
                fontFamily: FONT_FAMILY,
                fontSize: '13px',
                background,
                primaryColor: header,
                primaryTextColor: foreground,
                primaryBorderColor: border,
                secondaryColor: header,
                tertiaryColor: background,
                mainBkg: header,
                nodeBorder: border,
                lineColor: line,
                textColor: foreground,
                nodeTextColor: foreground,
                edgeLabelBackground: background,
                // Attribute rows of the tables
                rowOdd: background,
                rowEven: stripe,
            },
            background,
        };
    }

    function create({ viewport, stage, message, onViewChange, onRendered }) {
        const zoom = window.DrawMeDatabaseZoom.attach(viewport, stage, onViewChange);
        let renders = 0;
        let queue = Promise.resolve();
        let last = null;
        let size = null;
        let background = '#ffffff';

        const report = (result) => {
            if (onRendered) {
                onRendered(result);
            }
        };

        function showMessage(title, details, source) {
            message.textContent = '';
            const heading = document.createElement('p');
            heading.className = 'message-title';
            heading.textContent = title;
            message.appendChild(heading);
            for (const [label, text] of [['', details], ['Generated Mermaid source:', source]]) {
                if (!text) {
                    continue;
                }
                if (label) {
                    const caption = document.createElement('p');
                    caption.textContent = label;
                    message.appendChild(caption);
                }
                const pre = document.createElement('pre');
                pre.textContent = text;
                message.appendChild(pre);
            }
            message.hidden = false;
        }

        function hideMessage() {
            message.hidden = true;
            message.textContent = '';
        }

        // view: a saved view to restore, 'keep' (same place) or 'fit' (the whole diagram)
        async function draw({ tables, settings, view }) {
            const mermaid = window.mermaid;
            if (!mermaid || !window.DrawMeDatabaseMermaid) {
                showMessage('The Mermaid library could not be loaded.');
                report({ ok: false, error: 'The Mermaid library could not be loaded.' });
                return;
            }
            const started = performance.now();
            const { source } = window.DrawMeDatabaseMermaid.buildDiagram(tables, {
                direction: settings.direction,
                highlight: settings.highlight,
            });
            const theme = mermaidTheme();
            background = theme.background;
            // Natural size: the stage zooms. htmlLabels off: plain SVG text, so the export opens
            // in any SVG editor and can be drawn on a canvas (PNG). maxTextSize: the default
            // (50 000 characters) is reached by schemas of about 150 tables.
            mermaid.initialize({
                startOnLoad: false,
                securityLevel: 'strict',
                theme: theme.theme,
                darkMode: theme.darkMode,
                themeVariables: theme.themeVariables,
                look: 'classic',
                layout: settings.layout === 'elk' ? 'elk' : 'dagre',
                htmlLabels: false,
                fontFamily: FONT_FAMILY,
                maxTextSize: 5000000,
                er: { useMaxWidth: false, htmlLabels: false },
            });

            try {
                await mermaid.parse(source);
            } catch (err) {
                showMessage('Mermaid could not read the generated diagram.', errorText(err), source);
                report({ ok: false, error: `Mermaid could not read the generated diagram: ${errorText(err)}` });
                return;
            }

            // Rendered in an off-screen element of the page, so the fonts apply while Mermaid
            // measures the text
            const sandbox = document.createElement('div');
            sandbox.className = 'render-sandbox';
            document.body.appendChild(sandbox);
            let svg;
            try {
                ({ svg } = await mermaid.render(`dmdb-svg-${++renders}`, source, sandbox));
            } catch (err) {
                showMessage('Mermaid could not draw the diagram.', errorText(err), source);
                report({ ok: false, error: `Mermaid could not draw the diagram: ${errorText(err)}` });
                return;
            } finally {
                sandbox.remove();
            }

            stage.innerHTML = svg;
            const element = stage.querySelector('svg');
            const box = element.viewBox && element.viewBox.baseVal;
            size = box && box.width > 0
                ? { width: box.width, height: box.height }
                : { width: element.getBBox().width, height: element.getBBox().height };
            element.setAttribute('width', String(size.width));
            element.setAttribute('height', String(size.height));
            element.style.maxWidth = 'none';
            hideMessage();
            last = { tables, settings };
            zoom.setContent(size, view === 'keep' ? zoom.view : view === 'fit' ? null : view);
            report({
                ok: true,
                layout: settings.layout,
                entities: element.querySelectorAll('g.node').length,
                ms: Math.round(performance.now() - started),
            });
        }

        // The SVG as a standalone file, on the background of the theme it was drawn with
        function exportSvg() {
            const element = stage.querySelector('svg');
            if (!element || !size) {
                return null;
            }
            const clone = element.cloneNode(true);
            clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            clone.removeAttribute('style');
            const box = element.viewBox.baseVal;
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', String(box.x));
            rect.setAttribute('y', String(box.y));
            rect.setAttribute('width', String(box.width));
            rect.setAttribute('height', String(box.height));
            rect.setAttribute('fill', background);
            clone.insertBefore(rect, clone.firstChild);
            return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
        }

        // The drawing as a PNG (base64), twice the screen size when the canvas allows it
        async function exportPng() {
            const svg = exportSvg();
            if (!svg) {
                return null;
            }
            const scale = Math.min(2, MAX_PNG_SIDE / size.width, MAX_PNG_SIDE / size.height, Math.sqrt(MAX_PNG_AREA / (size.width * size.height)));
            const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
            try {
                const image = new Image();
                image.src = url;
                await image.decode();
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(size.width * scale));
                canvas.height = Math.max(1, Math.round(size.height * scale));
                canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
                return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
            } finally {
                URL.revokeObjectURL(url);
            }
        }

        return {
            // One render at a time (initialize() changes the global Mermaid configuration)
            render(tables, settings, view) {
                queue = queue.then(() => draw({ tables, settings, view })).catch(err => {
                    showMessage('The diagram could not be drawn.', errorText(err));
                    report({ ok: false, error: `The diagram could not be drawn: ${errorText(err)}` });
                });
                return queue;
            },
            // Draws the last diagram again, for example in the colors of a new theme
            redraw() {
                return last ? this.render(last.tables, last.settings, 'keep') : queue;
            },
            showMessage,
            hideMessage,
            exportSvg,
            exportPng,
            zoom,
        };
    }

    window.DrawMeDatabaseDiagram = { create, mermaidTheme };
})();

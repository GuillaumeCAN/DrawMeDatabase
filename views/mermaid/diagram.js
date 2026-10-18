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

    // Largest PNG export, in pixels (browsers refuse bigger canvases)
    const MAX_PNG_SIDE = 16384;
    const MAX_PNG_AREA = 120e6;

    const errorText = (err) => (err && err.message ? err.message : String(err));

    // Mermaid's "base" theme in the colors and the font of the page: the VS Code theme, or the
    // theme, palette, colors and font chosen in the settings (appearance.js)
    function mermaidTheme() {
        const appearance = window.DrawMeDatabaseAppearance;
        const palette = appearance.colors();
        const font = appearance.font();
        return {
            theme: 'base',
            darkMode: palette.dark,
            themeVariables: {
                fontFamily: font.family,
                fontSize: `${font.size}px`,
                background: palette.background,
                primaryColor: palette.header,
                primaryTextColor: palette.text,
                primaryBorderColor: palette.border,
                secondaryColor: palette.header,
                tertiaryColor: palette.background,
                mainBkg: palette.header,
                nodeBorder: palette.border,
                lineColor: palette.line,
                textColor: palette.text,
                nodeTextColor: palette.text,
                edgeLabelBackground: palette.background,
                // Attribute rows of the tables
                rowOdd: palette.background,
                rowEven: palette.stripe,
            },
            background: palette.background,
            fontFamily: font.family,
        };
    }

    // t: the texts of the page (i18n.js), English when it is not given
    // onSelectTable(table): a click selects a table (double-click or Ctrl+click opens its file);
    // without it, a click opens the file
    function create({ viewport, stage, message, onViewChange, onRendered, onOpenTable, onSelectTable, t }) {
        const tr = t || window.DrawMeDatabaseI18n.translator('en');
        const zoom = window.DrawMeDatabaseZoom.attach(viewport, stage, onViewChange);
        let renders = 0;
        let queue = Promise.resolve();
        let drawing = false;
        let last = null;
        let size = null;
        let background = '#ffffff';
        // Table of each drawn entity, by the id Mermaid gives its node ('dmdb-svg-3-entity-users-0')
        let tablesByNode = new Map();
        // What the stage shows, to skip drawing it again
        let lastKey = '';
        // The selected table, outlined
        let selectedTable = null;

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
            for (const [label, content] of [['', details], [tr('diagram.source'), source]]) {
                if (!content) {
                    continue;
                }
                if (label) {
                    const caption = document.createElement('p');
                    caption.textContent = label;
                    message.appendChild(caption);
                }
                const pre = document.createElement('pre');
                pre.textContent = content;
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
                showMessage(tr('diagram.noMermaid'));
                report({ ok: false, error: 'The Mermaid library could not be loaded.' });
                return;
            }
            const started = performance.now();
            const { source, entities } = window.DrawMeDatabaseMermaid.buildDiagram(tables, {
                direction: settings.direction,
                highlight: settings.highlight,
                git: settings.git,
                marks: settings.marks,
                keysOnly: settings.keysOnly,
                relationLabels: settings.relationLabels,
                gitLabels: gitLabels(),
            });
            const theme = mermaidTheme();
            background = theme.background;
            // Same drawing (an edit that changes no table, a refresh without change): nothing to do
            const key = JSON.stringify([source, settings.layout, theme.themeVariables]);
            if (key === lastKey && stage.querySelector('svg')) {
                last = { tables, settings };
                hideMessage();
                if (view !== 'keep' && view !== null) {
                    zoom.setContent(size, view === 'fit' ? null : view);
                }
                return;
            }
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
                fontFamily: theme.fontFamily,
                maxTextSize: 5000000,
                er: { useMaxWidth: false, htmlLabels: false },
            });

            try {
                await mermaid.parse(source);
            } catch (err) {
                showMessage(tr('diagram.parseError'), errorText(err), source);
                report({ ok: false, error: `Mermaid could not read the generated diagram: ${errorText(err)}` });
                return;
            }

            // Rendered in an off-screen element of the page, so the fonts apply while Mermaid
            // measures the text
            const sandbox = document.createElement('div');
            sandbox.className = 'render-sandbox';
            document.body.appendChild(sandbox);
            let svg;
            const svgId = `dmdb-svg-${++renders}`;
            try {
                ({ svg } = await mermaid.render(svgId, source, sandbox));
            } catch (err) {
                showMessage(tr('diagram.renderError'), errorText(err), source);
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
            markOpenableTables(element, svgId, entities, tables);
            markGitLabels(element);
            lastKey = key;
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

        // Entity nodes of tables with a source file (every declared table with onSelectTable):
        // pointer cursor, tooltip, click. Mermaid names each node '<svg id>-entity-<entity id>-<n>'
        // (pinned by mermaid.test.js).
        function markOpenableTables(element, svgId, entities, tables) {
            const byId = new Map(entities.filter(entity => entity.declared !== false).map(entity => [entity.id, entity.table]));
            const sources = new Map(tables
                .filter(table => table && table.source && typeof table.source.file === 'string')
                .map(table => [String(table.table), table.source]));
            tablesByNode = new Map();
            const prefix = `${svgId}-entity-`;
            element.querySelectorAll('g.node[id]').forEach(node => {
                if (!node.id.startsWith(prefix)) {
                    return;
                }
                const table = byId.get(node.id.slice(prefix.length).replace(/-\d+$/, ''));
                const source = table === undefined ? undefined : sources.get(table);
                if (table === undefined || (!source && !onSelectTable)) {
                    return;
                }
                tablesByNode.set(node.id, table);
                node.classList.add('openable');
                node.classList.toggle('selected', table === selectedTable);
                const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
                const where = source ? `\n${source.file}:${source.line}` : '';
                title.textContent = `${table}${where}\n${tr(onSelectTable ? 'diagram.selectTable' : 'diagram.openTable')}`;
                node.insertBefore(title, node.firstChild);
            });
        }

        // The git status words of the columns, in the language of the page
        const gitLabels = () => ({ untracked: tr('git.label.untracked'), modified: tr('git.label.modified'), unsaved: tr('git.label.unsaved') });

        // Comments of uncommitted columns ('● new'...), colored like the git decorations of VS Code
        function markGitLabels(element) {
            const words = gitLabels();
            const labels = new Map(['untracked', 'modified', 'unsaved'].map(status => [window.DrawMeDatabaseMermaid.gitLabel(status, words), status]));
            element.querySelectorAll('text').forEach(text => {
                const status = labels.get(text.textContent.trim());
                if (status) {
                    text.classList.add('git-label', `git-${status}`);
                }
            });
        }

        const tableAt = (event) => {
            const node = event.target.closest && event.target.closest('g.node.openable');
            return node && tablesByNode.has(node.id) ? tablesByNode.get(node.id) : undefined;
        };
        stage.addEventListener('click', event => {
            const table = tableAt(event);
            if (table === undefined) {
                return;
            }
            if (onSelectTable && !event.ctrlKey && !event.metaKey) {
                onSelectTable(table);
            } else if (onOpenTable) {
                onOpenTable(table);
            }
        });
        stage.addEventListener('dblclick', event => {
            const table = tableAt(event);
            if (table !== undefined && onSelectTable && onOpenTable) {
                onOpenTable(table);
            }
        });

        // The node of a table on the stage, or null
        function nodeOf(table) {
            for (const [id, name] of tablesByNode) {
                if (name === table) {
                    return stage.querySelector(`[id="${CSS.escape(id)}"]`);
                }
            }
            return null;
        }

        // Outlines a table (null: none)
        function select(table) {
            selectedTable = table;
            stage.querySelectorAll('g.node.selected').forEach(node => node.classList.remove('selected'));
            const node = table === null ? null : nodeOf(table);
            if (node) {
                node.classList.add('selected');
            }
        }

        // Moves the view so that a table is in the middle, at the current zoom (at least 60 %);
        // left, right: the widths hidden on each side (panels over the viewport)
        function centerOn(table, { left = 0, right = 0 } = {}) {
            const node = nodeOf(table);
            const element = stage.querySelector('svg');
            if (!node || !element || !size) {
                return;
            }
            // Its center in the coordinates of the drawing (the nodes are placed by transforms)
            const box = node.getBoundingClientRect();
            const drawing = element.getBoundingClientRect();
            const current = zoom.view.scale;
            const scale = Math.max(current, 0.6);
            const x = ((box.left + box.width / 2 - drawing.left) / current) * scale;
            const y = ((box.top + box.height / 2 - drawing.top) / current) * scale;
            zoom.setContent(size, { scale, x: left + Math.max(0, viewport.clientWidth - left - right) / 2 - x, y: viewport.clientHeight / 2 - y });
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
            clone.querySelectorAll('g.node > title').forEach(title => title.remove());
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

        // One drawing at a time (initialize() changes the global Mermaid configuration), and only the
        // last one asked for: while a large schema is drawn, live edits replace each other
        let pending = null;
        async function run() {
            drawing = true;
            while (pending) {
                const job = pending;
                pending = null;
                try {
                    await draw(job);
                } catch (err) {
                    showMessage(tr('diagram.drawError'), errorText(err));
                    report({ ok: false, error: `The diagram could not be drawn: ${errorText(err)}` });
                }
            }
            drawing = false;
        }

        return {
            render(tables, settings, view) {
                // A replaced 'fit' or saved view still applies
                const replacedView = pending && pending.view !== 'keep' ? pending.view : null;
                pending = { tables, settings, view: view === 'keep' && replacedView ? replacedView : view };
                if (!drawing) {
                    queue = run();
                }
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
            select,
            centerOn,
            zoom,
        };
    }

    window.DrawMeDatabaseDiagram = { create, mermaidTheme };
})();

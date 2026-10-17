//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// The page: loaded once, it receives the schema and the settings from the extension
// (postMessage), switches between the viewers without reloading, and keeps its state (viewer,
// zoom) with vscode.setState so it comes back the same after a reload of the window.
(function () {
    'use strict';

    // acquireVsCodeApi() may only be called once per page
    const vscode = acquireVsCodeApi();
    const Export = window.DrawMeDatabaseExport;

    const saved = vscode.getState() || {};
    const state = {
        viewer: saved.viewer === 'json' ? 'json' : 'diagram',
        view: saved.view || null,
        // The workspace folder of the schema, drawn again when VS Code restores the panel
        folder: typeof saved.folder === 'string' ? saved.folder : null,
        query: typeof saved.query === 'string' ? saved.query : '',
    };

    let schema = null;
    let settings = { layout: 'dagre', direction: 'TB' };
    let drawn = false;

    const $ = (id) => document.getElementById(id);
    const elements = {
        progress: $('progress'),
        summary: $('summary'),
        layout: $('layout-select'),
        direction: $('direction-button'),
        zoomLevel: $('zoom-level'),
        exportButton: $('export-button'),
        exportMenu: $('export-menu'),
        toast: $('toast'),
        diagramView: $('diagram-view'),
        jsonView: $('json-view'),
        search: $('search'),
        searchCount: $('search-count'),
    };

    let saveTimer;
    const persist = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => vscode.setState(state), 200);
    };

    const diagram = window.DrawMeDatabaseDiagram.create({
        viewport: $('viewport'),
        stage: $('stage'),
        message: $('message'),
        onViewChange(view) {
            elements.zoomLevel.textContent = `${Math.round(view.scale * 100)}%`;
            state.view = view;
            persist();
        },
        // Errors go to the DrawMeDatabase output; the integration test checks the drawing
        onRendered(result) {
            vscode.postMessage({ type: 'rendered', ...result });
        },
        onOpenTable(table) {
            vscode.postMessage({ type: 'open', table });
        },
    });
    const json = window.DrawMeDatabaseJson.create($('json-output'));

    let toastTimer;
    function toast(text) {
        elements.toast.textContent = text;
        elements.toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 3000);
    }

    function setBusy(busy) {
        elements.progress.hidden = !busy;
    }

    // Viewers

    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));

    function showViewer(viewer, focus) {
        state.viewer = viewer;
        persist();
        tabs.forEach(tab => {
            const selected = tab.dataset.viewer === viewer;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
            if (selected && focus) {
                tab.focus();
            }
        });
        elements.diagramView.hidden = viewer !== 'diagram';
        elements.jsonView.hidden = viewer !== 'json';
        document.querySelectorAll('[data-viewer-only]').forEach(element => {
            element.hidden = element.dataset.viewerOnly !== viewer;
        });
    }

    tabs.forEach(tab => {
        tab.addEventListener('click', () => showViewer(tab.dataset.viewer));
        tab.addEventListener('keydown', event => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                const index = (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
                showViewer(tabs[index].dataset.viewer, true);
            }
        });
    });

    // Search: the matching tables and their neighbours (diagram), the matching tables (JSON)

    let filtered = null;

    function filterSchema() {
        filtered = window.DrawMeDatabaseSearch.filterTables(schema ? schema.tables : [], state.query);
        const count = filtered.matches.length;
        elements.searchCount.textContent = !state.query.trim() || !schema
            ? ''
            : count === 0 ? 'No match' : `${count} of ${schema.tables.length}`;
    }

    // The tables on screen: all of them, or the result of the search
    const shownTables = () => (filtered ? filtered.tables : schema ? schema.tables : []);
    const searching = () => Boolean(state.query.trim());

    function draw(view) {
        if (!schema) {
            return;
        }
        filterSchema();
        const matches = new Set(filtered.matches);
        json.render(searching() ? schema.tables.filter(table => matches.has(table.table)) : schema.tables);
        if (searching() && filtered.matches.length === 0) {
            diagram.showMessage(`No table or column matches "${state.query.trim()}".`);
            return;
        }
        diagram.render(shownTables(), { ...settings, highlight: searching() ? filtered.matches : null }, view);
        drawn = true;
    }

    let searchTimer;
    elements.search.value = state.query;
    elements.search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            state.query = elements.search.value;
            persist();
            draw('fit');
        }, 250);
    });
    elements.search.addEventListener('keydown', event => {
        if (event.key === 'Escape' && elements.search.value) {
            event.stopPropagation();
            elements.search.value = '';
            elements.search.dispatchEvent(new Event('input'));
        }
    });
    document.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
            event.preventDefault();
            elements.search.focus();
            elements.search.select();
        }
    });

    // Toolbar

    function showSettings() {
        elements.layout.value = settings.layout;
        const leftToRight = settings.direction === 'LR';
        const label = leftToRight ? 'Direction: left to right' : 'Direction: top to bottom';
        elements.direction.title = label;
        elements.direction.setAttribute('aria-label', label);
        elements.direction.classList.toggle('left-to-right', leftToRight);
    }

    elements.layout.addEventListener('change', () => {
        vscode.postMessage({ type: 'setting', key: 'layout', value: elements.layout.value });
    });
    elements.direction.addEventListener('click', () => {
        vscode.postMessage({ type: 'setting', key: 'direction', value: settings.direction === 'LR' ? 'TB' : 'LR' });
    });
    $('zoom-in').addEventListener('click', () => diagram.zoom.zoomIn());
    $('zoom-out').addEventListener('click', () => diagram.zoom.zoomOut());
    $('zoom-fit').addEventListener('click', () => diagram.zoom.fit());
    elements.zoomLevel.addEventListener('click', () => diagram.zoom.actualSize());
    $('refresh-button').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

    function showSummary() {
        elements.summary.textContent = '';
        if (!schema) {
            return;
        }
        const count = schema.tables.length;
        const parts = [schema.project.frameworkLabel, schema.project.name, `${count} ${count === 1 ? 'table' : 'tables'}`].filter(Boolean);
        const text = document.createElement('span');
        text.textContent = parts.join(' · ');
        elements.summary.appendChild(text);
        if (schema.warnings > 0) {
            const link = document.createElement('button');
            link.type = 'button';
            link.className = 'link';
            link.textContent = `${schema.warnings} ${schema.warnings === 1 ? 'warning' : 'warnings'}`;
            link.title = 'Show the details in the DrawMeDatabase output';
            link.addEventListener('click', () => vscode.postMessage({ type: 'showOutput' }));
            elements.summary.appendChild(link);
        }
    }

    // Export menu

    // What is on screen: the search result when there is one
    const diagramSource = () => window.DrawMeDatabaseMermaid.generateMermaidER(shownTables(), { direction: settings.direction });

    const EXPORTS = {
        diagram: [
            { label: 'Save as SVG…', run: () => save('svg', diagram.exportSvg()) },
            { label: 'Save as PNG…', run: async () => save('png', await diagram.exportPng()) },
            { label: 'Save as Mermaid (.mmd)…', run: () => save('mmd', Export.mermaidFile(diagramSource(), { project: schema.project, layout: settings.layout })) },
            { label: 'Save as Markdown…', run: () => save('md', Export.markdownFile(diagramSource(), { project: schema.project, layout: settings.layout })) },
            { label: 'Copy Mermaid source', run: () => copy('mmd', Export.mermaidFile(diagramSource(), { project: schema.project, layout: settings.layout })) },
        ],
        json: [
            { label: 'Save as JSON…', run: () => save('json', json.text) },
            { label: 'Copy JSON', run: () => copy('json', json.text) },
        ],
    };

    function save(format, content) {
        if (!content) {
            toast('Nothing to export yet.');
            return;
        }
        vscode.postMessage({ type: 'save', format, content, fileName: Export.fileName(schema.project, format) });
    }

    function copy(format, content) {
        vscode.postMessage({ type: 'copy', format, content });
    }

    function openMenu() {
        const menu = elements.exportMenu;
        menu.textContent = '';
        (EXPORTS[state.viewer] || []).forEach(item => {
            const button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('role', 'menuitem');
            button.tabIndex = -1;
            button.textContent = item.label;
            button.disabled = !schema;
            button.addEventListener('click', async () => {
                closeMenu(true);
                try {
                    await item.run();
                } catch (err) {
                    toast(`Export failed: ${err && err.message ? err.message : err}`);
                }
            });
            menu.appendChild(button);
        });
        menu.hidden = false;
        elements.exportButton.setAttribute('aria-expanded', 'true');
        const first = menu.querySelector('button:not(:disabled)');
        if (first) {
            first.focus();
        }
    }

    function closeMenu(focusButton) {
        if (elements.exportMenu.hidden) {
            return;
        }
        elements.exportMenu.hidden = true;
        elements.exportButton.setAttribute('aria-expanded', 'false');
        if (focusButton) {
            elements.exportButton.focus();
        }
    }

    elements.exportButton.addEventListener('click', () => (elements.exportMenu.hidden ? openMenu() : closeMenu()));
    elements.exportMenu.addEventListener('keydown', event => {
        const items = Array.from(elements.exportMenu.querySelectorAll('button:not(:disabled)'));
        const index = items.indexOf(document.activeElement);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const next = items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
            if (next) {
                next.focus();
            }
        } else if (event.key === 'Escape') {
            closeMenu(true);
        } else if (event.key === 'Tab') {
            closeMenu();
        }
    });
    document.addEventListener('pointerdown', event => {
        if (!event.target.closest('.menu-anchor')) {
            closeMenu();
        }
    });

    // Messages from the extension

    window.addEventListener('message', event => {
        const message = event.data;
        if (!message || typeof message !== 'object') {
            return;
        }
        switch (message.type) {
            case 'schema':
                schema = {
                    tables: Array.isArray(message.tables) ? message.tables : [],
                    project: message.project || {},
                    warnings: Number(message.warnings) || 0,
                };
                state.folder = typeof schema.project.folder === 'string' ? schema.project.folder : null;
                persist();
                showSummary();
                // The saved view on the first drawing (reload of the window), then the same place
                draw(drawn ? 'keep' : state.view);
                break;
            case 'settings': {
                const changed = message.layout !== settings.layout || message.direction !== settings.direction;
                settings = { layout: message.layout === 'elk' ? 'elk' : 'dagre', direction: message.direction === 'LR' ? 'LR' : 'TB' };
                showSettings();
                if (schema && changed && drawn) {
                    draw('fit');
                }
                break;
            }
            case 'busy':
                setBusy(Boolean(message.busy));
                break;
            case 'toast':
                toast(String(message.text || ''));
                break;
            case 'empty':
                schema = null;
                filtered = null;
                showSummary();
                diagram.showMessage(String(message.text || 'Nothing to draw.'));
                break;
        }
    });

    // Draw again in the colors of the new theme (class set by VS Code on <body>)
    let theme = document.body.className;
    new MutationObserver(() => {
        if (document.body.className !== theme) {
            theme = document.body.className;
            diagram.redraw();
        }
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

    showViewer(state.viewer);
    showSettings();
    vscode.postMessage({ type: 'ready' });
})();

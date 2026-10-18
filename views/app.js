//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// The page: loaded once, it receives the schema, the settings and the tools of other extensions
// from the extension (postMessage), switches between the viewers without reloading, and keeps its
// state (viewer, zoom, side panel) with vscode.setState so it comes back the same after a reload
// of the window. Texts come from i18n.js, colors and fonts from appearance.js.
(function () {
    'use strict';

    // acquireVsCodeApi() may only be called once per page
    const vscode = acquireVsCodeApi();
    const Export = window.DrawMeDatabaseExport;
    const I18n = window.DrawMeDatabaseI18n;
    const Appearance = window.DrawMeDatabaseAppearance;

    const saved = vscode.getState() || {};
    const state = {
        viewer: saved.viewer === 'json' ? 'json' : 'diagram',
        view: saved.view || null,
        // The workspace folder of the schema, drawn again when VS Code restores the panel
        folder: typeof saved.folder === 'string' ? saved.folder : null,
        query: typeof saved.query === 'string' ? saved.query : '',
        panel: saved.panel === true,
    };

    let schema = null;
    let settings = {
        layout: 'dagre',
        direction: 'TB',
        git: true,
        keysOnly: false,
        relationLabels: true,
        autoRefresh: true,
        language: 'auto',
        appearance: Appearance.sanitize({}),
    };
    // Texts of the page; tr() always uses the current language
    let t = I18n.translator('en');
    const tr = (key, params) => t(key, params);
    // Tools and exports for the side panel, and the license of DrawMeDatabase Pro
    let features = { tools: [], exports: [], license: { kind: 'free', actions: ['discover'] } };
    // Exports added by other extensions (DrawMeDatabase Pro), and whether Pro is installed
    let extraExports = { items: [], pro: false };
    // Tables shown by another extension (a path, a saved view): { tables, highlight, label }
    let focus = null;
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
        git: $('git-button'),
        legend: $('legend'),
        focus: $('focus'),
        focusLabel: $('focus-label'),
        panel: $('side-panel'),
        panelButton: $('panel-button'),
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
        t: tr,
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
        if (focus && schema) {
            const shown = new Set(focus.tables);
            filtered = {
                tables: schema.tables
                    .filter(table => shown.has(table.table))
                    .map(table => ({ ...table, relations: (table.relations || []).filter(relation => shown.has(relation.on)) })),
                matches: focus.highlight.filter(name => shown.has(name)),
                neighbours: [],
            };
            elements.searchCount.textContent = '';
            return;
        }
        filtered = window.DrawMeDatabaseSearch.filterTables(schema ? schema.tables : [], state.query);
        const count = filtered.matches.length;
        elements.searchCount.textContent = !state.query.trim() || !schema
            ? ''
            : count === 0 ? t('search.none') : t('search.count', { count, total: schema.tables.length });
    }

    // The tables on screen: all of them, or the result of the search
    const shownTables = () => (filtered ? filtered.tables : schema ? schema.tables : []);
    const searching = () => Boolean(state.query.trim()) || Boolean(focus);

    function draw(view) {
        if (!schema) {
            return;
        }
        filterSchema();
        const matches = new Set(filtered.matches);
        json.render(!searching() ? schema.tables : focus ? filtered.tables : schema.tables.filter(table => matches.has(table.table)));
        if (searching() && filtered.tables.length === 0) {
            diagram.showMessage(focus ? t('diagram.focusMissing') : t('diagram.noMatch', { query: state.query.trim() }));
            return;
        }
        diagram.render(shownTables(), diagramSettings(), view);
        drawn = true;
        showLegend();
    }

    // What the diagram draws, from the settings
    const diagramSettings = () => ({
        layout: settings.layout,
        direction: settings.direction,
        git: settings.git,
        keysOnly: settings.keysOnly,
        relationLabels: settings.relationLabels,
        highlight: searching() ? filtered.matches : null,
    });

    // Number of tables per git status, under the diagram
    const LEGEND = ['untracked', 'modified', 'unsaved'];
    function showLegend() {
        const legend = elements.legend;
        legend.textContent = '';
        const tables = shownTables();
        const counts = LEGEND.map(status => [status, tables.filter(table => table.git === status).length]);
        if (!settings.git || counts.every(([, count]) => count === 0)) {
            legend.hidden = true;
            return;
        }
        for (const [status, count] of counts) {
            if (count === 0) {
                continue;
            }
            const item = document.createElement('span');
            item.className = `legend-item git-${status}`;
            item.textContent = `${t(`legend.${status}`)} ${count}`;
            item.title = t(`legend.${status}.title`, { count });
            legend.appendChild(item);
        }
        legend.hidden = false;
    }

    let searchTimer;
    elements.search.value = state.query;
    elements.search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            state.query = elements.search.value;
            persist();
            setFocus(null, false);
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

    // Focus of another extension, with a label to go back to the whole schema
    function setFocus(next, redraw = true) {
        focus = next && next.tables.length > 0 ? next : null;
        elements.focus.hidden = !focus;
        elements.focusLabel.textContent = focus ? focus.label || t('focus.count', { count: focus.tables.length }) : '';
        if (focus) {
            elements.search.value = '';
            state.query = '';
            persist();
        }
        if (redraw) {
            draw('fit');
        }
    }
    $('focus-clear').addEventListener('click', () => setFocus(null));

    // Toolbar

    function showSettings() {
        elements.layout.value = settings.layout;
        const leftToRight = settings.direction === 'LR';
        const label = t(`direction.${leftToRight ? 'LR' : 'TB'}`);
        elements.direction.title = label;
        elements.direction.setAttribute('aria-label', label);
        elements.direction.classList.toggle('left-to-right', leftToRight);
        elements.git.setAttribute('aria-pressed', String(settings.git));
        elements.git.setAttribute('aria-label', settings.git ? t('git.hide') : t('git.show'));
    }

    const setSetting = (key, value) => vscode.postMessage({ type: 'setting', key, value });
    elements.layout.addEventListener('change', () => setSetting('layout', elements.layout.value));
    elements.git.addEventListener('click', () => setSetting('showGitStatus', !settings.git));
    elements.direction.addEventListener('click', () => setSetting('direction', settings.direction === 'LR' ? 'TB' : 'LR'));
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
        const parts = [schema.project.frameworkLabel, schema.project.name, t('summary.tables', { count: schema.tables.length })].filter(Boolean);
        const text = document.createElement('span');
        text.textContent = parts.join(' · ');
        elements.summary.appendChild(text);
        if (schema.warnings > 0) {
            const link = document.createElement('button');
            link.type = 'button';
            link.className = 'link';
            link.textContent = t('summary.warnings', { count: schema.warnings });
            link.title = t('summary.warnings.title');
            link.addEventListener('click', () => vscode.postMessage({ type: 'showOutput' }));
            elements.summary.appendChild(link);
        }
    }

    // Export menu

    // What is on screen: the search result when there is one
    const diagramSource = () => window.DrawMeDatabaseMermaid.generateMermaidER(shownTables(), { direction: settings.direction });

    // The exports of the page: { id, label key, icon, run }
    const EXPORTS = {
        diagram: [
            { id: 'svg', label: 'export.svg', icon: 'image', run: () => save('svg', diagram.exportSvg()) },
            { id: 'png', label: 'export.png', icon: 'image', run: async () => save('png', await diagram.exportPng()) },
            { id: 'mmd', label: 'export.mmd', icon: 'file', run: () => save('mmd', Export.mermaidFile(diagramSource(), { project: schema.project, layout: settings.layout })) },
            { id: 'md', label: 'export.md', icon: 'file', run: () => save('md', Export.markdownFile(diagramSource(), { project: schema.project, layout: settings.layout })) },
            { id: 'copyMermaid', label: 'export.copyMermaid', icon: 'copy', run: () => copy('mmd', Export.mermaidFile(diagramSource(), { project: schema.project, layout: settings.layout })) },
        ],
        json: [
            { id: 'json', label: 'export.json', icon: 'code', run: () => save('json', json.text) },
            { id: 'copyJson', label: 'export.copyJson', icon: 'copy', run: () => copy('json', json.text) },
        ],
    };

    async function runExport(item) {
        try {
            await item.run();
        } catch (err) {
            toast(t('export.failed', { error: err && err.message ? err.message : err }));
        }
    }

    function save(format, content) {
        if (!content) {
            toast(t('export.nothing'));
            return;
        }
        vscode.postMessage({ type: 'save', format, content, fileName: Export.fileName(schema.project, format) });
    }

    function copy(format, content) {
        vscode.postMessage({ type: 'copy', format, content });
    }

    // The exports of the page, then those of other extensions (or what DrawMeDatabase Pro adds)
    function menuItems() {
        const items = (EXPORTS[state.viewer] || []).map(item => ({ ...item, label: t(item.label) }));
        if (state.viewer !== 'diagram') {
            return items;
        }
        if (extraExports.items.length > 0) {
            items.push({ separator: true });
            extraExports.items.forEach(item => items.push({
                label: item.label,
                run: () => vscode.postMessage({ type: 'export', id: item.id, tables: shownTables().map(table => table.table) }),
            }));
        } else if (!extraExports.pro) {
            items.push({ separator: true });
            items.push({ label: t('export.proTeaser'), pro: true, run: () => vscode.postMessage({ type: 'pro' }) });
        }
        return items;
    }

    function openMenu() {
        const menu = elements.exportMenu;
        menu.textContent = '';
        menuItems().forEach(item => {
            if (item.separator) {
                const line = document.createElement('div');
                line.className = 'menu-separator';
                line.setAttribute('role', 'separator');
                menu.appendChild(line);
                return;
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('role', 'menuitem');
            button.tabIndex = -1;
            button.textContent = item.label;
            button.disabled = !schema && !item.pro;
            if (item.pro) {
                button.classList.add('menu-pro');
                button.title = t('export.proTeaser.title');
            }
            button.addEventListener('click', () => {
                closeMenu(true);
                runExport(item);
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

    // Side panel: options of the diagram, appearance, tools, exports, settings, license

    const TOOL_ICONS = {
        'pro.canvas': 'canvas',
        'pro.designer': 'designer',
        'pro.addColumns': 'columns',
        'pro.compare': 'compare',
        'pro.compareRefs': 'compare',
        'pro.migrationChanges': 'migration',
        'pro.checks': 'checks',
        'pro.findPath': 'path',
        'pro.saveView': 'bookmark',
        'pro.openView': 'view',
        'pro.models': 'code',
    };
    const exportIcon = (id) => (/sql/.test(id) ? 'database' : /typescript|json/.test(id) ? 'code' : 'file');

    const label = (prefix, item) => (t.has(`${prefix}.${item.id}`) ? t(`${prefix}.${item.id}`) : item.label || item.id);
    const hint = (prefix, item) => (t.has(`${prefix}.${item.id}.hint`) ? t(`${prefix}.${item.id}.hint`) : item.hint || '');
    const stateTitle = (state) => (state === 'missing' ? t('panel.pro.missing') : state === 'locked' ? t('panel.pro.locked') : undefined);

    function licenseFooter() {
        const license = features.license || { kind: 'free' };
        const buttons = (license.actions || []).map((action, index) => ({
            id: `license:${action}`,
            label: t(action === 'discover' ? 'panel.license.discover' : `panel.license.${action}`),
            primary: index === 0 && action !== 'manage',
        }));
        if (license.kind === 'free') {
            return { kind: 'free', title: t('panel.license.free'), text: t('panel.license.free.hint'), buttons };
        }
        const title = license.kind === 'trial'
            ? t('panel.license.trial', { count: Math.max(0, Number(license.daysLeft) || 0) })
            : t(`panel.license.${license.kind}`);
        return { kind: license.kind, title, buttons };
    }

    function panelModel() {
        const appearance = settings.appearance;
        const appearanceItems = window.DrawMeDatabaseSidePanel.appearanceItems(appearance, t);

        const builtIn = [...EXPORTS.diagram, ...EXPORTS.json].map(item => ({ id: `export:${item.id}`, label: t(item.label), icon: item.icon, state: schema ? 'available' : 'locked' }));
        const others = features.exports.map(item => ({
            id: `export:${item.id}`,
            label: label('export', item),
            icon: exportIcon(item.id),
            state: item.state,
            badge: item.pro ? t('panel.pro') : undefined,
            title: stateTitle(item.state),
        }));

        return {
            title: t('panel.title'),
            closeLabel: t('panel.close'),
            sections: [
                {
                    id: 'view',
                    title: t('panel.view'),
                    items: [
                        { type: 'choice', id: 'layout', label: t('panel.layout'), value: settings.layout, options: [{ value: 'elk', label: 'ELK' }, { value: 'dagre', label: 'Dagre' }] },
                        { type: 'choice', id: 'direction', label: t('panel.direction'), value: settings.direction, options: ['TB', 'LR'].map(value => ({ value, label: t(`panel.direction.${value}`) })) },
                        { type: 'toggle', id: 'git', label: t('panel.git'), hint: t('panel.git.hint'), value: settings.git },
                        { type: 'toggle', id: 'keysOnly', label: t('panel.keysOnly'), hint: t('panel.keysOnly.hint'), value: settings.keysOnly },
                        { type: 'toggle', id: 'relationLabels', label: t('panel.relationLabels'), hint: t('panel.relationLabels.hint'), value: settings.relationLabels },
                        { type: 'toggle', id: 'grid', label: t('panel.grid'), value: appearance.grid },
                    ],
                },
                { id: 'appearance', title: t('panel.appearance'), items: appearanceItems },
                {
                    id: 'tools',
                    title: t('panel.tools'),
                    items: [{
                        type: 'actions',
                        items: features.tools.map(tool => ({
                            id: `tool:${tool.id}`,
                            label: label('tool', tool),
                            hint: hint('tool', tool),
                            icon: TOOL_ICONS[tool.id] || tool.icon || 'settings',
                            state: tool.state,
                            badge: tool.pro ? t('panel.pro') : undefined,
                            title: stateTitle(tool.state),
                        })),
                    }],
                },
                { id: 'exports', title: t('panel.exports'), items: [{ type: 'actions', items: [...builtIn, ...others] }] },
                {
                    id: 'settings',
                    title: t('panel.settings'),
                    items: [
                        {
                            type: 'choice',
                            id: 'language',
                            label: t('panel.language'),
                            hint: t('panel.language.hint'),
                            value: settings.language,
                            options: ['auto', ...I18n.LANGUAGES].map(language => ({ value: language, label: t(`language.${language}`) })),
                        },
                        { type: 'toggle', id: 'autoRefresh', label: t('panel.autoRefresh'), hint: t('panel.autoRefresh.hint'), value: settings.autoRefresh },
                        {
                            type: 'actions',
                            items: [
                                { id: 'settings:frameworkPath', label: t('panel.frameworkPath'), hint: t('panel.frameworkPath.hint'), icon: 'folder' },
                                { id: 'settings:all', label: t('panel.allSettings'), icon: 'settings' },
                            ],
                        },
                    ],
                },
            ],
            footer: licenseFooter(),
        };
    }

    // Settings of the page; the appearance settings are applied here at once (then saved)
    const SETTING_KEYS = { git: 'showGitStatus', layout: 'layout', direction: 'direction', keysOnly: 'keysOnly', relationLabels: 'relationLabels', language: 'language', autoRefresh: 'autoRefresh' };

    let previewTimer;
    function previewAppearance(next) {
        settings.appearance = Appearance.sanitize(next);
        Appearance.apply(settings.appearance);
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => diagram.redraw(), 120);
    }

    function onPanelChange(id, value, { preview }) {
        const change = window.DrawMeDatabaseSidePanel.changeAppearance(settings.appearance, id, value);
        if (change) {
            previewAppearance(change.appearance);
            if (!preview) {
                setSetting(change.key, change.value);
                renderPanel();
            }
            return;
        }
        if (Object.prototype.hasOwnProperty.call(SETTING_KEYS, id)) {
            setSetting(SETTING_KEYS[id], value);
        }
    }

    function onPanelAction(id) {
        if (id === 'panel:close') {
            setPanel(false, true);
        } else if (id === 'resetAppearance') {
            vscode.postMessage({ type: 'resetAppearance' });
        } else if (id.startsWith('tool:')) {
            vscode.postMessage({ type: 'tool', id: id.slice(5) });
        } else if (id.startsWith('export:')) {
            const name = id.slice(7);
            const builtIn = [...EXPORTS.diagram, ...EXPORTS.json].find(item => item.id === name);
            if (builtIn) {
                if (schema) {
                    runExport(builtIn);
                }
                return;
            }
            const other = features.exports.find(item => item.id === name);
            if (other && other.state === 'missing') {
                vscode.postMessage({ type: 'pro' });
            } else if (other) {
                vscode.postMessage({ type: 'export', id: name, tables: shownTables().map(table => table.table) });
            }
        } else if (id.startsWith('settings:')) {
            vscode.postMessage({ type: 'openSettings', target: id.slice(9) });
        } else if (id.startsWith('license:')) {
            vscode.postMessage({ type: 'license', action: id.slice(8) });
        }
    }

    const sidePanel = window.DrawMeDatabaseSidePanel.create({ element: elements.panel, onChange: onPanelChange, onAction: onPanelAction });

    function renderPanel() {
        if (state.panel) {
            sidePanel.render(panelModel());
        }
    }

    function setPanel(open, focusButton) {
        state.panel = open;
        persist();
        elements.panel.hidden = !open;
        elements.panelButton.setAttribute('aria-expanded', String(open));
        if (open) {
            renderPanel();
        } else if (focusButton) {
            elements.panelButton.focus();
        }
    }
    elements.panelButton.addEventListener('click', () => setPanel(!state.panel));
    elements.panel.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            setPanel(false, true);
        }
    });

    // Language: the texts of the page, then everything written by the script
    function applyLanguage(language) {
        t = I18n.translator(language);
        document.documentElement.lang = t.language;
        I18n.translateDocument(document, t);
        elements.panel.setAttribute('aria-label', t('panel.title'));
        showSettings();
        showSummary();
        if (schema) {
            filterSchema();
            showLegend();
        }
        setFocus(focus, false);
    }

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
                renderPanel();
                break;
            case 'settings': {
                const next = {
                    layout: message.layout === 'elk' ? 'elk' : 'dagre',
                    direction: message.direction === 'LR' ? 'LR' : 'TB',
                    git: message.showGitStatus !== false,
                    keysOnly: message.keysOnly === true,
                    relationLabels: message.relationLabels !== false,
                    autoRefresh: message.autoRefresh !== false,
                    language: ['auto', ...I18n.LANGUAGES].includes(message.language) ? message.language : 'auto',
                    appearance: Appearance.sanitize(message),
                };
                // A new layout, direction or set of columns moves every table: fit; the rest only
                // redraws in place (git status, language, colors, font)
                const moved = next.layout !== settings.layout || next.direction !== settings.direction || next.keysOnly !== settings.keysOnly;
                const languageChanged = message.languageResolved !== t.language;
                settings = next;
                Appearance.apply(settings.appearance);
                if (languageChanged) {
                    applyLanguage(message.languageResolved);
                }
                showSettings();
                renderPanel();
                if (schema && drawn) {
                    draw(moved ? 'fit' : 'keep');
                }
                break;
            }
            case 'busy':
                setBusy(Boolean(message.busy));
                break;
            case 'exporters':
                extraExports = {
                    items: Array.isArray(message.items) ? message.items.filter(item => item && typeof item.id === 'string') : [],
                    pro: Boolean(message.pro),
                };
                break;
            case 'features': {
                const list = (items) => (Array.isArray(items) ? items.filter(item => item && typeof item.id === 'string') : []);
                features = {
                    tools: list(message.tools),
                    exports: list(message.exports),
                    license: message.license && typeof message.license === 'object' ? message.license : { kind: 'free', actions: ['discover'] },
                };
                renderPanel();
                break;
            }
            case 'focus':
                setFocus({
                    tables: Array.isArray(message.tables) ? message.tables.map(String) : [],
                    highlight: Array.isArray(message.highlight) ? message.highlight.map(String) : [],
                    label: String(message.label || ''),
                }, Boolean(schema));
                if (state.viewer !== 'diagram') {
                    showViewer('diagram');
                }
                break;
            case 'svgRequest':
                vscode.postMessage({ type: 'svg', id: message.id, svg: diagram.exportSvg() });
                break;
            case 'toast':
                toast(String(message.text || ''));
                break;
            case 'empty':
                schema = null;
                filtered = null;
                showSummary();
                diagram.showMessage(String(message.text || t('diagram.nothing')));
                renderPanel();
                break;
        }
    });

    // Draw again in the colors of the new VS Code theme (class set by VS Code on <body>), which the
    // palette follows in 'auto'
    let theme = document.body.className.replace(/\s*dmdb-no-grid/, '');
    new MutationObserver(() => {
        const next = document.body.className.replace(/\s*dmdb-no-grid/, '');
        if (next !== theme) {
            theme = next;
            Appearance.apply(settings.appearance);
            diagram.redraw();
            renderPanel();
        }
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

    Appearance.apply(settings.appearance);
    showViewer(state.viewer);
    showSettings();
    setPanel(state.panel);
    vscode.postMessage({ type: 'ready' });
})();

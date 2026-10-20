//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// The DrawMeDatabase container of the Activity Bar (docs/activity-bar.md): native tree views of the
// schema, the tools, the exports and the license. The items are described by plain objects (the
// *Nodes functions, tested without VS Code), then turned into TreeItems by createSidebar().
//
// node: { id, label, description, tooltip, icon, muted, decoration, contextValue, command, children }
//   icon: a codicon; muted: greyed (a feature of DrawMeDatabase Pro that is missing or locked)
//   decoration: { git } or { state }, the color (and letter) of the label, see DECORATIONS
//   command: { id, args }, run by a click

const CONTAINER_ID = 'drawMeDatabase';
const VIEWS = { schema: 'DMDB.schema', tools: 'DMDB.tools', exports: 'DMDB.exports', license: 'DMDB.license' };
// What the welcome content of the Schema view shows (context key drawMeDatabase.schemaState)
const SCHEMA_STATES = ['loading', 'noFolder', 'noProject', 'noTables', 'error', 'ready'];
// The scheme of the resourceUri of the items with a decoration
const SCHEME = 'drawmedatabase';

// Codicons of the tools of DrawMeDatabase Pro, and of the page icons (views/sidepanel.js) that the
// tools of other extensions give
const TOOL_ICONS = {
    'pro.canvas': 'layout',
    'pro.timeline': 'history',
    'pro.designer': 'table',
    'pro.addColumns': 'add',
    'pro.compare': 'git-compare',
    'pro.compareRefs': 'git-compare',
    'pro.drift': 'database',
    'pro.migrationChanges': 'diff',
    'pro.checks': 'checklist',
    'pro.findPath': 'type-hierarchy-sub',
    'pro.saveView': 'bookmark',
    'pro.openView': 'eye',
    'pro.models': 'symbol-class',
};
const PAGE_ICONS = {
    canvas: 'layout',
    designer: 'table',
    columns: 'add',
    compare: 'git-compare',
    migration: 'diff',
    checks: 'checklist',
    path: 'type-hierarchy-sub',
    view: 'eye',
    bookmark: 'bookmark',
    history: 'history',
    code: 'code',
    file: 'file',
    image: 'file-media',
    copy: 'copy',
    database: 'database',
    settings: 'gear',
    folder: 'folder',
};

// The exports of the diagram, run by the page (the ids of views/app.js)
const BUILT_IN_EXPORTS = [
    { id: 'svg', icon: 'file-media' },
    { id: 'png', icon: 'file-media' },
    { id: 'mmd', icon: 'type-hierarchy' },
    { id: 'md', icon: 'markdown' },
    { id: 'copyMermaid', icon: 'copy' },
    { id: 'json', icon: 'json' },
    { id: 'copyJson', icon: 'copy' },
];

const LICENSE_ICONS = { free: 'info', trial: 'watch', expired: 'warning', licensed: 'verified-filled', development: 'beaker' };
const LICENSE_ACTION_ICONS = { buy: 'credit-card', enter: 'key', manage: 'gear', remove: 'trash', discover: 'link-external' };

// The colors (theme colors) and letters of the labels: the git status like the Explorer, the
// unsaved color of the diagram (theme.css), and greyed features
const DECORATIONS = {
    untracked: { badge: 'U', color: 'gitDecoration.untrackedResourceForeground' },
    modified: { badge: 'M', color: 'gitDecoration.modifiedResourceForeground' },
    unsaved: { badge: '●', color: 'editorInfo.foreground' },
    missing: { color: 'disabledForeground' },
    locked: { color: 'disabledForeground' },
};
const GIT_STATUSES = ['untracked', 'modified', 'unsaved'];
const FEATURE_STATES = ['available', 'missing', 'locked'];

const list = (value) => (Array.isArray(value) ? value : []);
// The translation of the key when there is one, else the text given by the extension
const translated = (t, key, fallback) => (t.has(key) ? t(key) : fallback);
const lines = (...parts) => parts.filter(Boolean).join('\n');
const codicon = (name) => (typeof name === 'string' && /^[a-z][a-z0-9-]*$/.test(name) ? name : undefined);
const gitStatus = (value, shown) => (shown && GIT_STATUSES.includes(value) ? value : undefined);
const featureState = (item) => (FEATURE_STATES.includes(item.state) ? item.state : 'available');
const stateTitle = (state, t) => (state === 'missing' ? t('panel.pro.missing') : state === 'locked' ? t('panel.pro.locked') : '');

// ---------------------------------------------------------------------------------------------
// Items

// The tables (sorted by name) and their columns. git: the git status of the tables is shown,
// columnGit: the one of the columns too (a feature of DrawMeDatabase Pro)
function schemaNodes(schema, t, { git = true, columnGit = false } = {}) {
    if (!schema || !Array.isArray(schema.tables)) {
        return [];
    }
    return schema.tables
        .filter(table => table && typeof table.table === 'string')
        .sort((a, b) => a.table.localeCompare(b.table))
        .map(table => tableNode(table, t, { git, columnGit, framework: schema.framework }));
}

function tableNode(table, t, { git, columnGit, framework }) {
    const columns = list(table.columns).filter(column => column && typeof column.name === 'string');
    const relations = list(table.relations).filter(relation => relation && typeof relation.on === 'string');
    const status = gitStatus(table.git, git);
    const file = table.source && typeof table.source.file === 'string' ? table.source.file : '';
    const open = framework === 'laravel' || framework === 'symfony' ? `inspector.open.${framework}` : 'inspector.open';
    return {
        id: `table:${table.table}`,
        table: table.table,
        label: table.table,
        description: t('inspector.summary.columns', { count: columns.length }),
        tooltip: lines(table.table, file, status && t(`inspector.git.${status}`), file && t(open)),
        icon: 'table',
        decoration: status ? { git: status } : undefined,
        contextValue: 'table',
        command: file ? { id: 'DMDB.openTable', args: [table.table] } : undefined,
        children: columns.map(column => columnNode(table, column, relations, t, { git: git && columnGit })),
    };
}

function columnNode(table, column, relations, t, { git }) {
    const relation = relations.find(candidate => candidate.foreignKey === column.name);
    const type = `${typeof column.type === 'string' ? column.type : ''}${column.nullable ? '?' : ''}`;
    const target = relation ? `${relation.on}.${relation.references || 'id'}` : '';
    const status = gitStatus(column.git, git);
    const file = column.source && typeof column.source.file === 'string';
    const kind = relation && t(`inspector.relation.${relation.type || 'many-to-one'}`);
    return {
        id: `column:${table.table}.${column.name}`,
        table: table.table,
        column: column.name,
        label: column.name,
        description: [type, target && `→ ${target}`].filter(Boolean).join(' '),
        tooltip: lines(
            type ? `${column.name}: ${type}` : column.name,
            column.primary && t('sidebar.primaryKey'),
            relation && `${t('sidebar.foreignKey', { target })} (${kind})`,
            status && t(`inspector.git.${status}`),
            file && t('inspector.column.open'),
        ),
        icon: column.primary ? 'key' : relation ? 'references' : 'symbol-field',
        decoration: status ? { git: status } : undefined,
        contextValue: 'column',
        command: file ? { id: 'DMDB.openTable', args: [table.table, column.name] } : undefined,
    };
}

// A tool or an export of an extension: greyed with PRO while DrawMeDatabase Pro does not add it,
// greyed with a lock once its trial has ended
function featureNode(prefix, item, t, { icon, command }) {
    const state = featureState(item);
    const greyed = state !== 'available';
    return {
        id: `${prefix}:${item.id}`,
        label: translated(t, `${prefix}.${item.id}`, item.label || item.id),
        description: item.pro && greyed ? t('panel.pro') : undefined,
        tooltip: lines(translated(t, `${prefix}.${item.id}.hint`, item.hint || ''), stateTitle(state, t)),
        icon: state === 'locked' ? 'lock' : icon,
        muted: greyed,
        decoration: greyed ? { state } : undefined,
        contextValue: `${prefix}.${state}`,
        command,
    };
}

// The tools of the side panel of 1.6.0 (features().tools of extension.js)
function toolNodes(features, t) {
    return list(features && features.tools)
        .filter(tool => tool && typeof tool.id === 'string')
        .map(tool => featureNode('tool', tool, t, {
            icon: TOOL_ICONS[tool.id] || PAGE_ICONS[tool.icon] || codicon(tool.icon) || 'tools',
            command: { id: 'DMDB.runTool', args: [tool.id] },
        }));
}

// The exports of the diagram, then the ones of the extensions (features().exports)
function exportNodes(features, t) {
    const builtIn = BUILT_IN_EXPORTS.map(item => ({
        id: `export:${item.id}`,
        label: t(`export.${item.id}`),
        tooltip: t('sidebar.export.hint'),
        icon: item.icon,
        contextValue: 'export.available',
        command: { id: 'DMDB.runExport', args: [item.id] },
    }));
    const others = list(features && features.exports)
        .filter(item => item && typeof item.id === 'string')
        .map(item => featureNode('export', item, t, {
            icon: /sql/.test(item.id) ? 'database' : /typescript|json/.test(item.id) ? 'json' : /html/.test(item.id) ? 'globe' : 'file-code',
            command: { id: 'DMDB.runExport', args: [item.id] },
        }));
    return [...builtIn, ...others];
}

// The license of DrawMeDatabase Pro (features().license): its state, then its buttons
function licenseNodes(license, t) {
    const kind = license && Object.prototype.hasOwnProperty.call(LICENSE_ICONS, license.kind) ? license.kind : 'free';
    const label = kind === 'free' ? t('panel.license.free')
        : kind === 'trial' ? t('panel.license.trial', { count: Math.max(0, Number(license.daysLeft) || 0) })
            : t(`panel.license.${kind}`);
    const status = {
        id: 'license:status',
        label,
        tooltip: kind === 'free' ? t('panel.license.free.hint') : undefined,
        icon: LICENSE_ICONS[kind],
        contextValue: `license.${kind}`,
    };
    const actions = list(license && license.actions)
        .filter(action => Object.prototype.hasOwnProperty.call(LICENSE_ACTION_ICONS, action))
        .map(action => ({
            id: `license:${action}`,
            label: t(action === 'discover' ? 'panel.license.discover' : `panel.license.${action}`),
            icon: LICENSE_ACTION_ICONS[action],
            contextValue: 'license.action',
            command: { id: 'DMDB.licenseAction', args: [action] },
        }));
    return [status, ...actions];
}

// ---------------------------------------------------------------------------------------------
// Views

function treeItem(vscode, node) {
    const collapsible = node.children && node.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, collapsible);
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.tooltip || undefined;
    item.contextValue = node.contextValue;
    item.iconPath = new vscode.ThemeIcon(node.icon, node.muted ? new vscode.ThemeColor('disabledForeground') : undefined);
    if (node.decoration) {
        // The decoration provider colors the label from this URI (see DECORATIONS)
        const [key, value] = Object.entries(node.decoration)[0];
        item.resourceUri = vscode.Uri.from({ scheme: SCHEME, path: `/${encodeURIComponent(node.id)}`, query: `${key}=${value}` });
    }
    if (node.command) {
        item.command = { title: node.label, command: node.command.id, arguments: node.command.args };
    }
    return item;
}

function createProvider(vscode, nodes) {
    const changed = new vscode.EventEmitter();
    return {
        onDidChangeTreeData: changed.event,
        getChildren: (node) => (node ? node.children || [] : nodes()),
        getTreeItem: (node) => treeItem(vscode, node),
        refresh: () => changed.fire(undefined),
        dispose: () => changed.dispose(),
    };
}

// The views of the container. options:
//   translator(): the translator of the current language (views/i18n.js)
//   schema(): the schema on screen ({ tables, framework }) or null; project(): its label or ''
//   features(): { tools, exports, license } (features() of extension.js)
//   showGit(), showColumnGit(): whether the git status of the tables, of the columns is shown
//   onSchemaVisibility(visible): the Schema view was shown or hidden
function createSidebar(vscode, { translator, schema, project, features, showGit, showColumnGit, onSchemaVisibility }) {
    const providers = {
        schema: createProvider(vscode, () => schemaNodes(schema(), translator(), { git: showGit(), columnGit: showColumnGit() })),
        tools: createProvider(vscode, () => toolNodes(features(), translator())),
        exports: createProvider(vscode, () => exportNodes(features(), translator())),
        license: createProvider(vscode, () => licenseNodes(features().license, translator())),
    };
    const subscriptions = [];
    const views = {};
    for (const [key, provider] of Object.entries(providers)) {
        views[key] = vscode.window.createTreeView(VIEWS[key], { treeDataProvider: provider, showCollapseAll: key === 'schema' });
        subscriptions.push(views[key], provider);
    }
    subscriptions.push(views.schema.onDidChangeVisibility(event => onSchemaVisibility(event.visible)));

    const decorationsChanged = new vscode.EventEmitter();
    subscriptions.push(decorationsChanged, vscode.window.registerFileDecorationProvider({
        onDidChangeFileDecorations: decorationsChanged.event,
        provideFileDecoration(uri) {
            if (!uri || uri.scheme !== SCHEME) {
                return undefined;
            }
            const [key, value] = String(uri.query || '').split('=');
            const decoration = (key === 'git' || key === 'state') && Object.prototype.hasOwnProperty.call(DECORATIONS, value) ? DECORATIONS[value] : null;
            if (!decoration) {
                return undefined;
            }
            const t = translator();
            const tooltip = key === 'git' ? t(`inspector.git.${value}`) : stateTitle(value, t);
            return new vscode.FileDecoration(decoration.badge, tooltip, new vscode.ThemeColor(decoration.color));
        },
    }));

    const context = new Map();
    const setContext = (key, value) => {
        if (context.get(key) !== value) {
            context.set(key, value);
            Promise.resolve(vscode.commands.executeCommand('setContext', key, value)).catch(() => {});
        }
    };
    // With an older DrawMeDatabase, the views that other extensions add to the container would be
    // moved to the Explorer: they are shown once this key is set (docs/api.md)
    setContext('drawMeDatabase.sidebar', true);

    const describeSchema = () => {
        views.schema.description = project() || undefined;
    };
    const licenseContext = () => {
        const license = features().license;
        setContext('drawMeDatabase.license', license && typeof license.kind === 'string' ? license.kind : 'free');
    };
    licenseContext();

    return {
        schemaVisible: () => Boolean(views.schema.visible),
        // The schema was read again, or its state changed (one of SCHEMA_STATES)
        schemaChanged(state) {
            if (SCHEMA_STATES.includes(state)) {
                setContext('drawMeDatabase.schemaState', state);
            }
            describeSchema();
            providers.schema.refresh();
        },
        // Tools, exports or license changed
        featuresChanged() {
            licenseContext();
            providers.tools.refresh();
            providers.exports.refresh();
            providers.license.refresh();
        },
        // Language, git status shown, license...: everything is drawn again
        refresh() {
            licenseContext();
            describeSchema();
            Object.values(providers).forEach(provider => provider.refresh());
            decorationsChanged.fire(undefined);
        },
        dispose() {
            subscriptions.forEach(subscription => subscription.dispose());
        },
    };
}

module.exports = {
    CONTAINER_ID,
    VIEWS,
    SCHEMA_STATES,
    SCHEME,
    BUILT_IN_EXPORTS,
    schemaNodes,
    toolNodes,
    exportNodes,
    licenseNodes,
    createSidebar,
};

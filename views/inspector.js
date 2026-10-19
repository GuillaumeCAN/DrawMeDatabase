//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Inspector of a table, in the side panel: what the diagram knows about it (columns, keys,
// relations both ways, git status, source lines), then the sections added by other extensions
// (DrawMeDatabase Pro: indexes, defaults, history...), or what they would add. Text is always set
// with textContent.
//
// tableInfo(schema, name) builds the info of a table from the schema on screen;
// create({ element, onAction }).render(info, t) draws it. onAction(id, value):
//   'close', 'open' (the file of the table), 'openColumn' (a column name), 'select' (a table
//   name), 'neighbours', 'action' (the id of an action of a section), 'pro'.
(function (root) {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const GIT_STATUSES = ['untracked', 'modified', 'unsaved'];

    // The info of a table: { table, git, source, framework, columns, outgoing, incoming }, or null
    function tableInfo(schema, name) {
        const tables = schema && Array.isArray(schema.tables) ? schema.tables : [];
        const table = tables.find(candidate => candidate.table === name);
        if (!table) {
            return null;
        }
        const relations = Array.isArray(table.relations) ? table.relations : [];
        const foreignKeys = new Set(relations.filter(relation => relation.type !== 'many-to-many').map(relation => relation.foreignKey));
        const incoming = [];
        tables.forEach(other => (other.relations || []).forEach(relation => {
            if (relation.on === name) {
                incoming.push({ table: other.table, column: relation.type === 'many-to-many' ? relation.via || relation.foreignKey : relation.foreignKey, references: relation.references, type: relation.type || 'many-to-one' });
            }
        }));
        return {
            table: name,
            git: table.git || null,
            source: table.source && typeof table.source.file === 'string' ? table.source : null,
            framework: schema.project && schema.project.framework,
            columns: (Array.isArray(table.columns) ? table.columns : []).map(column => ({
                name: column.name,
                type: column.type,
                nullable: column.nullable === true,
                primary: column.primary === true,
                foreign: foreignKeys.has(column.name),
                git: GIT_STATUSES.includes(column.git) ? column.git : null,
                source: column.source && typeof column.source.file === 'string' ? column.source : null,
            })),
            outgoing: relations.map(relation => ({
                column: relation.type === 'many-to-many' ? relation.via || relation.foreignKey : relation.foreignKey,
                on: relation.on,
                references: relation.references,
                type: relation.type || 'many-to-one',
            })),
            incoming,
        };
    }

    function element(tag, attributes, children) {
        const node = document.createElement(tag);
        Object.entries(attributes || {}).forEach(([name, value]) => {
            if (value === undefined || value === null || value === false) {
                return;
            }
            if (name === 'text') {
                node.textContent = value;
            } else if (name === 'className') {
                node.className = value;
            } else {
                node.setAttribute(name, value === true ? '' : String(value));
            }
        });
        (children || []).forEach(child => child && node.appendChild(child));
        return node;
    }

    function icon(name, className) {
        const paths = (window.DrawMeDatabaseSidePanel && window.DrawMeDatabaseSidePanel.ICONS) || {};
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('aria-hidden', 'true');
        if (className) {
            svg.setAttribute('class', className);
        }
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', paths[name] || paths.file || '');
        svg.appendChild(path);
        return svg;
    }

    function create({ element: container, onAction }) {
        const action = (id, value) => onAction && onAction(id, value);
        // Sections closed by the user, kept between tables
        const closed = new Set();

        function section(id, title, body) {
            const details = element('details', { className: 'panel-section', 'data-section': id });
            details.open = !closed.has(id);
            details.addEventListener('toggle', () => (details.open ? closed.delete(id) : closed.add(id)));
            details.appendChild(element('summary', { className: 'panel-section-title' }, [icon('chevron', 'panel-chevron'), element('span', { text: title })]));
            details.appendChild(element('div', { className: 'panel-section-body inspector-body' }, body));
            return details;
        }

        function gitChip(status, t) {
            return status && status !== 'committed'
                ? element('span', { className: `inspector-chip git-${status}`, text: t(`legend.${status}`) })
                : null;
        }

        function columnRow(column, info, t) {
            const key = column.primary ? 'PK' : column.foreign ? 'FK' : '';
            const row = element(column.source ? 'button' : 'div', {
                type: column.source ? 'button' : null,
                className: `inspector-column${column.git ? ` git-${column.git}` : ''}`,
                title: column.source ? `${t('inspector.column.open')}\n${column.source.file}:${column.source.line}` : null,
            }, [
                element('span', { className: `inspector-key${key ? ` ${key.toLowerCase()}` : ''}`, text: key }),
                element('span', { className: 'inspector-column-name', text: column.name }),
                element('span', { className: 'inspector-column-type', text: `${column.type || ''}${column.nullable ? '?' : ''}` }),
                column.git ? element('span', { className: `inspector-dot git-${column.git}`, title: t(`git.label.${column.git}`), 'aria-label': t(`git.label.${column.git}`) }) : null,
            ]);
            if (column.source) {
                row.addEventListener('click', () => action('openColumn', column.name));
            }
            return row;
        }

        function relationRow(table, detail, type, t) {
            const button = element('button', { type: 'button', className: 'inspector-relation', title: t('inspector.table.select') }, [
                element('span', { className: 'inspector-relation-table', text: table }),
                element('span', { className: 'inspector-relation-detail', text: detail }),
                element('span', { className: 'inspector-relation-type', text: t(`inspector.relation.${type}`) }),
            ]);
            button.addEventListener('click', () => action('select', table));
            return button;
        }

        // A section added by another extension: { title, items: [{ label, value, hint, tone, badge }],
        // actions: [{ id, label }], note, locked }
        function extraSection(extra, index, t) {
            const body = [];
            (extra.items || []).forEach(item => {
                body.push(element('div', { className: `inspector-item${item.tone ? ` tone-${item.tone}` : ''}` }, [
                    element('span', { className: 'inspector-item-label', text: item.label, title: item.label }),
                    item.value ? element('span', { className: 'inspector-item-value', text: item.value }) : null,
                    item.badge ? element('span', { className: 'inspector-item-badge', text: item.badge }) : null,
                    item.hint ? element('span', { className: 'inspector-item-hint', text: item.hint }) : null,
                ]));
            });
            if (extra.note) {
                body.push(element('p', { className: 'panel-note', text: extra.note }));
            }
            const actions = (extra.actions || []).map(entry => {
                const button = element('button', { type: 'button', className: 'panel-button' }, [element('span', { text: entry.label })]);
                button.addEventListener('click', () => action('action', entry.id));
                return button;
            });
            if (actions.length > 0) {
                body.push(element('div', { className: 'inspector-actions' }, actions));
            }
            const node = section(`extra-${index}-${extra.title}`, extra.title, body);
            if (extra.locked) {
                node.classList.add('inspector-locked');
                node.querySelector('summary').appendChild(element('span', { className: 'panel-badge', text: t('panel.pro') }));
            }
            return node;
        }

        // What DrawMeDatabase Pro would show here, while it is not installed
        function teaser(t) {
            const card = element('div', { className: 'panel-footer free inspector-teaser' }, [
                element('p', { className: 'panel-footer-title' }, [element('span', { text: t('inspector.pro.title') }), element('span', { className: 'panel-badge', text: t('panel.pro') })]),
                element('ul', { className: 'inspector-teaser-list' }, ['details', 'history', 'actions'].map(key => element('li', { text: t(`inspector.pro.${key}`) }))),
            ]);
            const button = element('button', { type: 'button', className: 'panel-button primary' }, [element('span', { text: t('panel.license.discover') })]);
            button.addEventListener('click', () => action('pro'));
            card.appendChild(button);
            return card;
        }

        // info: tableInfo(), with extras: { sections, loading, teaser, gitColumnsLocked } (the
        // sections of other extensions, still loading, the Pro teaser, and a note that the git
        // status of the columns comes with Pro)
        function render(info, t, extras) {
            const more = extras || {};
            const scroll = container.querySelector('.panel-content');
            const scrollTop = scroll && container.dataset.table === (info && info.table) ? scroll.scrollTop : 0;
            container.textContent = '';
            container.dataset.table = info ? info.table : '';

            const close = element('button', { type: 'button', className: 'panel-icon-button', title: t('panel.close'), 'aria-label': t('panel.close') }, [icon('close')]);
            close.addEventListener('click', () => action('close'));
            container.appendChild(element('div', { className: 'panel-header' }, [element('h2', { className: 'panel-title', text: t('inspector.title') }), close]));
            const content = element('div', { className: 'panel-content inspector' });
            container.appendChild(content);

            if (!info) {
                content.appendChild(element('p', { className: 'panel-note inspector-missing', text: t('inspector.notInSchema') }));
                return;
            }

            // Name, git status, size, and the file it comes from
            const head = element('div', { className: 'inspector-head' }, [
                element('div', { className: 'inspector-name-line' }, [element('h3', { className: 'inspector-name', text: info.table }), gitChip(info.git, t)]),
                element('p', { className: 'inspector-summary', text: [
                    t('inspector.summary.columns', { count: info.columns.length }),
                    t('inspector.summary.relations', { count: info.outgoing.length }),
                    t('inspector.summary.referencedBy', { count: info.incoming.length }),
                ].join(' · ') }),
                info.git && info.git !== 'committed' ? element('p', { className: `inspector-git-line git-${info.git}`, text: t(`inspector.git.${info.git}`) }) : null,
            ]);
            const buttons = [];
            if (info.source) {
                const open = element('button', { type: 'button', className: 'panel-button primary', title: `${info.source.file}:${info.source.line}` }, [
                    icon('file'),
                    // 'Open the migration' (inspector.open.laravel), else 'Open the file'
                    element('span', { text: t(typeof info.framework === 'string' && t.has && t.has(`inspector.open.${info.framework}`) ? `inspector.open.${info.framework}` : 'inspector.open') }),
                ]);
                open.addEventListener('click', () => action('open'));
                buttons.push(open);
                head.appendChild(element('p', { className: 'inspector-source', text: `${info.source.file}:${info.source.line}` }));
            }
            if (info.outgoing.length + info.incoming.length > 0) {
                const neighbours = element('button', { type: 'button', className: 'panel-button' }, [icon('path'), element('span', { text: t('inspector.neighbours') })]);
                neighbours.addEventListener('click', () => action('neighbours'));
                buttons.push(neighbours);
            }
            if (buttons.length > 0) {
                head.appendChild(element('div', { className: 'inspector-actions' }, buttons));
            }
            content.appendChild(head);

            // Columns, with their keys, types and git status (a click opens the line of the column)
            const columns = info.columns.length > 0
                ? info.columns.map(column => columnRow(column, info, t))
                : [element('p', { className: 'panel-note', text: t('inspector.none.columns') })];
            if (more.gitColumnsLocked && info.columns.length > 0) {
                const badge = element('button', { type: 'button', className: 'panel-badge panel-badge-button', title: t('panel.pro.missing'), text: t('panel.pro') });
                badge.addEventListener('click', () => action('pro'));
                columns.push(element('div', { className: 'inspector-locked-note' }, [element('span', { text: t('inspector.gitColumns') }), badge]));
            }
            content.appendChild(section('columns', t('inspector.columns'), columns));

            // Relations, both ways (a click shows the other table)
            const relations = [];
            if (info.outgoing.length > 0) {
                relations.push(element('h4', { className: 'panel-heading', text: t('inspector.references') }));
                info.outgoing.forEach(relation => relations.push(relationRow(relation.on, `${relation.column} → ${relation.on}.${relation.references || 'id'}`, relation.type, t)));
            }
            if (info.incoming.length > 0) {
                relations.push(element('h4', { className: 'panel-heading', text: t('inspector.referencedBy') }));
                info.incoming.forEach(relation => relations.push(relationRow(relation.table, `${relation.table}.${relation.column} → ${relation.references || 'id'}`, relation.type, t)));
            }
            if (relations.length === 0) {
                relations.push(element('p', { className: 'panel-note', text: t('inspector.none.relations') }));
            }
            content.appendChild(section('relations', t('inspector.relations'), relations));

            // Sections of other extensions, or what DrawMeDatabase Pro would add
            (more.sections || []).forEach((extra, index) => content.appendChild(extraSection(extra, index, t)));
            if (more.loading) {
                content.appendChild(element('p', { className: 'panel-note inspector-loading', text: t('inspector.loading') }));
            }
            if (more.teaser) {
                content.appendChild(teaser(t));
            }
            content.scrollTop = scrollTop;
        }

        return { render };
    }

    const api = { create, tableInfo };
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.DrawMeDatabaseInspector = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);

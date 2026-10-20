//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Search of the toolbar: the tables whose name or one of whose columns contains the text, and
// their direct neighbours (the tables they reference or that reference them), so the diagram
// shows each match in its context. Pure function, loaded by the webview and the unit tests.
(function (root) {
    'use strict';

    const asArray = (value) => (Array.isArray(value) ? value : []);
    const nameOf = (value) => (value === undefined || value === null ? '' : String(value));

    // { tables, matches, neighbours }: tables to draw (matches and neighbours, with only the
    // relations between them), names of the matching tables, names of the neighbours.
    // An empty query returns every table.
    function filterTables(tables, query) {
        const all = asArray(tables).filter(table => table && typeof table === 'object');
        const text = nameOf(query).trim().toLowerCase();
        if (!text) {
            return { tables: all, matches: [], neighbours: [] };
        }

        const contains = (value) => nameOf(value).toLowerCase().includes(text);
        const matches = new Set(all
            .filter(table => contains(table.table) || asArray(table.columns).some(column => column && contains(column.name)))
            .map(table => nameOf(table.table)));

        const neighbours = new Set();
        all.forEach(table => {
            const name = nameOf(table.table);
            asArray(table.relations).forEach(relation => {
                const target = nameOf(relation && relation.on);
                if (matches.has(name) && target && !matches.has(target)) {
                    neighbours.add(target);
                }
                if (matches.has(target) && !matches.has(name)) {
                    neighbours.add(name);
                }
            });
        });

        const shown = new Set([...matches, ...neighbours]);
        return {
            tables: all
                .filter(table => shown.has(nameOf(table.table)))
                .map(table => ({
                    ...table,
                    relations: asArray(table.relations).filter(relation => relation && shown.has(nameOf(relation.on))),
                })),
            matches: [...matches],
            neighbours: [...neighbours],
        };
    }

    const api = { filterTables };
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.DrawMeDatabaseSearch = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);

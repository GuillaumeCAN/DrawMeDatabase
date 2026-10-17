//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Builds the Mermaid erDiagram source from the parsers' tables.
// Pure function, loaded by the webview (classic script) and by the unit tests (CommonJS).
// Every identifier is sanitized for the Mermaid 10.9.8 erDiagram grammar, so one odd name
// can never make Mermaid reject the whole diagram.
(function (root) {
    'use strict';

    // Attribute keys: an attribute word equal to one of them is a syntax error
    const ATTRIBUTE_KEYS = new Set(['pk', 'fk', 'uk']);

    const EDGES = {
        'many-to-one': '||--o{',
        'one-to-one': '||--o|',
        'many-to-many': '}o--o{',
    };

    const asText = (value) => (value === undefined || value === null ? '' : String(value));
    const asArray = (value) => (Array.isArray(value) ? value : []);

    // Text allowed between double quotes (entity and relationship labels): no quote, '%',
    // backslash or control char. '#' and ':' are written as Mermaid entity codes, which Mermaid
    // turns back into the character when it draws: otherwise it reads '#word;' as an entity code
    // ('#1;' would become U+0001) and drops the ';' of 'style...:#...;'.
    function quotableText(value) {
        return asText(value)
            .replace(/"/g, '')
            .replace(/[%\\\u0000-\u001f\u007f]/g, '_')
            .trim()
            .replace(/[#:]/g, char => `#${char.charCodeAt(0)};`);
    }

    // One attribute word ([A-Za-z_][A-Za-z0-9_]*, ASCII only in Mermaid 10), never a key word
    function attributeWord(value, fallback) {
        let word = asText(value).trim()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^A-Za-z0-9_]+/g, '_');
        if (!/[A-Za-z0-9]/.test(word)) {
            return fallback;
        }
        if (!/^[A-Za-z_]/.test(word)) {
            word = '_' + word;
        }
        if (ATTRIBUTE_KEYS.has(word.toLowerCase())) {
            word += '_';
        }
        return word;
    }

    // '?string' -> 'string', '\Doctrine\Common\Collections\Collection' -> 'Collection',
    // 'Collection<int, Post>' -> 'Collection'
    function typeWord(type) {
        const text = asText(type).trim()
            .replace(/^\?/, '')
            .replace(/<.*$/s, '')
            .replace(/^.*\\/, '');
        return attributeWord(text, 'unknown');
    }

    function relationType(relation) {
        return Object.prototype.hasOwnProperty.call(EDGES, relation.type) ? relation.type : 'many-to-one';
    }

    function generateMermaidER(tables) {
        // Merge duplicate table entries (columns by name, first one wins)
        const merged = new Map();
        asArray(tables).forEach(table => {
            if (!table || typeof table !== 'object') {
                return;
            }
            const name = asText(table.table);
            if (!merged.has(name)) {
                merged.set(name, { name, columns: [], relations: [] });
            }
            const entry = merged.get(name);
            asArray(table.columns).forEach(column => {
                if (column && !entry.columns.some(existing => existing.name === column.name)) {
                    entry.columns.push(column);
                }
            });
            asArray(table.relations).forEach(relation => {
                if (relation && asText(relation.on) !== '') {
                    entry.relations.push(relation);
                }
            });
        });

        // Each entity gets a generated id (e1, e2...) and its table name as a quoted label:
        // Mermaid never reads a table name as an identifier, so keywords ('end', 'one'...) and
        // Object.prototype keys ('constructor', '__proto__'...: Mermaid 10 keeps its entities in
        // a plain object) cannot break the diagram
        const entries = Array.from(merged.values());
        const ids = new Map();
        entries.forEach(entry => ids.set(entry.name, `e${ids.size + 1}`));
        entries.forEach(entry => entry.relations.forEach(relation => {
            const name = asText(relation.on);
            if (!ids.has(name)) {
                ids.set(name, `e${ids.size + 1}`);
            }
        }));
        const entityId = (name) => ids.get(asText(name));
        const entity = (name) => `${entityId(name)}["${quotableText(name) || 'unnamed'}"]`;

        const lines = ['erDiagram'];

        entries.forEach(entry => {
            const foreignKeys = new Set(entry.relations
                .filter(relation => relationType(relation) !== 'many-to-many')
                .map(relation => asText(relation.foreignKey)));

            if (entry.columns.length === 0) {
                lines.push(`  ${entity(entry.name)}`);
                return;
            }
            lines.push(`  ${entity(entry.name)} {`);
            entry.columns.forEach(column => {
                const keys = [];
                if (column.primary) {
                    keys.push('PK');
                }
                if (foreignKeys.has(asText(column.name))) {
                    keys.push('FK');
                }
                const attribute = `${typeWord(column.type)} ${attributeWord(column.name, 'unnamed')}`;
                lines.push(`    ${keys.length ? `${attribute} ${keys.join(', ')}` : attribute}`);
            });
            lines.push('  }');
        });

        // Relation targets that are not parsed tables, declared for their label
        ids.forEach((id, name) => {
            if (!merged.has(name)) {
                lines.push(`  ${entity(name)}`);
            }
        });

        const edges = new Set();
        entries.forEach(entry => {
            entry.relations.forEach(relation => {
                const type = relationType(relation);
                const table = entityId(entry.name);
                const target = entityId(relation.on);
                const label = quotableText(type === 'many-to-many' ? relation.via || relation.foreignKey : relation.foreignKey);
                edges.add(type === 'many-to-many'
                    ? `  ${table} ${EDGES[type]} ${target} : "${label}"`
                    : `  ${target} ${EDGES[type]} ${table} : "${label}"`);
            });
        });
        edges.forEach(edge => lines.push(edge));

        return lines.join('\n') + '\n';
    }

    const api = { generateMermaidER };
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.DrawMeDatabaseMermaid = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);

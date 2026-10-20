//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Builds the Mermaid erDiagram source from the parsers' tables.
// Pure functions, loaded by the webview (classic script) and by the unit tests (CommonJS).
// Every identifier is sanitized for the Mermaid 12 erDiagram grammar, so one odd name can
// never make Mermaid reject the whole diagram.
(function (root) {
    'use strict';

    const EDGES = {
        'many-to-one': '||--o{',
        'one-to-one': '||--o|',
        'many-to-many': '}o--o{',
    };

    const DIRECTIONS = ['TB', 'BT', 'LR', 'RL'];

    // Git status of the tables (CSS classes of their node) and of the columns (attribute comment)
    const GIT_CLASSES = { untracked: 'gitNew', modified: 'gitModified', unsaved: 'gitUnsaved' };
    const GIT_LABELS = { untracked: 'new', modified: 'modified', unsaved: 'unsaved' };
    const DOT = String.fromCharCode(0x25cf);
    const gitLabel = (status) => `${DOT} ${GIT_LABELS[status]}`;
    const gitStatus = (value) => (Object.prototype.hasOwnProperty.call(GIT_LABELS, value) ? value : null);

    // Words the erDiagram lexer reads as keywords, so they cannot be entity ids (compared in
    // lower case). Ids are only used as is when they are plain ASCII words outside this list.
    const RESERVED_IDS = new Set([
        'erdiagram', 'style', 'classdef', 'class', 'subgraph', 'end', 'direction', 'default',
        'one', 'many', 'only', 'zero', 'to', 'optionally', 'u', 'o', 'acctitle', 'accdescr',
        'pk', 'fk', 'uk',
    ]);

    // Characters an attribute word may contain (lexer: [\*A-Za-z_\u00C0-\uFFFF] then
    // [A-Za-z0-9\-_\[\]().,\u00C0-\uFFFF\*]*). Names keep letters, digits, '_', '-' and '.';
    // types also keep '(', ')', ',', '[' and ']' (decimal(8,2), string[]).
    const NAME_CHARS = /[^A-Za-z0-9_\-.\u00C0-\uFFFF]+/g;
    const TYPE_CHARS = /[^A-Za-z0-9_\-.()[\],\u00C0-\uFFFF]+/g;

    const asText = (value) => (value === undefined || value === null ? '' : String(value));
    const asArray = (value) => (Array.isArray(value) ? value : []);

    // Text allowed between double quotes (entity and relationship labels): no quote, '%',
    // backslash or control char. '#' and ':' are written as Mermaid entity codes, which Mermaid
    // turns back into the character when it draws: otherwise it reads '#word;' as an entity code
    // ('#1;' would become U+0001) and drops the ';' of 'style...:#...;'. A line holding
    // "direction LR" is read as a direction statement wherever it is, hence the '_'.
    function quotableText(value) {
        return asText(value)
            .replace(/"/g, '')
            .replace(/[%\\\u0000-\u001f\u007f\u2028\u2029]/g, '_')
            .trim()
            .replace(/(direction)\s+(TB|BT|RL|LR)/gi, '$1_$2')
            .replace(/[#:]/g, char => `#${char.charCodeAt(0)};`);
    }

    // One attribute word, never a key word (PK, FK, UK: also when followed by '-', '.', 'é'...)
    function attributeWord(value, fallback, disallowed) {
        let word = asText(value).trim()
            .replace(/\s+/g, '_')
            .replace(disallowed || NAME_CHARS, '_');
        if (!/[A-Za-z0-9\u00C0-\uFFFF]/.test(word)) {
            return fallback;
        }
        if (!/^[A-Za-z_\u00C0-\uFFFF]/.test(word) || /^(pk|fk|uk)(?![A-Za-z0-9_])/i.test(word)) {
            word = '_' + word;
        }
        return word;
    }

    // '?string' -> 'string?', '\Doctrine\Common\Collections\Collection' -> 'Collection',
    // 'Collection<int, Post>' -> 'Collection'. Nullable columns get Mermaid's 'type?'.
    function typeWord(type, nullable) {
        const text = asText(type).trim();
        const word = attributeWord(text
            .replace(/^\?/, '')
            .replace(/<.*$/s, '')
            .replace(/^.*\\/, ''), 'unknown', TYPE_CHARS);
        return nullable || text.startsWith('?') ? `${word}?` : word;
    }

    function relationType(relation) {
        return Object.prototype.hasOwnProperty.call(EDGES, relation.type) ? relation.type : 'many-to-one';
    }

    // Duplicate table entries merged (columns by name, first one wins), in the order of the input
    function mergeTables(tables) {
        const merged = new Map();
        asArray(tables).forEach(table => {
            if (!table || typeof table !== 'object') {
                return;
            }
            const name = asText(table.table);
            if (!merged.has(name)) {
                merged.set(name, { name, columns: [], relations: [], git: gitStatus(table.git) });
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
        return merged;
    }

    // Ids: the table name when it is a plain ASCII word that is no keyword, else t1, t2... The
    // label always shows the exact name, so keywords and odd names cannot break the diagram.
    function assignIds(names) {
        const ids = new Map();
        const used = new Set();
        const readable = (name) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) && !RESERVED_IDS.has(name.toLowerCase());
        names.forEach(name => {
            if (readable(name) && !used.has(name.toLowerCase())) {
                ids.set(name, name);
                used.add(name.toLowerCase());
            }
        });
        let counter = 0;
        names.forEach(name => {
            if (!ids.has(name)) {
                let id;
                do {
                    id = `t${++counter}`;
                } while (used.has(id));
                ids.set(name, id);
                used.add(id);
            }
        });
        return ids;
    }

    // The diagram and its entities: { source, entities: [{ id, table, declared }] }. Options:
    // direction ('TB', 'LR'...), highlight (table names drawn as matches, the others dimmed),
    // git (true: the tables get the class of their git status, uncommitted columns a comment).
    function buildDiagram(tables, options) {
        const settings = options || {};
        const merged = mergeTables(tables);
        const entries = Array.from(merged.values());

        // Relation targets that are not parsed tables are entities too, declared for their label
        const names = entries.map(entry => entry.name);
        entries.forEach(entry => entry.relations.forEach(relation => {
            const name = asText(relation.on);
            if (!merged.has(name) && !names.includes(name)) {
                names.push(name);
            }
        }));
        const ids = assignIds(names);
        const entityId = (name) => ids.get(asText(name));
        const entity = (name) => {
            const id = entityId(name);
            const label = quotableText(name) || 'unnamed';
            return label === id ? id : `${id}["${label}"]`;
        };

        const lines = ['erDiagram'];
        if (DIRECTIONS.includes(settings.direction)) {
            lines.push(`  direction ${settings.direction}`);
        }

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
                const attribute = `${typeWord(column.type, column.nullable === true)} ${attributeWord(column.name, 'unnamed')}`;
                const status = settings.git ? gitStatus(column.git) : null;
                const comment = status ? ` "${gitLabel(status)}"` : '';
                lines.push(`    ${keys.length ? `${attribute} ${keys.join(', ')}` : attribute}${comment}`);
            });
            lines.push('  }');
        });

        names.forEach(name => {
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

        // Search results: the matches stand out, the other tables fade (styles from the page)
        const highlight = settings.highlight ? new Set(Array.from(settings.highlight, asText)) : null;
        if (highlight && highlight.size > 0) {
            const matched = names.filter(name => highlight.has(name)).map(entityId);
            const others = names.filter(name => !highlight.has(name)).map(entityId);
            if (matched.length > 0) {
                lines.push(`  class ${matched.join(',')} match`);
            }
            if (others.length > 0) {
                lines.push(`  class ${others.join(',')} dimmed`);
            }
        }

        if (settings.git) {
            for (const [status, className] of Object.entries(GIT_CLASSES)) {
                const changed = entries.filter(entry => entry.git === status).map(entry => entityId(entry.name));
                if (changed.length > 0) {
                    lines.push(`  class ${changed.join(',')} ${className}`);
                }
            }
        }

        return {
            source: lines.join('\n') + '\n',
            entities: names.map(name => ({ id: entityId(name), table: name, declared: merged.has(name) })),
        };
    }

    function generateMermaidER(tables, options) {
        return buildDiagram(tables, options).source;
    }

    const api = { generateMermaidER, buildDiagram, gitLabel, GIT_CLASSES };
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.DrawMeDatabaseMermaid = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);

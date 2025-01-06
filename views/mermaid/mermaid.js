function groupTablesByRelations(data) {
    const groups = [];
    const tableMap = new Map();

    data.forEach(table => {
        tableMap.set(table.table, table);
    });

    data.forEach(table => {
        let group = groups.find(g => g.includes(table.table));
        if (!group) {
            group = [];
            groups.push(group);
        }
        group.push(table.table);

        table.relations.forEach(relation => {
            if (!group.includes(relation.on)) {
                group.push(relation.on);
            }
        });
    });

    return groups.map(group => group.map(tableName => tableMap.get(tableName)));
}

function generateMermaidDiagram(data) {
    let mermaidStr = 'erDiagram\n';

    data.forEach(table => {
        mermaidStr += `  ${table.table} {\n`;

        table.columns.forEach(column => {
            mermaidStr += `    ${column.name} ${column.type}\n`;
        });

        mermaidStr += '  }\n';

        // relations
        table.relations.forEach(relation => {
            mermaidStr += `  ${relation.on} ||--o| ${table.table}: "${relation.foreignKey} references ${relation.references}"\n`;
        });
    });

    return mermaidStr;
}

const groupedTables = groupTablesByRelations(jsonData);

// Sort groups by the total number of columns in descending order
groupedTables.sort((a, b) => {
    const aColumns = a.reduce((sum, table) => sum + table.columns.length, 0);
    const bColumns = b.reduce((sum, table) => sum + table.columns.length, 0);
    return bColumns - aColumns;
});

let mermaidCode = '';

groupedTables.forEach(group => {
    mermaidCode += `<div class="mermaid">${generateMermaidDiagram(group)}</div>\n`;
});

document.getElementById("mermaid-diagram").innerHTML = mermaidCode;
mermaid.init();
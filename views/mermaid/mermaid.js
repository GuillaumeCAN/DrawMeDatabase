//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

function generateMermaidER(data) {
    let mermaidStr = 'erDiagram\n';

    const tableDefs = new Map();
    const relationsSet = new Set();

    data.forEach(table => {
      if (!tableDefs.has(table.table)) {
        let def = `  ${table.table} {\n`;
        table.columns.forEach(column => {
          def += `    ${column.name} ${column.type}\n`;
        });
        def += `  }\n`;
        tableDefs.set(table.table, def);
      }

      table.relations.forEach(relation => {
        const relLine = `  ${relation.on} ||--o| ${table.table} : "${relation.foreignKey} references ${relation.references}"`;
        relationsSet.add(relLine);
      });
    });

    tableDefs.forEach(def => {
      mermaidStr += def;
    });

    relationsSet.forEach(rel => {
      mermaidStr += rel + "\n";
    });

    return mermaidStr;
  }

  function renderMermaidDiagram() {
    const container = document.getElementById("mermaid-diagram");
    if (!container) {
      console.error("The container with ID 'mermaid-diagram' is not found.");
      return;
    }
    // generating mermaid code
    const mermaidCode = generateMermaidER(jsonData);
    container.innerHTML = `<div class="mermaid">${mermaidCode}</div>`;

    if (typeof mermaid !== "undefined" && mermaid.init) {
      mermaid.init(undefined, container);
    } else {
      console.error("The Mermaid library is not loaded.");
    }
  }

  // wait for the DOM to be fully loaded
  document.addEventListener("DOMContentLoaded", renderMermaidDiagram);

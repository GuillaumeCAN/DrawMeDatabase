//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

const fs = require('fs');
const vscode = require('vscode');

module.exports.Parser = function(projectPath) {
    if (!fs.existsSync(projectPath + '/database/migrations')) {
        vscode.window.showErrorMessage("Default folder does not exist.");
        return null;
    }

    // Get all PHP files in the migrations folder
    const phpFiles = fs.readdirSync(projectPath + '/database/migrations').filter(file => file.endsWith('.php'));
    
    // If no PHP files are found, show an error message
    if (phpFiles.length === 0) {
        vscode.window.showErrorMessage("No PHP files found in the default folder.");
        return null;
    }

    // Read the content of each PHP file
    const migrations = phpFiles.map(file => {
        const filePath = projectPath + '/database/migrations/' + file;
        const content = fs.readFileSync(filePath, 'utf-8'); 
        
        // Remove the down() function content
        const cleanedContent = content.replace(/public\s*function\s*down\(\)\s*{[\s\S]*?}/g, '');
        
        return { fileName: file, content: cleanedContent };
    });

    // Helper function to parse columns (creation, addition, modification, renaming, deletion)
    const parseColumns = (phpCode) => {
        const columnRegex = /\$table->(\w+)\('(\w+)'(?:, (.+))?\)(?:->change\(\))?/g;
        const renameRegex = /\$table->renameColumn\('(\w+)',\s*'(\w+)'\)/g; // Detect renameColumn calls
        const dropColumnRegex = /\$table->dropColumn\(['"](\w+)['"]\)/g; // Detect dropColumn calls
        const columns = [];
        let match;
    
        // Parse standard column definitions
        while ((match = columnRegex.exec(phpCode)) !== null) {
            const [, type, name, additional] = match;
            const column = { name, type, change: match[0].includes('->change()') };
            if (additional) {
                column.additional = additional.trim();
            }
            columns.push(column);
        }

        // Parse column renames
        while ((match = renameRegex.exec(phpCode)) !== null) {
            const [, oldName, newName] = match;
            columns.push({ name: newName, oldName }); // Capture the rename, but we'll manage the new name
        }

        // Parse column drops
        const dropColumns = [];
        while ((match = dropColumnRegex.exec(phpCode)) !== null) {
            const [, columnName] = match;
            dropColumns.push(columnName); // Capture the column name to be dropped
        }

        return { columns, dropColumns };
    };

    // Helper function to parse relations (creation or modification)
    const parseRelations = (phpCode) => {
        const relationRegex = /\$table->foreign\('(\w+)'\)->references\('(\w+)'\)->on\('(\w+)'\)/g;
        const relations = [];
        let match;
    
        while ((match = relationRegex.exec(phpCode)) !== null) {
            const [, foreignKey, references, on] = match;
            relations.push({ foreignKey, references, on });
        }
    
        return relations;
    };

    // Helper function to parse table creation or modification
    const parsePHPToSchemas = (phpCode) => {
        const tableRegex = /Schema::(create|table)\('(\w+)',\s*function\s*\(Blueprint\s*\$table\)\s*{([\s\S]*?)}\);/g;
        const schemas = [];
        let match;
    
        while ((match = tableRegex.exec(phpCode)) !== null) {
            const [_, action, tableName, tableContent] = match;
    
            const schema = {
                table: tableName,
                action: action === 'create' ? 'create' : 'modify',
                columns: parseColumns(tableContent).columns,
                dropColumns: parseColumns(tableContent).dropColumns,
                relations: parseRelations(tableContent),
            };
    
            schemas.push(schema);
        }
        return schemas;
    };

    // Track the state of the database (tables and their columns)
    let databaseState = {};

    // Apply migrations to the database state
    migrations.forEach(migration => {
        const schemas = parsePHPToSchemas(migration.content);

        schemas.forEach(schema => {
            if (schema.action === 'create') {
                // Create table
                if (!databaseState[schema.table]) {
                    databaseState[schema.table] = { columns: [], relations: [] };
                }
                // Add columns
                schema.columns.forEach(col => {
                    if (!databaseState[schema.table].columns.some(c => c.name === col.name)) {
                        databaseState[schema.table].columns.push(col);
                    }
                });
                // Add relations
                schema.relations.forEach(rel => {
                    if (!databaseState[schema.table].relations.some(r => r.foreignKey === rel.foreignKey)) {
                        databaseState[schema.table].relations.push(rel);
                    }
                });
            } else if (schema.action === 'modify') {
                // Modify table (add new columns, relations, or rename/drop/change columns)
                if (databaseState[schema.table]) {
                    // Add new columns
                    schema.columns.forEach(col => {
                        // If column is renamed, find the old column and update its name
                        if (col.oldName) {
                            const existingCol = databaseState[schema.table].columns.find(c => c.name === col.oldName);
                            if (existingCol) {
                                existingCol.name = col.name; // Update the column name
                            } else {
                                databaseState[schema.table].columns.push(col); // If the column doesn't exist, add it
                            }
                        } else if (col.change) {
                            // If column type is changed, update the type
                            const existingCol = databaseState[schema.table].columns.find(c => c.name === col.name);
                            if (existingCol) {
                                existingCol.type = col.type; // Update the column type
                            } else {
                                databaseState[schema.table].columns.push(col); // If the column doesn't exist, add it
                            }
                        } else {
                            if (!databaseState[schema.table].columns.some(c => c.name === col.name)) {
                                databaseState[schema.table].columns.push(col);
                            }
                        }
                    });

                    // Remove dropped columns
                    schema.dropColumns.forEach(colName => {
                        const columnIndex = databaseState[schema.table].columns.findIndex(c => c.name === colName);
                        if (columnIndex !== -1) {
                            databaseState[schema.table].columns.splice(columnIndex, 1); // Remove the dropped column
                        }
                    });

                    // Add new relations
                    schema.relations.forEach(rel => {
                        if (!databaseState[schema.table].relations.some(r => r.foreignKey === rel.foreignKey)) {
                            databaseState[schema.table].relations.push(rel);
                        }
                    });
                }
            }
        });
    });

    // Convert the database state to a JSON-friendly format
    const jsonTable = Object.keys(databaseState).map(tableName => {
        return {
            table: tableName,
            columns: databaseState[tableName].columns.map(col => {
                const { change, ...rest } = col;
                return rest;
            }),
            relations: databaseState[tableName].relations,
        };
    });

    const jsonTableString = JSON.stringify(jsonTable, null, 2);
    return jsonTable;
};
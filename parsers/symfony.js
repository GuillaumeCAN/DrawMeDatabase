//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

module.exports.Parser = function (projectPath) {

  const basePath = (projectPath) => {
    const config = vscode.workspace.getConfiguration('DrawMeDatabase');
    const customPath = config.get('frameworkPath');
    return customPath.length > 0 ? projectPath + '/' + customPath : projectPath;
  };

  baseEntityPath = path.join(basePath(projectPath), 'src/Entity');

  if (!fs.existsSync(baseEntityPath)) {
    console.log(baseEntityPath);
    vscode.window.showErrorMessage("Default folder does not exist.");
    
    return null;
  }

  const phpFiles = fs.readdirSync(baseEntityPath).filter(file => file.endsWith('.php'));
  if (phpFiles.length === 0) {
    console.log("BaseEntityPath: ", baseEntityPath);
    vscode.window.showErrorMessage("No PHP files found in the default folder.");
    return null;
  } else {
    vscode.window.showInformationMessage("Found " + phpFiles.length + " PHP files. Generating database schema...");
  }

  const entites = phpFiles.map(file => {
    const filePath = path.join(baseEntityPath, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    return { fileName: file, content: content };
  });

  const parseColumnsAndRelations = (phpCode, tableName) => {
    const columns = [];
    const relations = [];

    // regex to catch columns
    const columnRegex = /private\s+\??\s*(\w+)\s*\$(\w+)\s*=?\s*null?;/g;
    let match;

    while ((match = columnRegex.exec(phpCode)) !== null) {
      columns.push({
        name: match[2],
        type: match[1].toLowerCase(),
      });
    }

    // regex to catch relations
    const relationRegex = /#\[ORM\\(OneToMany|ManyToOne|ManyToMany|OneToOne)\(([^)]+)\)]/g;
    let relationMatch;

    while ((relationMatch = relationRegex.exec(phpCode)) !== null) {
      const relationType = relationMatch[1];
      const relationDetails = relationMatch[2];

      // targetEntity fetch
      const targetEntityMatch = /targetEntity:\s*([\w\\\\]+)::class/.exec(relationDetails);
      const targetEntity = targetEntityMatch ? targetEntityMatch[1].split('\\').pop().toLowerCase() : null;

      // mappedBy fetch
      const mappedByMatch = /mappedBy:\s*'(\w+)'/.exec(relationDetails);

      if (targetEntity) {
        relations.push({
          on: targetEntity,
          foreignKey: mappedByMatch ? mappedByMatch[1] : `${targetEntity}Id`,
          references: "id"
        });
      }
    }

    return { columns, relations };
  };

  const generateJSON = (fileName, columns, relations) => {
    return {
      table: fileName.replace('.php', '').toLowerCase(),
      columns: columns,
      relations: relations
    };
  };

  const databaseSchema = entites.map(entity => {
    const tableName = entity.fileName.replace('.php', '').toLowerCase();
    const { columns, relations } = parseColumnsAndRelations(entity.content, tableName);
    return generateJSON(entity.fileName, columns, relations);
  });

  return databaseSchema;
};

//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const simpleGit = require('simple-git');
const { execSync } = require('child_process');

module.exports.Parser = function (projectPath) {
  const basePath = (projectPath) => {
    const config = vscode.workspace.getConfiguration('DrawMeDatabase');
    const customPath = config.get('frameworkPath');
    return customPath.length > 0 ? path.join(projectPath, customPath) : projectPath;
  };

  const baseEntityPath = path.join(basePath(projectPath), 'src/Entity');

  if (!fs.existsSync(baseEntityPath)) {
    vscode.window.showErrorMessage("Default folder does not exist.");
    return null;
  }

  const phpFiles = fs.readdirSync(baseEntityPath).filter(file => file.endsWith('.php'));

  if (phpFiles.length === 0) {
    vscode.window.showErrorMessage("No PHP files found in the default folder.");
    return null;
  } else {
    vscode.window.showInformationMessage("Found " + phpFiles.length + " PHP files. Generating database schema...");
  }

  const git = simpleGit(projectPath);
  let statusSummary;
  try {
    statusSummary = execSync('git status --porcelain', { cwd: projectPath }).toString();
  } catch (error) {
    vscode.window.showErrorMessage("Git command failed.");
    return null;
  }

  const entites = phpFiles.map(file => {
    const filePath = path.join(baseEntityPath, file);
    const relativePath = path.relative(projectPath, filePath).replace(/\\/g, '/');

    const isUntracked = statusSummary.includes(`?? ${relativePath}`);
    let modifiedLines = [];

    if (!isUntracked) {
      try {
        const diff = execSync(`git diff --unified=0 -- "${relativePath}"`, { cwd: projectPath }).toString();
        const lineRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
        let match;
        while ((match = lineRegex.exec(diff)) !== null) {
          const startLine = parseInt(match[1], 10);
          const count = match[2] ? parseInt(match[2], 10) : 1;
          for (let i = 0; i < count; i++) {
            modifiedLines.push(startLine + i);
          }
        }
      } catch (e) {
        // No diff available — not a problem
      }
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    return { fileName: file, content, modifiedLines, isUntracked };
  });

  const parseColumnsAndRelations = (phpCode, tableName, modifiedLines, isUntracked) => {
    const columns = [];
    const relations = [];
    const lines = phpCode.split('\n');

    const columnRegex = /^\s*private\s+\??\s*([\\\w]+)\s*\$(\w+)/;

    lines.forEach((line, index) => {
      const match = columnRegex.exec(line);
      if (match) {
        const type = match[1].replace(/^\\/, '');
        const name = match[2];

        let gitStatus = "committed";
        const lineNumber = index + 1;
        if (isUntracked) {
          gitStatus = "untracked";
        } else if (modifiedLines.includes(lineNumber)) {
          gitStatus = "modified";
        }

        columns.push({ name, type, git: gitStatus });
      }
    });

    const relationRegex = /#\[ORM\\(OneToMany|ManyToOne|ManyToMany|OneToOne)\(([^)]+)\)]/g;
    let relationMatch;

    while ((relationMatch = relationRegex.exec(phpCode)) !== null) {
      const relationType = relationMatch[1];
      const relationDetails = relationMatch[2];

      const targetEntityMatch = /targetEntity:\s*([\w\\\\]+)::class/.exec(relationDetails);
      const targetEntity = targetEntityMatch ? targetEntityMatch[1].split('\\').pop().toLowerCase() : null;

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
    const { columns, relations } = parseColumnsAndRelations(
      entity.content,
      tableName,
      entity.modifiedLines,
      entity.isUntracked
    );
    return generateJSON(entity.fileName, columns, relations);
  });

  return databaseSchema;
};

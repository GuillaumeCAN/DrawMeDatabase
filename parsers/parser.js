//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const hasFiles = (projectPath, files) => {
  return files.every(file => fs.existsSync(path.join(projectPath, file)));
};

const getBasePath = (projectPath) => {
  const config = vscode.workspace.getConfiguration('DrawMeDatabase');
  const customPath = config.get('frameworkPath');
  return customPath.length > 0 ? projectPath + '/' + customPath : projectPath;
};

module.exports.detectFramework = function(projectPath) {
  const basePath = getBasePath(projectPath);

  // Détection Laravel
  if (hasFiles(basePath, ['artisan', 'composer.json'])) {
    const composerPath = path.join(basePath, 'composer.json');
    const composerData = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
    if (composerData.require && composerData.require['laravel/framework']) {
      return 'laravel';
    }
  }

  // Détection Symfony
  if (hasFiles(basePath, ['bin/console', 'composer.json'])) {
    const composerPath = path.join(basePath, 'composer.json');
    const composerData = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
    if (composerData.require && Object.keys(composerData.require).some(dep => dep.startsWith('symfony/'))) {
      return 'symfony';
    }
  }

  // Détection Django
  if (hasFiles(basePath, ['manage.py'])) {
    const requirementsPath = path.join(basePath, 'requirements.txt');
    const pyprojectPath = path.join(basePath, 'pyproject.toml');

    if (fs.existsSync(requirementsPath)) {
      const requirements = fs.readFileSync(requirementsPath, 'utf8');
      if (requirements.includes('Django')) {
        return 'django';
      }
    } else if (fs.existsSync(pyprojectPath)) {
      const pyproject = fs.readFileSync(pyprojectPath, 'utf8');
      if (pyproject.toLowerCase().includes('django')) {
        return 'django';
      }
    }
  }


  console.log("Base path used for detection:", basePath);
  return 'Unknown';
};

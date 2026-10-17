//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

const fs = require('fs');
const path = require('path');
const { ParserError } = require('./errors');

const isFile = (filePath) => {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
};

// The "require" section of composer.json, or null when there is no composer.json.
// Throws a ParserError when the file cannot be read or is not valid JSON.
const readComposerRequire = (basePath) => {
    const composerPath = path.join(basePath, 'composer.json');
    if (!isFile(composerPath)) {
        return null;
    }
    let composer;
    try {
        // Strip a UTF-8 BOM, JSON.parse rejects it
        composer = JSON.parse(fs.readFileSync(composerPath, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err) {
        throw new ParserError(`composer.json in "${basePath}" could not be read: ${err.message}`);
    }
    const dependencies = composer && composer.require;
    return dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies) ? dependencies : {};
};

// Returns 'laravel', 'symfony' or 'Unknown' for the framework root basePath
// (ParserError: invalid composer.json)
module.exports.detectFramework = function (basePath) {
    if (typeof basePath !== 'string' || basePath === '') {
        return 'Unknown';
    }

    const dependencies = readComposerRequire(basePath);
    const packages = dependencies ? Object.keys(dependencies) : [];

    // Laravel Detection
    if (isFile(path.join(basePath, 'artisan')) && packages.includes('laravel/framework')) {
        return 'laravel';
    }

    // Symfony Detection: symfony/framework-bundle, else any symfony/* package except the polyfills
    // (they are pulled by many non-Symfony projects)
    if (isFile(path.join(basePath, 'bin', 'console'))) {
        if (packages.includes('symfony/framework-bundle')
            || packages.some(name => name.startsWith('symfony/') && !name.startsWith('symfony/polyfill-'))) {
            return 'symfony';
        }
    }

    /*
    // Django Detection
    if (isFile(path.join(basePath, 'manage.py'))) {
        const requirementsPath = path.join(basePath, 'requirements.txt');
        const pyprojectPath = path.join(basePath, 'pyproject.toml');

        if (isFile(requirementsPath)) {
            const requirements = fs.readFileSync(requirementsPath, 'utf8');
            if (requirements.includes('Django')) {
                return 'django';
            }
        } else if (isFile(pyprojectPath)) {
            const pyproject = fs.readFileSync(pyprojectPath, 'utf8');
            if (pyproject.toLowerCase().includes('django')) {
                return 'django';
            }
        }
    }
    */

    return 'Unknown';
};

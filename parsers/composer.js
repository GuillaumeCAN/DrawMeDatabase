//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// composer.json of a PHP project, for the detection of the Laravel and Symfony parsers

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
        composer = JSON.parse(fs.readFileSync(composerPath, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
        throw new ParserError(`composer.json in "${basePath}" could not be read: ${err.message}`);
    }
    const dependencies = composer && composer.require;
    return dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies) ? dependencies : {};
};

// The names of the packages required by composer.json (none without composer.json)
const composerPackages = (basePath) => Object.keys(readComposerRequire(basePath) || {});

module.exports = { isFile, readComposerRequire, composerPackages };

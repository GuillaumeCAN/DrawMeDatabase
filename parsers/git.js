//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Git status of the lines that declare tables and columns, shared by the parsers:
// 'committed', 'modified' (changed since HEAD), 'untracked' (not in HEAD: new, ignored or
// staged-new) and 'unsaved' (changed in an editor and not saved yet, see `overrides`).
// git runs a fixed number of times for the sources of a parser (never with a shell), and its
// result can be cached while only unsaved editors change.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const toPosix = (filePath) => filePath.split(path.sep).join('/');

// Options that keep git output stable whatever the user or repository config says
const GIT_OPTIONS = [
    '-c', 'core.quotepath=off',
    '-c', 'color.ui=never',
    '-c', 'core.fsmonitor=',
    '-c', 'diff.interHunkContext=0',
    '-c', 'diff.submodule=short',
    '-c', 'diff.suppressBlankEmpty=false',
    '--no-optional-locks',
    '--literal-pathspecs',
];



function git(cwd, args) {
    // Without the variables that change the diff output (context lines, external diff tool)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_(DIFF_OPTS|EXTERNAL_DIFF)$/i.test(key)));
    return childProcess.execFileSync('git', [...GIT_OPTIONS, ...args], {
        cwd,
        // English messages, for gitErrorReason
        env: { ...env, LC_ALL: 'C' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
        timeout: 15000,
        windowsHide: true,
    });
}

// Path of a '+++ ' diff header: git adds a tab after names with spaces and C-quotes special names
function diffPath(text) {
    const value = text.replace(/\t$/, '');
    if (!(value.length > 1 && value.startsWith('"') && value.endsWith('"'))) {
        return value;
    }
    const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
    const raw = Buffer.from(value.slice(1, -1), 'utf8');
    const bytes = [];
    for (let i = 0; i < raw.length; i++) {
        if (raw[i] !== 0x5c) {
            bytes.push(raw[i]);
            continue;
        }
        const next = raw[++i];
        if (next >= 0x30 && next <= 0x37) {
            bytes.push(parseInt(raw.toString('latin1', i, i + 3), 8));
            i += 2;
        } else {
            bytes.push(escapes[String.fromCharCode(next)] || next);
        }
    }
    return Buffer.from(bytes).toString('utf8');
}

// Changed lines per file of a `git diff --unified=0`: { isNew, lines: Set, deletions: [] }.
// Only '+' and '-' lines count: context lines, if git prints any, are not changes.
function parseDiff(output) {
    const files = new Map();
    let current = null;
    let inHeader = false;
    let isNew = false;
    let lineNumber = 0;

    for (const line of output.split('\n')) {
        if (line.startsWith('diff --git ')) {
            current = null;
            inHeader = true;
            isNew = false;
            continue;
        }
        if (inHeader && line.startsWith('--- ')) {
            isNew = line === '--- /dev/null';
            continue;
        }
        if (inHeader && line.startsWith('+++ ')) {
            const target = diffPath(line.slice(4));
            if (target !== '/dev/null') {
                current = { isNew, lines: new Set(), deletions: [] };
                files.set(target.replace(/^b\//, ''), current);
            }
            continue;
        }

        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk) {
            inHeader = false;
            // Number of the next new line (an empty new side gives the line before the removal)
            lineNumber = parseInt(hunk[1], 10) + (hunk[2] === '0' ? 1 : 0);
        } else if (current && !inHeader && line[0] === '+') {
            current.lines.add(lineNumber++);
        } else if (current && !inHeader && line[0] === '-') {
            // Line removed after line `lineNumber - 1`
            current.deletions.push(lineNumber - 1);
        } else if (line[0] === ' ') {
            lineNumber++;
        }
    }
    return files;
}

// Reads into `state` the files under the paths `relPaths` (folders or files, from `root`) of the
// repository at `root` that are not in HEAD (untracked, ignored, staged-new) and the changed lines
// of the others, as paths from `root` prefixed with `prefix`. A changed submodule is read the same
// way, against its own HEAD.
function readRepository(root, relPaths, prefix, hasHead, state) {
    const entries = git(root, ['status', '--porcelain=v1', '-z', '-uall', '--ignored', '--ignore-submodules=none', '--', ...relPaths]).split('\0');
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.length < 4) {
            continue;
        }
        const xy = entry.slice(0, 2);
        const file = entry.slice(3);
        if (xy === '??' || xy === '!!' || 'ARC'.includes(xy[0]) || xy[1] === 'A') {
            state.notInHead.add(prefix + file);
        } else if (xy.includes('M') && fs.existsSync(path.join(root, file, '.git'))) {
            readRepository(path.join(root, file), ['.'], `${prefix}${file}/`, true, state);
        }
        if (xy[0] === 'R' || xy[0] === 'C') {
            i++; // the original path follows
        }
    }

    if (hasHead) {
        const diff = git(root, ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--text',
            '--unified=0', '--src-prefix=a/', '--dst-prefix=b/', '--', ...relPaths]);
        for (const [file, change] of parseDiff(diff)) {
            state.changes.set(prefix + file, change);
        }
    }
}

// Returns a function (filePath) → (firstLine, lastLine) → 'committed' | 'modified' | 'untracked'
// for the files under `paths` (a folder, or a list of folders and files that exist). The repository
// is the one of the first path; the paths outside of it are left out. Throws when git is not usable
// for these paths.
function readGitStatus(paths) {
    const real = (Array.isArray(paths) ? paths : [paths]).map(item => fs.realpathSync(item));
    if (real.length === 0) {
        throw new Error('no folder to read');
    }
    const first = fs.statSync(real[0]).isDirectory() ? real[0] : path.dirname(real[0]);
    const root = git(first, ['rev-parse', '--show-toplevel']).trim();
    if (!root) {
        throw new Error('no work tree');
    }
    const relPaths = [...new Set(real.map(item => toPosix(path.relative(root, item)) || '.'))]
        .filter(relPath => !relPath.startsWith('..'));
    if (relPaths.length === 0) {
        throw new Error('the entity folder is outside of the repository');
    }

    let hasHead = true;
    try {
        git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    } catch {
        hasHead = false;
    }

    const notInHead = new Set();
    const changes = new Map();
    readRepository(root, relPaths, '', hasHead, { notInHead, changes });

    return (filePath) => {
        const rel = toPosix(path.relative(root, fs.realpathSync(filePath)));
        const change = changes.get(rel);
        const isNew = !hasHead || notInHead.has(rel) || Boolean(change && change.isNew);

        const status = (first, last) => {
            if (isNew) {
                return 'untracked';
            }
            if (change) {
                for (let line = first; line <= last; line++) {
                    if (change.lines.has(line)) {
                        return 'modified';
                    }
                }
                // Lines removed inside the declaration
                if (change.deletions.some(line => line >= first && line < last)) {
                    return 'modified';
                }
            }
            return 'committed';
        };
        // Whether a line is not in HEAD: added since HEAD, or in a file that is not in HEAD
        status.added = (line) => isNew || Boolean(change && change.lines.has(line));
        return status;
    };
}

function gitErrorReason(error) {
    if (error.code === 'ENOENT') {
        return 'git is not installed';
    }
    const stderr = String(error.stderr || '');
    if (/not a git repository/i.test(stderr)) {
        return 'not a git repository';
    }
    const firstLine = (stderr.trim() || error.message || '').split('\n')[0];
    return firstLine.replace(/^fatal:\s*/, '') || 'git failed';
}

// ---------------------------------------------------------------------------------------------
// Unsaved editors

// Lines of `text` without the trailing line break and BOM, for comparisons
const splitLines = (text) => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');

// For each line of the editor text (1-based), the same line of the saved file, or 0 when the line
// is new or changed. Common start and end are matched first, the middle with a longest common
// subsequence (edits are small); a very large middle is treated as changed.
function lineMapping(savedText, editorText) {
    const saved = splitLines(savedText);
    const edited = splitLines(editorText);
    const map = new Array(edited.length + 1).fill(0);

    let start = 0;
    while (start < saved.length && start < edited.length && saved[start] === edited[start]) {
        map[start + 1] = start + 1;
        start++;
    }
    let endSaved = saved.length;
    let endEdited = edited.length;
    while (endSaved > start && endEdited > start && saved[endSaved - 1] === edited[endEdited - 1]) {
        map[endEdited] = endSaved;
        endSaved--;
        endEdited--;
    }

    const rows = endSaved - start;
    const cols = endEdited - start;
    if (rows > 0 && cols > 0 && rows * cols <= 4e6) {
        // lcs[i][j]: longest common subsequence of saved[start + i..] and edited[start + j..]
        const lcs = Array.from({ length: rows + 1 }, () => new Uint16Array(cols + 1));
        for (let i = rows - 1; i >= 0; i--) {
            for (let j = cols - 1; j >= 0; j--) {
                lcs[i][j] = saved[start + i] === edited[start + j]
                    ? lcs[i + 1][j + 1] + 1
                    : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < rows && j < cols) {
            if (saved[start + i] === edited[start + j]) {
                map[start + j + 1] = start + i + 1;
                i++;
                j++;
            } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
                i++;
            } else {
                j++;
            }
        }
    }
    return map;
}

// ---------------------------------------------------------------------------------------------
// Status reader

// The paths git reads for `sources`: a folder, a list of paths, or the { folders, files } of the
// sources() of a parser (docs/parsers.md)
function sourcePaths(sources) {
    if (typeof sources === 'string') {
        return [sources];
    }
    if (Array.isArray(sources)) {
        return sources.filter(item => typeof item === 'string');
    }
    const folders = sources && Array.isArray(sources.folders) ? sources.folders : [];
    const files = sources && Array.isArray(sources.files) ? sources.files : [];
    return [...folders.map(folder => (typeof folder === 'string' ? folder : folder && folder.path)), ...files]
        .filter(item => typeof item === 'string' && item !== '');
}

const exists = (filePath) => {
    try {
        fs.statSync(filePath);
        return true;
    } catch {
        return false;
    }
};

// Status of line ranges of the files of `sources` (a folder, or the sources() of a parser: git
// reads its folders and files, the missing ones left out): reader.statusOf(filePath)(firstLine,
// lastLine) returns 'unsaved', 'untracked', 'modified', 'committed', or null when there is no
// information (git disabled or unavailable, and no unsaved change). Lines are those of the parsed
// text, which is the editor text for the files of `overrides` (Map: absolute path → text).
// reader.addedOf(filePath)(line) tells whether a line is not in HEAD: added since HEAD (or in a
// file that is not in HEAD), or typed in an editor and not saved; false without git. A parser whose
// declarations share a file (the models of a Prisma schema) uses it to tell a new declaration from
// a modified one.
// options: git (false: no git), overrides, cache (Map reused between parses: git runs again only
// once the cache is cleared). reader.warning: why the git status is missing, if it should be told.
function createStatusReader(sources, { git: useGit = true, overrides = null, cache = null } = {}) {
    let gitStatus = null;
    let warning = null;
    const paths = sourcePaths(sources);
    if (useGit && paths.length > 0) {
        const key = paths.map(item => {
            try {
                return fs.realpathSync(item);
            } catch {
                return item;
            }
        }).join('\0');
        if (cache && cache.has(key)) {
            ({ gitStatus, warning } = cache.get(key));
        } else {
            // The missing folders and files (a config file the project does not have) are left out
            const existing = paths.filter(exists);
            try {
                gitStatus = existing.length > 0 ? readGitStatus(existing) : null;
            } catch (error) {
                // Outside a repository there is simply no git status: only real failures are told
                const reason = gitErrorReason(error);
                warning = reason === 'not a git repository' ? null : `Git status is not shown: ${reason}.`;
            }
            if (cache) {
                cache.set(key, { gitStatus, warning });
            }
        }
    }

    const byFile = new Map();
    const fileStatus = (filePath) => {
        let saved = null;
        try {
            saved = fs.readFileSync(filePath, 'utf8');
        } catch {
            saved = null;
        }
        const edited = overrides ? overrides.get(filePath) : undefined;
        let committed = null;
        if (gitStatus && saved !== null) {
            try {
                committed = gitStatus(filePath);
            } catch {
                committed = null;
            }
        }
        // Whether a line of the saved file is not in HEAD (false without git)
        const savedAdded = (line) => Boolean(committed && typeof committed.added === 'function' && line > 0 && committed.added(line));
        // A file that only exists in an editor
        if (edited !== undefined && saved === null) {
            return { status: () => 'unsaved', added: () => true };
        }
        if (edited === undefined || splitLines(edited).join('\n') === splitLines(saved).join('\n')) {
            return { status: (first, last) => (committed ? committed(first, last) : null), added: savedAdded };
        }
        const map = lineMapping(saved, edited);
        return {
            status: (first, last) => {
                let previous = 0;
                for (let line = first; line <= last; line++) {
                    const savedLine = map[line] || 0;
                    // A new or changed line, or saved lines removed inside the range
                    if (savedLine === 0 || (previous && savedLine !== previous + 1)) {
                        return 'unsaved';
                    }
                    previous = savedLine;
                }
                return committed ? committed(map[first], map[last]) : null;
            },
            // A line typed in the editor is not in HEAD; the others are lines of the saved file
            added: (line) => !map[line] || savedAdded(map[line]),
        };
    };
    const fileEntry = (filePath) => {
        if (!byFile.has(filePath)) {
            byFile.set(filePath, fileStatus(filePath));
        }
        return byFile.get(filePath);
    };

    return {
        warning,
        statusOf: (filePath) => fileEntry(filePath).status,
        addedOf: (filePath) => fileEntry(filePath).added,
    };
}

// Status of a table from the status of its declaration and of its columns: a table being edited
// is 'unsaved', a table that is not in HEAD 'untracked', a table with changed columns 'modified'
const STATUS_RANK = { committed: 0, modified: 1, untracked: 2, unsaved: 3 };

function tableStatus(declaration, columns) {
    if (declaration === 'unsaved' || declaration === 'untracked') {
        return declaration;
    }
    const known = columns.filter(status => status);
    if (known.includes('unsaved')) {
        return 'unsaved';
    }
    if (declaration === 'modified' || known.some(status => STATUS_RANK[status] > 0)) {
        return 'modified';
    }
    return declaration || (known.length > 0 ? 'committed' : null);
}

module.exports = { readGitStatus, gitErrorReason, parseDiff, lineMapping, createStatusReader, sourcePaths, tableStatus };

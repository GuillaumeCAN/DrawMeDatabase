//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Shared by both viewers: reads the embedded tables and handles the viewer selector
(function () {
    'use strict';

    // acquireVsCodeApi() may only be called once per page
    const vscode = acquireVsCodeApi();

    let data = null;
    let error = null;
    try {
        const element = document.getElementById('dmdb-data');
        data = JSON.parse(element ? element.textContent : '');
        if (!Array.isArray(data)) {
            throw new Error('the schema data is not a list of tables');
        }
    } catch (err) {
        data = null;
        error = err;
    }

    const select = document.getElementById('viewer-select');
    if (select) {
        select.addEventListener('change', () => {
            vscode.postMessage({ command: 'changeViewer', viewer: select.value });
        });
    }

    window.DrawMeDatabase = { data, error };
})();

//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// JSON viewer: shows the parsed tables and copies them to the clipboard
(function () {
    'use strict';

    const app = window.DrawMeDatabase;
    const output = document.getElementById('json-output');
    const copyButton = document.getElementById('copy-btn');

    // Show toast notification
    function showToast(message) {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.classList.add('show');
        setTimeout(() => {
            toast.classList.remove('show');
        }, 4000);
    }

    if (!app || app.error) {
        output.classList.add('error');
        output.textContent = 'Unable to read the schema data: '
            + (app && app.error && app.error.message ? app.error.message : 'unknown error');
        copyButton.disabled = true;
        return;
    }

    const jsonText = JSON.stringify(app.data, null, 2);
    output.textContent = jsonText;

    // Copy JSON data to clipboard
    copyButton.addEventListener('click', () => {
        navigator.clipboard.writeText(jsonText).then(() => {
            showToast('JSON code successfully copied!');
        }).catch(err => {
            console.error('Error while copying: ', err);
            showToast('Unable to copy the JSON code.');
        });
    });
})();

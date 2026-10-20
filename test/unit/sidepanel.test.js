//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// The side panel of the pages (views/sidepanel.js) in a minimal DOM: the actions, greyed when a
// feature of DrawMeDatabase Pro is missing or locked, or when a tool does not apply to the project.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', '..', 'views', 'sidepanel.js'), 'utf8');

// The parts of the DOM that the side panel uses
class FakeNode {
    constructor(tag) {
        this.tagName = tag;
        this.attributes = new Map();
        this.children = [];
        this.listeners = new Map();
        this.className = '';
        this.text = '';
        this.dataset = {};
    }

    set textContent(value) {
        this.text = String(value);
        this.children = [];
    }

    get textContent() {
        return this.text + this.children.map(child => child.textContent).join('');
    }

    setAttribute(name, value) {
        this.attributes.set(name, value);
        if (name === 'class') {
            this.className = value;
        }
        if (name.startsWith('data-')) {
            this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
        }
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }

    addEventListener(type, listener) {
        this.listeners.set(type, listener);
    }

    click() {
        this.listeners.get('click')();
    }

    contains(node) {
        return node === this || this.children.some(child => child.contains(node));
    }

    // Every node of the tree, this one first
    all() {
        return [this, ...this.children.flatMap(child => child.all())];
    }

    querySelector(selector) {
        return this.all().slice(1).find(node => selector.startsWith('.') && node.className.split(' ').includes(selector.slice(1))) || null;
    }

    querySelectorAll(selector) {
        return selector === '[data-key]' ? this.all().slice(1).filter(node => node.attributes.has('data-key')) : [];
    }

    focus() {}
}

function loadSidePanel() {
    const window = {};
    const document = {
        activeElement: null,
        createElement: (tag) => Object.assign(new FakeNode(tag), tag === 'canvas' ? { getContext: () => ({ fillStyle: '#000000' }) } : {}),
        createElementNS: (namespace, tag) => new FakeNode(tag),
    };
    vm.runInNewContext(SCRIPT, { window, document, getComputedStyle: () => ({ getPropertyValue: () => '' }) });
    return window.DrawMeDatabaseSidePanel;
}

test('the actions: available, missing (PRO badge), locked (a lock), unavailable (greyed with its reason, as given, without a badge); greyed items stay clickable', () => {
    const container = new FakeNode('div');
    const actions = [];
    const panel = loadSidePanel().create({ element: container, onAction: (id) => actions.push(id) });
    panel.render({
        title: 'Options',
        closeLabel: 'Close',
        sections: [{
            id: 'tools',
            title: 'Tools',
            items: [{
                type: 'actions',
                items: [
                    { id: 'canvas', label: 'Schema canvas', hint: 'Move the tables', icon: 'canvas' },
                    { id: 'designer', label: 'Design a table', icon: 'designer', state: 'missing', badge: 'PRO', title: 'Available with DrawMeDatabase Pro' },
                    { id: 'checks', label: 'Check the schema', icon: 'checks', state: 'locked', badge: 'PRO' },
                    { id: 'models', label: 'Eloquent models', hint: 'With their relationships', icon: 'code', state: 'unavailable', badge: 'PRO', title: 'ignored', reason: 'Eloquent models are for Laravel projects.' },
                    { id: 'odd', label: 'Odd', state: 'weird' },
                ],
            }],
        }],
    });
    const button = (id) => container.querySelectorAll('[data-key]').find(node => node.getAttribute('data-key') === id);
    const hint = (node) => node.all().find(child => child.className === 'panel-action-hint');
    const badge = (node) => node.all().find(child => child.className === 'panel-badge');
    assert.equal(button('canvas').className, 'panel-action available');
    assert.equal(button('canvas').getAttribute('aria-disabled'), null);
    assert.equal(hint(button('canvas')).textContent, 'Move the tables');
    assert.equal(button('designer').className, 'panel-action missing');
    assert.equal(button('designer').getAttribute('title'), 'Available with DrawMeDatabase Pro');
    assert.equal(badge(button('designer')).textContent, 'PRO');
    assert.equal(button('checks').className, 'panel-action locked');
    assert.ok(button('checks').all().some(child => child.getAttribute('class') === 'panel-action-lock'));
    const models = button('models');
    assert.equal(models.className, 'panel-action unavailable');
    assert.equal(models.getAttribute('aria-disabled'), 'true');
    assert.equal(models.getAttribute('title'), 'Eloquent models are for Laravel projects.');
    assert.equal(hint(models).textContent, 'Eloquent models are for Laravel projects.', 'its reason instead of its hint');
    assert.equal(badge(models), undefined);
    assert.equal(button('odd').className, 'panel-action available', 'an unknown state');
    models.click();
    button('designer').click();
    assert.deepEqual(actions, ['models', 'designer']);
});

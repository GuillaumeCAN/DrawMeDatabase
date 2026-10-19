//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

const test = require('node:test');
const assert = require('node:assert/strict');

const zoom = require('../../views/mermaid/zoom');

const VIEWPORT = { width: 1000, height: 600 };

test('zoomAt keeps the point under the cursor in place', () => {
    const view = { scale: 1, x: 100, y: 50 };
    const next = zoom.zoomAt(view, 2, 300, 250);
    assert.equal(next.scale, 2);
    // The diagram point under the cursor, before and after
    const before = { x: (300 - view.x) / view.scale, y: (250 - view.y) / view.scale };
    const after = { x: (300 - next.x) / next.scale, y: (250 - next.y) / next.scale };
    assert.deepEqual(after, before);
});

test('the scale stays between the limits', () => {
    assert.equal(zoom.zoomAt({ scale: 1, x: 0, y: 0 }, 1000, 0, 0).scale, zoom.MAX_SCALE);
    assert.equal(zoom.zoomAt({ scale: 1, x: 0, y: 0 }, 0.0001, 0, 0).scale, zoom.MIN_SCALE);
    assert.equal(zoom.clampScale(NaN), 1);
});

test('the + and - buttons go through the zoom levels', () => {
    assert.equal(zoom.stepScale(1, 1), 1.1);
    assert.equal(zoom.stepScale(1, -1), 0.9);
    assert.equal(zoom.stepScale(0.42, 1), 0.5);
    assert.equal(zoom.stepScale(0.42, -1), 0.33);
    assert.equal(zoom.stepScale(zoom.MAX_SCALE, 1), zoom.MAX_SCALE);
    assert.equal(zoom.stepScale(zoom.MIN_SCALE, -1), zoom.MIN_SCALE);
});

test('fit shows the whole diagram, centered, never above 100 %', () => {
    const large = zoom.fitView({ width: 4000, height: 1000 }, VIEWPORT);
    assert.ok(large.scale < 1);
    assert.ok(Math.abs(4000 * large.scale - (VIEWPORT.width - 48)) < 1e-9, 'fills the width minus the padding');
    assert.ok(Math.abs(large.x - (VIEWPORT.width - 4000 * large.scale) / 2) < 1e-9);
    assert.ok(Math.abs(large.y - (VIEWPORT.height - 1000 * large.scale) / 2) < 1e-9);

    const small = zoom.fitView({ width: 200, height: 100 }, VIEWPORT);
    assert.deepEqual(small, { scale: 1, x: 400, y: 250 });
});

test('100 % is centered when it fits, else starts at the top left corner', () => {
    assert.deepEqual(zoom.actualSizeView({ width: 200, height: 100 }, VIEWPORT), { scale: 1, x: 400, y: 250 });
    assert.deepEqual(zoom.actualSizeView({ width: 5000, height: 3000 }, VIEWPORT), { scale: 1, x: 24, y: 24 });
});

test('a diagram dragged away stays partly on screen', () => {
    const content = { width: 2000, height: 1000 };
    assert.deepEqual(zoom.constrain({ scale: 1, x: 5000, y: 5000 }, content, VIEWPORT), { scale: 1, x: 952, y: 552 });
    assert.deepEqual(zoom.constrain({ scale: 1, x: -5000, y: -5000 }, content, VIEWPORT), { scale: 1, x: -1952, y: -952 });
    const inside = { scale: 0.5, x: 10, y: 20 };
    assert.deepEqual(zoom.constrain(inside, content, VIEWPORT), inside);
});

test('a saved view is used only when it is complete and finite', () => {
    assert.deepEqual(zoom.sanitizeView({ scale: 0.5, x: 1, y: 2 }), { scale: 0.5, x: 1, y: 2 });
    assert.deepEqual(zoom.sanitizeView({ scale: 50, x: 1, y: 2 }), { scale: zoom.MAX_SCALE, x: 1, y: 2 });
    for (const value of [null, undefined, 'x', {}, { scale: 1, x: 0 }, { scale: 1, x: NaN, y: 0 }, { scale: '1', x: 0, y: 0 }]) {
        assert.equal(zoom.sanitizeView(value), null, JSON.stringify(value));
    }
});

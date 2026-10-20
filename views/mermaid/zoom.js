//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Zoom and pan of the diagram: a CSS transform (translate, then scale) on the element that
// holds the SVG. The view math is pure (unit tested); attach() wires the mouse, the wheel and
// the keyboard of the viewport. Loaded by the webview (classic script) and by the unit tests.
(function (root) {
    'use strict';

    const MIN_SCALE = 0.05;
    const MAX_SCALE = 4;
    // Zoom levels of the + and - buttons
    const STEPS = [0.05, 0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
    const PADDING = 24;
    // How much of the diagram stays on screen when it is dragged away (pixels)
    const KEEP_VISIBLE = 48;

    const clampScale = (scale) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number.isFinite(scale) ? scale : 1));

    // The view after zooming by factor, the point (px, py) of the viewport staying in place
    function zoomAt(view, factor, px, py) {
        const scale = clampScale(view.scale * factor);
        const ratio = scale / view.scale;
        return { scale, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio };
    }

    // The next zoom level up (direction 1) or down (-1)
    function stepScale(scale, direction) {
        if (direction > 0) {
            return STEPS.find(step => step > scale + 1e-6) || MAX_SCALE;
        }
        return [...STEPS].reverse().find(step => step < scale - 1e-6) || MIN_SCALE;
    }

    // The whole diagram in the viewport, never enlarged above 100 %, centered
    function fitView(content, viewport) {
        const scale = clampScale(Math.min(
            1,
            (viewport.width - 2 * PADDING) / Math.max(content.width, 1),
            (viewport.height - 2 * PADDING) / Math.max(content.height, 1),
        ));
        return centered(content, viewport, scale);
    }

    // 100 %: centered when it fits, else from the top left corner
    function actualSizeView(content, viewport) {
        const view = centered(content, viewport, 1);
        return {
            scale: 1,
            x: content.width + 2 * PADDING > viewport.width ? PADDING : view.x,
            y: content.height + 2 * PADDING > viewport.height ? PADDING : view.y,
        };
    }

    function centered(content, viewport, scale) {
        return {
            scale,
            x: (viewport.width - content.width * scale) / 2,
            y: (viewport.height - content.height * scale) / 2,
        };
    }

    // Keeps part of the diagram on screen, so it cannot be lost by dragging it away
    function constrain(view, content, viewport) {
        const width = content.width * view.scale;
        const height = content.height * view.scale;
        const keepX = Math.min(KEEP_VISIBLE, width);
        const keepY = Math.min(KEEP_VISIBLE, height);
        return {
            scale: view.scale,
            x: Math.min(viewport.width - keepX, Math.max(keepX - width, view.x)),
            y: Math.min(viewport.height - keepY, Math.max(keepY - height, view.y)),
        };
    }

    // A view read back from the saved state, or null when it is not usable
    function sanitizeView(value) {
        if (!value || typeof value !== 'object') {
            return null;
        }
        const { scale, x, y } = value;
        if (![scale, x, y].every(Number.isFinite)) {
            return null;
        }
        return { scale: clampScale(scale), x, y };
    }

    // Wires the viewport: drag to pan, wheel to scroll, Ctrl/Cmd + wheel (and pinch) to zoom,
    // keyboard when the viewport has the focus. onChange(view) is called after every change.
    function attach(viewport, stage, onChange) {
        let view = { scale: 1, x: 0, y: 0 };
        let content = { width: 0, height: 0 };
        let drag = null;

        const size = () => ({ width: viewport.clientWidth, height: viewport.clientHeight });

        function apply(next, notify = true) {
            view = content.width > 0 ? constrain(next, content, size()) : next;
            stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
            if (notify && onChange) {
                onChange(view);
            }
        }

        const center = () => ({ x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 });

        viewport.addEventListener('wheel', event => {
            event.preventDefault();
            if (event.ctrlKey || event.metaKey) {
                const rect = viewport.getBoundingClientRect();
                // Pinch gestures send small deltas, mouse wheels about 100 per notch
                const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.002));
                apply(zoomAt(view, factor, event.clientX - rect.left, event.clientY - rect.top));
                return;
            }
            const unit = event.deltaMode === 1 ? 16 : 1;
            const dx = (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit;
            const dy = (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit;
            apply({ scale: view.scale, x: view.x - dx, y: view.y - dy });
        }, { passive: false });

        viewport.addEventListener('pointerdown', event => {
            if (event.button !== 0 && event.button !== 1) {
                return;
            }
            drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: view.x, y: view.y, moved: false };
            try {
                viewport.setPointerCapture(event.pointerId);
            } catch {
                // No active pointer (synthetic event): the drag still works inside the viewport
            }
        });
        viewport.addEventListener('pointermove', event => {
            if (!drag || drag.id !== event.pointerId) {
                return;
            }
            const dx = event.clientX - drag.startX;
            const dy = event.clientY - drag.startY;
            if (!drag.moved && Math.hypot(dx, dy) < 4) {
                return;
            }
            drag.moved = true;
            viewport.classList.add('dragging');
            apply({ scale: view.scale, x: drag.x + dx, y: drag.y + dy });
        });
        const endDrag = (event) => {
            if (!drag || drag.id !== event.pointerId) {
                return;
            }
            // A drag is not a click (a click on a table opens its file)
            if (drag.moved) {
                viewport.addEventListener('click', stopClick, { capture: true, once: true });
            }
            drag = null;
            viewport.classList.remove('dragging');
        };
        const stopClick = (event) => event.stopPropagation();
        viewport.addEventListener('pointerup', endDrag);
        viewport.addEventListener('pointercancel', endDrag);

        viewport.addEventListener('keydown', event => {
            if (event.altKey || event.target !== viewport) {
                return;
            }
            const step = event.shiftKey ? 200 : 40;
            const actions = {
                '+': () => controller.zoomIn(),
                '=': () => controller.zoomIn(),
                '-': () => controller.zoomOut(),
                '0': () => controller.actualSize(),
                'f': () => controller.fit(),
                'ArrowLeft': () => apply({ ...view, x: view.x + step }),
                'ArrowRight': () => apply({ ...view, x: view.x - step }),
                'ArrowUp': () => apply({ ...view, y: view.y + step }),
                'ArrowDown': () => apply({ ...view, y: view.y - step }),
            };
            const action = actions[event.key];
            if (action && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                action();
            }
        });

        // Keeps the diagram reachable when the panel is resized
        new ResizeObserver(() => {
            if (content.width > 0) {
                apply(view, false);
            }
        }).observe(viewport);

        const controller = {
            // New content (width, height of the SVG): the saved view, or fit when there is none
            setContent(newContent, savedView) {
                content = newContent;
                apply(sanitizeView(savedView) || fitView(content, size()));
            },
            zoomIn() {
                const point = center();
                apply(zoomAt(view, stepScale(view.scale, 1) / view.scale, point.x, point.y));
            },
            zoomOut() {
                const point = center();
                apply(zoomAt(view, stepScale(view.scale, -1) / view.scale, point.x, point.y));
            },
            fit() {
                apply(fitView(content, size()));
            },
            actualSize() {
                apply(actualSizeView(content, size()));
            },
            get view() {
                return view;
            },
        };
        return controller;
    }

    const api = { MIN_SCALE, MAX_SCALE, clampScale, zoomAt, stepScale, fitView, actualSizeView, constrain, sanitizeView, attach };
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.DrawMeDatabaseZoom = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);

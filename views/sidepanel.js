//
// Copyright (c) 2025 Guillaume Cancalon - All rights reserved
//
// This file is part of DrawMeDatabase, and is released under the "GNU GENERAL PUBLIC LICENSE".
// Please see the LICENSE file that should have been included as part of this package.
//

// Side panel of the pages: options, appearance, tools and exports, drawn from a description
// (render(model)) so the pages of other extensions can use it too. Text is always set with
// textContent: nothing of the model is read as HTML.
//
// model: { title, closeLabel, sections: [{ id, title, items }], footer }
// items: { type: 'choice' | 'select', id, label, value, options: [{ value, label }] }
//        { type: 'toggle', id, label, hint, value }
//        { type: 'range', id, label, value, min, max, step, unit }
//        { type: 'text', id, label, value, placeholder }
//        { type: 'palettes', id, label, value, options: [{ value, label, colors }] }
//        { type: 'colors', id, label, resetLabel, items: [{ key, label, value, custom }] }
//        { type: 'actions', items: [{ id, label, hint, icon, state, badge, title }] }
//          state: 'available', 'missing' (greyed, PRO badge) or 'locked' (greyed, lock)
//        { type: 'button', id, label, primary }
//        { type: 'heading', label } and { type: 'note', text }
// footer: { title, text, buttons: [{ id, label, primary }] }
//
// onChange(id, value, { preview }) for the controls (preview: while a color or a size is being
// picked), onAction(id) for the actions and buttons.
(function () {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';
    // 16×16 stroked icons
    const ICONS = {
        canvas: 'M2 3h5v4H2zM9 9h5v4H9zM7 5h3.5v4',
        designer: 'M2 3h12v10H2zM2 6.5h12M6 6.5V13M11 8.5v3M9.5 10h3',
        columns: 'M2 3h12v10H2zM2 6.5h12M8 8.5v3M6.5 10h3',
        compare: 'M5 2v9M2.5 8.5 5 11l2.5-2.5M11 14V5M8.5 7.5 11 5l2.5 2.5',
        migration: 'M3 2h7l3 3v9H3zM10 2v3h3M6 9h4M8 7v4',
        checks: 'M8 2 3 4v4c0 3 2.2 5 5 6 2.8-1 5-3 5-6V4zM5.8 8.2 7.4 9.8 10.4 6.6',
        path: 'M4 4.5a1.5 1.5 0 1 0 0-.01M12 11.5a1.5 1.5 0 1 0 0-.01M5.5 4.5H9a2 2 0 0 1 0 4H7a2 2 0 0 0 0 4h3.5',
        view: 'M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4zM8 6.3a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4',
        bookmark: 'M4 2h8v12l-4-3-4 3z',
        code: 'M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4',
        file: 'M4 2h5l3 3v9H4zM9 2v3h3',
        image: 'M2 3h12v10H2zM2 11l3.5-3.5 3 3 2-2L14 12M10.5 6a1 1 0 1 0 0-.01',
        copy: 'M5 5h8v9H5zM3 11V2h8',
        database: 'M3 4c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2zM3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2',
        settings: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
        folder: 'M2 4h4l1.5 1.5H14V13H2z',
        reset: 'M3 8a5 5 0 1 0 1.5-3.6M3 2.5v3h3',
        lock: 'M4.5 7.5h7v6h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2',
        close: 'M4 4l8 8M12 4l-8 8',
        chevron: 'M6 4l4 4-4 4',
    };

    function icon(name, className) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('aria-hidden', 'true');
        if (className) {
            svg.setAttribute('class', className);
        }
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', ICONS[name] || ICONS.file);
        svg.appendChild(path);
        return svg;
    }

    function element(tag, attributes, children) {
        const node = document.createElement(tag);
        Object.entries(attributes || {}).forEach(([name, value]) => {
            if (value === undefined || value === null || value === false) {
                return;
            }
            if (name === 'text') {
                node.textContent = value;
            } else if (name === 'className') {
                node.className = value;
            } else if (name === 'value' || name === 'checked') {
                node[name] = value;
            } else {
                node.setAttribute(name, value === true ? '' : String(value));
            }
        });
        (children || []).forEach(child => child && node.appendChild(child));
        return node;
    }

    function create({ element: container, onChange, onAction }) {
        // Sections closed by the user, kept between renders
        const closed = new Set();
        let lastModel = null;
        let uid = 0;
        const nextId = (prefix) => `dmdb-panel-${prefix}-${++uid}`;

        const change = (id, value, preview) => onChange && onChange(id, value, { preview: Boolean(preview) });
        const action = (id) => onAction && onAction(id);

        function label(text, forId) {
            return element('label', { className: 'panel-label', for: forId, text });
        }

        function row(item, control, controlId) {
            const wrapper = element('div', { className: `panel-row panel-row-${item.type}` });
            if (item.label) {
                wrapper.appendChild(controlId ? label(item.label, controlId) : element('span', { className: 'panel-label', text: item.label }));
            }
            wrapper.appendChild(control);
            if (item.hint) {
                wrapper.appendChild(element('p', { className: 'panel-hint', text: item.hint }));
            }
            return wrapper;
        }

        const renderers = {
            choice(item) {
                const group = element('div', { className: 'panel-segmented', role: 'radiogroup', 'aria-label': item.label });
                item.options.forEach(option => {
                    const selected = option.value === item.value;
                    const button = element('button', {
                        type: 'button',
                        role: 'radio',
                        'aria-checked': String(selected),
                        className: selected ? 'selected' : '',
                        'data-key': `${item.id}:${option.value}`,
                        text: option.label,
                    });
                    button.addEventListener('click', () => change(item.id, option.value));
                    group.appendChild(button);
                });
                return row(item, group);
            },
            select(item) {
                const id = nextId('select');
                const select = element('select', { id, className: 'panel-select', 'data-key': item.id });
                item.options.forEach(option => select.appendChild(element('option', { value: option.value, text: option.label })));
                select.value = item.value;
                select.addEventListener('change', () => change(item.id, select.value));
                return row(item, select, id);
            },
            toggle(item) {
                const id = nextId('toggle');
                const input = element('input', { id, type: 'checkbox', role: 'switch', className: 'panel-switch', checked: Boolean(item.value), 'data-key': item.id });
                input.addEventListener('change', () => change(item.id, input.checked));
                const wrapper = element('div', { className: 'panel-row panel-toggle' }, [
                    element('label', { className: 'panel-toggle-label', for: id }, [
                        element('span', { className: 'panel-label', text: item.label }),
                        item.hint ? element('span', { className: 'panel-hint', text: item.hint }) : null,
                    ]),
                    input,
                ]);
                return wrapper;
            },
            range(item) {
                const id = nextId('range');
                const output = element('output', { className: 'panel-range-value', for: id, text: `${item.value}${item.unit || ''}` });
                const input = element('input', { id, type: 'range', min: item.min, max: item.max, step: item.step || 1, value: item.value, className: 'panel-range', 'data-key': item.id });
                input.addEventListener('input', () => {
                    output.textContent = `${input.value}${item.unit || ''}`;
                    change(item.id, Number(input.value), true);
                });
                input.addEventListener('change', () => change(item.id, Number(input.value)));
                return row(item, element('div', { className: 'panel-range-line' }, [input, output]), id);
            },
            text(item) {
                const id = nextId('text');
                const input = element('input', { id, type: 'text', className: 'panel-text', value: item.value || '', placeholder: item.placeholder, spellcheck: 'false', autocomplete: 'off', 'data-key': item.id });
                input.addEventListener('change', () => change(item.id, input.value));
                input.addEventListener('keydown', event => {
                    if (event.key === 'Enter') {
                        input.blur();
                    }
                });
                return row(item, input, id);
            },
            palettes(item) {
                const grid = element('div', { className: 'panel-palettes', role: 'radiogroup', 'aria-label': item.label });
                item.options.forEach(option => {
                    const selected = option.value === item.value;
                    const dots = element('span', { className: 'panel-palette-dots', 'aria-hidden': 'true' });
                    (option.colors || []).slice(0, 4).forEach(color => {
                        const dot = element('span', { className: 'panel-palette-dot' });
                        dot.style.backgroundColor = color;
                        dots.appendChild(dot);
                    });
                    const button = element('button', {
                        type: 'button',
                        role: 'radio',
                        'aria-checked': String(selected),
                        className: `panel-palette${selected ? ' selected' : ''}`,
                        'data-key': `${item.id}:${option.value}`,
                    }, [dots, element('span', { className: 'panel-palette-name', text: option.label })]);
                    button.addEventListener('click', () => change(item.id, option.value));
                    grid.appendChild(button);
                });
                return row(item, grid);
            },
            colors(item) {
                const list = element('div', { className: 'panel-colors' });
                item.items.forEach(color => {
                    const id = nextId('color');
                    const input = element('input', { id, type: 'color', value: color.value, className: 'panel-color', 'data-key': `${item.id}:${color.key}` });
                    input.addEventListener('input', () => change(item.id, { key: color.key, value: input.value }, true));
                    input.addEventListener('change', () => change(item.id, { key: color.key, value: input.value }));
                    const reset = element('button', {
                        type: 'button',
                        className: 'panel-icon-button',
                        title: item.resetLabel,
                        'aria-label': `${item.resetLabel}: ${color.label}`,
                        'data-key': `${item.id}:${color.key}:reset`,
                        hidden: !color.custom,
                    }, [icon('reset')]);
                    reset.addEventListener('click', () => change(item.id, { key: color.key, value: null }));
                    list.appendChild(element('div', { className: `panel-color-row${color.custom ? ' custom' : ''}` }, [
                        input,
                        element('label', { for: id, className: 'panel-color-label', text: color.label }),
                        reset,
                    ]));
                });
                return row(item, list);
            },
            actions(item) {
                const list = element('div', { className: 'panel-actions', role: 'list' });
                item.items.forEach(entry => {
                    const state = entry.state || 'available';
                    const button = element('button', {
                        type: 'button',
                        className: `panel-action ${state}`,
                        title: entry.title,
                        'data-key': entry.id,
                        'aria-disabled': state === 'available' ? null : 'true',
                    }, [
                        icon(entry.icon, 'panel-action-icon'),
                        element('span', { className: 'panel-action-text' }, [
                            element('span', { className: 'panel-action-label', text: entry.label }),
                            entry.hint ? element('span', { className: 'panel-action-hint', text: entry.hint }) : null,
                        ]),
                        state === 'locked'
                            ? icon('lock', 'panel-action-lock')
                            : entry.badge ? element('span', { className: 'panel-badge', text: entry.badge }) : null,
                    ]);
                    // Greyed items stay clickable: they tell how to get them
                    button.addEventListener('click', () => action(entry.id));
                    list.appendChild(element('div', { role: 'listitem' }, [button]));
                });
                return list;
            },
            button(item) {
                const button = element('button', { type: 'button', className: `panel-button${item.primary ? ' primary' : ''}`, 'data-key': item.id }, [
                    item.icon ? icon(item.icon) : null,
                    element('span', { text: item.label }),
                ]);
                button.addEventListener('click', () => action(item.id));
                return button;
            },
            heading(item) {
                return element('h3', { className: 'panel-heading', text: item.label });
            },
            note(item) {
                return element('p', { className: 'panel-note', text: item.text });
            },
        };

        function renderSection(section) {
            const details = element('details', { className: 'panel-section', 'data-section': section.id });
            details.open = !closed.has(section.id);
            details.addEventListener('toggle', () => {
                if (details.open) {
                    closed.delete(section.id);
                } else {
                    closed.add(section.id);
                }
            });
            const summary = element('summary', { className: 'panel-section-title' }, [icon('chevron', 'panel-chevron'), element('span', { text: section.title })]);
            const body = element('div', { className: 'panel-section-body' });
            section.items.forEach(item => {
                const render = renderers[item.type];
                if (render) {
                    body.appendChild(render(item));
                }
            });
            details.appendChild(summary);
            details.appendChild(body);
            return details;
        }

        function renderFooter(footer) {
            const card = element('div', { className: `panel-footer${footer.kind ? ` ${footer.kind}` : ''}` }, [
                element('p', { className: 'panel-footer-title', text: footer.title }),
                footer.text ? element('p', { className: 'panel-footer-text', text: footer.text }) : null,
            ]);
            (footer.buttons || []).forEach(button => card.appendChild(renderers.button(button)));
            return card;
        }

        function render(model) {
            lastModel = model;
            // Keep the scroll position and the focused control across renders
            const scroll = container.querySelector('.panel-content');
            const scrollTop = scroll ? scroll.scrollTop : 0;
            const active = document.activeElement;
            const focusKey = active && container.contains(active) && active.dataset ? active.dataset.key : null;

            container.textContent = '';
            const close = element('button', { type: 'button', className: 'panel-icon-button', title: model.closeLabel, 'aria-label': model.closeLabel, 'data-key': 'panel:close' }, [icon('close')]);
            close.addEventListener('click', () => action('panel:close'));
            container.appendChild(element('div', { className: 'panel-header' }, [element('h2', { className: 'panel-title', text: model.title }), close]));
            const content = element('div', { className: 'panel-content' });
            model.sections.forEach(section => content.appendChild(renderSection(section)));
            if (model.footer) {
                content.appendChild(renderFooter(model.footer));
            }
            container.appendChild(content);
            content.scrollTop = scrollTop;
            if (focusKey) {
                const target = Array.from(container.querySelectorAll('[data-key]')).find(node => node.dataset.key === focusKey);
                if (target) {
                    target.focus();
                }
            }
        }

        return {
            render,
            rerender() {
                if (lastModel) {
                    render(lastModel);
                }
            },
        };
    }

    window.DrawMeDatabaseSidePanel = { create, ICONS };
})();

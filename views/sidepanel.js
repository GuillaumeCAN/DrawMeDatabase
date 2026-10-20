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
//        { type: 'actions', items: [{ id, label, hint, icon, state, badge, title, reason }] }
//          state: 'available', 'missing' (greyed, PRO badge), 'locked' (greyed, lock) or
//          'unavailable' (greyed, without a badge: a tool that does not apply to the project; its
//          reason, as given, under its label and as its title)
//        { type: 'button', id, label, primary }
//        { type: 'heading', label } and { type: 'note', text }
//        A control with locked: true (a feature of DrawMeDatabase Pro) is disabled, with a PRO
//        badge (item.badge) that calls onAction('pro'); a palette list keeps item.free usable.
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
        history: 'M3.4 6A5 5 0 1 1 3 8M3 3v3h3M8 5.5V8l2 1.5',
        code: 'M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4',
        file: 'M4 2h5l3 3v9H4zM9 2v3h3',
        image: 'M2 3h12v10H2zM2 11l3.5-3.5 3 3 2-2L14 12M10.5 6a1 1 0 1 0 0-.01',
        copy: 'M5 5h8v9H5zM3 11V2h8',
        database: 'M3 4c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2zM3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2',
        settings: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
        folder: 'M2 4h4l1.5 1.5H14V13H2z',
        reset: 'M3 8a5 5 0 1 0 1.5-3.6M3 2.5v3h3',
        redo: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3',
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

        // The PRO badge of a locked control: a button that tells how to get it
        function proBadge(item) {
            if (!item.locked) {
                return null;
            }
            const badge = element('button', { type: 'button', className: 'panel-badge panel-badge-button', title: item.lockedTitle, 'data-key': `${item.id}:pro`, text: item.badge || 'PRO' });
            badge.addEventListener('click', () => action('pro'));
            return badge;
        }

        function row(item, control, controlId) {
            const wrapper = element('div', { className: `panel-row panel-row-${item.type}${item.locked ? ' locked' : ''}` });
            if (item.label) {
                const text = controlId ? label(item.label, controlId) : element('span', { className: 'panel-label', text: item.label });
                wrapper.appendChild(item.locked ? element('div', { className: 'panel-label-line' }, [text, proBadge(item)]) : text);
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
                const select = element('select', { id, className: 'panel-select', 'data-key': item.id, disabled: item.locked });
                item.options.forEach(option => select.appendChild(element('option', { value: option.value, text: option.label })));
                select.value = item.value;
                select.addEventListener('change', () => change(item.id, select.value));
                return row(item, select, id);
            },
            toggle(item) {
                const id = nextId('toggle');
                const input = element('input', { id, type: 'checkbox', role: 'switch', className: 'panel-switch', checked: Boolean(item.value), 'data-key': item.id, disabled: item.locked });
                input.addEventListener('change', () => change(item.id, input.checked));
                const wrapper = element('div', { className: `panel-row panel-toggle${item.locked ? ' locked' : ''}` }, [
                    element('label', { className: 'panel-toggle-label', for: id }, [
                        element('span', { className: 'panel-label-line' }, [element('span', { className: 'panel-label', text: item.label }), proBadge(item)]),
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
                    const locked = Boolean(item.locked && option.value !== item.free);
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
                        'aria-disabled': locked ? 'true' : null,
                        title: locked ? item.lockedTitle : null,
                        className: `panel-palette${selected ? ' selected' : ''}${locked ? ' locked' : ''}`,
                        'data-key': `${item.id}:${option.value}`,
                    }, [dots, element('span', { className: 'panel-palette-name', text: option.label })]);
                    button.addEventListener('click', () => (locked ? action('pro') : change(item.id, option.value)));
                    grid.appendChild(button);
                });
                return row(item, grid);
            },
            colors(item) {
                const list = element('div', { className: 'panel-colors' });
                item.items.forEach(color => {
                    const id = nextId('color');
                    const input = element('input', { id, type: 'color', value: color.value, className: 'panel-color', 'data-key': `${item.id}:${color.key}`, disabled: item.locked });
                    input.addEventListener('input', () => change(item.id, { key: color.key, value: input.value }, true));
                    input.addEventListener('change', () => change(item.id, { key: color.key, value: input.value }));
                    const reset = element('button', {
                        type: 'button',
                        className: 'panel-icon-button',
                        title: item.resetLabel,
                        'aria-label': `${item.resetLabel}: ${color.label}`,
                        'data-key': `${item.id}:${color.key}:reset`,
                        hidden: !color.custom || item.locked,
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
                    const state = ['available', 'missing', 'locked', 'unavailable'].includes(entry.state) ? entry.state : 'available';
                    const reason = state === 'unavailable' && typeof entry.reason === 'string' ? entry.reason : '';
                    const hint = reason || entry.hint;
                    const button = element('button', {
                        type: 'button',
                        className: `panel-action ${state}`,
                        title: reason || entry.title,
                        'data-key': entry.id,
                        'aria-disabled': state === 'available' ? null : 'true',
                    }, [
                        icon(entry.icon, 'panel-action-icon'),
                        element('span', { className: 'panel-action-text' }, [
                            element('span', { className: 'panel-action-label', text: entry.label }),
                            hint ? element('span', { className: 'panel-action-hint', text: hint }) : null,
                        ]),
                        state === 'locked'
                            ? icon('lock', 'panel-action-lock')
                            : entry.badge && state !== 'unavailable' ? element('span', { className: 'panel-badge', text: entry.badge }) : null,
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

    // ---------------------------------------------------------------------------------------------
    // The Appearance section, shared by the pages (appearance.js must be loaded)

    // A color of the page as #rrggbb (rgb(), names...), for the color inputs
    const colorProbe = document.createElement('canvas').getContext('2d');
    function toHex(value) {
        if (!value) {
            return '#000000';
        }
        colorProbe.fillStyle = '#000000';
        colorProbe.fillStyle = value;
        const normalized = colorProbe.fillStyle;
        if (/^#[0-9a-f]{6}$/i.test(normalized)) {
            return normalized;
        }
        const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(normalized);
        return rgb ? `#${rgb.slice(1, 4).map(part => Number(part).toString(16).padStart(2, '0')).join('')}` : '#000000';
    }

    // The colors shown for each key: the custom one, else the one in use
    function currentColors(appearance, t) {
        const Appearance = window.DrawMeDatabaseAppearance;
        const palette = Appearance.colors();
        const style = getComputedStyle(document.body);
        const used = {
            background: palette.background,
            header: palette.header,
            text: palette.text,
            border: palette.border,
            line: palette.line,
            accent: palette.accent,
            gitNew: style.getPropertyValue('--dmdb-git-new').trim(),
            gitModified: style.getPropertyValue('--dmdb-git-modified').trim(),
            gitUnsaved: style.getPropertyValue('--dmdb-git-unsaved').trim(),
        };
        return Appearance.COLOR_KEYS.map(key => ({
            key,
            label: t(`color.${key}`),
            value: toHex(appearance.colors[key] || used[key]),
            custom: Boolean(appearance.colors[key]),
        }));
    }

    // Four colors of a palette for its swatch, in the current theme
    function paletteSwatch(appearance, name) {
        const Appearance = window.DrawMeDatabaseAppearance;
        const kind = Appearance.themeKind(appearance, document.body.classList);
        const colors = Appearance.PALETTES[name][kind === 'light' || kind === 'hc-light' ? 'light' : 'dark'];
        const style = getComputedStyle(document.body);
        const vscodeColor = (variable) => style.getPropertyValue(variable).trim();
        return [
            colors.header || vscodeColor('--vscode-editorWidget-background'),
            colors.border || vscodeColor('--vscode-editorWidget-border') || vscodeColor('--vscode-widget-border'),
            colors.line || vscodeColor('--vscode-descriptionForeground'),
            colors.accent || vscodeColor('--vscode-focusBorder'),
        ].map(toHex);
    }

    // Items of the Appearance section: theme, palette, custom colors, font, text size, reset.
    // locked: the palettes, custom colors and fonts are features of DrawMeDatabase Pro (the
    // VS Code palette, the theme and the text size stay free); the effective values are shown.
    function appearanceItems(appearance, t, { locked = false } = {}) {
        const Appearance = window.DrawMeDatabaseAppearance;
        const lock = locked ? { locked: true, badge: t('panel.pro'), lockedTitle: t('panel.pro.missing') } : {};
        const shown = locked ? { ...appearance, palette: 'vscode', colors: {}, font: 'default', customFont: '' } : appearance;
        const items = [
            {
                type: 'choice',
                id: 'theme',
                label: t('panel.theme'),
                hint: t('panel.theme.hint'),
                value: appearance.theme,
                options: Appearance.THEMES.map(theme => ({ value: theme, label: t(`panel.theme.${theme}`) })),
            },
            {
                type: 'palettes',
                id: 'palette',
                label: t('panel.palette'),
                value: shown.palette,
                free: 'vscode',
                options: Object.keys(Appearance.PALETTES).map(name => ({ value: name, label: t(`palette.${name}`), colors: paletteSwatch(shown, name) })),
                ...lock,
            },
            { type: 'colors', id: 'colors', label: t('panel.colors'), resetLabel: t('panel.colors.reset'), items: currentColors(shown, t), ...lock },
            {
                type: 'select',
                id: 'font',
                label: t('panel.font'),
                value: shown.font,
                options: Appearance.FONTS.map(font => ({ value: font, label: t(`font.${font}`) })),
                ...lock,
            },
        ];
        if (shown.font === 'custom') {
            items.push({ type: 'text', id: 'customFont', label: t('panel.customFont'), value: appearance.customFont, placeholder: t('panel.customFont.placeholder') });
        }
        items.push(
            { type: 'range', id: 'fontSize', label: t('panel.fontSize'), value: appearance.fontSize, min: Appearance.FONT_SIZE.min, max: Appearance.FONT_SIZE.max, unit: ' px' },
            { type: 'button', id: 'resetAppearance', label: t('panel.resetAppearance'), icon: 'reset' },
        );
        return items;
    }

    // A change of an appearance control: { appearance (the new one), key, value (the setting to
    // save) }, or null when the control is not an appearance one ('grid' included)
    const APPEARANCE_KEYS = ['theme', 'palette', 'font', 'customFont', 'fontSize', 'grid'];
    function changeAppearance(appearance, id, value) {
        if (id === 'colors' && value && typeof value === 'object') {
            const colors = { ...appearance.colors };
            if (value.value) {
                colors[value.key] = value.value;
            } else {
                delete colors[value.key];
            }
            return { appearance: { ...appearance, colors }, key: 'colors', value: colors };
        }
        if (APPEARANCE_KEYS.includes(id)) {
            return { appearance: { ...appearance, [id]: value }, key: id, value };
        }
        return null;
    }

    window.DrawMeDatabaseSidePanel = { create, ICONS, appearanceItems, changeAppearance, toHex };
})();

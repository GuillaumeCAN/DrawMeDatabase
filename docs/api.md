# Extension API

Other extensions (DrawMeDatabase Pro, or yours) can use DrawMeDatabase through its API:

```js
const core = vscode.extensions.getExtension('GuillaumeCancalon.draw-me-database');
const api = await core.activate(); // or core.exports once it is active
if (api.apiVersion >= 1) {
    // ...
}
```

Members added by a later version are checked before use (`if (api.registerTool) { ... }`), so an extension works with the versions of DrawMeDatabase that do not have them yet.

Declare `"extensionDependencies": ["GuillaumeCancalon.draw-me-database"]` so that VS Code installs and activates it first. The tables are in the pivot format, see [pivot-format.md](pivot-format.md).

## Version 1

| Member | Description |
|--------|-------------|
| `apiVersion` | `2` since DrawMeDatabase 1.6.0 (`1` in 1.5.0). A new member raises it; members are never removed within a major version of the extension |
| `getSchema()` | The schema on screen: `{ tables, framework, basePath, project: { name, folder } }` (`folder` is the URI of the workspace folder as a string), or `null` before the first drawing. A copy: changing it changes nothing |
| `onDidChangeSchema(listener)` | Event fired with the new schema after each drawing (command, refresh, live edit). Returns a `Disposable` |
| `showDiagram()` | Draws the schema of the workspace, like the DrawMeDatabase command. Resolves to the parsed tables |
| `detectFramework(basePath)` | `'laravel'`, `'symfony'` or another value for an unsupported folder |
| `parseSchema(basePath, framework, options)` | Parses a framework folder: `{ tables, warnings }`. Options: `git`, `overrides`, `gitCache`, `columnSources`, `until` (Laravel), `details` (lengths, defaults, indexes, ON DELETE...), see [pivot-format.md](pivot-format.md). Throws a `ParserError` for a missing folder or an unknown framework |
| `viewsUri`, `viewScripts` | The folder of the page files and the scripts that draw a diagram, in loading order (`vendor/mermaid.min.js`, `i18n.js`, `appearance.js`, `mermaid/generator.js`, `mermaid/zoom.js`, `exporters.js`, `search.js`, `mermaid/diagram.js`, `sidepanel.js`), with `theme.css`. Add `viewsUri` to the `localResourceRoots` of your panel to reuse them, see [Pages](#pages) |
| `registerExporter({ id, label, extension, export, pro })` | Adds an item to the Export menu of the diagram and to the Export section of its side panel. `export(schema)` gets the tables on screen (the search result when there is one) and returns the text of the file (or a promise), saved with the Save dialog. `pro: true`: locked in the side panel once the trial of DrawMeDatabase Pro has ended. Returns a `Disposable` |
| `focusTables({ tables, highlight, label })` | Shows only these tables (and the relations between them) in the diagram, `highlight` standing out, with `label` and a button to go back to the whole schema. Opens the diagram when needed |
| `getDiagramSvg()` | The diagram on screen as an SVG file (text), or `null` when no diagram is drawn |
| Generator `marks` | The page scripts draw a table's `mark` as a CSS class of its node and a column's `note` as its comment when the diagram is drawn with `{ marks: true }` (for example a schema comparison: added, removed, changed) |
| `lastRender` | The last drawing reported by the page (`{ ok, layout, entities, error }`), for tests |

## Version 2 (DrawMeDatabase 1.6.0)

| Member | Description |
|--------|-------------|
| `registerTool({ id, label, command, args, hint, icon, pro })` | Adds a tool to the Tools section of the side panel of the diagram: a click runs `command` with `args` (strings, numbers, booleans). The ids of DrawMeDatabase Pro (`pro.canvas`, `pro.designer`...) replace the greyed items shown before it is installed, and their texts come from the translations of DrawMeDatabase. Returns `{ update({ label, hint, locked }), dispose() }` |
| `setLicenseStatus({ kind, daysLeft, commands })` | The license of DrawMeDatabase Pro, at the bottom of the side panel. `kind`: `'licensed'`, `'trial'` (with `daysLeft`), `'expired'` (its tools and exports are then shown locked) or `'development'`. `commands`: `{ buy, enter, manage }`, the commands of its buttons. `null`: not installed |
| `registerTableInfoProvider({ id, provide })` | Adds sections to the inspector of a table (a click on a table in the diagram). `provide(table, schema)` returns, or resolves to within 10 s, a list of sections: `{ title, items: [{ label, value, hint, badge, tone }], actions: [{ label, command, args }], note, locked }`. `tone`: `'added'`, `'modified'`, `'removed'`, `'muted'` or `'accent'`; an action runs `command` with `args` (strings, numbers, booleans); `locked: true` greys the section with a PRO badge. Without any provider, the inspector shows what DrawMeDatabase Pro would add. Returns a `Disposable` |
| `getDisplaySettings()` | The appearance and the language chosen by the user: `{ theme, palette, colors, font, customFont, fontSize, grid, language }` (`language`: `'en'` or `'fr'`, already resolved) |
| `onDidChangeDisplaySettings(listener)` | Event fired with the new display settings. Returns a `Disposable` |

## Pages

The panels of other extensions can look and speak like the diagram, with the page scripts of `viewScripts`:

- **Appearance**: post `getDisplaySettings()` to the page and call `DrawMeDatabaseAppearance.apply(settings)`. It sets the forced theme (`data-dmdb-theme` on `<body>`, which `theme.css` turns into the VS Code colors of a light or dark theme), the palette and custom colors (`--dmdb-color-*` variables), the font (`--dmdb-font-family`, `--dmdb-font-size`) and the grid (class `dmdb-no-grid`). `DrawMeDatabaseAppearance.colors()` and `.font()` give the result to drawings; the Mermaid diagrams of `DrawMeDatabaseDiagram` use them. Call `apply()` again when the class of `<body>` changes (a new VS Code theme), then redraw.
- **Language**: `const t = DrawMeDatabaseI18n.translator(settings.language)`, then `t('key', { count, ... })`. `DrawMeDatabaseI18n.register({ en: {...}, fr: {...} })` adds the texts of your pages; `translateDocument(document, t)` fills the elements marked with `data-i18n`, `data-i18n-title`, `data-i18n-label` (aria-label) and `data-i18n-placeholder`. `DrawMeDatabaseDiagram.create({ ..., t })` writes its messages and the git status of the columns in that language.
- **Side panel**: `DrawMeDatabaseSidePanel.create({ element, onChange, onAction }).render(model)` draws sections of choices, switches, lists, palettes, colors and actions (see the comment at the top of `views/sidepanel.js` for the model). `appearanceItems(settings, t)` gives the items of the Appearance section of the diagram, and `changeAppearance(settings, id, value)` the new appearance and the setting to save after a change of one of them. The styles are in `theme.css`.

Without DrawMeDatabase Pro, the Export menu has one more item that opens the page of DrawMeDatabase Pro in the Extensions view. It disappears once Pro, or any extension that registers an export, is installed.

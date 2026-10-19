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
| `apiVersion` | `3` since DrawMeDatabase 1.8.0 (`2` in 1.6.0 and 1.7.0, `1` in 1.5.0). A new member raises it; members are never removed within a major version of the extension |
| `getSchema()` | The schema on screen: `{ tables, framework, basePath, project: { name, folder } }` (`framework` is the id of the parser that read it, see `getFrameworks()`; `folder` is the URI of the workspace folder as a string), or `null` before the first drawing. A copy: changing it changes nothing |
| `onDidChangeSchema(listener)` | Event fired with the new schema after each drawing (command, refresh, live edit). Returns a `Disposable` |
| `showDiagram()` | Draws the schema of the workspace, like the DrawMeDatabase command. Resolves to the parsed tables |
| `detectFramework(basePath, options)` | The id of the stack of a framework root (`'laravel'`, `'symfony'`, `'prisma'`, see `getFrameworks()`), or `'Unknown'` for an unsupported folder. 1.8.0: `options.framework`, an id that wins over the detection, like the `DrawMeDatabase.framework` setting (the API does not read the setting: `getSchema().framework` follows it) |
| `parseSchema(basePath, framework, options)` | Parses a framework folder with the parser `framework` (an id of `getFrameworks()`): `{ tables, warnings }`. Options: `git`, `overrides`, `gitCache`, `columnSources`, `until` (Laravel), `details` (lengths, defaults, indexes, ON DELETE...), see [pivot-format.md](pivot-format.md). Throws a `ParserError` for a missing folder or an unknown framework |
| `viewsUri`, `viewScripts` | The folder of the page files and the scripts that draw a diagram, in loading order (`vendor/mermaid.min.js`, `i18n.js`, `appearance.js`, `mermaid/generator.js`, `mermaid/zoom.js`, `exporters.js`, `search.js`, `mermaid/diagram.js`, `sidepanel.js`), with `theme.css`. Add `viewsUri` to the `localResourceRoots` of your panel to reuse them, see [Pages](#pages) |
| `registerExporter({ id, label, extension, export, pro })` | Adds an item to the Export menu of the diagram and to the Exports view of the sidebar (1.6.0: the Export section of the side panel). `export(schema)` gets the tables on screen (the search result when there is one) and returns the text of the file (or a promise), saved with the Save dialog. `pro: true`: locked in the Exports view once the trial of DrawMeDatabase Pro has ended. Returns a `Disposable` |
| `focusTables({ tables, highlight, label })` | Shows only these tables (and the relations between them) in the diagram, `highlight` standing out, with `label` and a button to go back to the whole schema. Opens the diagram when needed |
| `getDiagramSvg()` | The diagram on screen as an SVG file (text), or `null` when no diagram is drawn |
| Generator `marks` | The page scripts draw a table's `mark` as a CSS class of its node and a column's `note` as its comment when the diagram is drawn with `{ marks: true }` (for example a schema comparison: added, removed, changed) |
| `lastRender` | The last drawing reported by the page (`{ ok, layout, entities, error }`), for tests |

## Version 2 (DrawMeDatabase 1.6.0)

| Member | Description |
|--------|-------------|
| `registerTool({ id, label, command, args, hint, icon, pro })` | Adds a tool to the Tools view of the sidebar (1.6.0: the Tools section of the side panel of the diagram): a click runs `command` with `args` (strings, numbers, booleans). The ids of DrawMeDatabase Pro (`pro.canvas`, `pro.designer`...) replace the greyed items shown before it is installed, and their texts come from the translations of DrawMeDatabase. `icon`: a codicon (`plug`), or an icon of `views/sidepanel.js` (`history`, `compare`...). Returns `{ update({ label, hint, locked }), dispose() }` |
| `connectPro()` | Shows the license of DrawMeDatabase Pro in the License view of the sidebar (1.6.0: at the bottom of the side panel), which is only shown while it is set. DrawMeDatabase reads it from the exports of DrawMeDatabase Pro, not from the caller: see [License of DrawMeDatabase Pro](#license-of-drawmedatabase-pro). Resolves to `true` once it follows it |
| `registerTableInfoProvider({ id, provide })` | Adds sections to the inspector of a table (a click on a table in the diagram). `provide(table, schema)` returns, or resolves to within 10 s, a list of sections: `{ title, items: [{ label, value, hint, badge, tone }], actions: [{ label, command, args }], note, locked }`. `tone`: `'added'`, `'modified'`, `'removed'`, `'muted'` or `'accent'`; an action runs `command` with `args` (strings, numbers, booleans); `locked: true` greys the section with a PRO badge. Without any provider, the inspector shows what DrawMeDatabase Pro would add. Returns a `Disposable` |
| `getDisplaySettings()` | The appearance and the language chosen by the user: `{ theme, palette, colors, font, customFont, fontSize, grid, language }` (`language`: `'en'` or `'fr'`, already resolved) |
| `onDidChangeDisplaySettings(listener)` | Event fired with the new display settings. Returns a `Disposable` |

## Version 3 (DrawMeDatabase 1.8.0)

The parsers are pluggable ([parsers.md](parsers.md)): a stack is an id (`framework` everywhere in the API) with its label and its sources. More stacks will follow: code that branches on `framework` keeps a default for the ids it does not know (for example, no Laravel migration written for a stack that is not `laravel`, and no Doctrine entity for `prisma`).

| Member | Description |
|--------|-------------|
| `getFrameworks()` | The supported stacks, in the order of detection (the first one wins a tie): `[{ id, label }]`, today `[{ id: 'laravel', label: 'Laravel' }, { id: 'symfony', label: 'Symfony' }, { id: 'prisma', label: 'Prisma' }]` |
| `getSources(basePath, framework)` | What the parser of a stack reads in a framework root: `{ folders: [{ path, recursive }], files, extensions }`, absolute paths (`recursive`: its sub-folders too; `extensions`: of the files of the folders, `['.php']`; `files`: single files, whatever their extension). For example the files to copy for a version of the schema, or to watch. Throws a `ParserError` for an unknown framework |

## Sidebar (DrawMeDatabase 1.7.0)

DrawMeDatabase has a view container in the Activity Bar, with the views *Schema* (`DMDB.schema`), *Tools* (`DMDB.tools`), *Exports* (`DMDB.exports`) and *License* (`DMDB.license`); see [activity-bar.md](activity-bar.md). Its id is **`drawMeDatabase`**: other extensions add their own views to it in their `package.json`, after the ones of DrawMeDatabase.

```json
"contributes": {
    "views": {
        "drawMeDatabase": [
            { "id": "DMDBPro.connections", "name": "%view.connections%", "when": "drawMeDatabase.sidebar" }
        ]
    }
}
```

| Context key | Value |
|-------------|-------|
| `drawMeDatabase.sidebar` | `true` once the container exists. Put it in the `when` clause of your views: with a DrawMeDatabase older than 1.7.0, VS Code would move them to the Explorer |
| `drawMeDatabase.schemaState` | What the Schema view shows: `loading`, `noFolder`, `noProject` (no supported project found), `noTables`, `error` (see the output) or `ready` |
| `drawMeDatabase.license` | The `kind` of the license of DrawMeDatabase Pro (see [below](#license-of-drawmedatabase-pro)), or `free` |

- `workbench.view.extension.drawMeDatabase` opens the container, `<view id>.focus` one of its views.
- The Schema view reads the schema itself when it is shown, without the diagram: `getSchema()` and `onDidChangeSchema` then give its schema too, and it follows the edits of the code while the Schema view or the diagram is visible.
- The commands of the views can be used in the menus of your views: `DMDB.refreshSchema` (read the schema again), `DMDB.showInDiagram` (with a table name: open the diagram on it and inspect it), `DMDB.openTable` (a table name, and optionally a column name: open its file at its line), `DMDB.runExport` (an export id, see `registerExporter`), `DMDB.openSettings`, `DMDB.showOutput`.

## License of DrawMeDatabase Pro

Every extension can call the API, so the API cannot unlock what DrawMeDatabase keeps for DrawMeDatabase Pro (the git status of the columns, the palettes, the custom colors and the fonts). DrawMeDatabase reads the license from the exports of the extension **`GuillaumeCancalon.draw-me-database-pro`**, which VS Code keeps for that extension:

1. Pro returns **frozen** exports from its `activate()` (`Object.freeze`), with:
   - `licenseStatus()`: `{ kind, daysLeft, commands }`, or `null` once it is deactivated. `kind`: `'licensed'`, `'trial'` (with `daysLeft`), `'expired'` (its tools and exports are then shown locked) or `'development'`. `commands`: `{ buy, enter, manage, remove }`, the commands of its buttons (`remove`: only while a key is stored);
   - `onDidChangeLicenseStatus(listener)`: an event fired when its license changes (and every hour during the trial). Returns a `Disposable`.
2. Pro calls `connectPro()` while it activates, **without awaiting it** in `activate()`: DrawMeDatabase waits for the end of the activation of Pro (`extension.activate()`), then follows its license.

Exports that are not frozen are ignored: another extension could have replaced their functions. Calling `connectPro()` from another extension only makes DrawMeDatabase read the exports of Pro again.

This stops an extension from unlocking Pro with one line of code. It is not a lock: DrawMeDatabase is free software, and a modified copy of it can show anything.

## Pages

The panels of other extensions can look and speak like the diagram, with the page scripts of `viewScripts`:

- **Appearance**: post `getDisplaySettings()` to the page and call `DrawMeDatabaseAppearance.apply(settings)`. It sets the forced theme (`data-dmdb-theme` on `<body>`, which `theme.css` turns into the VS Code colors of a light or dark theme), the palette and custom colors (`--dmdb-color-*` variables), the font (`--dmdb-font-family`, `--dmdb-font-size`) and the grid (class `dmdb-no-grid`). `DrawMeDatabaseAppearance.colors()` and `.font()` give the result to drawings; the Mermaid diagrams of `DrawMeDatabaseDiagram` use them. Call `apply()` again when the class of `<body>` changes (a new VS Code theme), then redraw.
- **Language**: `const t = DrawMeDatabaseI18n.translator(settings.language)`, then `t('key', { count, ... })`. `DrawMeDatabaseI18n.register({ en: {...}, fr: {...} })` adds the texts of your pages; `translateDocument(document, t)` fills the elements marked with `data-i18n`, `data-i18n-title`, `data-i18n-label` (aria-label) and `data-i18n-placeholder`. `DrawMeDatabaseDiagram.create({ ..., t })` writes its messages and the git status of the columns in that language.
- **Side panel**: `DrawMeDatabaseSidePanel.create({ element, onChange, onAction }).render(model)` draws sections of choices, switches, lists, palettes, colors and actions (see the comment at the top of `views/sidepanel.js` for the model). `appearanceItems(settings, t)` gives the items of the Appearance section of the diagram, and `changeAppearance(settings, id, value)` the new appearance and the setting to save after a change of one of them. The styles are in `theme.css`.

Without DrawMeDatabase Pro, the Export menu has one more item that opens the page of DrawMeDatabase Pro in the Extensions view. It disappears once Pro, or any extension that registers an export, is installed.

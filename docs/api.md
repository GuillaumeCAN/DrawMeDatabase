# Extension API

Other extensions (DrawMeDatabase Pro, or yours) can use DrawMeDatabase through its API:

```js
const core = vscode.extensions.getExtension('GuillaumeCancalon.draw-me-database');
const api = await core.activate(); // or core.exports once it is active
if (api.apiVersion >= 1) {
    // ...
}
```

Declare `"extensionDependencies": ["GuillaumeCancalon.draw-me-database"]` so that VS Code installs and activates it first. The tables are in the pivot format, see [pivot-format.md](pivot-format.md).

## Version 1

| Member | Description |
|--------|-------------|
| `apiVersion` | `1`. A new member raises it; members are never removed within a major version of the extension |
| `getSchema()` | The schema on screen: `{ tables, framework, basePath, project: { name, folder } }` (`folder` is the URI of the workspace folder as a string), or `null` before the first drawing. A copy: changing it changes nothing |
| `onDidChangeSchema(listener)` | Event fired with the new schema after each drawing (command, refresh, live edit). Returns a `Disposable` |
| `showDiagram()` | Draws the schema of the workspace, like the DrawMeDatabase command. Resolves to the parsed tables |
| `detectFramework(basePath)` | `'laravel'`, `'symfony'` or another value for an unsupported folder |
| `parseSchema(basePath, framework, options)` | Parses a framework folder: `{ tables, warnings }`. Options: `git`, `overrides`, `gitCache`, `columnSources`, `until` (Laravel), see [pivot-format.md](pivot-format.md). Throws a `ParserError` for a missing folder or an unknown framework |
| `viewsUri`, `viewScripts` | The folder of the page files and the scripts that draw a diagram, in loading order (`vendor/mermaid.min.js`, `mermaid/generator.js`, `mermaid/zoom.js`, `exporters.js`, `search.js`, `mermaid/diagram.js`), with `theme.css`. Add `viewsUri` to the `localResourceRoots` of your panel to reuse them |
| `registerExporter({ id, label, extension, export })` | Adds an item to the Export menu of the diagram. `export(schema)` gets the tables on screen (the search result when there is one) and returns the text of the file (or a promise), saved with the Save dialog. Returns a `Disposable` |
| `focusTables({ tables, highlight, label })` | Shows only these tables (and the relations between them) in the diagram, `highlight` standing out, with `label` and a button to go back to the whole schema. Opens the diagram when needed |
| `getDiagramSvg()` | The diagram on screen as an SVG file (text), or `null` when no diagram is drawn |
| `lastRender` | The last drawing reported by the page (`{ ok, layout, entities, error }`), for tests |

Without DrawMeDatabase Pro, the Export menu has one more item that opens the page of DrawMeDatabase Pro in the Extensions view. It disappears once Pro, or any extension that registers an export, is installed.

# The DrawMeDatabase sidebar (Activity Bar)

Design note for the DrawMeDatabase view container in the Activity Bar, like the one of GitLens. It
replaces most of the options panel that 1.6.0 put inside the diagram.

## Why

The options panel of 1.6.0 lives inside the diagram webview: its tools, exports and license are
only reachable once a diagram is open, and they take space from the diagram. VS Code has a native
place for what an extension offers: a view container in the Activity Bar, with tree views that
follow the theme, the keyboard, the screen readers and the layout chosen by the user (views can be
moved, collapsed, hidden or dragged to the secondary side bar).

## What moves, what stays

| Today (options panel of the diagram) | After |
|--------------------------------------|-------|
| View: layout, direction, git status, git status of the columns (Pro), keys only, relation names, grid | **Stays** in the diagram: they change how this diagram is drawn |
| Appearance: theme, palette, custom colors, font, text size, reset | **Stays** in the diagram: the changes are previewed live on the diagram |
| Settings: language, auto refresh, framework folder, all settings | **Stays** (language and auto refresh change the diagram); the framework folder also gets a button in the welcome of the Schema view, and all settings a gear in the title of the Schema view |
| Tools (built-in and Pro) | **Moves** to the *Tools* view |
| Export (built-in and Pro) | **Moves** to the *Exports* view. The Export menu of the toolbar of the diagram stays |
| License footer | **Moves** to the *License* view, shown once DrawMeDatabase Pro is installed |
| — | **New**: the *Schema* view (tables → columns) |

The options button of the diagram stays, and its panel only keeps the display settings (View,
Appearance, Settings), with a button that opens the sidebar for the tools, exports and license.

## The container

- `contributes.viewsContainers.activitybar`: id **`drawMeDatabase`**, title *DrawMeDatabase*, icon
  `images/activitybar.svg` (a database, monochrome: VS Code draws it as a mask in the color of the
  theme).
- It is shown in every workspace, like GitLens: without a Laravel or Symfony project the Schema view
  says why and how to fix it. Users can hide it from the context menu of the Activity Bar.
- Its views are native tree views (`vscode.window.createTreeView`), not webviews: no page to load,
  native keyboard navigation, type-to-filter, and the look of the rest of VS Code.

## The views

Each view is built from the same registries as the options panel of 1.6.0, so nothing changes for
DrawMeDatabase Pro or for other extensions: a tool added with `registerTool()` shows in the Tools
view, an export added with `registerExporter()` in the Exports view, and `setLicenseStatus()` fills
the License view.

### Schema (`DMDB.schema`)

- The tables of the project, sorted by name, each one with its columns.
- Table: icon `table`, description = its number of columns; its git status (new, modified, unsaved)
  colors its name and adds a letter, like the Explorer (while `DrawMeDatabase.showGitStatus` is on).
- Column: icon `key` for a primary key, `references` for a foreign key, `symbol-field` otherwise;
  description = its type, `?` when nullable, and `→ table.column` for a foreign key. The git status
  of each column comes with DrawMeDatabase Pro, as in the diagram.
- A click on a table opens its migration or entity, a click on a column opens its line (the source
  lines the parsers already give to the inspector). The context menu adds *Show in Diagram*, which
  opens the diagram, selects the table and shows it in the inspector.
- Title: *Draw Database Schema* (opens the diagram), *Refresh*, *Collapse All*, and *Settings* in the
  `...` menu. The description of the view is the framework and the project (`Laravel · backend`).
- The view reads the schema itself when it becomes visible: no diagram is needed. The schema is
  then shared with the diagram (and with `getSchema()` / `onDidChangeSchema` of the API), and the
  view follows the edits of the migrations and entities live while it, or the diagram, is visible.
- Welcome content (`viewsWelcome`), from the context key `drawMeDatabase.schemaState`:
  - no folder open: *Open Folder*;
  - no Laravel or Symfony project found: what DrawMeDatabase reads, and *Set the Framework Folder*
    (the `DrawMeDatabase.frameworkPath` setting);
  - a project without tables: what DrawMeDatabase reads, and *Refresh*;
  - an error while reading: *Show Output* and *Refresh*;
  - while reading: a short message.

### Tools (`DMDB.tools`)

- The built-in and Pro tools, in the order of the options panel, from the registry of
  `registerTool()`; a click runs the same command as in the panel.
- The tools of DrawMeDatabase Pro are listed before Pro is installed: greyed (their name in the
  disabled color), with the description *PRO*; a click opens the page of DrawMeDatabase Pro.
- Once the Pro trial has ended, its tools are greyed with a lock; a click runs them, and Pro tells
  how to get a license (as in the panel).
- The tooltip gives the hint of the tool and, when greyed, why.

### Exports (`DMDB.exports`)

- The exports of the diagram (SVG, PNG, Mermaid, Markdown, Copy Mermaid, JSON, Copy JSON), then the
  ones of the extensions (SQL, DBML... of DrawMeDatabase Pro, greyed with *PRO* like the tools).
- An export works on what the diagram shows (the search result when there is one), like the Export
  menu: the view asks the diagram, and opens it first when it is closed.

### License (`DMDB.license`)

- Shown only once DrawMeDatabase Pro is installed (it calls `setLicenseStatus()`): without Pro, the
  free extension shows no license view, the greyed tools and exports are the only sign of Pro.
- The state of DrawMeDatabase Pro and its buttons, from `setLicenseStatus()`:
  - trial: *Pro trial: N days left*, *Buy a license*, *Enter a license key*;
  - expired: *Your Pro trial has ended*, *Buy a license*, *Enter a license key*;
  - licensed: *DrawMeDatabase Pro* and *License* (manage);
  - development: *DrawMeDatabase Pro (development)*.
- The buttons run the commands given by Pro, as the footer of the panel did.

## Extensibility

The container belongs to the core, so DrawMeDatabase Pro (or any extension) adds its own views to
it in its `package.json`, keyed by the container id:

```json
"contributes": {
    "views": {
        "drawMeDatabase": [
            { "id": "DMDBPro.connections", "name": "%view.connections%", "when": "drawMeDatabase.sidebar" },
            { "id": "DMDBPro.savedViews", "name": "%view.savedViews%", "when": "drawMeDatabase.sidebar" }
        ]
    }
}
```

- `drawMeDatabase.sidebar` is set by the core once its container exists: with an older core, VS Code
  would otherwise move these views to the Explorer.
- The context keys of the core can be used in the `when` clauses of these views and of their menus:
  `drawMeDatabase.schemaState` (`loading`, `noFolder`, `noProject`, `noTables`, `error`, `ready`)
  and `drawMeDatabase.license` (`free`, `trial`, `expired`, `licensed`, `development`).
- The views of other extensions come after the ones of the core; users can reorder them.
- Planned in DrawMeDatabase Pro: *Database connections* (for the comparison with a live database)
  and *Saved views*.
- No new API member is needed: the container id and the context keys are documented in
  [api.md](api.md).

## Languages

- The names of the container and of the views, the welcome content and the commands come from
  `package.nls.json` / `package.nls.fr.json`: they follow the display language of VS Code.
- The items of the views (labels, descriptions, tooltips) come from `views/i18n.js`, in the
  language of the `DrawMeDatabase.language` setting, like the diagram and the messages; the views
  are refreshed when it changes.

## Not in this version

- Several workspace folders: the views show the project of the active editor, else of the last
  drawing, else of the first folder (like the DrawMeDatabase command).
- Relations as tree nodes (the foreign keys are in the descriptions of the columns).
- A Home or Settings webview view: the settings stay in the diagram and in the Settings editor.

# DrawMeDatabase modernization plan (after 1.1.2)

Written on October 17, 2026, from the working tree of `fix/stabilize-1.1.2`, and validated on October 18, 2026: the decisions are in section 9, the progress in the table below.
The measurements (.vsix sizes, php-parser probe) were made in a temporary directory, outside the repository.

## 1. Summary

| # | Workstream | Version | Effort | Risk | Priority |
|---|------------|---------|--------|------|----------|
| 0 | Commit, merge and publish 1.1.2 | 1.1.2 | 0.5 d | low | **urgent** |
| 1 | GitHub Actions CI, Open VSX, Marketplace publishing without PATs | (tooling) | 2–3 d | medium | **urgent: before December 1, 2026** |
| 2 | Mermaid 10.9.8 → 12.2 | 1.2.0 | 2–3 d | medium | high |
| 3 | UX: webview foundation, zoom/pan, export, click → file, auto-refresh, filter | 1.2.0 then 1.3.0 | 8–10 d | low to medium | high |
| 4 | AST-based parsers (php-parser) | 1.4.0 | 10–14 d | high (regressions) | medium |
| 5 | Accuracy by running PHP (SQLite, Doctrine) | — | 9–14 d | high | **out of scope** (to be discussed again) |

Progress (October 18, 2026):

| # | Status |
|---|--------|
| 0 | 1.1.2 merged into `main`; tag and publication pending (Open VSX setup in [publishing.md](publishing.md)) |
| 1 | Done: CI, Dependabot and tag-driven releases (PR #7) |
| 2 | Done in 1.2.0: Mermaid 12.2.0 full build, ELK by default |
| 3 | a, b, c done in 1.2.0 (single-page webview, zoom/pan, export, plus PNG export); d, e, f done in 1.3.0 (click → file, auto-refresh, search) |
| 4 | In reserve (decision 4) |
| 5 | Out of scope (decision 3) |

Proposed order: 0 → 1 → 2 → 3 → 4. Workstream 1 has an external deadline. Workstream 2 unblocks part of workstream 3 (`classDef` styles for the filter, Unicode names). Workstream 4 is a robustness investment with no visible gain: it comes after the features users see.

Effort is given in days of focused work, tests and docs included.

## 2. Workstream 0: close 1.1.2 (0.5 d)

- Commit `fix/stabilize-1.1.2`, open the PR to `main`, merge, tag `v1.1.2`.
- Publish 1.1.2 to the Marketplace while the current PAT still works (or by manual upload, see workstream 1).
- Small debt found while reading the code: `parsers/laravel.js` (`toPivot`) refers to a `CONTRACT.md` that does not exist in the repository. Either write that document describing the pivot format (useful for workstreams 3 and 4), or fix the comment. *Done in 1.3.0: [pivot-format.md](pivot-format.md).*

## 3. Workstream 1: CI and publishing (2–3 d, deadline December 1, 2026)

### Findings
- There is no `.github/` folder, so no CI. The tests (lint, 191 unit tests, integration test under xvfb) only run locally.
- Microsoft's documentation confirms it: "On December 1, 2026, global Personal Access Tokens (PATs) in Azure DevOps are retired". A Marketplace PAT must be created with "All accessible organizations", which makes it a global PAT: publishing with a PAT stops on that date.
- The `GuillaumeCancalon` namespace is free on Open VSX (the API returns 404 for the namespace and for the extension).

### Work
1. **CI** (`.github/workflows/ci.yml`): Node 22, `npm ci`, `npm run lint`, `npm run test:unit`, `xvfb-run -a npm test`, `npm run package`, with the .vsix kept as an artifact. Add Dependabot for `npm` (Mermaid stays pinned and only moves through PRs) and for `github-actions`.
2. **Open VSX** (Cursor, VSCodium, Windsurf, Gitpod…):
   - an Eclipse account with the same GitHub username, and the *Publisher Agreement* signed on open-vsx.org;
   - `npx ovsx create-namespace GuillaumeCancalon`, then a namespace ownership claim (without it, the extension is shown as "unverified" and someone else could claim the namespace);
   - a first publish with a token: `npx ovsx publish builds/draw-me-database-1.1.2.vsix -p <token>`.
   - Later, *Trusted Publishing* (OIDC from GitHub Actions, no stored secret) if open-vsx.org has enabled it. The feature is off by default for registry operators: to be checked. It requires namespace ownership and an already published first version.
3. **Marketplace without a PAT**, two options (decision 2):
   - **A. Manual upload** of the .vsix built by the CI on the Marketplace management page. No infrastructure, fine for a few releases a year. *Recommended to start with.*
   - **B. Entra ID automation**: an Azure subscription (the free tier is enough), a user-assigned managed identity, a GitHub federated credential of type *Environment*, the identity added as a *Contributor* of the publisher, then `azure/login` with `allow-no-subscriptions: true` and `vsce publish --azure-credential` (vsce ≥ 2.26.1; the repository uses 4.0.0).
     - One write-up reports that an *App Registration* authenticates but fails when publishing (`InvalidAccessException`): only the managed identity works.
     - The publisher member to add is the identity's Azure DevOps ID, not its Client ID or Object ID.
     - The official documentation only covers Azure Pipelines, not GitHub Actions.
     - Nobody has confirmed that this works with a publisher owned by a personal Microsoft account. It must be tested before December 1.
4. A **tag-triggered release** (`v*`) that pushes to Open VSX and builds the .vsix for the Marketplace (option A) or publishes it (option B).

### Risks
- Entra ID with a personal account: undocumented. Option A is the fallback and depends on nothing.
- Open VSX runs automatic checks when publishing (secret detection, blocklist, typosquatting). The package holds no secret, but a false positive would block the publish.

## 4. Workstream 2: Mermaid 12 (2–3 d, version 1.2.0)

### Measurements (real packages built with `vsce package`, same content as 1.1.2)

| Bundled Mermaid | Raw `mermaid.min.js` | .vsix | Change |
|-----------------|----------------------|-------|--------|
| 10.9.8 (current) | 3.34 MB | **1.09 MB** | — |
| 11.17.2 | 3.57 MB | 1.08 MB | −1 % |
| 12.2.0 full (ELK included) | 5.49 MB | **1.68 MB** | **+53 %** |
| 12.2.0 "tiny" (`@mermaid-js/tiny`, no ELK) | 2.81 MB | **0.84 MB** | −23 % |

- The Mermaid 12 ESM build (chunks loaded on demand) also weighs about 1.58 MB compressed in total (208 files). It only helps if we ship a subset of the chunks, which would be fragile because their names contain hashes. Ruled out.
- The tiny build has no ELK, mindmap, architecture diagram or KaTeX, and no lazy loading. A `layout: elk` request falls back to dagre. Its README says it is "designed to be used via CDN", but it is published on npm under the MIT license and can be bundled like the current build.

### What Mermaid 12 changes for us
- **Breaking changes**: ELK becomes the default layout (ER diagrams included), and the default theme/look becomes `redux-color` / `neo`. To keep the current rendering: `mermaid.initialize({ layout: 'dagre', look: 'classic', theme: … })`. The code already passes `theme` (`default` / `dark`) explicitly. Mermaid 12 also requires ES2024 in the browser; the VS Code ≥ 1.96 webview (Chromium 128) supports it, confirmed by the integration test, which CI also runs on VS Code 1.96.0. The ER diagram does not even need it: the only ES2024 call of the bundle (`Object.groupBy`) is in the parser of the Langium-based diagram types, and the test also passed on VS Code 1.84.2 (Chromium 114) with `engines.vscode` lowered for the check. For the tests: Node ≥ 22.12; the repository already requires Node 22.
- **Gains for the ER diagram** (added between 11.x and 12):
  - Unicode attribute names, which lifts the README limitation "attribute names … limited to ASCII";
  - entity aliases `id["exact name"]`: we keep a sanitized identifier and display the exact table name;
  - `direction LR/TB`;
  - `classDef` / `style` to highlight search results (workstream 3);
  - optional types `type?` (11.16) to show nullability;
  - subgraphs (11.17) to group tables, for example by entity sub-folder or by connection.

### Work
1. Bump `devDependencies.mermaid` (and `scripts/copy-vendor.js` if tiny is chosen: different package, different source file).
2. `views/mermaid/mermaid.js`: explicit `layout: 'dagre', look: 'classic'`, so no visual change at first.
3. `views/mermaid/generator.js`: revisit the sanitizing written for the 10.9.8 grammar (Unicode, aliases, `?`). The `mermaid.test.js` test, which has the real Mermaid parse every generated diagram, is the safety net. Its title "accepted by Mermaid 10.9.8" must be updated.
4. Visual check on the fixtures (`blog-app`, a 150-table schema) in light, dark and high-contrast themes.
5. Later: a `DrawMeDatabase.layout` setting (`dagre` | `elk`). ELK only becomes the default after a benchmark (rendering time and readability on 150 tables). A third-party summary of open issues mentions misplaced edge labels with ELK.

### Decision 1: do we want ELK?
- **Yes**: full build, 1.68 MB .vsix (still well below the 4.4 MB of 1.1.1).
- **No**: tiny build, 0.84 MB .vsix, dagre only (the current rendering).
- Recommendation: **full build**. The layout is the main lever for the readability of large schemas, and +0.6 MB is reasonable. If the benchmark shows ELK brings nothing, switch to tiny.

### Risks
- Unintended change of appearance if the explicit configuration misses a setting: check visually.
- 10.9.x still receives security fixes (10.9.8 is from August 2026), but nothing guarantees for how long: do not postpone this workstream indefinitely.

## 5. Workstream 3: UX (8–10 d, versions 1.2.0 and 1.3.0)

Findings in `extension.js`: each render replaces `panel.webview.html`, which reloads the whole page (Mermaid included). Switching between JSON and Mermaid reloads the page too. There is no `getState`/`setState` and no panel serializer. Parsing is synchronous (`readFileSync`, `execFileSync` for git) and runs in the extension host.

| Item | Effort | Version | Notes |
|------|--------|---------|-------|
| a. **Webview foundation**: page loaded once, data sent with `postMessage`, state (viewer, zoom, filter) kept with `vscode.setState` | 1–1.5 d | 1.2.0 | Prerequisite for b, e and f. The `webview.test.js` and `extension.test.js` tests need updating. |
| b. **Zoom / pan**: Ctrl + wheel, drag, +, −, "fit" and 100 % buttons, state kept across refreshes | 1–1.5 d | 1.2.0 | Own implementation (CSS transform on the SVG, about 150 lines, no dependency). `svg-pan-zoom` has not moved since 2024; `@panzoom/panzoom` (MIT) is the fallback. |
| c. **Export**: SVG, `.mmd` source, Markdown with a `mermaid` block, "copy source" | 1 d | 1.2.0 | The webview sends the content, the extension opens `showSaveDialog` then calls `workspace.fs.writeFile`. The CSP does not change. |
| d. **Click on a table → opens the file** | 1.5–2 d | 1.3.0 | The pivot format needs an optional `source: { file, line }` field per table (the migration that creates the table for Laravel, the entity class for Symfony). The current parsers already know the lines (`createLineLocator`, `property.lines`): **workstream 4 is not needed**. In the webview, mapping an SVG node to its table relies on the ids Mermaid generates, which change between versions: keep a test that pins it. The extension only opens paths found in the pivot. |
| e. **Auto-refresh** on save | 1–1.5 d | 1.3.0 | `FileSystemWatcher` on `database/migrations/*.php` or `src/Entity/**/*.php` (taking `frameworkPath` into account), about 500 ms debounce, only while the panel is open. `DrawMeDatabase.autoRefresh` setting. Since parsing and git are synchronous, measure on a large project; make git asynchronous if needed. |
| f. **Search / filter**: input field, matching tables with their direct neighbours, highlighted with `classDef` | 1.5 d | 1.3.0 | The generator already runs in the webview, so the diagram is regenerated client-side. Needs workstream 2 for `classDef` on ER diagrams. The JSON viewer is filtered too. |

### Risks
- d depends on the DOM structure Mermaid produces: fragile on every Mermaid upgrade, hence the dedicated test.
- e may freeze the extension host on a very large repository (synchronous git with a 15 s timeout): measure before enabling the setting by default.

## 6. Workstream 4: AST-based parsers with `php-parser` (10–14 d, version 1.4.0)

### Evaluation of `php-parser` 3.7.0 (glayzzle)
- BSD-3 license, **no dependencies**. Active project: 8 releases in 2026, the latest on June 10, 2026.
- Probe: PHP 8.4 syntax is accepted and modeled correctly (property hooks → `hooks`, asymmetric visibility → `visibilitySet`), as are attributes, enums, `readonly` classes, typed constants, heredocs and `@ORM` docblocks. **The 61 PHP files of the fixtures parse without error, in 60 ms in total.**
- Packaging:
  - the `dist/php-parser.min.js` bundle (UMD) **does not load under Node** (it references `self`);
  - `node_modules/php-parser/src` must be shipped (146 files, about 110 KB compressed, so **+0.11 MB** on the .vsix) with an exception in `.vscodeignore`, which excludes `node_modules/**` today. It would be the first runtime dependency. There is still no build step.

### What the AST brings, and what it does not
- **Gains**:
  - no more edge cases of the scanner (strings, nested closures, comments);
  - simple resolution of constants and variables (`self::TABLE`, `$table = 'x'`), skipped with a warning today;
  - attribute arguments as nodes;
  - exact positions (useful for item 3d).
- **No gain**:
  - conditional code is still applied "as if every branch ran";
  - Doctrine `@ORM` annotations remain docblock text, so the annotation mini-parser stays;
  - the limitations listed in the README (XML/YAML mappings, package migrations, Eloquent models) do not change.

### Method
1. Same contract `parse(basePath) → { tables, warnings }`. The **127 parser tests** (58 Laravel, 69 Symfony) are black-box tests on this contract and serve as the safety net. The 14 `php-utils` tests go away with the scanner. The tests check the text and line numbers of the warnings: keep them.
2. A **comparison harness**: both implementations run side by side and their pivot output is compared, on the fixtures and on a corpus of real projects (Laravel skeleton, Symfony Demo, a few open-source projects). Switch only when there is no difference, or every difference is explained.
3. Laravel first (where the gain is clearest), then Symfony.
4. Fallback: if php-parser throws on a file (future syntax or broken file), warn and apply the old scanner to that file. The scanner is removed one version later.

### Risks
- Silent regressions on rare syntax: this is what the comparison harness is for.
- Dependence on a single maintainer on the glayzzle side; a delay on PHP 8.5 or 9 is handled by the fallback.
- The cost (10–14 d) is high for an invisible gain. **Only start it if** a class of scanner bugs shows up, or if constant resolution is wanted.

## 7. Workstream 5: accuracy by running PHP (out of scope, proposed for later)

- **Laravel**, migrations run on in-memory SQLite:
  - PHP, `vendor/` and `pdo_sqlite` must be available on the machine. With Sail or Docker, PHP is often not on the host, hence a `phpCommand` setting;
  - a PHP bootstrap script is also needed, because the `:memory:` database is lost between two `artisan` calls. Introspection (`Schema::getTables/getColumns/getForeignKeys`) only exists since Laravel 10.x (late 2023);
  - MySQL-specific `DB::statement` calls fail on SQLite;
  - above all, **the project's code is executed** (migrations with side effects, `.env`).
- **Symfony**:
  - `doctrine:mapping:describe --format=json` **only exists since Doctrine ORM 3.7.0**, released on September 7, 2026: most projects do not have it yet;
  - it handles **one entity per call**, so one kernel boot per entity, which is slow;
  - the alternative, `doctrine:schema:create --dump-sql`, means parsing an SQL dialect and may try to connect to detect the platform when `server_version` is not configured.
- **Why out of scope**: the README promises "reads your code, it does not execute it nor connect to a database". Changing that is a product decision (decision 3), not technical modernization. If it ever happens, it would be an explicit opt-in, with a fallback to static analysis.

## 8. Deliberately out of scope

- Workstream 5 (see above).
- ~~PNG export: with labels in `foreignObject`, the canvas gets "tainted". SVG and `.mmd` are enough.~~ Done in 1.2.0 with `htmlLabels: false` (see decisions).
- Other frameworks (Django, commented out in `parsers/parser.js`, Rails, Prisma…).
- Relations inferred from Eloquent models, Doctrine XML/YAML mappings and embeddables.
- Connecting to a real database, and editing the schema from the diagram.
- Moving to TypeScript or to a bundler: plain CommonJS JS without a build step, with `jsconfig`, is enough, and every workstream above works with it.
- VS Code for the Web and Restricted Mode (not supported, as today).

## 9. Decisions (October 18, 2026)

Guillaume delegated the choices; they follow the recommendations, checked against measurements where there were none.

1. **ELK: yes, full Mermaid 12 build.** ELK is also the **default layout**. Benchmark in the webview (Chromium, synthetic schema of 150 tables, 1 to 3 foreign keys each): ELK draws in 4.7 s a 18 540 × 8 939 px diagram (2:1), Dagre in 3.9 s a 29 497 × 6 773 px one (4.4:1). ELK is more compact, with right-angled links and well-placed labels (the label issues mentioned above were fixed in 12.1 and 12.2). Dagre stays available in the toolbar and in the `DrawMeDatabase.layout` setting.
2. **Marketplace: manual upload** of the .vsix built by the release workflow. The Entra ID job stays commented in `release.yml`; revisit if releases become frequent.
3. **Workstream 5: out of scope.** The extension keeps reading the code without running it.
4. **Workstream 4: in reserve**, until a class of scanner bugs or the need to resolve constants shows up.
5. **This plan is in the repository** (this file).

Other choices made while implementing 1.2.0:
- `look: 'classic'` and Mermaid's `base` theme filled with the colors of the current VS Code theme (instead of `neo` / `redux-color`): the diagram matches any theme, including high contrast.
- `htmlLabels: false`: plain SVG text, so the SVG export opens in any editor and the PNG export can draw it on a canvas (the PNG export ruled out in section 8 is possible this way).
- Readable entity ids in the generated source (`users ||--o{ posts`), with generated ids only for names that are not plain words, so the exported Mermaid source is easy to read.
- `retainContextWhenHidden` on the panel: large diagrams take seconds to draw, so they are kept while the tab is hidden.

## Sources

- VS Code, Publishing Extensions (retirement of global PATs, Entra ID, `--azure-credential`): https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- Write-up on GitHub Actions + Entra ID: https://dev.to/emrecodes/publishing-to-the-vs-code-marketplace-with-ci-4p2h
- Open VSX, Publishing Extensions: https://github.com/eclipse/openvsx/wiki/Publishing-Extensions
- Open VSX, Trusted Publishing: https://github.com/eclipse/openvsx/wiki/Trusted-Publishing
- Mermaid 12.0.0 release notes: https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.0.0
- Mermaid ER syntax: https://mermaid.js.org/syntax/entityRelationshipDiagram.html
- Doctrine ORM, `MappingDescribeCommand` (3.7.x branch, `--format` option): https://github.com/doctrine/orm
- Laravel, `Schema::getColumns` / `getForeignKeys` / `getTables` (PRs #48357, #49264, #49020): https://github.com/laravel/framework

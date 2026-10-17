# Welcome to your VS Code Extension

## What's in the folder

* This folder contains all of the files necessary for your extension.
* `package.json` - this is the manifest file in which you declare your extension and command.
  * The sample plugin registers a command and defines its title and command name. With this information VS Code can show the command in the command palette. It doesn’t yet need to load the plugin.
* `extension.js` - this is the main file where you will provide the implementation of your command.
  * The file exports one function, `activate`, which is called the very first time your extension is activated (in this case by executing the command). Inside the `activate` function we call `registerCommand`.
  * We pass the function containing the implementation of the command as the second parameter to `registerCommand`.

## Get up and running straight away

* Press `F5` to open a new window with your extension loaded.
* Run your command from the command palette by pressing (`Ctrl+Shift+P` or `Cmd+Shift+P` on Mac) and typing `Hello World`.
* Set breakpoints in your code inside `extension.js` to debug your extension.
* Find output from your extension in the debug console.

## Make changes

* You can relaunch the extension from the debug toolbar after changing code in `extension.js`.
* You can also reload (`Ctrl+R` or `Cmd+R` on Mac) the VS Code window with your extension to load your changes.

## Explore the API

* You can open the full set of our API when you open the file `node_modules/@types/vscode/index.d.ts`.

## Run tests

* Run `npm install` first: it also copies the pinned Mermaid build to `views/vendor/` (see `scripts/copy-vendor.js`).
* `npm run test:unit` runs the unit tests in `test/unit/` with Node's test runner (no VS Code needed).
* `npm test` runs lint, the unit tests, then the integration tests in `test/integration/` inside a downloaded VS Code
  (on Linux without a display: `xvfb-run -a npm test`; `.vscode-test.mjs` keeps the test VS Code on the X display that
  xvfb-run sets, also on a Wayland desktop). Their workspace is `test/fixtures/integration/workspace`.
* You can also install the [Extension Test Runner](https://marketplace.visualstudio.com/items?itemName=ms-vscode.extension-test-runner)
  and run the integration tests from the Testing view.
* `npm run package` builds the `.vsix` into `builds/`.

## Go further

 * [Follow UX guidelines](https://code.visualstudio.com/api/ux-guidelines/overview) to create extensions that seamlessly integrate with VS Code's native interface and patterns.
 * [Publish your extension](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) on the VS Code extension marketplace.
 * Automate builds by setting up [Continuous Integration](https://code.visualstudio.com/api/working-with-extensions/continuous-integration).
 * Integrate to the [report issue](https://code.visualstudio.com/api/get-started/wrapping-up#issue-reporting) flow to get issue and feature requests reported by users.

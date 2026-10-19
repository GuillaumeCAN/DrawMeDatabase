import globals from "globals";

const rules = {
    "no-const-assign": "warn",
    "no-this-before-super": "warn",
    "no-undef": "warn",
    "no-unreachable": "warn",
    "no-unused-vars": "warn",
    "constructor-super": "warn",
    "valid-typeof": "warn",
};

export default [
    {
        ignores: ["node_modules/**", "views/vendor/**", "builds/**", ".vscode-test/**", ".idea/**"],
    },
    // Extension host, parsers, scripts and tests (CommonJS, Node)
    {
        files: ["**/*.js"],
        ignores: ["views/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: {
                ...globals.node,
            },
        },
        rules,
    },
    // Integration tests run by @vscode/test-cli (mocha TDD interface)
    {
        files: ["test/integration/**/*.js"],
        languageOptions: {
            globals: {
                ...globals.mocha,
            },
        },
    },
    // Node-side helper of the views
    {
        files: ["views/html.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: {
                ...globals.node,
            },
        },
        rules,
    },
    // Webview scripts (browser)
    {
        files: ["views/**/*.js"],
        ignores: ["views/html.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "script",
            globals: {
                ...globals.browser,
                acquireVsCodeApi: "readonly",
                mermaid: "readonly",
            },
        },
        rules,
    },
    // Shared with the unit tests through module.exports
    {
        files: ["views/mermaid/generator.js", "views/mermaid/zoom.js", "views/exporters.js"],
        languageOptions: {
            globals: {
                module: "readonly",
            },
        },
    },
    // ES module configuration files
    {
        files: ["**/*.mjs"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: {
                ...globals.node,
            },
        },
        rules,
    },
];

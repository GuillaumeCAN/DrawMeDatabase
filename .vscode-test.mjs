import { defineConfig } from '@vscode/test-cli';

// Linux with an X display (xvfb-run sets one): keep the test VS Code on it, Electron would
// otherwise open its window on the Wayland session of the desktop
const useX11 = process.platform === 'linux' && Boolean(process.env.DISPLAY);

// VS Code to test with: stable by default, or a version such as 1.96.0 (CI also tests the
// oldest version allowed by engines.vscode)
const version = process.env.VSCODE_TEST_VERSION || 'stable';

export default defineConfig({
	version,
	files: 'test/integration/**/*.test.js',
	// Workspace with a tiny Laravel app in a subfolder (see its .vscode/settings.json)
	workspaceFolder: 'test/fixtures/integration/workspace',
	launchArgs: ['--disable-extensions', ...(useX11 ? ['--ozone-platform=x11'] : [])],
	env: useX11 ? { WAYLAND_DISPLAY: undefined } : {},
	mocha: {
		ui: 'tdd',
		timeout: 20000,
	},
});

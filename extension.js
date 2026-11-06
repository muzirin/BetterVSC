const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CURSOR_MARKER = "BETTERVSC_CURSOR_V3";
const FONTS_MARKER = "BETTERVSC_FONTS_V1";

const CODE_FONT = '"JetBrains Mono", "Maple Mono NF CN", "MiSans", monospace';
const UI_FONT = '"Maple Mono NF CN", "MiSans", sans-serif';
const TERMINAL_FONT = '"Maple Mono NF CN", "MiSans", monospace';

const FORCED_SETTINGS = {
	"editor.fontFamily": CODE_FONT,
	"terminal.integrated.fontFamily": TERMINAL_FONT,
	"terminal.integrated.gpuAcceleration": "off",
	"debug.console.fontFamily": TERMINAL_FONT,
	"chat.fontFamily": UI_FONT,
	"chat.editor.fontFamily": TERMINAL_FONT,
	"scm.inputFontFamily": TERMINAL_FONT,
	"markdown.preview.fontFamily": UI_FONT,
};

let contextRef;
let applying = false;
let applyTimer;

function explorerVimEnabled() {
	return vscode.workspace.getConfiguration("bettervsc").get("explorerVim", true);
}

async function updateExplorerVimContext() {
	try {
		await vscode.commands.executeCommand(
			"setContext",
			"bettervsc.explorerVim",
			explorerVimEnabled()
		);
	} catch {
		// Ignore.
	}
}

async function openFocusedInEditor() {
	try {
		await vscode.commands.executeCommand("list.select");
		await new Promise((resolve) => setTimeout(resolve, 50));
		await vscode.commands.executeCommand(
			"workbench.action.focusActiveEditorGroup"
		);
	} catch (error) {
		vscode.window.showErrorMessage(
			`BetterVSC: failed to open the focused item: ${
				error && error.message ? error.message : error
			}`
		);
	}
}

function targetDirectory() {
	return path.join(os.homedir(), ".vscode", "bettervsc");
}

function fileUri(filePath) {
	return "file:///" + filePath.replace(/\\/g, "/");
}

function copyMedia(context) {
	const dir = targetDirectory();
	fs.mkdirSync(dir, { recursive: true });

	const files = ["bettervsc-cursor.js", "bettervsc-fonts.css"];
	for (const file of files) {
		const source = path.join(context.extensionPath, "media", file);
		const target = path.join(dir, file);
		fs.copyFileSync(source, target);
	}

	return {
		cursor: path.join(dir, "bettervsc-cursor.js"),
		fonts: path.join(dir, "bettervsc-fonts.css"),
	};
}

function findWorkbenchHtml() {
	const appRoot = vscode.env.appRoot;
	if (!appRoot) return null;

	const base = path.join(appRoot, "out", "vs", "code");
	const dirs = [
		path.join(base, "electron-browser", "workbench"),
		path.join(base, "electron-browser"),
		path.join(base, "electron-sandbox", "workbench"),
		path.join(base, "electron-sandbox"),
	];
	const names = [
		"workbench-dev.html",
		"workbench.esm.html",
		"workbench.html",
		"workbench-apc-extension.html",
	];

	for (const dir of dirs) {
		for (const name of names) {
			const candidate = path.join(dir, name);
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return null;
}

function htmlHasMarkers() {
	const htmlPath = findWorkbenchHtml();
	if (!htmlPath) return true;
	try {
		const html = fs.readFileSync(htmlPath, "utf8");
		return html.includes(CURSOR_MARKER) && html.includes(FONTS_MARKER);
	} catch {
		return true;
	}
}

async function ensureCustomCss(force) {
	const files = copyMedia(contextRef);
	const config = vscode.workspace.getConfiguration("vscode_custom_css");
	const current = config.get("imports") || [];

	const wanted = [
		fileUri(files.fonts),
		fileUri(files.cursor),
	];

	const filtered = current.filter((item) => {
		const lower = String(item).toLowerCase().replace(/\\/g, "/");
		return !(
			lower.includes("/bettervsc-cursor.js") ||
			lower.includes("/bettervsc-fonts.css") ||
			lower.includes("neovide-cursor")
		);
	});

	const next = [...filtered, ...wanted];
	const changed =
		next.length !== current.length ||
		next.some((item, index) => item !== current[index]);

	if (changed) {
		await config.update("imports", next, vscode.ConfigurationTarget.Global);
	}

	if (!force && !changed && htmlHasMarkers()) return;

	const extension = vscode.extensions.getExtension("be5invis.vscode-custom-css");
	if (!extension) {
		vscode.window.showWarningMessage(
			"BetterVSC: vscode-custom-css is not installed; the cursor/font CSS was not injected."
		);
		return;
	}

	try {
		await extension.activate();
		await vscode.commands.executeCommand("extension.updateCustomCSS");
	} catch (error) {
		vscode.window.showErrorMessage(
			`BetterVSC: failed to re-inject custom CSS: ${error && error.message ? error.message : error}`
		);
	}
}

function scheduleApply() {
	if (!vscode.workspace.getConfiguration("bettervsc").get("enforce", true)) return;
	clearTimeout(applyTimer);
	applyTimer = setTimeout(() => {
		applyForcedSettings();
	}, 150);
}

async function applyForcedSettings() {
	if (applying) return;
	if (!vscode.workspace.getConfiguration("bettervsc").get("enforce", true)) return;
	applying = true;
	try {
		const config = vscode.workspace.getConfiguration();
		for (const [key, value] of Object.entries(FORCED_SETTINGS)) {
			const inspected = config.inspect(key);
			if (inspected && inspected.globalValue === value) continue;
			try {
				await config.update(key, value, vscode.ConfigurationTarget.Global);
			} catch {
				// A setting can be unavailable if its built-in extension is disabled.
			}
		}
	} finally {
		applying = false;
	}
}

async function activate(context) {
	contextRef = context;

	context.subscriptions.push(
		vscode.commands.registerCommand("bettervsc.apply", async () => {
			await vscode.workspace
				.getConfiguration("bettervsc")
				.update("enforce", true, vscode.ConfigurationTarget.Global);
			await applyForcedSettings();
			await ensureCustomCss(true);
			vscode.window.showInformationMessage(
				"BetterVSC: fonts and cursor settings applied. Reload the window to finish."
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("bettervsc.injectCustomCss", async () => {
			await ensureCustomCss(true);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("bettervsc.openFocusedInEditor", async () => {
			await openFocusedInEditor();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("bettervsc.toggleExplorerVim", async () => {
			const next = !explorerVimEnabled();
			await vscode.workspace
				.getConfiguration("bettervsc")
				.update("explorerVim", next, vscode.ConfigurationTarget.Global);
			await updateExplorerVimContext();
			vscode.window.showInformationMessage(
				`BetterVSC: Explorer Vim keys ${next ? "enabled" : "disabled"}.`
			);
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("bettervsc.explorerVim")) {
				updateExplorerVimContext();
			}

			if (event.affectsConfiguration("bettervsc.enforce")) {
				if (vscode.workspace.getConfiguration("bettervsc").get("enforce", true)) {
					scheduleApply();
				}
				return;
			}

			const affected = Object.keys(FORCED_SETTINGS).some((key) =>
				event.affectsConfiguration(key)
			);
			if (affected) scheduleApply();
		})
	);

	await updateExplorerVimContext();
	await applyForcedSettings();

	if (!htmlHasMarkers()) {
		await ensureCustomCss(false);
	}
}

function deactivate() {
	clearTimeout(applyTimer);
}

module.exports = { activate, deactivate };

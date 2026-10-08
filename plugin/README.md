# Herdr Cockpit for VS Code: the Herdr plugin

Jump from [Herdr](https://herdr.dev) in your terminal to the same space in VS Code, Cursor, Kiro or Positron, with the [Herdr Cockpit](../README.md) extension showing your spaces, agents and shells.

One plugin and one editor window instead of several plugins and windows:

- **Files, git and review in the real editor.** The editor's Explorer, Source Control, diffs, search and every extension and file viewer (notebooks, Markdown, images, PDFs) work on the space's folder, so you don't need separate Herdr plugins for a file explorer, a web UI or a git reviewer.
- **Agent usage in one place.** The extension shows Claude Code, Codex and Kiro plan limits side by side.
- **Back and forth in one keystroke.** Open the space or pane you're on in the editor, or a `file:line` you selected in any pane.

![The same Herdr space, in Herdr's terminal and in VS Code. Open in editor (ctrl+b, then shift+E) takes you from one to the other](https://raw.githubusercontent.com/sriharirao92/vscode-herdr-cockpit/main/docs/images/terminal-to-vscode.png)

```bash
herdr plugin install sriharirao92/vscode-herdr-cockpit/plugin
```

Herdr shows what the plugin runs before installing. It's one POSIX shell script (`herdr-cockpit.sh`): no build step, nothing else to install. macOS and Linux.

## Actions

Run them with a keybinding (setup offers to add them), or from any terminal: `herdr plugin action invoke sriharirao.vscode-herdr-cockpit.<action>` (the action acts on the space you have focused in Herdr).

| Action | What it does |
|---|---|
| **Herdr Cockpit: Open in editor** | Opens the Cockpit window on the space you're in, with the focused pane's tab in front. |
| **Herdr Cockpit: Open selected file in editor** | Select a location in any pane and open it at that line: `src/app.ts:42:7`, `src/app.ts:42`, `app.ts(42,7)`, `app.ts#L42`, `File "app.py", line 12`. Relative paths are resolved against the folder the pane's program is in. |
| **Herdr Cockpit: Review changes in editor** | The focused pane's repository changes as diffs. |
| **Herdr Cockpit: Status** | Which editors have the extension, and whether the Cockpit window is connected. |
| **Herdr Cockpit: Set up editor** | Pick the editor, install the extension in it, and add keybindings. Runs by itself the first time you open something. |

The first time, **Set up editor** opens in a popup: it lists the editors it finds, installs Herdr Cockpit in the one you pick (from its extension store, else from this repository's latest release) and offers these keybindings in Herdr's `config.toml` when they're free:

| Key | Action |
|---|---|
| `prefix+shift+e` | Open in editor |
| `prefix+shift+o` | Open selected file in editor |

## Settings

`config.toml` in the plugin's config directory (`herdr plugin config-dir sriharirao.vscode-herdr-cockpit`):

```toml
editor = "cursor"          # vscode, cursor, kiro, positron, vscode-insiders, vscodium, windsurf
review_on_done = false     # open an agent's changes when it finishes
ssh_host = "my-server"     # the name your computer uses to SSH here (remote setups)
```

Without `editor`, the plugin uses the editor where the Herdr Cockpit extension ran most recently.

## Herdr on a server

If Herdr runs on a remote machine, open it from your computer with Remote-SSH (`code --remote ssh-remote+<host> ~`), install Herdr Cockpit there, and run **Herdr Cockpit: Set Up Cockpit Window**. The extension runs on the server next to Herdr. **Set up editor** prints the command when it finds no editor on the machine.

## How it works

The extension writes `~/.herdr-cockpit/editors/<editor>.json` (its version and the editor's command line) and, from the Cockpit window, `~/.herdr-cockpit/status/<editor>.json`. The plugin opens links like `cursor://sriharirao.herdr-cockpit/open?space=w1&pane=w1:p2` with the editor's own command line (`--open-url`). A link can only name a space, a pane or a file, and the extension validates it again.

Clicking `file:line` text in a pane isn't possible yet: Herdr 0.9 only sends clicks on `http(s)` URLs to plugins. Select the text and run **Open selected file** instead.

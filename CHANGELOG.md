# Changelog

Herdr Hub (the editor extension) and the Herdr plugin (`plugin/`) are released together from this repository.

## Unreleased

- A window opened without a folder (a new window, or the editor's first launch) offers **Open Herdr Hub**, which turns it into the hub window (`herdr.offerHubOnStartup`: `emptyWindows`, `allWindows`, `never`). It stays quiet when Herdr isn't installed or a hub window is already open.
- Opening a space closes the editor's Welcome page, and the hub window opens without one (`workbench.startupEditor` = `none` for the hub workspace, unless you set it).

## 0.1.0 (2026-10-06)

First public release. Tested with Herdr 0.9.3 on macOS: in VS Code by hand and with an automated real-editor test, in Positron by hand, and started in Cursor. Kiro installs it but hasn't been tried by hand yet. Unit tests run on macOS and Linux.

### Extension
- **Links from Herdr**: `<editor>://sriharirao.herdr-hub/open|review|file`, used by the Herdr plugin. Links act in the hub window; a link that reaches another window is handed over to it (and the hub window is created or focused).
- **Get started walkthrough**: connect to Herdr, open the hub window, find the sidebar, install the Herdr plugin, plan limits, the guide.
- **Install the Herdr Plugin** command.
- **Agents left, shells right**: `herdr.terminalLocation` = `editorSplit`.
- Terminal tabs show just their name in any saved or untitled workspace you've switched spaces from, not only the hub window.
- **Terminal tabs work like the Herdr TUI**: Herdr Hub draws each tab from Herdr's live stream of the pane (instead of running `herdr attach` in it). Drag, double-click or triple-click selects and copies, with a "Copied to clipboard" note; the wheel scrolls Herdr's scrollback; a click goes to the program in the pane (Herdr 0.9.2+). The terminal "+" opens the same kind of tab.
- **Tabs and Herdr stay in sync**: closing a tab with its X closes the pane in Herdr (`herdr.closeTabInHerdr`: idle shells at once; agents, busy shells and a space's last tab ask first). Switching spaces and closing the window only detach. Verified in a real VS Code by `npm run test:vscode`.
- **Split Terminal** on a Herdr tab splits that pane in Herdr (same Herdr tab); **renaming** a tab renames the pane (or agent) in Herdr, and Herdr renames update the tab without taking focus.
- Herdr tabs stay in one editor group (the one already showing them, else the last one used) instead of following the active group.
- Tested with Herdr 0.9.3 (protocol 22, unchanged from 0.9.1).
- Clicking a space outside the hub window asks first: **Open Hub Window** (the space and pane open there) or **Use This Window** (remembered per window). A window with no folder goes straight to the hub window.
- **Linux**: Herdr, git and Codex are found in Linux install locations (`~/.local/bin`, Linuxbrew, `/usr/bin`, Nix, Snap); help shows Ctrl+Shift+P on Linux.
- **Remote**: the extension runs where your workspace is (`extensionKind: workspace`), so with Remote-SSH it runs on the server next to Herdr.
- Publisher is now `sriharirao` (extension id `sriharirao.herdr-hub`). Uninstall the earlier `srihari-local.herdr-hub` build.

### Plugin (new)
- **Open in editor**, **Open selected file in editor** (`path:line:col`, `path(line,col)`, `path#L42`, Python tracebacks), **Review changes in editor**, **Status** and **Set up editor** actions.
- Setup finds VS Code, Cursor, Kiro and Positron (and VS Code Insiders, VSCodium, Windsurf), installs the extension, and can add Herdr keybindings.
- Optional: open an agent's changes when it finishes (`review_on_done`).

## 0.0.26
- Herdr not installed, not running, crashed or incompatible: each has its own screen; **Start Herdr** runs the server in the background; reconnects with backoff and offers to reopen the space's tabs when Herdr is back. Setting `herdr.startServer`.
- Started servers get a terminal-like environment, so Kiro's shell integration no longer hides agents.
- Live updates: agent status changes now arrive as events (they silently fell back to polling before).
- The hub window opens the sidebar the first time (Cursor hides extension icons behind an overflow menu).

## 0.0.20
- Git safety fails closed: no lazy fetches, no hooks, every repository-defined filter disabled; git runs only in trusted windows.

## 0.0.19
- Repository-defined programs (clean filters, gpg) can't run from the sidebar's git calls.
- Help page: header, privacy and troubleshooting sections.

## 0.0.18
- Renamed from Herdr Bridge to Herdr Hub. Tidier header. `herdr.binaryPath` and `herdr.socketPath` are machine-scoped.

## 0.0.2 – 0.0.17
- Sidebar of spaces, agents and shells with live status, shell activity, agent logos, usage (Claude Code, Codex, Kiro), create/rename/close spaces and tabs, the terminal **+** creating Herdr tabs, follow mode, the hub window and a help page.

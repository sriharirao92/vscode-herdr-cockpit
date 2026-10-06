# Changelog

Herdr Hub (the editor extension) and the Herdr plugin (`plugin/`) are released together from this repository.

## Unreleased

### Extension
- **Links from Herdr**: `<editor>://sriharirao.herdr-hub/open|review|file`, used by the Herdr plugin. Links act in the hub window; a link that reaches another window is handed over to it (and the hub window is created or focused).
- **Get started walkthrough**: connect to Herdr, open the hub window, find the sidebar, install the Herdr plugin, plan limits, the guide.
- **Install the Herdr Plugin** command.
- **Agents left, shells right**: `herdr.terminalLocation` = `editorSplit`.
- Terminal tabs show just their name in any saved or untitled workspace you've switched spaces from, not only the hub window.
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

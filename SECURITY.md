# Security

## Reporting a vulnerability

Please report security issues privately through GitHub: **Security → Report a vulnerability** on this repository. Don't open a public issue. You'll get a reply within a few days.

## What the extension and plugin do

Herdr Cockpit is a client of your local Herdr server. It never runs agents itself.

- **Herdr**: talks to Herdr's socket (`~/.config/herdr/herdr.sock` or a named session's). It creates, renames and closes spaces, tabs and panes only when you ask, with a confirmation before anything is closed.
- **Git**: runs read-only `git status` / `git log` in your spaces' folders, only in trusted windows, with repository-defined programs disabled (fsmonitor, filters, hooks, signature checks, lazy fetches).
- **Programs it starts**: `herdr` (streaming panes into terminal tabs, starting the server when you click Start Herdr) and, while a Codex pane is open, `codex app-server` to read your plan limits. `herdr.binaryPath` and `herdr.socketPath` are machine-scoped, so a repository's settings can't choose them.
- **Files it reads**: usage data from `~/.codex/sessions`, `~/.claude/projects` and Kiro's session files (only the metering fields). It never reads credentials.
- **Files it writes**: `~/.herdr-cockpit` (the hub workspace, editor and status files for the plugin), and `~/.claude/settings.json` only after you confirm **Show plan limits** (a backup is kept).
- **Links**: `<editor>://sriharirao.herdr-cockpit/...` links can come from anywhere, so they can only select a space, pane or file you already have. Every field is validated. A file outside your Herdr spaces and open folders (symlinks resolved) asks before opening; network paths are refused. A link for another Herdr session asks before switching.

The plugin is one shell script you can read in full (`plugin/herdr-cockpit.sh`). It only calls Herdr's CLI and your editor's command line, writes its own `config.toml`, and appends to Herdr's `config.toml` only when you agree to add keybindings.

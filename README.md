# Herdr Hub

Your [Herdr](https://herdr.dev) spaces, agents and shells in **one** editor window, with the editor's files, diffs and source control alongside.

Herdr keeps running your agents (Claude Code, Codex, Kiro, Cursor Agent, Copilot, Gemini and more) in its own terminal multiplexer. Herdr Hub is a client of the Herdr server: switching a space mounts its folder and opens every agent and shell as a terminal tab, and the sidebar shows what each one is doing. Closing a tab only detaches; the agent keeps running in Herdr.

Works in **VS Code, Cursor, Kiro and Positron** on **macOS and Linux**. A community project, not affiliated with Herdr.

## Features

- **Spaces & Agents sidebar**, live from Herdr: each space is a card with its branch and changes; agents show a colored status (working, blocked, done, idle), time in state and a one-line summary of what they last said. **Needs you** lists blocked and done agents with a preview of their screen. **Shells** show what is running, or the last command and its output.
- **Switch spaces**: click one to swap its folder into the window (Explorer, Search and Source Control follow) and open its agents and shells as tabs, most urgent first. Put agents and shells side by side with `herdr.terminalLocation` = `editorSplit`.
- **Create from the editor**: new spaces (a folder or a new git worktree), new tabs with a shell or an agent; the terminal **+** creates Herdr tabs in the hub window. Rename and close in Herdr.
- **Usage**: Claude Code, Codex and Kiro plan limits (5-hour and weekly windows, reset times, Kiro credits) while their agents run.
- **Review changes**: an agent's diffs, offered when it finishes.
- **Follow mode**: switch spaces in Herdr's terminal and the hub window follows.
- **When Herdr isn't running**: says why (not installed, not running, crashed, incompatible), starts it in the background on request, and reconnects when it's back.

## Requirements

- Herdr 0.9 (socket protocol 22; tested with 0.9.1), running on the same machine as the extension. A newer protocol shows an "incompatible" screen until Herdr Hub is updated. With Remote-SSH, the extension runs on the server next to Herdr.
- macOS or Linux.

## Get started

1. Install **Herdr Hub** from the Extensions view (VS Code Marketplace; Open VSX for Cursor, Kiro and Positron), or download the `.vsix` from [Releases](https://github.com/sriharirao92/herdr-hub/releases) and run `code --install-extension herdr-hub.vsix` (or `cursor`, `kiro`, `positron`).
2. Run Herdr as usual, or click **Start Herdr** in the sidebar.
3. Run **Herdr Hub: Set Up Hub Window**. The hub window's first folder (`~/.herdr-hub`) never changes, so switching spaces never restarts your extensions.
4. Click a space.

The **Get started with Herdr Hub** walkthrough covers the same steps (Command Palette: **Welcome: Open Walkthrough…**).

**Can't see the sidebar?** In Cursor the activity bar is a row of icons across the top of the sidebar, and Herdr Hub may be behind the **⌄** arrow at its end. The Command Palette always works: **Herdr Hub: Focus on Spaces & Agents View**.

## The Herdr plugin

Working in Herdr's terminal? The companion plugin jumps from Herdr to the editor:

```bash
herdr plugin install sriharirao92/herdr-hub/plugin
```

- **Open in editor**: the space and pane you're on, in the hub window.
- **Open selected file in editor**: select `src/app.ts:42:7` (or `app.py", line 12`, `file.ts(42,7)`, `file.ts#L42`) in any pane.
- **Review changes in editor**, **Status**, and **Set up editor** (finds your editors, installs the extension, offers keybindings).

See [plugin/README.md](plugin/README.md).

## Settings

All settings start with `herdr.`; the guide (`?` in the sidebar) lists them. Most used:

| Setting | |
|---|---|
| `herdr.terminalLocation` | `editor`, `editorSplit` (agents left, shells right) or `panel` |
| `herdr.autoAttachShells` | Also open plain shells when switching spaces |
| `herdr.closeTabInHerdr` | Closing a tab's X closes it in Herdr: `ask` (idle shells close at once; agents and busy shells ask), `always`, `never` |
| `herdr.startServer` | Start Herdr when the hub window opens: `ask`, `always`, `never` |
| `herdr.binaryPath`, `herdr.socketPath` | A herdr binary or socket (named session) Herdr Hub doesn't find itself |

## Privacy and security

Nothing leaves your machine. Herdr Hub talks to your local Herdr server, runs read-only git in trusted windows, and reads usage from your agents' local files (never credentials). See [SECURITY.md](SECURITY.md).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). `npm test` needs no editor.

## License

[MIT](LICENSE). Agent logos: see [media/THIRD_PARTY_NOTICES.md](media/THIRD_PARTY_NOTICES.md).

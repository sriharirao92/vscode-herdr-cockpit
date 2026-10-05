# Herdr Hub (prototype)

Herdr spaces and agents inside **one** VS Code window.

- **Spaces & Agents sidebar**: live from Herdr's socket (`session.snapshot` + `events.subscribe`). Each space is a card with its branch and changes; agents show a colored status, time in state and a one-line summary of what they last said. A **Needs you** section lists blocked and done agents with a preview of their screen. **Shells** show what is running (`python app.py`, `vi config.yaml`) or the last command and its output, with failures in red. Status-bar counter and badge.
- **Header buttons**: toggle shell panes, open settings. Right-click a space, agent or shell for more actions.
- **Switch space** (click it): swaps the space's folder into this window (Explorer, Search and Source Control follow), closes the previous space's attach terminals, and opens every pane of the space as its own tab: agents first (most urgent first), then shells. Set `herdr.autoAttachShells` to `false` to open agents only.
- **Create from VS Code**: **+** next to "Spaces" makes a new space (a folder, or a new git worktree of an existing space); **+ New tab** in a space starts a shell or an agent (Claude, Codex, Kiro, Cursor, …). In the hub window VS Code's own terminal **+** creates a Herdr tab in the current space, and its dropdown starts agents. Right-click to rename or close in Herdr.
- **Usage**: plan usage of Claude Code, Codex and Kiro at the top of the sidebar: 5-hour and weekly limit bars with reset countdowns (Codex; Claude after a one-click opt-in), Claude tokens in the current 5-hour block, Kiro credits. Read from each tool's local files.
- **Agent logos** for Claude, Codex, Kiro, Cursor, Copilot, Gemini, Qwen, Kimi, Devin, Grok, OpenCode, Kilo Code, Antigravity, Amp and more (see `media/THIRD_PARTY_NOTICES.md`).
- **Pin** (📌): mount a space alongside the current one instead of swapping.
- **Agent terminals**: `herdr agent attach <pane> --takeover` in native VS Code terminals. Closing one only detaches; the agent keeps running.
- **Follow mode**: switch spaces in the Herdr TUI (e.g. in your Mac terminal) and this window follows.
- **Full status**: per-agent state (or custom state label), time in state, agent kind, model, task title, $tokens; per-space branch, uncommitted changes, ahead/behind. Right-click → **Show Raw Herdr Record** for every field Herdr reports.
- **Review changes**: HEAD ↔ working-tree diffs for the agent's repo; offered automatically when an agent goes `done`.

## Install
    code --install-extension herdr-hub-<version>.vsix

## First run
1. Make sure the Herdr server is running (`herdr` in any terminal, or "Herdr: Open Full Herdr TUI in Editor").
2. Run **Herdr: Set up Herdr Hub Window**. It opens a workspace whose first folder is `~/.herdr-hub`.
   Slot 0 never changes, so switching spaces never restarts extensions.
   (Any normal window works too; the folder you opened stays in slot 0.)
3. Click a space in the Herdr sidebar.

## Debugging
- **Herdr: Show Raw Session Snapshot** shows exactly what Herdr returns. Snapshot types are generated
  from `herdr api schema --json` (`npm run gen:types`).
- Output panel → "Herdr Hub" logs connection and follow events.

## Develop
    npm install && npm run compile && npm test   # mock-server tests, no VS Code needed
    # F5 in VS Code with this folder open launches an Extension Development Host

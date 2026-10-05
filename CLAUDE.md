# Herdr Bridge — VS Code extension

## What this is
A VS Code extension that brings [Herdr](https://herdr.dev) (a terminal-native multiplexer for AI coding agents)
into **one** VS Code window. Goal: keep Herdr's spaces/agents workflow but get the VS Code IDE
(files, diffs, SCM) without juggling a terminal app plus several VS Code windows.

The user runs Herdr in the macOS terminal. Their agents include Claude Code, Codex and Kiro. The extension is a **client of the
Herdr server**. It never owns agent processes; Herdr does.

Status: working prototype (v0.0.16), installed and tried by the user on macOS against a real Herdr
server (installed binary: herdr 0.9.1, socket protocol 22; the online docs were at 0.9.3). Confirmed working in real use: sidebar lists real
spaces/agents, space switching, attach terminals.

## Commands
```bash
npm install
npm run compile        # tsc -> out/
npm test               # mock Herdr socket server tests + git info test (no VS Code needed)
npm run package        # -> herdr-bridge-<version>.vsix
npm run install-local  # package + code --install-extension --force
```
Debug: open this folder in VS Code, press F5 (`.vscode/launch.json`) to get an Extension Development Host.
After installing a new vsix: Command Palette → "Developer: Reload Window".
Bump `version` in package.json for each vsix you hand to the user.

## Architecture (src/)
| File | Role |
|---|---|
| `herdrClient.ts` | Herdr socket API client. NDJSON over a Unix socket. `request()` uses one short-lived connection per call. `subscribe()` keeps a connection open for `events.subscribe`. Resolves the socket path the way Herdr does (`HERDR_SOCKET_PATH` → `HERDR_SESSION` → `~/.config/herdr/herdr.sock`). **No vscode imports** (testable standalone). |
| `herdrTypes.ts` | **Generated** from `herdr api schema --json` by `scripts/gen-herdr-types.mjs` (`npm run gen:types`). Don't edit by hand; add roots in the script when using more of the API. |
| `model.ts` | `normalize(result)` turns the `session.snapshot` result into Space → Tab → Pane, typed against `herdrTypes.ts`. Handles agent status, state labels, metadata tokens, terminal title, worktree, rollups and counts. Throws on a response missing the snapshot arrays. No vscode imports. |
| `herdrActions.ts` | Typed create/rename/close wrappers (`workspace.create`, `tab.create`, `worktree.create`/`remove`, `agent.start`/`rename`, `pane.rename`/`close`, `tab.*`, `workspace.*`). Creates default to `focus:false`. `AGENT_KINDS` (display names), `agentName()` (unique valid names), `AGENT_NAME`. No vscode imports. |
| `usage.ts` | "Usage" section data (no credentials read): Codex **live** via `codex app-server` stdio JSON-RPC (`initialize` → `account/rateLimits/read`; same data as Codex `/usage`; ~1s, so cached 5 min; `codex app-server proxy` to the daemon did NOT answer this handshake), falling back to `rate_limits` in `~/.codex/sessions/**/rollout-*.jsonl` (stale: Codex ≥0.160 stopped writing them, and they only update on model requests); Claude Code plan % from our opt-in status-line capture `~/.herdr-hub/claude-usage.json` (matches `/usage`; per-model weekly limits like Fable aren't exposed), tokens from `~/.claude/projects/**/*.jsonl` over the real session window (5h reset − 5h), else an estimated block; Kiro credits from `~/.kiro/sessions/cli/*.json` `metering_usage` (allowance: user setting `herdr.kiroMonthlyCredits`; Kiro exposes it to no other tool: `kiro-cli acp` v2 has no usage method, v3 boots its whole agent engine, creates sessions and didn't answer; the TUI's `/usage` uses AWS `GetUsageLimits` with Kiro's own login). Only agent kinds running in Herdr are read and shown (`only` / viewState filter); no Codex process starts without a Codex pane. Polled every 60s while the sidebar is visible. No vscode imports. **Kiro session files contain other data (tool args, even tokens): only read the metering fields.** |
| `usageSetup.ts` | Opt-in "Show plan limits…": Claude Code gives `rate_limits` only to a status-line command, so this installs `~/.herdr-hub/claude-statusline.sh` in `~/.claude/settings.json` after a modal (backup `settings.json.herdr-backup`); never replaces an existing statusLine. |
| `manage.ts` | The VS Code flows around those: pick Shell/agent, New tab, New space (folder or git worktree), Rename…, Close in Herdr… (with confirmations; worktree delete with force fallback). |
| `profiles.ts` | Terminal profiles (`contributes.terminal.profiles`): "Herdr Shell" + per-agent. The provider creates the Herdr tab, returns `herdr terminal attach <id>`, and adopts the terminal on `onDidOpenTerminal`; falls back to a local shell when Herdr isn't reachable. |
| `extension.ts` | Wiring and sync loop. Re-snapshots on any event (debounced 120ms); event payloads are only treated as "something changed". Polls every 1.5s when there's no event stream, every 15s as a safety net otherwise. Also: notifications on status transitions, follow mode, status bar, all commands, hub-window setup. Tracks time-in-state locally (`stateSince`) because Herdr only exposes `state_change_seq`. |
| `panel.ts` | "Spaces & Agents" **webview view** (replaced the TreeView in v0.0.4: the tree API allows only one grey description line and an icon tint per row). Posts a `ViewState`, maps webview actions to `herdr.*` commands. CSP: nonce script, no inline styles. Right-click menus use `webview/context` + `data-vscode-context`. |
| `viewState.ts` | Builds the JSON the webview draws (names, headlines, shell summaries, attention list). No vscode imports. |
| `activity.ts` | What panes are doing: `pane.process_info` (foreground process) + `pane.read` (`recent_unwrapped` for shells, `detection` for agents), summarized to "running X" / "at prompt, last ran Y" + last output lines + failure flag. Polled every 4s, only while the sidebar is visible. No vscode imports. |
| `media/agent-icons.js` | **Generated** by `scripts/gen-agent-icons.mjs` (`npm run gen:icons`): agent logos from `@lobehub/icons-static-svg` (MIT) keyed by Herdr agent name. Unknown agents get a lettered avatar. Notices in `media/THIRD_PARTY_NOTICES.md`. |
| `help.ts`, `media/help.{html,css,js}` | "Herdr: How to Read the Sidebar" (`?` in the view header/title bar). User-facing guide; examples reuse `panel.css` classes so they match the sidebar; the settings table is generated from `package.json`. **Update help.html when the sidebar's behavior or visuals change.** |
| `media/panel.{js,css}` | Webview renderer (plain JS, `// @ts-check`) and styles. Colors only from `--vscode-*` theme variables. Icons: `media/codicons` (copied from `@vscode/codicons` by `npm run codicons`, run by `npm run package`). |
| `folders.ts` | Mounts spaces as workspace folders. **Never touches folder index 0.** Changing the first folder restarts the extension host. Managed folders are named `⬢ <label>`, kept at the tail, and swapped in one `updateWorkspaceFolders` call. Updates are serialized by waiting for `onDidChangeWorkspaceFolders`. |
| `terminals.ts` | Agent pane → VS Code terminal running `herdr agent attach <pane_id> --takeover`. Plain shell → `herdr terminal attach <terminal_id>`. Closing the terminal only detaches. Attach terminals are created `hideFromUser` and then shown: extensions that type into new terminals (Python Environments sends `source .venv/bin/activate` — it skips hideFromUser/pty terminals) would otherwise type into the agent's prompt on every space switch. Don't "fix" this via `python.terminal.activateEnvironment: false`: Python Environments then writes `autoActivationType: off` to the user's global settings. Resolves the binary in Homebrew paths, because a GUI-launched VS Code on macOS lacks Homebrew in PATH. |
| `review.ts` | "Review changes": uses the built-in `vscode.git` API to list changes, then opens `HEAD ↔ working tree` diffs. |
| `gitInfo.ts` | Branch, dirty count and ahead/behind via `git status --porcelain=v1 --branch`. Cached 8s, refreshed in the background. |
| `test/mockTest.ts` | Fake Herdr server. Tests a schema-typed synthetic snapshot, the real fixture `test/fixtures/snapshot-herdr-0.9.1.json`, metadata parsing, errors, subscriptions and `events_lost`. |
| `test/viewTest.ts` | Shell/agent summaries and view state, using real pane output captured from herdr 0.9.1. |
| `test/gitTest.ts` | Runs against a real temporary git repo. |

## Key design decisions (keep unless the user says otherwise)
- **VS Code extension as a Herdr client, not a Herdr plugin.** An optional Herdr plugin is in the backlog only for the reverse jump.
- **Hub window:** `Herdr: Set up Herdr Hub Window` creates `~/.herdr-hub/herdr-hub.code-workspace`. Slot 0 is `~/.herdr-hub`, so switching spaces never restarts extensions. The workspace setting `herdr.hubWindow: true` enables follow mode there. In the hub, the extension also sets `terminal.integrated.tabs.description` to `${task}` at workspace scope (once, only if unset) so terminal tabs show just their name; VS Code has no per-terminal option for this.
- **Follow mode** acts only in a hub window, or after the user has switched a space from VS Code (the `herdr.managedWindow` workspaceState flag). This prevents hijacking unrelated windows.
- **Switching a space:** mount its folder, reveal it in Explorer, call `workspace.focus` in Herdr, and close the attach terminals of other spaces (`closeTerminalsOnSwitch`). Then attach every pane as its own tab: agents most urgent first (blocked > done > working > idle), then shells in tab order (`autoAttachShells`). VS Code places each new terminal tab after the previous one (editor area and panel alike), so they're opened in that order, then the first is focused.
- **Events are invalidation signals.** Always re-read with `session.snapshot`; never apply event payloads incrementally. This is what Herdr's docs recommend: on `events_lost`, resubscribe and re-snapshot.
- **UI layout:** the user moved the Herdr view to the **secondary (right) sidebar** by hand and keeps Explorer on the left. Extensions can't target the secondary sidebar without the proposed API `contribSecondarySidebar` (`viewsContainers.secondarySidebar`), so the container stays in the activity bar.
- **Sidebar design (v0.0.4):** space cards (collapsible, status accent bar, branch/changes line), agents and shells as compact two-line rows (name + status pill, then one line: task/summary or `$ command`) with a chevron that reveals details (summary or screen, output box, chips, folder; persisted per pane in webview state); no "attached" chips, a "Needs you" section for blocked/done agents with a screen preview, and a collapsible "Shells" group per space. Pane names come from `paneName()` (viewState.ts) and are used for both the sidebar row and the VS Code terminal tab (VS Code can't rename a tab later, so names use only snapshot fields): agents = display name or kind ("Claude"); shells = pane label → tab label → `Tab N`. Agent terminal tabs use the logo from `media/agent-logos` as their icon. Space header = chevron + name only (no tags or hover buttons); the git line shows branch · last-commit age · ↑↓/synced/no upstream · conflicts/staged/modified/new or clean · Review. Toggle shells and open settings from the view header or the `…` menu.
- **Out of scope:** the user doesn't want AI chat (Copilot, Claude Code or Codex panels) in the hub window. Their agents run in Herdr.

## Herdr API facts used (from herdr.dev/docs/socket-api)
- Socket: `~/.config/herdr/herdr.sock`; named sessions use `~/.config/herdr/sessions/<name>/herdr.sock`.
- Requests look like `{"id","method","params"}\n`. Responses look like `{"id","result"}` or `{"id","error":{code,message}}`.
- Methods used: `session.snapshot`, `events.subscribe`, `workspace.focus {workspace_id}`, `agent.focus {target}`.
- `agent.focus` params are `{target}` (confirmed in the schema). The call is best-effort and errors are swallowed.
- Event types subscribed are listed in `DEFAULT_SUBSCRIPTIONS`.
- Pane ids look like `w1:p1`, tab ids `w1:t1`. Ids can change when a pane moves across workspaces.
- Useful extra methods:
  - `agent.prompt` (accepts an optional `wait`), `agent.wait`, `agent.start`, `pane.read`
  - `worktree.create` / `worktree.open` / `worktree.remove`
  - `notification.show`, `layout.export`, `pane.process_info`
- `herdr api schema --json` prints the full JSON Schema of the installed binary; `npm run gen:types` turns it into `src/herdrTypes.ts`.
- `herdr api snapshot` prints a live snapshot.
- Direct attach: only one direct-attach client owns input (`--takeover`). Detach with `ctrl+b q`. On macOS, `ctrl+b` passes through VS Code fine (sidebar toggle is ⌘B there).

## Snapshot facts (from the herdr 0.9.1 schema)
- `session.snapshot` result is `{type: "session_snapshot", snapshot}`. The snapshot is flat: `workspaces`, `tabs`, `panes`, `layouts`, `agents` arrays plus `focused_{workspace,tab,pane}_id`.
- Every agent also appears in `panes`. `AgentInfo` is `PaneInfo` plus `name`, `state_change_seq`, `interactive_ready`, `launch_pending`, `screen_detection_skipped`; only panes have `label` and `scroll`.
- `agent_status` is `idle | working | blocked | done | unknown`; Herdr reports `done` itself. There is **no `seen` field** in the snapshot. Shell panes report `unknown`.
- `tokens` and `state_labels` sit directly on records (no `metadata` wrapper). `WorkspaceInfo` has **no cwd and no branch**; `worktree` (when set) has `checkout_path`, `is_linked_worktree` and repo info. Branch comes from `gitInfo.ts`.
- The two kiro agents the user saw as "idle" really are `idle` in Herdr.
- Subscribable but unused: `workspace.metadata_updated`, `pane.updated` (likely needed for instant token/label updates).
- **Learned by testing against a throwaway session** (`herdr --session hb-test server`, socket `~/.config/herdr/sessions/hb-test/herdr.sock`; use this, never the user's live session, to try mutating calls):
  - `agent.start` `name` must match `^[a-z][a-z0-9_-]{0,31}$` (names are CLI targets); we use `claude`, `claude-2`, … and show them as "Claude", "Claude 2".
  - A pane just created isn't at its prompt yet: `agent.start` answers `agent_pane_busy`; `startAgent` retries for up to 15s.
  - `agent.start` can report success for an agent that isn't installed (tried `muse`).
  - `workspace.close` on a space with linked worktree spaces needs `close_group: true` (error `workspace_group_close_required`).
  - `worktree.create` puts checkouts in `~/.herdr/worktrees/<repo>/<branch>`; `worktree.remove {workspace_id}` closes the space and deletes the folder (refuses with uncommitted changes unless `force`).
- **VS Code "+" (verified in VS Code 1.140's source):** a contributed profile is the default when `terminal.integrated.defaultProfile.<os>` equals its **title**; the setting is `restricted` (ignored in untrusted workspaces); profile terminals get their location from the clicked "+", so the provider must not set one; only user-created terminals use the default (extension-created ones don't). The hub window sets `defaultProfile.osx = "Herdr Shell"` at workspace scope once.
- `pane.read` results have `revision: 0` on 0.9.1, so `activity.ts` detects output changes by comparing text. Each socket request takes ~100ms; activity polls run 6 at a time.

After upgrading Herdr: `npm run gen:types`, fix compile errors, and save a new `herdr api snapshot` fixture.

## Backlog / ideas
1. ~~Schema-generated types~~ (done). Extend `ROOTS` in the generator when adding methods below.
2. Use targeted event payloads, such as `pane.agent_status_changed`, for instant status updates instead of a full re-snapshot. Keep the snapshot fallback.
3. **Prompt agent from VS Code**: on an agent row, open an input box and call `agent.prompt`. Optionally send the current selection or file path as context.
4. ~~New agent / new worktree space~~ (done: New tab / New space / + button).
5. A **reverse jump** Herdr plugin (`herdr-plugin.toml`) with an action that opens `vscode://srihari-local.herdr-bridge/focus?workspace=<id>`. The extension would need `registerUriHandler`.
6. On done: auto-open review, and diff against the merge-base instead of HEAD when on a worktree branch.
7. ~~`pane.read` preview for blocked agents~~ (done in the sidebar).
8. Support named sessions and remote machines (`herdr --remote`) via the `herdr.socketPath` setting or a session picker.
9. Bundle with esbuild. Add an ESLint config and CI. Swap the placeholder `repository` URL in package.json for the real one.

## Conventions
- TypeScript strict. Keep `herdrClient.ts` and `model.ts` free of `vscode` imports so `npm test` runs without VS Code.
- Add a mock-server test for any new socket method.
- Never write workspace folder index 0.
- Agent processes belong to Herdr: closing or disposing a VS Code terminal must only detach.

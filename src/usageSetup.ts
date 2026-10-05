// Opt-in: let Claude Code share its plan usage (5-hour / weekly limits) with the sidebar.
// Claude Code only gives `rate_limits` to a status-line command, so this installs a tiny one
// (src/usage.ts claudeStatusLineScript) in ~/.claude/settings.json, after asking.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { claudeCaptureFile, claudeStatusLineScript } from './usage';

export async function setUpClaudeUsage(home: string, log: (m: string) => void): Promise<boolean> {
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const capture = claudeCaptureFile(home);
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await fs.promises.readFile(settingsFile, 'utf8'));
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      vscode.window.showErrorMessage(`Herdr: couldn't read ${settingsFile}: ${e?.message ?? e}`);
      return false;
    }
  }

  if (settings.statusLine) {
    // Never replace someone's status line; show how to add the capture to it instead.
    const snippet = `tee "${capture}" | `;
    const pick = await vscode.window.showInformationMessage(
      'You already have a Claude Code status line, so Herdr left it alone.',
      {
        modal: true,
        detail: `To show plan limits in the sidebar, make your status line command also save its input: put ${snippet}in front of the command in ~/.claude/settings.json ("statusLine" → "command").`,
      },
      'Copy Snippet',
    );
    if (pick) await vscode.env.clipboard.writeText(snippet);
    return false;
  }

  const ok = await vscode.window.showInformationMessage(
    'Show Claude plan limits in the Herdr sidebar?',
    {
      modal: true,
      detail:
        'Claude Code shares your 5-hour and weekly usage only with a status line command. Herdr will add a small one to ' +
        '~/.claude/settings.json (a backup is saved next to it) that shows "5h 42% · 7d 18%" under the Claude prompt and saves ' +
        `the numbers to ${capture}. With a custom status line, Claude Code hides some footer hints such as "? for shortcuts".\n\n` +
        'Limits appear for claude.ai Pro and Max plans, after the next reply in each session. To undo, remove "statusLine" from the settings file.',
    },
    'Set Up',
  );
  if (!ok) return false;

  try {
    const script = path.join(path.dirname(capture), 'claude-statusline.sh');
    await fs.promises.mkdir(path.dirname(capture), { recursive: true });
    await fs.promises.writeFile(script, claudeStatusLineScript(capture), { mode: 0o755 });
    if (fs.existsSync(settingsFile)) await fs.promises.copyFile(settingsFile, `${settingsFile}.herdr-backup`);
    else await fs.promises.mkdir(path.dirname(settingsFile), { recursive: true });
    settings.statusLine = { type: 'command', command: `sh "${script}"` };
    await fs.promises.writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    log(`claude usage: status line installed (${script}); backup at ${settingsFile}.herdr-backup`);
    vscode.window.showInformationMessage('Herdr: done. Claude plan limits appear after the next Claude reply.');
    return true;
  } catch (e: any) {
    vscode.window.showErrorMessage(`Herdr: couldn't set up the status line: ${e?.message ?? e}`);
    return false;
  }
}

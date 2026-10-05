// "Herdr Hub: How to Read the Sidebar": a user-facing guide in an editor tab (media/help.html).
// Reuses the sidebar's stylesheet so its examples look exactly like the real sidebar,
// and lists the extension's settings straight from package.json so they never drift.
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';

/** Commands the page's buttons may run. */
const ALLOWED = new Set(['openSettings', 'setupHub', 'refresh', 'startServer']);

let current: vscode.WebviewPanel | undefined;

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function settingsTable(ext: vscode.Extension<unknown>): string {
  const props: Record<string, { description?: string; markdownDescription?: string; default?: unknown }> =
    (ext.packageJSON as any)?.contributes?.configuration?.properties ?? {};
  const rows = Object.entries(props)
    .map(
      ([key, p]) =>
        `<tr><td>${esc(key)}<div class="def">default: ${esc(JSON.stringify(p.default ?? ''))}</div></td><td>${esc(p.description ?? p.markdownDescription ?? '')}</td></tr>`,
    )
    .join('');
  return `<table class="settings"><tr><th>Setting</th><th>What it does</th></tr>${rows}</table>`;
}

export function showHelp(ctx: vscode.ExtensionContext) {
  if (current) return current.reveal();
  const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
  const panel = vscode.window.createWebviewPanel('herdr.help', 'Herdr Hub: Sidebar Guide', vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [media],
  });
  current = panel;
  panel.iconPath = vscode.Uri.joinPath(media, 'herdr.svg');
  const w = panel.webview;
  const uri = (...p: string[]) => w.asWebviewUri(vscode.Uri.joinPath(media, ...p));
  const nonce = crypto.randomBytes(16).toString('base64');
  const body = fs.readFileSync(vscode.Uri.joinPath(media, 'help.html').fsPath, 'utf8').replace('<!--SETTINGS-->', settingsTable(ctx.extension));
  w.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; font-src ${w.cspSource}; img-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${uri('codicons', 'codicon.css')}" rel="stylesheet">
<link href="${uri('panel.css')}" rel="stylesheet">
<link href="${uri('help.css')}" rel="stylesheet">
<title>Herdr Hub sidebar guide</title>
</head>
<body><main class="doc">${body}</main>
<script nonce="${nonce}" src="${uri('agent-icons.js')}"></script>
<script nonce="${nonce}" src="${uri('help.js')}"></script>
</body>
</html>`;
  panel.webview.onDidReceiveMessage((m) => {
    if (m?.type === 'cmd' && ALLOWED.has(m.command)) vscode.commands.executeCommand(`herdr.${m.command}`);
  });
  panel.onDidDispose(() => (current = undefined));
}

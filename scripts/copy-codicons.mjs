#!/usr/bin/env node
// Copies VS Code's icon font (@vscode/codicons) into media/codicons so the webview can load it.
// Runs as part of `npm run package`; the copied files are committed so F5 debugging works too.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@vscode', 'codicons', 'dist');
const dest = join(root, 'media', 'codicons');
mkdirSync(dest, { recursive: true });
for (const f of ['codicon.css', 'codicon.ttf']) copyFileSync(join(src, f), join(dest, f));
copyFileSync(join(src, '..', 'LICENSE'), join(dest, 'LICENSE'));
console.log(`copied codicons to ${dest}`);

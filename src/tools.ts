// Finding command-line tools (herdr, git, codex) on macOS and Linux. An editor started from the Dock or an
// app launcher gets a minimal PATH, without Homebrew or ~/.local/bin, so the usual install folders are
// checked before falling back to a bare name (PATH). No vscode imports.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Install folders to check, most likely first. */
export function toolDirs(home = os.homedir(), platform: NodeJS.Platform = process.platform): string[] {
  const user = [path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin'), path.join(home, '.nix-profile', 'bin')];
  if (platform === 'darwin') return ['/opt/homebrew/bin', '/usr/local/bin', ...user, '/run/current-system/sw/bin'];
  // Herdr's and Codex's installers default to ~/.local/bin on Linux.
  return [
    user[0],
    '/usr/local/bin',
    '/usr/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    path.join(home, '.linuxbrew', 'bin'),
    ...user.slice(1),
    '/run/current-system/sw/bin',
    '/snap/bin',
  ];
}

/**
 * The first existing `name` in `preferred` (full paths), then the install folders; else the bare name,
 * which the OS looks up on PATH.
 */
export function findTool(name: string, preferred: string[] = [], home?: string, platform?: NodeJS.Platform): string {
  const candidates = [...preferred, ...toolDirs(home, platform).map((d) => path.join(d, name))];
  return candidates.find((c) => fs.existsSync(c)) ?? name;
}

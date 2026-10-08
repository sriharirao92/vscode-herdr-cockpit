// The built-in Herdr terminal (herdr.terminalClient = "builtin"): a tab the extension draws itself from
// `herdr terminal session control`, instead of running `herdr agent/terminal attach` in it. It handles the
// mouse like the Herdr TUI: drag / double-click / triple-click selects and copies, the wheel scrolls Herdr's
// scrollback. See herdrStream.ts and termScreen.ts.
import * as vscode from 'vscode';
import { HerdrStream } from './herdrStream';
import { parseInput, POSTLUDE, PRELUDE, Screen } from './termScreen';

export interface BuiltinDeps {
  binary(): string;
  env(): NodeJS.ProcessEnv;
  log(line: string): void;
  /** The stream ended on its own (Herdr stopped, the pane closed, another client took it over). */
  onEnded(): void;
}

const WHEEL_LINES = 3;

export class HerdrPty implements vscode.Pseudoterminal {
  private readonly writer = new vscode.EventEmitter<string>();
  private readonly closer = new vscode.EventEmitter<number | void>();
  private readonly namer = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writer.event;
  readonly onDidClose = this.closer.event;
  /** Renames the tab without focusing it (unlike the rename command, which acts on the active terminal). */
  readonly onDidChangeName = this.namer.event;
  /** The pane this tab shows, once known (a "+" tab creates its pane when it opens). */
  paneId?: string;
  private stream?: HerdrStream;
  private screen?: Screen;
  /** Keeps model writes in frame order. */
  private queue: Promise<void> = Promise.resolve();
  private closedByUser = false;
  private toastTimer?: NodeJS.Timeout;
  /** The left button's press, to tell a click (sent to the program) from a drag (a selection). */
  private press?: { x: number; y: number; moved: boolean };
  /** The stream ended without the tab being closed: the tab now only shows a note. */
  ended = false;

  constructor(
    /** The pane id, or how to get it once the tab is open (create the pane then). */
    private readonly target: string | (() => Promise<string>),
    private readonly deps: BuiltinDeps,
  ) {
    if (typeof target === 'string') this.paneId = target;
  }

  setName(name: string) {
    this.namer.fire(name);
  }

  open(dims: vscode.TerminalDimensions | undefined): void {
    this.screen = new Screen(dims?.columns ?? 80, dims?.rows ?? 24);
    this.writer.fire(PRELUDE);
    if (typeof this.target === 'string') return this.connect(this.target);
    this.target().then(
      (id) => {
        this.paneId = id;
        if (!this.closedByUser) this.connect(id);
      },
      (e) => this.onStreamClosed(undefined, e instanceof Error ? e.message : String(e)),
    );
  }

  private connect(target: string) {
    const screen = this.screen!;
    const { cols, rows } = screen;
    this.stream = new HerdrStream(this.deps.binary(), target, { cols, rows }, this.deps.env(), {
      onFrame: (bytes) => {
        this.writer.fire(bytes.toString('utf8'));
        this.queue = this.queue
          .then(() => screen.write(bytes))
          .then(() => {
            // The frame may have painted over the selection: show it again.
            if (screen.hasSelection()) this.writer.fire(screen.paint(screen.rowsOf()));
          });
      },
      onClose: ({ reason, error }) => this.onStreamClosed(reason, error),
    });
  }

  handleInput(data: string): void {
    const screen = this.screen;
    if (!screen || !this.stream || this.ended) return;
    for (const t of parseInput(data)) {
      if (t.kind === 'data') {
        if (screen.hasSelection()) this.writer.fire(screen.paint(screen.clearSelection()));
        this.stream.input(t.text);
      } else if (t.wheel) {
        if (screen.hasSelection()) this.writer.fire(screen.paint(screen.clearSelection()));
        this.stream.scroll(t.wheel, WHEEL_LINES);
      } else if (t.button === 0) {
        // Left button: a drag selects (like the Herdr TUI); a click without movement goes to the program,
        // so buttons in mouse-aware programs (Kiro) work. Herdr drops it for programs without the mouse.
        if (!t.release && !t.motion) this.press = { x: t.x, y: t.y, moved: false };
        else if (t.motion && this.press) this.press.moved = true;
        const r = screen.mouse(t);
        if (r.repaint.length) this.writer.fire(screen.paint(r.repaint));
        if (r.copy) this.copied(r.copy);
        if (t.release && this.press && !this.press.moved && !r.copy) {
          const mods = (t.shift ? 1 : 0) | (t.ctrl ? 2 : 0) | (t.alt ? 4 : 0);
          this.stream.mouse('down', 'left', this.press.x, this.press.y, mods);
          this.stream.mouse('up', 'left', t.x, t.y, mods);
        }
        if (t.release) this.press = undefined;
      } else if ((t.button === 1 || t.button === 2) && !t.motion) {
        const mods = (t.shift ? 1 : 0) | (t.ctrl ? 2 : 0) | (t.alt ? 4 : 0);
        this.stream.mouse(t.release ? 'up' : 'down', t.button === 1 ? 'middle' : 'right', t.x, t.y, mods);
      }
    }
  }

  /** Copy to the clipboard and say so: a toast in the tab (like the Herdr TUI) and the status bar. */
  private copied(text: string) {
    void vscode.env.clipboard.writeText(text);
    const n = text.length;
    vscode.window.setStatusBarMessage(`$(copy) Copied ${n} character${n === 1 ? '' : 's'} to the clipboard`, 2500);
    const screen = this.screen;
    if (!screen) return;
    const t = screen.toast('✓ Copied to clipboard');
    this.writer.fire(t.paint);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      if (!this.closedByUser && !this.ended) this.writer.fire(screen.paint([t.row]));
    }, 1500);
  }

  setDimensions(dims: vscode.TerminalDimensions): void {
    this.screen?.resize(dims.columns, dims.rows);
    this.stream?.resize(dims.columns, dims.rows); // Herdr answers with a full frame
  }

  close(): void {
    this.closedByUser = true;
    clearTimeout(this.toastTimer);
    this.stream?.release();
    this.screen?.dispose();
  }

  private onStreamClosed(reason?: string, error?: string) {
    if (this.closedByUser) return;
    this.ended = true;
    const why = error ? `couldn't stream this pane: ${error}` : reason === 'detached' ? 'detached' : `the stream ended (${reason ?? 'closed'})`;
    this.deps.log(`built-in terminal ${this.paneId ?? '(new pane)'}: ${why}`);
    this.writer.fire(`${POSTLUDE}\r\n\x1b[2m[Herdr Cockpit] ${why}. Close this tab, or click the pane in the sidebar to open it again.\x1b[0m\r\n`);
    this.deps.onEnded();
  }
}

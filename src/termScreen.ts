// The screen behind a built-in Herdr terminal tab: a headless xterm fed with Herdr's frames, the mouse
// selection on it, and what to paint to show the selection. No vscode imports.
//
// Herdr's direct attach captures the mouse and drops drags for programs that don't use it, so nothing can be
// selected (see CLAUDE.md). Here the tab reports the mouse to us instead (SGR mode), and we do what the Herdr
// TUI does: drag, double-click (word) or triple-click (line) selects, release copies, the wheel scrolls.
import { Terminal } from '@xterm/headless';
import type { IBufferCell, IBufferLine } from '@xterm/headless';

const ESC = '\x1b';

/**
 * Written to the tab (and the model) before Herdr's first frame: the alternate screen (frames repaint the
 * screen, so they'd only litter the editor's scrollback), button-event mouse tracking with SGR coordinates
 * (drags and the wheel come to us), and bracketed paste (pastes arrive marked; shells and agents expect it).
 */
export const PRELUDE = `${ESC}[?1049h${ESC}[?1002h${ESC}[?1006h${ESC}[?2004h`;
/** Undo the prelude when the tab closes. */
export const POSTLUDE = `${ESC}[?2004l${ESC}[?1006l${ESC}[?1002l${ESC}[?1049l`;

// ---------- input: keystrokes and mouse reports ----------

export type InputToken =
  | { kind: 'data'; text: string }
  | { kind: 'mouse'; button: number; x: number; y: number; release: boolean; motion: boolean; wheel?: 'up' | 'down'; shift: boolean; alt: boolean; ctrl: boolean };

// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Split what the tab sends into plain input and SGR mouse reports (cells 0-based). */
export function parseInput(data: string): InputToken[] {
  const out: InputToken[] = [];
  let last = 0;
  for (const m of data.matchAll(SGR_MOUSE)) {
    if (m.index! > last) out.push({ kind: 'data', text: data.slice(last, m.index) });
    const b = Number(m[1]);
    const wheel = b & 64 ? ((b & 1) === 0 ? 'up' : 'down') : undefined;
    out.push({
      kind: 'mouse',
      button: b & 3,
      x: Number(m[2]) - 1,
      y: Number(m[3]) - 1,
      release: m[4] === 'm',
      motion: !!(b & 32),
      ...(wheel && { wheel }),
      shift: !!(b & 4),
      alt: !!(b & 8),
      ctrl: !!(b & 16),
    } as InputToken);
    last = m.index! + m[0].length;
  }
  if (last < data.length) out.push({ kind: 'data', text: data.slice(last) });
  return out;
}

// ---------- the screen ----------

export interface Cell {
  x: number;
  y: number;
}

/** Characters that end a word for double-click selection (like most terminals). */
const WORD_BREAK = /[\s()[\]{}<>'"`|│,;]/;

export class Screen {
  readonly term: Terminal;
  private anchor?: Cell;
  private head?: Cell;
  private selecting = false;
  private lastClick = { at: 0, x: -1, y: -1, count: 0 };

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
    this.term.write(PRELUDE);
  }

  write(data: Buffer | string): Promise<void> {
    return new Promise((r) => this.term.write(data, r));
  }
  resize(cols: number, rows: number) {
    this.clearSelection();
    this.term.resize(Math.max(1, cols), Math.max(1, rows));
  }
  dispose() {
    this.term.dispose();
  }

  get cols() {
    return this.term.cols;
  }
  get rows() {
    return this.term.rows;
  }
  private line(y: number): IBufferLine | undefined {
    const b = this.term.buffer.active;
    return b.getLine(b.viewportY + y);
  }

  // ----- selection -----

  hasSelection() {
    return !!this.anchor && !!this.head;
  }
  /** Normalized, inclusive: start <= end in reading order. */
  range(): { start: Cell; end: Cell } | undefined {
    if (!this.anchor || !this.head) return;
    const [a, b] = [this.anchor, this.head];
    return a.y < b.y || (a.y === b.y && a.x <= b.x) ? { start: a, end: b } : { start: b, end: a };
  }
  /** Rows the selection covers (to repaint them). */
  rowsOf(): number[] {
    const r = this.range();
    if (!r) return [];
    const ys: number[] = [];
    for (let y = r.start.y; y <= r.end.y; y++) ys.push(y);
    return ys;
  }
  clearSelection(): number[] {
    const rows = this.rowsOf();
    this.anchor = this.head = undefined;
    this.selecting = false;
    return rows;
  }
  private clamp(c: Cell): Cell {
    return { x: Math.min(Math.max(0, c.x), this.cols - 1), y: Math.min(Math.max(0, c.y), this.rows - 1) };
  }

  /** The selected text: rows joined by newlines (not inside a wrapped line), trailing spaces trimmed. */
  selectionText(): string {
    const r = this.range();
    if (!r) return '';
    let out = '';
    for (let y = r.start.y; y <= r.end.y; y++) {
      const line = this.line(y);
      if (!line) continue;
      const from = y === r.start.y ? r.start.x : 0;
      const to = y === r.end.y ? r.end.x + 1 : this.cols;
      if (y > r.start.y && !line.isWrapped) out += '\n';
      const seg = line.translateToString(false, from, to);
      // Trailing spaces are padding, except before the continuation of a wrapped line.
      out += y < r.end.y && this.line(y + 1)?.isWrapped ? seg : seg.replace(/[ \t]+$/, '');
    }
    return out;
  }

  private wordAt(c: Cell): { start: Cell; end: Cell } {
    const line = this.line(c.y);
    const text = line ? line.translateToString(false) : '';
    const ch = (i: number) => text[i] ?? ' ';
    if (WORD_BREAK.test(ch(c.x))) return { start: c, end: c };
    let s = c.x;
    let e = c.x;
    while (s > 0 && !WORD_BREAK.test(ch(s - 1))) s--;
    while (e < this.cols - 1 && !WORD_BREAK.test(ch(e + 1))) e++;
    return { start: { x: s, y: c.y }, end: { x: e, y: c.y } };
  }

  /**
   * A left-button mouse event. Returns what changed: rows to repaint, and the text to copy when a selection
   * is finished (release after a drag, or a double/triple click).
   */
  mouse(ev: { x: number; y: number; release: boolean; motion: boolean }, now = Date.now()): { repaint: number[]; copy?: string } {
    const c = this.clamp(ev);
    if (!ev.release && !ev.motion) {
      // press: click counting for word / line selection
      const same = now - this.lastClick.at < 400 && this.lastClick.x === c.x && this.lastClick.y === c.y;
      this.lastClick = { at: now, x: c.x, y: c.y, count: same ? this.lastClick.count + 1 : 1 };
      const before = this.clearSelection();
      if (this.lastClick.count === 2 || this.lastClick.count >= 3) {
        const w = this.lastClick.count === 2 ? this.wordAt(c) : { start: { x: 0, y: c.y }, end: { x: this.cols - 1, y: c.y } };
        this.anchor = w.start;
        this.head = w.end;
        const text = this.selectionText();
        return { repaint: [...new Set([...before, ...this.rowsOf()])], copy: text || undefined };
      }
      this.anchor = c;
      this.head = undefined; // a plain click selects nothing until the mouse moves
      this.selecting = true;
      return { repaint: before };
    }
    if (ev.motion && this.selecting && this.anchor) {
      const before = this.rowsOf();
      this.head = c;
      return { repaint: [...new Set([...before, ...this.rowsOf()])] };
    }
    if (ev.release && this.selecting) {
      this.selecting = false;
      if (!this.head) {
        this.anchor = undefined;
        return { repaint: [] };
      }
      const text = this.selectionText();
      return { repaint: [], copy: text || undefined };
    }
    return { repaint: [] };
  }

  // ----- painting -----

  private selected(x: number, y: number): boolean {
    const r = this.range();
    if (!r || y < r.start.y || y > r.end.y) return false;
    if (y === r.start.y && x < r.start.x) return false;
    if (y === r.end.y && x > r.end.x) return false;
    return true;
  }

  /**
   * A short message over the middle of the bottom row, like the Herdr TUI's "copied" toast. It only paints:
   * repaint `row` (paint([row])) to remove it.
   */
  toast(text: string): { row: number; paint: string } {
    const row = this.rows - 1;
    const label = ` ${text} `.slice(0, this.cols);
    const col = Math.max(0, Math.floor((this.cols - [...label].length) / 2));
    return { row, paint: `${ESC}[?2026h${ESC}7${ESC}[${row + 1};${col + 1}H${ESC}[0;1;30;42m${label}${ESC}[0m${ESC}8${ESC}[?2026l` };
  }

  /** Repaint rows from the model, with the selection shown inverted; ends with the cursor back in place. */
  paint(rows: number[]): string {
    if (!rows.length) return '';
    let out = `${ESC}[?2026h${ESC}7`;
    const cell = this.term.buffer.active.getNullCell();
    for (const y of rows) {
      const line = this.line(y);
      if (!line || y < 0 || y >= this.rows) continue;
      out += `${ESC}[${y + 1};1H`;
      let sgr = '';
      for (let x = 0; x < this.cols; x++) {
        const c = line.getCell(x, cell);
        if (!c || c.getWidth() === 0) continue;
        const s = sgrOf(c, this.selected(x, y));
        if (s !== sgr) {
          out += `${ESC}[${s}m`;
          sgr = s;
        }
        out += c.getChars() || ' ';
      }
      out += `${ESC}[0m`;
    }
    return out + `${ESC}8${ESC}[?2026l`;
  }
}

/** SGR parameters for a cell (starting from a reset), inverted when selected. */
export function sgrOf(c: IBufferCell, selected: boolean): string {
  const p = ['0'];
  if (c.isBold()) p.push('1');
  if (c.isDim()) p.push('2');
  if (c.isItalic()) p.push('3');
  if (c.isUnderline()) p.push('4');
  if (c.isBlink()) p.push('5');
  if (!!c.isInverse() !== selected) p.push('7');
  if (c.isInvisible()) p.push('8');
  if (c.isStrikethrough()) p.push('9');
  const color = (rgb: boolean, palette: boolean, v: number, base: number, bright: number, ext: number) => {
    if (rgb) p.push(`${ext};2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`);
    else if (palette) p.push(v < 8 ? String(base + v) : v < 16 ? String(bright + v - 8) : `${ext};5;${v}`);
  };
  color(c.isFgRGB(), c.isFgPalette(), c.getFgColor(), 30, 90, 38);
  color(c.isBgRGB(), c.isBgPalette(), c.getBgColor(), 40, 100, 48);
  return p.join(';');
}

// Low-level terminal control plus the color "painter" used by the render layer.
//
// The painter is injected into render functions so rendering stays pure and
// unit-testable: tests pass a no-op painter and assert on visible text.

import { EventEmitter } from "node:events";

const RESET = "\x1b[0m";

/** True when colour output is allowed (honours NO_COLOR). */
export function colorsAllowed(noColor = false) {
  if (noColor) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR === "0") return false;
  return true;
}

/**
 * Build styling helpers. `fg`/`bg` take truecolour channels and return a
 * text-transforming function; `bold`/`dim`/`italic`/`underline`/`inverse`
 * are the same shape. When colour is disabled every transform is the identity.
 */
export function createPainter(noColor = false) {
  const on = colorsAllowed(noColor);
  const wrap = (text, open) => (on && text.length > 0 ? open + text + RESET : text);

  const sgr = (...codes) => `\x1b[${codes.join(";")}m`;

  const fg = (r, g, b) => (text) => wrap(text, sgr(38, 2, r, g, b));
  const bg = (r, g, b) => (text) => wrap(text, sgr(48, 2, r, g, b));

  return {
    on,
    reset: RESET,
    fg,
    bg,
    bold: (text) => wrap(text, sgr(1)),
    dim: (text) => wrap(text, sgr(2)),
    italic: (text) => wrap(text, sgr(3)),
    underline: (text) => wrap(text, sgr(4)),
    inverse: (text) => wrap(text, sgr(7)),
    strikethrough: (text) => wrap(text, sgr(9)),
  };
}

/**
 * Terminal wrapper. `setup()` takes the screen over (alternate buffer, hidden
 * cursor, raw stdin); `teardown()` puts it back exactly as it was. Teardown is
 * idempotent, so it is safe to call from both a `finally` and `process.on('exit')`.
 */
export class Terminal {
  constructor({ out = process.stdout, input = process.stdin } = {}) {
    this.out = out;
    this.input = input;
    this.active = false;
    this.resizers = new Set();
    this.events = new EventEmitter();
    this.wasRaw = false;
  }

  get width() {
    return this.out.columns || 80;
  }

  get height() {
    return this.out.rows || 24;
  }

  get isTTY() {
    return Boolean(this.out.isTTY);
  }

  onResize(cb) {
    this.resizers.add(cb);
    this.out.on("resize", cb);
  }

  offResize(cb) {
    this.resizers.delete(cb);
    this.out.removeListener("resize", cb);
  }

  write(s) {
    this.out.write(s);
  }

  setup() {
    if (this.active) return;
    this.active = true;
    this.wasRaw = Boolean(this.input.isTTY && this.input.setRawMode?.(true));
    this.write("\x1b[?1049h"); // enter alternate buffer
    this.write("\x1b[?25l"); // hide cursor
    this.write("\x1b[H"); // cursor home
    this.write("\x1b[2J");
  }

  teardown() {
    if (!this.active) return;
    this.active = false;
    this.write("\x1b[?25h"); // show cursor
    this.write("\x1b[?1049l"); // leave alternate buffer
    if (this.wasRaw) {
      try {
        this.input.setRawMode(false);
      } catch {
        /* already closed */
      }
    }
    for (const cb of this.resizers) this.out.removeListener("resize", cb);
    this.resizers.clear();
    // A TTY stdout keeps the process alive for as long as it holds listeners.
    // Drop our resize hook and let the stream go so `q` actually exits.
    if (typeof this.out.unref === "function") {
      try {
        this.out.unref();
      } catch {
        /* already unrefd */
      }
    }
  }

  /** Move cursor to row/col (1-based). */
  moveTo(row, col) {
    this.write(`\x1b[${row};${col}H`);
  }

  home() {
    this.write("\x1b[H");
  }

  clearEol() {
    this.write("\x1b[K");
  }

  /** Paint a full frame: rows are written top to bottom, cursor reset first. */
  paintFrame(rows) {
    this.write("\x1b[H");
    for (let i = 0; i < rows.length; i++) {
      if (i > 0) this.write("\n");
      this.write(rows[i]);
      this.clearEol();
    }
    // Erase anything left over from a previously taller frame.
    this.write("\x1b[J");
  }
}

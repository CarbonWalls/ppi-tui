// Terminal keyboard input parser.
//
// In raw mode stdin hands us bytes; this turns byte runs into symbolic key
// names ("up", "enter", "ctrl+c", "meta+x", the raw text for printables).
// Sequences can be split across reads, so the parser is stateful: incomplete
// escape sequences are buffered until the rest arrives. A lone ESC is
// ambiguous with the start of a sequence, so callers flush it after a short
// timeout (see `pendingEsc` / `drain`).

const ESC = "\x1b";
export const ESC_TIMEOUT_MS = 60;

// CSI: ESC [ params final
const CSI_RE = /^\x1b\[([0-9;?<>]*)([ -\/]*[@-~])/;
// SS3: ESC O final
const SS3_RE = /^\x1bO([A-Za-z0-9])/;

const CTRL_NAMES = {
  "\x00": "ctrl+@",
  "\x01": "ctrl+a",
  "\x02": "ctrl+b",
  "\x03": "ctrl+c",
  "\x04": "ctrl+d",
  "\x05": "ctrl+e",
  "\x06": "ctrl+f",
  "\x07": "ctrl+g",
  "\x08": "backspace",
  "\x09": "tab",
  "\x0a": "enter",
  "\x0b": "ctrl+k",
  "\x0c": "ctrl+l",
  "\x0d": "enter",
  "\x0e": "ctrl+n",
  "\x0f": "ctrl+o",
  "\x10": "ctrl+p",
  "\x11": "ctrl+q",
  "\x12": "ctrl+r",
  "\x13": "ctrl+s",
  "\x14": "ctrl+t",
  "\x15": "ctrl+u",
  "\x16": "ctrl+v",
  "\x17": "ctrl+w",
  "\x18": "ctrl+x",
  "\x19": "ctrl+y",
  "\x1a": "ctrl+z",
  "\x1c": "ctrl+\\",
  "\x1d": "ctrl+]",
  "\x1e": "ctrl+^",
  "\x1f": "ctrl+_",
  "\x7f": "backspace",
};

const CSI_FINAL = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  E: "begin",
  F: "end",
  H: "home",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
  Z: "shift+tab",
};

const TILDE_KEYS = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
};

// Modifier is the trailing numeric param, but only when the sequence carries
// one. For tilde keys the first param is the key code and the modifier (if any)
// is the second; for letter keys a lone param is just the code, so at least two
// params are required. xterm encodes 2=shift, 3=alt, 4=alt+shift, 5=ctrl,
// 6=ctrl+shift, 7=ctrl+alt, 8=ctrl+alt+shift.
function modPrefix(params, final) {
  if (!params.length) return "";
  const idx = final === "~" ? 1 : params.length >= 2 ? params.length - 1 : -1;
  if (idx < 0 || idx >= params.length) return "";
  const n = Number(params[idx]);
  if (!n || n < 2) return "";
  const parts = [];
  const shift = n === 2 || n === 4 || n === 6 || n === 8;
  const alt = n === 3 || n === 4 || n === 7 || n === 8;
  const ctrl = n === 5 || n === 6 || n === 7 || n === 8;
  if (shift) parts.push("shift");
  if (alt) parts.push("alt");
  if (ctrl) parts.push("ctrl");
  return parts.length ? parts.join("+") + "+" : "";
}

// The full set of symbolic names this parser can emit, so consumers can tell
// a real key event ("enter") from raw text that happens to spell one.
let SYMBOLIC_KEYS = null;
export function symbolicKeyNames() {
  if (SYMBOLIC_KEYS) return SYMBOLIC_KEYS;
  const set = new Set(["escape"]);
  for (const table of [CSI_FINAL, TILDE_KEYS, CTRL_NAMES]) {
    for (const v of Object.values(table)) set.add(v);
  }
  // Modifier combinations the parser produces from CSI letter keys.
  for (const base of Object.values(CSI_FINAL)) {
    for (const mod of [
      "shift",
      "alt",
      "ctrl",
      "shift+alt",
      "ctrl+shift",
      "ctrl+alt",
      "ctrl+alt+shift",
    ]) {
      set.add(`${mod}+${base}`);
    }
  }
  SYMBOLIC_KEYS = set;
  return set;
}

/** True for a real key event, as opposed to raw text the user typed/pasted. */
export function isSymbolicKey(key) {
  if (typeof key !== "string") return false;
  if (symbolicKeyNames().has(key)) return true;
  return /^(?:ctrl|shift|alt|meta)\+/i.test(key);
}

export class KeyParser {
  constructor() {
    this.buf = "";
  }

  /** True when the parser is holding an unresolved lone ESC. */
  pendingEsc() {
    return this.buf === ESC;
  }

  /** Feed a chunk of bytes/string. Returns resolved key names. */
  feed(chunk) {
    if (Buffer.isBuffer(chunk)) chunk = chunk.toString("utf8");
    this.buf += chunk;
    return this._drain();
  }

  /** Release a pending lone ESC, if any. */
  drain() {
    if (this.pendingEsc()) {
      this.buf = "";
      return ["escape"];
    }
    return [];
  }

  stop() {
    this.buf = "";
  }

  _drain() {
    const out = [];

    while (this.buf.length > 0) {
      if (this.buf[0] === ESC) {
        const resolved = this._consumeEscape();
        if (resolved === null) return out; // incomplete — wait for more input
        out.push(...resolved);
        continue;
      }

      if (this.buf[0] < " " || this.buf[0] === "\x7f") {
        const name = CTRL_NAMES[this.buf[0]];
        out.push(name ?? "ctrl+");
        this.buf = this.buf.slice(1);
        continue;
      }

      // Printable run (batched: paste and IME can deliver several at once).
      const m = /^[^\x00-\x1f\x7f]+/.exec(this.buf);
      if (m) {
        out.push(m[0]);
        this.buf = this.buf.slice(m[0].length);
      }
    }

    return out;
  }

  _consumeEscape() {
    const buf = this.buf;

    // Lone ESC so far — caller decides after the timeout.
    if (buf.length === 1) return null;

    // Double ESC = plain escape.
    if (buf[1] === ESC) {
      this.buf = buf.slice(1);
      return ["escape"];
    }

    // CSI: ESC [ params final. With no final byte yet this is incomplete, so
    // buffer it rather than misreading '[' as a meta combination.
    if (buf[1] === "[") {
      const csi = CSI_RE.exec(buf);
      if (!csi) return null;
      const params = csi[1] ? csi[1].split(";").filter((s) => s.length) : [];
      const final = csi[2];
      this.buf = buf.slice(csi[0].length);
      const mod = modPrefix(params, final);
      const base =
        CSI_FINAL[final] ?? (final === "~" ? TILDE_KEYS[Number(params[0])] : undefined);
      if (base) return [mod ? mod + base : base];
      return [];
    }

    // SS3: ESC O final.
    if (buf[1] === "O") {
      const ss3 = SS3_RE.exec(buf);
      if (!ss3) return null;
      const base = CSI_FINAL[ss3[1]];
      this.buf = buf.slice(ss3[0].length);
      if (base) return [base];
      return [];
    }

    // ESC + printable = meta/alt combination.
    if (buf[1] >= " ") {
      const ch = buf[1];
      this.buf = buf.slice(2);
      return ["meta+" + ch];
    }

    // Unknown escape that is not going to complete: discard two bytes.
    if (buf.length >= 4) {
      this.buf = buf.slice(2);
      return [];
    }

    return null;
  }
}

/**
 * Async iterator of key names over a readable stream (raw-mode stdin).
 * Detaching the iterator removes its listeners, which matters when the
 * terminal is handed to a child process (pi) that needs stdin itself.
 */
export function keys(stream) {
  const parser = new KeyParser();
  const queue = [];
  let waiters = [];
  let done = false;
  let escTimer = null;

  // One item per read: the parsed keys plus whether the read looked like a
  // paste rather than a single interactive keystroke.
  const deliver = (item) => {
    if (waiters.length > 0) waiters.shift()({ value: item, done: false });
    else queue.push(item);
  };
  const finish = () => {
    done = true;
    clearTimeout(escTimer);
    while (waiters.length > 0) waiters.shift()({ value: undefined, done: true });
  };

  const isPaste = (ks) =>
    ks.length > 1 ||
    (ks.length === 1 && !isSymbolicKey(ks[0]) && [...ks[0]].length > 1);

  const onData = (chunk) => {
    clearTimeout(escTimer);
    const ks = parser.feed(chunk);
    deliver({ keys: ks, paste: isPaste(ks) });
    if (parser.pendingEsc()) {
      escTimer = setTimeout(() => {
        escTimer = null;
        deliver({ keys: parser.drain(), paste: false });
      }, ESC_TIMEOUT_MS);
    }
  };
  const onEnd = finish;
  const onError = finish;

  stream.on("data", onData);
  stream.on("end", onEnd);
  stream.on("error", onError);

  const detach = () => {
    clearTimeout(escTimer);
    stream.removeListener("data", onData);
    stream.removeListener("end", onEnd);
    stream.removeListener("error", onError);
  };

  return {
    parser,
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
        return: () => {
          detach();
          parser.stop();
          finish();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

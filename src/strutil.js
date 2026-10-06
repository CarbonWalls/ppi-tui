// Pure string utilities for terminal rendering.
//
// Every function here is side-effect free so the render layer can be tested
// without a real terminal. Width accounting is *visible* width: ANSI escape
// sequences contribute zero columns, wide (CJK / emoji) characters contribute
// two, and combining marks / variation selectors contribute zero.

/* eslint-disable no-control-regex */

const ANSI_RE = /\x1b\[[0-9;:<=>?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>NOM78]/g;

// Ranges that render two cells wide in a monospace terminal. Approximate but
// covers CJK, hangul, full-width forms, and the common emoji blocks.
const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3040, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1f0ff],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
];

// Zero-width: combining diacritics, variation selectors, ZWJ, and joiners.
const ZERO_WIDTH_RANGES = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x06d6, 0x06dd],
  [0x06df, 0x06e4],
  [0x0700, 0x070d],
  [0x07a6, 0x07b0],
  [0x0900, 0x0903],
  [0x093a, 0x094f],
  [0x0951, 0x0957],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
];

function inRanges(code, ranges) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid];
    if (code < start) hi = mid - 1;
    else if (code > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Visible width of a single code point (0, 1, or 2 columns). */
export function charWidth(code) {
  if (code < 0x20) return 0;
  if (code === 0x7f) return 0;
  if (inRanges(code, ZERO_WIDTH_RANGES)) return 0;
  if (inRanges(code, WIDE_RANGES)) return 2;
  return 1;
}

/** Strip ANSI escape sequences from a string. */
export function stripAnsi(str) {
  return str.replace(ANSI_RE, "");
}

/** Number of terminal columns `str` occupies (ANSI sequences ignored). */
export function visibleWidth(str) {
  const plain = stripAnsi(str);
  let width = 0;
  for (const ch of plain) {
    width += charWidth(ch.codePointAt(0));
  }
  return width;
}

/**
 * Truncate `str` so its visible width is at most `max` columns.
 * Preserves ANSI styling that appears before the cut and, when truncating,
 * appends `ellipsis` followed by a hard reset so styling cannot leak.
 */
export function truncateVisible(str, max, ellipsis = "…") {
  if (max <= 0) return "";
  if (visibleWidth(str) <= max) return str;

  const ellipsisWidth = charWidth(ellipsis.codePointAt(0));
  const limit = Math.max(0, max - ellipsisWidth);

  let out = "";
  let width = 0;
  let hadAnsi = false;
  let rest = str;

  while (rest.length > 0) {
    const m = /^(\x1b\[[0-9;:<=>?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/.exec(rest);
    if (m) {
      out += m[0];
      hadAnsi = true;
      rest = rest.slice(m[0].length);
      continue;
    }
    const ch = String.fromCodePoint(rest.codePointAt(0));
    const cw = charWidth(ch.codePointAt(0));
    if (width + cw > limit) break;
    out += ch;
    width += cw;
    rest = rest.slice(ch.length);
  }

  out += ellipsis;
  if (hadAnsi) out += "\x1b[0m";
  return out;
}

/** Pad `str` on the right with `fill` until it is `width` visible columns. */
export function padEndVisible(str, width, fill = " ") {
  const pad = width - visibleWidth(str);
  return pad > 0 ? str + fill.repeat(pad) : str;
}

/** Pad `str` on the left with `fill` until it is `width` visible columns. */
export function padStartVisible(str, width, fill = " ") {
  const pad = width - visibleWidth(str);
  return pad > 0 ? fill.repeat(pad) + str : str;
}

/** Right-align `str` inside `width` visible columns, truncating if needed. */
export function rightAlign(str, width) {
  if (visibleWidth(str) > width) return truncateVisible(str, width);
  return padStartVisible(str, width);
}

/** Human readable byte size, e.g. 480 KB. */
export function humanSize(bytes) {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** Relative-ish absolute timestamp label, e.g. "2026-10-05 14:02". */
export function timeLabel(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

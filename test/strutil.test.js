import { test } from "node:test";
import assert from "node:assert/strict";
import {
  charWidth,
  humanSize,
  padEndVisible,
  padStartVisible,
  rightAlign,
  stripAnsi,
  timeLabel,
  truncateVisible,
  visibleWidth,
} from "../src/strutil.js";

test("stripAnsi removes SGR, CSI and OSC sequences", () => {
  assert.equal(stripAnsi("\x1b[38;2;1;2;3mhi\x1b[0m"), "hi");
  assert.equal(stripAnsi("\x1b[?25lcur\x1b[2Ksor"), "cursor");
  assert.equal(stripAnsi("\x1b]0;title\x07x"), "x");
  assert.equal(stripAnsi("plain"), "plain");
});

test("visibleWidth counts display columns, not bytes or code units", () => {
  assert.equal(visibleWidth("hello"), 5);
  assert.equal(visibleWidth("\x1b[1mbold\x1b[0m"), 4);
  assert.equal(visibleWidth("日本語"), 6); // wide CJK
  assert.equal(visibleWidth("a😀b"), 4); // emoji is 2 cells
  assert.equal(visibleWidth("e\u0301"), 1); // combining mark is 0 cells
  assert.equal(visibleWidth("x\ufe0f"), 1); // variation selector is 0 cells
});

test("charWidth handles control bytes", () => {
  assert.equal(charWidth(0x1b), 0);
  assert.equal(charWidth(0x7f), 0);
  assert.equal(charWidth(0x41), 1);
  assert.equal(charWidth(0x4e2d), 2);
});

test("truncateVisible respects visible width and appends an ellipsis", () => {
  assert.equal(truncateVisible("hello world", 8), "hello w…");
  assert.equal(truncateVisible("hello world", 100), "hello world");
  assert.equal(truncateVisible("日本語テスト", 5), "日本…");
  assert.equal(truncateVisible("abc", 0), "");
  // Truncation of styled text resets styling so it cannot leak.
  const out = truncateVisible("\x1b[1mhello world\x1b[0m", 5);
  assert.equal(stripAnsi(out).length, 5); // "hell…"
  assert.ok(out.includes("\x1b[0m"), "ends with a hard reset");
  assert.ok(stripAnsi(out).endsWith("…"));
});

test("padEndVisible / padStartVisible / rightAlign align by visible width", () => {
  assert.equal(padEndVisible("ab", 5), "ab   ");
  assert.equal(padEndVisible("日", 4), "日  ");
  assert.equal(padStartVisible("ab", 4, "0"), "00ab");
  assert.equal(visibleWidth(padEndVisible("\x1b[31mred\x1b[0m", 6)), 6);
  assert.equal(rightAlign("x", 4), "   x");
  assert.equal(stripAnsi(rightAlign("\x1b[31mxx\x1b[0m", 5)), "   xx");
});

test("humanSize formats bytes readably", () => {
  assert.equal(humanSize(0), "0 B");
  assert.equal(humanSize(1023), "1023 B");
  assert.equal(humanSize(1024), "1 KB");
  assert.equal(humanSize(1536), "1.5 KB");
  assert.equal(humanSize(1048576), "1 MB");
  assert.equal(humanSize(10485760), "10 MB");
  assert.equal(humanSize(123456789), "118 MB");
});

test("timeLabel renders a stable timestamp", () => {
  const label = timeLabel(new Date("2026-10-05T14:02:00Z").getTime());
  assert.match(label, /^2026-10-\d{2} \d{2}:\d{2}$/);
  assert.equal(timeLabel(undefined), "—");
});

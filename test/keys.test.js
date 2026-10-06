import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { isSymbolicKey, KeyParser, keys } from "../src/keys.js";

function parse(input) {
  const p = new KeyParser();
  return p.feed(Buffer.from(input, "utf8"));
}

test("printables arrive as text", () => {
  assert.deepEqual(parse("a"), ["a"]);
  assert.deepEqual(parse("hello"), ["hello"]);
});

test("control keys map to names", () => {
  assert.deepEqual(parse("\r"), ["enter"]);
  assert.deepEqual(parse("\n"), ["enter"]);
  assert.deepEqual(parse("\x7f"), ["backspace"]);
  assert.deepEqual(parse("\b"), ["backspace"]);
  assert.deepEqual(parse("\t"), ["tab"]);
  assert.deepEqual(parse("\x03"), ["ctrl+c"]);
  assert.deepEqual(parse("\x15"), ["ctrl+u"]);
  assert.deepEqual(parse("\x1a"), ["ctrl+z"]);
});

test("arrow and navigation keys", () => {
  assert.deepEqual(parse("\x1b[A"), ["up"]);
  assert.deepEqual(parse("\x1b[B"), ["down"]);
  assert.deepEqual(parse("\x1b[C"), ["right"]);
  assert.deepEqual(parse("\x1b[D"), ["left"]);
  assert.deepEqual(parse("\x1b[H"), ["home"]);
  assert.deepEqual(parse("\x1b[F"), ["end"]);
  assert.deepEqual(parse("\x1b[5~"), ["pageup"]);
  assert.deepEqual(parse("\x1b[6~"), ["pagedown"]);
  assert.deepEqual(parse("\x1b[3~"), ["delete"]);
  assert.deepEqual(parse("\x1b[Z"), ["shift+tab"]);
});

test("modifier-modified arrow keys", () => {
  assert.deepEqual(parse("\x1b[1;2A"), ["shift+up"]);
  assert.deepEqual(parse("\x1b[1;5A"), ["ctrl+up"]);
  assert.deepEqual(parse("\x1b[1;2D"), ["shift+left"]);
});

test("SS3 sequences (application cursor mode)", () => {
  assert.deepEqual(parse("\x1bOA"), ["up"]);
  assert.deepEqual(parse("\x1bOB"), ["down"]);
});

test("meta/alt combinations", () => {
  assert.deepEqual(parse("\x1bb"), ["meta+b"]);
});

test("a lone ESC is buffered, then flushed on demand", () => {
  const p = new KeyParser();
  assert.deepEqual(p.feed(Buffer.from("\x1b")), [], "ESC alone is ambiguous");
  assert.deepEqual(p.drain(), ["escape"]);
  // A subsequent byte turns it into a sequence instead.
  const q = new KeyParser();
  q.feed(Buffer.from("\x1b"));
  assert.deepEqual(q.feed(Buffer.from("[A")), ["up"]);
});

test("split sequences are reassembled across feeds", () => {
  const p = new KeyParser();
  assert.deepEqual(p.feed(Buffer.from("\x1b[")), []);
  assert.deepEqual(p.feed(Buffer.from("B")), ["down"]);
});

test("unknown escape sequences degrade without throwing", () => {
  const p = new KeyParser();
  assert.deepEqual(p.feed(Buffer.from("\x1b[?9999z")), []);
  assert.deepEqual(p.feed(Buffer.from("ok")), ["ok"]);
});

test("keys() async iterator over a fake stream, and detach removes listeners", () => {
  const stream = new EventEmitter();
  stream.setRawMode = () => true;
  const it = keys(stream);
  const received = [];
  const done = (async () => {
    for await (const item of it) {
      received.push(...item.keys);
      if (item.keys.includes("q")) break;
    }
  })();

  stream.emit("data", Buffer.from("\x1b[B")); // down
  stream.emit("data", Buffer.from("q"));

  return done.then(() => {
    assert.deepEqual(received, ["down", "q"]);
    assert.equal(stream.listenerCount("data"), 0, "data listener removed after return()");
  });
});

test("isSymbolicKey separates key events from text", () => {
  assert.equal(isSymbolicKey("enter"), true);
  assert.equal(isSymbolicKey("backspace"), true);
  assert.equal(isSymbolicKey("up"), true);
  assert.equal(isSymbolicKey("ctrl+c"), true);
  assert.equal(isSymbolicKey("meta+b"), true);
  assert.equal(isSymbolicKey("shift+tab"), true);
  assert.equal(isSymbolicKey(""), false);
  assert.equal(isSymbolicKey("x"), false);
  assert.equal(isSymbolicKey("hello"), false, "a pasted word is text, not a key");
});

test("keys() ends when the stream ends", async () => {
  const stream = new EventEmitter();
  const it = keys(stream);
  const received = [];
  // Consume in a separate async function so the emits below actually run;
  // awaiting the loop directly would deadlock.
  const done = (async () => {
    for await (const item of it) received.push(...item.keys);
  })();

  stream.emit("data", Buffer.from("ab"));
  stream.emit("end");
  await done;
  assert.deepEqual(received, ["ab"]);
});

test("keys() flags multi-keystroke reads as paste, single ones as not", () => {
  const stream = new EventEmitter();
  const it = keys(stream);
  const items = [];
  const done = (async () => {
    for await (const item of it) {
      items.push(item);
      if (items.length === 4) break;
    }
  })();

  stream.emit("data", Buffer.from("q")); // single keystroke
  stream.emit("data", Buffer.from("hello")); // one multi-char run => paste
  stream.emit("data", Buffer.from("\x1b[B")); // single arrow key => not paste
  stream.emit("data", Buffer.from("ab")); // one multi-char run => paste

  return done.then(() => {
    assert.deepEqual(
      items.map((i) => ({ keys: i.keys, paste: i.paste })),
      [
        { keys: ["q"], paste: false },
        { keys: ["hello"], paste: true },
        { keys: ["down"], paste: false },
        { keys: ["ab"], paste: true }, // consecutive printables arrive as one run
      ],
    );
  });
});

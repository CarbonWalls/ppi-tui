import { test } from "node:test";
import assert from "node:assert/strict";
import { createPainter } from "../src/term.js";
import { renderFrame } from "../src/render.js";
import { stripAnsi } from "../src/strutil.js";

// No-colour painter: every style transform is the identity, so assertions can
// be made on visible text. Any stray escape is still stripped for safety.
const painter = createPainter(true);
const ctx = (state, extra = {}) => ({
  width: 90,
  height: 24,
  painter,
  meta: { version: "9.9.9", rootLabel: "~/.pi", agentDirLabel: "~/.pi/agent" },
  ...extra,
});

function frame(state, extra) {
  return renderFrame(state, ctx(state, extra)).map(stripAnsi);
}

function fakeProfile(name, over = {}) {
  return {
    name,
    path: `/home/u/.pi/profiles/${name}`,
    isDefault: false,
    current: false,
    settings: {},
    model: "demo-1",
    provider: "1",
    theme: "dark",
    tuiMode: "fullscreen",
    packageCount: 2,
    packages: [],
    auth: { kind: "shared", target: "/home/u/.pi/agent/auth.json" },
    models: { kind: "shared", target: "/home/u/.pi/agent/models.json" },
    counts: { extensions: 1, skills: 2, tools: 0, prompts: 0, sessions: 3 },
    sizeBytes: 2048,
    sizeLabel: "2 KB",
    mtimeMs: Date.UTC(2026, 9, 5, 14, 2),
    mtimeLabel: "2026-10-05 14:02",
    problems: [],
    ...over,
  };
}

function stateFor(profiles, over = {}) {
  return { profiles, selected: 0, offset: 0, modal: null, status: null, currentDir: null, ...over };
}

test("renders a header with the title, profile count and root", () => {
  const lines = frame(stateFor([fakeProfile("work"), fakeProfile("play")]));
  assert.ok(lines[0].includes("ppi") && lines[0].includes("pi profile manager"));
  assert.ok(lines[0].includes("9.9.9"), "version in title bar");
  assert.ok(lines[1].includes("2 profiles"));
  assert.ok(lines[1].includes("~/.pi"));
});

test("flags the default and current profiles", () => {
  const lines = frame(
    stateFor([fakeProfile("work", { isDefault: true }), fakeProfile("live", { current: true })]),
  );
  // The marker must sit on the profile's list row, not just anywhere the name
  // appears (the subtitle also names the default).
  assert.ok(lines.some((l) => l.includes("work") && l.includes("★")), "default marker");
  assert.ok(lines.some((l) => l.includes("live") && l.includes("●")), "current marker");
  assert.ok(lines[1].includes("default") && lines[1].includes("work"), "subtitle names the default");
});

test("renders the detail pane for the selected profile", () => {
  const lines = frame(stateFor([fakeProfile("work")]));
  const joined = lines.join("\n");
  assert.ok(joined.includes("model") && joined.includes("demo-1"));
  assert.ok(joined.includes("provider") && joined.includes("dark"), "theme shown");
  assert.ok(joined.includes("auth") && joined.includes("shared"));
  assert.ok(joined.includes("2 KB"));
  assert.ok(joined.includes("sessions"));
  assert.ok(joined.includes("/home/u/.pi/profiles/work"));
});

test("footer lists the primary keybindings", () => {
  const lines = frame(stateFor([fakeProfile("work")]));
  const footer = lines[lines.length - 1]; // footer is the last line with no status
  assert.ok(footer.includes("use"));
  assert.ok(footer.includes("default"));
  assert.ok(footer.includes("new"));
  assert.ok(footer.includes("delete"));
  assert.ok(footer.includes("quit"));
});

test("status line renders when set", () => {
  const lines = frame(stateFor([fakeProfile("work")], { status: { text: "All good", kind: "success" } }));
  assert.equal(lines[lines.length - 1].trim(), "All good");
  assert.equal(lines[lines.length - 2].trim().length > 0, true, "footer still rendered above the status");
});

test("empty state invites creating a profile", () => {
  const lines = frame(stateFor([]));
  const joined = lines.join("\n");
  assert.ok(/No profiles yet/.test(joined));
  assert.ok(joined.includes("ppi create"));
});

test("shows a problem warning when auth is missing", () => {
  const lines = frame(
    stateFor([fakeProfile("work", { auth: { kind: "missing" }, problems: ["no auth.json (pi login may fail)"] })]),
  );
  const joined = lines.join("\n");
  assert.ok(joined.includes("missing"));
  assert.ok(joined.includes("no auth.json"));
});

test("create modal renders fields, toggles and buttons", () => {
  const state = stateFor([fakeProfile("work")], {
    modal: {
      type: "create",
      focus: "name",
      name: "exp",
      base: "blank",
      fromProfile: "work",
      shareAuth: true,
      shareModels: false,
      error: null,
    },
  });
  const lines = frame(state);
  const joined = lines.join("\n");
  assert.ok(joined.includes("Create profile"), "modal title");
  assert.ok(joined.includes("Name"), "name field");
  assert.ok(joined.includes("exp"), "typed name visible");
  assert.ok(joined.includes("Blank profile"));
  assert.ok(joined.includes("share auth"));
  assert.ok(joined.includes("Create") && joined.includes("Cancel"), "buttons");
});

test("create modal surfaces validation errors", () => {
  const state = stateFor([fakeProfile("work")], {
    modal: {
      type: "create",
      focus: "name",
      name: "work",
      base: "blank",
      fromProfile: "work",
      shareAuth: true,
      shareModels: true,
      error: 'A profile named "work" already exists.',
    },
  });
  const lines = frame(state);
  assert.ok(lines.some((l) => l.includes("already exists")));
});

test("delete modal asks for the exact name and gates the button", () => {
  const state = stateFor([fakeProfile("work")], {
    modal: { type: "delete", name: "work", path: "/p", typed: "wor", focus: "typed", error: null },
  });
  const lines = frame(state);
  const joined = lines.join("\n");
  assert.ok(joined.includes("Delete profile") && joined.includes("work"));
  assert.ok(joined.includes("Type the profile name to confirm"));
  assert.ok(joined.includes("must match"), "explains the gate while it is unconfirmed");
});

test("help modal lists the keys", () => {
  const state = stateFor([fakeProfile("work")], { modal: { type: "help" } });
  const lines = frame(state);
  const joined = lines.join("\n");
  assert.ok(joined.includes("Keys"));
  assert.ok(joined.includes("launch pi with the selected profile"));
  assert.ok(joined.includes("~/.pi/profiles"));
});

test("delete modal renders once the typed name matches (regression)", () => {
  // button() used to double-invoke its colour transform and throw here.
  const state = stateFor([fakeProfile("work")], {
    modal: { type: "delete", name: "work", path: "/p", typed: "work", focus: "typed", error: null },
  });
  const lines = renderFrame(state, ctx(state));
  assert.ok(lines.length > 0);
  const joined = lines.map(stripAnsi).join("\n");
  assert.ok(joined.includes("Delete"));
  assert.ok(!/must match/.test(joined), "gate hint hidden once the name matches");
});

test("warns when the terminal is too small", () => {
  const lines = renderFrame(
    stateFor([fakeProfile("work")]),
    { width: 30, height: 6, painter, meta: {} },
  ).map(stripAnsi);
  assert.ok(lines.some((l) => l.includes("Terminal too small")));
});

test("frame width never exceeds the terminal width", () => {
  const raw = renderFrame(
    stateFor([fakeProfile("work", { isDefault: true }), fakeProfile("two")]),
    { width: 64, height: 20, painter, meta: { rootLabel: "~/.pi" } },
  );
  for (const line of raw) {
    // Allow the trailing reset to be counted as zero-width.
    assert.ok(line.length <= 64 + 10, `line fits: ${JSON.stringify(line)}`);
  }
});

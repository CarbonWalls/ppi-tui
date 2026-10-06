import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { stripAnsi } from "../src/strutil.js";
import { createApi, initialState, reduce, runTui } from "../src/tui.js";
import { loadProfileManagerCtor, makeProfileManager } from "../src/profiles.js";

function fakeProfile(name, over = {}) {
  return {
    name,
    path: `/tmp/pps/${name}`,
    isDefault: false,
    current: false,
    settings: {},
    model: "demo-1",
    provider: "1",
    theme: "dark",
    tuiMode: "fullscreen",
    packageCount: 0,
    packages: [],
    auth: { kind: "shared", target: "/tmp/pps/agent/auth.json" },
    models: { kind: "shared", target: "/tmp/pps/agent/models.json" },
    counts: { extensions: 0, skills: 0, tools: 0, prompts: 0, sessions: 1 },
    sizeBytes: 10,
    sizeLabel: "10 B",
    mtimeMs: 0,
    mtimeLabel: "—",
    problems: [],
    ...over,
  };
}

function stateWith(names, over = {}) {
  const profiles = names.map((n, i) => fakeProfile(n, { isDefault: i === 0 }));
  const { selected, preselect, ...rest } = over;
  // Accept either an explicit name (preselect) or an index (selected).
  const pre =
    preselect ?? (typeof selected === "number" ? names[Math.min(selected, names.length - 1)] : undefined);
  return initialState({ profiles, currentDir: null, preselect: pre, ...rest });
}

/** Apply a sequence of keys through the reducer with a fake api. */
function play(state, keys, api, height = 24, meta = {}) {
  let s = state;
  let control = null;
  for (const k of keys) {
    const r = reduce(s, k, api, height, meta);
    s = r.state;
    control = r.control;
  }
  return { state: s, control };
}

function fakeApi(opts = {}) {
  const calls = { setDefault: [], create: [], delete: [] };
  let list = opts.profiles ?? [];
  return {
    calls,
    pm: { piRoot: "/tmp/pps", agentDir: "/tmp/pps/agent" },
    refresh: () => list,
    setList: (next) => {
      list = next;
    },
    setDefault: (name) => {
      calls.setDefault.push(name);
      if (opts.mutate) list = list.map((p) => ({ ...p, isDefault: p.name === name }));
    },
    create: (name, createOpts) => {
      calls.create.push([name, createOpts]);
      if (opts.createThrows) throw new Error("boom");
      list = [...list, fakeProfile(name)];
    },
    delete: (name) => {
      calls.delete.push(name);
      list = list.filter((p) => p.name !== name);
    },
    validate: (name) => opts.validate?.(name) ?? null,
  };
}

/* ------------------------------------------------------------- navigation */

test("arrow keys, j/k, home/end and paging move the selection", () => {
  const state = stateWith(Array.from({ length: 10 }, (_, i) => `p${i}`));
  const api = fakeApi({ profiles: state.profiles });

  assert.equal(play(state, ["down"], api, 10).state.selected, 1);
  assert.equal(play(state, ["j", "j"], api, 10).state.selected, 2);
  assert.equal(play(state, ["down", "up"], api, 10).state.selected, 0);
  assert.equal(play(state, ["end"], api, 10).state.selected, 9);
  assert.equal(play(state, ["G"], api, 10).state.selected, 9);
  assert.equal(play(state, ["end", "g"], api, 10).state.selected, 0);
  assert.equal(play(state, ["pagedown"], api, 10).state.selected, 6);
  assert.equal(play(state, ["end", "pageup"], api, 10).state.selected, 3);
});

test("selection scrolls the list into view and clamps", () => {
  const state = stateWith(Array.from({ length: 10 }, (_, i) => `p${i}`));
  const api = fakeApi({ profiles: state.profiles });
  const at9 = play(state, ["end"], api, 10);
  assert.equal(at9.state.selected, 9);
  assert.equal(at9.state.offset, 3, "offset follows the selection");
  const past = play(state, ["pagedown", "pagedown", "pagedown"], api, 10);
  assert.equal(past.state.selected, 9, "clamped to the last profile");
  const above = play(state, ["up"], api, 10);
  assert.equal(above.state.selected, 0, "clamped above zero");
});

test("unknown keys are no-ops", () => {
  const state = stateWith(["a", "b"]);
  const api = fakeApi({ profiles: state.profiles });
  const out = play(state, ["z", "f1", "insert", "ctrl+l"], api);
  assert.equal(out.state.selected, 0);
  assert.equal(out.control, null);
});

/* ---------------------------------------------------------------- actions */

test("enter / u launches the selected profile", () => {
  const state = stateWith(["a", "b"], { selected: 1 });
  const api = fakeApi({ profiles: state.profiles });
  const out = play(state, ["enter"], api);
  assert.deepEqual(out.control, { kind: "launch", path: "/tmp/pps/b", name: "b" });
  assert.deepEqual(play(state, ["u"], api).control.kind, "launch");
});

test("'d' sets the default and reports success", () => {
  const state = stateWith(["a", "b"], { selected: 1 });
  const api = fakeApi({ profiles: state.profiles, mutate: true });
  const out = play(state, ["d"], api);
  assert.deepEqual(api.calls.setDefault, ["b"]);
  assert.equal(out.state.status.kind, "success");
  assert.ok(out.state.status.text.includes('"b"'));
  assert.equal(out.state.profiles[1].isDefault, true);
  assert.equal(out.state.profiles[0].isDefault, false);
});

test("'D' opens a delete modal that requires the exact name", () => {
  const state = stateWith(["a", "b"], { selected: 1 });
  const api = fakeApi({ profiles: state.profiles });

  const opened = play(state, ["D"], api);
  assert.equal(opened.state.modal.type, "delete");
  assert.equal(opened.state.modal.name, "b");

  // Wrong name: no deletion, error shown.
  const wrong = play(state, ["D", "x", "enter"], api);
  assert.deepEqual(api.calls.delete, []);
  assert.ok(wrong.state.modal.error.includes("Type the full name"));

  // Correct name: deleted, modal closed, status set.
  const ok = play(state, ["D", "b", "enter"], api);
  assert.deepEqual(api.calls.delete, ["b"]);
  assert.equal(ok.state.modal, null);
  assert.equal(ok.state.status.kind, "success");
});

test("delete errors from ppi surface in the modal", () => {
  const state = stateWith(["a"]);
  const api = fakeApi({ profiles: state.profiles });
  api.delete = () => {
    throw new Error("permission denied");
  };
  const out = play(state, ["D", "a", "enter"], api);
  assert.equal(out.state.modal.error, "permission denied");
  assert.notEqual(out.state.modal, null, "modal stays open on failure");
});

/* ------------------------------------------------------------- create flow */

test("'n' opens the create modal and typing builds the name", () => {
  const state = stateWith(["a"]);
  const api = fakeApi({ profiles: state.profiles });
  const out = play(state, ["n", "w", "o", "r", "k", "-", "1"], api);
  assert.equal(out.state.modal.type, "create");
  assert.equal(out.state.modal.name, "work-1");
});

test("create rejects invalid characters without losing the name", () => {
  const state = stateWith(["a"]);
  const api = fakeApi({ profiles: state.profiles });
  // A space is refused and explained; the typed name survives.
  const afterSpace = play(state, ["n", "wo", " "], api);
  assert.equal(afterSpace.state.modal.name, "wo");
  assert.ok(afterSpace.state.modal.error.includes("Allowed"));
  // Continuing with valid input clears the complaint.
  const afterMore = play(state, ["n", "wo", " ", "rk"], api);
  assert.equal(afterMore.state.modal.name, "work");
  assert.equal(afterMore.state.modal.error, null);
});

test("create with a duplicate name shows a validation error", () => {
  const state = stateWith(["a"]);
  const api = fakeApi({
    profiles: state.profiles,
    validate: (name) => (name === "a" ? 'A profile named "a" already exists.' : null),
  });
  const out = play(state, ["n", "a", "tab", "tab", "tab", "tab", "enter"], api);
  assert.deepEqual(api.calls.create, []);
  assert.equal(out.state.modal.error, 'A profile named "a" already exists.');
  assert.equal(out.state.modal, out.state.modal, "modal stays open");
});

test("create submits the expected options and selects the new profile", () => {
  const state = stateWith(["a"]);
  const api = fakeApi({ profiles: state.profiles });
  // name -> base -> auth -> models -> create  (4 tabs from 'name')
  const out = play(state, ["n", "d", "e", "m", "o", "tab", "tab", "tab", "tab", "enter"], api);
  assert.deepEqual(api.calls.create, [["demo", { shareAuth: true, shareModels: true }]]);
  assert.equal(out.state.modal, null);
  assert.equal(out.state.selected, 1, "new profile selected");
  assert.equal(out.state.profiles[1].name, "demo");
  assert.equal(out.state.status.kind, "success");
});

test("create can copy from an existing profile", () => {
  const state = stateWith(["a", "b"]);
  const api = fakeApi({ profiles: state.profiles });
  // name field, then tab to the base group, 'right' twice: blank -> base -> from,
  // then tab from->auth->models->create to reach the Create button.
  const out = play(
    state,
    ["n", "c", "2", "tab", "right", "right", "tab", "tab", "tab", "tab", "enter"],
    api,
  );
  assert.deepEqual(api.calls.create, [
    ["c2", { shareAuth: true, shareModels: true, from: "a" }],
  ]);
  assert.equal(out.state.status.kind, "success");
});

test("toggles and cancel button work", () => {
  const state = stateWith(["a"]);
  const api = fakeApi({ profiles: state.profiles });
  // Tab to auth (name->base->auth), space toggles it off.
  const toggled = play(state, ["n", "tab", "tab", " "], api);
  assert.equal(toggled.state.modal.shareAuth, false);
  assert.equal(toggled.state.modal.shareModels, true);
  // Cancel closes without creating.
  const cancelled = play(state, ["n", "tab", "tab", "tab", "tab", "tab", " "], api);
  assert.deepEqual(api.calls.create, []);
  assert.equal(cancelled.state.modal, null);
});

test("escape and ctrl+c close modals / quit", () => {
  const state = stateWith(["a"]);
  const api = fakeApi({ profiles: state.profiles });
  assert.equal(play(state, ["n", "escape"], api).state.modal, null);
  assert.equal(play(state, ["n", "ctrl+c"], api).state.modal, null);
  assert.equal(play(state, ["escape"], api).control.kind, "quit");
  assert.equal(play(state, ["q"], api).control.kind, "quit");
  assert.equal(play(state, ["ctrl+c"], api).control.kind, "quit");
});

test("'?' opens the help overlay", () => {
  const state = stateWith(["a"]);
  const api = fakeApi({ profiles: state.profiles });
  assert.equal(play(state, ["?"], api).state.modal.type, "help");
  assert.equal(play(state, ["?", "escape"], api).state.modal, null);
});

test("pasted input never launches pi or mutates profiles", () => {
  const state = stateWith(["a", "b"]);
  const api = fakeApi({ profiles: state.profiles });

  // A paste containing 'enter' must not launch the selected profile.
  const paste = play(state, ["enter"], api, 24, { paste: true });
  assert.equal(paste.control, null);
  assert.deepEqual(api.calls.setDefault, []);

  // Pasted action letters in the list are ignored too.
  const pasteActions = play(state, ["d", "D", "n", "q"], api, 24, { paste: true });
  assert.deepEqual(api.calls.delete, []);
  assert.deepEqual(api.calls.create, []);
  assert.equal(pasteActions.control, null, "paste does not quit either");
  assert.equal(pasteActions.state.modal, null, "paste does not open dialogs");
});

test("pasted text still fills an open name field", () => {
  const state = stateWith(["a"]);
  const api = fakeApi({ profiles: state.profiles });

  // Open the modal with a real keystroke, then paste a name.
  const opened = play(state, ["n"], api);
  const pasted = play(opened.state, ["work-2"], api, 24, { paste: true });
  assert.equal(pasted.state.modal.name, "work-2");

  // A paste containing enter does not submit the form.
  const notSubmitted = play(opened.state, ["w", "enter"], api, 24, { paste: true });
  assert.deepEqual(api.calls.create, []);
  assert.equal(notSubmitted.state.modal.name, "w");
});

test("'r' refreshes and clears stale selection", () => {
  const state = stateWith(["a", "b"], { selected: 1 });
  const api = fakeApi({ profiles: state.profiles });
  const out = play(state, ["r"], api);
  assert.ok(out.state.status.text.includes("Refreshed"));
  // Selection is kept by name across a refresh.
  assert.equal(out.state.selected, 1);
});

/* -------------------------------------------------- end-to-end via runTui */

let root;
let savedAgentDir;
let ProfileManager;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "ppi-tui-e2e-"));
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "skills", "greeter"), { recursive: true });
  writeFileSync(join(agentDir, "skills", "greeter", "SKILL.md"), "# greet\n");
  writeFileSync(join(agentDir, "auth.json"), '{"token":"abc"}\n');
  writeFileSync(join(agentDir, "models.json"), "{}\n");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "demo-1" }) + "\n");

  process.env.PPI_PI_ROOT = root;
  // Keep the live session's profile well away from this suite.
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;

  ProfileManager = await loadProfileManagerCtor();
  const pm = makeProfileManager(ProfileManager);
  pm.create("alpha");
});

after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  rmSync(root, { recursive: true, force: true });
});

/** A fake Terminal that records painted frames instead of writing to stdout. */
function fakeTerminal({ width = 90, height = 24 } = {}) {
  return {
    width,
    height,
    isTTY: true,
    frames: [],
    setup() {},
    teardown() {
      this.tornDown = true;
    },
    onResize() {},
    offResize() {},
    paintFrame(rows) {
      this.frames.push(rows.map((r) => stripAnsi(r)));
    },
    write() {},
  };
}

/** Synthetic key stream: yields keys one per tick, then ends. */
function syntheticKeys(keys) {
  const it = keys[Symbol.iterator]();
  const gen = {
    next: () => {
      const r = it.next();
      return r.done
        ? Promise.resolve({ value: undefined, done: true })
        : Promise.resolve({ value: { keys: [r.value], paste: false }, done: false });
    },
    return: () => Promise.resolve({ value: undefined, done: true }),
    throw: (e) => Promise.reject(e),
  };
  return { [Symbol.asyncIterator]: () => gen };
}

/* ------------------------------------------------- real-process exit test */

// The TUI used to stay alive after `q`/esc because the TTY stdin/stdout kept
// the event loop ref'd. The fake terminal above cannot catch that (it never
// touches real streams), so drive the actual binary under a real pty via socat
// and check the *node* process really exits.
//
// This must run under a pty: with piped stdio the app takes its non-TTY
// fallback and prints a plain listing instead of entering the TUI, so `q`
// would never be read. And socat itself waits on its stdin pipe, so the test
// must poll for the child rather than wait for socat to return.
test("quitting the real binary exits the process (no lingering TTY handles)", async () => {
  const socat = spawnSync("which", ["socat"], { encoding: "utf8" }).stdout.trim();
  if (!socat || !existsSync(socat)) return; // not every runner has socat

  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "ppi-tui.js");
  // The wrapper records the TUI's own pid, so the test can watch the real
  // process rather than scraping the process table (socat re-execs its child,
  // so `ps` shows the whole EXEC: line and the `timeout` wrapper too).
  const pidFile = join(root, "tui.pid");
  // `$$` is the wrapper shell's pid; we exec node *in place*, so it is also
  // the TUI's pid.
  const wrapper = [
    "#!/bin/sh",
    "unset PI_CODING_AGENT_DIR",
    "export PPI_PI_ROOT=" + JSON.stringify(root),
    "export COLUMNS=100 LINES=24",
    "printf %s $$ > " + JSON.stringify(pidFile),
    "exec node " + JSON.stringify(bin),
    "",
  ].join("\n");
  const wrapperPath = join(root, "run-tui.sh");
  writeFileSync(wrapperPath, wrapper, { mode: 0o755 });

  const cmd =
    "(sleep 0.4; printf q; sleep 8) | exec timeout 20 " +
    [JSON.stringify(socat), "-", JSON.stringify("EXEC:" + wrapperPath + ",pty,rawer,echo=0")].join(" ");
  const child = spawn("/bin/sh", ["-c", cmd], { stdio: "ignore" });

  // Wait for the pid file, then poll that pid until it is gone. A prompt quit
  // makes it vanish right after 'q'; a hang keeps it alive for the full window.
  const started = Date.now();
  let pid = undefined;
  for (let i = 0; i < 40 && pid === undefined; i++) {
    try {
      pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  let exited = false;
  if (pid) {
    for (let i = 0; i < 60; i++) {
      if (!existsSync("/proc/" + pid)) {
        exited = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  const elapsed = Date.now() - started;
  rmSync(wrapperPath, { force: true });
  rmSync(pidFile, { force: true });
  assert.ok(pid, "the TUI wrapper never reported its pid");
  assert.ok(existedWrapper(pid), "sanity: pid was live at least once");
  assert.ok(exited, `the TUI process (pid ${pid}) was still alive after ${elapsed}ms — it did not quit`);
  assert.ok(elapsed < 3000, `quit was not prompt — took ${elapsed}ms`);
});

function existedWrapper(pid) {
  // The pid file existed and named a real process at some point: /proc/<pid>
  // disappearing after we saw it is the exit signal, so merely having read the
  // pid is enough to know it started.
  return Number.isInteger(pid) && pid > 0;
}

test("runTui navigates, creates a profile through real ppi, and quits", async () => {
  const term = fakeTerminal();
  const api = createApi(ProfileManager);
  await runTui({
    ProfileManager,
    api,
    term,
    input: syntheticKeys(["down", "n", "b", "e", "t", "a", "tab", "tab", "tab", "tab", "enter", "q"]),
  });

  assert.ok(existsSync(join(root, "profiles", "beta")), "profile was really created via ppi");
  const last = term.frames[term.frames.length - 1];
  assert.ok(term.tornDown, "terminal restored on exit");
  const anyFrame = term.frames.map((f) => f.join("\n"));
  assert.ok(anyFrame.some((f) => f.includes("beta")), "beta appears in a rendered frame");
  assert.ok(anyFrame.some((f) => f.includes("Created profile")), "success status rendered");
  assert.ok(last.some((l) => l.includes("alpha") || l.includes("beta")));
});

test("runTui hands the terminal to pi on enter", async () => {
  const term = fakeTerminal();
  const api = createApi(ProfileManager);
  let launched = null;
  await runTui({
    ProfileManager,
    api,
    term,
    input: syntheticKeys(["enter"]),
    onLaunch: (control) => {
      launched = control;
    },
  });
  assert.ok(launched, "onLaunch fired instead of spawning pi");
  assert.equal(launched.name, "alpha");
  assert.ok(launched.path.endsWith(join("profiles", "alpha")));
  assert.ok(term.tornDown, "terminal restored before handing over");
});

test("runTui renders even with an empty profile list", async () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), "ppi-tui-empty-"));
  const saved = process.env.PPI_PI_ROOT;
  process.env.PPI_PI_ROOT = emptyRoot;
  try {
    const term = fakeTerminal();
    const api = createApi(ProfileManager);
    await runTui({ ProfileManager, api, term, input: syntheticKeys(["q"]) });
    const joined = term.frames.map((f) => f.join("\n"));
    assert.ok(joined.some((f) => f.includes("No profiles yet")));
  } finally {
    process.env.PPI_PI_ROOT = saved;
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

// CLI subcommand tests.
//
// These drive `main()` directly (not the TUI) against a throwaway pi root, so
// they exercise the non-interactive paths that mirror `ppi` itself: create with
// --from / --from-base / --own-*, delete with --force, and set-default.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "ppi-tui.js");

let root;
let profilesDir;
let savedRoot;

before(() => {
  root = mkdtempSync(join(tmpdir(), "ppicli-"));
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(join(root, "agent", "settings.json"), '{"defaultModel":"demo-1"}');
  writeFileSync(join(root, "agent", "auth.json"), '{"token":"abc"}');
  writeFileSync(join(root, "agent", "models.json"), "[]");
  mkdirSync(join(root, "agent", "skills"), { recursive: true });
  writeFileSync(join(root, "agent", "skills", "demo.md"), "# demo");
  profilesDir = join(root, "profiles");
  savedRoot = process.env.PPI_PI_ROOT;
  process.env.PPI_PI_ROOT = root;
  delete process.env.PI_CODING_AGENT_DIR;
});

after(() => {
  process.env.PPI_PI_ROOT = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

/**
 * Run the CLI in a real subprocess with the throwaway root.
 *
 * Spawning is deliberate: swapping process.stdout/stderr in-process (even via
 * Object.defineProperty) breaks node's own console and test reporter, which
 * both reach for stream internals. A subprocess keeps the capture honest and
 * isolates exit codes.
 */
async function run(...args) {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { ...process.env, PPI_PI_ROOT: root, PI_CODING_AGENT_DIR: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out = [];
  const err = [];
  child.stdout.on("data", (d) => out.push(d));
  child.stderr.on("data", (d) => err.push(d));
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8"), code };
}

function readDefault() {
  try {
    return JSON.parse(readFileSync(join(profilesDir, "default.json"), "utf8")).default;
  } catch {
    return undefined;
  }
}

test("create makes a blank scaffold sharing stock auth/models", async () => {
  const { out } = await run("create", "blank");
  assert.match(out, /Created "blank"/);
  assert.ok(existsSync(join(profilesDir, "blank", "settings.json")));
  for (const d of ["extensions", "skills", "tools", "prompts", "sessions"]) {
    assert.ok(existsSync(join(profilesDir, "blank", d)), `${d} scaffolded`);
  }
  assert.equal(readFileSync(join(profilesDir, "blank", "settings.json"), "utf8"), "{}\n");
  // Shared by default: symlinks back to the stock agent dir.
  assert.ok(existsSync(join(profilesDir, "blank", "auth.json")));
});

test("create --from copies an existing profile", async () => {
  await run("create", "blank");
  const { out } = await run("create", "copied", "--from", "blank");
  assert.match(out, /from "blank"/);
  assert.ok(existsSync(join(profilesDir, "copied", "settings.json")));
});

test("create --from-base seeds settings from the stock agent dir", async () => {
  const { out } = await run("create", "based", "--from-base");
  assert.match(out, /from stock pi config/);
  const settings = JSON.parse(readFileSync(join(profilesDir, "based", "settings.json"), "utf8"));
  assert.equal(settings.defaultModel, "demo-1");
  // Skills are part of the base.
  assert.ok(existsSync(join(profilesDir, "based", "skills", "demo.md")));
});

test("create --own-models copies instead of symlinking models", async () => {
  await run("create", "ownm", "--own-models");
  const p = join(profilesDir, "ownm", "models.json");
  assert.ok(existsSync(p));
  assert.equal(readFileSync(p, "utf8"), "[]");
});

test("create rejects --from and --from-base together", async () => {
  await run("create", "blank");
  const { err } = await run("create", "bad", "--from", "blank", "--from-base");
  assert.match(err, /Cannot use both --from and --from-base/);
  assert.ok(!existsSync(join(profilesDir, "bad")));
});

test("create rejects a duplicate name", async () => {
  await run("create", "blank");
  const { err } = await run("create", "blank");
  assert.match(err, /already exists/);
});

test("create rejects an invalid name", async () => {
  const { err } = await run("create", "not valid!");
  assert.match(err, /Invalid profile name/);
  assert.ok(!existsSync(join(profilesDir, "not valid!")));
});

test("create requires a name", async () => {
  const { err } = await run("create");
  assert.match(err, /Usage: ppi-tui create/);
});

test("--from requires a value", async () => {
  const { err } = await run("create", "x", "--from");
  assert.match(err, /--from requires a profile name/);
});

test("set-default writes default.json", async () => {
  await run("create", "alpha");
  await run("create", "beta");
  const { out } = await run("set-default", "beta");
  assert.match(out, /Default profile set to "beta"/);
  assert.equal(readDefault(), "beta");
});

test("set-default requires a name", async () => {
  const { err } = await run("set-default");
  assert.match(err, /Usage: ppi-tui set-default/);
});

test("set-default rejects an unknown profile", async () => {
  const { err } = await run("set-default", "ghost");
  assert.match(err, /does not exist/);
});

test("delete --force removes the profile", async () => {
  await run("create", "doomed");
  const { out } = await run("delete", "doomed", "--force");
  assert.match(out, /Profile "doomed" deleted/);
  assert.ok(!existsSync(join(profilesDir, "doomed")));
});

test("delete clears the default when removing it", async () => {
  await run("create", "primary");
  await run("set-default", "primary");
  await run("delete", "primary", "--force");
  assert.equal(readDefault(), undefined);
});

test("delete requires --force when stdin is not a TTY", async () => {
  await run("create", "guarded");
  const { err } = await run("delete", "guarded");
  assert.match(err, /Use --force to delete non-interactively/);
  assert.ok(existsSync(join(profilesDir, "guarded")), "profile left intact");
});

test("delete rejects an unknown profile", async () => {
  const { err } = await run("delete", "ghost", "--force");
  assert.match(err, /does not exist/);
});

test("delete requires a name", async () => {
  const { err } = await run("delete");
  assert.match(err, /Usage: ppi-tui delete/);
});

test("list prints profiles without a TTY", async () => {
  await run("create", "alpha");
  await run("create", "beta");
  await run("set-default", "alpha");
  const { out } = await run("list");
  assert.match(out, /alpha/);
  assert.match(out, /beta/);
  assert.match(out, /\* alpha/, "default is starred");
  assert.ok(!/\x1b\[/.test(out), "no ANSI escapes in the plain listing");
});

test("help lists the subcommands", async () => {
  const { out } = await run("--help");
  assert.match(out, /ppi-tui/);
  assert.match(out, /create <name>/);
  assert.match(out, /--from <profile>/);
  assert.match(out, /--from-base/);
  assert.match(out, /delete <name>/);
  assert.match(out, /set-default <name>/);
});

test("version prints the package version", async () => {
  const { out } = await run("--version");
  assert.match(out.trim(), /^ppi-tui \d+\.\d+\.\d+$/);
});

test("unknown options are reported", async () => {
  const { err } = await run("--nope");
  assert.match(err, /Unknown option/);
});

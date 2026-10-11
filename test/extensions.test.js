// Package (extension) management across profiles: shared-npm dedup,
// settings.json packages editing, and the all-profiles orchestration.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readlinkSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfileManagerCtor, makeProfileManager } from "../src/profiles.js";
import {
  addPackageToProfile,
  ensureSharedNpm,
  installExtensionForAll,
  normalizeSource,
  npmSharingInfo,
  packageSharingSummaries,
  removeExtensionFromAll,
  removePackageFromProfile,
  sharedNpmDir,
  updateExtensionsForAll,
} from "../src/extensions.js";

let root;
let pm;
let savedRoot;

function makeProfile(name, { withNpm = false } = {}) {
  const dir = join(root, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), "{}\n");
  if (withNpm) {
    const npm = join(dir, "npm", "node_modules", "some-pkg");
    mkdirSync(npm, { recursive: true });
    writeFileSync(join(npm, "index.js"), "export {};\n");
  }
  return dir;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "ppi-ext-"));
  savedRoot = process.env.PPI_PI_ROOT;
  process.env.PPI_PI_ROOT = root;
  const ProfileManager = await loadProfileManagerCtor();
  pm = makeProfileManager(ProfileManager);
});

after(() => {
  if (savedRoot === undefined) delete process.env.PPI_PI_ROOT;
  else process.env.PPI_PI_ROOT = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

test("normalizeSource adds npm: to bare names and leaves others alone", () => {
  assert.equal(normalizeSource("pi-foo"), "npm:pi-foo");
  assert.equal(normalizeSource("@scope/pkg"), "npm:@scope/pkg");
  assert.equal(normalizeSource("npm:pi-foo"), "npm:pi-foo");
  assert.equal(normalizeSource("npm:@scope/pkg@1.0.0"), "npm:@scope/pkg@1.0.0");
  assert.equal(normalizeSource("git:github.com/x/y"), "git:github.com/x/y");
  assert.equal(normalizeSource("https://example.com/x"), "https://example.com/x");
  assert.equal(normalizeSource("./local"), "./local");
  assert.equal(normalizeSource("/abs/path"), "/abs/path");
  assert.equal(normalizeSource(""), "");
});

test("addPackageToProfile is idempotent and preserves existing keys", () => {
  const dir = makeProfile("edita");
  addPackageToProfile(dir, "pi-one");
  addPackageToProfile(dir, "@scope/two");
  assert.equal(addPackageToProfile(dir, "pi-one"), false, "second add is a no-op");
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, ["npm:pi-one", "npm:@scope/two"]);
  assert.equal(settings.defaultModel, undefined);
});

test("removePackageFromProfile removes string AND object entries", () => {
  const dir = makeProfile("editb");
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ packages: ["npm:pi-one", { source: "npm:other", extensions: [] }] }) + "\n",
  );
  assert.equal(removePackageFromProfile(dir, "other"), true);
  assert.equal(removePackageFromProfile(dir, "pi-one"), true);
  assert.equal(removePackageFromProfile(dir, "pi-one"), false, "already gone");
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, []);
});

test("ensureSharedNpm creates a shared root and symlinks profiles to it", () => {
  const a = makeProfile("shA");
  const b = makeProfile("shB");
  const report = ensureSharedNpm(pm, { log: () => {} });
  const shared = sharedNpmDir(root);
  assert.ok(existsSync(shared));
  for (const p of [a, b]) {
    const info = npmSharingInfo(p);
    assert.equal(info.kind, "symlink");
    assert.equal(readlinkSync(info.path), shared);
  }
  assert.ok(report.linked.includes("shA"));
  assert.ok(report.linked.includes("shB"));
  // Re-running is a no-op ("already shared").
  const report2 = ensureSharedNpm(pm, { log: () => {} });
  assert.deepEqual(report2.migrated, []);
  assert.ok(report2.linked.length === 0, "no new links created on re-run");
});

test("ensureSharedNpm migrates a real per-profile npm dir into the shared root", () => {
  const c = makeProfile("shC", { withNpm: true });
  const npm = join(c, "npm");
  assert.equal(lstatSync(npm).isDirectory(), true, "starts as a real dir");
  const report = ensureSharedNpm(pm, { log: () => {} });
  assert.deepEqual(report.migrated, ["shC"]);
  // contents moved into shared root
  assert.ok(existsSync(join(sharedNpmDir(root), "node_modules", "some-pkg", "index.js")));
  // dir replaced by symlink to shared root
  const info = npmSharingInfo(c);
  assert.equal(info.kind, "symlink");
  assert.equal(readlinkSync(info.path), sharedNpmDir(root));
});

test("installExtensionForAll runs pi install once and declares it in every profile", () => {
  const dirs = [makeProfile("instA"), makeProfile("instB")];
  const calls = [];
  const fakeRun = (agentDir, args) => {
    calls.push({ agentDir, args });
    return 0;
  };
  const result = installExtensionForAll(pm, "pi-fresh", { run: fakeRun, log: () => {} });
  assert.equal(result.norm, "npm:pi-fresh");
  // exactly one physical install
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["install", "npm:pi-fresh"]);
  // every profile now lists it and shares the npm dir
  for (const d of dirs) {
    const settings = JSON.parse(readFileSync(join(d, "settings.json"), "utf8"));
    assert.deepEqual(settings.packages, ["npm:pi-fresh"]);
    assert.equal(npmSharingInfo(d).kind, "symlink");
  }
});

test("installExtensionForAll is idempotent and propagates a shared install", () => {
  const dirs = [makeProfile("instC"), makeProfile("instD")];
  // Simulate that profile A already had the package (pi install wrote it there).
  addPackageToProfile(dirs[0], "pi-fresh");
  const calls = [];
  installExtensionForAll(pm, "pi-fresh", { run: (...a) => (calls.push(a), 0), log: () => {} });
  // pi install runs again (fresh fetch ensures latest), but profiles that
  // already list the source do not get duplicates.
  for (const d of dirs) {
    const s = JSON.parse(readFileSync(join(d, "settings.json"), "utf8"));
    assert.deepEqual(s.packages, ["npm:pi-fresh"]);
  }
});

test("updateExtensionsForAll runs pi update once per source mode", () => {
  makeProfile("upA");
  makeProfile("upB");
  const all = [];
  updateExtensionsForAll(pm, undefined, { run: (a, b) => (all.push(b), 0), log: () => {} });
  assert.deepEqual(all, [["update", "--extensions"]]);

  const single = [];
  updateExtensionsForAll(pm, "pi-fresh", { run: (a, b) => (single.push(b), 0), log: () => {} });
  assert.deepEqual(single, [["update", "npm:pi-fresh"]]);
});

test("removeExtensionFromAll drops the package from every profile", () => {
  const dirs = [makeProfile("rmA"), makeProfile("rmB")];
  // Only these two profiles carry the unique source.
  for (const d of dirs) addPackageToProfile(d, "pi-rmonly");
  const r = removeExtensionFromAll(pm, "pi-rmonly", { log: () => {} });
  assert.deepEqual(r.removed.sort(), ["rmA", "rmB"]);
  for (const d of dirs) {
    const s = JSON.parse(readFileSync(join(d, "settings.json"), "utf8"));
    assert.deepEqual(s.packages, []);
  }
  // unrelated profiles are untouched and not reported as changed
  assert.ok(!r.removed.includes("instA"));
  const instA = JSON.parse(
    readFileSync(join(root, "profiles", "instA", "settings.json"), "utf8"),
  );
  assert.ok(instA.packages.includes("npm:pi-fresh"));
});

test("packageSharingSummaries reports shared vs local vs missing", () => {
  const shared = makeProfile("sumS");
  const local = makeProfile("sumL", { withNpm: true });
  const miss = makeProfile("sumM");
  ensureSharedNpm(pm, { log: () => {} });
  // make one profile intentionally "local" by pointing it at its own npm dir
  rmSync(join(local, "npm"), { recursive: true, force: true });
  mkdirSync(join(local, "npm", "node_modules"), { recursive: true });

  const map = Object.fromEntries(
    packageSharingSummaries(pm).map((s) => [s.name, s.sharing]),
  );
  assert.equal(map.sumS, "shared");
  assert.equal(map.sumM, "shared", "missing got symlinked by ensureSharedNpm");
  assert.equal(map.sumL, "local");
});

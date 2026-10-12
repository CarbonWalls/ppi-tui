// setup: resolve pi-profiles into a fresh clone and create the `ppi` shim,
// all idempotent and non-destructive of an existing ppi.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultBinDir,
  ensurePiProfiles,
  ensurePpiShim,
  findGlobalPiProfiles,
  setup,
} from "../src/setup.js";

let root;
let savedRoot;

before(() => {
  root = mkdtempSync(join(tmpdir(), "ppi-setup-"));
  savedRoot = process.env.PPI_PI_ROOT;
  delete process.env.PPI_PI_ROOT;
});

after(() => {
  if (savedRoot === undefined) delete process.env.PPI_PI_ROOT;
  else process.env.PPI_PI_ROOT = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

test("findGlobalPiProfiles locates the globally installed pi-profiles", () => {
  const p = findGlobalPiProfiles();
  assert.ok(p, "a global pi-profiles should exist on this machine");
  assert.ok(existsSync(join(p, "dist", "src", "index.js")), "points at the real package");
});

test("ensurePiProfiles symlinks a global copy into a bare project", () => {
  const proj = join(root, "proj");
  mkdirSync(proj);
  const r = ensurePiProfiles(proj, { log: () => {} });
  assert.equal(r.status, "linked");
  const local = join(proj, "node_modules", "pi-profiles");
  assert.ok(lstatSync(local).isSymbolicLink());
  // second run sees it as resolvable, no duplicate work
  const r2 = ensurePiProfiles(proj, { log: () => {} });
  assert.equal(r2.status, "ok");
});

test("ensurePpiShim creates a ppi link, backing up an existing one", () => {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const target = join(root, "bin", "ppi-tui.js");
  writeFileSync(target, "#!/usr/bin/env node\n");

  // fresh link
  const r1 = ensurePpiShim(bin, target, { log: () => {} });
  assert.equal(r1.status, "linked");
  assert.equal(readlinkSync(join(bin, "ppi")), target);

  // idempotent
  const r2 = ensurePpiShim(bin, target, { log: () => {} });
  assert.equal(r2.status, "ok");

  // another tool occupies `ppi` -> it is backed up and replaced
  writeFileSync(join(bin, "ppitarget"), "#!/usr/bin/env node\n");
  rmSync(join(bin, "ppi"));
  symlinkOrFile(join(bin, "ppi"), join(bin, "ppitarget"));
  const r3 = ensurePpiShim(bin, target, { log: () => {} });
  assert.equal(r3.status, "backedUpLink");
  assert.ok(existsSync(join(bin, "ppi.orig.bak")));
  assert.equal(readlinkSync(join(bin, "ppi")), target);
});

function symlinkOrFile(path, target) {
  try {
    symlinkSync(target, path, "file");
  } catch {
    /* already exists */
  }
}

test("defaultBinDir prefers the running node's bin dir, never npm bin -g", () => {
  // npm removed `npm bin` in v11; the old implementation fell through to a
  // regex that misses source checkouts and returned /usr/local/bin. For nvm,
  // homebrew and distro installs the running node's bin dir is exactly right.
  const bin = defaultBinDir("/home/user/somewhere/bin/ppi-tui.js");
  assert.equal(bin, dirname(process.execPath));
  assert.notEqual(bin, "/usr/local/bin");
  assert.ok(process.execPath.startsWith(bin), "executable itself lives there");
});

test("setup() reports ok and links pi-profiles + shim end to end", () => {
  const proj = join(root, "full");
  mkdirSync(proj, { recursive: true });
  const bin = join(root, "fullbin");
  const target = join(proj, "bin", "ppi-tui.js");
  mkdirSync(join(proj, "bin"), { recursive: true });
  writeFileSync(target, "#!/usr/bin/env node\n");
  const r = setup({ projectRoot: proj, binDir: bin, target, log: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.pi.status, "linked");
  assert.equal(r.shim.status, "linked");
  assert.equal(readlinkSync(join(bin, "ppi")), target);
});

test("setup() with makeShim=false only resolves pi-profiles", () => {
  const proj = join(root, "noShim");
  mkdirSync(proj, { recursive: true });
  const bin = join(root, "noshim-bin");
  const r = setup({ projectRoot: proj, binDir: bin, makeShim: false, log: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.pi.status, "linked");
  assert.equal(r.shim, undefined);
  assert.ok(!existsSync(join(bin, "ppi")));
});

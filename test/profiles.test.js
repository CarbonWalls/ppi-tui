import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enrichAll,
  enrichProfile,
  loadProfileManagerCtor,
  makeProfileManager,
  nameValidationError,
  readSettings,
} from "../src/profiles.js";

// A throwaway pi root: this suite drives ppi's *real* ProfileManager, so it
// must never touch the user's ~/.pi.
let root;
let agentDir;
let profilesDir;
let ProfileManager;
let pm;
let savedRoot;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "ppi-tui-"));
  agentDir = join(root, "agent");
  profilesDir = join(root, "profiles");
  mkdirSync(join(agentDir, "skills", "greeter"), { recursive: true });
  mkdirSync(join(agentDir, "extensions", "ext-one"), { recursive: true });
  writeFileSync(join(agentDir, "skills", "greeter", "SKILL.md"), "# greet\n");
  writeFileSync(join(agentDir, "extensions", "ext-one", "extension.ts"), "export {};\n");
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ token: "x".repeat(200000) }) + "\n");
  writeFileSync(join(agentDir, "models.json"), '{"models":{}}\n');
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultModel: "demo-1", defaultProvider: "1", theme: "dark" }) + "\n",
  );

  savedRoot = process.env.PPI_PI_ROOT;
  process.env.PPI_PI_ROOT = root;

  ProfileManager = await loadProfileManagerCtor();
  pm = makeProfileManager(ProfileManager);
});

after(() => {
  if (savedRoot === undefined) delete process.env.PPI_PI_ROOT;
  else process.env.PPI_PI_ROOT = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

test("ppi's own create() lays out the expected profile scaffold", () => {
  pm.create("blank");
  assert.ok(existsSync(join(profilesDir, "blank", "settings.json")));
  for (const dir of ["extensions", "skills", "tools", "prompts", "sessions"]) {
    assert.ok(existsSync(join(profilesDir, "blank", dir)), `${dir}/ exists`);
  }
  // Default behaviour symlinks auth/models from the stock agentDir.
  assert.ok(lstatSync(join(profilesDir, "blank", "auth.json")).isSymbolicLink());
  assert.equal(readlinkSync(join(profilesDir, "blank", "auth.json")), join(agentDir, "auth.json"));
});

test("--from-base copies stock settings but not sessions", () => {
  pm.create("frombase", { fromBase: true });
  const settings = readSettings(join(profilesDir, "frombase"));
  assert.equal(settings.defaultModel, "demo-1");
  assert.equal(settings.theme, "dark");
  assert.ok(existsSync(join(profilesDir, "frombase", "skills", "greeter", "SKILL.md")), "copied a skill");
  assert.ok(existsSync(join(profilesDir, "frombase", "sessions")), "sessions dir exists");
  const enriched = enrichProfile({ name: "frombase", path: join(profilesDir, "frombase") }, {});
  assert.equal(enriched.counts.sessions, 0, "sessions are not copied from base");
});

test("--own-auth copies instead of symlinking", () => {
  pm.create("own", { shareAuth: false });
  assert.ok(lstatSync(join(profilesDir, "own", "auth.json")).isFile(), "auth.json is a real file");
  assert.ok(lstatSync(join(profilesDir, "own", "models.json")).isSymbolicLink(), "models still shared");
});

test("--from copies an existing profile and preserves its symlinks", () => {
  pm.create("copy", { from: "blank" });
  assert.ok(lstatSync(join(profilesDir, "copy", "auth.json")).isSymbolicLink());
});

test("enrichment reports counts, sizes, link status and settings", () => {
  const profiles = enrichAll(pm, { currentDir: null });
  const byName = Object.fromEntries(profiles.map((p) => [p.name, p]));

  assert.deepEqual(profiles.map((p) => p.name).sort(), ["blank", "copy", "frombase", "own"].sort());

  const blank = byName.blank;
  assert.equal(blank.auth.kind, "shared");
  assert.equal(blank.models.kind, "shared");
  assert.equal(blank.counts.extensions, 0);
  assert.equal(blank.counts.sessions, 0);
  // The stock auth.json is 200 KB, but a shared profile must not count the
  // target's size — only the symlink itself.
  assert.ok(blank.sizeBytes < 4096, `symlink targets not followed (got ${blank.sizeBytes})`);
  assert.ok(/(bytes|B|KB)/.test(blank.sizeLabel));

  const base = byName.frombase;
  assert.equal(base.model, "demo-1");
  assert.equal(base.provider, "1");
  assert.equal(base.theme, "dark");
  assert.equal(base.counts.skills, 1);
  assert.equal(base.counts.extensions, 1);
  assert.ok(base.sizeBytes > 0);

  const own = byName.own;
  assert.equal(own.auth.kind, "own");
  assert.equal(own.models.kind, "shared");
});

test("enrichment flags the default and the running profile", () => {
  pm.setDefault("blank");
  const profiles = enrichAll(pm, { currentDir: join(profilesDir, "own") });
  const byName = Object.fromEntries(profiles.map((p) => [p.name, p]));
  assert.equal(byName.blank.isDefault, true);
  assert.equal(byName.own.isDefault, false);
  assert.equal(byName.own.current, true);
  assert.equal(byName.blank.current, false);
});

test("enrichProfile returns null for a vanished profile", () => {
  assert.equal(
    enrichProfile({ name: "ghost", path: join(profilesDir, "ghost") }, {}),
    null,
  );
});

test("enrichment reports problems for a hand-made incomplete profile", () => {
  const path = join(profilesDir, "handmade");
  mkdirSync(path, { recursive: true });
  const got = enrichProfile({ name: "handmade", path, isDefault: false }, {});
  assert.ok(got.problems.includes("missing settings.json"));
  assert.ok(got.problems.includes("no auth.json (pi login may fail)"));
  assert.ok(got.problems.includes("no models.json"));

  // Invalid settings.json is reported, not thrown.
  writeFileSync(join(path, "settings.json"), "{not json");
  const again = enrichProfile({ name: "handmade", path, isDefault: false }, {});
  assert.ok(again.problems.includes("settings.json is not valid JSON"));
  assert.deepEqual(readSettings(path), { __invalid: true });
});

test("nameValidationError mirrors ppi's rules with no side effects", () => {
  assert.equal(nameValidationError(ProfileManager, "fine-name.1_2", profilesDir), null);
  assert.ok(nameValidationError(ProfileManager, "", profilesDir), "empty is invalid");
  assert.ok(nameValidationError(ProfileManager, "-leading", profilesDir), "leading dash invalid");
  assert.ok(nameValidationError(ProfileManager, "has space", profilesDir), "space invalid");
  assert.ok(nameValidationError(ProfileManager, "no/slash", profilesDir), "slash invalid");
  assert.ok(
    nameValidationError(ProfileManager, "x".repeat(65), profilesDir),
    "over 64 chars invalid",
  );
  assert.ok(
    nameValidationError(ProfileManager, "blank", profilesDir),
    "existing name is rejected",
  );
  // Validating must not have created anything.
  assert.ok(!existsSync(join(profilesDir, "fine-name.1_2")));
});

test("ppi clears the default when the default profile is deleted", () => {
  assert.equal(pm.getDefault(), "blank");
  pm.delete("blank");
  assert.equal(pm.getDefault(), undefined);
  assert.ok(!existsSync(join(profilesDir, "blank")));
});

// Package (extension/skill/theme/prompt) management across all profiles.
//
// pi installs npm packages physically into `<agentDir>/npm/node_modules` —
// one full copy *per profile*. Installing the same package into N profiles
// therefore means N downloads and N copies of the same tree.
//
// ppi-tui eliminates that: it points every profile's `npm` dir at one shared
// physical install root (`~/.pi/shared/npm`, invisible to ppi because ppi only
// lists directories under `~/.pi/profiles/`). Each profile still keeps its own
// `settings.json` `packages` array, so which packages *load* is per-profile —
// only the bytes are shared. One `pi install` / `pi update` fetches and updates
// the shared tree once, no matter how many profiles there are.
//
// Rules/conventions:
//   * shared root lives OUTSIDE the profiles dir so `ppi list` never mistakes
//     it for a profile.
//   * Migration is one-way and idempotent: a real `npm` dir is merged into the
//     shared root and then replaced by a symlink. Already-shared profiles are
//     left alone.
//   * Auth/models/other settings are never touched — only the `packages` array
//     in each profile's settings.json and the `npm` symlink itself.

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readSettings } from "./profiles.js";

const noop = () => {};

/** The single physical install root shared by all profiles. */
export function sharedNpmDir(piRoot) {
  return join(piRoot, "shared", "npm");
}

/** Profiles as [{ name, path }], tolerating ppi listing dirs it cannot stat. */
export function listProfiles(pm) {
  return (pm?.list?.() ?? []).map((p) => ({ name: p.name, path: p.path }));
}

/** Describe one profile's `npm` entry without mutating it. */
export function npmSharingInfo(profilePath) {
  const p = join(profilePath, "npm");
  if (!existsSync(p)) return { kind: "missing", path: p, target: undefined };
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      return { kind: "symlink", path: p, target: readlinkSync(p) };
    }
  } catch {
    /* fall through to dir */
  }
  return { kind: "dir", path: p, target: undefined };
}

function realpathOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Point every profile's `npm` at the shared root.
 *
 *   - missing  -> create shared root + symlink the profile to it
 *   - symlink already to shared root -> left alone
 *   - symlink elsewhere -> warned, untouched (never overrides a user choice)
 *   - real dir -> merged into the shared root, then the dir is replaced by a
 *     symlink (first profile's tree is moved wholesale; later ones merge with
 *     "existing wins", which is safe because npm trees overlap).
 *
 * Returns a report listing what happened. `dryRun` performs no writes.
 */
export function ensureSharedNpm(pm, { log = noop, dryRun = false } = {}) {
  const sharedRoot = sharedNpmDir(pm.piRoot);
  const sharedReal = realpathOr(sharedRoot);
  const profiles = listProfiles(pm);
  const report = {
    sharedRoot,
    shared: [],
    migrated: [],
    linked: [],
    warnings: [],
  };

  for (const prof of profiles) {
    const info = npmSharingInfo(prof.path);
    if (info.kind === "symlink") {
      const targetReal = realpathOr(info.path);
      if (sharedReal && targetReal && targetReal === sharedReal) {
        report.shared.push(prof.name);
      } else {
        report.warnings.push(
          `${prof.name}: npm symlink points elsewhere (${info.target}); leaving as-is`,
        );
      }
      continue;
    }

    if (info.kind === "missing") {
      if (!dryRun) {
        mkdirSync(sharedRoot, { recursive: true });
        symlinkSync(sharedRoot, info.path, "dir");
      }
      report.linked.push(prof.name);
      continue;
    }

    // Real directory.
    if (!dryRun) migrateNpmDir(info.path, sharedRoot, prof.name, report);
    report.migrated.push(prof.name);
  }

  return report;
}

/** Merge a real per-profile npm dir into the shared root, then symlink it. */
function migrateNpmDir(npmPath, sharedRoot, name, report) {
  if (!existsSync(sharedRoot)) {
    mkdirSync(dirname(sharedRoot), { recursive: true });
    renameSync(npmPath, sharedRoot);
  } else {
    for (const entry of readdirSync(npmPath)) {
      const src = join(npmPath, entry);
      const dst = join(sharedRoot, entry);
      if (existsSync(dst)) {
        report.warnings.push(`${name}: kept existing shared copy of ${entry}`);
        continue;
      }
      try {
        renameSync(src, dst);
      } catch (err) {
        report.warnings.push(`${name}: could not move ${entry}: ${err?.message ?? err}`);
      }
    }
    rmSync(npmPath, { recursive: true, force: true });
  }
  symlinkSync(sharedRoot, npmPath, "dir");
}

/* ------------------------------------------------------------------ *
 * settings.json `packages` array helpers
 * ------------------------------------------------------------------ */

/** Raw `packages` array (strings and/or { source } objects) from a profile. */
export function readPackages(profilePath) {
  const settings = readSettings(profilePath);
  return Array.isArray(settings.packages) ? settings.packages : [];
}

/** Persist settings.json, preserving the two-space style ppi uses. */
export function writeSettings(profilePath, settings) {
  writeFileSync(join(profilePath, "settings.json"), JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function packageSourceString(entry) {
  return typeof entry === "string" ? entry : entry && typeof entry.source === "string" ? entry.source : "";
}

/**
 * Add a package source to one profile's settings.json. Idempotent: a profile
 * that already lists it (as a string or an object) is left unchanged.
 * Returns true if the array actually changed.
 */
export function addPackageToProfile(profilePath, source) {
  const settings = readSettings(profilePath);
  if (settings.__invalid) {
    throw new Error(`Cannot edit ${join(profilePath, "settings.json")}: not valid JSON.`);
  }
  const norm = normalizeSource(source);
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  if (packages.some((e) => packageSourceString(e) === norm)) return false;
  settings.packages = [...packages, norm];
  writeSettings(profilePath, settings);
  return true;
}

/** Remove a package source from one profile. Returns true if it changed. */
export function removePackageFromProfile(profilePath, source) {
  const settings = readSettings(profilePath);
  if (settings.__invalid) {
    throw new Error(`Cannot edit ${join(profilePath, "settings.json")}: not valid JSON.`);
  }
  const norm = normalizeSource(source);
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const next = packages.filter((e) => packageSourceString(e) !== norm);
  if (next.length === packages.length) return false;
  settings.packages = next;
  writeSettings(profilePath, settings);
  return true;
}

/**
 * Tidy a user-typed source into a form pi accepts. pi requires an explicit
 * scheme (it treats a bare `foo` as a local path), so we auto-prepend `npm:`
 * to anything that is not already a recognized source or a local path.
 */
export function normalizeSource(source) {
  let s = String(source ?? "").trim();
  if (!s) return s;
  if (/^(npm|git|github|bitbucket|gitlab|https?):/i.test(s)) return s;
  if (/^[./~]/.test(s) || /^[A-Za-z]:[\\/]/.test(s)) return s; // local path
  return `npm:${s}`;
}

/* ------------------------------------------------------------------ *
 * Human summary for `ppi extensions list`
 * ------------------------------------------------------------------ */

/**
 * Read-only per-profile package summary. Never writes; reflects the current
 * sharing state (even if some profiles haven't been migrated yet).
 */
export function packageSharingSummaries(pm) {
  const sharedRoot = sharedNpmDir(pm.piRoot);
  const sharedReal = realpathOr(sharedRoot);
  return listProfiles(pm).map((prof) => {
    const info = npmSharingInfo(prof.path);
    let sharing;
    if (info.kind === "symlink") {
      const targetReal = realpathOr(info.path);
      sharing = sharedReal && targetReal && targetReal === sharedReal ? "shared" : "external";
    } else if (info.kind === "dir") {
      sharing = "local";
    } else {
      sharing = "missing";
    }
    return {
      name: prof.name,
      path: prof.path,
      sharing,
      packages: readPackages(prof.path),
    };
  });
}

/* ------------------------------------------------------------------ *
 * pi invocation
 * ------------------------------------------------------------------ */

const DEFAULT_PI_BIN = process.env.PI_BIN || "pi";

/**
 * Run a pi package command against one agent dir. Returns the exit code.
 * `agentDir` is passed via PI_CODING_AGENT_DIR so npm installs land in that
 * profile's `npm` dir — which points at the shared root after migration.
 */
export function makePiRunner({ binary = DEFAULT_PI_BIN, log = noop } = {}) {
  return function runPi(agentDir, args, { inherit = true, log: localLog } = {}) {
    const say = localLog || log;
    try {
      const res = spawnSync(binary, args, {
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        stdio: inherit ? "inherit" : "pipe",
        encoding: "utf8",
      });
      return res.status ?? (res.error ? 1 : 0);
    } catch (err) {
      say(`Failed to run ${binary}: ${err?.message ?? err}`);
      return 1;
    }
  };
}

function pickRepresentative(pm, profiles) {
  let def = null;
  try {
    def = typeof pm.getDefault === "function" ? pm.getDefault() : null;
  } catch {
    def = null;
  }
  return profiles.find((p) => p.name === def) || profiles[0];
}

/**
 * Install a package for every profile with a single physical install.
 *
 * 1. Migrate all profiles to the shared npm root (idempotent, once).
 * 2. Run `pi install <source>` exactly once, in the default profile, so the
 *    physical tree is fetched a single time into the shared root.
 * 3. Declare the source in every profile's settings.json so pi loads it.
 */
export function installExtensionForAll(
  pm,
  source,
  { run = makePiRunner(), log = noop } = {},
) {
  const profiles = listProfiles(pm);
  if (profiles.length === 0) throw new Error("No profiles found. Create one with `ppi create <name>` first.");
  const norm = normalizeSource(source);
  if (!norm) throw new Error("No package source given. Usage: extensions install <source>");

  const report = ensureSharedNpm(pm, { log });
  const rep = pickRepresentative(pm, profiles);

  log(`Installing ${norm} once (shared physical copy for ${profiles.length} profile).`);
  const code = run(rep.path, ["install", norm]);
  if (code !== 0) throw new Error(`pi install ${norm} failed (exit ${code}).`);

  const added = [];
  const already = [];
  for (const prof of profiles) {
    if (addPackageToProfile(prof.path, norm)) added.push(prof.name);
    else already.push(prof.name);
  }
  return { norm, report, added, already, profiles: profiles.map((p) => p.name) };
}

/**
 * Update packages across all profiles, again updating the shared physical
 * tree once. With `source` updates just that package; without it reconciles
 * everything (`pi update --extensions`).
 */
export function updateExtensionsForAll(
  pm,
  source,
  { run = makePiRunner(), log = noop } = {},
) {
  const profiles = listProfiles(pm);
  if (profiles.length === 0) throw new Error("No profiles found. Create one with `ppi create <name>` first.");
  ensureSharedNpm(pm, { log });

  const norm = source && String(source).trim() ? normalizeSource(source) : "";
  const args = norm ? ["update", norm] : ["update", "--extensions"];
  const rep = pickRepresentative(pm, profiles);

  log(
    `Updating ${norm ? `${norm} ` : "all extensions "}once (shared physical copy for ${profiles.length} profile).`,
  );
  const code = run(rep.path, args);
  if (code !== 0) throw new Error(`pi update failed (exit ${code}).`);
  return { norm, args, profiles: profiles.map((p) => p.name) };
}

/**
 * Remove a package from every profile's settings.json. Physical files in the
 * shared cache are left in place — safe, because another profile may still use
 * them, and re-adding is instant.
 */
export function removeExtensionFromAll(
  pm,
  source,
  { log = noop } = {},
) {
  const profiles = listProfiles(pm);
  if (profiles.length === 0) throw new Error("No profiles found.");
  const norm = normalizeSource(source);
  if (!norm) throw new Error("No package source given. Usage: extensions remove <source>");

  const removed = [];
  const missing = [];
  for (const prof of profiles) {
    if (removePackageFromProfile(prof.path, norm)) removed.push(prof.name);
    else missing.push(prof.name);
  }
  if (removed.length === 0) {
    log(`${norm} is not configured in any profile.`);
  }
  return { norm, removed, missing };
}

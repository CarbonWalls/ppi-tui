// One-command setup so a fresh clone (or a global npm install) just works.
//
// Two things can block a new machine from running ppi-tui:
//   1. `pi-profiles` is a peer dependency, so a bare `git clone` has no
//      node_modules and `loadProfileManagerCtor` falls back to scanning global
//      npm roots — which may be empty. We resolve it (symlink into local
//      node_modules if a global copy exists).
//   2. Tying up the `ppi` name. The tool is designed to *be* ppi, but the
//      original `pi-profiles` package also ships a `ppi` bin, so we never
//      declare a conflicting `ppi` in package.json. Instead `setup` creates the
//      `ppi` shim explicitly and backs up anything already occupying that name.
//
// Everything here is idempotent and never destroys a pre-existing install.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

const noop = () => {};

/* ------------------------------------------------------------------ *
 * 1. Ensure pi-profiles is resolvable
 * ------------------------------------------------------------------ */

function globalNpmRoot() {
  try {
    const res = spawnSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const root = (res.stdout || "").trim();
    return root || undefined;
  } catch {
    return undefined;
  }
}

/** Find a global install of pi-profiles, or undefined. */
export function findGlobalPiProfiles() {
  const root = globalNpmRoot();
  if (!root) return undefined;
  const p = join(root, "pi-profiles");
  return existsSync(p) ? p : undefined;
}

/** Install pi-profiles globally if it isn't anywhere, then return its path. */
export function installGlobalPiProfiles({ log = noop } = {}) {
  log("Installing pi-profiles globally... (one-time, it's a peer dependency)");
  const res = spawnSync(
    "npm",
    ["install", "-g", "--no-fund", "--no-audit", "pi-profiles"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (res.error) {
    throw new Error(`Could not run npm install -g pi-profiles: ${res.error.message}`);
  }
  const found = findGlobalPiProfiles();
  if (!found) {
    throw new Error(
      `pi-profiles should now be installed but was not found. \n${(res.stderr || res.stdout || "").trim()}`,
    );
  }
  return found;
}

/**
 * Make pi-profiles resolvable from a local checkout by symlinking it into the
 * project's node_modules when a global copy exists.
 *
 * Returns { status: 'ok'|'linked'|'installed'|'error', path?, error? }.
 * - ok        -> already resolvable from the project
 * - linked    -> symlinked a global copy into the project's node_modules
 * - installed -> world had no pi-profiles, so we installed it globally + linked
 * - error     -> installation failed
 */
export function ensurePiProfiles(projectRoot, { log = noop } = {}) {
  const nodeModules = join(projectRoot, "node_modules");
  const local = join(nodeModules, "pi-profiles");
  if (existsSync(local)) return { status: "ok", path: local };

  let globalPath = findGlobalPiProfiles();
  if (!globalPath) {
    try {
      globalPath = installGlobalPiProfiles({ log });
    } catch (err) {
      return { status: "error", error: err.message };
    }
    const linked = tryLinkPiProfiles(nodeModules, globalPath, log);
    return { status: "installed", path: globalPath, linked };
  }

  const linked = tryLinkPiProfiles(nodeModules, globalPath, log);
  return { status: linked ? "linked" : "ok", path: globalPath };
}

function tryLinkPiProfiles(nodeModules, globalPath, log) {
  const local = join(nodeModules, "pi-profiles");
  if (existsSync(local)) return false;
  mkdirSync(nodeModules, { recursive: true });
  symlinkSync(globalPath, local, "dir");
  log(`Linked pi-profiles -> ${globalPath}`);
  return true;
}

/* ------------------------------------------------------------------ *
 * 2. Create the `ppi` shim (take over the ppi command)
 * ------------------------------------------------------------------ */

/**
 * The npm global bin dir.
 *
 * Best guess first, no subprocesses: the running node's own bin dir. That is
 * exactly where global bins land for nvm (`<nvm>/versions/node/vX/bin`),
 * homebrew (`/usr/local/bin`) and distro (`/usr/bin`) installs. `npm root -g`
 * is authoritative but `npm bin` was removed in npm 11, so we fall back to
 * `npm root -g`'s sibling `bin`, then the installed-package script path, then
 * a conventional default.
 */
export function defaultBinDir(scriptPath) {
  try {
    const bin = dirname(process.execPath);
    if (bin) return bin;
  } catch {
    /* execPath unavailable */
  }
  try {
    const res = spawnSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const root = (res.stdout || "").trim();
    if (root) return join(root, "..", "bin");
  } catch {
    /* fall through */
  }
  const m = String(scriptPath ?? "").match(/(^.*[\\/]node_modules[\\/])[^\\/]+[\\/]bin[\\/][^\\/]+$/);
  if (m) return join(m[1], "bin");
  return "/usr/local/bin";
}

/** Where this script itself lives (the ppi-tui entrypoint that the shim points at). */
export function selfBinPath() {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return process.argv[1];
  }
}

/**
 * Point the `ppi` command at ppi-tui's own bin, backing up anything already
 * occupying that name. Idempotent: if `ppi` already points at ppi-tui, it's a
 * no-op.
 *
 * Returns { status: 'ok'|'linked'|'backedUpLink'|'error', path?, backedUp?, error? }.
 * - ok           -> `ppi` already was this tool
 * - linked       -> created a fresh `ppi` shim
 * - backedUpLink -> renamed an existing `ppi` to `<dir>/ppi.<tool>.bak`, then linked
 * - error        -> `ppi` is a real file we won't touch; old component not a symlink
 */
export function ensurePpiShim(binDir, target, { log = noop } = {}) {
  const ppiPath = join(binDir, "ppi");
  mkdirSync(binDir, { recursive: true });

  let existing = null;
  let isLink = false;
  if (existsSync(ppiPath)) {
    try {
      isLink = lstatSync(ppiPath).isSymbolicLink();
      existing = isLink ? readlinkSync(ppiPath) : "file";
    } catch {
      existing = "file";
    }
    // Already points at ppi-tui -> nothing to do.
    if (isLink && existsSync(target) && readlinkSync(ppiPath) === target) {
      return { status: "ok", path: ppiPath };
    }
  }

  if (existing !== null && !isLink) {
    return {
      status: "error",
      path: ppiPath,
      error: `${ppiPath} is a real file; refusing to replace it. Remove it or point it at ppi-tui yourself.`,
    };
  }

  let backedUp = undefined;
  if (existing !== null && isLink) {
    const bak = `${ppiPath}.orig.bak`;
    if (!existsSync(bak)) {
      renameSync(ppiPath, bak);
      backedUp = bak;
      log(`Backed up existing ppi -> ${bak}`);
    }
  }

  symlinkSync(target, ppiPath, "file");
  log(`Linked ${ppiPath} -> ${target}`);
  return { status: backedUp ? "backedUpLink" : "linked", path: ppiPath, backedUp };
}

/** Full setup: resolve pi-profiles and (optionally) create the ppi shim. */
export function setup({ projectRoot, binDir = defaultBinDir(selfBinPath()), target = selfBinPath(), makeShim = true, log = noop }) {
  const piResult = ensurePiProfiles(projectRoot, { log });
  if (piResult.status === "error") {
    return { ok: false, pi: piResult, shim: undefined };
  }
  if (!makeShim) {
    return { ok: true, pi: piResult, shim: undefined };
  }
  const shim = ensurePpiShim(binDir, target, { log });
  return {
    ok: shim.status !== "error",
    pi: piResult,
    shim,
    binDir,
  };
}

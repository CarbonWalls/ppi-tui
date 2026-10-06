// Profile layer.
//
// This is where ppi-tui builds *on top of* ppi (pi-profiles): every mutating
// operation is delegated to ppi's own `ProfileManager` class, imported from the
// installed package. ppi-tui never reimplements profile logic and never touches
// ppi's files — it only calls the documented library API.
//
// On top of that we add a read-only "enrichment" pass that gathers the display
// details ppi itself does not surface (settings summary, dir sizes, symlink
// status, counts). Enrichment is pure filesystem reading; it never writes.

import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { humanSize, timeLabel } from "./strutil.js";

const KNOWN_COUNT_DIRS = ["extensions", "skills", "tools", "prompts"];

/** Resolve ppi's ProfileManager constructor from wherever it is installed. */
export async function loadProfileManagerCtor() {
  // 1) Bare specifier — works when pi-profiles is a local dependency or a
  //    node_modules symlink into the global install.
  try {
    const mod = await import("pi-profiles");
    if (mod?.ProfileManager) return mod.ProfileManager;
  } catch {
    /* fall through to global lookup */
  }

  // 2) Global npm roots, in install order of preference.
  const roots = [];
  try {
    roots.push(execSync("npm root -g", { encoding: "utf8" }).trim());
  } catch {
    /* npm unavailable */
  }
  if (process.platform === "win32") {
    roots.push(join(process.env.APPDATA ?? "", "npm", "node_modules"));
  } else {
    roots.push("/usr/local/lib/node_modules", "/usr/lib/node_modules");
  }
  const home = homedir();
  roots.push(join(home, ".npm-global", "lib", "node_modules"));
  roots.push(join(home, ".local", "share", "npm", "lib", "node_modules"));

  const seen = new Set();
  for (const root of roots) {
    if (!root || seen.has(root)) continue;
    seen.add(root);
    const pkgPath = join(root, "pi-profiles");
    if (!existsSync(pkgPath)) continue;
    try {
      const mod = await import(pathToFileURL(join(pkgPath, "dist", "src", "index.js")).href);
      if (mod?.ProfileManager) return mod.ProfileManager;
    } catch {
      /* keep trying */
    }
  }

  throw new Error(
    "pi-profiles (ppi) not found. Install it first: npm install -g pi-profiles",
  );
}

/**
 * Construct a ProfileManager with the same root resolution ppi itself uses:
 * the PPI_PI_ROOT env var wins, then ~/.pi.
 */
export function makeProfileManager(ProfileManager) {
  return new ProfileManager(process.env.PPI_PI_ROOT);
}

/** Read and parse a profile's settings.json (never throws). */
export function readSettings(profilePath) {
  const p = join(profilePath, "settings.json");
  if (!existsSync(p)) return {};
  try {
    const data = JSON.parse(readFileSync(p, "utf-8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return { __invalid: true };
  }
}

function symlinkInfo(profilePath, file) {
  const p = join(profilePath, file);
  if (!existsSync(p)) return { kind: "missing", target: undefined };
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      return { kind: "shared", target: readlinkSync(p) };
    }
  } catch {
    /* treat as own */
  }
  return { kind: "own", target: undefined };
}

function countEntries(dir) {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith(".")).length;
  } catch {
    return 0;
  }
}

function countFilesRecursive(dir, depth = 0) {
  if (!existsSync(dir) || depth > 4) return 0;
  let n = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        n += countFilesRecursive(p, depth + 1);
      } else if (entry.isFile()) {
        n += 1;
      }
    }
  } catch {
    /* unreadable */
  }
  return n;
}

function dirSize(dir, depth = 0) {
  if (!existsSync(dir) || depth > 6) return 0;
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const p = join(dir, entry.name);
      // lstat on the entry itself: symlinks count as their link size only, so
      // auth/models shared with the base profile are not double-counted.
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        total += st.size;
      } else if (st.isDirectory()) {
        total += dirSize(p, depth + 1);
      } else {
        total += st.size;
      }
    }
  } catch {
    /* unreadable */
  }
  return total;
}

function dirMtime(dir) {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Gather display details for one profile entry from `pm.list()`.
 * Returns `null` when the profile vanished (e.g. deleted in another shell).
 */
export function enrichProfile(entry, { agentDir, currentDir } = {}) {
  if (!entry || !existsSync(entry.path)) return null;

  const settings = readSettings(entry.path);
  const packages = Array.isArray(settings.packages) ? settings.packages : [];

  const counts = {};
  for (const d of KNOWN_COUNT_DIRS) counts[d] = countEntries(join(entry.path, d));
  counts.sessions = countFilesRecursive(join(entry.path, "sessions"));

  const sizeBytes = dirSize(entry.path);
  const mtimeMs = dirMtime(entry.path);
  const auth = symlinkInfo(entry.path, "auth.json");
  const models = symlinkInfo(entry.path, "models.json");

  const problems = [];
  if (!existsSync(join(entry.path, "settings.json"))) problems.push("missing settings.json");
  if (auth.kind === "missing") problems.push("no auth.json (pi login may fail)");
  if (models.kind === "missing") problems.push("no models.json");
  if (settings.__invalid) problems.push("settings.json is not valid JSON");

  return {
    ...entry,
    current: Boolean(currentDir && samePath(currentDir, entry.path)),
    settings,
    model: settings.defaultModel,
    provider: settings.defaultProvider,
    theme: settings.theme,
    tuiMode: settings.tuiMode,
    packageCount: packages.length,
    packages,
    auth,
    models,
    counts,
    sizeBytes,
    sizeLabel: humanSize(sizeBytes),
    mtimeMs,
    mtimeLabel: timeLabel(mtimeMs),
    problems,
  };
}

function samePath(a, b) {
  try {
    return statSync(a).ino === statSync(b).ino;
  } catch {
    return a === b;
  }
}

/** Enrich ppi's profile list, skipping anything that no longer exists. */
export function enrichAll(pm, { currentDir } = {}) {
  const agentDir = pm.agentDir;
  return pm
    .list()
    .map((entry) => enrichProfile(entry, { agentDir, currentDir }))
    .filter((p) => p !== null);
}

/**
 * Validate a candidate profile name *without side effects*.
 *
 * Prefers ppi's own `validateName` so we track ppi's exact rules; falls back
 * to a mirror of ppi's documented rule (regex + 64-char cap) for builds where
 * the method is not reachable. Never creates or writes anything.
 */
const FALLBACK_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const FALLBACK_MAX_NAME = 64;

export function nameValidationError(ProfileManager, name, profilesDir) {
  const pm = makeProfileManager(ProfileManager);
  const dir = profilesDir ?? pm.profilesDir;

  if (typeof pm.validateName === "function") {
    try {
      pm.validateName(name);
    } catch (err) {
      return err?.message ?? "Invalid profile name";
    }
  } else if (
    !name ||
    typeof name !== "string" ||
    name.length > FALLBACK_MAX_NAME ||
    !FALLBACK_NAME_RE.test(name)
  ) {
    return (
      `Invalid profile name "${name}". Names must match ${FALLBACK_NAME_RE} ` +
      `and be at most ${FALLBACK_MAX_NAME} characters.`
    );
  }

  if (existsSync(join(dir, name))) {
    return `A profile named "${name}" already exists.`;
  }
  return null;
}

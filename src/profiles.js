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
import { dirname, join } from "node:path";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Worker } from "node:worker_threads";
import { homedir } from "node:os";
import { humanSize, timeLabel } from "./strutil.js";

const KNOWN_COUNT_DIRS = ["extensions", "skills", "tools", "prompts"];

/**
 * Candidate global npm roots, cheapest-first and WITHOUT spawning a
 * subprocess. `npm root -g` is authoritative but slow (~100-400ms of node/npm
 * startup), so we probe roots we can derive for free first:
 *
 *   - our own node's sibling `lib/node_modules` (covers nvm, homebrew, and
 *     most `npm install -g` prefixes, where node's `execPath` lives under
 *     `<prefix>/bin`);
 *   - the npm prefix env vars (`npm_config_prefix` is what npm itself reads);
 *   - the well-known global locations.
 *
 * These cover the overwhelmingly common install layouts. If none of them has
 * pi-profiles we fall back to running `npm root -g` once, so exotic prefixes
 * still work — just at the cost of the spawn.
 */
export function globalNpmRootCandidates() {
  const roots = [];
  const add = (r) => {
    if (r && !roots.includes(r)) roots.push(r);
  };

  // Derived from the running node binary: `<prefix>/bin/node` -> `<prefix>/lib/node_modules`.
  try {
    const binDir = dirname(process.execPath);
    add(join(dirname(binDir), "lib", "node_modules"));
  } catch {
    /* execPath unavailable */
  }

  // npm's own prefix env vars (npm_config_prefix wins; PREFIX is the classic).
  for (const key of ["npm_config_prefix", "NPM_CONFIG_PREFIX", "PREFIX"]) {
    const prefix = process.env[key];
    if (prefix) add(join(prefix, "lib", "node_modules"));
  }

  const home = homedir();
  if (process.platform === "win32") {
    add(join(process.env.APPDATA ?? "", "npm", "node_modules"));
  } else {
    add("/usr/local/lib/node_modules", "/usr/lib/node_modules");
  }
  add(join(home, ".npm-global", "lib", "node_modules"));
  add(join(home, ".local", "share", "npm", "lib", "node_modules"));
  return roots;
}

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

  // 2) Global npm roots. Try the no-subprocess candidates first; only if none
  //    of them carries pi-profiles do we pay for `npm root -g`.
  let mod = await tryRoots(globalNpmRootCandidates());
  if (mod) return mod;

  try {
    const npmRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
    if (npmRoot) mod = await tryRoots([npmRoot]);
  } catch {
    /* npm unavailable */
  }
  if (mod) return mod;

  throw new Error(
    "pi-profiles (ppi) not found. Install it first: npm install -g pi-profiles",
  );
}

/** Import ProfileManager from the first root that actually contains it. */
async function tryRoots(roots) {
  const seen = new Set();
  for (const root of roots) {
    if (!root || seen.has(root)) continue;
    seen.add(root);
    const pkgPath = join(root, "pi-profiles");
    if (!existsSync(pkgPath)) continue;
    try {
      const m = await import(pathToFileURL(join(pkgPath, "dist", "src", "index.js")).href);
      if (m?.ProfileManager) return m.ProfileManager;
    } catch {
      /* keep trying */
    }
  }
  return null;
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

function dirMtime(dir) {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Byte-size measurement: worker thread + size cache layer
 * ------------------------------------------------------------------ */

const MAX_WALK_DEPTH = 6;

/**
 * Cheap on-disk fingerprint of a profile dir, used to decide whether a
 * previously measured size is still trustworthy. Three or four stat/readdir
 * syscalls — nothing like the full walk.
 */
function profileFingerprint(profilePath) {
  let topMtimeMs;
  let topCount;
  let settingsMtimeMs;
  try {
    topMtimeMs = statSync(profilePath).mtimeMs;
    topCount = readdirSync(profilePath).length;
  } catch {
    return null; // profile vanished — can't fingerprint, so don't cache
  }
  try {
    settingsMtimeMs = statSync(join(profilePath, "settings.json")).mtimeMs;
  } catch {
    settingsMtimeMs = -1; // no settings.json
  }
  return { topMtimeMs, topCount, settingsMtimeMs };
}

// Size cache: within the TTL, an unchanged profile (same fingerprint) reuses
// its measured size instead of re-walking tens of thousands of files. The file
// lives in our own cache dir (honouring PPI_TUI_CACHE_DIR / XDG_CACHE_HOME),
// never inside ~/.pi — ppi-tui doesn't write to ppi's tree.
const SIZE_CACHE_VERSION = 1;
const SIZE_CACHE_TTL_MS = 60_000;

function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function sizeCacheDir() {
  return (
    process.env.PPI_TUI_CACHE_DIR ||
    (process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? "", "ppi-tui")
      : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ppi-tui"))
  );
}

function sizeCachePath() {
  return join(sizeCacheDir(), `sizes-${hashString(process.env.PPI_PI_ROOT || "root")}.json`);
}

let sizeCache = null;
let sizeCacheFlush = null;

function loadSizeCache() {
  if (sizeCache) return sizeCache;
  const data = { version: SIZE_CACHE_VERSION, profiles: {} };
  try {
    const raw = JSON.parse(readFileSync(sizeCachePath(), "utf8"));
    if (raw && raw.version === SIZE_CACHE_VERSION && raw.profiles && typeof raw.profiles === "object") {
      data.profiles = raw.profiles;
    }
  } catch {
    /* missing or corrupt — start empty */
  }
  sizeCache = data;
  return data;
}

/** Best-effort, debounced, atomic-ish cache write (tmp + rename). */
function scheduleSizeCacheFlush() {
  if (sizeCacheFlush) return;
  sizeCacheFlush = setImmediate(() => {
    sizeCacheFlush = null;
    try {
      const file = sizeCachePath();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + ".tmp", JSON.stringify(sizeCache ?? { version: SIZE_CACHE_VERSION, profiles: {} }), "utf8");
      renameSync(file + ".tmp", file);
    } catch {
      /* cache is best-effort; never block the app on it */
    }
  });
}

function readSizeCache(profilePath) {
  const fp = profileFingerprint(profilePath);
  if (!fp) return null;
  const entry = loadSizeCache().profiles[profilePath];
  if (!entry || entry.version !== SIZE_CACHE_VERSION) return null;
  if (
    entry.topMtimeMs !== fp.topMtimeMs ||
    entry.topCount !== fp.topCount ||
    entry.settingsMtimeMs !== fp.settingsMtimeMs
  ) {
    return null;
  }
  if (Date.now() - entry.recordedAt > SIZE_CACHE_TTL_MS) return null;
  return { sizeBytes: entry.sizeBytes, mtimeMs: entry.mtimeMs };
}

function putSizeCache(profilePath, { sizeBytes, mtimeMs }) {
  const fp = profileFingerprint(profilePath);
  if (!fp) return;
  loadSizeCache().profiles[profilePath] = {
    version: SIZE_CACHE_VERSION,
    sizeBytes,
    mtimeMs,
    ...fp,
    recordedAt: Date.now(),
  };
  scheduleSizeCacheFlush();
}

/** Cooperative in-process walk (fallback when worker threads are unavailable). */
async function walkCooperative(profilePath, stopped) {
  let total = 0;
  const stack = [[profilePath, 0]];
  while (stack.length > 0) {
    const [dir, depth] = stack.pop();
    if (depth > MAX_WALK_DEPTH) continue;
    if (stopped()) return { sizeBytes: undefined, mtimeMs: undefined, aborted: true };
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const p = join(dir, entry.name);
        // lstat on the entry itself: symlinks count as their link size only, so
        // auth/models shared with the base profile are not double-counted.
        const st = lstatSync(p);
        if (st.isSymbolicLink()) total += st.size;
        else if (st.isDirectory()) stack.push([p, depth + 1]);
        else total += st.size;
      }
    } catch {
      /* unreadable */
    }
    // Yield between directories so a fallback walk never freezes the UI.
    await new Promise((r) => setImmediate(r));
  }
  return { sizeBytes: total, mtimeMs: dirMtime(profilePath), aborted: false };
}

/**
 * Measure one profile dir's byte size and mtime, off the main thread.
 *
 * The walk is syscall-bound (one lstat per entry — tens of thousands on a big
 * profile), so it runs on a dedicated worker thread: the UI keeps rendering
 * and answering keys with zero contention, and several profiles can be
 * measured concurrently. If workers are unavailable it falls back to a
 * cooperative in-process loop that yields between directories.
 *
 * A size-cache layer lets an *unchanged* profile (same cheap fingerprint within
 * the TTL) skip the walk entirely; pass `force: true` to bypass it.
 *
 * Returns a thenable with a `cancel` method that terminates an in-flight walk.
 * Resolves `{ sizeBytes, mtimeMs, aborted, cache }`, where `cache` is
 * "hit" | "worker" | "walk" | "none".
 */
export function measureProfile(profilePath, { shouldStop, force = false } = {}) {
  const stopped = () => typeof shouldStop === "function" && shouldStop();
  let worker = null;
  let poll = null;
  let finished = false;
  let fallbackStarted = false;
  let resolveResult;

  const settled = (result) => {
    if (finished) return;
    finished = true;
    if (poll) clearImmediate(poll);
    resolveResult(result);
  };

  // Fallback used when the worker cannot start or fails mid-walk. Runs once;
  // `settled` guards against any error/exit racing this with a message.
  async function cooperative() {
    const r = await walkCooperative(profilePath, stopped);
    if (!r.aborted) putSizeCache(profilePath, r);
    return { ...r, cache: r.aborted ? "none" : "walk" };
  }
  const fallback = () => {
    if (fallbackStarted) return;
    fallbackStarted = true;
    cooperative().then(settled);
  };

  const p = new Promise((resolve) => {
    resolveResult = resolve;

    // Bail straight away if the caller is already tearing down.
    if (stopped()) {
      settled({ sizeBytes: undefined, mtimeMs: undefined, aborted: true, cache: "none" });
      return;
    }

    if (!force) {
      const hit = readSizeCache(profilePath);
      if (hit && !stopped()) {
        settled({ sizeBytes: hit.sizeBytes, mtimeMs: hit.mtimeMs, aborted: false, cache: "hit" });
        return;
      }
    }

    try {
      worker = new Worker(new URL("./size-worker.js", import.meta.url), { type: "module" });
    } catch {
      worker = null;
    }

    if (!worker) {
      fallback();
      return;
    }

    worker.once("message", (m) => {
      if (finished) return;
      if (!m || typeof m.sizeBytes !== "number") return fallback();
      const r = { sizeBytes: m.sizeBytes, mtimeMs: m.mtimeMs, aborted: false };
      putSizeCache(profilePath, r);
      settled({ ...r, cache: "worker" });
    });
    worker.once("error", fallback);
    worker.once("exit", () => {
      if (!finished) fallback();
    });
    worker.postMessage(profilePath);

    // Poll the caller's stop flag from the main thread; a setImmediate chain is
    // cheaper than a timer and drains cleanly once the result lands.
    poll = setImmediate(function pump() {
      if (finished) return;
      if (stopped()) return abort();
      poll = setImmediate(pump);
    });
  });

  const abort = () => {
    if (finished) return;
    if (worker) {
      try {
        worker.terminate();
      } catch {
        /* already gone */
      }
    }
    settled({ sizeBytes: undefined, mtimeMs: undefined, aborted: true, cache: "none" });
  };
  p.cancel = abort;
  return p;
}

/**
 * Gather display details for one profile entry from `pm.list()`.
 * Returns `null` when the profile vanished (e.g. deleted in another shell).
 *
 * Sizes and mtimes are intentionally NOT computed here: walking a large
 * profile for its byte size costs tens of thousands of `lstatSync` calls and
 * dominates load time. Callers that want those numbers should follow up with
 * `measureProfile()` per profile and patch the results in.
 */
export function enrichProfile(entry, { agentDir, currentDir } = {}) {
  if (!entry || !existsSync(entry.path)) return null;

  const settings = readSettings(entry.path);
  const packages = Array.isArray(settings.packages) ? settings.packages : [];

  const counts = {};
  for (const d of KNOWN_COUNT_DIRS) counts[d] = countEntries(join(entry.path, d));
  counts.sessions = countFilesRecursive(join(entry.path, "sessions"));

  const sizeBytes = undefined;
  const mtimeMs = undefined;
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

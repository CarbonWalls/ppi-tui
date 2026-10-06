// Command line entrypoint: argument parsing, ppi-style subcommands, a
// non-interactive listing fallback, and the TUI.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { loadProfileManagerCtor, makeProfileManager } from "./profiles.js";
import { launchPi } from "./launch.js";
import { runTui } from "./tui.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The name this tool was invoked as.
 *
 * The same binary may be reached as `ppi` (the global symlink), `ppi-tui`
 * (the package bin) or `node ./bin/ppi-tui.js`. Help and usage strings should
 * always show the name the user actually typed, so they can copy-paste the
 * examples straight back into the shell.
 */
function programName() {
  const arg = process.argv[1] || "";
  const base = basename(arg);
  if (base && base !== "node") return base.replace(/\.m?js$/i, "");
  return "ppi";
}

function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version ?? "";
  } catch {
    return "";
  }
}

function printHelp() {
  const v = packageVersion();
  const p = programName();
  console.log(`${p} ${v} — interactive profile manager for ppi (pi-profiles)

Usage:
  ${p}                                     Interactive profile browser (default)
  ${p} [use] <name> [-- <pi args...>]      Launch pi with <name> directly
  ${p} list                                Print profiles (no TUI required)
  ${p} create <name> [options]             Create a profile without the TUI
  ${p} delete <name> [--force]             Delete a profile without the TUI
  ${p} set-default <name>                  Set the default profile
  ${p} help                                Show this message

Create options:
  --from <profile>                            Copy from an existing profile
  --from-base                                 Copy from the stock pi config
  --own-auth                                  Independent auth (copy, not symlink)
  --own-models                                Independent models (copy, not symlink)

In the TUI:
  arrows/j,k  move        enter / u  launch pi with the profile
  d           set default n / c      create a profile
  D / x       delete      r          refresh
  ?           help        q / esc    quit

Options:
  --no-color   Disable colour output
  --help, -h   Show this message
  --version,-v Print the version

Anything after a bare "--" is passed to pi when a profile is launched, e.g.
  ${p} use work -- -p "fix the bug"`);
}

function die(msg) {
  console.error(msg);
  console.error("Run `" + programName() + " help` for usage.");
  process.exitCode = 1;
}

/** Interactive y/N confirmation, mirroring ppi's own delete prompt. */
function confirm(message) {
  return new Promise((resolve) => {
    let raw = "";
    const onData = (chunk) => {
      raw += chunk.toString("utf8");
      // Resolve as soon as we see Enter, without echoing the prompt twice.
      if (raw.includes("\r") || raw.includes("\n")) {
        process.stdin.removeListener("data", onData);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve(raw.trim().toLowerCase().startsWith("y"));
      }
    };
    process.stdout.write(message);
    process.stdin.resume();
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on("data", onData);
  });
}

const MUTATING_SUBS = ["create", "delete", "set-default"];

function parseArgs(args) {
  const dash = args.indexOf("--");
  const own = dash === -1 ? args : args.slice(0, dash);
  const piArgs = dash === -1 ? [] : args.slice(dash + 1);

  const flags = { noColor: false, help: false, version: false, list: false, force: false };
  const createOpts = { from: undefined, fromBase: false, ownAuth: false, ownModels: false };
  const positionals = [];
  let subcommand = null;
  const SUBS = ["use", "list", "ls", "help", ...MUTATING_SUBS];
  const CREATE_FLAGS = new Set(["--from", "--from-base", "--own-auth", "--own-models"]);

  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a === "-h" || a === "--help") flags.help = true;
    else if (a === "-v" || a === "--version") flags.version = true;
    else if (a === "--no-color") flags.noColor = true;
    else if (a === "--list" || a === "--ls") flags.list = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--from") {
      const next = own[i + 1];
      if (!next || next.startsWith("-")) throw new Error("--from requires a profile name");
      createOpts.from = next;
      i++;
    } else if (a === "--from-base") createOpts.fromBase = true;
    else if (a === "--own-auth") createOpts.ownAuth = true;
    else if (a === "--own-models") createOpts.ownModels = true;
    else if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
    else if (i === 0 && SUBS.includes(a)) subcommand = a === "ls" ? "list" : a;
    else positionals.push(a);
  }

  return { flags, positionals, piArgs, subcommand, createOpts };
}

/** Plain-text listing for pipes and non-TTY use (no ANSI escapes). */
function printListing(profiles, { rootLabel }) {
  if (profiles.length === 0) {
    console.log(`No profiles found under ${rootLabel}. Create one with \`ppi create <name>\`.`);
    return;
  }
  console.log(`Profiles under ${rootLabel} (* = default, ● = current pi session):\n`);
  const nameW = Math.max(6, ...profiles.map((p) => p.name.length));
  for (const p of profiles) {
    const star = p.isDefault ? "*" : " ";
    const cur = p.current ? "●" : " ";
    const model = p.model ? p.model.padEnd(18) : "—".padEnd(18);
    const size = (p.sizeLabel ?? "—").padEnd(9);
    const cnt = p.counts;
    const bits = [
      cnt.extensions ? `${cnt.extensions} ext` : null,
      cnt.skills ? `${cnt.skills} skill${cnt.skills === 1 ? "" : "s"}` : null,
      cnt.tools ? `${cnt.tools} tool${cnt.tools === 1 ? "" : "s"}` : null,
      cnt.prompts ? `${cnt.prompts} prompt${cnt.prompts === 1 ? "" : "s"}` : null,
      `${cnt.sessions} session${cnt.sessions === 1 ? "" : "s"}`,
    ]
      .filter(Boolean)
      .join(" · ");
    console.log(`${star} ${p.name.padEnd(nameW)} ${cur} ${model} ${size} ${bits}`);
    const links = [
      p.auth.kind === "shared" ? "auth shared" : p.auth.kind === "own" ? "auth own" : "auth missing",
      p.models.kind === "shared"
        ? "models shared"
        : p.models.kind === "own"
          ? "models own"
          : "models missing",
    ].join(" · ");
    console.log(`${" ".repeat(nameW + 6)}${links}   ${p.path}`);
    for (const problem of p.problems) {
      console.log(`${" ".repeat(nameW + 6)}! ${problem}`);
    }
  }
}

/** Create a profile without the TUI, mirroring `ppi create`. */
function cmdCreate(pm, positionals, opts) {
  const name = positionals[0];
  if (!name) {
    die(
      "Usage: " +
        programName() +
        " create <name> [--from <profile>] [--from-base] [--own-auth] [--own-models]",
    );
    return;
  }
  if (opts.from && opts.fromBase) {
    die("Cannot use both --from and --from-base.");
    return;
  }
  try {
    pm.create(name, {
      from: opts.from,
      fromBase: opts.fromBase,
      shareAuth: !opts.ownAuth,
      shareModels: !opts.ownModels,
    });
    const source = opts.from
      ? ` from "${opts.from}"`
      : opts.fromBase
        ? " from stock pi config"
        : "";
    console.log(`Created "${name}"${source} at ${pm.resolve(name).path}`);
  } catch (err) {
    die(err.message);
  }
}

/** Delete a profile without the TUI, mirroring `ppi delete`. */
async function cmdDelete(pm, positionals, flags) {
  const name = positionals[0];
  if (!name) {
    die("Usage: " + programName() + " delete <name> [--force]");
    return;
  }
  let profile;
  try {
    profile = pm.resolve(name);
  } catch (err) {
    die(err.message);
    return;
  }
  if (!flags.force) {
    if (!process.stdin.isTTY) {
      die(`Cannot confirm interactively. Use --force to delete non-interactively.`);
      return;
    }
    const yes = await confirm(`Delete profile "${name}" at ${profile.path}? This cannot be undone. [y/N] `);
    if (!yes) {
      console.log("Aborted.");
      return;
    }
  }
  try {
    pm.delete(name);
    console.log(`Profile "${name}" deleted.`);
  } catch (err) {
    die(err.message);
  }
}

/** Set the default profile without the TUI, mirroring `ppi set-default`. */
function cmdSetDefault(pm, positionals) {
  const name = positionals[0];
  if (!name) {
    die("Usage: " + programName() + " set-default <name>");
    return;
  }
  try {
    pm.setDefault(name);
    console.log(`Default profile set to "${name}".`);
  } catch (err) {
    die(err.message);
  }
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    die(err.message);
    return;
  }

  const { flags, positionals, piArgs, subcommand, createOpts } = parsed;

  if (flags.help || subcommand === "help") {
    printHelp();
    return;
  }
  if (flags.version) {
    console.log((programName() + " " + packageVersion()).trim());
    return;
  }

  const ProfileManager = await loadProfileManagerCtor();
  const pm = makeProfileManager(ProfileManager);
  const currentDir = process.env.PI_CODING_AGENT_DIR || null;

  // Non-interactive profile management, mirroring ppi's own subcommands.
  if (subcommand === "create") return cmdCreate(pm, positionals, createOpts);
  if (subcommand === "delete") return cmdDelete(pm, positionals, flags);
  if (subcommand === "set-default") return cmdSetDefault(pm, positionals);

  // Explicit listing, or automatic fallback when there is no terminal.
  const wantList =
    flags.list ||
    subcommand === "list" ||
    (!process.stdout.isTTY && positionals.length === 0);

  if (wantList) {
    // Imported lazily so the listing path stays cheap.
    const { enrichAll } = await import("./profiles.js");
    const profiles = enrichAll(pm, { currentDir });
    // Sizes are deliberately not computed here: walking a large profile for its
    // byte size costs tens of thousands of lstat calls and would dominate the
    // run. Use the TUI to see sizes — they load in the background there.
    const { shortPath } = await import("./render.js");
    printListing(profiles, { rootLabel: shortPath(pm.piRoot) + "/profiles" });
    return;
  }

  // Direct launch: `ppi use work` or `ppi work`.
  const directName = subcommand === "use" ? positionals[0] : positionals[0];
  if (directName) {
    try {
      const profile = pm.resolve(directName);
      launchPi(profile.path, piArgs);
      return;
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    const { enrichAll } = await import("./profiles.js");
    const profiles = enrichAll(pm, { currentDir });
    const { shortPath } = await import("./render.js");
    console.error("Not running in a terminal — showing the profile list instead.");
    printListing(profiles, { rootLabel: shortPath(pm.piRoot) + "/profiles" });
    return;
  }

  await runTui({
    ProfileManager,
    piArgs,
    noColor: flags.noColor,
    version: packageVersion(),
  });
}

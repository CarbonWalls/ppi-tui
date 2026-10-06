// Command line entrypoint: argument parsing, ppi-style subcommands, a
// non-interactive listing fallback, and the TUI.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadProfileManagerCtor, makeProfileManager } from "./profiles.js";
import { launchPi } from "./launch.js";
import { runTui } from "./tui.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version ?? "";
  } catch {
    return "";
  }
}

function printHelp() {
  const v = packageVersion();
  console.log(`ppi-tui ${v} — interactive profile manager for ppi (pi-profiles)

Usage:
  ppi-tui                                     Interactive profile browser (default)
  ppi-tui [use] <name> [-- <pi args...>]      Launch pi with <name> directly
  ppi-tui list                                Print profiles (no TUI required)
  ppi-tui help                                Show this message

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
  ppi-tui use work -- -p "fix the bug"`);
}

function parseArgs(args) {
  const dash = args.indexOf("--");
  const own = dash === -1 ? args : args.slice(0, dash);
  const piArgs = dash === -1 ? [] : args.slice(dash + 1);

  const flags = { noColor: false, help: false, version: false, list: false };
  const positionals = [];
  let subcommand = null;
  const SUBS = ["use", "list", "ls", "help"];

  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a === "-h" || a === "--help") flags.help = true;
    else if (a === "-v" || a === "--version") flags.version = true;
    else if (a === "--no-color") flags.noColor = true;
    else if (a === "--list" || a === "--ls") flags.list = true;
    else if (a.startsWith("-") && a !== "-") throw new Error(`Unknown option: ${a}`);
    else if (i === 0 && SUBS.includes(a)) subcommand = a === "ls" ? "list" : a;
    else positionals.push(a);
  }

  return { flags, positionals, piArgs, subcommand };
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

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error("Run `ppi-tui help` for usage.");
    process.exitCode = 1;
    return;
  }

  const { flags, positionals, piArgs, subcommand } = parsed;

  if (flags.help || subcommand === "help") {
    printHelp();
    return;
  }
  if (flags.version) {
    console.log(`ppi-tui ${packageVersion()}`.trim());
    return;
  }

  const ProfileManager = await loadProfileManagerCtor();
  const pm = makeProfileManager(ProfileManager);
  const currentDir = process.env.PI_CODING_AGENT_DIR || null;

  // Explicit listing, or automatic fallback when there is no terminal.
  const wantList =
    flags.list ||
    subcommand === "list" ||
    (!process.stdout.isTTY && positionals.length === 0);

  if (wantList) {
    // Imported lazily so the listing path stays cheap.
    const { enrichAll } = await import("./profiles.js");
    const profiles = enrichAll(pm, { currentDir });
    const { shortPath } = await import("./render.js");
    printListing(profiles, { rootLabel: shortPath(pm.piRoot) + "/profiles" });
    return;
  }

  // Direct launch: `ppi-tui use work` or `ppi-tui work`.
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

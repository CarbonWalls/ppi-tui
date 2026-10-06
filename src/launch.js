// Launch pi with a profile.
//
// This deliberately mirrors ppi's own launch.js behaviour: pi is spawned with
// PI_CODING_AGENT_DIR pointing at the profile and inherits stdio so the TUI
// renders directly through the same terminal.
//
// Signal handling is copied from ppi for a reason: SIGINT is delivered to the
// whole foreground process group when the child shares the parent's TTY, so
// forwarding it would double-signal pi. SIGTERM and SIGHUP target the parent
// specifically, so those get forwarded.

import { spawn } from "node:child_process";
import { constants } from "node:os";

export function launchPi(profilePath, piArgs, { onExit } = {}) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: profilePath };
  const child = spawn("pi", piArgs, { env, stdio: "inherit" });

  for (const sig of ["SIGTERM", "SIGHUP"]) {
    process.on(sig, () => child.kill(sig));
  }

  child.on("error", (err) => {
    if (err.code === "ENOENT") {
      console.error("pi not found. Install from https://pi.dev");
      process.exit(1);
    }
    throw err;
  });

  child.on("exit", (code, signal) => {
    if (code !== null) {
      if (onExit) onExit(code);
      process.exit(code);
    }
    const sigNum = signal ? (constants.signals[signal] ?? 1) : 1;
    if (onExit) onExit(128 + sigNum);
    process.exit(128 + sigNum);
  });

  return child;
}

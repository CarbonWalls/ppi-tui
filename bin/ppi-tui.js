#!/usr/bin/env node
// ppi-tui — interactive terminal UI for ppi (pi-profiles).
// Thin entrypoint; all logic lives in ../src/cli.js so the app is testable
// without spawning a process.
import { main } from "../src/cli.js";

main(process.argv.slice(2)).catch((err) => {
  console.error(err?.message ? err.message : String(err));
  process.exit(1);
});

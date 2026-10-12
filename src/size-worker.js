// Size-measurement worker thread.
//
// `measureProfile` (in profiles.js) can be by far the most expensive part of a
// run: walking a large profile's file tree for its byte size costs one lstat
// per entry (tens of thousands on a big profile) and is syscall-bound. Spawning
// that walk on a dedicated thread keeps it fully off the event loop — the TUI
// keeps rendering and answering keys with zero contention — and lets several
// profiles be measured concurrently instead of one-at-a-time.
//
// The worker mirrors measureProfile's exact walk semantics:
//   * dotfiles are skipped;
//   * depth is capped (sane for a settings/extension/session tree);
//   * symlinks count their own link size only, never the target's — so a
//     profile sharing auth/models (or its npm dir) with the stock config is
//     not double-counted.
//
// Protocol: receive the profile path on the message port, return
// { sizeBytes, mtimeMs } once the walk completes, then close the port so the
// thread exits.

import { parentPort } from "node:worker_threads";
import { readdirSync, lstatSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_WALK_DEPTH = 6;

/** Synchronous, depth-capped size walk. Returns { sizeBytes, mtimeMs }. */
function walkSize(rootPath) {
  let total = 0;
  const stack = [[rootPath, 0]];

  while (stack.length > 0) {
    const [dir, depth] = stack.pop();
    if (depth > MAX_WALK_DEPTH) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const p = join(dir, entry.name);
        // lstat the entry itself: symlinks count as their link size only, so
        // shared auth/models and npm dirs are never double-counted.
        const st = lstatSync(p);
        if (st.isSymbolicLink()) {
          total += st.size;
        } else if (st.isDirectory()) {
          stack.push([p, depth + 1]);
        } else {
          total += st.size;
        }
      }
    } catch {
      /* unreadable directory — skip */
    }
  }

  let mtimeMs;
  try {
    mtimeMs = statSync(rootPath).mtimeMs;
  } catch {
    mtimeMs = undefined;
  }
  return { sizeBytes: total, mtimeMs };
}

parentPort.on("message", (rootPath) => {
  const result = walkSize(rootPath);
  parentPort.postMessage(result);
  parentPort.close(); // let the thread exit once the main thread has the result
});

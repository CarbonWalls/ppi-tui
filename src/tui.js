// The app: a pure reducer over key events plus the terminal runtime that
// drives it.
//
// `reduce(state, key, api)` holds every interaction rule and owns no I/O of its
// own — profile mutations go through `api`, which the tests replace with an
// in-memory double. `runTui()` is the thin runtime: terminal setup, render on
// input and resize, and handing the terminal over to pi when a profile is
// launched.

import { isSymbolicKey, keys } from "./keys.js";
import { createPainter, Terminal } from "./term.js";
import { bodyHeight, renderFrame, shortPath } from "./render.js";
import { enrichAll, makeProfileManager, nameValidationError } from "./profiles.js";
import { launchPi } from "./launch.js";

const MAX_NAME = 64;
const NAME_CHARS = /[A-Za-z0-9._-]/;

/* --------------------------------------------------------------------- api */

/** Operations the reducer may perform, bound to a real ppi ProfileManager. */
export function createApi(ProfileManager) {
  const pm = makeProfileManager(ProfileManager);
  return {
    pm,
    get profilesDir() {
      return pm.profilesDir;
    },
    refresh(currentDir) {
      return enrichAll(pm, { currentDir });
    },
    setDefault(name) {
      pm.setDefault(name);
    },
    create(name, opts) {
      pm.create(name, opts);
    },
    delete(name) {
      pm.delete(name);
    },
    validate(name) {
      return nameValidationError(ProfileManager, name, pm.profilesDir);
    },
  };
}

/* ------------------------------------------------------------------ state */

export function initialState({ profiles, currentDir, preselect }) {
  const list = Array.isArray(profiles) ? profiles : [];
  let selected = 0;
  if (preselect) {
    const idx = list.findIndex((p) => p.name === preselect);
    if (idx >= 0) selected = idx;
  }
  return {
    profiles: list,
    selected: list.length ? Math.min(selected, list.length - 1) : -1,
    offset: 0,
    modal: null,
    status: null,
    currentDir: currentDir ?? null,
  };
}

function openCreateModal(state) {
  return {
    type: "create",
    focus: "name",
    name: "",
    base: "blank",
    fromProfile: state.profiles[0]?.name ?? null,
    shareAuth: true,
    shareModels: true,
    error: null,
  };
}

function openDeleteModal(prof) {
  return { type: "delete", name: prof.name, path: prof.path, typed: "", focus: "typed", error: null };
}

/* ---------------------------------------------------------------- helpers */

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function visibleCount(state, bodyH) {
  if (!state.profiles.length) return 0;
  const dense = state.profiles.length * 2 > bodyH;
  return dense ? bodyH : Math.max(1, Math.floor(bodyH / 2));
}

function scrollToSelection(state, height) {
  if (!state.profiles.length) return state;
  const bodyH = bodyHeight(state, height);
  const n = visibleCount(state, bodyH);
  const selected = clamp(state.selected, 0, state.profiles.length - 1);
  let offset = state.offset;
  if (selected < offset) offset = selected;
  else if (selected >= offset + n) offset = selected - n + 1;
  offset = clamp(offset, 0, Math.max(0, state.profiles.length - n));
  return { ...state, selected, offset };
}

function withStatus(state, text, kind = "info") {
  return { ...state, status: { text, kind } };
}

function refreshProfiles(state, api) {
  const profiles = api.refresh(state.currentDir);
  const next = { ...state, profiles };
  // Keep the selection stable across a refresh, clamping to the new list.
  const prevName = state.profiles[state.selected]?.name;
  const idx = prevName ? profiles.findIndex((p) => p.name === prevName) : -1;
  next.selected = profiles.length ? (idx >= 0 ? idx : clamp(state.selected, 0, profiles.length - 1)) : -1;
  return next;
}

const CREATE_FOCUS_ORDER = ["name", "base", "from", "auth", "models", "create", "cancel"];
const DELETE_FOCUS_ORDER = ["typed", "delete", "cancel"];

function cycleFocus(order, current, delta) {
  if (!order.length) return current;
  let idx = order.indexOf(current);
  if (idx < 0) idx = 0;
  idx = (idx + delta + order.length) % order.length;
  return order[idx];
}

function createFocusOrder(modal) {
  return CREATE_FOCUS_ORDER.filter((f) => (f === "from" ? modal.base === "from" : true));
}

/* ---------------------------------------------------------------- reducer */

/**
 * Apply one key event to the state. Returns `{ state, control }` where control
 * is either null, `{ kind: "quit" }`, or `{ kind: "launch", path }`.
 *
 * `meta.paste` marks keys that arrived as part of a paste (or coalesced read).
 * Such keys never trigger actions — a paste must not launch pi or open dialogs —
 * though text runs still feed an open name field.
 */
export function reduce(state, key, api, height = 24, meta = {}) {
  if (!state.modal) return reduceList(state, key, api, height, meta);
  if (state.modal.type === "create") return reduceCreate(state, key, api, height, meta);
  if (state.modal.type === "delete") return reduceDelete(state, key, api, height, meta);
  if (state.modal.type === "help") return reduceHelp(state, key, api, height, meta);
  return { state, control: null };
}

function reduceList(state, key, api, height, meta = {}) {
  // Keys that arrived in a burst (paste) are ignored: a paste must never
  // launch pi or mutate profiles.
  if (meta.paste) return { state, control: null };

  const n = state.profiles.length;
  const sel = state.selected;

  // Global keys work even with an empty list.
  if (key === "q" || key === "escape" || key === "ctrl+c") return { state, control: { kind: "quit" } };
  if (key === "?" ) return { state: { ...state, modal: { type: "help" } }, control: null };
  if (key === "r" || key === "ctrl+r" || key === "f5") {
    let next = refreshProfiles(state, api);
    next = scrollToSelection(next, height);
    return { state: withStatus(next, `Refreshed — ${next.profiles.length} profile(s)`), control: null };
  }
  if (key === "n" || key === "c") {
    return { state: { ...state, modal: openCreateModal(state) }, control: null };
  }

  if (n === 0) return { state, control: null };

  if (key === "up" || key === "k") return { state: scrollToSelection({ ...state, selected: sel - 1 }, height), control: null };
  if (key === "down" || key === "j") return { state: scrollToSelection({ ...state, selected: sel + 1 }, height), control: null };
  if (key === "home" || key === "g") return { state: scrollToSelection({ ...state, selected: 0 }, height), control: null };
  if (key === "end" || key === "G") return { state: scrollToSelection({ ...state, selected: n - 1 }, height), control: null };
  if (key === "pageup") {
    const step = Math.max(1, visibleCount(state, bodyHeight(state, height)) - 1);
    return { state: scrollToSelection({ ...state, selected: sel - step }, height), control: null };
  }
  if (key === "pagedown") {
    const step = Math.max(1, visibleCount(state, bodyHeight(state, height)) - 1);
    return { state: scrollToSelection({ ...state, selected: sel + step }, height), control: null };
  }

  if (key === "enter" || key === "u" || key === "l" || key === "right") {
    const prof = state.profiles[sel];
    if (!prof) return { state, control: null };
    return { state, control: { kind: "launch", path: prof.path, name: prof.name } };
  }

  if (key === "d") {
    const prof = state.profiles[sel];
    if (!prof) return { state, control: null };
    try {
      api.setDefault(prof.name);
    } catch (err) {
      return { state: withStatus(state, err.message, "error"), control: null };
    }
    const next = refreshProfiles(state, api);
    return { state: withStatus(next, `Default profile set to "${prof.name}"`, "success"), control: null };
  }

  if (key === "D" || key === "x" || key === "shift+d" || key === "delete") {
    const prof = state.profiles[sel];
    if (!prof) return { state, control: null };
    return { state: { ...state, modal: openDeleteModal(prof) }, control: null };
  }

  return { state, control: null };
}

function reduceHelp(state, key) {
  if (key === "escape" || key === "q" || key === "enter" || key === "?" || key === "ctrl+c") {
    return { state: { ...state, modal: null }, control: null };
  }
  return { state, control: null };
}

function reduceCreate(state, key, api, height, meta = {}) {
  const m = state.modal;
  const close = () => ({ state: { ...state, modal: null }, control: null });

  // A paste may still fill in the name field, but its control keys (enter,
  // tab, escape) must not drive the form.
  if (meta.paste && isSymbolicKey(key)) return { state, control: null };

  if (key === "escape" || key === "ctrl+c") {
    // Discarding a typed name is lossless, so close without prompting.
    return close();
  }

  const order = createFocusOrder(m);

  if (key === "tab" || key === "down") {
    return { state: { ...state, modal: { ...m, focus: cycleFocus(order, m.focus, 1) } }, control: null };
  }
  if (key === "shift+tab" || key === "up") {
    return { state: { ...state, modal: { ...m, focus: cycleFocus(order, m.focus, -1) } }, control: null };
  }

  if (m.focus === "name") {
    if (key === "backspace") {
      return { state: { ...state, modal: { ...m, name: m.name.slice(0, -1), error: null } }, control: null };
    }
    if (key === "ctrl+u") {
      return { state: { ...state, modal: { ...m, name: "", error: null } }, control: null };
    }
    if (key === "left" || key === "right") {
      return { state, control: null }; // single-line input: no cursor travel
    }
    if (key === "enter") {
      // Enter on the name field jumps to the next field (or submits at the end).
      const nextFocus = cycleFocus(order, "name", 1);
      return { state: { ...state, modal: { ...m, focus: nextFocus, error: null } }, control: null };
    }
    if (isText(key)) {
      let name = m.name;
      let skipped = false;
      for (const ch of key) {
        if (name.length >= MAX_NAME) break;
        if (NAME_CHARS.test(ch)) name += ch;
        else skipped = true;
      }
      const error = skipped ? "Allowed: letters, digits, . _ - (must start alphanumeric)" : null;
      return { state: { ...state, modal: { ...m, name, error } }, control: null };
    }
    return { state, control: null };
  }

  if (m.focus === "base") {
    const bases =
      m.base === "from" && state.profiles.length === 0
        ? ["blank", "base"]
        : ["blank", "base", "from"];
    if (key === "left" || key === "h") {
      const idx = bases.indexOf(m.base);
      return { state: { ...state, modal: { ...m, base: bases[(idx + bases.length - 1) % bases.length], error: null } }, control: null };
    }
    if (key === "right" || key === "l" || key === " ") {
      const idx = bases.indexOf(m.base);
      return { state: { ...state, modal: { ...m, base: bases[(idx + 1) % bases.length], error: null } }, control: null };
    }
    return { state, control: null };
  }

  if (m.focus === "from") {
    const opts = state.profiles.map((p) => p.name);
    if (!opts.length) return { state, control: null };
    if (key === "left" || key === "h") {
      const idx = clamp(opts.indexOf(m.fromProfile), 0, opts.length - 1);
      return { state: { ...state, modal: { ...m, fromProfile: opts[(idx + opts.length - 1) % opts.length], error: null } }, control: null };
    }
    if (key === "right" || key === "l" || key === " ") {
      const idx = clamp(opts.indexOf(m.fromProfile), 0, opts.length - 1);
      return { state: { ...state, modal: { ...m, fromProfile: opts[(idx + 1) % opts.length], error: null } }, control: null };
    }
    return { state, control: null };
  }

  if (m.focus === "auth" || m.focus === "models") {
    if (key === " " || key === "enter") {
      const field = m.focus === "auth" ? "shareAuth" : "shareModels";
      return { state: { ...state, modal: { ...m, [field]: !m[field], error: null } }, control: null };
    }
    return { state, control: null };
  }

  if (m.focus === "create") {
    if (key === "enter" || key === " ") return submitCreate(state, api, height);
    return { state, control: null };
  }

  if (m.focus === "cancel") {
    if (key === "enter" || key === " ") return close();
    return { state, control: null };
  }

  return { state, control: null };
}

function isText(key) {
  // Multi-char runs arrive on paste, but so do symbolic names like "enter".
  // Treat printable strings that are not key events as text.
  if (isSymbolicKey(key)) return false;
  return key.length >= 1 && [...key].every((c) => c >= " ");
}

function submitCreate(state, api, height) {
  const m = state.modal;
  const name = m.name.trim();

  if (!name) {
    return { state: { ...state, modal: { ...m, error: "Enter a profile name first." } }, control: null };
  }
  const validation = api.validate(name);
  if (validation) {
    return { state: { ...state, modal: { ...m, error: validation } }, control: null };
  }

  const opts = {};
  if (m.base === "base") opts.fromBase = true;
  else if (m.base === "from") opts.from = m.fromProfile ?? state.profiles[0]?.name;

  try {
    api.create(name, { shareAuth: m.shareAuth, shareModels: m.shareModels, ...opts });
  } catch (err) {
    return { state: { ...state, modal: { ...m, error: err.message } }, control: null };
  }

  const profiles = api.refresh(state.currentDir);
  const idx = profiles.findIndex((p) => p.name === name);
  const next = {
    ...state,
    profiles,
    selected: idx >= 0 ? idx : 0,
    offset: 0,
    modal: null,
  };
  return {
    state: withStatus(next, `Created profile "${name}"`, "success"),
    control: null,
  };
}

function reduceDelete(state, key, api, height, meta = {}) {
  const m = state.modal;
  const close = () => ({ state: { ...state, modal: null }, control: null });

  // A paste can type the confirmation name, but its control keys must not
  // submit the form.
  if (meta.paste && isSymbolicKey(key)) return { state, control: null };

  if (key === "escape" || key === "ctrl+c") return close();

  // Typing always feeds the confirmation field, whatever has focus.
  if (isText(key)) {
    return {
      state: { ...state, modal: { ...m, focus: "typed", typed: m.typed + key, error: null } },
      control: null,
    };
  }
  if (key === "backspace") {
    return {
      state: { ...state, modal: { ...m, focus: "typed", typed: m.typed.slice(0, -1), error: null } },
      control: null,
    };
  }
  if (key === "ctrl+u") {
    return { state: { ...state, modal: { ...m, focus: "typed", typed: "", error: null } }, control: null };
  }

  if (key === "tab" || key === "down") {
    return { state: { ...state, modal: { ...m, focus: cycleFocus(DELETE_FOCUS_ORDER, m.focus, 1) } }, control: null };
  }
  if (key === "shift+tab" || key === "up") {
    return { state: { ...state, modal: { ...m, focus: cycleFocus(DELETE_FOCUS_ORDER, m.focus, -1) } }, control: null };
  }

  if (key === "enter" || key === " ") {
    if (m.focus === "cancel") return close();
    return submitDelete(state, api, height);
  }

  return { state, control: null };
}

function submitDelete(state, api, height) {
  const m = state.modal;

  if (m.typed !== m.name || m.name.length === 0) {
    return {
      state: {
        ...state,
        modal: { ...m, error: `Type the full name "${m.name}" to confirm.` },
      },
      control: null,
    };
  }

  try {
    api.delete(m.name);
  } catch (err) {
    return { state: { ...state, modal: { ...m, error: err.message } }, control: null };
  }

  const profiles = api.refresh(state.currentDir);
  const next = {
    ...state,
    profiles,
    selected: profiles.length ? clamp(state.selected, 0, profiles.length - 1) : -1,
    offset: 0,
    modal: null,
  };
  return {
    state: withStatus(next, `Deleted profile "${m.name}"`, "success"),
    control: null,
  };
}

/* ---------------------------------------------------------------- runtime */

export async function runTui({
  ProfileManager,
  api,
  piArgs = [],
  noColor = false,
  version = "",
  term: termOpt,
  input,
  onLaunch,
} = {}) {
  const ops = api ?? createApi(ProfileManager);
  const currentDir = process.env.PI_CODING_AGENT_DIR || null;
  const term = termOpt ?? new Terminal();

  let state = initialState({
    profiles: ops.refresh(currentDir),
    currentDir,
  });

  const painter = createPainter(noColor);
  const meta = {
    version,
    rootLabel: shortPath(ops.pm.piRoot),
    agentDirLabel: shortPath(ops.pm.agentDir),
  };

  const ctx = () => ({ width: term.width, height: term.height, painter, meta });
  const render = () => term.paintFrame(renderFrame(state, ctx()));

  let exiting = false;
  term.onResize(() => {
    if (!exiting) render();
  });

  term.setup();
  const teardown = () => {
    if (!exiting) {
      exiting = true;
      term.teardown();
    }
  };
  process.on("exit", () => term.teardown());

  render();

  // Take the actual iterator (not just the iterable) so we can detach it
  // before handing the terminal over — otherwise this process would keep
  // stealing pi's stdin.
  const it = (input ?? keys(process.stdin))[Symbol.asyncIterator]();
  try {
    while (true) {
      const { value: chunk, done } = await it.next();
      if (done) break;
      for (const key of chunk.keys) {
        const result = reduce(state, key, ops, term.height, { paste: chunk.paste });
        state = result.state;
        if (result.control?.kind === "quit") {
          await it.return?.();
          teardown();
          return;
        }
        if (result.control?.kind === "launch") {
          // Hand the terminal over to pi: stop reading stdin, restore the
          // screen, then spawn with PI_CODING_AGENT_DIR set.
          await it.return?.();
          teardown();
          if (onLaunch) {
            onLaunch(result.control);
            return;
          }
          launchPi(result.control.path, piArgs);
          return;
        }
        render();
      }
    }
  } finally {
    await it.return?.();
    teardown();
  }
}

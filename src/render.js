// Pure rendering. renderFrame(state, ctx) -> string[] never touches the
// terminal, which keeps the whole visual layer unit-testable: tests feed a
// state and assert on ANSI-stripped lines.

import { padEndVisible, padStartVisible, truncateVisible, visibleWidth } from "./strutil.js";

// Box glyphs (UTF-8 terminals; pi's own TUI assumes the same).
const G = {
  tl: "┌",
  tr: "┐",
  bl: "└",
  br: "┘",
  h: "─",
  v: "│",
  dash: "┄",
};

// Semantic palette (truecolour).
const C = {
  accent: (p) => p.fg(122, 140, 255),
  accent2: (p) => p.fg(160, 120, 255),
  success: (p) => p.fg(120, 200, 140),
  warn: (p) => p.fg(235, 190, 110),
  error: (p) => p.fg(235, 110, 110),
  muted: (p) => p.fg(118, 126, 144),
  title: (p) => p.fg(235, 240, 255),
  titleBg: (p) => p.bg(42, 50, 84),
};

export const MIN_HEIGHT = 10;
export const MIN_WIDTH = 44;

/** Rows available for the profile list, mirroring renderFrame's layout. */
export function bodyHeight(state, height) {
  return Math.max(0, height - 2 /* header */ - 1 /* footer */ - (state.status ? 1 : 0));
}

/**
 * Compose a full frame.
 *
 * @param {object} state - { profiles, selected, offset, modal, status }
 * @param {object} ctx   - { width, height, painter, meta }
 * @returns {string[]} frame lines
 */
export function renderFrame(state, ctx) {
  const { width, height, painter: p } = ctx;
  if (height < MIN_HEIGHT || width < MIN_WIDTH) {
    return [
      "",
      C.warn(p)(
        `Terminal too small for ppi-tui: need at least ${MIN_WIDTH}x${MIN_HEIGHT}, have ${width}x${height}.`,
      ),
      C.muted(p)("Resize the window or run it in a larger terminal."),
    ];
  }

  const lines = [];
  lines.push(renderTitle(state, ctx));
  lines.push(renderSubtitle(state, ctx));

  const headerH = 2;
  const footerH = 1;
  const statusH = state.status ? 1 : 0;
  const bodyH = height - headerH - footerH - statusH;

  lines.push(...renderBody(state, { ...ctx, bodyH }));
  lines.push(renderFooter(state, ctx));
  if (state.status) lines.push(renderStatus(state, ctx));

  // Modals overlay the body region, drawn last.
  if (state.modal) {
    const overlay = renderModal(state, ctx);
    if (overlay) {
      const { top, rows } = overlay;
      for (let i = 0; i < rows.length; i++) {
        const idx = top + i;
        if (idx >= 0 && idx < lines.length) lines[idx] = rows[i];
        else if (idx >= lines.length) lines.push(rows[i]);
      }
    }
  }

  return lines;
}

function renderTitle(state, ctx) {
  const { width, painter: p, meta = {} } = ctx;
  const left = `${C.title(p)("ppi")} ${p.bold("pi profile manager")}`;
  const rightText = `ppi-tui ${meta.version ?? ""}`.trim();
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(rightText));
  const content = left + " ".repeat(gap) + C.muted(p)(rightText);
  return C.titleBg(p)(padEndVisible(content, width));
}

function renderSubtitle(state, ctx) {
  const { width, painter: p, meta = {} } = ctx;
  const n = state.profiles.length;
  const rootLabel = meta.rootLabel ?? "~/.pi";
  const def = state.profiles.find((x) => x.isDefault);
  const sep = C.muted(p)(" · ");
  const text = [
    `${C.accent(p)(String(n))} ${C.muted(p)("profile" + (n === 1 ? "" : "s"))}`,
    `${C.muted(p)("root")} ${C.accent2(p)(rootLabel)}`,
    def ? `${C.muted(p)("default")} ${C.warn(p)(def.name)}` : C.warn(p)("no default set"),
  ].join(sep);
  return padEndVisible(truncateVisible(text, width), width);
}

function renderBody(state, ctx) {
  const { width, bodyH, painter: p } = ctx;

  if (state.profiles.length === 0) {
    const rows = ["", "", ""];
    const msg1 = `${C.muted(p)("No profiles yet — press ")}${C.accent(p)("n")}${C.muted(p)(" to create one")}`;
    const msg2 = `${C.muted(p)("or run ")}${C.accent(p)("ppi create <name>")}${C.muted(p)(" on the shell")}`;
    rows[1] = padStartVisible(msg1, Math.max(0, Math.floor((width + visibleWidth(msg1)) / 2)));
    rows.push(padStartVisible(msg2, Math.max(0, Math.floor((width + visibleWidth(msg2)) / 2))));
    while (rows.length < bodyH) rows.push("");
    return rows.slice(0, bodyH);
  }

  const listW = Math.min(Math.max(24, Math.round(width * 0.38)), Math.floor(width / 2));
  const detailW = width - listW - 1; // -1 for the divider
  const selected = state.profiles[state.selected];
  const detail = selected ? renderDetail(selected, { detailW, painter: p }) : [];

  const dense = state.profiles.length * 2 > bodyH;
  const rows = [];
  for (let row = 0; row < bodyH; row++) {
    let idx;
    let isSub = false;
    if (dense) {
      idx = state.offset + row;
    } else {
      idx = state.offset + Math.floor(row / 2);
      isSub = row % 2 === 1;
    }
    const prof = state.profiles[idx];
    const listPart = prof
      ? renderListRow(prof, { listW, selected: idx === state.selected, sub: isSub, painter: p })
      : " ".repeat(listW);
    const divider = C.muted(p)(G.v);
    const detailPart = detail[row] ?? "";
    rows.push(
      listPart + divider + padEndVisible(truncateVisible(detailPart, detailW), detailW),
    );
  }
  return rows;
}

function renderListRow(prof, { listW, selected, sub, painter: p }) {
  if (sub) {
    const model = prof.model ? C.muted(p)(prof.model) : "";
    const tail = C.muted(p)(prof.sizeLabel);
    const gap = Math.max(1, listW - 4 - visibleWidth(model) - visibleWidth(tail));
    const row = `    ${model}${" ".repeat(gap)}${tail}`;
    return padEndVisible(truncateVisible(row, listW), listW);
  }

  const marker = prof.current ? C.accent(p)("●") : " ";
  const name = selected ? p.inverse(p.bold(prof.name)) : p.bold(prof.name);
  const star = prof.isDefault ? C.warn(p)("★") : C.muted(p)("○");
  const used = visibleWidth(marker) + 1 + visibleWidth(name) + 1 + visibleWidth(star);
  const gap = Math.max(1, listW - used);
  const row = `${marker} ${name}${" ".repeat(gap)}${star}`;
  return padEndVisible(truncateVisible(row, listW), listW);
}

function renderDetail(prof, { detailW, painter: p }) {
  const labelW = 10;
  const valW = Math.max(10, detailW - labelW - 3);
  const kv = (label, value, color) => {
    const l = C.muted(p)(padEndVisible(label, labelW));
    const v = truncateVisible(String(value ?? "—"), valW);
    return `  ${l}${color ? color(v) : v}`;
  };

  const rows = [];
  rows.push(
    `  ${p.bold(C.accent(p)(prof.name))}` +
      (prof.isDefault ? `  ${C.warn(p)("default")}` : "") +
      (prof.current ? `  ${C.accent(p)("current")}` : ""),
  );
  rows.push(`  ${C.muted(p)(truncateVisible(prof.path, Math.max(4, detailW - 2)))}`);
  rows.push(`  ${C.muted(p)(G.dash.repeat(Math.max(3, Math.min(detailW - 2, 42))))}`);

  rows.push(kv("model", prof.model, (x) => C.accent(p)(x)));
  rows.push(kv("provider", prof.provider));
  rows.push(kv("theme", prof.theme));
  if (prof.tuiMode) rows.push(kv("tui", prof.tuiMode));

  const linkLabel = (info) =>
    info.kind === "shared"
      ? `shared → ${shortPath(info.target)}`
      : info.kind === "own"
        ? "own copy"
        : "missing";
  rows.push(
    kv(
      "auth",
      linkLabel(prof.auth),
      prof.auth.kind === "missing" ? (x) => C.error(p)(x) : undefined,
    ),
  );
  rows.push(
    kv(
      "models",
      linkLabel(prof.models),
      prof.models.kind === "missing" ? (x) => C.error(p)(x) : undefined,
    ),
  );
  rows.push(kv("packages", prof.packageCount));

  const cnt = prof.counts;
  rows.push(
    kv(
      "installed",
      [
        cnt.extensions ? `${cnt.extensions} ext` : null,
        cnt.skills ? `${cnt.skills} skill${cnt.skills === 1 ? "" : "s"}` : null,
        cnt.tools ? `${cnt.tools} tool${cnt.tools === 1 ? "" : "s"}` : null,
        cnt.prompts ? `${cnt.prompts} prompt${cnt.prompts === 1 ? "" : "s"}` : null,
      ]
        .filter(Boolean)
        .join(" · ") || "none",
    ),
  );
  rows.push(kv("sessions", cnt.sessions));
  rows.push(kv("size", prof.sizeLabel, (x) => C.success(p)(x)));
  rows.push(kv("modified", prof.mtimeLabel));

  for (const problem of prof.problems) {
    rows.push(`  ${C.warn(p)("⚠")} ${C.warn(p)(truncateVisible(problem, Math.max(4, detailW - 4)))}`);
  }
  return rows;
}

export function shortPath(p) {
  if (!p) return "—";
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

function renderFooter(state, ctx) {
  const { width, painter: p } = ctx;
  const hint = state.modal
    ? modalHint(state.modal)
    : [
        ["↑↓", "select"],
        ["⏎ / u", "use"],
        ["d", "default"],
        ["n", "new"],
        ["D", "delete"],
        ["r", "refresh"],
        ["?", "help"],
        ["q", "quit"],
      ];
  const parts = hint.map(([k, v]) => `${p.bold(k)} ${C.muted(p)(v)}`);
  return padEndVisible(truncateVisible(parts.join(C.muted(p)("   ")), width), width);
}

function modalHint(modal) {
  if (modal.type === "create") {
    return [
      ["⇥", "next field"],
      ["← →", "change"],
      ["␣", "toggle"],
      ["⏎", "confirm"],
      ["esc", "cancel"],
    ];
  }
  if (modal.type === "delete") {
    return [
      ["type name", "confirm"],
      ["⇥", "buttons"],
      ["⏎", "confirm"],
      ["esc", "cancel"],
    ];
  }
  return [["esc", "close"]];
}

function renderStatus(state, ctx) {
  const { width, painter: p } = ctx;
  const { text, kind } = state.status;
  const color =
    kind === "error"
      ? C.error
      : kind === "warn"
        ? C.warn
        : kind === "success"
          ? C.success
          : C.muted;
  return padEndVisible(truncateVisible(color(p)(text), width), width);
}

/* ------------------------------------------------------------------ modals */

export function renderModal(state, ctx) {
  const { width, height, painter: p } = ctx;
  const inner = modalContent(state, ctx);
  if (!inner) return null;

  const headerH = 2;
  const footerH = 1;
  const statusH = state.status ? 1 : 0;
  const bodyTop = headerH;
  const bodyH = height - headerH - footerH - statusH;

  const boxW = Math.min(width - 2, inner.width + 4);
  const boxH = Math.min(bodyH, inner.rows.length + 2);
  const innerW = boxW - 4;
  const left = Math.max(1, Math.floor((width - boxW) / 2));
  const top = bodyTop + Math.max(0, Math.floor((bodyH - boxH) / 2));
  const pad = " ".repeat(left - 1);

  const titleText = inner.title ? ` ${p.bold(inner.title)} ` : "";
  const rows = [];
  rows.push(
    pad +
      C.muted(p)(G.tl) +
      titleText +
      C.muted(p)(G.h.repeat(Math.max(0, innerW + 2 - visibleWidth(titleText)))) +
      C.muted(p)(G.tr),
  );
  for (let i = 0; i < boxH - 2; i++) {
    const content = inner.rows[i] ?? "";
    rows.push(
      pad +
        C.muted(p)(G.v) +
        " " +
        padEndVisible(truncateVisible(content, innerW), innerW) +
        " " +
        C.muted(p)(G.v),
    );
  }
  rows.push(pad + C.muted(p)(G.bl) + C.muted(p)(G.h.repeat(innerW + 2)) + C.muted(p)(G.br));

  return { top, rows: rows.map((r) => padEndVisible(truncateVisible(r, width), width)) };
}

function modalContent(state, ctx) {
  if (state.modal.type === "create") return createModalContent(state, ctx);
  if (state.modal.type === "delete") return deleteModalContent(state, ctx);
  if (state.modal.type === "help") return helpModalContent(state, ctx);
  return null;
}

function budget(ctx) {
  return Math.min(64, Math.max(40, ctx.width - 8));
}

function button(label, active, painter, enabled = true, color) {
  if (active && enabled) return painter.inverse(painter.bold(` ${label} `));
  // `color` (when given) is already a text transform, e.g. `C.error(p)`.
  const body = enabled ? (color ? color(label) : painter.bold(label)) : painter.dim(label);
  return ` ${body} `;
}

function centeredButtons(buttons, budgetW, painter) {
  const total = visibleWidth(buttons);
  const indent = Math.max(0, Math.floor((budgetW - total) / 2));
  return " ".repeat(indent) + buttons;
}

function createModalContent(state, ctx) {
  const { painter: p } = ctx;
  const m = state.modal;
  const W = budget(ctx);
  const meta = ctx.meta ?? {};

  const rows = [];
  const nameFocused = m.focus === "name";
  const cursor = p.inverse(" ");
  const nameValue = m.name ? p.bold(m.name) : C.muted(p)("profile-name");
  const nameInner = `${nameValue}${nameFocused ? cursor : ""}`;
  rows.push(`${C.muted(p)("Name   ")}[${padEndVisible(nameInner, W - 12)}]`);

  rows.push("");
  rows.push(C.muted(p)("Base"));
  const bases = [
    ["blank", "Blank profile"],
    ["base", `Copy from stock ${shortPath(meta.agentDirLabel ?? "~/.pi/agent")}`],
    ["from", "Copy from an existing profile"],
  ];
  for (const [id, label] of bases) {
    const active = m.base === id;
    const focused = m.focus === "base" && active;
    const radio = active ? (focused ? p.inverse(p.bold("●")) : C.accent(p)("●")) : C.muted(p)("○");
    rows.push(`  ${radio} ${active ? p.bold(label) : C.muted(p)(label)}`);
  }

  if (m.base === "from") {
    const opts = state.profiles.map((x) => x.name);
    const focused = m.focus === "from";
    const val = m.fromProfile ?? opts[0] ?? "—";
    const arrows = focused ? C.accent(p)("◂ ▸") : C.muted(p)("◂ ▸");
    const pos = opts.indexOf(val);
    rows.push(
      `      ${C.muted(p)("from:")} ${p.bold(val)} ${arrows} ${C.muted(p)(`${pos + 1}/${opts.length}`)}`,
    );
  }

  rows.push("");
  const toggle = (on, focused) =>
    on
      ? focused
        ? p.inverse(p.bold("[✓]"))
        : C.success(p)("[✓]")
      : focused
        ? p.inverse(C.muted(p)("[ ]"))
        : C.muted(p)("[ ]");
  rows.push(`${toggle(m.shareAuth, m.focus === "auth")} ${C.muted(p)("share auth with stock pi config")}`);
  rows.push(
    `${toggle(m.shareModels, m.focus === "models")} ${C.muted(p)("share models with stock pi config")}`,
  );

  rows.push("");
  if (m.error) {
    rows.push(`${C.error(p)("⚠")} ${C.error(p)(truncateVisible(m.error, W))}`);
    rows.push("");
  }

  rows.push(
    centeredButtons(
      `${button("Create", m.focus === "create", p)}   ${button("Cancel", m.focus === "cancel", p)}`,
      W,
      p,
    ),
  );

  const width = Math.max(44, ...rows.map(visibleWidth));
  return { title: "Create profile", rows, width: Math.min(width, 72) };
}

function deleteModalContent(state, ctx) {
  const { painter: p } = ctx;
  const m = state.modal;
  const prof = state.profiles.find((x) => x.name === m.name);
  const W = budget(ctx);

  const rows = [];
  rows.push(C.muted(p)(truncateVisible(prof?.path ?? m.path ?? "", W)));
  const cnt = prof?.counts ?? {};
  rows.push(
    C.muted(p)(
      [
        cnt.sessions != null ? `${cnt.sessions} session${cnt.sessions === 1 ? "" : "s"}` : null,
        cnt.extensions != null
          ? `${cnt.extensions} extension${cnt.extensions === 1 ? "" : "s"}`
          : null,
        prof?.sizeLabel,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  );
  rows.push("");
  rows.push(`${C.warn(p)("⚠")} ${C.warn(p)("This permanently removes settings, extensions,")}`);
  rows.push(`${C.warn(p)("   skills, prompts and sessions. It cannot be undone.")}`);
  rows.push("");
  rows.push(C.muted(p)("Type the profile name to confirm:"));
  const cursor = p.inverse(" ");
  const typed = m.typed ? p.bold(m.typed) : "";
  rows.push(`[${padEndVisible(`${typed}${m.focus === "typed" ? cursor : ""}`, W - 12)}]`);
  rows.push("");

  const matches = m.typed.length > 0 && m.typed === m.name;
  if (m.error) {
    rows.push(`${C.error(p)("⚠")} ${C.error(p)(truncateVisible(m.error, W))}`);
    rows.push("");
  } else if (!matches) {
    rows.push(C.muted(p)(`Name must match "${m.name}" exactly to enable deletion.`));
    rows.push("");
  }

  rows.push(
    centeredButtons(
      `${button("Delete", m.focus === "delete", p, matches, C.error(p))}   ${button(
        "Cancel",
        m.focus === "cancel",
        p,
      )}`,
      W,
      p,
    ),
  );

  const width = Math.max(44, ...rows.map(visibleWidth), visibleWidth(`Delete profile "${m.name}"`));
  return { title: `Delete profile "${m.name}"`, rows, width: Math.min(width, 72) };
}

function helpModalContent(state, ctx) {
  const { painter: p } = ctx;
  const entries = [
    ["↑ / k", "move selection up"],
    ["↓ / j", "move selection down"],
    ["g / G", "first / last profile"],
    ["⏎ / u", "launch pi with the selected profile"],
    ["d", "set selected profile as default"],
    ["n / c", "create a new profile"],
    ["D / x", "delete the selected profile"],
    ["r", "refresh the profile list"],
    ["?", "show this help"],
    ["q / esc", "quit ppi-tui"],
  ];
  const rows = entries.map(
    ([k, v]) => `  ${p.bold(padEndVisible(k, 9))} ${C.muted(p)(v)}`,
  );
  rows.push("");
  const rootLabel = ((ctx.meta ?? {}).rootLabel ?? "~/.pi") + "/profiles";
  rows.push(`  ${C.muted(p)("Profiles live at")} ${C.accent2(p)(rootLabel)}`);
  const width = Math.max(40, ...rows.map(visibleWidth));
  return { title: "Keys", rows, width: Math.min(width, 72) };
}

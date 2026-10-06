# ppi-tui

An interactive terminal UI for [ppi](https://www.npmjs.com/package/pi-profiles)
(the `pi-profiles` package), the profile manager for
[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

`ppi` manages multiple pi agent configurations: each profile is a complete agent
directory (`settings.json`, extensions, skills, prompts, sessions, auth) living
under `~/.pi/profiles/<name>/`, plus a `default.json` pointing at the active one.
`ppi-tui` is a visual front-end for that — a two-pane picker that shows what each
profile contains and lets you switch, create, default and delete profiles without
remembering subcommands.

**It builds on top of `ppi` rather than replacing it.** Every mutation goes
through `ppi`'s own `ProfileManager` API, so the two tools always agree on disk
state. `ppi-tui` never touches `~/.pi/agent/` (the stock pi config) except to read
the paths `ppi` itself uses.

## Requirements

- Node `>=20` (ESM, zero runtime dependencies)
- `pi-profiles` — installed globally by `ppi`, or as a peer dependency

## Install

`ppi-tui` expects `pi-profiles` to be resolvable. If you run `ppi` globally, the
package is already at your global npm root; symlink it into this project (or any
dir you run from):

```sh
npm link pi-profiles        # if pi-profiles exposes a link target
# or, without touching the global package:
mkdir -p node_modules && ln -s "$(npm root -g)/pi-profiles" node_modules/pi-profiles
```

Then run it in place:

```sh
node ./bin/ppi-tui.js
```

## Usage

```sh
ppi-tui                       # interactive UI (needs a TTY)
ppi-tui list                  # plain listing, no TTY needed
ppi-tui --version
ppi-tui --help
```

The UI is a two-pane layout: profile list on the left, details for the selected
profile on the right (model, provider, theme, whether auth/models are shared with
the stock config, installed extensions, session count, size, last modified).

| Key | Action |
|---|---|
| `↑`/`k`, `↓`/`j` | move selection |
| `g`/`G` | first / last profile |
| `⏎` / `u` | launch `pi` with the selected profile |
| `d` | set the selected profile as default |
| `n` / `c` | create a new profile |
| `D` / `x` | delete the selected profile |
| `r` | refresh the list |
| `?` | help |
| `q` / `esc` | quit |

### Creating a profile

A modal asks for the name (validated live — invalid characters and collisions are
rejected with a reason), a base (blank, copy from the stock pi config, or copy an
existing profile), and two toggles for sharing `auth.json` / `models.json` with
the stock config via symlink. Type-to-confirm is not needed here, so `⏎` on
**Create** makes it immediately.

### Deleting a profile

Deleting is permanent — it removes settings, extensions, skills, prompts and
sessions. The modal makes you **type the profile name exactly** before the Delete
button activates (stronger than `ppi`'s `y/N`), which matters because one of those
profiles is probably your live agent.

### Paste safety

Input that arrives as one multi-keystroke chunk is treated as a paste and
ignored in the list, and only its text is accepted in name fields. This keeps an
accidental middle-click paste from confirming a delete or launching `pi`.

## Project layout

```
bin/ppi-tui.js        entry point
src/strutil.js        ANSI-aware string width utils (no deps)
src/keys.js           raw-mode key parsing, paste detection
src/term.js           terminal wrapper + colour painter
src/profiles.js       ProfileManager loader + read-only enrichment
src/launch.js         mirrors ppi's launch semantics
src/render.js         pure renderFrame(state, ctx) -> string[]
src/tui.js            pure reduce(state, key, api, height, meta) + runTui runtime
src/cli.js            arg parsing, subcommands, non-TTY listing
test/*.test.js        node --test suites (65 tests)
```

The app is built **pure-first** for testability: `renderFrame` and `reduce` are
pure functions with all I/O behind an injected `api`, and `runTui` takes an
injectable terminal, input stream and `onLaunch` callback. The whole UI can be
driven without a real terminal, which is how the tests exercise it — and how the
reduce logic is verified to never touch `~/.pi` (tests point `PPI_PI_ROOT` at a
temp dir and unset `PI_CODING_AGENT_DIR`).

## Development

```sh
node --test test/            # full suite
node --test test/tui.test.js # one suite
```

Colours are 24-bit ANSI, honouring `NO_COLOR`. Width math is display-cell aware,
so emoji and wide CJK characters align.

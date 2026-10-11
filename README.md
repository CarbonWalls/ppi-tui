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
ppi-tui
ppi-tui list                  # plain listing, no TTY needed
ppi-tui create <name> [opts]  # create without the TUI
ppi-tui delete <name> [--force]  # delete without the TUI
ppi-tui set-default <name>    # set the default profile
ppi-tui extensions install <source>   # add a package to every profile (shared)
ppi-tui extensions update [<source>]  # update packages in every profile (shared)
ppi-tui extensions list               # show packages across all profiles
ppi-tui extensions remove <source>    # drop a package from every profile
ppi-tui --version
ppi-tui --help
```

### Non-interactive profile management

The subcommands mirror `ppi` itself, so anything scriptable there works here
too:

```sh
ppi-tui create work                              # blank profile
ppi-tui create work --from home                  # copy an existing profile
ppi-tui create work --from-base                  # copy the stock pi config
ppi-tui create work --own-auth --own-models      # copy, don't symlink
ppi-tui delete work --force                      # no confirmation prompt
ppi-tui set-default work
```

`--own-auth` / `--own-models` copy `auth.json` / `models.json` into the profile
instead of symlinking them back to the stock pi config.

### Extension management across all profiles

pi installs npm packages physically into *each* profile's `npm/` directory, so
giving every profile the same extension means one full copy per profile. `ppi
extensions` eliminates that by deduplicating the physical install.

On the first `install` / `update`, every profile's `npm` dir is pointed at one
shared install root (`~/.pi/shared/npm`, invisible to ppi because it lives
outside `~/.pi/profiles/`). A profile that already had its own `npm` directory
has its contents merged in and the dir becomes a symlink — so existing installs
are kept, not re-downloaded.

Each profile still keeps its **own** `packages` list in `settings.json`; only
the bytes are shared. `pi install` / `pi update` therefore fetch once no matter
how many profiles you have:

```sh
ppi extensions install pi-context-tree   # npm: is assumed for bare names
ppi extensions install npm:@scope/pkg@1.0
ppi extensions update                    # reconcile every installed package
ppi extensions update pi-context-tree    # update just one
ppi extensions list                      # who has what, shared or not
ppi extensions remove pi-context-tree    # drop from every profile
```

Bare names are auto-prefixed with `npm:`; `git:`, `./path`, and `https://…`
sources pass through unchanged. `remove` only edits the `packages` arrays —
bytes stay in the shared cache (safe, and re-adding is instant).

Short aliases: `ext` / `x` for `extensions`, and `i`/`add`, `u`/`up`,
`l`/`ls`, `rm`/`un` per action. The examples above are the same as
`ppi x i npm:pi-context-tree`, `ppi ext u`, `ppi x l`, `ppi ext rm foo`.

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

### Sizes load in the background

Byte sizes and modification times are the expensive part of loading a profile —
a large one holds tens of thousands of files, and every file costs an `lstat`.
The TUI renders immediately and fills those numbers in once measured, so a big
profile set never blocks startup. The plain `list` subcommand skips them
entirely (it prints a `—`), since a one-shot listing should stay fast.

## Replacing `ppi` with `ppi-tui`

`ppi-tui` can take over the global `ppi` command without uninstalling anything:
point the `ppi` symlink at this project's entrypoint and keep `pi-profiles`
installed (it's imported as a library). For example:

```sh
ln -sf /usr/local/lib/node_modules/pi-profiles/dist/src/cli/main.js /usr/local/bin/ppi.orig   # backup
ln -sf /path/to/ppi-tui/bin/ppi-tui.js /usr/local/bin/ppi
```

Because every mutation delegates to `ppi`'s own `ProfileManager`, and the
subcommands mirror `ppi`'s flags one-for-one, scripts calling `ppi` keep working.

## Project layout

```
bin/ppi-tui.js        entry point
src/strutil.js        ANSI-aware string width utils (no deps)
src/keys.js           raw-mode key parsing, paste detection
src/term.js           terminal wrapper + colour painter
src/profiles.js       ProfileManager loader + read-only enrichment
src/extensions.js     shared-npm package management across all profiles
src/launch.js         mirrors ppi's launch semantics
src/render.js         pure renderFrame(state, ctx) -> string[]
src/tui.js            pure reduce(state, key, api, height, meta) + runTui runtime
src/cli.js            arg parsing, subcommands, non-TTY listing
test/*.test.js        node --test suites (105 tests)
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

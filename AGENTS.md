# Talos

Controls Claude sessions from a central server. See `README.md` for what it is
and how to run it.

## Rules

Follow the dev rules in [docs/DEV_RULES.md](docs/DEV_RULES.md) for all code
here. Above all: write functional code (small pure functions, no mutation,
side effects kept at the edges).

Follow the UI rules in [docs/UI_RULES.md](docs/UI_RULES.md) for anything
people look at. Above all: as little text as possible, and icons over words.
After any change to the page, run `make screenshots` and commit the new
screenshots with it.

Follow the CLI rules in [docs/CLI_RULES.md](docs/CLI_RULES.md) for the
`talos` command. Above all: data on stdout, one-line errors that say what to
run, and `--json` on every list.

Every command goes in the README's Commands section: each `talos` command
and each `make` target, with a line on what it does. Add, change or remove a
command there in the same change that adds, changes or removes it.

Name things, and talk about the system, with the words in
[docs/GLOSSARY.md](docs/GLOSSARY.md). Add a word there before using a new one.

Follow the commit rules in [docs/COMMITS.md](docs/COMMITS.md).

## Modules

Build behavior inside modules: blocks with one job, fixed inputs and outputs,
and their own tests, used only through their `index.ts`. They're folders in
the app for now, written so each could become its own package later. Talos is
the layer that wires them together. See [docs/MODULES.md](docs/MODULES.md).

- `talos-sessions`: run Claude Code and get its conversation and structured answers back. Created: `talos/src/talos-sessions/`.
- `talos-machine-link`: keep a machine connected to the server. Not created.
- `talos-relay`: the server's live hub between machines and pages. Not created.
- `talos-pairing`: give a new machine its key. Not created.
- `talos-sign-in`: sign people in. Not created.
- `talos-accounts`: keep several Claude logins, watch each one's usage, and say which a session should use (replaces janus). Not created.
- `talos-utils`: general helpers more than one module needs, knowing nothing about talos. Not created (only once a second module needs a helper).

Each module stands on its own: it depends on nothing else in talos, except
`talos-utils` if it needs a helper.

`talos-shared` isn't a module. It's what talos's own programs share, and no
module imports it.

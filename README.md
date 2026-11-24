# Talos

Talos controls Claude sessions from another program.

In Greek myth, Talos was a bronze giant that guarded Crete and ran without
anyone steering it. This Talos keeps Claude sessions working the same way.

## Why

If a program can drive a Claude session, it can do almost anything with it:

- tell a session about a conversation it should join
- have a session work through a list of tasks, one after another
- start, stop, and check on sessions on any machine

Omicron (the task board) doesn't do this part well. Talos does this part and
nothing else.

## The plan

- **One central server** that controls everything. Every machine connects to
  it, and it tells their sessions what to do.
- **Safe remote control.** Only Joe, and programs Joe allows, can send orders
  to a session. Work this out first, before anything else gets built.

## Layout

- `talos-server/`: the central server. It serves the page from `talos-web/`.
- `talos-web/`: the one page (React and shadcn), for browsers and the desktop app.
- `talos-desktop/`: the desktop app (Tauri): one window on the server's page.
- `talos/`: the program each machine runs. It connects to the server and
  answers each ping with a pong. It also answers questions about its own
  machine on 127.0.0.1:7071, which the page uses to show a "This machine"
  panel when it's open on a machine running talos.
- `talos-shared/`: the message types and helpers talos's own programs share
  (talos, the server and the page). Modules don't use it.

All three are TypeScript, run with [Bun](https://bun.com).

## Modules

Talos is being split into blocks, one job each, each with fixed inputs and
outputs and its own tests. Each is a folder in the app for now. Why and how:
[docs/MODULES.md](docs/MODULES.md).

| Module | Job | Status |
| --- | --- | --- |
| `talos-sessions` | Run Claude Code and get its conversation and structured answers back | Created: `talos/src/talos-sessions/` |
| `talos-machine-link` | Keep a machine connected to the server | Not created |
| `talos-relay` | The server's live hub between machines and pages | Not created |
| `talos-pairing` | Give a new machine its key | Not created |
| `talos-sign-in` | Sign people in | Not created |
| `talos-accounts` | Keep several Claude logins, watch each one's usage, and say which a session should use; replaces janus | Not created |
| `talos-utils` | General helpers more than one module needs; knows nothing about talos | Not created (only once a second module needs a helper) |

Each module stands on its own: it depends on nothing else in talos, except
`talos-utils` if it needs a helper. `talos-shared` isn't a module: it's what
talos's own programs share (talos, the server, the page), and modules never
import it.

## Running it

```sh
cp .env.example .env    # then fill it in (it says how)
make dev
```

Open http://localhost:7070 (or run `make desktop`) and sign in with GitHub.
The `talos` terminal shows a pairing code: enter it with the + button on the
Machines page. `talos` then shows who entered it and asks if that's you (or
checks `TALOS_PAIR_OWNER` when it has no terminal), so someone else who saw the
code can't take the machine. Then it saves its key in
`~/.talos/credentials.json` and connects. The admin (`TALOS_ADMIN_GITHUB_ID`, a GitHub account number) has a switch under Settings
that lets new people sign up; it starts off.

Until the code is entered, a talos started again (after Ctrl-C, a crash or a
restart) shows the same code, kept in `~/.talos/pairing.json` until it runs
out after 10 minutes. The server takes only a few codes at a time from one
address, so a new one each time would soon be turned away.

The emulator forgets everything when it stops, so after `make down` each
machine shows a new code to pair with.

### On another machine, with no clone

```sh
curl -fsSL https://raw.githubusercontent.com/joeboylson/talos/main/install.sh | sh -s -- wss://<server>
talos service install
```

The script downloads main from GitHub into `~/.talos/app` (only talos and
`talos-shared`), puts talos's own Bun 1.4.4 in `~/.talos/bun` (checked against
Bun's checksums), saves the server's address in
`~/.talos/talos.env`, and puts a `talos` command in `~/.local/bin`.
`talos service install` pairs the machine (the code shows in the terminal),
then runs talos in the background and at every login, and again if it stops: a
launch agent on macOS, a systemd user service on Linux. Its log is
`~/.talos/talos.log`. `talos status` says whether the machine is paired, the
service running and talos connected. After a push to main, `talos update`
brings the machine up to it and sets up the service again on the new code. It
restarts the session runner, which ends its sessions, only when the runner's
own code changed.

To take talos off a machine (the login service, the session runner and its
sessions, the `talos` command and `~/.talos`), then remove the machine on the
page:

```sh
curl -fsSL https://raw.githubusercontent.com/joeboylson/talos/main/uninstall.sh | sh
```

`talos service uninstall` only stops running talos in the background, and
keeps the rest.

## Commands

Every command lives here. Names follow the glossary
([docs/GLOSSARY.md](docs/GLOSSARY.md)).

### `talos` (on each machine)

| Command | What it does |
| --- | --- |
| `talos`, `talos help [<thing>]` | Lists these commands, or one group of them (like `talos help sessions`). |
| `talos connect [--owner <login>]` | Pairs this machine if it isn't yet, then connects here and stays connected until stopped. `--owner` answers pairing's "is that you?" ahead of time. |
| `talos service install [--owner <login>]` | Pairs this machine if it isn't yet, then runs talos in the background, at every login and again if it stops (macOS and Linux). |
| `talos service start` | Starts the background talos. |
| `talos service stop` | Stops it until the next login or `talos service start`. Its sessions keep running. |
| `talos service uninstall` | Stops running talos in the background. Its sessions run on until `talos runner stop`. |
| `talos status [--json]` | Shows the version, the server, whether this machine is paired, the service running, talos connected, and how many sessions run. |
| `talos update` | Brings a copy put in place by `install.sh` up to main, then runs `talos service install`. |
| `talos logs [--runner]` | Shows the end of talos's log (or the session runner's) and follows it. |
| `talos open` | Prints the page's address for this machine's Machines page and opens it in the browser. |
| `talos folders [--json]` | Lists the folders this machine allows sessions in. |
| `talos folders add <path>` | Allows sessions in a folder on this machine. Prints its identifier. |
| `talos folders remove <folder>` | Stops allowing a folder. |
| `talos folders rename <folder> <new-name>` | Gives a folder a new name. Its path never changes. |
| `talos sessions [--json]` | Lists this machine's Claude sessions. |
| `talos sessions start [<folder>] [--name <name>] [--add]` | Starts a session in a folder, given by its name or its path (the current folder if none), named after it unless `--name` says otherwise. A folder that isn't added yet is added first, after asking (`--add` says yes without asking). Prints its identifier and page address. |
| `talos sessions <session> send "<text>"` | Sends a session a message, as from the page; with no text, sends what's piped in. |
| `talos sessions [<session>] attach` | Follows a session's conversation in your terminal (with no session named, the only one running, or one you choose from a list): type a message, `y`/`n` for a permission question, a number for a question's choice; Ctrl-C stops its turn, Ctrl-D leaves it running. |
| `talos sessions <session> open` | Prints the session's page address and opens it in the browser. |
| `talos sessions <session> stop` | Ends a session. |
| `talos runner stop` | Ends the session runner and every session in it. |

Every command takes `--help` (or `-h`), and `talos --version` says which
talos this is. Lists are tables in a terminal and tab-separated lines when
piped; `--json` gives JSON. Options start with a dash and a letter, and `--`
ends them (`talos sessions web send -- --force it`). Errors are one line saying what to run next
(`TALOS_DEBUG=1` adds the stack trace). It exits `0` when it worked, `1` when
it couldn't, and `2` when a command was typed wrong. See
[docs/CLI_RULES.md](docs/CLI_RULES.md).

Folders belong to the machine the command runs on. They're kept there (in
`~/.talos/folders.json`), and a running `talos` tells the server straight
away. The page lists them under Folders, where they (and machines) can be
renamed too.

Sessions run in the session runner, a background program `talos` starts on
each machine. It holds the Claude Code sessions, so they keep running
when `talos` restarts (it restarts on every save in development). After
changing anything in `talos/src/talos-sessions/`, run
`make talos runner stop` so the next `talos` starts a fresh one; that ends
running sessions. The session runner's own log is `~/.talos/runner.log`.

In this repo, run any of them with `make talos <command>`, like
`make talos folders add ~/code/x`.

### `make` (in this repo)

| Command                | What it does                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `make dev`             | Starts the AWS emulator and talos-server in Docker, then runs talos here. Ctrl-C stops talos.         |
| `make down`            | Stops the Docker side (the emulator forgets everything).                                              |
| `make logs`            | Follows talos-server's output. It restarts on every save.                                             |
| `make talos <command>` | Runs any `talos` command from here (see above). Plain `make talos` connects.                          |
| `make desktop`         | Opens the desktop app on the server's page. Run `make dev` first.                                     |
| `make example EXAMPLE=<name>` | Runs a talos-sessions example (receipts, recipes, explorer) in this terminal; `MODE=record` saves the run, `MODE=replay` plays it back with no Claude. |
| `make live-examples`   | Runs every example's live check against real Claude (`LIVE_ONLY=<name>` runs one); costs real Claude turns. |
| `make check-sessions`  | Runs talos-sessions' own check: its typecheck, tests and examples' tests (`make test` runs it too). |
| `make live-sessions`   | Checks the session runner with real Claude Code sessions in a throwaway folder (`LIVE_ONLY=<name>` runs one scenario); costs real Claude turns. |
| `make sdk-check`       | Checks the headless stream against Anthropic's Agent SDK: the SDK drives the tests' fake Claude Code, and talos's input lines are compared with the SDK's. No model. |
| `make screenshots`     | Retakes every screen of the page into `docs/screenshots/`, from a throwaway server with made-up data. |
| `make server-image`    | Builds the talos-server container that goes on AWS.                                                   |
| `make security`        | Runs the security checks that GitHub and each publish run (see Publishing).                           |
| `make test`            | Runs every folder's tests.                                                                            |
| `make test-db`         | Checks the server's tables against a throwaway AWS emulator in Docker (not part of `make test`).      |
| `make typecheck`       | Type-checks every folder.                                                                             |
| `make install`         | Installs packages (other commands do this when needed).                                               |

## Publishing

Every push to `main` that changes the server publishes it. AWS CodeBuild
(`talos-server-deploy` in us-east-2) runs `deploy/buildspec.yml`: it checks
the code, builds the image, runs the security checks, and only if they pass
uploads the image and switches the live server to it. Results show in the AWS
console under CodeBuild. Changes to docs, `talos/` or `talos-desktop/` alone
don't publish.

Every push and pull request also runs the Checks workflow on GitHub
(`.github/workflows/security.yml`): types, tests and the same security checks.
It has no access to AWS. The security checks (`dev/security/check.sh`, also
`make security`) fail on high or critical problems only:

- `bun audit`: packages with known holes.
- gitleaks: keys or passwords committed anywhere in the history.
- Semgrep: risky code patterns.
- zizmor: mistakes in the GitHub workflows.
- Trivy: known holes in the server image's system packages.

## Status

Live on AWS (ECS Express Mode in us-east-2). Machines and sessions driven
from the page.

Known limit: a session (or anything running as you) can pose as a session to
talos on that machine, since sessions run as your own user. See
`talos-sessions` in docs/MODULES.md.

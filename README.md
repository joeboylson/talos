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
- `talos-shared/`: the message types and helpers both sides use.

All three are TypeScript, run with [Bun](https://bun.com).

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

The emulator forgets everything when it stops, so after `make down` each
machine shows a new code to pair with.

## Commands

Every command lives here. Names follow the glossary
([docs/GLOSSARY.md](docs/GLOSSARY.md)).

### `talos` (on each machine)

| Command                                    | What it does                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `talos`                                    | Pairs this machine if it isn't yet, then connects and stays connected.            |
| `talos folders`                            | Lists the folders this machine allows sessions in.                                |
| `talos folders add <path>`                 | Allows sessions in a folder on this machine. Prints its identifier.               |
| `talos folders remove <folder>`            | Stops allowing a folder.                                                          |
| `talos folders rename <folder> <new-name>` | Gives a folder a new name. Its path never changes.                                |
| `talos sessions`                           | Lists this machine's Claude sessions.                                             |
| `talos sessions <session> attach`          | Shows a session's terminal in yours, to watch or type. Ctrl-\\ leaves it running. |
| `talos sessions <session> stop`            | Ends a session.                                                                   |
| `talos host stop`                          | Ends the session host and every session in it.                                    |
| `talos help`                               | Lists these commands.                                                             |

Folders belong to the machine the command runs on. They're kept there (in
`~/.talos/folders.json`), and a running `talos` tells the server straight
away. The page lists them under Folders, where they (and machines) can be
renamed too.

Sessions run in the session host, a background program `talos` starts on
each machine. It holds Claude Code's terminals, so sessions keep running
when `talos` restarts (it restarts on every save in development). After
changing `talos/src/host.ts` or `talos/src/hook.ts`, run
`make talos host stop` so the next `talos` starts a fresh host; that ends
running sessions. The host's own log is `~/.talos/host.log`.

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
| `make screenshots`     | Retakes every screen of the page into `docs/screenshots/`, from a throwaway server with made-up data. |
| `make server-image`    | Builds the talos-server container that goes on AWS.                                                   |
| `make security`        | Runs the security checks that GitHub and each publish run (see Publishing).                           |
| `make test`            | Runs every folder's tests.                                                                            |
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

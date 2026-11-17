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
Machines page. The machine saves its key in `~/.talos/credentials.json` and
connects. The admin (`TALOS_ADMIN_GITHUB_LOGIN`) has a switch under Settings
that lets new people sign up; it starts off.

The emulator forgets everything when it stops, so after `make down` each
machine shows a new code to pair with.

## Commands

Every command lives here. Names follow the glossary
([docs/GLOSSARY.md](docs/GLOSSARY.md)).

### `talos` (on each machine)

| Command      | What it does                                                           |
| ------------ | ---------------------------------------------------------------------- |
| `talos`      | Pairs this machine if it isn't yet, then connects and stays connected. |
| `talos help` | Lists these commands.                                                  |

In this repo, run them with `cd talos && bun src/index.ts <command>`
(`make talos` runs plain `talos`).

### `make` (in this repo)

| Command             | What it does                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `make dev`          | Starts the AWS emulator and talos-server in Docker, then runs talos here. Ctrl-C stops talos. |
| `make down`         | Stops the Docker side (the emulator forgets everything).                                      |
| `make logs`         | Follows talos-server's output. It restarts on every save.                                     |
| `make talos`        | Runs only talos, for when the server is already up.                                           |
| `make desktop`      | Opens the desktop app on the server's page. Run `make dev` first.                             |
| `make server-image` | Builds the talos-server container that goes on AWS.                                           |
| `make test`         | Runs every folder's tests.                                                                    |
| `make typecheck`    | Type-checks every folder.                                                                     |
| `make install`      | Installs packages (other commands do this when needed).                                       |

## Status

A ping and pong on one machine. No AWS yet.

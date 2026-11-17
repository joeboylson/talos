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
- `talos-web/`: the one page, for browsers and the desktop app.
- `talos-desktop/`: the desktop app (Tauri): one window on the server's page.
- `talos/`: the program each machine runs. It connects to the server and
  answers each ping with a pong. It also answers questions about its own
  machine on 127.0.0.1:7071, which the page uses to show a "This machine"
  panel when it's open on a machine running talos.
- `talos-shared/`: the message types and helpers both sides use.

All three are TypeScript, run with [Bun](https://bun.com).

## Running it

```sh
cp .env.example .env    # then set TALOS_MACHINE_KEY (openssl rand -hex 32)
make dev                # installs packages the first time, then runs both
```

Open http://localhost:7070 and press Ping, or run `make desktop` in a second
terminal to open the same page in the desktop app.

`make test` and `make typecheck` run each folder's tests and type checks.

## Status

A ping and pong on one machine. No AWS yet.

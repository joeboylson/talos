# Modules

Talos is being split into blocks, each with one job. A block takes a fixed set
of inputs, gives a fixed set of outputs, and knows nothing about talos. It's
tested on its own. Talos itself is then the layer that wires the blocks together
and adds what only talos needs: machines, owners, folders, settings and the page.

This is the dev rules' functional style (small pure parts, side effects at the
edges, see [DEV_RULES.md](DEV_RULES.md)) applied to whole blocks instead of
single functions.

## Rules

- **Modules first, packages later.** Each block is a folder inside the app,
  not its own package. It's written so it could become a package later without
  changes: it's used only through its `index.ts`, and it never reaches into
  talos or another block's insides.
- **Inputs and outputs, nothing else.** A block's `index.ts` lists everything
  it takes in and gives out. Anything talos-specific is passed in, never
  imported.
- **Each module stands on its own.** It depends on nothing else in talos: not
  another module, not talos's own code. The one exception is `talos-utils`
  (below), if it needs one of its helpers.
- **No `talos-shared`.** No module imports `talos-shared`. That package is part
  of talos's specific layer: what talos's own programs (talos, the server, the
  page) share. A module owns its own shapes, limits and helpers, and talos
  converts them into `talos-shared`'s messages.
- **No database.** No module reads or writes the database. Talos's own layer
  does that: it gives a module the data it needs (like the machine list, or the
  pairings waiting) and stores what the module hands back.
- **Tested alone.** Each block has its own tests that run without the rest of
  the app, and one check script inside it that typechecks it and runs its tests
  and its examples' free tests. Everywhere talos is tested calls that script, so
  the module's own repo could run the same one.
- **Shown by examples.** Each module has small examples, inside it, of how to use
  it for something that isn't talos. An example uses the module's `index.ts`
  plus its own helpers (in `examples/kit/`), brings its own data (a dummy
  project, a JSON file, a SQLite database, whatever fits), runs with one
  command, keeps its run in a folder you can open, and has its own tests. Talos
  uses the module through the same calls the examples do.
- **Split only along a real edge.** A block exists because what goes in and out
  of it can be described on its own. A block that only passes calls through
  to another isn't worth having.
- **Named `talos-<job>`.**

## The blocks

Each block below is listed as what goes in → what comes out.

- **`talos-sessions`** (created). Runs Claude Code and gets output back from it.
  - In, when the session runner starts: its home (the folder it keeps its own
    files in), a folder check, a logger, the kinds of output the program
    defines, what a prose turn may send, and whether to put folder trust back
    when it stops (`restoreTrustOnStop`). Tests can also set the command it
    runs as Claude and the settings file it trusts folders in; otherwise it
    runs the pinned Claude Code.
  - In, through its plain calls (`connectToSessions({ home, runnerScript })`):
    start a session in a folder, send it a message (through its mod, one per
    turn, waiting while a turn runs) or keys, interrupt its turn, answer a
    permission prompt showing in its terminal (allow or deny), stop it,
    resize
    it, see its screen, ask it for a kind of output, answer an open output by
    its id, attach a terminal, list the sessions, follow events, and start,
    check or stop the session runner itself.
  - Out: results and refusals for each call; each session's state (from its
    mod's facts), whether its mod's link is up or lost, whether its running
    turn was started by Claude Code on its own, its asks
    (state and latest answer per kind), its open outputs, its conversation as
    entries in conversation order (outputs and dropped markers included),
    its waiting messages, the permission prompts showing in its terminal
    (each with its tool and what it would do), notices like a dropped answer, each waiting
    message given back (with the request id it was sent with) when an
    interrupt or Esc means it won't go in, and its raw terminal output.
  - Refusal codes: `no-such-session`, `already-running`, `too-many-sessions`,
    `folder-not-allowed` (also a folder that's gone), `already-asking`,
    `closed` (that question has closed), `not-a-choice`, `not-sendable` (a
    choice that would act as a command), `too-many-waiting` (it already has
    as many messages waiting for their turn as it takes), `stopped` (Esc in
    its terminal stopped
    it; only the person continues it, there), `link-lost` (its mod is gone,
    so talos sends it nothing) and `no-claude-code` (the machine hasn't the
    one Claude Code version talos runs) and `not-running` (an interrupt with
    no turn running). A malformed
    request, or a session runner that can't be reached, throws instead.
  - Its home holds: `runner.sock` (the plain calls) and `runner-link.sock`
    (the sessions' mods),
    `mod/<hash>/` (the mod's snapshot), `claude-code/<version>/claude` (the
    pinned Claude Code, a hard link to the installer's copy), `runner.lock` (the one runner holding the home),
    `runner.log` (moved to `runner.log.1` past 10 MB when a runner starts),
    `uploads/<session>/`
    (a session's newest 20 images), `quarantine.log` (dropped items' data),
    `trust-changes.json` (trust to put back, even after a crash) and
    `session-groups.json` (what a runner that dies outright leaves to end).
  - Holds: the session runner, the mod (`mod/`, run inside every session's
    Claude Code, with its helper and its own tests under Claude Code's kit;
    it gives the session talos's tools and answers their calls through the
    runner, and refuses every other mod's hooks and the `/fork` command in
    its session), the link server, the lane and output rules, held answers, the transcript reader, and its own copies of the
    shapes and limits it shares with `talos-shared`.
  - Known limit: it trusts everything that runs as the same user. A session's
    link secret is in its mod's helper's environment, so anything with Bash
    in that session (a sub-agent, a prompt-injected command) can read it and
    post to the link as the mod: put up questions with buttons, or answer an
    asked-for turn. It can also open the control socket, which is this
    user's like the rest, and drive every session through it. The fix is running sessions as a separate
    OS user, left until talos runs for more than its one owner.
  - Shown by: `examples/receipts`, `examples/recipes`, `examples/explorer`.
  - Lives in: `talos/src/talos-sessions/`, tests in its own `tests/` and each
    example's `tests/`, all run by its `check.sh`.
- **`talos-machine-link`** (not created). Keeps a machine connected to the
  server.
  - In: the machine's key, the server's address, messages to send.
  - Out: commands from the server, connected or disconnected.
  - Holds: reconnecting, and the paced resend after a reconnect.
  - Will live in: `talos/src/talos-machine-link/`.
- **`talos-relay`** (not created). The server's live hub between machines and
  pages.
  - In: what machines report, commands from pages, who owns what.
  - Out: the right messages to each owner's pages and machines.
  - Holds: recent history per session, the kept machine list, the per-socket
    budgets.
  - Will live in: `talos-server/src/talos-relay/`.
- **`talos-pairing`** (not created). Gives a new machine its key.
  - In: a machine's name, the code a person enters, who approved it.
  - Out: a machine key, or a pairing still waiting.
  - Will live in: `talos-server/src/talos-pairing/`, with the machine's half in
    `talos/src/talos-pairing/`.
- **`talos-accounts`** (not created). Keeps several Claude logins and says which
  one a session should use, so talos can replace janus.
  - In: the saved logins (long-lived tokens), the switching rules (pin to one,
    or move at a % of the weekly or 5-hour limit, notify only, move back on
    reset).
  - Out: each account's usage and when it resets, and which account a session
    should use now, with the settings to start it on that account.
  - Holds: the logins, reading usage, the switching rules.
  - Needs from `talos-sessions`: extra settings for one session when it
    starts, and restarting a session with new settings while keeping its
    conversation, between turns.
  - Will live in: `talos/src/talos-accounts/`.
- **`talos-sign-in`** (not created). Signs people in.
  - In: a request.
  - Out: the signed-in person, or none.
  - Holds: GitHub sign-in and session cookies.
  - Will live in: `talos-server/src/talos-sign-in/`.

## `talos-utils`: general helpers (not created)

Helpers more than one module needs, like reading JSON safely, go in
`talos-utils`, so each has one owner.

- **Completely general.** Nothing in it knows about talos, sessions, machines or
  any module. Every helper would make sense in any program.
- **Stands on its own.** It depends on nothing else in talos, so it could become
  a package of its own.
- **Only once a second module needs it.** Until then a helper lives in the one
  module that uses it (DEV_RULES: inline until the second caller). When a second
  module needs the same helper, it moves to `talos-utils`.

## Not a module: `talos-shared`

`talos-shared` already exists, as a package. It's part of talos's specific
layer, not a module: it holds what talos's own programs share (the message
shapes between talos, the server and the page, the readers that check them,
limits and names). Modules never import it.

## Order

`talos-sessions` came first: it had the clearest edge, and the work in
[TASKS.md](TASKS.md) builds on it.

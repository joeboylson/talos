# Glossary

The words Talos uses, in the code, the page, the `talos` command and these
docs. Use these and no others.

## Things

- **person**: someone who uses Talos. A person can have several sign-ins.
- **sign-in**: one way a person gets in, like a GitHub account
  (`github-id:34290408`, by GitHub's permanent account number). Tailscale
  sign-ins come later.
- **admin**: the one person named in `TALOS_ADMIN_GITHUB_ID`. Only the
  admin sees settings.
- **machine**: a computer running `talos`, belonging to the person who paired
  it. Nobody else can see or use it.
- **pairing**: how a machine joins: `talos` shows a **pairing code**, its
  owner enters it on the page.
- **machine key**: the secret a machine gets when it's paired and uses every
  time it connects.
- **folder**: a folder on a machine that its owner allows sessions in. Only
  `talos` on that machine can add or remove one; the page just shows them.
- **session**: a Claude Code conversation that `talos` runs in a folder,
  headless. Its state, as its stream says, is **starting**, **ready** (`idle`
  in code), **working**, or **needs you** (a permission question to answer,
  or an open question waiting for its answer).
- **link lost**: a session whose mod is gone. It keeps running and takes
  messages, but talos's tools and asks don't work in it.
- **self-started turn**: a turn Claude Code starts on its own, not from a
  message: a sub-agent's, a background task's notice, a scheduled wake-up.
  It's shown as such and never taken for the person's.
- **entry**: one thing in a session's conversation: a message someone sent
  (with any images), text Claude wrote, a tool Claude ran, an output the
  session sent in a prose turn, or a dropped marker.
- **position**: an entry's place in its session's conversation, counted by the
  session runner as it reads it. Every side keeps entries in that order and
  trims the oldest first, so an entry that arrives again lands in its place.
- **dropped marker**: an entry that stands in for an item that failed its
  check, holding only its kind and why. The item's data is kept aside in the
  **quarantine file** on the machine, never sent on.
- **status**: a session's structured state (working, waiting, done, stuck) plus
  a one-line note, filled in when someone presses "ask for an update". It's a
  kind talos asks for; the session reports it by calling the report_status tool.
- **decision**: a question a session asks its owner while working, with two to
  four choices. It's an optional output, with an id. The page shows it as
  buttons; a click is answered by its id, and the owner can also type their own
  answer. It lasts one turn.
- **structured tool**: the tool a session calls to send an output of a kind
  (report_status, ask_decision). Its own call isn't shown in the conversation.
- **attach**: follow a session's conversation in your terminal and type to
  it (`talos sessions <session> attach`).
- **command list**: what attach can do besides sending a message, opened with
  Ctrl+P. For now it holds one item: the session's loop.
- **waiting message**: a message sent from the page while a session's turn
  runs, held by the session runner and sent once the turn is over, one per
  turn. Every page shows it.
- **interrupt**: stopping a session's running turn, from the page or Ctrl-C
  in attach. The session goes on taking messages. Waiting messages go back
  to the message box of the page that sent them.
- **loop**: one message talos sends a session again and again (typed, or a
  file's text, read again before every run), on a
  **schedule** (cron, in the machine's own time), until its **limit**: a
  number of runs (at most 999) or an end time (at most 7 days after it
  starts). A session has at most one. It ends with its session, and can be
  edited or **restarted** while it runs. See [TASKS.md](TASKS.md) for where
  loops go next.
- **run**: one time a loop's schedule comes due. It's **sent**, or
  **skipped**: the session was busy, its file couldn't be read, or the
  machine was off (the last two logged as warnings). Its **history** lists every run.

## Programs

Name a program by where it runs and what it does. Don't call any of them a
"client": the page, `talos` and the session runner are each a client of
something.

- **server**: `talos-server`, the one central program, on AWS.
- **page**: the website the server shows (`talos-web`), in a browser or the
  desktop app.
- **talos**: the main program on each machine. It connects to the server and
  passes commands on to the session runner. It restarts freely (on every save,
  in development).
- **session runner**: the background program on each machine that keeps the
  sessions running, answers their mods and reads their conversations. It
  outlives `talos` restarts. In code, "runner" is short for it.
- **hook**: code Claude Code runs at set moments, such as before each tool
  runs and when a turn stops. talos's hooks are its mod's: through them the
  session runner allows or denies a tool, or keeps a turn going.
- **mod**: talos's plugin with code that runs inside every session's Claude
  Code. It tells the session runner what Claude Code is doing, gives the
  session talos's structured tools, and sends the session its messages. Its
  code lives in `talos-sessions/mod/`.
- **stream**: the JSON lines a session's Claude Code reads and writes when it
  runs headless (with no terminal): messages and control requests in, the
  conversation, each turn's end and permission questions out.
- **link**: the connection between a session's mod and the session runner.
  Over it the mod gets talos's tools and asks about each tool call and Stop,
  and sends a heartbeat so the runner knows it's alive.
- **check-in**: the mod's first word over the link when a session starts:
  which session, which Claude Code version, which snapshot.
- **snapshot**: a read-only copy of the mod the session runner makes when it
  starts. Sessions load the mod from it, so editing the mod's code never
  changes a running session.
- **pinned Claude Code**: the one tested copy of `claude` talos keeps in its
  home and runs every session with. It never updates itself; it's changed by
  hand.

## How talos is built

- **module**: a block of talos with one job, fixed inputs and outputs, and its
  own tests, used only through its `index.ts`. Named `talos-<job>`. See
  [MODULES.md](MODULES.md).
- **`talos-utils`**: general helpers more than one module needs. It knows
  nothing about talos and could stand on its own; a module may import it and
  nothing else in talos.
- **specific layer**: talos's own code that wires the modules together and
  decides what's talos-specific, such as which output kinds exist and their
  rules. It includes `talos-shared`, the package talos's own programs share;
  modules never import it.
- **output**: what a turn hands back. **Prose** is a session's ordinary
  conversation. A structured output has fixed fields, of a **kind** like status
  or decision.
- **optional output**: a structured output a session may send during a prose
  turn, like a decision, as its specific layer allows.
- **kind**: a type of structured output, defined by talos's specific layer:
  its fields and their check, which fields get sent into a session (and
  whether those may hold commands), its **choices field** (the list a click
  picks from), whether the session waits after sending one, and the request
  talos sends to ask for one.
- **turn shape**: what a turn must hand back and what else it may send. A
  **prose turn** hands back prose and may send its optional outputs. An
  **asked-for turn** (like a **status turn**) is one talos starts to ask for a
  kind: only that kind's tool runs.
- **lane**: the rules for which turn shape a session is in, and the steps from
  asking for a kind to its answer.
- **pending output** and **open output**: an output's call was allowed and
  given an id (pending), then went through with that id (open). An open
  output that waits is a question; it closes when the person's turn after the
  one that asked it ends. Turns talos sends (an answer, an asked-for request)
  don't count, and only a turn's end counts.
- **ask** and **asks list**: asking a session for a kind. The asks list holds,
  per kind, where the latest ask stands (asking, answered, no response) and its
  latest answer.
- **settled**: a session's turn is over: its stream sent the turn's result.
  Talos sends into a session only then, one thing per turn: the person's
  waiting messages first, then its own text.
- **held answer**: a click on an open output's choice, kept until the session
  has settled, then sent as `Answer to <id>: <choice>`. The message is
  `answer-output`.

## Using a module

- **account**: one Claude login a session can run on. A machine can have
  several, and talos can switch a session between them.
- **home**: the folder a module keeps its own files in, handed to it by the
  program using it. Talos's is `~/.talos`; an example's is its `run/` folder.
- **plain calls**: how a program uses `talos-sessions` (`connectToSessions`,
  given its home and the script that runs its session runner): start, send,
  interrupt, answerPermission, ask, answer, stop, sessions, follow, and
  isRunning, ensureRunning and stopRunner for the session runner itself.
- **result**: what a plain call gives back: done, or a **refusal**, which holds
  a short fixed **code** a program can check (like `closed`; the list is in
  docs/MODULES.md) and a reason to show.
- **notice**: something the session runner tells a program didn't happen, like
  a dropped answer.
- **request id**: the id a page gives each thing it asks a session to do, so a
  refusal is shown on that page only (and a refused message's waiting copy
  goes). The server gives the machine an id of its own in its place.
- **folder check**: the program's rule for which folders a session may start in.
- **kind** and **asked-for turn** belong to the module: any program passes its
  own kinds in, not only talos.
- **check script**: the one script inside a module that typechecks it and runs
  its tests and its examples' free tests (`check.sh`).
- **example**: a small program inside a module that shows how to use it for
  something that isn't talos, with its own data and tests.
- **kit**: the helpers a module's examples share (`examples/kit/`).
- **view**: an example's pure part: what the screen shows for what's happened,
  and what to do for a key.
- **live**, **recording** and **replay**: the modes an example runs in. Live uses
  real Claude; a recording saves a live run; a replay plays one back with no
  Claude.
- **live check**: an example's check against a real run, by hand, since it
  costs Claude turns.
- **watchdog**: what stops an example's session runner when the example is gone.

## Identifiers

Every thing has an identifier: `talos:` and then kind and name pairs,
separated by colons, from the biggest thing to the smallest.

```
talos:machines                              all your machines
talos:machines:work-mac                     one machine
talos:machines:work-mac:folders:talos       a folder on it
talos:machines:work-mac:sessions:fix-login  a session on it
talos:settings                              the admin's settings
```

Kinds are plural (`machines`, `folders`, `sessions`). Names are lowercase
letters, numbers and dashes, and unique among their siblings: a person can't
have two machines called `work-mac`.

## The same shape everywhere

An identifier, a page address and a command name the same thing the same way.
Only the separator changes.

| Identifier                                | Page                        | Command                                      |
| ----------------------------------------- | --------------------------- | -------------------------------------------- |
| `talos:machines`                          | `/machines`                 | `talos machines` (page only, for now)        |
| `talos:machines:work-mac`                 | `/machines/work-mac`        | `talos machines work-mac` (page only, for now) |
| `talos:machines:work-mac` + ping          | the row's ping button       | `talos machines work-mac ping` (page only, for now) |
| `talos:folders`                           | `/folders`                  | `talos folders`                              |
| `talos:machines:atlas:sessions:fix-login` | `/sessions/atlas/fix-login` | `talos sessions fix-login attach` (on atlas) |
| `talos:settings`                          | `/settings`                 | `talos settings` (page only, for now)        |

Actions (`ping`, `add`, `remove`, `rename`, `attach`) come after the thing they act on.
They're verbs, so they never appear in an identifier.

A command run on a machine is about that machine, so it leaves the machine
out: `talos folders add ~/code/x` on work-mac adds
`talos:machines:work-mac:folders:x`. The Folders page lists every machine's
folders together, with a Machine column.

The server's own data routes live under `/api`, so they never clash with a
page address.

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
- **session**: a Claude Code conversation that `talos` runs in a folder. Its
  state is **starting**, **ready**, **working**, or **needs you** (Claude is
  asking something in its terminal; attach to answer).
- **entry**: one thing in a session's conversation: a message someone sent
  (with any images), text Claude wrote, or a tool Claude ran.
- **status**: a session's structured state (working, waiting, done, stuck) plus
  a one-line note, filled in when someone presses "ask for an update". The
  session reports it by calling the report_status tool; hooks force that call and
  keep it out of ordinary chat.
- **decision**: a question a session asks its owner while working, with two to
  four choices. The page shows it as buttons; the owner picks one or types their
  own answer, which goes to the session as its next message. The session asks by
  calling the ask_decision tool, then waits.
- **structured tool**: a typed tool a session calls to hand talos an answer
  (report_status, ask_decision), checked before it's recorded.
- **prose turn** and **status turn**: a session's ordinary chat turn is a prose
  turn, where any tool runs, plus the structured tools meant for chat (like
  ask_decision). A status turn is one talos starts to ask for a status, where only
  report_status runs.
- **attach**: show a session's terminal in your own, to watch or type.

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
  sessions running, answers their hooks and reads their conversations. It
  outlives `talos` restarts. In code, "runner" is short for it.
- **hook**: a check Claude Code makes with the session runner at set moments,
  such as before each tool runs and when a turn stops. The session runner's
  answer can allow or deny the tool, or keep the turn going.

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
| `talos:machines`                          | `/machines`                 | `talos machines`                             |
| `talos:machines:work-mac`                 | `/machines/work-mac`        | `talos machines work-mac`                    |
| `talos:machines:work-mac` + ping          | the row's ping button       | `talos machines work-mac ping`               |
| `talos:folders`                           | `/folders`                  | `talos folders`                              |
| `talos:machines:atlas:sessions:fix-login` | `/sessions/atlas/fix-login` | `talos sessions fix-login attach` (on atlas) |
| `talos:settings`                          | `/settings`                 | `talos settings`                             |

Actions (`ping`, `add`, `remove`, `rename`, `attach`) come after the thing they act on.
They're verbs, so they never appear in an identifier.

A command run on a machine is about that machine, so it leaves the machine
out: `talos folders add ~/code/x` on work-mac adds
`talos:machines:work-mac:folders:x`. The Folders page lists every machine's
folders together, with a Machine column.

The server's own data routes live under `/api`, so they never clash with a
page address.

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
- **kind**: a type of structured output, defined by talos's specific layer:
  its fields and their check, which fields get typed into a session (and
  whether those may hold commands), its **choices field** (the list a click
  picks from), whether the session waits after sending one, and the request
  talos types to ask for one.
- **turn shape**: what a turn must hand back and what else it may send. A
  **prose turn** hands back prose and may send its optional outputs. An
  **asked-for turn** (like a **status turn**) is one talos starts to ask for a
  kind: only that kind's tool runs.
- **lane**: the rules for which turn shape a session is in, and the steps from
  asking for a kind to its answer.
- **pending output** and **open output**: an output's call was allowed and
  given an id (pending), then went through with that id (open). An open
  output that waits is a question; it closes when the turn after the one that
  asked it ends.
- **ask** and **asks list**: asking a session for a kind. The asks list holds,
  per kind, where the latest ask stands (asking, answered, no response) and its
  latest answer.
- **settled**: a session's turn is over and its screen has been still for a
  moment. Talos types its own text into a session only then, after an Esc.
- **held answer**: a click on an open output's choice, kept until the session
  has settled, then typed as `Answer to <id>: <choice>`. The message is
  `answer-output`.

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

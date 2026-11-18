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
- **session host**: the background program on each machine that holds the
  sessions' terminals, so they outlive `talos` restarts.
- **attach**: show a session's terminal in your own, to watch or type.
- **server**: `talos-server`, the one central program.
- **page**: the website the server shows (`talos-web`), in a browser or the
  desktop app.

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

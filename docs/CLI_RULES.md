# CLI rules

For the `talos` command, and anything else people (or agents) run in a
terminal. Learned from the CLIs that are good to use: GitHub's `gh`, Stripe's,
Vercel's and Fly's.

- **Name commands after tasks, in the identifier's shape.** `talos <thing>
  [<name>] <action>`, the way identifiers and page addresses read (see
  [GLOSSARY.md](GLOSSARY.md)): `talos sessions fix-login stop`, not
  `talos stop-session fix-login`.
- **Data on stdout, everything else on stderr.** What a command answers (a
  list, an identifier, a status) goes to stdout. Notes, progress, warnings and
  logs go to stderr, so `talos sessions | ...` pipes only the sessions.
- **Readable for people, plain for scripts.** In a terminal, lists are tables
  with a header row. Piped, they're tab-separated lines with no header. Every
  list and `talos status` takes `--json`, which prints the same data as JSON.
- **Errors say what went wrong and what to run.** One line on stderr, then the
  command that fixes it if there is one. Never a stack trace (`TALOS_DEBUG=1`
  shows one). A mistyped command gets the closest real one, not the whole help.
- **Exit codes mean something.** `0` it worked, `1` it couldn't, `2` the
  command was typed wrong.
- **Ask only when a person is there.** Prompt in a terminal; every question
  also has a flag (or setting) that answers it, so a script or an agent never
  waits on a prompt nobody sees.
- **Say what happened.** After an action, print what changed and where to see
  it: its identifier, its page address.
- **Help everywhere.** `talos`, `talos help`, `talos help <thing>`,
  `talos <thing> --help` and `-h` all show help, grouped by task, with
  examples. `talos --version` says which talos this is.
- **Set up once, then stay out of the way.** One line installs talos; pairing
  is a link to click; `talos update` keeps it current; settings live in one
  file, not in flags typed every time.
- **Do what the page can't.** Following logs, attaching to a session's
  terminal, opening the page where you are: the terminal's own strengths.
- **Every command change lands everywhere at once.** A command added,
  changed or removed changes `talos help` and the README's Commands section in
  the same change.

# recipes

A chat with a Claude Code session that keeps a small recipe book. Ask it to add
a recipe, scale one, swap an ingredient or plan a week of dinners, and it edits
the files in `book/` as you talk.

It shows the module with no kinds at all: just a plain way to run and talk to a
session, and to watch it work in its own terminal.

```
make example EXAMPLE=recipes              # live: real Claude
make example EXAMPLE=recipes MODE=record  # live, and save the run
make example EXAMPLE=recipes MODE=replay  # play the saved run, no Claude
```

Keys: type a message and ⏎ · `^A` watch the session's own terminal (`^\` to
come back) · `^C` quit, listing the files that changed.

## What's where

- `data/`: the `book/`, `pantry.md`, and the session's `CLAUDE.md` and
  `.claude/settings.json`. Copied fresh into `run/work/` each run.
- `run/`: the last run, kept so you can look; `run/work/book/` has the edited
  recipes.
- `runner.ts`, `view.ts`, `changes.ts`, `main.ts`: the example. `view.ts` is pure.
- `tests/`: free tests, in `make test`. `live-check.ts`: a real run, by hand.

## What it can't keep to itself

- Claude Code writes its own records under your `~/.claude`.
- Your own Claude Code settings apply, and Claude Code also reads the
  `CLAUDE.md` files of the folders around `run/work/` (this repo's).
- Nothing walls Claude in: `data/.claude/settings.json` allows editing `book/`
  and `pantry.md`, and auto mode decides the rest.

# explorer

Ask about a made-up shop's 2025 sales in plain words. The answer comes back as
the session's text with charts, tables and numbers drawn in between, in the
order the session sent them.

It shows a session sending structured outputs on its own, in a normal turn,
alongside its prose: `chart`, `table`, `stat` and `summary` (see `kinds.ts`).

```
make example EXAMPLE=explorer              # live: real Claude
make example EXAMPLE=explorer MODE=record  # live, and save the run
make example EXAMPLE=explorer MODE=replay  # play the saved run, no Claude
```

Keys: type a question and ⏎ · `s` summary · `^A` the session's own terminal
(`^\` to come back) · `^C` quit.

## What's where

- `data/`: `shop.db` (built by `build.ts`), and the session's `CLAUDE.md` and
  `.claude/settings.json`. Copied fresh into `run/work/` each run.
- `run/`: the last run, kept so you can look: the session runner's socket and
  log, the MCP config, and `work/`, the session's copy of the data.
- `kinds.ts`, `runner.ts`, `view.ts`, `main.ts`: the example. `view.ts` is pure.
- `tests/`: free tests, in `make test`. `live-check.ts`: a real run, by hand.

## What it can't keep to itself

- Claude Code writes its own records under your `~/.claude`.
- Your own Claude Code settings apply, and Claude Code also reads the
  `CLAUDE.md` files of the folders around `run/work/` (this repo's).
- Nothing walls Claude in: `data/.claude/settings.json` allows `sqlite3` and
  reading, and auto mode decides the rest.

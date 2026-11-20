# receipts

A pile of messy receipts in, a clean table of expenses and totals out. When a
receipt could be business or personal, the session asks you, and you answer
with a number.

It shows three things the module does:

- outputs sent on their own, with no prose shown at all (`expense`, `skipped`)
- a question you answer by its id (`question`, which waits)
- an output the program asks for (`tally`, asked once the session is idle with
  no question open)

```
make example EXAMPLE=receipts              # live: real Claude
make example EXAMPLE=receipts MODE=record  # live, and save the run
make example EXAMPLE=receipts MODE=replay  # play the saved run, no Claude
```

Keys: `1`-`9` answer the question · `^A` the session's own terminal (`^\` to
come back) · `^C` quit.

## What's where

- `data/`: the `inbox/` of receipts, and the session's `CLAUDE.md` and
  `.claude/settings.json`. Copied fresh into `run/work/` each run.
- `answers.json`: the right answer for each receipt, for the live check. It
  sits outside `data/`, so the session never sees it.
- `run/`: the last run, kept so you can look.
- `kinds.ts`, `runner.ts`, `view.ts`, `main.ts`: the example. `view.ts` is pure.
- `tests/`: free tests, in `make test`. `live-check.ts`: a real run, by hand.

## What it can't keep to itself

- Claude Code writes its own records under your `~/.claude`.
- Your own Claude Code settings apply, and Claude Code also reads the
  `CLAUDE.md` files of the folders around `run/work/` (this repo's).
- Nothing walls Claude in: `data/.claude/settings.json` allows reading, and
  auto mode decides the rest.

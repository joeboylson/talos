# Talos

Controls Claude sessions from a central server. See `README.md` for what it is
and how to run it.

## Rules

Follow the dev rules in [docs/DEV_RULES.md](docs/DEV_RULES.md) for all code
here. Above all: write functional code (small pure functions, no mutation,
side effects kept at the edges).

Follow the UI rules in [docs/UI_RULES.md](docs/UI_RULES.md) for anything
people look at. Above all: as little text as possible, and icons over words.
After any change to the page, run `make screenshots` and commit the new
screenshots with it.

Every command goes in the README's Commands section: each `talos` command
and each `make` target, with a line on what it does. Add, change or remove a
command there in the same change that adds, changes or removes it. Name
things with the words in [docs/GLOSSARY.md](docs/GLOSSARY.md).

Follow the commit rules in [docs/COMMITS.md](docs/COMMITS.md).

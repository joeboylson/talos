# UI rules

For `talos-web` and anything else people look at.

- **Let the UI speak for itself.** If a screen needs words to explain it, fix
  the screen, not the words.
- **As little text as possible.** Data is welcome: names, statuses, numbers.
  Everything else earns its place. No subtitles, descriptions or help text
  under titles, cards, dialogs or settings: a label, the thing itself, and
  nothing more. Short feedback is fine ("No machines", an error).
- **Icons over words.** If an icon can say it, use the icon alone: buttons,
  actions, toggles. Every icon-only control gets a tooltip and an
  `aria-label` with its name (use `IconButton`). Keep text only where an icon
  can't carry it, and then keep it to a word or two.
- **Plain shadcn.** Use shadcn components as they come (new-york style,
  neutral colors), laid out like the shadcn blocks: dashboard-01's sidebar,
  header and table; the login blocks' centered card. Add components with
  `bunx shadcn@4.23.0 add <name>` in `talos-web/`.
- **Never edit `src/components/ui/`.** The shadcn CLI may overwrite it. To
  change a component, make a new one in `src/components/` that wraps the
  shadcn one (like `IconButton` wraps `Button` and `Tooltip`).
- **Light and dark.** Everything works in both; use the theme colors
  (`bg-muted`, `text-muted-foreground`), never fixed ones, except status dots.

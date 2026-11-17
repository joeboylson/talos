# Commit rules

Taken from Joe's dev workflow.

- **Commit when asked, not as you go.** Don't commit while building. Commit
  when Joe asks, at points that make sense.
- **One line, conventional-commit style.** Subject line only: no body and no
  `Co-Authored-By` line. For example:
  `feat(talos-server): add a health check for the load balancer`.
- **Clean comments first.** Run `/clean-comments` on the changes before
  committing.

# Dev rules

Follow these unless a code comment or Joe says otherwise. Adapted from the
temp_plus_platform dev guidelines.

- **Functional first.** Write as much as possible as small pure functions that
  take values and return values, and build bigger behavior by composing them.
  Don't mutate inputs; return new values. Prefer `map`/`filter`/`reduce` and
  expressions over loops that build state. No classes unless something outside
  the code forces one. Keep the impure parts (sockets, timers, `fetch`, file
  and env reads, logging) thin and at the edges, and pass what they produce
  into pure functions.
- **Thinnest working line first.** Build the smallest version that works end
  to end, through every layer it has to cross, with the least code. No extra
  options, settings, layers, or "while we're here" work. Prove it runs, then
  grow it only when a real need shows up.
- **One owner per shared value.** Each shared value lives in one place and
  everyone else imports it. Never declare the same constant twice, tests
  included. Values both sides use belong in `talos-shared`.
- **Talk through contracts.** Folders and modules use each other only through
  their exported types and functions, never each other's internals. Each
  folder (`talos`, `talos-server`, `talos-shared`, `talos-web`,
  `talos-desktop`) has its own
  tests and runs on its own; the root only ties them together and never
  supplies something a folder needs to work.
- **Wide, shallow files, one concern each.** One main thing per file, named
  after it. Helpers group by subject (`utils/string.ts`, `utils/date.ts`).
  Group by feature at the top, keep tests and types beside what they cover,
  and give shared folders an `index.ts` that re-exports.
- **No magic values.** Give every meaningful literal a named constant:
  `RETRY_DELAY_MS = 2000`, not a bare `2000`. Keep constants in a constants
  file. A fixed set of related values is a union type or enum; grouped
  settings are one config object.
- **Inline until the second caller.** Don't pull code into its own function
  until a second place needs it, or it's a truly general helper with no ties
  to this project. "Might reuse it someday" doesn't count.
- **Name the in-between values.** Pull long expressions, chained calls and
  object literals into well-named variables above the line that uses them, so
  that line reads like English: `if (payloadHasEmail)`, not
  `if (payload.get("key").toLowerCase().trim() === "email")`.
- **Guard clauses, flat code.** Handle the odd cases first and return early
  (missing input, no permission, empty list). The normal path sits flat at the
  bottom, not inside nested `if`s.
- **Descriptive names.** Don't save characters. Functions say what they do in
  2–5 words (`parseUserEmail`, `sendMachineList`); variables name the thing
  (`activeSessionCount`); booleans read as a state (`isConnected`,
  `hasExpired`, `shouldRetry`). This covers everything named: files, routes,
  env vars, config keys, message types, CSS classes. Use each one's usual
  casing: camelCase in TypeScript, kebab-case for files and routes,
  SCREAMING_SNAKE for env vars and constants.
- **Strict types, no escape hatches.** Type every boundary: function
  signatures, messages, request and response shapes. Let inference handle the
  rest. Reuse existing types, and prefer built-in or library types. No `any`;
  if one can't be avoided, keep it to one line with a comment saying why.
- **Fail loud.** Let errors travel up to something that can handle them.
  Don't swallow errors, and don't catch just to log and re-throw. Catch only
  to add context, recover, or turn the error into a proper answer (like a 400).
  Use built-in error types unless a custom one makes failures clearer.
- **Test behavior, not internals.** Test what goes in and what comes out, so
  tests survive rewrites. Pure functions make this easy, so test them
  heavily: edge cases, limits, and error paths.
- **Comment the why, not the what.** Comments explain business rules,
  surprising decisions, and traps ("retries twice because the vendor's API
  fails on a cold start"). Delete comments that repeat the code, and never
  leave commented-out code. See the `/clean-comments` skill.

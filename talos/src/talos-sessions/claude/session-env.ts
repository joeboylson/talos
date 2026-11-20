// Claude Code marks the sessions it runs, and a session started with these
// marks thinks it's a sub-session: it stops saving its conversation (which
// the replies are read from). talos may itself run inside Claude Code, so
// the marks are dropped. The rest of the environment, including the
// person's own Claude Code settings, is kept.
const INHERITED_SESSION_MARKS = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SSE_PORT",
];

export const buildSessionEnv = (
  env: Record<string, string | undefined>,
  sessionVariables: Record<string, string>,
): Record<string, string | undefined> => {
  const keptEntries = Object.entries(env).filter(([envKey]) => !INHERITED_SESSION_MARKS.includes(envKey));
  return { ...Object.fromEntries(keptEntries), ...sessionVariables };
};

// A shell that lowers the open-file limit, soft then hard (the hard limit can't
// go below the soft one), then runs the command that follows. A hard limit can't
// be raised again from inside, so the session and everything it starts stay
// under it. If a limit is already lower, the shell leaves it and runs anyway.
export const withOpenFileLimit = (maxOpenFiles: number): string[] => [
  "/bin/sh",
  "-c",
  `ulimit -Sn ${maxOpenFiles} 2>/dev/null; ulimit -Hn ${maxOpenFiles} 2>/dev/null; exec "$@"`,
  "talos-session",
];

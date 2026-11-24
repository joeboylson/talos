// How the talos command talks back (see docs/CLI_RULES.md): its flags, its
// errors and exit codes, and lists as tables for people or plain lines for
// scripts.

// The flags any command may take. --json, --help and --version are anyone's;
// --owner answers pairing's one question, --name names a new session, --add
// answers yes to adding a session's folder, --runner picks the session
// runner's log; --cron, --runs and --until set a loop's schedule and limit,
// and -f (--file) a file its message comes from.
export type Flags = {
  json: boolean;
  help: boolean;
  version: boolean;
  runner: boolean;
  add: boolean;
  owner?: string;
  name?: string;
  cron?: string;
  runs?: string;
  until?: string;
  file?: string;
};
export type ParsedArgs = { words: string[]; flags: Flags };

export const EXIT_CODES = { done: 0, failed: 1, usage: 2 } as const;

// Something the person can fix: one line, and the command that fixes it.
// A usage error (a command typed wrong) exits 2, any other 1.
export type CliError = Error & { fix?: string; exitCode: number };
export const cliError = (message: string, fix?: string, exitCode: number = EXIT_CODES.failed): CliError =>
  Object.assign(new Error(message), { exitCode, ...(fix && { fix }) });
const isCliError = (error: unknown): error is CliError => error instanceof Error && typeof Reflect.get(error, "exitCode") === "number";
export const usageError = (message: string, fix = "talos help"): CliError => cliError(message, fix, EXIT_CODES.usage);

const VALUE_FLAGS = { "--owner": "owner", "--name": "name", "--cron": "cron", "--runs": "runs", "--until": "until", "--file": "file", "-f": "file" } as const;
const SWITCH_FLAGS = { "--json": "json", "--help": "help", "-h": "help", "--version": "version", "-V": "version", "--runner": "runner", "--add": "add" } as const;

// Words stay in order; flags may come anywhere. A word is a flag only when it's
// a dash and a letter (so "-1 is wrong" is a word), and `--` makes every word
// after it a word. An unknown flag, or one missing its value, is a usage error.
const looksLikeFlag = (arg: string): boolean => /^--?[A-Za-z]/.test(arg);
export const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const empty: ParsedArgs = { words: [], flags: { json: false, help: false, version: false, runner: false, add: false } };
  const read = (rest: readonly string[], parsed: ParsedArgs): ParsedArgs => {
    const [arg, ...after] = rest;
    if (arg === undefined) return parsed;
    if (arg === "--") return { ...parsed, words: [...parsed.words, ...after] };
    if (arg in SWITCH_FLAGS) return read(after, { ...parsed, flags: { ...parsed.flags, [SWITCH_FLAGS[arg as keyof typeof SWITCH_FLAGS]]: true } });
    if (arg in VALUE_FLAGS) {
      const [value, ...afterValue] = after;
      if (value === undefined || value.startsWith("-")) throw usageError(`${arg} needs a value`);
      return read(afterValue, { ...parsed, flags: { ...parsed.flags, [VALUE_FLAGS[arg as keyof typeof VALUE_FLAGS]]: value } });
    }
    if (looksLikeFlag(arg)) throw usageError(`there's no ${arg} option`);
    return read(after, { ...parsed, words: [...parsed.words, arg] });
  };
  return read(argv, empty);
};

// What goes to stderr for an error: its line, then the fix. A stack trace only
// with TALOS_DEBUG, for a bug rather than something the person can fix.
export const describeError = (error: unknown, isDebug: boolean): { text: string; exitCode: number } => {
  if (isCliError(error)) {
    const message = error.message.replace(/^talos: /, "");
    return { text: [`talos: ${message}`, ...(error.fix ? [`  run: ${error.fix}`] : [])].join("\n"), exitCode: error.exitCode };
  }
  const message = (error instanceof Error ? error.message : String(error)).replace(/^talos: /, "");
  const stack = isDebug && error instanceof Error && error.stack ? `\n${error.stack}` : "";
  return { text: `talos: ${message}${stack}`, exitCode: EXIT_CODES.failed };
};

// A list for people: a header row and aligned columns. Piped: tab-separated
// lines, no header, so `cut` and `awk` read it as they always have.
export const formatTable = (headers: readonly string[], rows: readonly (readonly string[])[], isTerminal: boolean): string => {
  if (!isTerminal) return rows.map((row) => row.join("\t")).join("\n");
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join("  ")
      .trimEnd();
  return [line(headers.map((header) => header.toUpperCase())), ...rows.map(line)].join("\n");
};

// The number of single-letter edits between two words.
const editDistance = (a: string, b: string): number => {
  const firstRow = Array.from({ length: b.length + 1 }, (_, index) => index);
  const lastRow = [...a].reduce(
    (previous, letterOfA, rowIndex) =>
      [...b].reduce(
        (row, letterOfB, column) => [...row, Math.min(previous[column + 1]! + 1, row[column]! + 1, previous[column]! + (letterOfA === letterOfB ? 0 : 1))],
        [rowIndex + 1],
      ),
    firstRow,
  );
  return lastRow[b.length]!;
};

// The known command closest to what was typed, if one is close enough to be a typo.
export const closestCommand = (typed: string, known: readonly string[]): string | null => {
  const scored = known.map((command) => ({ command, distance: editDistance(typed, command) }));
  const best = scored.reduce<{ command: string; distance: number } | null>((closest, next) => (!closest || next.distance < closest.distance ? next : closest), null);
  // At most two letters off, and fewer for a short word, so a guess is a typo
  // and not just another word.
  const isTypo = best !== null && best.distance <= Math.min(2, Math.max(1, Math.floor(typed.length / 3)));
  return isTypo ? best.command : null;
};

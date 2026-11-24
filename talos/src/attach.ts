// The terminal side of attach (see attach-view.ts): follows the runner's
// events for one session, prints its conversation as it grows, keeps the
// session's state in the prompt, and acts on each line typed. Ctrl+P opens
// the command list (attach-palette.ts).
import { createInterface, type Interface } from "node:readline";
import { openPalette } from "./attach-palette";
import { cliError } from "./cli";
import { entryLines, isTurnRunning, paintFor, permissionLine, promptFor, readTyped, statusLine, type AttachAction } from "./attach-view";
import type { RunnerEvent, SessionEntry, SessionSummary, SessionsConnection } from "./talos-sessions";

// How much of the conversation shows when you attach.
const ENTRIES_SHOWN_AT_START = 30;

export const attachToSession = async (sessions: SessionsConnection, sessionName: string): Promise<void> => {
  if (!process.stdin.isTTY) throw cliError("attach needs a terminal", `talos sessions ${sessionName} send "<text>"`, 2);
  // Set by openInput below, before any event can arrive.
  let lines!: Interface;
  // While the command list is open, Clack owns the terminal, so lines wait
  // here and print once it closes.
  let isMenuOpen = false;
  const heldLines: string[] = [];
  // Prints above the line being typed, then puts the typed line back.
  const print = (text: string[]) => {
    if (isMenuOpen) return void heldLines.push(...text);
    process.stdout.write("\r\x1b[2K");
    text.forEach((line) => process.stdout.write(`${line}\n`));
    lines.prompt(true);
  };

  const paint = paintFor(process.stdout.isTTY === true && !process.env.NO_COLOR);
  let session: SessionSummary | null = null;
  let shownPrompt = "";
  let shownStatus: string | null = null;
  const shownAsks = new Set<string>();
  // A tool shows once it has finished; until then it's the running one.
  const shownEntries = new Set<string>();
  const runningTools = new Map<string, string>();
  let isFirstBatch = true;
  // The state changes in the prompt; a permission question also prints once,
  // since it waits on you.
  const showState = () => {
    if (!session || isMenuOpen) return;
    const asks = (session.permissionAsks ?? []).filter(({ id }) => !shownAsks.has(id));
    asks.forEach(({ id }) => shownAsks.add(id));
    if (asks.length > 0) print(asks.map(({ tool, summary }) => permissionLine(tool, summary, paint)));
    const prompt = promptFor(session, [...runningTools.values()].at(-1) ?? null, paint);
    if (prompt === shownPrompt) return;
    lines.setPrompt((shownPrompt = prompt));
    lines.prompt(true);
  };
  const showEntries = (entries: readonly SessionEntry[]) => {
    const fresh = [...entries].sort((a, b) => a.position - b.position).filter(({ entryId }) => !shownEntries.has(entryId));
    fresh.forEach((entry) => {
      const isRunning = entry.kind === "tool" && entry.outcome === "running";
      if (isRunning) runningTools.set(entry.entryId, `${entry.toolName}${entry.summary ? ` ${entry.summary}` : ""}`);
      else runningTools.delete(entry.entryId);
      if (!isRunning) shownEntries.add(entry.entryId);
    });
    const finished = fresh.filter((entry) => shownEntries.has(entry.entryId));
    const shown = isFirstBatch ? finished.slice(-ENTRIES_SHOWN_AT_START) : finished;
    isFirstBatch = false;
    const lines = shown.flatMap((entry) => entryLines(entry, paint));
    if (lines.length > 0) print(lines);
    showState();
  };

  let leave = (_why: string): void => {};
  let stopFollowing = (): void => {};
  const ended = new Promise<string>((resolve) => {
    leave = resolve;
  });
  {
    const onEvent = (event: RunnerEvent) => {
      if (event.type === "session-entries" && event.sessionName === sessionName) showEntries(event.entries);
      if (event.type === "notice" && event.sessionName === sessionName) print([paint.dim(`  (${event.message})`)]);
      if (event.type === "message-returned" && event.sessionName === sessionName) print([paint.dim(`  (not sent: ${event.text})`)]);
      if (event.type !== "sessions") return;
      session = event.sessions.find((one) => one.sessionName === sessionName) ?? null;
      if (!session) return leave(`${sessionName} ended`);
      const status = statusLine(session, paint);
      if (status && status !== shownStatus) print([(shownStatus = status)]);
      showState();
    };
    const following = sessions.follow(onEvent);
    void following.ended.then(() => leave("the session runner stopped"));
    stopFollowing = following.stop;
  }

  const act = async (action: AttachAction) => {
    if (action.do === "nothing") return;
    const result =
      action.do === "send"
        ? await sessions.send(sessionName, action.text)
        : action.do === "answer"
          ? await sessions.answer(sessionName, action.outputId, action.choice)
          : await sessions.answerPermission(sessionName, action.id, action.isAllowed);
    if (!result.ok) print([paint.red(`  (${result.reason})`)]);
  };
  // What you typed goes: it comes back in the conversation as your message.
  const visibleLength = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").length;
  const onLine = (typed: string) => {
    const rows = Math.max(1, Math.ceil((visibleLength(shownPrompt) + typed.length) / (process.stdout.columns || 80)));
    process.stdout.write(`\x1b[${rows}A\r\x1b[J`);
    if (session) void act(readTyped(typed, session)).catch((error: unknown) => print([paint.red(`  (${String(error)})`)]));
    lines.prompt();
  };
  // Ctrl-C stops the running turn; with none running, it leaves, as Ctrl-D does.
  const onInterrupt = () => {
    if (session && isTurnRunning(session)) void sessions.interrupt(sessionName);
    else lines.close();
  };
  // Clack reads the keyboard itself, so the input line closes while the
  // command list is open and a new one opens after, with your text in it.
  // Each new line keeps the last one's history, so the up arrow still finds earlier messages.
  const openInput = (typedSoFar: string, history: string[]) => {
    lines = createInterface({ input: process.stdin, output: process.stdout, prompt: shownPrompt || "› ", history });
    lines.on("line", onLine);
    lines.on("SIGINT", onInterrupt);
    lines.on("close", () => {
      if (isMenuOpen) return;
      stopFollowing();
      leave(`left ${sessionName} running`);
    });
    lines.prompt();
    if (typedSoFar) lines.write(typedSoFar);
  };
  const openMenu = async () => {
    isMenuOpen = true;
    const typedSoFar = lines.line;
    const history = [...(lines as Interface & { history: string[] }).history];
    lines.close();
    // The input line also takes Ctrl+P (as "the line before") and redraws once
    // this handler returns, so the row is cleared after that.
    await new Promise((resolve) => setImmediate(resolve));
    process.stdout.write("\r\x1b[2K");
    const said = await openPalette(sessionName).catch((error: unknown) => paint.red(`(${String(error)})`));
    isMenuOpen = false;
    const waiting = heldLines.splice(0);
    openInput(typedSoFar, history);
    const shown = [...waiting, ...(said ? [paint.dim(`  ${said}`)] : [])];
    if (shown.length > 0) print(shown);
    showState();
  };
  // Ahead of the input line's own keys, so the text typed so far is read before Ctrl+P changes it.
  process.stdin.prependListener("keypress", (_typed: string, key?: { ctrl?: boolean; name?: string }) => {
    if (key?.ctrl && key.name === "p" && !isMenuOpen) void openMenu();
  });

  openInput("", []);
  const why = await ended;
  lines.close();
  // The session can end while the command list is open, with Clack's key mode
  // on and its cursor hidden, so both are put back.
  process.stdout.write(`\r\x1b[2K\x1b[?25h[talos] ${why}\n`);
  process.stdin.setRawMode(false);
  process.exit(0);
};

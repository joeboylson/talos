// The terminal side of attach (see attach-view.ts): follows the runner's
// events for one session, prints its conversation as it grows, keeps the
// session's state in the prompt, and acts on each line typed.
import { createInterface } from "node:readline";
import { cliError } from "./cli";
import { entryLines, isTurnRunning, paintFor, permissionLine, promptFor, readTyped, statusLine, type AttachAction } from "./attach-view";
import type { RunnerEvent, SessionEntry, SessionSummary, SessionsConnection } from "./talos-sessions";

// How much of the conversation shows when you attach.
const ENTRIES_SHOWN_AT_START = 30;

export const attachToSession = async (sessions: SessionsConnection, sessionName: string): Promise<void> => {
  if (!process.stdin.isTTY) throw cliError("attach needs a terminal", `talos sessions ${sessionName} send "<text>"`, 2);
  const lines = createInterface({ input: process.stdin, output: process.stdout, prompt: "› " });
  // Prints above the line being typed, then puts the typed line back.
  const print = (text: string[]) => {
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
    if (!session) return;
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

  const ended = new Promise<string>((resolve) => {
    const onEvent = (event: RunnerEvent) => {
      if (event.type === "session-entries" && event.sessionName === sessionName) showEntries(event.entries);
      if (event.type === "notice" && event.sessionName === sessionName) print([paint.dim(`  (${event.message})`)]);
      if (event.type === "message-returned" && event.sessionName === sessionName) print([paint.dim(`  (not sent: ${event.text})`)]);
      if (event.type !== "sessions") return;
      session = event.sessions.find((one) => one.sessionName === sessionName) ?? null;
      if (!session) return resolve(`${sessionName} ended`);
      const status = statusLine(session, paint);
      if (status && status !== shownStatus) print([(shownStatus = status)]);
      showState();
    };
    const following = sessions.follow(onEvent);
    void following.ended.then(() => resolve("the session runner stopped"));
    lines.on("close", () => {
      following.stop();
      resolve(`left ${sessionName} running`);
    });
  });

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
  lines.on("line", (typed) => {
    const rows = Math.max(1, Math.ceil((visibleLength(shownPrompt) + typed.length) / (process.stdout.columns || 80)));
    process.stdout.write(`\x1b[${rows}A\r\x1b[J`);
    if (session) void act(readTyped(typed, session)).catch((error: unknown) => print([paint.red(`  (${String(error)})`)]));
    lines.prompt();
  });
  // Ctrl-C stops the running turn; with none running, it leaves, as Ctrl-D does.
  lines.on("SIGINT", () => {
    if (session && isTurnRunning(session)) void sessions.interrupt(sessionName);
    else lines.close();
  });

  lines.prompt();
  const why = await ended;
  lines.close();
  process.stdout.write(`\r\x1b[2K[talos] ${why}\n`);
  process.exit(0);
};

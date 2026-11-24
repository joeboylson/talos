// The terminal side of attach (see attach-view.ts): follows the runner's
// events for one session, prints its conversation as it grows and a line
// when what it waits on changes, and acts on each line typed.
import { createInterface } from "node:readline";
import { cliError } from "./cli";
import { entryLines, isTurnRunning, readTyped, stateLine, type AttachAction } from "./attach-view";
import type { RunnerEvent, SessionEntry, SessionSummary, SessionsConnection } from "./talos-sessions";

// How much of the conversation shows when you attach.
const ENTRIES_SHOWN_AT_START = 30;

export const attachToSession = async (sessions: SessionsConnection, sessionName: string): Promise<void> => {
  if (!process.stdin.isTTY) throw cliError("attach needs a terminal", `talos sessions ${sessionName} send "<text>"`, 2);
  const lines = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  // Prints above the line being typed, then puts the typed line back.
  const print = (text: string[]) => {
    process.stdout.write("\r\x1b[2K");
    text.forEach((line) => process.stdout.write(`${line}\n`));
    lines.prompt(true);
  };

  let session: SessionSummary | null = null;
  let shownState = "";
  const shownEntries = new Set<string>();
  let isFirstBatch = true;
  const showEntries = (entries: readonly SessionEntry[]) => {
    const fresh = [...entries].sort((a, b) => a.position - b.position).filter(({ entryId }) => !shownEntries.has(entryId));
    fresh.forEach(({ entryId }) => shownEntries.add(entryId));
    const shown = isFirstBatch ? fresh.slice(-ENTRIES_SHOWN_AT_START) : fresh;
    isFirstBatch = false;
    if (shown.length > 0) print(shown.flatMap(entryLines));
  };

  const ended = new Promise<string>((resolve) => {
    const onEvent = (event: RunnerEvent) => {
      if (event.type === "session-entries" && event.sessionName === sessionName) showEntries(event.entries);
      if (event.type === "notice" && event.sessionName === sessionName) print([`  (${event.message})`]);
      if (event.type === "message-returned" && event.sessionName === sessionName) print([`  (not sent: ${event.text})`]);
      if (event.type !== "sessions") return;
      session = event.sessions.find((one) => one.sessionName === sessionName) ?? null;
      if (!session) return resolve(`${sessionName} ended`);
      const line = stateLine(session);
      if (line !== shownState) print([`  — ${(shownState = line)}`]);
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
    if (!result.ok) print([`  (${result.reason})`]);
  };
  lines.on("line", (typed) => {
    if (session) void act(readTyped(typed, session)).catch((error: unknown) => print([`  (${String(error)})`]));
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

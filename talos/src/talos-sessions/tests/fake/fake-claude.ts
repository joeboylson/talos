// A stand-in for Claude Code, for the fake-runner tests: it reports to the
// session runner through the same hooks, and saves its conversation the same
// way, but follows a fixed script instead of thinking.
// - "go": a line of text, a note (an output that doesn't wait) and a question.
// - "go2": two questions.
// - the status request: sends a status.
// - an answer: runs Bash, as a normal turn would.
// - "prompt": a permission prompt before a Bash call ("go-prompt": a question
//   first, "slow-prompt": 300 ms of work first): Enter or "1" approves it
//   (APPROVED), Esc refuses it and ends the turn with no Stop (REFUSED), as
//   Claude Code does.
// - "rate-limit": a turn that ends on an API error, with StopFailure and no
//   Stop, as Claude Code does.
// - "clear" / "resume": a last line in the current conversation file, then a
//   switch to a second file / back to the first, as /clear and /resume do.
// Anything else is a prompt it just answers by ending its turn.
// It saves its process id in claude.pid. In a folder named stubborn… it ignores
// being told to stop; in one named spawner… it starts a process that ignores
// the terminal closing, and saves that one's id in child.pid. Text typed while
// a turn runs joins it (see below) and is also saved as a "BUSY" line, and a
// tool talos denies as a "DENIED" line, so a test can see both.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { askRunner } from "../../client/hook-client";
import { SESSION_ENV_KEYS } from "../../constants";

// fake-runner.ts gives the status kind this request.
const STATUS_REQUEST = "please send status";

const sessionName = process.env[SESSION_ENV_KEYS.sessionName] ?? "";
const runnerSocket = process.env[SESSION_ENV_KEYS.runnerSocket] ?? "";
const token = process.env[SESSION_ENV_KEYS.hookToken] ?? "";
const firstTranscript = join(process.cwd(), "transcript.jsonl");
const secondTranscript = join(process.cwd(), "transcript-2.jsonl");
let transcriptPath = firstTranscript;

let lineNumber = 0;
const saveLine = (line: object) => {
  lineNumber += 1;
  appendFileSync(transcriptPath, `${JSON.stringify({ uuid: `line-${lineNumber}`, ...line })}\n`);
};
const saveText = (text: string) => saveLine({ type: "assistant", message: { content: [{ type: "text", text }] } });

const hook = async (details: object): Promise<string> => {
  const answer = await askRunner(runnerSocket, { sessionName, token, details: JSON.stringify({ transcript_path: transcriptPath, ...details }) });
  return answer?.kind === "reply" ? answer.reply : "";
};

// Calls one tool as Claude Code would: its PreToolUse, then (if allowed) its
// call saved in the conversation and its PostToolUse with the input the hook
// handed back. Only structured tools are saved, the rest only need the hook.
let toolCount = 0;
const callTool = async (toolName: string, input: object, toolUseId = `tool-${++toolCount}`) => {
  const reply = JSON.parse((await hook({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: input, tool_use_id: toolUseId })) || "{}");
  const decision = reply.hookSpecificOutput?.permissionDecision;
  if (decision === "deny") return saveText(`DENIED ${toolName}`);
  if (!toolName.startsWith("mcp__")) return;
  saveLine({ type: "assistant", message: { content: [{ type: "tool_use", id: toolUseId, name: toolName, input }] } });
  await hook({ hook_event_name: "PostToolUse", tool_name: toolName, tool_input: reply.hookSpecificOutput.updatedInput, tool_use_id: toolUseId });
};

// An image's path, as talos types it, must be there when the message arrives.
const notePastedImages = (text: string) =>
  text.split(/\s+/).filter((word) => /\.(png|jpg|gif|webp)$/.test(word) && !existsSync(word)).forEach((path) => saveText(`MISSING ${path}`));

const runTurn = async (text: string) => {
  await hook({ hook_event_name: "UserPromptSubmit", prompt: text });
  saveLine({ type: "user", message: { content: text } });
  notePastedImages(text);
  if (text === "go") {
    saveText("Here is a note, then a question.");
    await callTool("mcp__talos__send_note", { text: "a note" }, "tool-note");
    await callTool("mcp__talos__ask_question", { question: "Which one?", choices: ["A", "B"] }, "tool-question");
  }
  if (text === "go2") {
    await callTool("mcp__talos__ask_question", { question: "First?", choices: ["A", "B"] });
    await callTool("mcp__talos__ask_question", { question: "Second?", choices: ["C", "D"] });
  }
  if (text === STATUS_REQUEST) await callTool("mcp__talos__send_status", { text: "all good" });
  if (text.startsWith("Answer to")) await callTool("Bash", { command: "ls" });
  // A question, then Claude Code compacting the conversation (a SessionStart mid-turn).
  if (text === "go-compact") {
    await callTool("mcp__talos__ask_question", { question: "Which one?", choices: ["A", "B"] });
    await hook({ hook_event_name: "SessionStart", source: "compact" });
  }
  if (text === "go-prompt") await callTool("mcp__talos__ask_question", { question: "Which one?", choices: ["A", "B"] });
  if (text === "slow-prompt") await Bun.sleep(300);
  if (text === "prompt" || text === "go-prompt" || text === "slow-prompt") {
    await hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
    const key = await new Promise<string>((resolve) => (answerPrompt = resolve));
    if (key.includes("\x1b") && !key.includes("\r")) return saveText("REFUSED");
    saveText("APPROVED");
  }
  if (text === "clear" || text === "resume") {
    saveText(`said before ${text}`);
    transcriptPath = text === "clear" ? secondTranscript : firstTranscript;
    await hook({ hook_event_name: "SessionStart", source: text });
  }
  // A turn takes a moment, so text typed into it would be seen as busy.
  await Bun.sleep(300);
  if (text === "rate-limit") return void (await hook({ hook_event_name: "StopFailure", error: "rate_limit" }));
  // A Stop the lane blocks keeps the turn going, as Claude Code does.
  if (await hook({ hook_event_name: "Stop" })) await hook({ hook_event_name: "Stop" });
  process.stdout.write("done\n");
};

// In a folder named noisy… its screen never settles: it writes all the time,
// from before it reports its start.
if (basename(process.cwd()).startsWith("noisy")) {
  process.stdout.write(".\n");
  setInterval(() => process.stdout.write(".\n"), 100);
}
// In a folder named prompting… it asks permission right after it reports its
// start, while its screen is still drawing (for 2 s).
const isPrompting = basename(process.cwd()).startsWith("prompting");
if (isPrompting) {
  const drawing = setInterval(() => process.stdout.write(".\n"), 100);
  setTimeout(() => clearInterval(drawing), 2000);
}
writeFileSync(join(process.cwd(), "claude.pid"), String(process.pid));
if (basename(process.cwd()).startsWith("stubborn")) for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, () => {});
if (basename(process.cwd()).startsWith("spawner")) {
  const child = Bun.spawn(["sh", "-c", "trap '' HUP TERM; sleep 60"], { stdio: ["ignore", "ignore", "ignore"] });
  writeFileSync(join(process.cwd(), "child.pid"), String(child.pid));
}
writeFileSync(firstTranscript, "");
writeFileSync(secondTranscript, "");
// In a folder named mute… it never reports its start, like a Claude Code stuck
// on a screen before its hooks run.
// In a folder named late… it reports its start after 1.5 s.
if (basename(process.cwd()).startsWith("late")) await Bun.sleep(1500);
if (!basename(process.cwd()).startsWith("mute")) await hook({ hook_event_name: "SessionStart" });
if (isPrompting) await hook({ hook_event_name: "Notification", message: "Claude needs your permission to use Bash" });
process.stdin.setRawMode?.(true);
process.stdout.write("ready\n");

// What the session runner types: Esc, then the message in bracketed paste, then
// Enter. Turns run one after another.
let turnsWaiting = 0;
// Set while a permission prompt shows: the next keys go to it.
let answerPrompt: ((key: string) => void) | null = null;
let typed = "";
let turns = Promise.resolve();
process.stdin.on("data", (chunk: Buffer) => {
  if (answerPrompt) {
    const answer = answerPrompt;
    answerPrompt = null;
    return answer(chunk.toString());
  }
  typed += chunk.toString();
  const lines = typed.split("\r");
  typed = lines.pop() ?? "";
  for (const line of lines) {
    const text = line.replace(/\x1b\[20[01]~/g, "").replace(/\x1b/g, "").trim();
    if (!text) continue;
    // Text typed into a running turn joins it, as in Claude Code: it's reported
    // as a start at once and saved as a queued command, with no turn of its own.
    if (turnsWaiting > 0) {
      saveText(`BUSY ${text}`);
      void hook({ hook_event_name: "UserPromptSubmit", prompt: text });
      saveLine({ type: "attachment", attachment: { type: "queued_command", prompt: text, commandMode: "prompt" } });
      continue;
    }
    turnsWaiting += 1;
    turns = turns.then(() => runTurn(text)).finally(() => (turnsWaiting -= 1));
  }
});

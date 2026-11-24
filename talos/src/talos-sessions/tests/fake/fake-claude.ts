// A stand-in for Claude Code run headless, for the fake-runner tests: it reads
// JSON lines on its input and writes its stream on its output as Claude Code
// does, links to the runner as talos's mod does (fake-mod.ts), and follows a
// fixed script instead of thinking.
// - "go": a line of text, a note (an output that doesn't wait) and a question.
// - "go2": two questions.
// - the status request: sends a status. In a folder named nosy… it tries Bash
//   first, which talos's mod denies in an asked-for turn.
// - an answer: runs Bash, as a normal turn would.
// - "prompt": a permission question before a Bash call ("go-prompt": a
//   question first, "slow-prompt": 300 ms of work first): allowed, the turn
//   says APPROVED; denied, REFUSED.
// - "rate-limit": a turn that ends on an API error.
// - "deaf": a turn that works for 1 s and ends on its own, interrupted or not.
// - "long": a turn that works for 3 s, unless talos interrupts it.
// - "wake-later": a turn, then at once one Claude Code starts on its own (like
//   a background task's notice), which runs for a second.
// - "go-compact": a question, then Claude Code compacting the conversation.
// Anything else is a message it answers by ending its turn.
// A message that arrives while a turn runs joins it, as in Claude Code: it's
// saved as a "BUSY" line and starts no turn. Each message is noted in
// submits.log as it arrives, with how many before it haven't started
// ("<text> behind <n>"). Every stream line is also saved in transcript.jsonl,
// and every input line in input.jsonl.
// It saves its process id in claude.pid. In a folder named stubborn… it ignores
// being told to stop; in one named spawner… it starts a process that ignores
// the terminal closing, and saves that one's id in child.pid. In one named
// late… it says it's ready after 1.5 s; in one named mute…, never. In one named
// prompting… it starts a turn on its own with a permission question at once.
import { appendFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { callTalosTool, linkLikeTheMod, mayCallTool } from "./fake-mod";

// fake-runner.ts gives the status kind this request.
const STATUS_REQUEST = "please send status";
const folderName = basename(process.cwd());
const isFolder = (prefix: string) => folderName.startsWith(prefix);
const transcriptFile = join(process.cwd(), "transcript.jsonl");

const emit = (line: Record<string, unknown>) => {
  const text = JSON.stringify({ uuid: crypto.randomUUID(), session_id: "fake-session", ...line });
  appendFileSync(transcriptFile, `${text}\n`);
  process.stdout.write(`${text}\n`);
};
const saveText = (text: string) => emit({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } });
// Shaped as Claude Code's own result line, which the Agent SDK reads too.
const endTurn = (isError = false) =>
  emit({
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    is_error: isError,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    permission_denials: [],
    ...(isError ? { errors: ["the turn ended early"] } : { result: "" }),
  });

// Control requests it sends (permission questions) wait for their answer.
const awaitingAnswers = new Map<string, (response: Record<string, unknown>) => void>();
let requestCount = 0;
const askPermission = (toolUseId: string): Promise<boolean> => {
  const requestId = `perm-request-${++requestCount}`;
  emit({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: toolUseId, input: { command: "ls" } } });
  return new Promise((resolve) => awaitingAnswers.set(requestId, (response) => resolve(response.behavior === "allow")));
};

// A call to talos's own tool is the runner's to answer; any other is denied
// while talos asks for one kind of answer. Only talos's tools are saved.
let toolCount = 0;
const callTool = async (toolName: string, input: object, toolUseId = `tool-${++toolCount}`) => {
  if (!toolName.startsWith("mcp__")) return (await mayCallTool(toolName)) ? undefined : saveText(`DENIED ${toolName}`);
  emit({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: toolUseId, name: toolName, input }] } });
  const answer = await callTalosTool(toolName, toolUseId, input);
  const isDenied = typeof answer.result !== "string";
  emit({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: String(answer.result ?? answer.deny), is_error: isDenied }] } });
  if (isDenied) saveText(`DENIED ${toolName}`);
};

// Set while a "long" turn runs: an interrupt ends it.
let interruptTurn: (() => void) | null = null;

const runTurnSteps = async (text: string): Promise<boolean> => {
  if (text === "go") {
    saveText("Here is a note, then a question.");
    await callTool("mcp__talos__send_note", { text: "a note" }, "tool-note");
    await callTool("mcp__talos__ask_question", { question: "Which one?", choices: ["A", "B"] }, "tool-question");
  }
  if (text === "go2") {
    await callTool("mcp__talos__ask_question", { question: "First?", choices: ["A", "B"] });
    await callTool("mcp__talos__ask_question", { question: "Second?", choices: ["C", "D"] });
  }
  if (text === STATUS_REQUEST && isFolder("nosy")) await callTool("Bash", { command: "ls" });
  if (text === STATUS_REQUEST) await callTool("mcp__talos__send_status", { text: "all good" });
  if (text.startsWith("Answer to")) await callTool("Bash", { command: "ls" });
  if (text === "go-compact") {
    await callTool("mcp__talos__ask_question", { question: "Which one?", choices: ["A", "B"] });
    emit({ type: "system", subtype: "compact_boundary" });
  }
  if (text === "go-prompt") await callTool("mcp__talos__ask_question", { question: "Which one?", choices: ["A", "B"] });
  if (text === "slow-prompt") await Bun.sleep(300);
  if (text === "prompt" || text === "go-prompt" || text === "slow-prompt") saveText((await askPermission(`perm-${++toolCount}`)) ? "APPROVED" : "REFUSED");
  if (text === "deaf") await Bun.sleep(1000);
  if (text === "long") {
    const isInterrupted = await Promise.race([Bun.sleep(3000).then(() => false), new Promise<boolean>((resolve) => (interruptTurn = () => resolve(true)))]);
    interruptTurn = null;
    if (isInterrupted) {
      emit({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } });
      return true;
    }
  }
  // A turn takes a moment, so a message sent into it would be seen as busy.
  await Bun.sleep(300);
  return text === "rate-limit";
};

let isTurnRunning = false;
let turns = Promise.resolve();
let messagesNotStarted = 0;

const runTurn = async (text: string, content: unknown) => {
  messagesNotStarted -= 1;
  isTurnRunning = true;
  emit({ type: "user", isReplay: true, parent_tool_use_id: null, message: { role: "user", content } });
  const isError = await runTurnSteps(text);
  if (!isError) saveText("done");
  endTurn(isError);
  if (text === "wake-later") {
    saveText("a background task finished");
    await Bun.sleep(1000);
    endTurn();
    // A moment before a waiting turn starts, as in Claude Code.
    await Bun.sleep(500);
  }
  isTurnRunning = false;
};

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.flatMap((block) => (block?.type === "text" ? [String(block.text)] : [])).join("\n")
      : "";

const onUserMessage = (content: unknown) => {
  const text = textOf(content).trim();
  appendFileSync(join(process.cwd(), "submits.log"), `${text} behind ${messagesNotStarted}\n`);
  if (isTurnRunning) return saveText(`BUSY ${text}`);
  messagesNotStarted += 1;
  turns = turns.then(() => runTurn(text, content));
};

// Its answer to the start request, given once it's linked.
let takeStartAnswer: (answer: () => void) => void = () => {};
const startAnswer = new Promise<() => void>((resolve) => (takeStartAnswer = resolve));
const onControlRequest = (requestId: string, request: Record<string, unknown>) => {
  const answer = () => process.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response: {} } })}\n`);
  if (request.subtype === "initialize") return takeStartAnswer(answer);
  if (request.subtype === "interrupt") interruptTurn?.();
  answer();
};

const onLine = (line: Record<string, unknown>) => {
  if (line.type === "user") return onUserMessage((line.message as { content?: unknown })?.content);
  if (line.type === "control_request") return onControlRequest(String(line.request_id), (line.request ?? {}) as Record<string, unknown>);
  if (line.type === "control_response") {
    const { request_id: requestId, response } = (line.response ?? {}) as { request_id?: string; response?: Record<string, unknown> };
    const answered = requestId ? awaitingAnswers.get(requestId) : undefined;
    if (requestId) awaitingAnswers.delete(requestId);
    answered?.(response ?? {});
  }
};

writeFileSync(join(process.cwd(), "claude.pid"), String(process.pid));
writeFileSync(transcriptFile, "");
if (isFolder("stubborn")) for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, () => {});
if (isFolder("spawner")) {
  const child = Bun.spawn(["sh", "-c", "trap '' HUP TERM; sleep 60"], { stdio: ["ignore", "ignore", "ignore"] });
  writeFileSync(join(process.cwd(), "child.pid"), String(child.pid));
}

// Its input, a line at a time.
void (async () => {
  let unread = "";
  for await (const chunk of Bun.stdin.stream()) {
    const lines = (unread + new TextDecoder().decode(chunk)).split("\n");
    unread = lines.pop() ?? "";
    for (const line of lines.filter((text) => text.trim())) {
      appendFileSync(join(process.cwd(), "input.jsonl"), `${line}\n`);
      onLine(JSON.parse(line));
    }
  }
  process.exit(0);
})();

// The prompting… folder's own turn, under way as it starts: a permission
// question before it says it's ready.
const runPromptingTurn = async () => {
  isTurnRunning = true;
  saveText((await askPermission("perm-0")) ? "APPROVED" : "REFUSED");
  endTurn();
  isTurnRunning = false;
};

if (!isFolder("mute")) {
  await linkLikeTheMod();
  if (isFolder("late")) await Bun.sleep(1500);
  const promptingTurn = isFolder("prompting") ? runPromptingTurn() : null;
  await Bun.sleep(promptingTurn ? 100 : 0);
  (await startAnswer)();
  await promptingTurn;
}

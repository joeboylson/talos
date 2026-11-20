// Live checks of talos-sessions with real Claude Code sessions, run by
// `make live-sessions`. Each prints PASS or FAIL; the run fails if any fails.
// They cost real Claude turns, so they're run by hand, not with make test.
import {
  allowFolder,
  answer,
  ask,
  check,
  finish,
  forgeHook,
  HOME,
  isRunnerRunning,
  makeFolder,
  rawSession,
  RUNNER_HOOKS_SOCKET,
  runHookScript,
  rawEvents,
  savedConversation,
  screen,
  send,
  startRunner,
  startSession,
  stopRunner,
  stopSession,
  tokenOf,
  typeKeys,
  waitFor,
} from "./harness";

const ASK_DECISION = "Use the ask_decision tool to ask me whether to use tabs or spaces, with exactly the choices Tabs and Spaces. Then end your turn.";
const TALOS_TOOL = "mcp__talos__ask_decision";
const preToolUse = (toolName: string, toolInput: object = {}) => ({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, tool_use_id: "forged" });
const decisionOf = (reply: string): string => {
  if (!reply) return "";
  const parsed = JSON.parse(reply);
  return parsed.hookSpecificOutput?.permissionDecision ?? parsed.decision ?? "";
};

const openDecision = async (sessionName: string) => {
  await send(sessionName, ASK_DECISION);
  return waitFor(sessionName, (session) => session.decision !== null && session.state === "needs-you");
};

// A normal session: a status, a decision answered by its id, the conversation.
const normalSession = async (label: string, projectSettings?: object) => {
  const name = `flow-${label}`;
  allowFolder(name, makeFolder(name, projectSettings));
  check(`${label}: a session starts and is ready`, (await startSession(name, name, `${HOME}/work/${name}`)) !== null);

  await ask(name, "status");
  const reported = await waitFor(name, (session) => session.status !== null && session.status.state !== "pending");
  check(`${label}: an asked-for status comes back`, ["working", "waiting", "done", "stuck"].includes(reported?.status?.state ?? ""), reported?.status?.state);
  await waitFor(name, (session) => session.state === "idle");

  const asked = await openDecision(name);
  const id = asked?.decision?.id ?? "";
  check(`${label}: a decision opens with an id`, id.length > 0);
  check(`${label}: the session saw that id`, (await savedConversation(`${HOME}/work/${name}`)).includes(`Asked as ${id}`));
  check(`${label}: a click is taken`, (await answer(name, id, 1)).ok);
  check(`${label}: a second click is refused`, (await answer(name, id, 0)).ok === false);
  const after = await waitFor(name, (session) => session.state === "idle" && session.decision === null);
  check(`${label}: the answer goes in and the question closes`, after !== null);

  const events = await rawEvents({ timeout: false } as RequestInit);
  const reader = events.body!.getReader();
  setTimeout(() => reader.cancel(), 1500);
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  check(`${label}: the conversation holds the decision as an output entry`, text.includes(`"kind":"output"`) && text.includes(id));
  check(`${label}: the structured tool's own call isn't in the conversation`, !text.includes(`"toolName":"${TALOS_TOOL}"`));
  await stopSession(name);
};

// An answer typed in the terminal ends a turn, and the question closes with it.
const typedAnswer = async () => {
  const name = "typed";
  allowFolder(name, makeFolder(name));
  await startSession(name, name, `${HOME}/work/${name}`);
  const asked = await openDecision(name);
  await typeKeys(name, `Answer to ${asked?.decision?.id}: Tabs`);
  await Bun.sleep(300);
  await typeKeys(name, "\r");
  const closed = await waitFor(name, (session) => session.state === "idle" && session.decision === null);
  check("an answer typed in the terminal closes the question once its turn ends", closed !== null);
  await stopSession(name);
};

// A permission prompt mid-turn: a queued ask and a held answer wait, so nothing
// is typed into the prompt (which would approve it).
const permissionPrompt = async () => {
  const name = "prompt";
  const path = makeFolder(name, { permissions: { defaultMode: "default", ask: ["Bash(touch:*)"] } });
  allowFolder(name, path);
  await startSession(name, name, path);
  const asked = await openDecision(name);
  const id = asked?.decision?.id ?? "";
  await send(name, "Run `touch made-by-test` with the Bash tool.");
  const prompted = await waitFor(name, (session) => session.state === "needs-you" && session.decision !== null, 60_000);
  await Bun.sleep(3000);
  check("a permission prompt shows mid-turn", prompted !== null && /Do you want|Yes/.test(await screen(name)));
  await ask(name, "status");
  check("a click during the prompt is held, not refused", (await answer(name, id, 0)).ok);
  await Bun.sleep(5000);
  const waiting = await rawSession(name);
  check("the queued ask waits", waiting?.asks.status?.state === "asking");
  check("nothing was typed into the prompt", !(await Bun.file(`${path}/made-by-test`).exists()));
  await typeKeys(name, "\x1b");
  await waitFor(name, (session) => session.state === "idle", 60_000);
  await Bun.sleep(3000);
  check("the prompt was never approved", !(await Bun.file(`${path}/made-by-test`).exists()));
  await stopSession(name);
};

// Another PreToolUse hook that rewrites the call's input (and so drops the id):
// nothing may open that the session didn't see.
const rewritingHook = async () => {
  const name = "rewrite";
  const rewrite = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { question: "Rewritten?", choices: ["A", "B"] } } });
  const path = makeFolder(name, { hooks: { PreToolUse: [{ matcher: "mcp__talos__.*", hooks: [{ type: "command", command: `echo '${rewrite}'` }] }] } });
  allowFolder(name, path);
  await startSession(name, name, path);
  await send(name, ASK_DECISION);
  await waitFor(name, (session) => session.state === "idle" || session.state === "needs-you");
  await Bun.sleep(3000);
  const session = await rawSession(name);
  const seen = await savedConversation(path);
  const opened = session?.openOutputs ?? [];
  check("a rewritten call opens nothing the session didn't see", opened.every((output) => seen.includes(`Asked as ${output.id}`)), `${opened.length} open`);
  await stopSession(name);
};

// What a hostile session can do with its own token.
const hostileSession = async () => {
  const name = "hostile";
  allowFolder(name, makeFolder(name));
  await startSession(name, name, `${HOME}/work/${name}`);
  const token = await tokenOf(name);

  const madeUpId = { hook_event_name: "PostToolUse", tool_use_id: "made-up", tool_input: { id: crypto.randomUUID() } };
  await forgeHook(name, token, madeUpId);
  check("a forged PostToolUse opens nothing", (await rawSession(name))?.openOutputs.length === 0);

  await ask(name, "status");
  await waitFor(name, (session) => session.asks.status?.state === "asking" && session.state === "working", 30_000);
  const firstStop = await forgeHook(name, token, { hook_event_name: "Stop" });
  const secondStop = await forgeHook(name, token, { hook_event_name: "Stop" });
  const bash = await forgeHook(name, token, preToolUse("Bash", { command: "ls" }));
  // When the forged Stops land (before the request is typed, or after the
  // answer) is a race, so whether the first is blocked isn't checked here; the
  // lane tests pin that. What must hold: forged Stops don't end the turn early.
  const stillLimited = firstStop?.kind === "reply" && secondStop?.kind === "reply" && bash?.kind === "reply";
  const statusNow = (await rawSession(name))?.asks.status?.state;
  check("forged Stops don't end an asked-for turn early", stillLimited && (decisionOf(bash.reply) === "deny" || statusNow === "answered"), statusNow);
  const reported = await waitFor(name, (session) => session.status?.state !== "pending");
  check("the real answer still comes back", reported !== null);
  await waitFor(name, (session) => session.state === "idle");

  const env = { TALOS_SESSION_NAME: name, TALOS_RUNNER_SOCKET: RUNNER_HOOKS_SOCKET, TALOS_HOOK_TOKEN: "wrong" };
  check("the hook script denies talos's tools for a bad token", decisionOf(await runHookScript(env, preToolUse(TALOS_TOOL))) === "deny");
  check("the hook script leaves other tools alone for a bad token", (await runHookScript(env, preToolUse("Bash"))) === "");

  const huge = await forgeHook(name, token, preToolUse("Bash", { command: "x".repeat(4 * 1024 * 1024) }));
  check("a 4 MB hook is turned down as too big", huge?.kind === "too-big");
  check("the runner is still up after it", await isRunnerRunning());

  // A flood of connections from a process with room for them, while real hooks
  // keep being answered.
  const flood = Bun.spawn(["/bin/sh", "-c", `ulimit -n 20000; exec "${process.execPath}" "${import.meta.dir}/flood.ts" "${RUNNER_HOOKS_SOCKET}" 11000`], { stdout: "ignore" });
  await Bun.sleep(3000);
  const answers = await Promise.all(Array.from({ length: 10 }, () => forgeHook(name, token, preToolUse("Bash"))));
  flood.kill();
  check("hooks are still answered during an 11,000-connection flood", answers.every((reply) => reply?.kind === "reply"), `${answers.filter((reply) => reply?.kind === "reply").length}/10`);

  // A reader that stops reading is cut off, and nothing else waits on it.
  const stalled = await rawEvents({ timeout: false } as RequestInit);
  await send(name, "Print the numbers 1 to 400, one per line, as plain text. No tools.");
  await waitFor(name, (session) => session.state === "idle");
  check("a reader that stops reading doesn't stall the runner", (await rawSession(name)) !== undefined && stalled.ok);
  void stalled.body?.cancel();

  // A replaced session: the old token and the old question are dead.
  const asked = await openDecision(name);
  const oldId = asked?.decision?.id ?? "";
  await stopSession(name);
  await waitFor(name, () => false, 3000);
  await startSession(name, name, `${HOME}/work/${name}`);
  const oldTokenStop = await forgeHook(name, token, { hook_event_name: "Stop" });
  check("the replaced session's old token does nothing", oldTokenStop?.kind === "reply" && oldTokenStop.reply === "");
  check("an answer to the old session's question is refused", (await answer(name, oldId, 0)).ok === false);
  await stopSession(name);
};

// With the session runner down, the hook script still fails safe.
const runnerDown = async () => {
  await stopRunner();
  await Bun.sleep(500);
  const env = { TALOS_SESSION_NAME: "anything", TALOS_RUNNER_SOCKET: RUNNER_HOOKS_SOCKET, TALOS_HOOK_TOKEN: "t" };
  check("with the runner down, talos's tools are denied", decisionOf(await runHookScript(env, preToolUse(TALOS_TOOL))) === "deny");
  check("with the runner down, other tools still run", (await runHookScript(env, preToolUse("Bash"))) === "");
  check("with no hook settings at all, talos's tools are denied", decisionOf(await runHookScript({ TALOS_RUNNER_SOCKET: "" }, preToolUse(TALOS_TOOL))) === "deny");
};

// LIVE_ONLY=<part of a scenario's name> runs just the matching ones.
const runEach = async (scenarios: [string, () => Promise<void>][]) => {
  for (const [name, scenario] of scenarios.filter(([name]) => name.includes(process.env.LIVE_ONLY ?? ""))) {
    try {
      await scenario();
    } catch (error) {
      check(`${name} ran to the end`, false, String(error));
    }
  }
};

await startRunner();
await runEach([
  ["normal session, auto mode", () => normalSession("auto")],
  ["normal session, asking mode", () => normalSession("ask", { permissions: { defaultMode: "default" } })],
  ["typed answer", typedAnswer],
  ["permission prompt", permissionPrompt],
  ["rewriting hook", rewritingHook],
  ["hostile session", hostileSession],
  ["runner down", runnerDown],
]);
await finish();

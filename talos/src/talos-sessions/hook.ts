// Claude Code runs this on each hook event (see buildHookSettings) and passes
// the event's details on stdin. It hands them to the session runner and prints
// back whatever decision the session runner returns (empty for most events). For the
// lane the session runner returns a PreToolUse allow/deny or a Stop block, which
// Claude Code then enforces. If the session runner is slow or unreachable it denies the
// structured tools (nothing would record them) and lets everything else through,
// so it can never hold Claude up. A tool call too big for the session runner to read is
// denied outright, since talos can't check it.
import { parseJsonOrNull } from "./json";
import { SESSION_ENV_KEYS } from "./constants";
import { askRunner } from "./client/hook-client";
import { hookReplyFromRunner, hookReplyWhenRunnerUnreachable, hookReplyWhenTooBig } from "./lanes/lane";

const sessionName = process.env[SESSION_ENV_KEYS.sessionName];
const runnerSocket = process.env[SESSION_ENV_KEYS.runnerSocket];
const hookToken = process.env[SESSION_ENV_KEYS.hookToken] ?? "";

// Without its settings the hook can't reach the session runner, so it fails
// safe the same way as when the session runner is down.
const hookDetails = await Bun.stdin.text();
const answer = sessionName && runnerSocket ? await askRunner(runnerSocket, { sessionName, token: hookToken, details: hookDetails }) : null;
const decision =
  answer?.kind === "reply"
    ? hookReplyFromRunner(parseJsonOrNull(hookDetails), answer.reply)
    : answer?.kind === "too-big"
      ? hookReplyWhenTooBig(parseJsonOrNull(hookDetails))
      : hookReplyWhenRunnerUnreachable(parseJsonOrNull(hookDetails));
if (decision) process.stdout.write(decision);
process.exit(0);

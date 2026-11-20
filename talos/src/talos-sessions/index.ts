// The only way into talos-sessions: everything talos passes in and gets out.
// See docs/MODULES.md and module-boundaries.test.ts.
export { ensureRunnerRunning, followRunnerEvents, isRunnerRunning, postToRunner, runnerFetch } from "./client/runner-client";
export { RUNNER_ROUTES, sessionRoute, REFUSAL_CODES, type RefusalCode, type RunnerEvent } from "./client/runner-protocol";
export { DETACH_KEY, connectToSessions, type Result, type SessionsConnection } from "./client/plain-calls";
export { runSessionRunner } from "./runner/run";
export { COPIED_LIMITS } from "./limits";
export { isIdentifierName, mergeSessionEntries, readSessionEntries, type SentImage, type SessionEntry, type SessionSummary } from "./shapes";
export type { RunnerInputs } from "./runner/inputs";
export { cleanLine, saysSomething } from "./clean";
export { PROSE, type OutputKind, type TurnShape } from "./kinds";

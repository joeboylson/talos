// The plain calls: how a program (talos, or an example) uses the session
// runner. Each call that can be turned down gives back a result; a malformed
// request, or a session runner that can't be reached or answers nonsense,
// throws, so neither is ever mistaken for a refusal.
import type { SentImage, SessionSummary } from "../shapes";
import { readSessionList } from "../shapes";
import { parseJsonOrNull } from "../json";
import { ensureRunnerRunning, followRunnerEvents, isRunnerRunning, postToRunner, runnerFetch } from "./runner-client";
import { RUNNER_ROUTES, readRefusal, sessionRoute, type Refusal, type RunnerEvent } from "./runner-protocol";

export type Result = { ok: true } | ({ ok: false } & Refusal);

const readResult = async (response: Response): Promise<Result> => {
  if (response.ok) return { ok: true };
  const body = await response.text();
  const refusal = readRefusal(parseJsonOrNull(body));
  if (refusal) return { ok: false, ...refusal };
  throw new Error(`the session runner answered ${response.status}: ${body.slice(0, 200)}`);
};

export const connectToSessions = ({ home, runnerScript }: { home: string; runnerScript: string }) => {
  const post = (route: string, body: unknown) => postToRunner(home, route, body).then(readResult);

  // ended settles when the stream ends (the session runner stopped, or after
  // stop), and rejects only when it can't connect.
  const follow = (onEvent: (runnerEvent: RunnerEvent) => void) => {
    const controller = new AbortController();
    const ended = followRunnerEvents(home, onEvent, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) throw error;
    });
    return { stop: () => controller.abort(), ended };
  };

  const sessions = async (): Promise<SessionSummary[]> => {
    const response = await runnerFetch(home, RUNNER_ROUTES.sessions);
    const list = response.ok ? readSessionList(await response.json()) : null;
    if (!list) throw new Error(`the session runner sent an unreadable session list (${response.status})`);
    return list;
  };

  return {
    isRunning: () => isRunnerRunning(home),
    ensureRunning: () => ensureRunnerRunning(home, runnerScript),
    start: (sessionName: string, folderName: string, path: string) => post(RUNNER_ROUTES.sessions, { sessionName, folderName, path }),
    // requestId: given back with the message if it's returned (message-returned).
    send: (sessionName: string, text: string, images: SentImage[] = [], requestId?: string) =>
      post(sessionRoute(sessionName, "send"), { text, images, ...(requestId && { requestId }) }),
    interrupt: (sessionName: string) => post(sessionRoute(sessionName, "interrupt"), {}),
    // Answers a permission question the session waits on (its id from the
    // session's permissionAsks).
    answerPermission: (sessionName: string, toolUseId: string, isAllowed: boolean) =>
      post(sessionRoute(sessionName, "answer-permission"), { toolUseId, isAllowed }),
    ask: (sessionName: string, kind: string) => post(sessionRoute(sessionName, "ask"), { kind }),
    answer: (sessionName: string, outputId: string, choice: number) => post(sessionRoute(sessionName, "answer"), { outputId, choice }),
    stop: (sessionName: string) => post(sessionRoute(sessionName, "stop"), {}),
    stopRunner: () => post(RUNNER_ROUTES.stop, {}),
    sessions,
    follow,
  };
};

export type SessionsConnection = ReturnType<typeof connectToSessions>;

// The plain calls: how a program (talos, or an example) uses the session
// runner. Each call that can be turned down gives back a result; a malformed
// request, or a session runner that can't be reached or answers nonsense,
// throws, so neither is ever mistaken for a refusal.
import type { SentImage, SessionSummary } from "../shapes";
import { readSessionList } from "../shapes";
import { parseJsonOrNull } from "../json";
import { ensureRunnerRunning, followRunnerEvents, isRunnerRunning, postToRunner, runnerFetch } from "./runner-client";
import { TERMINAL_RESET, isCtrlKey } from "../terminal";
import { RUNNER_ROUTES, readRefusal, sessionRoute, type Refusal, type RunnerEvent } from "./runner-protocol";

export type Result = { ok: true } | ({ ok: false } & Refusal);

// Ctrl-\ leaves an attached session running.
export const DETACH_KEY = 0x1c;

const readResult = async (response: Response): Promise<Result> => {
  if (response.ok) return { ok: true };
  const body = await response.text();
  const refusal = readRefusal(parseJsonOrNull(body));
  if (refusal) return { ok: false, ...refusal };
  throw new Error(`the session runner answered ${response.status}: ${body.slice(0, 200)}`);
};

type Terminal = { input: typeof process.stdin; output: typeof process.stdout; detachKey: number };

export const connectToSessions = ({ home, runnerScript }: { home: string; runnerScript: string }) => {
  const post = (route: string, body: unknown) => postToRunner(home, route, body).then(readResult);

  const screen = async (sessionName: string): Promise<({ ok: true; stream: ReadableStream<Uint8Array> }) | ({ ok: false } & Refusal)> => {
    const response = await runnerFetch(home, sessionRoute(sessionName, "output"), { timeout: false } as RequestInit);
    if (response.ok && response.body) return { ok: true, stream: response.body };
    const result = await readResult(response);
    if (result.ok) throw new Error("the session runner sent no screen");
    return result;
  };

  const keys = (sessionName: string, typed: Uint8Array | string): Promise<Result> =>
    runnerFetch(home, sessionRoute(sessionName, "input"), { method: "POST", body: typed }).then(readResult);

  const resize = (sessionName: string, cols: number, rows: number): Promise<Result> => post(sessionRoute(sessionName, "resize"), { cols, rows });

  // Shows the session's terminal in this one and types into it, until the
  // detach key leaves it running or the session ends. Gives the terminal back
  // as it found it, and never ends the program.
  const attach = async (sessionName: string, { input, output, detachKey }: Terminal): Promise<({ ok: true; how: "detached" | "ended" }) | ({ ok: false } & Refusal)> => {
    const shown = await screen(sessionName);
    if (!shown.ok) return shown;
    const matchSize = () => void resize(sessionName, output.columns, output.rows).catch(() => {});
    matchSize();
    output.on("resize", matchSize);
    const reader = shown.stream.getReader();
    // Keys go one request at a time, so they arrive in the order typed.
    let pendingKeys: Promise<unknown> = Promise.resolve();
    return new Promise((resolve) => {
      const finish = (how: "detached" | "ended") => {
        input.off("data", onKeys);
        output.off("resize", matchSize);
        output.write(TERMINAL_RESET);
        input.setRawMode(false);
        input.pause();
        void reader.cancel().catch(() => {});
        resolve({ ok: true, how });
      };
      const onKeys = (chunk: Buffer) => {
        if (isCtrlKey(chunk, detachKey)) return finish("detached");
        pendingKeys = pendingKeys.then(() => keys(sessionName, chunk)).catch(() => {});
      };
      input.setRawMode(true);
      input.resume();
      input.on("data", onKeys);
      const show = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) return finish("ended");
        output.write(value);
        return show();
      };
      void show().catch(() => finish("ended"));
    });
  };

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
    ask: (sessionName: string, kind: string) => post(sessionRoute(sessionName, "ask"), { kind }),
    answer: (sessionName: string, outputId: string, choice: number) => post(sessionRoute(sessionName, "answer"), { outputId, choice }),
    keys,
    resize,
    screen,
    stop: (sessionName: string) => post(sessionRoute(sessionName, "stop"), {}),
    stopRunner: () => post(RUNNER_ROUTES.stop, {}),
    sessions,
    follow,
    attach,
  };
};

export type SessionsConnection = ReturnType<typeof connectToSessions>;

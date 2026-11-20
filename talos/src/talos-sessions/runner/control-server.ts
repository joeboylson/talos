// The control socket: the routes talos (and only talos) uses to start, drive,
// watch and stop sessions. A session is told the hooks socket instead, so a
// prompt-injected session can't reach these.
import { rm } from "node:fs/promises";
import type { BunRequest } from "bun";
import { isIdentifierName, readSentImages } from "../shapes";
import { RUNNER_ROUTES, encodeRunnerEvent, sessionNameOf } from "../client/runner-protocol";
import { isDraftChangingKeys, isDraftClearingKeys, isTurnChangingKeys } from "../terminal";
import { endSession, startSession } from "./lifecycle";
import { noSuchSession, refuse } from "./refuse";
import { isAllowedFolder, log, paths } from "./inputs";
import { sendToSession } from "./messages";
import { answerOutput, applyLaneEvent, askForOutput } from "./session-state";
import { SESSION_LIMITS } from "../limits";
import { eventListeners, heldSessions, listSessions } from "./store";

const streamOf = <T>(
  onStart: (controller: ReadableStreamDefaultController<T>) => void,
  onEnd: (controller: ReadableStreamDefaultController<T>) => void,
) => {
  let streamController: ReadableStreamDefaultController<T> | null = null;
  return new ReadableStream<T>({
    start: (controller) => {
      streamController = controller;
      onStart(controller);
    },
    cancel: () => {
      if (streamController) onEnd(streamController);
    },
  });
};

// Starts with the recent output, so the attached terminal redraws the screen.
const streamOutput = (sessionName: string): Response => {
  const session = heldSessions.get(sessionName);
  if (!session) return noSuchSession(sessionName);
  const stream = streamOf<Uint8Array>(
    (controller) => {
      controller.enqueue(session.output);
      session.outputListeners.add(controller);
    },
    (controller) => session.outputListeners.delete(controller),
  );
  return new Response(stream);
};

// Starts with the session list and every kept entry, so a talos that just
// (re)started has the whole picture.
const streamEvents = (): Response => {
  const stream = streamOf<string>(
    (controller) => {
      controller.enqueue(encodeRunnerEvent({ type: "sessions", sessions: listSessions() }));
      heldSessions.forEach(({ entries }, sessionName) =>
        controller.enqueue(encodeRunnerEvent({ type: "session-entries", sessionName, entries })),
      );
      eventListeners.add(controller);
    },
    (controller) => eventListeners.delete(controller),
  );
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
};

const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
};

// Control routes only act on a held session; a non-identifier name can't be one.
const heldSessionOf = (request: BunRequest) => {
  const sessionName = sessionNameOf(request);
  return isIdentifierName(sessionName) ? heldSessions.get(sessionName) : undefined;
};

// Answers once every session has exited, then leaves: the answer has to go out
// before the process does.
const stopRunner = async () => {
  log.event("runner: stopping, with every session it holds");
  await Promise.all([...heldSessions.values()].map(endSession));
  const { runnerSocket, hooksSocket } = paths();
  await Promise.all([rm(runnerSocket, { force: true }), rm(hooksSocket, { force: true })]);
  setTimeout(() => process.exit(0), 50);
  return new Response(null, { status: 204 });
};

// Event and output streams stay open for as long as someone listens, so the
// session runner turns off Bun's limit on quiet requests (0 = none). Bun's types don't
// allow that option alongside a file socket, though Bun itself does.
export const controlServeOptions = (runnerSocket: string) => ({
  unix: runnerSocket,
  idleTimeout: 0,
  maxRequestBodySize: SESSION_LIMITS.maxControlBodyBytes,
  routes: {
    [RUNNER_ROUTES.health]: new Response("ok"),
    [RUNNER_ROUTES.events]: { GET: streamEvents },
    [RUNNER_ROUTES.stop]: { POST: stopRunner },
    [RUNNER_ROUTES.sessions]: {
      GET: () => Response.json(listSessions()),
      POST: async (request: BunRequest) => {
        const { sessionName, folderName, path } = await readJson(request);
        const isRequest = isIdentifierName(sessionName) && isIdentifierName(folderName) && typeof path === "string";
        if (!isRequest) return new Response("expected plain sessionName and folderName, and a path", { status: 400 });
        // The session runner checks the folder list itself, so nothing that reaches its
        // socket can start Claude (and mark it trusted) in any other folder.
        if (!(await isAllowedFolder(folderName, path))) return refuse("folder-not-allowed", `${path} isn't one of the allowed folders`, 403);
        return startSession({ sessionName, folderName, path });
      },
    },
    [`${RUNNER_ROUTES.sessions}/:sessionName/send`]: {
      POST: async (request: BunRequest) => {
        const body = await readJson(request);
        const text = typeof body.text === "string" ? body.text : "";
        const images = readSentImages(body.images);
        if (!images || (!text.trim() && images.length === 0)) {
          return new Response("expected text or images", { status: 400 });
        }
        return sendToSession(sessionNameOf(request), text, images);
      },
    },
    [`${RUNNER_ROUTES.sessions}/:sessionName/stop`]: {
      POST: async (request: BunRequest) => {
        const session = heldSessionOf(request);
        if (!session) return noSuchSession(sessionNameOf(request));
        await endSession(session);
        return new Response(null, { status: 204 });
      },
    },
    [`${RUNNER_ROUTES.sessions}/:sessionName/ask`]: {
      POST: async (request: BunRequest) => askForOutput(sessionNameOf(request), (await readJson(request)).kind),
    },
    [`${RUNNER_ROUTES.sessions}/:sessionName/answer`]: {
      POST: async (request: BunRequest) => {
        const { outputId, choice } = await readJson(request);
        return answerOutput(sessionNameOf(request), outputId, choice);
      },
    },
    [`${RUNNER_ROUTES.sessions}/:sessionName/output`]: {
      GET: (request: BunRequest) => streamOutput(sessionNameOf(request)),
    },
    [`${RUNNER_ROUTES.sessions}/:sessionName/input`]: {
      POST: async (request: BunRequest) => {
        // Read the body first: a session read before the wait could be stale.
        const keys = new Uint8Array(await request.arrayBuffer());
        const session = heldSessionOf(request);
        if (!session) return noSuchSession(sessionNameOf(request));
        // A terminal sends reports (like focus in or out) as input on its own, so
        // only keys that change the turn or the draft count as the person typing.
        const isTurnChanging = isTurnChangingKeys(keys);
        const isDraftChanging = isDraftChangingKeys(keys);
        const hasDraft = isDraftClearingKeys(keys) ? false : isDraftChanging || session.hasDraft;
        heldSessions.set(session.summary.sessionName, { ...session, hasDraft });
        if (isTurnChanging || isDraftChanging) applyLaneEvent(session.summary.sessionName, { type: "person-typed", isTurnChanging });
        session.terminal.write(keys);
        return new Response(null, { status: 204 });
      },
    },
    [`${RUNNER_ROUTES.sessions}/:sessionName/resize`]: {
      POST: async (request: BunRequest) => {
        const { cols, rows } = await readJson(request);
        const isSize = (value: unknown) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= SESSION_LIMITS.maxTerminalCells;
        if (!isSize(cols) || !isSize(rows)) return new Response("expected a terminal size", { status: 400 });
        const session = heldSessionOf(request);
        if (!session) return noSuchSession(sessionNameOf(request));
        session.terminal.resize(Number(cols), Number(rows));
        return new Response(null, { status: 204 });
      },
    },
  },
  fetch: () => new Response("Not found", { status: 404 }),
});

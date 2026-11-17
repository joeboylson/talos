// The session host: a background program that starts Claude Code sessions in
// terminals it holds, so they keep running when talos restarts. talos starts
// it (see host-client.ts) and talks to it through a file socket only this
// user can open. `talos host stop` ends it and every session it holds.
import { rm } from "node:fs/promises";
import type { BunRequest, Subprocess } from "bun";
import {
  ENV_KEYS,
  MAX_SESSIONS,
  createLogger,
  readLogsMode,
  type Exchange,
  type SessionState,
  type SessionSummary,
} from "talos-shared";
import { trustFolder } from "./claude-trust";
import {
  CLAUDE_COMMAND,
  HOOK_SCRIPT,
  HOST_SOCKET,
  MAX_OUTPUT_BYTES,
  READY_CHECK_MS,
  READY_LONGEST_WAIT_MS,
  READY_QUIET_MS,
  REPLY_SAVE_WAIT_MS,
  SESSION_ENV_KEYS,
  TERMINAL_SIZE,
} from "./constants";
import { HOST_ROUTES, encodeHostEvent, type HostEvent, type StartSessionRequest } from "./host-protocol";
import {
  appendOutput,
  buildHookSettings,
  buildSessionEnv,
  buildTypedMessage,
  nextSessionState,
  readLastExchange,
} from "./session-logic";

const log = createLogger(readLogsMode(process.env[ENV_KEYS.logsMode]));

type Terminal = { write: (data: string | Uint8Array) => void; resize: (cols: number, rows: number) => void };

type HeldSession = {
  summary: SessionSummary;
  path: string;
  child: Subprocess;
  terminal: Terminal;
  // Messages sent before Claude Code finished starting; typed once it's ready.
  queuedTexts: string[];
};

// The host's state: the sessions it holds, each one's recent terminal output,
// and who is listening for events and output.
const heldSessions = new Map<string, HeldSession>();
const outputBySession = new Map<string, Uint8Array>();
const lastOutputAtBySession = new Map<string, number>();
const outputListeners = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
const eventListeners = new Set<ReadableStreamDefaultController<string>>();

const listSessions = (): SessionSummary[] => [...heldSessions.values()].map((session) => session.summary);

const broadcast = (hostEvent: HostEvent) => {
  const line = encodeHostEvent(hostEvent);
  eventListeners.forEach((listener) => listener.enqueue(line));
};

const broadcastSessions = () => broadcast({ type: "sessions", sessions: listSessions() });

const setSessionState = (sessionName: string, state: SessionState) => {
  const session = heldSessions.get(sessionName);
  if (!session || session.summary.state === state) return;
  heldSessions.set(sessionName, { ...session, summary: { ...session.summary, state } });
  log.detail(`host: ${sessionName} is ${state}`);
  broadcastSessions();
};

const typeIntoSession = (session: HeldSession, text: string) => session.terminal.write(buildTypedMessage(text));

const handleOutput = (sessionName: string, chunk: Uint8Array) => {
  outputBySession.set(
    sessionName,
    appendOutput(outputBySession.get(sessionName) ?? new Uint8Array(), chunk, MAX_OUTPUT_BYTES),
  );
  lastOutputAtBySession.set(sessionName, Date.now());
  outputListeners.get(sessionName)?.forEach((listener) => listener.enqueue(chunk));
};

const forgetSession = (sessionName: string) => {
  heldSessions.delete(sessionName);
  outputBySession.delete(sessionName);
  lastOutputAtBySession.delete(sessionName);
  outputListeners.get(sessionName)?.forEach((listener) => listener.close());
  outputListeners.delete(sessionName);
  log.event(`host: session ${sessionName} ended`);
  broadcastSessions();
};

const startSession = async ({ sessionName, folderName, path }: StartSessionRequest): Promise<Response> => {
  if (heldSessions.has(sessionName)) return new Response(`${sessionName} is already running`, { status: 409 });
  if (heldSessions.size >= MAX_SESSIONS) return new Response("too many sessions", { status: 429 });
  await trustFolder(path);

  const hookCommand = `"${process.execPath}" "${HOOK_SCRIPT}"`;
  const child = Bun.spawn(
    [CLAUDE_COMMAND, "--session-id", crypto.randomUUID(), "--settings", buildHookSettings(hookCommand)],
    {
      cwd: path,
      env: buildSessionEnv(process.env, {
        [SESSION_ENV_KEYS.sessionName]: sessionName,
        [SESSION_ENV_KEYS.hostSocket]: HOST_SOCKET,
      }),
      terminal: { ...TERMINAL_SIZE, data: (_terminal: unknown, chunk: Uint8Array) => handleOutput(sessionName, chunk) },
    } as Parameters<typeof Bun.spawn>[1],
  );
  // Bun's terminal option adds this to the spawned process; its types don't list it yet.
  const terminal = (child as unknown as { terminal: Terminal }).terminal;

  heldSessions.set(sessionName, {
    summary: { sessionName, folderName, state: "starting" },
    path,
    child,
    terminal,
    queuedTexts: [],
  });
  child.exited.then(() => forgetSession(sessionName));
  log.event(`host: started session ${sessionName} in ${path}`);
  broadcastSessions();
  return new Response(null, { status: 201 });
};

// Reads the finished exchange, waiting a moment if Claude Code hasn't saved
// its answer yet.
const readFinishedExchange = async (transcriptPath: string, giveUpAtMs: number): Promise<Exchange | null> => {
  const exchange = readLastExchange(await Bun.file(transcriptPath).text(), Date.now());
  if (!exchange || exchange.reply || Date.now() > giveUpAtMs) return exchange;
  await Bun.sleep(READY_CHECK_MS);
  return readFinishedExchange(transcriptPath, giveUpAtMs);
};

// Once Claude Code's screen settles after it starts, the session is ready:
// type anything sent while it was starting.
const becomeReadyWhenQuiet = async (sessionName: string, giveUpAtMs: number): Promise<void> => {
  const quietForMs = Date.now() - (lastOutputAtBySession.get(sessionName) ?? 0);
  if (quietForMs < READY_QUIET_MS && Date.now() < giveUpAtMs) {
    await Bun.sleep(READY_CHECK_MS);
    return becomeReadyWhenQuiet(sessionName, giveUpAtMs);
  }
  const session = heldSessions.get(sessionName);
  if (!session) return;
  heldSessions.set(sessionName, { ...session, queuedTexts: [] });
  setSessionState(sessionName, "idle");
  session.queuedTexts.forEach((text) => typeIntoSession(session, text));
};

const handleHook = async (sessionName: string, hookDetailsText: string) => {
  const session = heldSessions.get(sessionName);
  if (!session) return;
  const hookDetails: unknown = JSON.parse(hookDetailsText || "{}");
  const hookEvent = String(Reflect.get(hookDetails as object, "hook_event_name") ?? "");
  const nextState = nextSessionState(hookEvent, hookDetails);

  if (hookEvent === "SessionStart") void becomeReadyWhenQuiet(sessionName, Date.now() + READY_LONGEST_WAIT_MS);

  if (hookEvent === "Stop") {
    const transcriptPath = Reflect.get(hookDetails as object, "transcript_path");
    if (typeof transcriptPath === "string") {
      const exchange = await readFinishedExchange(transcriptPath, Date.now() + REPLY_SAVE_WAIT_MS);
      if (exchange) broadcast({ type: "exchange", sessionName, exchange });
    }
  }
  if (nextState) setSessionState(sessionName, nextState);
};

const sendToSession = (sessionName: string, text: string): Response => {
  const session = heldSessions.get(sessionName);
  if (!session) return new Response(`no session ${sessionName}`, { status: 404 });
  if (session.summary.state === "starting") {
    heldSessions.set(sessionName, { ...session, queuedTexts: [...session.queuedTexts, text] });
  } else {
    typeIntoSession(session, text);
  }
  return new Response(null, { status: 204 });
};

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
  if (!heldSessions.has(sessionName)) return new Response(`no session ${sessionName}`, { status: 404 });
  const listeners = outputListeners.get(sessionName) ?? new Set();
  outputListeners.set(sessionName, listeners);
  const stream = streamOf<Uint8Array>(
    (controller) => {
      controller.enqueue(outputBySession.get(sessionName) ?? new Uint8Array());
      listeners.add(controller);
    },
    (controller) => listeners.delete(controller),
  );
  return new Response(stream);
};

const streamEvents = (): Response => {
  const stream = streamOf<string>(
    (controller) => {
      controller.enqueue(encodeHostEvent({ type: "sessions", sessions: listSessions() }));
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

const sessionNameOf = (request: BunRequest) => request.params.sessionName ?? "";

const stopHost = () => {
  log.event("host: stopping, with every session it holds");
  heldSessions.forEach((session) => session.child.kill());
  setTimeout(async () => {
    await rm(HOST_SOCKET, { force: true });
    process.exit(0);
  }, 200);
  return new Response(null, { status: 204 });
};

await rm(HOST_SOCKET, { force: true });
// Event and output streams stay open for as long as someone listens, so the
// host turns off Bun's limit on quiet requests (0 = none). Bun's types don't
// allow that option alongside a file socket, though Bun itself does.
const serveOptions = {
  unix: HOST_SOCKET,
  idleTimeout: 0,
  routes: {
    [HOST_ROUTES.health]: new Response("ok"),
    [HOST_ROUTES.events]: { GET: streamEvents },
    [HOST_ROUTES.stop]: { POST: stopHost },
    [HOST_ROUTES.sessions]: {
      GET: () => Response.json(listSessions()),
      POST: async (request: BunRequest) => {
        const { sessionName, folderName, path } = await readJson(request);
        const isRequest = typeof sessionName === "string" && typeof folderName === "string" && typeof path === "string";
        if (!isRequest) return new Response("expected sessionName, folderName and path", { status: 400 });
        return startSession({ sessionName, folderName, path });
      },
    },
    [`${HOST_ROUTES.sessions}/:sessionName/send`]: {
      POST: async (request: BunRequest) => {
        const { text } = await readJson(request);
        if (typeof text !== "string" || !text) return new Response("expected text", { status: 400 });
        return sendToSession(sessionNameOf(request), text);
      },
    },
    [`${HOST_ROUTES.sessions}/:sessionName/stop`]: {
      POST: (request: BunRequest) => {
        heldSessions.get(sessionNameOf(request))?.child.kill();
        return new Response(null, { status: 204 });
      },
    },
    [`${HOST_ROUTES.sessions}/:sessionName/output`]: {
      GET: (request: BunRequest) => streamOutput(sessionNameOf(request)),
    },
    [`${HOST_ROUTES.sessions}/:sessionName/input`]: {
      POST: async (request: BunRequest) => {
        heldSessions.get(sessionNameOf(request))?.terminal.write(new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { status: 204 });
      },
    },
    [`${HOST_ROUTES.sessions}/:sessionName/resize`]: {
      POST: async (request: BunRequest) => {
        const { cols, rows } = await readJson(request);
        if (typeof cols === "number" && typeof rows === "number")
          heldSessions.get(sessionNameOf(request))?.terminal.resize(cols, rows);
        return new Response(null, { status: 204 });
      },
    },
    "/hooks/:sessionName": {
      POST: async (request: BunRequest) => {
        await handleHook(sessionNameOf(request), await request.text()).catch((error: unknown) =>
          log.warn(`host: couldn't handle a hook: ${error}`),
        );
        return new Response(null, { status: 204 });
      },
    },
  },
  fetch: () => new Response("Not found", { status: 404 }),
};
Bun.serve(serveOptions as unknown as Parameters<typeof Bun.serve>[0]);
log.event(`host: listening on ${HOST_SOCKET}`);

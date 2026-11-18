// The session host: a background program that starts Claude Code sessions in
// terminals it holds, so they keep running when talos restarts. talos starts
// it (see host-client.ts) and talks to it through a file socket only this
// user can open. `talos host stop` ends it and every session it holds.
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BunRequest, Subprocess } from "bun";
import {
  ENV_KEYS,
  MAX_ENTRIES_KEPT,
  isIdentifierName,
  MAX_SESSIONS,
  createLogger,
  mergeSessionEntries,
  readLogsMode,
  readSentImages,
  type SentImage,
  type SessionEntry,
  type SessionState,
  type SessionSummary,
} from "talos-shared";
import { trustFolder } from "./claude-trust";
import { readFolders } from "./folders";
import {
  CLAUDE_COMMAND,
  CREDENTIALS_FOLDER_MODE,
  HOOK_SCRIPT,
  HOST_SOCKET_MODE,
  IMAGE_PASTE_SETTLE_MS,
  HOST_SOCKET,
  MAX_OUTPUT_BYTES,
  READY_CHECK_MS,
  READY_LONGEST_WAIT_MS,
  READY_QUIET_MS,
  SESSION_ENV_KEYS,
  TERMINAL_SIZE,
  TRANSCRIPT_CHECK_MS,
  UPLOAD_FILE_MODE,
  UPLOADS_FOLDER,
} from "./constants";
import { HOST_ROUTES, encodeHostEvent, type HostEvent, type StartSessionRequest } from "./host-protocol";
import {
  appendOutput,
  buildHookSettings,
  buildMessageWithImages,
  buildSessionEnv,
  buildPastedText,
  ENTER_KEY,
  nextSessionState,
  readCompleteLines,
  readTranscriptLine,
  resolveTranscriptItems,
} from "./session-logic";

const log = createLogger(readLogsMode(process.env[ENV_KEYS.logsMode]));

type Terminal = { write: (data: string | Uint8Array) => void; resize: (cols: number, rows: number) => void };

type ToolEntry = Extract<SessionEntry, { kind: "tool" }>;

type TypedMessage = { text: string; hasImages: boolean };

// Where a session's conversation is saved, how much of it has been read, and
// the tools seen there that haven't ended yet.
type Transcript = { path: string; readByteCount: number; runningTools: Record<string, ToolEntry> };

type HeldSession = {
  summary: SessionSummary;
  path: string;
  child: Subprocess;
  terminal: Terminal;
  // Messages sent before Claude Code finished starting; typed once it's ready.
  queuedMessages: TypedMessage[];
  transcript: Transcript | null;
  entries: SessionEntry[];
};

// The host's state: the sessions it holds, each one's recent terminal output,
// and who is listening for events and output.
const heldSessions = new Map<string, HeldSession>();
const outputBySession = new Map<string, Uint8Array>();
const lastOutputAtBySession = new Map<string, number>();
const outputListeners = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
const eventListeners = new Set<ReadableStreamDefaultController<string>>();
const sessionsBeingRead = new Set<string>();

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

const typeIntoSession = async (session: HeldSession, { text, hasImages }: TypedMessage): Promise<void> => {
  session.terminal.write(buildPastedText(text));
  if (hasImages) await Bun.sleep(IMAGE_PASTE_SETTLE_MS);
  session.terminal.write(ENTER_KEY);
};

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
  void rm(join(UPLOADS_FOLDER, sessionName), { recursive: true, force: true });
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
    queuedMessages: [],
    transcript: null,
    entries: [],
  });
  child.exited.then(() => forgetSession(sessionName));
  log.event(`host: started session ${sessionName} in ${path}`);
  broadcastSessions();
  return new Response(null, { status: 201 });
};

const readNewEntries = async (sessionName: string): Promise<void> => {
  const transcript = heldSessions.get(sessionName)?.transcript;
  if (!transcript) return;
  const transcriptFile = Bun.file(transcript.path);
  if (!(await transcriptFile.exists()) || transcriptFile.size <= transcript.readByteCount) return;

  const newBytes = new Uint8Array(await transcriptFile.slice(transcript.readByteCount).arrayBuffer());
  const { lines, usedByteCount } = readCompleteLines(newBytes);
  if (usedByteCount === 0) return;
  const { entries, knownTools } = resolveTranscriptItems(lines.flatMap(readTranscriptLine), transcript.runningTools);

  const session = heldSessions.get(sessionName);
  if (!session || session.transcript?.path !== transcript.path) return;
  heldSessions.set(sessionName, {
    ...session,
    transcript: { ...transcript, readByteCount: transcript.readByteCount + usedByteCount, runningTools: knownTools },
    entries: mergeSessionEntries(session.entries, entries, MAX_ENTRIES_KEPT),
  });
  if (entries.length > 0) broadcast({ type: "session-entries", sessionName, entries });
};

// One read at a time per session, so the same lines are never read twice.
const readAllNewEntries = () =>
  [...heldSessions.keys()]
    .filter((sessionName) => !sessionsBeingRead.has(sessionName))
    .forEach((sessionName) => {
      sessionsBeingRead.add(sessionName);
      readNewEntries(sessionName)
        .catch((error: unknown) => log.warn(`host: couldn't read ${sessionName}'s conversation: ${error}`))
        .finally(() => sessionsBeingRead.delete(sessionName));
    });

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
  heldSessions.set(sessionName, { ...session, queuedMessages: [] });
  setSessionState(sessionName, "idle");
  for (const message of session.queuedMessages) await typeIntoSession(session, message);
};

const handleHook = async (sessionName: string, hookDetailsText: string) => {
  const session = heldSessions.get(sessionName);
  if (!session) return;
  const hookDetails: unknown = JSON.parse(hookDetailsText || "{}");
  const hookEvent = String(Reflect.get(hookDetails as object, "hook_event_name") ?? "");
  const nextState = nextSessionState(hookEvent, hookDetails);

  if (hookEvent === "SessionStart") void becomeReadyWhenQuiet(sessionName, Date.now() + READY_LONGEST_WAIT_MS);

  // Claude Code can start a new conversation file (like after /clear), so
  // a new path starts over from its beginning.
  const transcriptPath = Reflect.get(hookDetails as object, "transcript_path");
  const isNewTranscript = typeof transcriptPath === "string" && transcriptPath !== session.transcript?.path;
  if (isNewTranscript) {
    heldSessions.set(sessionName, { ...session, transcript: { path: transcriptPath, readByteCount: 0, runningTools: {} } });
  }
  if (nextState) setSessionState(sessionName, nextState);
};

const IMAGE_FILE_EXTENSIONS: Record<SentImage["mediaType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const saveImages = async (sessionName: string, images: SentImage[]): Promise<string[]> => {
  if (images.length === 0) return [];
  const sessionUploadsFolder = join(UPLOADS_FOLDER, sessionName);
  await mkdir(sessionUploadsFolder, { recursive: true, mode: CREDENTIALS_FOLDER_MODE });
  return Promise.all(
    images.map(async ({ mediaType, dataBase64 }) => {
      const imagePath = join(sessionUploadsFolder, `${crypto.randomUUID()}.${IMAGE_FILE_EXTENSIONS[mediaType]}`);
      await Bun.write(imagePath, Buffer.from(dataBase64, "base64"));
      await chmod(imagePath, UPLOAD_FILE_MODE);
      return imagePath;
    }),
  );
};

const sendToSession = async (sessionName: string, text: string, images: SentImage[]): Promise<Response> => {
  if (!heldSessions.has(sessionName)) return new Response(`no session ${sessionName}`, { status: 404 });
  const message = { text: buildMessageWithImages(text, await saveImages(sessionName, images)), hasImages: images.length > 0 };
  const session = heldSessions.get(sessionName);
  if (!session) return new Response(`no session ${sessionName}`, { status: 404 });
  if (session.summary.state === "starting") {
    heldSessions.set(sessionName, { ...session, queuedMessages: [...session.queuedMessages, message] });
  } else {
    await typeIntoSession(session, message);
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

// Starts with the session list and every kept entry, so a talos that just
// (re)started has the whole picture.
const streamEvents = (): Response => {
  const stream = streamOf<string>(
    (controller) => {
      controller.enqueue(encodeHostEvent({ type: "sessions", sessions: listSessions() }));
      heldSessions.forEach(({ entries }, sessionName) =>
        controller.enqueue(encodeHostEvent({ type: "session-entries", sessionName, entries })),
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
        const isRequest = isIdentifierName(sessionName) && isIdentifierName(folderName) && typeof path === "string";
        if (!isRequest) return new Response("expected plain sessionName and folderName, and a path", { status: 400 });
        // The host checks the folder list itself, so nothing that reaches its
        // socket can start Claude (and mark it trusted) in any other folder.
        const isAllowedFolder = (await readFolders()).some((folder) => folder.folderName === folderName && folder.path === path);
        if (!isAllowedFolder) return new Response(`${path} isn't one of this machine's folders`, { status: 403 });
        return startSession({ sessionName, folderName, path });
      },
    },
    [`${HOST_ROUTES.sessions}/:sessionName/send`]: {
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
await chmod(HOST_SOCKET, HOST_SOCKET_MODE);
setInterval(readAllNewEntries, TRANSCRIPT_CHECK_MS);
log.event(`host: listening on ${HOST_SOCKET}`);

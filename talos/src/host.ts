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
  type SessionStatus,
} from "talos-shared";
import { trustFolder } from "./claude-trust";
import { readFolders } from "./folders";
import {
  CLAUDE_COMMAND,
  CREDENTIALS_FOLDER,
  CREDENTIALS_FOLDER_MODE,
  HOOK_SCRIPT,
  HOOK_TOKEN_HEADER,
  HOST_HOOKS_SOCKET,
  HOST_SOCKET,
  HOST_SOCKET_MODE,
  IMAGE_PASTE_SETTLE_MS,
  MAX_OUTPUT_BYTES,
  MAX_TRANSCRIPT_READ_BYTES,
  SESSIONS_BROADCAST_COALESCE_MS,
  READY_CHECK_MS,
  READY_LONGEST_WAIT_MS,
  READY_QUIET_MS,
  SESSION_ENV_KEYS,
  TERMINAL_SIZE,
  MCP_CONFIG_FILE,
  STATUS_CHECK_MS,
  STATUS_MCP_SERVER_KEY,
  STATUS_TIMEOUT_MS,
  STATUS_TOOL_NAME,
  STATUS_TOOL_SCRIPT,
  TRANSCRIPT_CHECK_MS,
  UPLOAD_FILE_MODE,
  UPLOADS_FOLDER,
} from "./constants";
import { HOST_ROUTES, encodeHostEvent, type HostEvent, type StartSessionRequest } from "./host-protocol";
import {
  allowToolDecision,
  appendOutput,
  blockStopDecision,
  decideStatusStop,
  statusAskInFlight,
  buildHookSettings,
  buildMessageWithImages,
  buildPastedText,
  buildSessionEnv,
  denyToolDecision,
  ENTER_KEY,
  nextSessionState,
  allowTranscriptSwitch,
  createCoalescer,
  hookTokenAuthorized,
  readCompleteLines,
  readStatusReportsInSlice,
  readHookToolName,
  readTranscriptLine,
  resolveTranscriptItems,
  STATUS_REQUEST_PROMPT,
} from "./session-logic";

const log = createLogger(readLogsMode(process.env[ENV_KEYS.logsMode]));

type Terminal = { write: (data: string | Uint8Array) => void; resize: (cols: number, rows: number) => void };

type ToolEntry = Extract<SessionEntry, { kind: "tool" }>;

type TypedMessage = { text: string; hasImages: boolean };

// Where a session's conversation is saved, how much of it has been read, and
// the tools seen there that haven't ended yet.
type Transcript = { path: string; readByteCount: number; runningTools: Record<string, ToolEntry> };

// The status lane for one session. active: a status turn is running now.
// wanted: asked while busy, start when it next goes idle. reported: the session
// called report_status this turn. askedAtMs: for the no-response timeout.
// harvestFromByte: the transcript size when this status turn began, so the
// harvest reads only report_status lines the session writes during the turn.
// forcedStop: the host has already blocked one Stop to force the report, tracked
// here rather than from the hook body's stop_hook_active (which a session can
// forge over its own hook token).
type StatusLane = { active: boolean; wanted: boolean; reported: boolean; askedAtMs: number; harvestFromByte: number; forcedStop: boolean };
const IDLE_STATUS_LANE: StatusLane = { active: false, wanted: false, reported: false, askedAtMs: 0, harvestFromByte: 0, forcedStop: false };

type HeldSession = {
  summary: SessionSummary;
  path: string;
  child: Subprocess;
  terminal: Terminal;
  // Messages sent before Claude Code finished starting; typed once it's ready.
  queuedMessages: TypedMessage[];
  transcript: Transcript | null;
  entries: SessionEntry[];
  statusLane: StatusLane;
  // Proves a hook POST on the shared hooks socket came from this session.
  hookToken: string;
};

// The host's state: the sessions it holds, each one's recent terminal output,
// and who is listening for events and output.
const heldSessions = new Map<string, HeldSession>();
const outputBySession = new Map<string, Uint8Array>();
const lastOutputAtBySession = new Map<string, number>();
const outputListeners = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
const eventListeners = new Set<ReadableStreamDefaultController<string>>();
const sessionsBeingRead = new Set<string>();
// Sessions with a ready-loop running, so a forged flood of SessionStart events
// can't pile up uncancelled becomeReadyWhenQuiet loops and exhaust the host.
const sessionsBecomingReady = new Set<string>();

const listSessions = (): SessionSummary[] => [...heldSessions.values()].map((session) => session.summary);

const broadcast = (hostEvent: HostEvent) => {
  const line = encodeHostEvent(hostEvent);
  eventListeners.forEach((listener) => listener.enqueue(line));
};

// Coalesced: rapid state/status changes (a session can flap its own state via
// forged hooks) collapse into one roster broadcast per window, so the uplink
// (host→machine→server) can't be flooded. The run sends the latest list.
const broadcastSessions = createCoalescer(
  () => broadcast({ type: "sessions", sessions: listSessions() }),
  SESSIONS_BROADCAST_COALESCE_MS,
);

const setSessionState = (sessionName: string, state: SessionState) => {
  const session = heldSessions.get(sessionName);
  if (!session || session.summary.state === state) return;
  heldSessions.set(sessionName, { ...session, summary: { ...session.summary, state } });
  log.detail(`host: ${sessionName} is ${state}`);
  broadcastSessions();
  // A status update is only asked of an idle session, so a turn's hooks apply
  // to the right turn. A request that arrived while busy waits for idle here.
  if (state === "idle" && session.statusLane.wanted && !session.statusLane.active) startStatusTurn(sessionName);
};

const updateStatusLane = (sessionName: string, change: Partial<StatusLane>) => {
  const session = heldSessions.get(sessionName);
  if (session) heldSessions.set(sessionName, { ...session, statusLane: { ...session.statusLane, ...change } });
};

const setSessionStatus = (sessionName: string, status: SessionStatus) => {
  const session = heldSessions.get(sessionName);
  if (!session) return;
  heldSessions.set(sessionName, { ...session, summary: { ...session.summary, status } });
  broadcastSessions();
};

// Begin a status turn: mark it, show it as pending, and type the request so the
// session answers by calling report_status (the PreToolUse hook forces that).
const startStatusTurn = (sessionName: string) => {
  const session = heldSessions.get(sessionName);
  if (!session) return;
  // Harvest only what the session writes from here on, so a report_status call
  // left in the backlog by an earlier turn or a sub-agent isn't read as this
  // turn's status.
  const harvestFromByte = session.transcript ? Bun.file(session.transcript.path).size : 0;
  updateStatusLane(sessionName, { active: true, wanted: false, reported: false, askedAtMs: Date.now(), harvestFromByte, forcedStop: false });
  session.terminal.write(buildPastedText(STATUS_REQUEST_PROMPT));
  session.terminal.write(ENTER_KEY);
};

// Someone pressed "ask for an update". Show pending; ask now if idle, else wait.
const askForStatus = (sessionName: string): Response => {
  const session = heldSessions.get(sessionName);
  if (!session) return new Response(`no session ${sessionName}`, { status: 404 });
  // Ignore a repeat ask while one is already in flight, so a flood of asks can't
  // keep resetting askedAtMs (starving the no-response sweep) or re-clobber the
  // running turn. The in-flight ask resolves on its own and a later ask works.
  if (statusAskInFlight(session.statusLane)) return new Response(null, { status: 204 });
  const askedAtMs = Date.now();
  const isIdle = session.summary.state === "idle";
  heldSessions.set(sessionName, {
    ...session,
    summary: { ...session.summary, status: { state: "pending", note: "", atMs: askedAtMs } },
    statusLane: { active: false, wanted: !isIdle, reported: false, askedAtMs, harvestFromByte: 0, forcedStop: false },
  });
  broadcastSessions();
  if (isIdle) startStatusTurn(sessionName);
  return new Response(null, { status: 204 });
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
  sessionsBeingRead.delete(sessionName);
  sessionsBecomingReady.delete(sessionName);
  void rm(join(UPLOADS_FOLDER, sessionName), { recursive: true, force: true });
  log.event(`host: session ${sessionName} ended`);
  broadcastSessions();
};

const startSession = async ({ sessionName, folderName, path }: StartSessionRequest): Promise<Response> => {
  if (heldSessions.has(sessionName)) return new Response(`${sessionName} is already running`, { status: 409 });
  if (heldSessions.size >= MAX_SESSIONS) return new Response("too many sessions", { status: 429 });
  await trustFolder(path);

  const hookCommand = `"${process.execPath}" "${HOOK_SCRIPT}"`;
  const hookToken = crypto.randomUUID();
  // The hook reads these from its env to reach the host; pin them in --settings
  // (below) as well as the spawn env so a project's own settings can't poison them.
  const hookEnv = {
    [SESSION_ENV_KEYS.sessionName]: sessionName,
    [SESSION_ENV_KEYS.hostSocket]: HOST_HOOKS_SOCKET,
    [SESSION_ENV_KEYS.hookToken]: hookToken,
  };
  const child = Bun.spawn(
    // --mcp-config gives every session the report_status tool (status-tool.ts);
    // the PreToolUse hook decides when it may be called.
    [CLAUDE_COMMAND, "--session-id", crypto.randomUUID(), "--settings", buildHookSettings(hookCommand, hookEnv), "--mcp-config", MCP_CONFIG_FILE],
    {
      cwd: path,
      env: buildSessionEnv(process.env, hookEnv),
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
    statusLane: IDLE_STATUS_LANE,
    hookToken,
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

  // Read at most a bounded chunk per poll, so a session can't make one read
  // allocate and parse its whole (possibly huge) transcript at once and OOM or
  // stall the host. A big backlog drains over several polls.
  const chunkEnd = transcript.readByteCount + Math.min(transcriptFile.size - transcript.readByteCount, MAX_TRANSCRIPT_READ_BYTES);
  const newBytes = new Uint8Array(await transcriptFile.slice(transcript.readByteCount, chunkEnd).arrayBuffer());
  const { lines, usedByteCount } = readCompleteLines(newBytes);
  if (usedByteCount === 0) {
    // No complete line in the chunk. If the file has already grown past it, a
    // single line is longer than the cap (pathological) — skip the chunk instead
    // of reading the whole remainder, so one huge line can't OOM the host; its
    // fragments then fail to parse and drop. Otherwise it's an incomplete trailing
    // line still being written: wait for the next poll.
    if (chunkEnd < transcriptFile.size) {
      const current = heldSessions.get(sessionName);
      if (current?.transcript?.path === transcript.path) {
        heldSessions.set(sessionName, { ...current, transcript: { ...current.transcript, readByteCount: chunkEnd } });
      }
    }
    return;
  }
  const { entries, knownTools } = resolveTranscriptItems(lines.flatMap(readTranscriptLine), transcript.runningTools);

  const session = heldSessions.get(sessionName);
  if (!session || session.transcript?.path !== transcript.path) return;
  heldSessions.set(sessionName, {
    ...session,
    transcript: { ...transcript, readByteCount: transcript.readByteCount + usedByteCount, runningTools: knownTools },
    entries: mergeSessionEntries(session.entries, entries, MAX_ENTRIES_KEPT),
  });
  if (entries.length > 0) broadcast({ type: "session-entries", sessionName, entries });

  // On a status turn, harvest the session's report_status call from these lines —
  // but only the ones written during THIS turn (byte offset at/after the turn's
  // floor), so a report_status left in the backlog by an earlier turn or a
  // sub-agent sidechain can't be read as this turn's status.
  const lane = heldSessions.get(sessionName)?.statusLane;
  if (lane?.active) {
    for (const report of readStatusReportsInSlice(newBytes.subarray(0, usedByteCount), transcript.readByteCount, lane.harvestFromByte)) {
      setSessionStatus(sessionName, { state: report.state, note: report.note, atMs: Date.now() });
      updateStatusLane(sessionName, { reported: true });
    }
  }
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
const becomeReadyWhenQuiet = async (sessionName: string, token: string, giveUpAtMs: number): Promise<void> => {
  // Bail if the session is gone, or was replaced by a new instance with the same
  // name, so a stale loop never drives the replacement.
  if (heldSessions.get(sessionName)?.hookToken !== token) return;
  const quietForMs = Date.now() - (lastOutputAtBySession.get(sessionName) ?? 0);
  if (quietForMs < READY_QUIET_MS && Date.now() < giveUpAtMs) {
    await Bun.sleep(READY_CHECK_MS);
    return becomeReadyWhenQuiet(sessionName, token, giveUpAtMs);
  }
  const session = heldSessions.get(sessionName);
  if (!session || session.hookToken !== token) return;
  heldSessions.set(sessionName, { ...session, queuedMessages: [] });
  setSessionState(sessionName, "idle");
  for (const message of session.queuedMessages) await typeIntoSession(session, message);
};

// The status lane's answer to a hook, as Claude Code expects it on stdout:
// force the report_status call (block Stop until it happens), keep a status
// turn to that one tool, and keep report_status out of chat turns.
const decideStatusHook = async (sessionName: string, hookEvent: string, hookDetails: unknown): Promise<string> => {
  const lane = heldSessions.get(sessionName)?.statusLane;
  if (hookEvent === "PreToolUse") {
    const isStatusTool = readHookToolName(hookDetails) === STATUS_TOOL_NAME;
    if (lane?.active) return isStatusTool ? allowToolDecision() : denyToolDecision("This is a status update — only report_status is allowed this turn.");
    return isStatusTool ? denyToolDecision("Not a status update; report_status can't be called now.") : "";
  }
  if (hookEvent === "Stop" && lane?.active) {
    await readNewEntries(sessionName); // harvest a just-made report before deciding
    const current = heldSessions.get(sessionName)?.statusLane;
    if (!current) return "";
    const outcome = decideStatusStop(current);
    if (outcome === "reported") return updateStatusLane(sessionName, { active: false }), "";
    // "force": block once to make the session report; "wait": already forced, so
    // let the Stop proceed without blocking again. Neither clears `active` — only
    // a report or the no-response sweep does — so a forged Stop can't end the
    // status turn early and let a forbidden tool run.
    if (outcome === "force") return updateStatusLane(sessionName, { forcedStop: true }), blockStopDecision("Call report_status with your state and one short line before finishing.");
    return "";
  }
  return "";
};

const handleHook = async (sessionName: string, hookDetailsText: string): Promise<string> => {
  const session = heldSessions.get(sessionName);
  if (!session) return "";
  const hookDetails: unknown = JSON.parse(hookDetailsText || "{}");
  const hookEvent = String(Reflect.get(hookDetails as object, "hook_event_name") ?? "");

  const decision = await decideStatusHook(sessionName, hookEvent, hookDetails);

  // Only one ready-loop per session instance, so a forged flood of SessionStart
  // events can't pile up uncancelled loops and exhaust the host's memory.
  if (hookEvent === "SessionStart" && !sessionsBecomingReady.has(sessionName)) {
    sessionsBecomingReady.add(sessionName);
    void becomeReadyWhenQuiet(sessionName, session.hookToken, Date.now() + READY_LONGEST_WAIT_MS).finally(() =>
      sessionsBecomingReady.delete(sessionName),
    );
  }

  // Claude Code can start a new conversation file (like after /clear), so
  // a new path starts over from its beginning.
  const transcriptPath = Reflect.get(hookDetails as object, "transcript_path");
  const current = heldSessions.get(sessionName);
  const isNewTranscript =
    typeof transcriptPath === "string" &&
    current !== undefined &&
    transcriptPath !== current.transcript?.path &&
    allowTranscriptSwitch(transcriptPath, current.transcript?.path ?? null);
  if (isNewTranscript && current) {
    heldSessions.set(sessionName, {
      ...current,
      transcript: { path: transcriptPath, readByteCount: 0, runningTools: {} },
      // The harvest floor is a byte offset into the old transcript, so re-anchor
      // it to the new file's size — a fresh file starts at 0; a resumed file
      // keeps its existing lines out of this status turn's harvest.
      statusLane: { ...current.statusLane, harvestFromByte: Bun.file(transcriptPath).size },
    });
  }
  // A Stop the host answered with a block keeps the turn going, so don't move to
  // idle. Keyed on the decision, not on `active` (which now persists past a Stop
  // until the session reports or the sweep times out).
  const blockedStop = hookEvent === "Stop" && decision !== "";
  const nextState = nextSessionState(hookEvent, hookDetails);
  if (nextState && !blockedStop) setSessionState(sessionName, nextState);
  return decision;
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

// Control routes only act on a held session; a non-identifier name can't be one.
const heldSessionOf = (request: BunRequest) => {
  const sessionName = sessionNameOf(request);
  return isIdentifierName(sessionName) ? heldSessions.get(sessionName) : undefined;
};

const stopHost = () => {
  log.event("host: stopping, with every session it holds");
  heldSessions.forEach((session) => session.child.kill());
  setTimeout(async () => {
    await Promise.all([rm(HOST_SOCKET, { force: true }), rm(HOST_HOOKS_SOCKET, { force: true })]);
    process.exit(0);
  }, 200);
  return new Response(null, { status: 204 });
};

await Promise.all([rm(HOST_SOCKET, { force: true }), rm(HOST_HOOKS_SOCKET, { force: true })]);
// talos (and only talos) connects to the control socket. A session is told the
// hook socket instead, so a prompt-injected session can't reach the routes that
// drive other sessions.
await mkdir(CREDENTIALS_FOLDER, { recursive: true, mode: CREDENTIALS_FOLDER_MODE });
// The MCP config that gives every session the report_status tool.
await Bun.write(
  MCP_CONFIG_FILE,
  JSON.stringify({ mcpServers: { [STATUS_MCP_SERVER_KEY]: { command: process.execPath, args: [STATUS_TOOL_SCRIPT] } } }),
);

// Event and output streams stay open for as long as someone listens, so the
// host turns off Bun's limit on quiet requests (0 = none). Bun's types don't
// allow that option alongside a file socket, though Bun itself does.
const controlServeOptions = {
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
        heldSessionOf(request)?.child.kill();
        return new Response(null, { status: 204 });
      },
    },
    [`${HOST_ROUTES.sessions}/:sessionName/ask-update`]: {
      POST: (request: BunRequest) => askForStatus(sessionNameOf(request)),
    },
    [`${HOST_ROUTES.sessions}/:sessionName/output`]: {
      GET: (request: BunRequest) => streamOutput(sessionNameOf(request)),
    },
    [`${HOST_ROUTES.sessions}/:sessionName/input`]: {
      POST: async (request: BunRequest) => {
        heldSessionOf(request)?.terminal.write(new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { status: 204 });
      },
    },
    [`${HOST_ROUTES.sessions}/:sessionName/resize`]: {
      POST: async (request: BunRequest) => {
        const { cols, rows } = await readJson(request);
        if (typeof cols === "number" && typeof rows === "number") heldSessionOf(request)?.terminal.resize(cols, rows);
        return new Response(null, { status: 204 });
      },
    },
  },
  fetch: () => new Response("Not found", { status: 404 }),
};

// The only route a session can reach: its own Claude Code hooks.
const hookServeOptions = {
  unix: HOST_HOOKS_SOCKET,
  routes: {
    [HOST_ROUTES.health]: new Response("ok"),
    [HOST_ROUTES.hooks]: {
      POST: async (request: BunRequest) => {
        const sessionName = sessionNameOf(request);
        // The hooks socket is shared by every session, so bind the POST to its
        // session with a per-session token; a request for a session whose token
        // it doesn't have is ignored, so one session can't drive another's hooks.
        if (!hookTokenAuthorized(request.headers.get(HOOK_TOKEN_HEADER), heldSessions.get(sessionName)?.hookToken)) {
          log.warn(`host: ignored a hook for "${sessionName}" with a bad token`);
          return new Response("");
        }
        const decision = await handleHook(sessionName, await request.text()).catch((error: unknown) => {
          log.warn(`host: couldn't handle a hook: ${error}`);
          return "";
        });
        // The hook script prints this to Claude Code; empty means no decision.
        return new Response(decision);
      },
    },
  },
  fetch: () => new Response("Not found", { status: 404 }),
};

Bun.serve(controlServeOptions as unknown as Parameters<typeof Bun.serve>[0]);
Bun.serve(hookServeOptions as unknown as Parameters<typeof Bun.serve>[0]);
await chmod(HOST_SOCKET, HOST_SOCKET_MODE);
await chmod(HOST_HOOKS_SOCKET, HOST_SOCKET_MODE);
setInterval(readAllNewEntries, TRANSCRIPT_CHECK_MS);
// The backstop that ends a status turn the host can't otherwise clear: a turn
// is cleared once it has been in flight (active or wanted) past the timeout.
// This always fires — even when the turn already reported but never reached a
// Stop (e.g. the session was interrupted), which would otherwise strand `active`
// true and leave the session un-askable and over-enforced. A turn that never
// reported is still "pending", so it also becomes "no response".
setInterval(() => {
  const nowMs = Date.now();
  for (const [sessionName, session] of heldSessions) {
    const lane = session.statusLane;
    const timedOut = (lane.active || lane.wanted) && nowMs - lane.askedAtMs > STATUS_TIMEOUT_MS;
    if (!timedOut) continue;
    if (session.summary.status?.state === "pending") setSessionStatus(sessionName, { state: "no-response", note: "", atMs: nowMs });
    updateStatusLane(sessionName, { active: false, wanted: false });
  }
}, STATUS_CHECK_MS);
log.event(`host: listening on ${HOST_SOCKET}`);

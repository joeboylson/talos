import type { ServerWebSocket, WebSocketHandler } from "bun";
import {
  KEEP_ALIVE_GONE_MS,
  LIMITS,
  batchEntriesBySize,
  encode,
  mergeSessionEntries,
  parseJsonOrNull,
  pickUniqueName,
  readMachineToServer,
  readPageToServer,
  toIdentifierName,
  type Folder,
  type Logger,
  type MachineSummary,
  type PageToServer,
  type ServerToMachine,
  type ServerToPage,
  type SessionEntry,
  type SessionSummary,
} from "talos-shared";
import {
  CLOSE_CODES,
  NO_MACHINES_MESSAGE,
  PING_ANSWER_WAIT_MS,
} from "./constants";
import { allowBytes, type ByteWindow } from "./utils/rate-limit";
import { steadyNow } from "./utils/steady-clock";
import type { MachineRecord, MachinesTable } from "./machines-table";
import { SERVER_LIMITS } from "./limits";

export type SocketData =
  // checkedAtMs: when its key check began, so a removal during the check
  // still counts (see openSocket).
  | { role: "machine"; machineId: string; machineName: string; ownerPersonId: string; checkedAtMs: number }
  // checkedAtMs: when its sign-in check began, so a sign-out during the check
  // still counts (see openSocket).
  | { role: "page"; personId: string; displayName: string; expiresAtMs: number; checkedAtMs: number };
type Socket = ServerWebSocket<SocketData>;
type MachineData = Extract<SocketData, { role: "machine" }>;

// What a connected machine has told the server about itself. Only the
// machine knows these, so they're gone while it's offline.
export type MachineReport = { folders: Folder[]; sessions: SessionSummary[] };

// A person only ever sees their own machines.
export const buildMachineSummaries = (
  machines: MachineRecord[],
  reportsByMachineId: Map<string, MachineReport>,
  personId: string,
): MachineSummary[] =>
  machines
    .filter((machine) => machine.ownerPersonId === personId)
    .map(({ machineId, machineName }) => {
      const report = reportsByMachineId.get(machineId);
      return {
        machineId,
        machineName,
        isConnected: report !== undefined,
        folders: report?.folders ?? null,
        sessions: report?.sessions ?? null,
      };
    })
    .sort((first, second) => first.machineName.localeCompare(second.machineName));

// Which of a person's connected machines a ping goes to: the one asked for
// (only if it's theirs and connected), or all of them.
export const chooseMachinesToPing = (ownConnectedMachineIds: string[], requestedMachineId?: string): string[] => {
  if (!requestedMachineId) return ownConnectedMachineIds;
  return ownConnectedMachineIds.filter((machineId) => machineId === requestedMachineId);
};

// A new session is named what was typed, or after its folder, and is unique
// among that machine's sessions.
export const chooseSessionName = (typedName: string | undefined, folderName: string, takenNames: string[]): string =>
  pickUniqueName(toIdentifierName(typedName?.trim() || folderName), takenNames);

export const createConnections = (
  machinesTable: MachinesTable,
  log: Logger,
  relayCoalesceMs: number = SERVER_LIMITS.machineListRelayCoalesceMs,
) => {
  // The server's only changing state: who's connected, what each connected
  // machine reported, each session's recent entries, and when each
  // unanswered ping went out.
  const machineSockets = new Map<string, Socket>();
  const reportsByMachineId = new Map<string, MachineReport>();
  // Per-socket ingress byte budget, so one connection can't flood large frames
  // and starve the shared server thread's synchronous JSON.parse for all owners.
  const socketByteWindows = new Map<Socket, ByteWindow>();
  // Each connected machine's sessions' kept entries, by machine so that one
  // machine's report or disconnect only touches its own.
  const entriesByMachine = new Map<string, Map<string, SessionEntry[]>>();
  const socketMessageWindows = new Map<Socket, ByteWindow>();
  const pageSockets = new Set<Socket>();
  // At most one unanswered ping per machine, so a flood of pings from a page
  // can't grow this map or make each ping scan a big one.
  const pendingPingByMachineId = new Map<string, { pingId: string; sentAtMs: number }>();

  const findOwnedSockets = (sockets: Iterable<Socket>, personId: string): Socket[] =>
    [...sockets].filter((socket) =>
      socket.data.role === "machine" ? socket.data.ownerPersonId === personId : socket.data.personId === personId,
    );

  // What goes to a page waits while its socket is backed up, and goes on when it
  // drains (Bun drops a message sent past its limit): a page opening gets every
  // kept history, which can be far more than a socket takes at once.
  // A page that stops reading for good (while still pinging) would make it grow
  // without end, so past a cap it's closed; it gets every kept history again
  // when it reconnects.
  const waitingSends = new Map<Socket, { texts: string[]; bytes: number }>();
  const sendToPage = (pageSocket: Socket, text: string): void => {
    // A page closed while it opened would keep a queue nothing ever drains.
    if (!pageSockets.has(pageSocket)) return;
    const waiting = waitingSends.get(pageSocket);
    if (!waiting) {
      const sent = pageSocket.send(text);
      if (sent === 0) waitingSends.set(pageSocket, { texts: [text], bytes: Buffer.byteLength(text) });
      else if (sent === -1) waitingSends.set(pageSocket, { texts: [], bytes: 0 });
      return;
    }
    waiting.texts.push(text);
    waiting.bytes += Buffer.byteLength(text);
    if (waiting.bytes <= SERVER_LIMITS.maxWaitingPageBytes) return;
    waitingSends.delete(pageSocket);
    pageSocket.close(CLOSE_CODES.tooFarBehind, "too far behind");
  };
  const sendWaiting = (pageSocket: Socket): void => {
    const waiting = waitingSends.get(pageSocket);
    if (!waiting) return;
    while (waiting.texts.length > 0) {
      const text = waiting.texts[0]!;
      const sent = pageSocket.send(text);
      if (sent === 0) return;
      waiting.texts.shift();
      waiting.bytes -= Buffer.byteLength(text);
      if (sent === -1) return;
    }
    waitingSends.delete(pageSocket);
  };

  // Requests sent on to a machine, kept by the page that sent them under the
  // server's id for them, so what didn't happen goes back to that page. Each
  // page forgets its oldest past the cap, so one person's flood can't push out
  // another's; a request that went fine never hears back.
  const pendingRequestsByPage = new Map<Socket, Map<string, string>>();
  const rememberRequest = (pageSocket: Socket, requestId: string): string => {
    const id = crypto.randomUUID();
    const pending = pendingRequestsByPage.get(pageSocket) ?? new Map<string, string>();
    pendingRequestsByPage.set(pageSocket, pending);
    pending.set(id, requestId);
    const oldest = pending.keys().next().value;
    if (pending.size > SERVER_LIMITS.maxPendingRequestsPerPage && oldest) pending.delete(oldest);
    return id;
  };
  // Looked for only among the owner's open pages, so a machine can't reach another's.
  const takeRequest = (ownerPersonId: string, id: string): { pageSocket: Socket; requestId: string } | null => {
    const pageSocket = findOwnedSockets(pageSockets, ownerPersonId).find((page) => pendingRequestsByPage.get(page)?.has(id));
    const requestId = pageSocket && pendingRequestsByPage.get(pageSocket)?.get(id);
    if (!pageSocket || requestId === undefined) return null;
    pendingRequestsByPage.get(pageSocket)?.delete(id);
    return { pageSocket, requestId };
  };

  const sendToOwnerPages = (personId: string, message: ServerToPage) => {
    const encodedMessage = encode(message);
    findOwnedSockets(pageSockets, personId).forEach((pageSocket) => sendToPage(pageSocket, encodedMessage));
  };

  const sendMachineList = (pageSocket: Socket, machines: MachineRecord[]) => {
    if (pageSocket.data.role !== "page") return;
    const machineSummaries = buildMachineSummaries(machines, reportsByMachineId, pageSocket.data.personId);
    sendToPage(pageSocket, encode<ServerToPage>({ type: "machines", machines: machineSummaries }));
  };

  // Each owner's machines as of the last table read. Every change to the table
  // (pair, rename, remove) and every connect or disconnect ends in
  // sendMachineListToPages, which reads the table again, so this stays current
  // and the frequent session and folder reports reuse it instead of scanning.
  // shortcut: a second server instance (a deploy's overlap) doesn't see the
  // other's writes until it reads again; share the list if it ever runs more
  // than one instance.
  const machinesByOwner = new Map<string, MachineRecord[]>();
  // Two reads for one owner can finish out of order; only the newest one sends,
  // so the page never ends on an older list.
  const tableReadCountByOwner = new Map<string, number>();
  // The newest read whose list was sent, so an older read that worked is still
  // sent when a newer one failed.
  const sentReadByOwner = new Map<string, number>();
  // Names handed out by start and not yet reported, with when, so two starts
  // close together don't get the same one. A report that lists one ends its
  // wait; one the machine never reports (it refused the start) lapses.
  const startedNamesByMachine = new Map<string, Map<string, number>>();
  const waitingStartedNames = (machineId: string, nowMs: number): Map<string, number> =>
    new Map([...(startedNamesByMachine.get(machineId) ?? [])].filter(([, atMs]) => nowMs - atMs < SERVER_LIMITS.startedNameWaitMs));

  const sendOwnerMachineList = (personId: string, machines: MachineRecord[]) =>
    findOwnedSockets(pageSockets, personId).forEach((pageSocket) => sendMachineList(pageSocket, machines));

  const sendMachineListToPages = async (personId: string): Promise<void> => {
    const readNumber = (tableReadCountByOwner.get(personId) ?? 0) + 1;
    tableReadCountByOwner.set(personId, readNumber);
    // A failed read drops the copy, so the next report reads fresh instead of
    // reusing a list that misses the write this read was for.
    const allMachines = await machinesTable.listMachines().catch((error: unknown) => {
      machinesByOwner.delete(personId);
      throw error;
    });
    const machines = allMachines.filter((machine) => machine.ownerPersonId === personId);
    if (readNumber <= (sentReadByOwner.get(personId) ?? 0)) return;
    sentReadByOwner.set(personId, readNumber);
    if (tableReadCountByOwner.get(personId) === readNumber) machinesByOwner.set(personId, machines);
    sendOwnerMachineList(personId, machines);
  };

  // A machine reports its sessions often (every status, state or entry change).
  // Coalesce per owner so a burst becomes one broadcast per window, which also
  // caps the page traffic if a machine floods these messages. Roster changes
  // (pair/connect/disconnect) relay at once through sendMachineListToPages.
  const relayScheduledFor = new Set<string>();
  const scheduleMachineListRelay = (personId: string) => {
    if (relayScheduledFor.has(personId)) return;
    relayScheduledFor.add(personId);
    setTimeout(() => {
      relayScheduledFor.delete(personId);
      const machines = machinesByOwner.get(personId);
      if (machines) return sendOwnerMachineList(personId, machines);
      sendMachineListToPages(personId).catch((error: unknown) => log.warn(`couldn't send ${personId}'s machine list: ${error}`));
    }, relayCoalesceMs);
  };

  // A page that just opened gets every kept entry of the person's sessions.
  const sendKeptEntries = (pageSocket: Socket, personId: string) => {
    findOwnedSockets(machineSockets.values(), personId).forEach((machineSocket) => {
      if (machineSocket.data.role !== "machine") return;
      const { machineId } = machineSocket.data;
      reportsByMachineId.get(machineId)?.sessions.forEach(({ sessionName }) => {
        // In batches: a session's whole kept history can be tens of MB, and one
        // message that big can be dropped, hiding the session from the page.
        const entries = entriesByMachine.get(machineId)?.get(sessionName) ?? [];
        batchEntriesBySize(entries, LIMITS.maxEntriesBatchBytes).forEach((batch) =>
          sendToPage(pageSocket, encode<ServerToPage>({ type: "session-entries", machineId, sessionName, entries: batch.entries })),
        );
      });
    });
  };

  // Updates a connected machine's name in place, and tells talos on that
  // machine so its own name and folder identifiers stay right.
  const renameConnectedMachine = (machineId: string, machineName: string): void => {
    const machineSocket = machineSockets.get(machineId);
    if (machineSocket?.data.role !== "machine") return;
    machineSocket.data.machineName = machineName;
    machineSocket.send(encode<ServerToMachine>({ type: "machine-name", machineName }));
  };

  // False when the machine is offline: only the machine itself can change its folders.
  const sendFolderRename = (machineId: string, folderName: string, newFolderName: string): boolean => {
    const machineSocket = machineSockets.get(machineId);
    if (!machineSocket) return false;
    machineSocket.send(encode<ServerToMachine>({ type: "rename-folder", folderName, newFolderName }));
    return true;
  };

  // Runs on the keep-alive timer. A page socket is authorized only at connect,
  // so this is where an expired session is cut: open == trusted only until the
  // cookie would have expired.
  // When each socket was last heard from (a message, or the answer to a ping),
  // so one that's gone silent (a sleeping laptop, a phone off the network) is
  // closed instead of looking connected for good.
  const lastHeardAtMs = new Map<Socket, number>();
  // Not a page's ping, so its answer only says talos is there.
  const KEEP_ALIVE_PING_ID = "keep-alive";
  const heardFrom = (socket: Socket) => lastHeardAtMs.set(socket, steadyNow());

  // Machines also get a ping of talos's own, which talos answers and which
  // tells talos the server is still there.
  const pingAllSockets = (heardNowMs = steadyNow()): void => {
    const nowMs = Date.now();
    const expiredPages = [...pageSockets].filter((socket) => socket.data.role === "page" && socket.data.expiresAtMs <= nowMs);
    expiredPages.forEach((socket) => socket.close(CLOSE_CODES.sessionExpired, "session expired"));
    const isExpired = new Set(expiredPages);
    [...machineSockets.values(), ...pageSockets].forEach((socket) => {
      if (isExpired.has(socket)) return;
      if (heardNowMs - (lastHeardAtMs.get(socket) ?? heardNowMs) > KEEP_ALIVE_GONE_MS) return socket.close(CLOSE_CODES.silent, "heard nothing for too long");
      socket.ping();
      if (socket.data.role === "machine") socket.send(encode<ServerToMachine>({ type: "ping", id: KEEP_ALIVE_PING_ID }));
    });
  };

  // When each sign-out or removal happened, for checks already under way then.
  // Those take seconds, so each is kept a minute, and older ones go as new ones
  // come, so neither map grows for good.
  const RECENT_FOR_MS = 60_000;
  const noteRecent = (recent: Map<string, number>, key: string): void => {
    const nowMs = steadyNow();
    [...recent].filter(([, atMs]) => nowMs - atMs > RECENT_FOR_MS).forEach(([oldKey]) => recent.delete(oldKey));
    recent.set(key, nowMs);
  };

  // After someone signs out everywhere, their open pages stop getting updates,
  // and so does one whose sign-in check was already under way.
  const signedOutAtMsByPerson = new Map<string, number>();
  const disconnectPersonPages = (personId: string): void => {
    noteRecent(signedOutAtMsByPerson, personId);
    findOwnedSockets(pageSockets, personId).forEach((pageSocket) =>
      pageSocket.close(CLOSE_CODES.signedOut, "signed out"),
    );
  };

  // A removed machine is cut off, and so is one whose key check was already
  // under way when it was removed.
  const removedAtMsByMachine = new Map<string, number>();
  const disconnectMachine = (machineId: string): void => {
    noteRecent(removedAtMsByMachine, machineId);
    machineSockets.get(machineId)?.close(CLOSE_CODES.machineRemoved, "removed from the page");
  };

  const handlePing = (pageSocket: Socket, personId: string, displayName: string, requestedMachineId?: string) => {
    const ownConnectedMachineIds = findOwnedSockets(machineSockets.values(), personId).flatMap((machineSocket) =>
      machineSocket.data.role === "machine" ? [machineSocket.data.machineId] : [],
    );
    const targetMachineIds = chooseMachinesToPing(ownConnectedMachineIds, requestedMachineId);
    if (targetMachineIds.length === 0) {
      log.detail(`${displayName} pressed Ping, but no matching machine of theirs is connected`);
      sendToPage(pageSocket, encode<ServerToPage>({ type: "error", message: NO_MACHINES_MESSAGE }));
      return;
    }
    log.detail(`${displayName} pinged ${targetMachineIds.length} machine(s)`);
    const nowMs = steadyNow();
    targetMachineIds.forEach((machineId) => {
      const pending = pendingPingByMachineId.get(machineId);
      const isStillWaiting = pending !== undefined && nowMs - pending.sentAtMs < PING_ANSWER_WAIT_MS;
      if (isStillWaiting) return;
      const pingId = crypto.randomUUID();
      pendingPingByMachineId.set(machineId, { pingId, sentAtMs: nowMs });
      machineSockets.get(machineId)?.send(encode<ServerToMachine>({ type: "ping", id: pingId }));
    });
  };

  // Session commands go only to the person's own, connected machine, and
  // only for folders and sessions that machine reported.
  const handleSessionCommand = (
    pageSocket: Socket,
    personId: string,
    displayName: string,
    message: Exclude<PageToServer, { type: "ping" }>,
  ) => {
    const pageRequest = message.requestId ? { requestId: message.requestId } : {};
    const sendProblem = (problem: string) => sendToPage(pageSocket, encode<ServerToPage>({ type: "error", message: problem, ...pageRequest }));
    const machineSocket = machineSockets.get(message.machineId);
    // The machine gets an id of the server's own, so a page can't name another's
    // request. Made only as it's sent, so a request turned down here takes no room.
    const forwarded = () => (message.requestId ? { requestId: rememberRequest(pageSocket, message.requestId) } : {});
    const isOwnMachine = machineSocket?.data.role === "machine" && machineSocket.data.ownerPersonId === personId;
    const report = reportsByMachineId.get(message.machineId);
    if (!machineSocket || !isOwnMachine || !report) return sendProblem("That machine isn't connected");
    const machineName = machineSocket.data.role === "machine" ? machineSocket.data.machineName : "";
    const sessionNames = report.sessions.map((session) => session.sessionName);

    if (message.type === "start-session") {
      const hasFolder = report.folders.some((folder) => folder.folderName === message.folderName);
      if (!hasFolder) return sendProblem("That folder isn't on that machine");
      const nowMs = steadyNow();
      const started = waitingStartedNames(message.machineId, nowMs);
      if (started.size >= SERVER_LIMITS.maxStartingSessions) return sendProblem("Too many sessions are starting on that machine; wait a moment");
      const sessionName = chooseSessionName(message.sessionName, message.folderName, [...sessionNames, ...started.keys()]);
      startedNamesByMachine.set(message.machineId, new Map([...started, [sessionName, nowMs]]));
      log.event(`${displayName} started session "${sessionName}" in "${message.folderName}" on "${machineName}"`);
      return machineSocket.send(encode<ServerToMachine>({ type: "start-session", folderName: message.folderName, sessionName, ...forwarded() }));
    }

    if (!sessionNames.includes(message.sessionName)) return sendProblem("That session isn't running");

    if (message.type === "stop-session") {
      log.event(`${displayName} stopped session "${message.sessionName}" on "${machineName}"`);
      return machineSocket.send(encode<ServerToMachine>({ type: "stop-session", sessionName: message.sessionName, ...forwarded() }));
    }

    if (message.type === "answer-permission") {
      const { sessionName, toolUseId, isAllowed } = message;
      log.detail(`${displayName} ${isAllowed ? "allowed" : "denied"} a tool in session "${sessionName}" on "${machineName}"`);
      return machineSocket.send(encode<ServerToMachine>({ type: "answer-permission", sessionName, toolUseId, isAllowed, ...forwarded() }));
    }

    if (message.type === "interrupt-session") {
      log.event(`${displayName} interrupted session "${message.sessionName}" on "${machineName}"`);
      return machineSocket.send(encode<ServerToMachine>({ type: "interrupt-session", sessionName: message.sessionName, ...forwarded() }));
    }

    if (message.type === "ask-for-output") {
      const { sessionName, kind } = message;
      log.detail(`${displayName} asked session "${sessionName}" on "${machineName}" for a ${kind}`);
      return machineSocket.send(encode<ServerToMachine>({ type: "ask-for-output", sessionName, kind, ...forwarded() }));
    }

    if (message.type === "answer-output") {
      const { sessionName, outputId, choice } = message;
      log.detail(`${displayName} answered a question in session "${sessionName}" on "${machineName}"`);
      return machineSocket.send(encode<ServerToMachine>({ type: "answer-output", sessionName, outputId, choice, ...forwarded() }));
    }

    const text = message.text.trim();
    const images = message.images ?? [];
    if (!text && images.length === 0) return sendProblem("That message can't be sent");
    log.detail(`${displayName} sent a message to session "${message.sessionName}" on "${machineName}"`);
    machineSocket.send(
      encode<ServerToMachine>({ type: "send-to-session", sessionName: message.sessionName, text, images, ...forwarded() }),
    );
  };

  const handlePageMessage = (pageSocket: Socket, personId: string, displayName: string, rawMessage: string | Buffer) => {
    const message = readPageToServer(parseJsonOrNull(String(rawMessage)));
    if (!message) {
      // Told, not only logged, so the page doesn't wait forever on a message
      // (like one over the text limit) that never went anywhere.
      sendToPage(pageSocket, encode<ServerToPage>({ type: "error", message: "That couldn't be sent" }));
      return log.warn(`${displayName}'s page sent a message the server can't read`);
    }
    if (message.type === "ping") return handlePing(pageSocket, personId, displayName, message.machineId);
    handleSessionCommand(pageSocket, personId, displayName, message);
  };

  const updateReport = (machine: MachineData, change: Partial<MachineReport>) => {
    const currentReport = reportsByMachineId.get(machine.machineId) ?? { folders: [], sessions: [] };
    reportsByMachineId.set(machine.machineId, { ...currentReport, ...change });
    scheduleMachineListRelay(machine.ownerPersonId);
  };

  const handleSessions = (machine: MachineData, sessions: SessionSummary[]) => {
    // A session that's gone takes its kept entries with it.
    const keptByName = entriesByMachine.get(machine.machineId);
    const liveNames = new Set(sessions.map(({ sessionName }) => sessionName));
    [...(keptByName?.keys() ?? [])].filter((sessionName) => !liveNames.has(sessionName)).forEach((sessionName) => keptByName?.delete(sessionName));
    log.detail(`"${machine.machineName}" has ${sessions.length} session(s)`);
    const stillStarting = [...waitingStartedNames(machine.machineId, steadyNow())].filter(([sessionName]) => !liveNames.has(sessionName));
    startedNamesByMachine.set(machine.machineId, new Map(stillStarting));
    updateReport(machine, { sessions });
  };

  // Only for a session the machine says it has, so a machine can't fill the
  // server's memory with entries for made-up sessions.
  const handleSessionEntries = (machine: MachineData, sessionName: string, entries: SessionEntry[]) => {
    const hasSession = reportsByMachineId.get(machine.machineId)?.sessions.some((session) => session.sessionName === sessionName);
    if (!hasSession) return log.warn(`"${machine.machineName}" sent entries for a session it doesn't have`);
    const keptByName = entriesByMachine.get(machine.machineId) ?? new Map<string, SessionEntry[]>();
    entriesByMachine.set(machine.machineId, keptByName);
    keptByName.set(sessionName, mergeSessionEntries(keptByName.get(sessionName) ?? [], entries, LIMITS.maxEntriesKept));
    log.detail(`session "${sessionName}" on "${machine.machineName}" has ${entries.length} new or changed entries`);
    sendToOwnerPages(machine.ownerPersonId, { type: "session-entries", machineId: machine.machineId, sessionName, entries });
  };

  const handlePong = (machine: MachineData, pingId: string) => {
    const pending = pendingPingByMachineId.get(machine.machineId);
    if (pending?.pingId !== pingId) return;
    pendingPingByMachineId.delete(machine.machineId);
    const roundTripMs = steadyNow() - pending.sentAtMs;
    log.detail(`pong from "${machine.machineName}" in ${roundTripMs} ms`);
    const { machineId, machineName } = machine;
    sendToOwnerPages(machine.ownerPersonId, { type: "pong", machineId, machineName, roundTripMs });
  };

  const handleMachineMessage = (machine: MachineData, rawMessage: string | Buffer) => {
    const message = readMachineToServer(parseJsonOrNull(String(rawMessage)));
    if (!message) return log.warn(`"${machine.machineName}" sent a message the server can't read`);
    if (message.type === "pong") return handlePong(machine, message.id);
    if (message.type === "sessions") return handleSessions(machine, message.sessions);
    if (message.type === "session-entries") return handleSessionEntries(machine, message.sessionName, message.entries);
    if (message.type === "message-returned") {
      // Back to the page that sent it, for its message box; with no request
      // to go by, to all the owner's pages.
      const { sessionName, text } = message;
      const returned = { type: "message-returned" as const, machineId: machine.machineId, sessionName, text };
      const request = message.requestId ? takeRequest(machine.ownerPersonId, message.requestId) : null;
      if (!request) return sendToOwnerPages(machine.ownerPersonId, returned);
      return sendToPage(request.pageSocket, encode<ServerToPage>({ ...returned, requestId: request.requestId }));
    }
    if (message.type === "error") {
      const problem = `${machine.machineName}: ${message.message}`;
      // Shown on the page whose request it was, if the machine names one;
      // otherwise on all the owner's pages.
      const request = message.requestId ? takeRequest(machine.ownerPersonId, message.requestId) : null;
      if (!request) return sendToOwnerPages(machine.ownerPersonId, { type: "error", message: problem });
      return sendToPage(request.pageSocket, encode<ServerToPage>({ type: "error", message: problem, requestId: request.requestId }));
    }
    log.detail(`"${machine.machineName}" has ${message.folders.length} folder(s)`);
    updateReport(machine, { folders: message.folders });
  };

  // One socket's problem stays that socket's problem: an error here would
  // otherwise stop the whole server, and every machine and page with it.
  const reportSocketError = (socket: Socket, error: unknown) =>
    log.warn(`a ${socket.data.role} socket's message failed: ${error instanceof Error ? error.message : error}`);

  const openSocket = async (socket: Socket): Promise<void> => {
    if (socket.data.role === "page") {
      const signedOutAtMs = signedOutAtMsByPerson.get(socket.data.personId) ?? -Infinity;
      if (socket.data.checkedAtMs <= signedOutAtMs) return socket.close(CLOSE_CODES.signedOut, "signed out");
      pageSockets.add(socket);
      log.detail(`${socket.data.displayName} connected to the live updates`);
      // From the kept copy, or a numbered read (which sends to this page too),
      // so an older read can't land after a newer one.
      // Kept entries go even if the table read fails, since a coalesced relay
      // brings the list later but nothing would bring the entries.
      try {
        const machines = machinesByOwner.get(socket.data.personId);
        if (machines) sendMachineList(socket, machines);
        else await sendMachineListToPages(socket.data.personId);
      } finally {
        sendKeptEntries(socket, socket.data.personId);
      }
      return;
    }
    const { machineId, machineName, ownerPersonId, checkedAtMs } = socket.data;
    if (checkedAtMs <= (removedAtMsByMachine.get(machineId) ?? -Infinity)) return socket.close(CLOSE_CODES.machineRemoved, "removed from the page");
    machineSockets.get(machineId)?.close(CLOSE_CODES.machineReplaced, "replaced by a newer connection");
    machineSockets.set(machineId, socket);
    reportsByMachineId.set(machineId, { folders: [], sessions: [] });
    log.event(`machine connected: "${machineName}"`);
    await sendMachineListToPages(ownerPersonId);
  };

  const closeSocket = async (socket: Socket): Promise<void> => {
    if (socket.data.role === "page") {
      pageSockets.delete(socket);
      log.detail(`${socket.data.displayName} closed the page`);
      return;
    }
    // A replaced connection closing late mustn't remove its replacement.
    const isCurrentConnection = machineSockets.get(socket.data.machineId) === socket;
    if (!isCurrentConnection) return;
    machineSockets.delete(socket.data.machineId);
    reportsByMachineId.delete(socket.data.machineId);
    entriesByMachine.delete(socket.data.machineId);
    pendingPingByMachineId.delete(socket.data.machineId);
    startedNamesByMachine.delete(socket.data.machineId);
    log.event(`machine disconnected: "${socket.data.machineName}"`);
    await sendMachineListToPages(socket.data.ownerPersonId);
  };

  const websocketHandlers: WebSocketHandler<SocketData> = {
    open(socket) {
      heardFrom(socket);
      openSocket(socket).catch((error: unknown) => reportSocketError(socket, error));
    },

    pong(socket) {
      heardFrom(socket);
    },

    message(socket, rawMessage) {
      heardFrom(socket);
      // Drop before parsing if this socket is over its byte or message budget, so
      // a flood of large frames or of tiny ones can't block the single server
      // thread for every other owner. Bytes, not characters, are what's parsed.
      const nowMs = steadyNow();
      const messageCheck = allowBytes(socketMessageWindows.get(socket), nowMs, 1, {
        windowMs: LIMITS.socketIngressWindowMs,
        maxBytes: SERVER_LIMITS.maxSocketMessagesPerWindow,
      });
      socketMessageWindows.set(socket, messageCheck.window);
      if (!messageCheck.isAllowed) return;
      const messageBytes = typeof rawMessage === "string" ? Buffer.byteLength(rawMessage) : rawMessage.length;
      const byteCheck = allowBytes(socketByteWindows.get(socket), nowMs, messageBytes, {
        windowMs: LIMITS.socketIngressWindowMs,
        maxBytes: LIMITS.maxSocketIngressBytes,
      });
      socketByteWindows.set(socket, byteCheck.window);
      if (!byteCheck.isAllowed) return;
      try {
        if (socket.data.role === "page") {
          return handlePageMessage(socket, socket.data.personId, socket.data.displayName, rawMessage);
        }
        handleMachineMessage(socket.data, rawMessage);
      } catch (error) {
        reportSocketError(socket, error);
      }
    },

    drain(socket) {
      sendWaiting(socket);
    },

    close(socket) {
      lastHeardAtMs.delete(socket);
      waitingSends.delete(socket);
      pendingRequestsByPage.delete(socket);
      socketByteWindows.delete(socket);
      socketMessageWindows.delete(socket);
      closeSocket(socket).catch((error: unknown) => reportSocketError(socket, error));
    },
  };

  return {
    websocketHandlers,
    pingAllSockets,
    disconnectPersonPages,
    sendMachineListToPages,
    disconnectMachine,
    renameConnectedMachine,
    sendFolderRename,
  };
};

export type Connections = ReturnType<typeof createConnections>;

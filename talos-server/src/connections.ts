import type { ServerWebSocket, WebSocketHandler } from "bun";
import {
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
import type { MachineRecord, MachinesTable } from "./machines-table";
import { SERVER_LIMITS } from "./limits";

export type SocketData =
  | { role: "machine"; machineId: string; machineName: string; ownerPersonId: string }
  | { role: "page"; personId: string; displayName: string; expiresAtMs: number };
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

const entriesKey = (machineId: string, sessionName: string) => `${machineId}:${sessionName}`;

export const createConnections = (machinesTable: MachinesTable, log: Logger) => {
  // The server's only changing state: who's connected, what each connected
  // machine reported, each session's recent entries, and when each
  // unanswered ping went out.
  const machineSockets = new Map<string, Socket>();
  const reportsByMachineId = new Map<string, MachineReport>();
  // Per-socket ingress byte budget, so one connection can't flood large frames
  // and starve the shared server thread's synchronous JSON.parse for all owners.
  const socketByteWindows = new Map<Socket, ByteWindow>();
  const entriesBySession = new Map<string, SessionEntry[]>();
  const pageSockets = new Set<Socket>();
  const pingSentAtById = new Map<string, number>();

  const findOwnedSockets = (sockets: Iterable<Socket>, personId: string): Socket[] =>
    [...sockets].filter((socket) =>
      socket.data.role === "machine" ? socket.data.ownerPersonId === personId : socket.data.personId === personId,
    );

  const sendToOwnerPages = (personId: string, message: ServerToPage) => {
    const encodedMessage = encode(message);
    findOwnedSockets(pageSockets, personId).forEach((pageSocket) => pageSocket.send(encodedMessage));
  };

  const sendMachineList = (pageSocket: Socket, machines: MachineRecord[]) => {
    if (pageSocket.data.role !== "page") return;
    const machineSummaries = buildMachineSummaries(machines, reportsByMachineId, pageSocket.data.personId);
    pageSocket.send(encode<ServerToPage>({ type: "machines", machines: machineSummaries }));
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
    const isNewestRead = tableReadCountByOwner.get(personId) === readNumber;
    if (!isNewestRead) return;
    machinesByOwner.set(personId, machines);
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
    }, SERVER_LIMITS.machineListRelayCoalesceMs);
  };

  // A page that just opened gets every kept entry of the person's sessions.
  const sendKeptEntries = (pageSocket: Socket, personId: string) => {
    findOwnedSockets(machineSockets.values(), personId).forEach((machineSocket) => {
      if (machineSocket.data.role !== "machine") return;
      const { machineId } = machineSocket.data;
      reportsByMachineId.get(machineId)?.sessions.forEach(({ sessionName }) => {
        // In batches: a session's whole kept history can be tens of MB, and one
        // message that big can be dropped, hiding the session from the page.
        const entries = entriesBySession.get(entriesKey(machineId, sessionName)) ?? [];
        batchEntriesBySize(entries, LIMITS.maxEntriesBatchBytes).forEach((batch) =>
          pageSocket.send(encode<ServerToPage>({ type: "session-entries", machineId, sessionName, entries: batch.entries })),
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

  // Browsers and talos answer WebSocket pings on their own, so nothing here waits for a reply.
  // Runs on the keep-alive timer. A page socket is authorized only at connect,
  // so this is where an expired session is cut: open == trusted only until the
  // cookie would have expired.
  const pingAllSockets = (): void => {
    const nowMs = Date.now();
    const expiredPages = [...pageSockets].filter((socket) => socket.data.role === "page" && socket.data.expiresAtMs <= nowMs);
    expiredPages.forEach((socket) => socket.close(CLOSE_CODES.sessionExpired, "session expired"));
    const isExpired = new Set(expiredPages);
    [...machineSockets.values(), ...pageSockets].forEach((socket) => {
      if (!isExpired.has(socket)) socket.ping();
    });
  };

  // After someone signs out everywhere, their open pages stop getting updates.
  const disconnectPersonPages = (personId: string): void => {
    findOwnedSockets(pageSockets, personId).forEach((pageSocket) =>
      pageSocket.close(CLOSE_CODES.signedOut, "signed out"),
    );
  };

  const disconnectMachine = (machineId: string): void => {
    machineSockets.get(machineId)?.close(CLOSE_CODES.machineRemoved, "removed from the page");
  };

  const handlePing = (pageSocket: Socket, personId: string, displayName: string, requestedMachineId?: string) => {
    const ownConnectedMachineIds = findOwnedSockets(machineSockets.values(), personId).flatMap((machineSocket) =>
      machineSocket.data.role === "machine" ? [machineSocket.data.machineId] : [],
    );
    const targetMachineIds = chooseMachinesToPing(ownConnectedMachineIds, requestedMachineId);
    if (targetMachineIds.length === 0) {
      log.detail(`${displayName} pressed Ping, but no matching machine of theirs is connected`);
      pageSocket.send(encode<ServerToPage>({ type: "error", message: NO_MACHINES_MESSAGE }));
      return;
    }
    log.detail(`${displayName} pinged ${targetMachineIds.length} machine(s)`);
    // A machine that never answers mustn't leave its pings here forever.
    const oldestKeptMs = Date.now() - PING_ANSWER_WAIT_MS;
    [...pingSentAtById].filter(([, sentAtMs]) => sentAtMs < oldestKeptMs).forEach(([pingId]) => pingSentAtById.delete(pingId));
    targetMachineIds.forEach((machineId) => {
      const pingId = crypto.randomUUID();
      pingSentAtById.set(pingId, Date.now());
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
    const sendProblem = (problem: string) => pageSocket.send(encode<ServerToPage>({ type: "error", message: problem }));
    const machineSocket = machineSockets.get(message.machineId);
    const isOwnMachine = machineSocket?.data.role === "machine" && machineSocket.data.ownerPersonId === personId;
    const report = reportsByMachineId.get(message.machineId);
    if (!machineSocket || !isOwnMachine || !report) return sendProblem("That machine isn't connected");
    const machineName = machineSocket.data.role === "machine" ? machineSocket.data.machineName : "";
    const sessionNames = report.sessions.map((session) => session.sessionName);

    if (message.type === "start-session") {
      const hasFolder = report.folders.some((folder) => folder.folderName === message.folderName);
      if (!hasFolder) return sendProblem("That folder isn't on that machine");
      const sessionName = chooseSessionName(message.sessionName, message.folderName, sessionNames);
      log.event(`${displayName} started session "${sessionName}" in "${message.folderName}" on "${machineName}"`);
      return machineSocket.send(encode<ServerToMachine>({ type: "start-session", folderName: message.folderName, sessionName }));
    }

    if (!sessionNames.includes(message.sessionName)) return sendProblem("That session isn't running");

    if (message.type === "stop-session") {
      log.event(`${displayName} stopped session "${message.sessionName}" on "${machineName}"`);
      return machineSocket.send(encode<ServerToMachine>({ type: "stop-session", sessionName: message.sessionName }));
    }

    if (message.type === "ask-for-update") {
      log.detail(`${displayName} asked session "${message.sessionName}" on "${machineName}" for a status update`);
      return machineSocket.send(encode<ServerToMachine>({ type: "ask-for-update", sessionName: message.sessionName }));
    }

    const text = message.text.trim();
    const images = message.images ?? [];
    if (!text && images.length === 0) return sendProblem("That message can't be sent");
    log.detail(`${displayName} sent a message to session "${message.sessionName}" on "${machineName}"`);
    machineSocket.send(
      encode<ServerToMachine>({ type: "send-to-session", sessionName: message.sessionName, text, images }),
    );
  };

  const handlePageMessage = (pageSocket: Socket, personId: string, displayName: string, rawMessage: string | Buffer) => {
    const message = readPageToServer(parseJsonOrNull(String(rawMessage)));
    if (!message) return log.warn(`${displayName}'s page sent a message the server can't read`);
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
    const liveKeys = new Set(sessions.map(({ sessionName }) => entriesKey(machine.machineId, sessionName)));
    [...entriesBySession.keys()]
      .filter((key) => key.startsWith(`${machine.machineId}:`) && !liveKeys.has(key))
      .forEach((key) => entriesBySession.delete(key));
    log.detail(`"${machine.machineName}" has ${sessions.length} session(s)`);
    updateReport(machine, { sessions });
  };

  // Only for a session the machine says it has, so a machine can't fill the
  // server's memory with entries for made-up sessions.
  const handleSessionEntries = (machine: MachineData, sessionName: string, entries: SessionEntry[]) => {
    const hasSession = reportsByMachineId.get(machine.machineId)?.sessions.some((session) => session.sessionName === sessionName);
    if (!hasSession) return log.warn(`"${machine.machineName}" sent entries for a session it doesn't have`);
    const key = entriesKey(machine.machineId, sessionName);
    entriesBySession.set(key, mergeSessionEntries(entriesBySession.get(key) ?? [], entries, LIMITS.maxEntriesKept));
    log.detail(`session "${sessionName}" on "${machine.machineName}" has ${entries.length} new or changed entries`);
    sendToOwnerPages(machine.ownerPersonId, { type: "session-entries", machineId: machine.machineId, sessionName, entries });
  };

  const handlePong = (machine: MachineData, pingId: string) => {
    const pingSentAt = pingSentAtById.get(pingId);
    if (pingSentAt === undefined) return;
    pingSentAtById.delete(pingId);
    const roundTripMs = Date.now() - pingSentAt;
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
    log.detail(`"${machine.machineName}" has ${message.folders.length} folder(s)`);
    updateReport(machine, { folders: message.folders });
  };

  // One socket's problem stays that socket's problem: an error here would
  // otherwise stop the whole server, and every machine and page with it.
  const reportSocketError = (socket: Socket, error: unknown) =>
    log.warn(`a ${socket.data.role} socket's message failed: ${error instanceof Error ? error.message : error}`);

  const openSocket = async (socket: Socket): Promise<void> => {
    if (socket.data.role === "page") {
      pageSockets.add(socket);
      log.detail(`${socket.data.displayName} connected to the live updates`);
      // From the kept copy, or a numbered read (which sends to this page too),
      // so an older read can't land after a newer one.
      const machines = machinesByOwner.get(socket.data.personId);
      if (machines) sendMachineList(socket, machines);
      else await sendMachineListToPages(socket.data.personId);
      sendKeptEntries(socket, socket.data.personId);
      return;
    }
    const { machineId, machineName, ownerPersonId } = socket.data;
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
    const goneMachineId = socket.data.machineId;
    [...entriesBySession.keys()]
      .filter((key) => key.startsWith(`${goneMachineId}:`))
      .forEach((key) => entriesBySession.delete(key));
    log.event(`machine disconnected: "${socket.data.machineName}"`);
    await sendMachineListToPages(socket.data.ownerPersonId);
  };

  const websocketHandlers: WebSocketHandler<SocketData> = {
    open(socket) {
      openSocket(socket).catch((error: unknown) => reportSocketError(socket, error));
    },

    message(socket, rawMessage) {
      // Drop before parsing if this socket is over its byte budget, so a flood of
      // large frames can't block the single server thread for every other owner.
      const { isAllowed, window } = allowBytes(socketByteWindows.get(socket), Date.now(), rawMessage.length, {
        windowMs: LIMITS.socketIngressWindowMs,
        maxBytes: LIMITS.maxSocketIngressBytes,
      });
      socketByteWindows.set(socket, window);
      if (!isAllowed) return;
      try {
        if (socket.data.role === "page") {
          return handlePageMessage(socket, socket.data.personId, socket.data.displayName, rawMessage);
        }
        handleMachineMessage(socket.data, rawMessage);
      } catch (error) {
        reportSocketError(socket, error);
      }
    },

    close(socket) {
      socketByteWindows.delete(socket);
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

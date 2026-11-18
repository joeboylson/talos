import type { ServerWebSocket, WebSocketHandler } from "bun";
import {
  MAX_EXCHANGE_TEXT_LENGTH,
  decode,
  encode,
  pickUniqueName,
  readExchange,
  readFolderList,
  readSessionList,
  toIdentifierName,
  type Exchange,
  type Folder,
  type Logger,
  type MachineSummary,
  type MachineToServer,
  type PageToServer,
  type ServerToMachine,
  type ServerToPage,
  type SessionSummary,
} from "talos-shared";
import { CLOSE_CODES, MAX_EXCHANGES_KEPT, NO_MACHINES_MESSAGE } from "./constants";
import type { MachineRecord, MachinesTable } from "./machines-table";

export type SocketData =
  | { role: "machine"; machineId: string; machineName: string; ownerPersonId: string }
  | { role: "page"; personId: string; displayName: string };
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

const exchangeKey = (machineId: string, sessionName: string) => `${machineId}:${sessionName}`;

export const createConnections = (machinesTable: MachinesTable, log: Logger) => {
  // The server's only changing state: who's connected, what each connected
  // machine reported, each session's recent exchanges, and when each
  // unanswered ping went out.
  const machineSockets = new Map<string, Socket>();
  const reportsByMachineId = new Map<string, MachineReport>();
  const exchangesBySession = new Map<string, Exchange[]>();
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

  const sendMachineListToPages = async (personId: string): Promise<void> => {
    const machines = await machinesTable.listMachines();
    findOwnedSockets(pageSockets, personId).forEach((pageSocket) => sendMachineList(pageSocket, machines));
  };

  // A page that just opened gets every kept exchange of the person's sessions.
  const sendKeptExchanges = (pageSocket: Socket, personId: string) => {
    findOwnedSockets(machineSockets.values(), personId).forEach((machineSocket) => {
      if (machineSocket.data.role !== "machine") return;
      const { machineId } = machineSocket.data;
      reportsByMachineId.get(machineId)?.sessions.forEach(({ sessionName }) => {
        (exchangesBySession.get(exchangeKey(machineId, sessionName)) ?? []).forEach((exchange) =>
          pageSocket.send(encode<ServerToPage>({ type: "exchange", machineId, sessionName, exchange })),
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
  const pingAllSockets = (): void => {
    [...machineSockets.values(), ...pageSockets].forEach((socket) => socket.ping());
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

    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (!text || text.length > MAX_EXCHANGE_TEXT_LENGTH) return sendProblem("That message can't be sent");
    log.detail(`${displayName} sent a message to session "${message.sessionName}" on "${machineName}"`);
    machineSocket.send(encode<ServerToMachine>({ type: "send-to-session", sessionName: message.sessionName, text }));
  };

  const handlePageMessage = (pageSocket: Socket, personId: string, displayName: string, rawMessage: string | Buffer) => {
    const message = decode<PageToServer>(rawMessage);
    if (!message) return;
    if (message.type === "ping") return handlePing(pageSocket, personId, displayName, message.machineId);
    const isSessionCommand = ["start-session", "send-to-session", "stop-session"].includes(message.type);
    if (isSessionCommand) handleSessionCommand(pageSocket, personId, displayName, message);
  };

  const updateReport = (machine: MachineData, change: Partial<MachineReport>) => {
    const currentReport = reportsByMachineId.get(machine.machineId) ?? { folders: [], sessions: [] };
    reportsByMachineId.set(machine.machineId, { ...currentReport, ...change });
    void sendMachineListToPages(machine.ownerPersonId);
  };

  const handleSessions = (machine: MachineData, value: unknown) => {
    const sessions = readSessionList(value);
    if (!sessions) return log.warn(`"${machine.machineName}" sent a session list the server can't read`);
    // A session that's gone takes its kept exchanges with it.
    const liveKeys = new Set(sessions.map(({ sessionName }) => exchangeKey(machine.machineId, sessionName)));
    [...exchangesBySession.keys()]
      .filter((key) => key.startsWith(`${machine.machineId}:`) && !liveKeys.has(key))
      .forEach((key) => exchangesBySession.delete(key));
    log.detail(`"${machine.machineName}" has ${sessions.length} session(s)`);
    updateReport(machine, { sessions });
  };

  const handleExchange = (machine: MachineData, sessionName: unknown, value: unknown) => {
    const exchange = readExchange(value);
    if (typeof sessionName !== "string" || !exchange) {
      return log.warn(`"${machine.machineName}" sent an exchange the server can't read`);
    }
    const key = exchangeKey(machine.machineId, sessionName);
    const keptExchanges = [...(exchangesBySession.get(key) ?? []), exchange].slice(-MAX_EXCHANGES_KEPT);
    exchangesBySession.set(key, keptExchanges);
    log.detail(`session "${sessionName}" on "${machine.machineName}" answered`);
    sendToOwnerPages(machine.ownerPersonId, { type: "exchange", machineId: machine.machineId, sessionName, exchange });
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
    const message = decode<MachineToServer>(rawMessage);
    if (message?.type === "pong") return handlePong(machine, message.id);
    if (message?.type === "folders") {
      const folders = readFolderList(message.folders);
      if (!folders) return log.warn(`"${machine.machineName}" sent a folder list the server can't read`);
      log.detail(`"${machine.machineName}" has ${folders.length} folder(s)`);
      return updateReport(machine, { folders });
    }
    if (message?.type === "sessions") return handleSessions(machine, message.sessions);
    if (message?.type === "exchange") return handleExchange(machine, message.sessionName, message.exchange);
  };

  const websocketHandlers: WebSocketHandler<SocketData> = {
    async open(socket) {
      if (socket.data.role === "page") {
        pageSockets.add(socket);
        log.detail(`${socket.data.displayName} connected to the live updates`);
        sendMachineList(socket, await machinesTable.listMachines());
        sendKeptExchanges(socket, socket.data.personId);
        return;
      }
      const { machineId, machineName, ownerPersonId } = socket.data;
      machineSockets.get(machineId)?.close(CLOSE_CODES.machineReplaced, "replaced by a newer connection");
      machineSockets.set(machineId, socket);
      reportsByMachineId.set(machineId, { folders: [], sessions: [] });
      log.event(`machine connected: "${machineName}"`);
      await sendMachineListToPages(ownerPersonId);
    },

    message(socket, rawMessage) {
      if (socket.data.role === "page") {
        return handlePageMessage(socket, socket.data.personId, socket.data.displayName, rawMessage);
      }
      handleMachineMessage(socket.data, rawMessage);
    },

    async close(socket) {
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
      log.event(`machine disconnected: "${socket.data.machineName}"`);
      await sendMachineListToPages(socket.data.ownerPersonId);
    },
  };

  return {
    websocketHandlers,
    pingAllSockets,
    sendMachineListToPages,
    disconnectMachine,
    renameConnectedMachine,
    sendFolderRename,
  };
};

export type Connections = ReturnType<typeof createConnections>;

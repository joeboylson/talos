import type { ServerWebSocket, WebSocketHandler } from "bun";
import {
  decode,
  encode,
  type Folder,
  type MachineSummary,
  type MachineToServer,
  type PageToServer,
  type ServerToMachine,
  type Logger,
  readFolderList,
  type ServerToPage,
} from "talos-shared";
import { CLOSE_CODES, NO_MACHINES_MESSAGE } from "./constants";
import type { MachineRecord, MachinesTable } from "./machines-table";

export type SocketData =
  | { role: "machine"; machineId: string; machineName: string; ownerPersonId: string }
  | { role: "page"; personId: string; displayName: string };
type Socket = ServerWebSocket<SocketData>;

// A person only ever sees their own machines. Folders come from each
// connected machine, so an offline machine's folders are unknown (null).
export const buildMachineSummaries = (
  machines: MachineRecord[],
  foldersByMachineId: Map<string, Folder[]>,
  personId: string,
): MachineSummary[] =>
  machines
    .filter((machine) => machine.ownerPersonId === personId)
    .map(({ machineId, machineName }) => ({
      machineId,
      machineName,
      isConnected: foldersByMachineId.has(machineId),
      folders: foldersByMachineId.get(machineId) ?? null,
    }))
    .sort((first, second) => first.machineName.localeCompare(second.machineName));

// Which of a person's connected machines a ping goes to: the one asked for
// (only if it's theirs and connected), or all of them.
export const chooseMachinesToPing = (ownConnectedMachineIds: string[], requestedMachineId?: string): string[] => {
  if (!requestedMachineId) return ownConnectedMachineIds;
  return ownConnectedMachineIds.filter((machineId) => machineId === requestedMachineId);
};

export const createConnections = (machinesTable: MachinesTable, log: Logger) => {
  // The server's only changing state: who's connected, each connected
  // machine's folders, and when each unanswered ping went out.
  const machineSockets = new Map<string, Socket>();
  const foldersByMachineId = new Map<string, Folder[]>();
  const pageSockets = new Set<Socket>();
  const pingSentAtById = new Map<string, number>();

  const findOwnedSockets = (sockets: Iterable<Socket>, personId: string): Socket[] =>
    [...sockets].filter((socket) =>
      socket.data.role === "machine" ? socket.data.ownerPersonId === personId : socket.data.personId === personId,
    );

  const sendMachineList = (pageSocket: Socket, machines: MachineRecord[]) => {
    if (pageSocket.data.role !== "page") return;
    const machineSummaries = buildMachineSummaries(machines, foldersByMachineId, pageSocket.data.personId);
    pageSocket.send(encode<ServerToPage>({ type: "machines", machines: machineSummaries }));
  };

  const sendMachineListToPages = async (personId: string): Promise<void> => {
    const machines = await machinesTable.listMachines();
    findOwnedSockets(pageSockets, personId).forEach((pageSocket) => sendMachineList(pageSocket, machines));
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

  const disconnectMachine = (machineId: string): void => {
    machineSockets.get(machineId)?.close(CLOSE_CODES.machineRemoved, "removed from the page");
  };

  const handlePageMessage = (pageSocket: Socket, personId: string, displayName: string, rawMessage: string | Buffer) => {
    const message = decode<PageToServer>(rawMessage);
    if (message?.type !== "ping") return;
    const ownConnectedMachineIds = [...machineSockets.entries()]
      .filter(([, machineSocket]) => machineSocket.data.role === "machine" && machineSocket.data.ownerPersonId === personId)
      .map(([machineId]) => machineId);
    const targetMachineIds = chooseMachinesToPing(ownConnectedMachineIds, message.machineId);
    if (targetMachineIds.length === 0) {
      log.detail(`${displayName} pressed Ping, but no matching machine of theirs is connected`);
      pageSocket.send(encode<ServerToPage>({ type: "error", message: NO_MACHINES_MESSAGE }));
      return;
    }
    log.detail(`${displayName} pinged ${targetMachineIds.length} machine(s)`);
    const targetSockets = targetMachineIds.flatMap((machineId) => machineSockets.get(machineId) ?? []);
    targetSockets.forEach((machineSocket) => {
      const pingId = crypto.randomUUID();
      pingSentAtById.set(pingId, Date.now());
      machineSocket.send(encode<ServerToMachine>({ type: "ping", id: pingId }));
    });
  };

  const handleMachineMessage = (machine: { machineId: string; machineName: string; ownerPersonId: string }, rawMessage: string | Buffer) => {
    const { machineId, machineName, ownerPersonId } = machine;
    const message = decode<MachineToServer>(rawMessage);
    if (message?.type === "folders") return handleFolders(machine, message.folders);
    if (message?.type !== "pong") return;
    const pingSentAt = pingSentAtById.get(message.id);
    if (pingSentAt === undefined) return;
    pingSentAtById.delete(message.id);
    const roundTripMs = Date.now() - pingSentAt;
    log.detail(`pong from "${machineName}" in ${roundTripMs} ms`);
    const pongMessage = encode<ServerToPage>({ type: "pong", machineId, machineName, roundTripMs });
    findOwnedSockets(pageSockets, ownerPersonId).forEach((pageSocket) => pageSocket.send(pongMessage));
  };

  const handleFolders = (machine: { machineId: string; machineName: string; ownerPersonId: string }, value: unknown) => {
    const folders = readFolderList(value);
    if (!folders) return log.warn(`"${machine.machineName}" sent a folder list the server can't read`);
    foldersByMachineId.set(machine.machineId, folders);
    log.detail(`"${machine.machineName}" has ${folders.length} folder(s)`);
    void sendMachineListToPages(machine.ownerPersonId);
  };

  const websocketHandlers: WebSocketHandler<SocketData> = {
    async open(socket) {
      if (socket.data.role === "page") {
        pageSockets.add(socket);
        log.detail(`${socket.data.displayName} connected to the live updates`);
        sendMachineList(socket, await machinesTable.listMachines());
        return;
      }
      const { machineId, machineName, ownerPersonId } = socket.data;
      machineSockets.get(machineId)?.close(CLOSE_CODES.machineReplaced, "replaced by a newer connection");
      machineSockets.set(machineId, socket);
      foldersByMachineId.set(machineId, []);
      log.event(`machine connected: "${machineName}"`);
      await sendMachineListToPages(ownerPersonId);
    },

    message(socket, rawMessage) {
      if (socket.data.role === "page") return handlePageMessage(socket, socket.data.personId, socket.data.displayName, rawMessage);
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
      foldersByMachineId.delete(socket.data.machineId);
      log.event(`machine disconnected: "${socket.data.machineName}"`);
      await sendMachineListToPages(socket.data.ownerPersonId);
    },
  };

  return { websocketHandlers, sendMachineListToPages, disconnectMachine, renameConnectedMachine, sendFolderRename };
};

export type Connections = ReturnType<typeof createConnections>;

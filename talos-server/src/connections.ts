import type { ServerWebSocket, WebSocketHandler } from "bun";
import {
  decode,
  encode,
  type MachineSummary,
  type MachineToServer,
  type PageToServer,
  type ServerToMachine,
  type ServerToPage,
} from "talos-shared";
import { CLOSE_CODES, NO_MACHINES_MESSAGE } from "./constants";
import type { MachineRecord, MachinesTable } from "./machines-table";

export type SocketData = { role: "machine"; machineId: string; machineName: string } | { role: "page"; login: string };
type Socket = ServerWebSocket<SocketData>;

export const buildMachineSummaries = (machines: MachineRecord[], connectedMachineIds: Set<string>): MachineSummary[] =>
  machines
    .map(({ machineId, machineName }) => ({ machineId, machineName, isConnected: connectedMachineIds.has(machineId) }))
    .sort((first, second) => first.machineName.localeCompare(second.machineName));

export const createConnections = (machinesTable: MachinesTable) => {
  // The server's only changing state: who's connected, and when each unanswered ping went out.
  const machineSockets = new Map<string, Socket>();
  const pageSockets = new Set<Socket>();
  const pingSentAtById = new Map<string, number>();

  const buildMachineListMessage = async (): Promise<string> => {
    const machines = await machinesTable.listMachines();
    const machineSummaries = buildMachineSummaries(machines, new Set(machineSockets.keys()));
    return encode<ServerToPage>({ type: "machines", machines: machineSummaries });
  };

  const sendMachineListToAllPages = async (): Promise<void> => {
    const machineListMessage = await buildMachineListMessage();
    pageSockets.forEach((pageSocket) => pageSocket.send(machineListMessage));
  };

  const disconnectMachine = (machineId: string): void => {
    machineSockets.get(machineId)?.close(CLOSE_CODES.machineRemoved, "removed from the page");
  };

  const handlePageMessage = (pageSocket: Socket, rawMessage: string | Buffer) => {
    const message = decode<PageToServer>(rawMessage);
    if (message?.type !== "ping") return;
    if (machineSockets.size === 0) {
      pageSocket.send(encode<ServerToPage>({ type: "error", message: NO_MACHINES_MESSAGE }));
      return;
    }
    machineSockets.forEach((machineSocket) => {
      const pingId = crypto.randomUUID();
      pingSentAtById.set(pingId, Date.now());
      machineSocket.send(encode<ServerToMachine>({ type: "ping", id: pingId }));
    });
  };

  const handleMachineMessage = (machineName: string, rawMessage: string | Buffer) => {
    const message = decode<MachineToServer>(rawMessage);
    if (message?.type !== "pong") return;
    const pingSentAt = pingSentAtById.get(message.id);
    if (pingSentAt === undefined) return;
    pingSentAtById.delete(message.id);
    const pongMessage = encode<ServerToPage>({ type: "pong", machineName, roundTripMs: Date.now() - pingSentAt });
    pageSockets.forEach((pageSocket) => pageSocket.send(pongMessage));
  };

  const websocketHandlers: WebSocketHandler<SocketData> = {
    async open(socket) {
      if (socket.data.role === "page") {
        pageSockets.add(socket);
        socket.send(await buildMachineListMessage());
        return;
      }
      const { machineId, machineName } = socket.data;
      machineSockets.get(machineId)?.close(CLOSE_CODES.machineReplaced, "replaced by a newer connection");
      machineSockets.set(machineId, socket);
      console.log(`machine connected: ${machineName}`);
      await sendMachineListToAllPages();
    },

    message(socket, rawMessage) {
      if (socket.data.role === "page") return handlePageMessage(socket, rawMessage);
      handleMachineMessage(socket.data.machineName, rawMessage);
    },

    async close(socket) {
      if (socket.data.role === "page") {
        pageSockets.delete(socket);
        return;
      }
      // A replaced connection closing late mustn't remove its replacement.
      const isCurrentConnection = machineSockets.get(socket.data.machineId) === socket;
      if (!isCurrentConnection) return;
      machineSockets.delete(socket.data.machineId);
      console.log(`machine disconnected: ${socket.data.machineName}`);
      await sendMachineListToAllPages();
    },
  };

  return { websocketHandlers, sendMachineListToAllPages, disconnectMachine };
};

export type Connections = ReturnType<typeof createConnections>;

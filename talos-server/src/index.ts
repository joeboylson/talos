import type { Server, ServerWebSocket } from "bun";
import {
  DEFAULT_SERVER_PORT,
  ENV_KEYS,
  MACHINE_NAME_QUERY_PARAM,
  SERVER_ROUTES,
  decode,
  encode,
  requireEnv,
  type MachineToServer,
  type PageToServer,
  type ServerToMachine,
  type ServerToPage,
} from "talos-shared";
import page from "../../talos-web/src/index.html";
import { isMachineKeyValid } from "./auth";
import {
  HEALTH_ROUTE,
  MACHINE_REPLACED_CLOSE_CODE,
  MACHINE_REPLACED_REASON,
  NO_MACHINES_MESSAGE,
  UNNAMED_MACHINE_NAME,
} from "./constants";

const serverPort = Number(process.env[ENV_KEYS.serverPort] || DEFAULT_SERVER_PORT);
const machineKey = requireEnv(ENV_KEYS.machineKey);
// Production serves the page pre-built; anything else rebuilds it on each change.
const isProduction = process.env.NODE_ENV === "production";

type SocketData = { role: "machine"; machineName: string } | { role: "page" };
type Socket = ServerWebSocket<SocketData>;

// The server's only state: who's connected, and when each unanswered ping went out.
const machineSockets = new Map<string, Socket>();
const pageSockets = new Set<Socket>();
const pingSentAtById = new Map<string, number>();

const buildMachineListMessage = (): ServerToPage => ({
  type: "machines",
  machineNames: [...machineSockets.keys()],
});

const sendToAllPages = (message: ServerToPage) => {
  const encodedMessage = encode(message);
  pageSockets.forEach((pageSocket) => pageSocket.send(encodedMessage));
};

const upgradeToSocket = (request: Request, server: Server<SocketData>, data: SocketData) => {
  const isUpgraded = server.upgrade(request, { data });
  if (isUpgraded) return undefined;
  return new Response("Expected a WebSocket", { status: 400 });
};

const handleMachineRequest = (request: Request, server: Server<SocketData>) => {
  const hasValidKey = isMachineKeyValid(request.headers.get("authorization"), machineKey);
  if (!hasValidKey) {
    console.warn(`turned away a machine with a wrong key from ${server.requestIP(request)?.address}`);
    return new Response("Unauthorized", { status: 401 });
  }
  const requestedName = new URL(request.url).searchParams.get(MACHINE_NAME_QUERY_PARAM);
  const machineName = requestedName || UNNAMED_MACHINE_NAME;
  return upgradeToSocket(request, server, { role: "machine", machineName });
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
  const roundTripMs = Date.now() - pingSentAt;
  sendToAllPages({ type: "pong", machineName, roundTripMs });
};

const server = Bun.serve<SocketData>({
  port: serverPort,
  development: !isProduction,
  routes: { "/": page, [HEALTH_ROUTE]: new Response("ok") },

  fetch(request, server) {
    const requestPath = new URL(request.url).pathname;
    if (requestPath === SERVER_ROUTES.page) return upgradeToSocket(request, server, { role: "page" });
    if (requestPath === SERVER_ROUTES.machine) return handleMachineRequest(request, server);
    return new Response("Not found", { status: 404 });
  },

  websocket: {
    open(socket) {
      if (socket.data.role === "page") {
        pageSockets.add(socket);
        socket.send(encode(buildMachineListMessage()));
        return;
      }
      const { machineName } = socket.data;
      machineSockets.get(machineName)?.close(MACHINE_REPLACED_CLOSE_CODE, MACHINE_REPLACED_REASON);
      machineSockets.set(machineName, socket);
      console.log(`machine connected: ${machineName}`);
      sendToAllPages(buildMachineListMessage());
    },

    message(socket, rawMessage) {
      if (socket.data.role === "page") return handlePageMessage(socket, rawMessage);
      handleMachineMessage(socket.data.machineName, rawMessage);
    },

    close(socket) {
      if (socket.data.role === "page") {
        pageSockets.delete(socket);
        return;
      }
      // A replaced connection closing late mustn't remove its replacement.
      const isCurrentConnection = machineSockets.get(socket.data.machineName) === socket;
      if (!isCurrentConnection) return;
      machineSockets.delete(socket.data.machineName);
      console.log(`machine disconnected: ${socket.data.machineName}`);
      sendToAllPages(buildMachineListMessage());
    },
  },
});

console.log(`talos-server: http://localhost:${server.port}`);

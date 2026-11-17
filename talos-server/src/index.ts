import type { Server } from "bun";
import { SERVER_ROUTES } from "talos-shared";
import page from "../../talos-web/src/index.html";
import { createAuthRoutes } from "./auth-routes";
import { readServerConfig } from "./config";
import { createConnections, type SocketData } from "./connections";
import { HEALTH_ROUTE } from "./constants";
import { createMachineRoutes } from "./machine-routes";
import { createEmulatorTable, createMachinesTable } from "./machines-table";
import { createPairingRoutes } from "./pairing-routes";
import { createRequestChecks } from "./request-checks";
import { textResponse } from "./utils/request";

const config = readServerConfig(process.env, SERVER_ROUTES.signInCallback);
if (config.isUsingEmulator) await createEmulatorTable(config.machinesTable);
const machinesTable = createMachinesTable(config.machinesTable, config.isUsingEmulator);
const checks = createRequestChecks(config);
const connections = createConnections(machinesTable);
const authRoutes = createAuthRoutes(config, checks);
const machineRoutes = createMachineRoutes(machinesTable, checks, connections);
const pairingRoutes = createPairingRoutes(machinesTable, checks, connections.sendMachineListToAllPages);

const upgradeToSocket = (request: Request, server: Server<SocketData>, data: SocketData) => {
  const isUpgraded = server.upgrade(request, { data });
  if (isUpgraded) return undefined;
  return textResponse("Expected a WebSocket", 400);
};

const server = Bun.serve<SocketData>({
  port: config.serverPort,
  development: !config.isProduction,

  // The page itself holds nothing secret. It asks for the signed-in user and
  // sends anyone else to GitHub; every route with data checks the session.
  routes: {
    "/": page,
    [HEALTH_ROUTE]: new Response("ok"),
    [SERVER_ROUTES.signIn]: { GET: authRoutes.signIn },
    [SERVER_ROUTES.signInCallback]: { GET: authRoutes.signInCallback },
    [SERVER_ROUTES.signOut]: { POST: authRoutes.signOut },
    [SERVER_ROUTES.currentUser]: { GET: authRoutes.currentUser },
    [SERVER_ROUTES.pairStart]: { POST: pairingRoutes.start },
    [SERVER_ROUTES.pairPoll]: { POST: pairingRoutes.poll },
    [SERVER_ROUTES.pairApprove]: { POST: pairingRoutes.approve },
    [SERVER_ROUTES.machineCheck]: { GET: machineRoutes.check },
    [`${SERVER_ROUTES.machines}/:machineId`]: { DELETE: machineRoutes.remove },
  },

  async fetch(request, server) {
    const requestPath = new URL(request.url).pathname;

    if (requestPath === SERVER_ROUTES.pageSocket) {
      const login = checks.readTrustedLogin(request);
      if (!login) return textResponse("Not signed in", 401);
      return upgradeToSocket(request, server, { role: "page", login });
    }

    if (requestPath === SERVER_ROUTES.machineSocket) {
      const machine = await machineRoutes.findMachineForRequest(request);
      if (!machine) {
        console.warn(`turned away a machine with an unknown key from ${server.requestIP(request)?.address}`);
        return textResponse("Unknown machine key", 401);
      }
      const { machineId, machineName } = machine;
      return upgradeToSocket(request, server, { role: "machine", machineId, machineName });
    }

    return textResponse("Not found", 404);
  },

  websocket: connections.websocketHandlers,
});

console.log(`talos-server: http://localhost:${server.port}`);

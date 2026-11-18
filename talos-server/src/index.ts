import type { Server } from "bun";
import { PAGE_KINDS, SERVER_ROUTES, buildPagePath, createLogger } from "talos-shared";
import page from "../../talos-web/src/index.html";
import { createAuthRoutes } from "./auth-routes";
import { readServerConfig } from "./config";
import { createConnections, type SocketData } from "./connections";
import { HEALTH_ROUTE, KEEP_ALIVE_INTERVAL_MS } from "./constants";
import { buildTableName, createDocumentClient, createEmulatorTables } from "./dynamo";
import { createMachineRoutes } from "./machine-routes";
import { createMachinesTable } from "./machines-table";
import { createPairingRoutes } from "./pairing-routes";
import { createRequestChecks } from "./request-checks";
import { createSettingsRoutes } from "./settings-routes";
import { createSettingsTable } from "./settings-table";
import { createSignInsTable } from "./sign-ins-table";
import { textResponse } from "./utils/request";

const config = readServerConfig(process.env, SERVER_ROUTES.signInCallback);
const log = createLogger(config.logsMode);
if (config.isUsingEmulator) await createEmulatorTables(config.tablePrefix, log);

const documentClient = createDocumentClient(config.isUsingEmulator);
const machinesTable = createMachinesTable(documentClient, buildTableName(config.tablePrefix, "machines"));
const signInsTable = createSignInsTable(documentClient, buildTableName(config.tablePrefix, "signIns"));
const settingsTable = createSettingsTable(documentClient, buildTableName(config.tablePrefix, "settings"));

const checks = createRequestChecks(config);
const connections = createConnections(machinesTable, log);
const authRoutes = createAuthRoutes(config, checks, { signInsTable, settingsTable }, log);
const settingsRoutes = createSettingsRoutes(checks, settingsTable, log);
const machineRoutes = createMachineRoutes(machinesTable, checks, connections, log);
const pairingRoutes = createPairingRoutes(machinesTable, checks, connections.sendMachineListToPages, log);

const upgradeToSocket = (request: Request, server: Server<SocketData>, data: SocketData) => {
  const isUpgraded = server.upgrade(request, { data });
  if (isUpgraded) return undefined;
  return textResponse("Expected a WebSocket", 400);
};

const server = Bun.serve<SocketData>({
  port: config.serverPort,
  development: !config.isProduction,

  // The page itself holds nothing secret: it shows a sign-in button until
  // someone signs in. Every route with data checks the session.
  routes: {
    "/": Response.redirect(buildPagePath(["machines"])),
    ...Object.fromEntries(PAGE_KINDS.map((pageKind) => [buildPagePath([pageKind]), page])),
    [`${buildPagePath(["sessions"])}/:machineName/:sessionName`]: page,
    [HEALTH_ROUTE]: new Response("ok"),
    [SERVER_ROUTES.signIn]: { GET: authRoutes.signIn },
    [SERVER_ROUTES.signInCallback]: { GET: authRoutes.signInCallback },
    [SERVER_ROUTES.signOut]: { POST: authRoutes.signOut },
    [SERVER_ROUTES.currentUser]: { GET: authRoutes.currentUser },
    [SERVER_ROUTES.settings]: { GET: settingsRoutes.read, PUT: settingsRoutes.update },
    [SERVER_ROUTES.pairStart]: { POST: pairingRoutes.start },
    [SERVER_ROUTES.pairPoll]: { POST: pairingRoutes.poll },
    [SERVER_ROUTES.pairApprove]: { POST: pairingRoutes.approve },
    [SERVER_ROUTES.machineCheck]: { GET: machineRoutes.check },
    [`${SERVER_ROUTES.machines}/:machineId`]: { DELETE: machineRoutes.remove, PATCH: machineRoutes.rename },
    [`${SERVER_ROUTES.machines}/:machineId/folders/:folderName`]: { PATCH: machineRoutes.renameFolder },
  },

  async fetch(request, server) {
    const requestPath = new URL(request.url).pathname;

    if (requestPath === SERVER_ROUTES.pageSocket) {
      const person = checks.readTrustedPerson(request);
      if (!person) return textResponse("Not signed in", 401);
      const { personId, displayName } = person;
      return upgradeToSocket(request, server, { role: "page", personId, displayName });
    }

    if (requestPath === SERVER_ROUTES.machineSocket) {
      const machine = await machineRoutes.findMachineForRequest(request);
      if (!machine) {
        log.warn(`turned away a machine with an unknown key from ${server.requestIP(request)?.address}`);
        return textResponse("Unknown machine key", 401);
      }
      const { machineId, machineName, ownerPersonId } = machine;
      return upgradeToSocket(request, server, { role: "machine", machineId, machineName, ownerPersonId });
    }

    return textResponse("Not found", 404);
  },

  websocket: connections.websocketHandlers,
});

setInterval(connections.pingAllSockets, KEEP_ALIVE_INTERVAL_MS);

log.event(`talos-server: http://localhost:${server.port} (logs: ${config.logsMode})`);

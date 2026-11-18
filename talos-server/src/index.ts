import type { BunRequest, Server } from "bun";
import { PAGE_KINDS, SERVER_ROUTES, buildPagePath, createLogger } from "talos-shared";
import page from "../../talos-web/src/index.html";

const PAGE_ENTRY_PATH = new URL("../../talos-web/src/index.html", import.meta.url).pathname;
import { createAuthRoutes } from "./auth-routes";
import { readServerConfig } from "./config";
import { createConnections, type SocketData } from "./connections";
import {
  ASSET_CACHE_CONTROL,
  HEALTH_ROUTE,
  KEEP_ALIVE_INTERVAL_MS,
  MAX_REQUEST_BODY_BYTES,
  MAX_SOCKET_MESSAGE_BYTES,
  PAGE_ASSETS_ROUTE,
} from "./constants";
import { buildTableName, createDocumentClient, createEmulatorTables } from "./dynamo";
import { createMachineRoutes } from "./machine-routes";
import { createMachinesTable } from "./machines-table";
import { buildPageFiles } from "./page-files";
import { createPairingRoutes } from "./pairing-routes";
import { createRequestChecks } from "./request-checks";
import { buildSecurityHeaders, withHeaders } from "./security-headers";
import { createSettingsRoutes } from "./settings-routes";
import { createSettingsTable } from "./settings-table";
import { createSignInsTable } from "./sign-ins-table";
import { readClientAddress } from "./utils/rate-limit";
import { textResponse } from "./utils/request";

const config = readServerConfig(process.env, SERVER_ROUTES.signInCallback);
const log = createLogger(config.logsMode);
if (config.isUsingEmulator) await createEmulatorTables(config.tablePrefix, log);

const documentClient = createDocumentClient(config.isUsingEmulator);
const machinesTable = createMachinesTable(documentClient, buildTableName(config.tablePrefix, "machines"));
const signInsTable = createSignInsTable(documentClient, buildTableName(config.tablePrefix, "signIns"));
const settingsTable = createSettingsTable(documentClient, buildTableName(config.tablePrefix, "settings"));

const checks = createRequestChecks(config, signInsTable);
const connections = createConnections(machinesTable, log);
const authRoutes = createAuthRoutes(config, checks, { signInsTable, settingsTable }, connections.disconnectPersonPages, log);
const settingsRoutes = createSettingsRoutes(checks, settingsTable, log);
const machineRoutes = createMachineRoutes(machinesTable, checks, connections, log);
const pairingRoutes = createPairingRoutes(machinesTable, checks, connections.sendMachineListToPages, log);

const upgradeToSocket = (request: Request, server: Server<SocketData>, data: SocketData) => {
  const isUpgraded = server.upgrade(request, { data });
  if (isUpgraded) return undefined;
  return textResponse("Expected a WebSocket", 400);
};

const securityHeaders = buildSecurityHeaders(config.publicOrigin.startsWith("https:"));
type RouteHandler = (request: BunRequest, server: Server<SocketData>) => Response | Promise<Response>;
const secure =
  (handler: RouteHandler): RouteHandler =>
  async (request, server) =>
    withHeaders(await handler(request, server), securityHeaders);

const clientAddressOf = (request: Request, server: Server<SocketData>): string =>
  readClientAddress(request.headers.get("x-forwarded-for"), server.requestIP(request)?.address);

// Production serves the page from a build made at start, with the headers.
// Development uses Bun's own page serving (live reload), which can't add them.
const pageFiles = config.isProduction ? await buildPageFiles(PAGE_ENTRY_PATH) : null;
const pageRoute = pageFiles
  ? secure(() => new Response(pageFiles.pageHtml, { headers: { "Content-Type": "text/html;charset=utf-8" } }))
  : page;
const assetRoute = secure((request) => {
  const asset = pageFiles?.assetsByPath.get(new URL(request.url).pathname);
  return asset ? new Response(asset, { headers: { "Cache-Control": ASSET_CACHE_CONTROL } }) : textResponse("Not found", 404);
});

const server = Bun.serve<SocketData>({
  port: config.serverPort,
  development: !config.isProduction,
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,

  // The page itself holds nothing secret: it shows a sign-in button until
  // someone signs in. Every route with data checks the session.
  routes: {
    "/": secure(() => Response.redirect(buildPagePath(["machines"]))),
    ...Object.fromEntries(PAGE_KINDS.map((pageKind) => [buildPagePath([pageKind]), pageRoute])),
    [`${buildPagePath(["sessions"])}/:machineName/:sessionName`]: pageRoute,
    [`${PAGE_ASSETS_ROUTE}/*`]: assetRoute,
    [HEALTH_ROUTE]: secure(() => new Response("ok")),
    [SERVER_ROUTES.signIn]: { GET: secure(authRoutes.signIn) },
    [SERVER_ROUTES.signInCallback]: { GET: secure(authRoutes.signInCallback) },
    [SERVER_ROUTES.signOut]: { POST: secure(authRoutes.signOut) },
    [SERVER_ROUTES.currentUser]: { GET: secure(authRoutes.currentUser) },
    [SERVER_ROUTES.settings]: { GET: secure(settingsRoutes.read), PUT: secure(settingsRoutes.update) },
    [SERVER_ROUTES.pairStart]: { POST: secure((request, server) => pairingRoutes.start(request, clientAddressOf(request, server))) },
    [SERVER_ROUTES.pairPoll]: { POST: secure(pairingRoutes.poll) },
    [SERVER_ROUTES.pairApprove]: { POST: secure(pairingRoutes.approve) },
    [SERVER_ROUTES.pairCollect]: { POST: secure(pairingRoutes.collect) },
    [SERVER_ROUTES.machineCheck]: { GET: secure(machineRoutes.check) },
    [`${SERVER_ROUTES.machines}/:machineId`]: { DELETE: secure(machineRoutes.remove), PATCH: secure(machineRoutes.rename) },
    [`${SERVER_ROUTES.machines}/:machineId/folders/:folderName`]: { PATCH: secure(machineRoutes.renameFolder) },
  },

  async fetch(request, server) {
    const requestPath = new URL(request.url).pathname;

    if (requestPath === SERVER_ROUTES.pageSocket) {
      const person = await checks.readTrustedPerson(request);
      if (!person) return withHeaders(textResponse("Not signed in", 401), securityHeaders);
      const { personId, displayName } = person;
      return upgradeToSocket(request, server, { role: "page", personId, displayName });
    }

    if (requestPath === SERVER_ROUTES.machineSocket) {
      const machine = await machineRoutes.findMachineForRequest(request);
      if (!machine) {
        log.warn(`turned away a machine with an unknown key from ${server.requestIP(request)?.address}`);
        return withHeaders(textResponse("Unknown machine key", 401), securityHeaders);
      }
      const { machineId, machineName, ownerPersonId } = machine;
      return upgradeToSocket(request, server, { role: "machine", machineId, machineName, ownerPersonId });
    }

    return withHeaders(textResponse("Not found", 404), securityHeaders);
  },

  // Anything a route throws becomes a plain error, never a crash or a stack trace.
  error(error) {
    log.warn(`a request failed: ${error.message}`);
    return withHeaders(textResponse("Something went wrong", 500), securityHeaders);
  },

  websocket: { ...connections.websocketHandlers, maxPayloadLength: MAX_SOCKET_MESSAGE_BYTES },
});

setInterval(connections.pingAllSockets, KEEP_ALIVE_INTERVAL_MS);

log.event(`talos-server: http://localhost:${server.port} (logs: ${config.logsMode})`);

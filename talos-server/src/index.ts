import { LIMITS, PAGE_KINDS, SERVER_ROUTES, buildPagePath, createLogger } from "talos-shared";
import page from "../../talos-web/src/index.html";

const PAGE_ENTRY_PATH = new URL("../../talos-web/src/index.html", import.meta.url).pathname;
import { createAuthRoutes } from "./auth-routes";
import { readServerConfig } from "./config";
import { createConnections, type SocketData } from "./connections";
import { ASSET_CACHE_CONTROL, KEEP_ALIVE_INTERVAL_MS, PAGE_ASSETS_ROUTE } from "./constants";
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
import { buildApiRoutes, decideSocket, secureWith } from "./server-routes";
import { textResponse } from "./utils/request";
import { SERVER_LIMITS } from "./limits";

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

const securityHeaders = buildSecurityHeaders(config.publicOrigin.startsWith("https:"));
const secure = secureWith(securityHeaders);

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
  maxRequestBodySize: SERVER_LIMITS.maxRequestBodyBytes,

  // The page itself holds nothing secret: it shows a sign-in button until
  // someone signs in. Every route with data checks the session.
  routes: {
    "/": secure(() => Response.redirect(buildPagePath(["machines"]))),
    ...Object.fromEntries(PAGE_KINDS.map((pageKind) => [buildPagePath([pageKind]), pageRoute])),
    [`${buildPagePath(["sessions"])}/:machineName/:sessionName`]: pageRoute,
    [`${PAGE_ASSETS_ROUTE}/*`]: assetRoute,
    ...buildApiRoutes({ authRoutes, settingsRoutes, machineRoutes, pairingRoutes, securityHeaders }),
  },

  async fetch(request, server) {
    const decision = await decideSocket(request, checks, machineRoutes, log);
    if (!decision) return withHeaders(textResponse("Not found", 404), securityHeaders);
    if ("response" in decision) return withHeaders(decision.response, securityHeaders);
    const isUpgraded = server.upgrade(request, { data: decision.data });
    return isUpgraded ? undefined : textResponse("Expected a WebSocket", 400);
  },

  // Anything a route throws becomes a plain error, never a crash or a stack trace.
  error(error) {
    log.warn(`a request failed: ${error.message}`);
    return withHeaders(textResponse("Something went wrong", 500), securityHeaders);
  },

  websocket: { ...connections.websocketHandlers, maxPayloadLength: LIMITS.maxSocketMessageBytes },
});

setInterval(connections.pingAllSockets, KEEP_ALIVE_INTERVAL_MS);

log.event(`talos-server: http://localhost:${server.port} (logs: ${config.logsMode})`);

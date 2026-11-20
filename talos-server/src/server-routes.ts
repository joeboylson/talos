import type { BunRequest, Server } from "bun";
import { SERVER_ROUTES, type Logger } from "talos-shared";
import type { createAuthRoutes } from "./auth-routes";
import type { SocketData } from "./connections";
import { HEALTH_ROUTE } from "./constants";
import type { createMachineRoutes } from "./machine-routes";
import type { createPairingRoutes } from "./pairing-routes";
import type { RequestChecks } from "./request-checks";
import { withHeaders } from "./security-headers";
import type { createSettingsRoutes } from "./settings-routes";
import { readClientAddress } from "./utils/rate-limit";
import { textResponse } from "./utils/request";

export type RouteHandler = (request: BunRequest, server: Server<SocketData>) => Response | Promise<Response>;

type ApiRouteParts = {
  authRoutes: ReturnType<typeof createAuthRoutes>;
  settingsRoutes: ReturnType<typeof createSettingsRoutes>;
  machineRoutes: ReturnType<typeof createMachineRoutes>;
  pairingRoutes: ReturnType<typeof createPairingRoutes>;
  securityHeaders: Record<string, string>;
};

export const secureWith =
  (securityHeaders: Record<string, string>) =>
  (handler: RouteHandler): RouteHandler =>
  async (request, server) =>
    withHeaders(await handler(request, server), securityHeaders);

const clientAddressOf = (request: Request, server: Server<SocketData>): string =>
  readClientAddress(request.headers.get("x-forwarded-for"), server.requestIP(request)?.address);

// Every route that reads or changes data, by path and method. Each handler
// checks its own caller; this only decides which handler a request reaches.
export const buildApiRoutes = ({ authRoutes, settingsRoutes, machineRoutes, pairingRoutes, securityHeaders }: ApiRouteParts) => {
  const secure = secureWith(securityHeaders);
  return {
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
  };
};

export type SocketDecision = { data: SocketData } | { response: Response } | null;

// Who a socket belongs to comes only from the server's own checks, never from
// the request: a page needs a session sent from Talos's own page (so another
// site can't open one with someone's cookie), a machine needs its key.
// Null means the path isn't a socket.
export const decideSocket = async (
  request: Request,
  checks: RequestChecks,
  machineRoutes: Pick<ReturnType<typeof createMachineRoutes>, "findMachineForRequest">,
  log: Logger,
): Promise<SocketDecision> => {
  const requestPath = new URL(request.url).pathname;
  if (requestPath === SERVER_ROUTES.pageSocket) {
    const person = await checks.readTrustedPerson(request);
    if (!person) return { response: textResponse("Not signed in", 401) };
    const { personId, displayName, expiresAtMs } = person;
    return { data: { role: "page", personId, displayName, expiresAtMs } };
  }
  if (requestPath === SERVER_ROUTES.machineSocket) {
    const machine = await machineRoutes.findMachineForRequest(request);
    if (!machine) {
      log.warn("turned away a machine with an unknown key");
      return { response: textResponse("Unknown machine key", 401) };
    }
    const { machineId, machineName, ownerPersonId } = machine;
    return { data: { role: "machine", machineId, machineName, ownerPersonId } };
  }
  return null;
};

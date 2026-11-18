import { LOCAL_STATUS_HOST, LOCAL_STATUS_PORT, LOCAL_STATUS_ROUTE, type LocalStatus, type Logger } from "talos-shared";
import { buildCorsHeaders } from "./cors";

type LocalStatusServerOptions = {
  allowedOrigin: string;
  readLocalStatus: () => LocalStatus;
  log: Logger;
};

const isPortTaken = (error: unknown): boolean =>
  typeof error === "object" && error !== null && Reflect.get(error, "code") === "EADDRINUSE";

const serveLocalStatus = ({ allowedOrigin, readLocalStatus, log }: LocalStatusServerOptions): void => {
  Bun.serve({
    hostname: LOCAL_STATUS_HOST,
    port: LOCAL_STATUS_PORT,
    fetch(request) {
      const corsHeaders = buildCorsHeaders(request.headers.get("origin"), allowedOrigin);
      const isPreflight = request.method === "OPTIONS";
      if (isPreflight) return new Response(null, { status: 204, headers: corsHeaders });

      const isStatusRequest = new URL(request.url).pathname === LOCAL_STATUS_ROUTE;
      if (!isStatusRequest) return new Response("Not found", { status: 404 });
      log.detail(`talos: the page asked for this machine's status (from ${request.headers.get("origin") ?? "no site"})`);
      return Response.json(readLocalStatus(), { headers: corsHeaders });
    },
  });
};

// Lets the page, opened on this same machine, show its "This machine" panel.
// A second talos on the same machine (like one with its own TALOS_HOME) finds
// the port taken and goes without the panel rather than stopping.
export const startLocalStatusServer = (options: LocalStatusServerOptions): void => {
  try {
    serveLocalStatus(options);
  } catch (error) {
    if (!isPortTaken(error)) throw error;
    options.log.warn(`talos: port ${LOCAL_STATUS_PORT} is taken, so the page's "This machine" panel won't show this talos`);
  }
};

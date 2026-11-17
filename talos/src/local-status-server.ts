import { LOCAL_STATUS_HOST, LOCAL_STATUS_PORT, LOCAL_STATUS_ROUTE, type LocalStatus, type Logger } from "talos-shared";
import { buildCorsHeaders } from "./cors";

type LocalStatusServerOptions = {
  allowedOrigin: string;
  readLocalStatus: () => LocalStatus;
  log: Logger;
};

// Lets the page, opened on this same machine, show its "This machine" panel.
export const startLocalStatusServer = ({ allowedOrigin, readLocalStatus, log }: LocalStatusServerOptions): void => {
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

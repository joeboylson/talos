import { LOCAL_STATUS_HOST, LOCAL_STATUS_PORT, LOCAL_STATUS_ROUTE, type LocalStatus } from "talos-shared";
import { buildCorsHeaders } from "./cors";

type LocalStatusServerOptions = {
  allowedOrigin: string;
  readLocalStatus: () => LocalStatus;
};

// Lets the page, opened on this same machine, show its "This machine" panel.
export const startLocalStatusServer = ({ allowedOrigin, readLocalStatus }: LocalStatusServerOptions): void => {
  Bun.serve({
    hostname: LOCAL_STATUS_HOST,
    port: LOCAL_STATUS_PORT,
    fetch(request) {
      const corsHeaders = buildCorsHeaders(request.headers.get("origin"), allowedOrigin);
      const isPreflight = request.method === "OPTIONS";
      if (isPreflight) return new Response(null, { status: 204, headers: corsHeaders });

      const isStatusRequest = new URL(request.url).pathname === LOCAL_STATUS_ROUTE;
      if (!isStatusRequest) return new Response("Not found", { status: 404 });
      return Response.json(readLocalStatus(), { headers: corsHeaders });
    },
  });
};

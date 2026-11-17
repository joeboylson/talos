// The page is served by talos-server, so its address is the server's
// address over http(s): ws://host:7070 → http://host:7070.
export const pageOriginFromServerUrl = (serverUrl: string): string =>
  new URL(serverUrl.replace(/^ws/, "http")).origin;

// Only the page may read this machine's status. Private-Network lets an https
// page read a 127.0.0.1 address in browsers that ask first.
export const buildCorsHeaders = (requestOrigin: string | null, allowedOrigin: string): Record<string, string> => {
  const isAllowedOrigin = requestOrigin === allowedOrigin;
  if (!isAllowedOrigin) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Private-Network": "true",
    Vary: "Origin",
  };
};

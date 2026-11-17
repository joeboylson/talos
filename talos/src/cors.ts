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

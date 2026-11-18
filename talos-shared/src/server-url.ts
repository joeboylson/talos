// The server's web address is its socket address over http(s):
// ws://host:7070 → http://host:7070.
export const httpOriginFromServerUrl = (serverUrl: string): string =>
  new URL(serverUrl.replace(/^ws/, "http")).origin;

const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

// The machine key and every command travel over this address, so it must be
// encrypted (wss://), unless the server is on this same computer.
export const isSafeServerUrl = (serverUrl: string): boolean => {
  const url = URL.parse(serverUrl);
  if (!url) return false;
  if (url.protocol === "wss:") return true;
  return url.protocol === "ws:" && LOCAL_HOSTNAMES.includes(url.hostname);
};

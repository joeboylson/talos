// The server's web address is its socket address over http(s):
// ws://host:7070 → http://host:7070.
export const httpOriginFromServerUrl = (serverUrl: string): string =>
  new URL(serverUrl.replace(/^ws/, "http")).origin;

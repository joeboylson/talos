import { expect, test } from "bun:test";
import { httpOriginFromServerUrl } from "./server-url";

test.each([
  ["ws://localhost:7070", "http://localhost:7070"],
  ["wss://talos.example.com", "https://talos.example.com"],
  ["wss://talos.example.com:8443/some/path", "https://talos.example.com:8443"],
])("httpOriginFromServerUrl(%s) is %s", (serverUrl, expectedOrigin) => {
  expect(httpOriginFromServerUrl(serverUrl)).toBe(expectedOrigin);
});

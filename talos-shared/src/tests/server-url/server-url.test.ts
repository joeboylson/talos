import { expect, test } from "bun:test";
import { httpOriginFromServerUrl, isSafeServerUrl } from "../../server-url";

test.each([
  ["ws://localhost:7070", "http://localhost:7070"],
  ["wss://talos.example.com", "https://talos.example.com"],
  ["wss://talos.example.com:8443/some/path", "https://talos.example.com:8443"],
  ["WSS://talos.example.com", "https://talos.example.com"],
  [" wss://talos.example.com", "https://talos.example.com"],
])("httpOriginFromServerUrl(%s) is %s", (serverUrl, expectedOrigin) => {
  expect(httpOriginFromServerUrl(serverUrl)).toBe(expectedOrigin);
});

test.each([
  ["wss://talos.example.com", true],
  ["ws://localhost:7070", true],
  ["ws://127.0.0.1:7070", true],
  ["ws://[::1]:7070", true],
  ["ws://talos.example.com", false],
  ["http://talos.example.com", false],
  ["http://localhost:7070", false],
  ["not a url", false],
])("isSafeServerUrl %p", (serverUrl, expected) => {
  expect(isSafeServerUrl(serverUrl)).toBe(expected);
});

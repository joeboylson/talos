import { expect, test } from "bun:test";
import { buildCorsHeaders, pageOriginFromServerUrl } from "./cors";

test.each([
  ["ws://localhost:7070", "http://localhost:7070"],
  ["wss://talos.example.com", "https://talos.example.com"],
  ["wss://talos.example.com:8443/some/path", "https://talos.example.com:8443"],
])("pageOriginFromServerUrl(%s) is %s", (serverUrl, expectedOrigin) => {
  expect(pageOriginFromServerUrl(serverUrl)).toBe(expectedOrigin);
});

const PAGE_ORIGIN = "http://localhost:7070";

test("lets the page's origin read the status", () => {
  expect(buildCorsHeaders(PAGE_ORIGIN, PAGE_ORIGIN)).toEqual({
    "Access-Control-Allow-Origin": PAGE_ORIGIN,
    "Access-Control-Allow-Private-Network": "true",
    Vary: "Origin",
  });
});

test.each([
  ["no origin", null],
  ["another site", "https://evil.example.com"],
  ["same host, different port", "http://localhost:9999"],
  ["127.0.0.1 instead of localhost", "http://127.0.0.1:7070"],
])("gives %s no access", (_label, requestOrigin) => {
  expect(buildCorsHeaders(requestOrigin, PAGE_ORIGIN)).toEqual({ Vary: "Origin" });
});

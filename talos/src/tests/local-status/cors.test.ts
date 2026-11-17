import { expect, test } from "bun:test";
import { buildCorsHeaders } from "../../cors";

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

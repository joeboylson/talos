import { expect, test } from "bun:test";
import { readServerConfig } from "../../config";
import { buildTableName } from "../../dynamo";

const FULL_ENV = {
  TALOS_PUBLIC_URL: "http://localhost:7070/",
  TALOS_GITHUB_CLIENT_ID: "client-id",
  TALOS_GITHUB_CLIENT_SECRET: "client-secret",
  TALOS_ADMIN_GITHUB_ID: "34290408",
  TALOS_SESSION_SECRET: "a-session-secret-that-is-long-enough",
};

test("reads the config, with defaults", () => {
  const config = readServerConfig(FULL_ENV, "/auth/callback");
  expect(config.serverPort).toBe(7070);
  expect(config.publicOrigin).toBe("http://localhost:7070");
  expect(config.signInCallbackUrl).toBe("http://localhost:7070/auth/callback");
  expect(config.adminGithubId).toBe(34290408);
  expect(config.tablePrefix).toBe("talos-");
  expect(config.isUsingEmulator).toBe(false);
  expect(config.isProduction).toBe(false);
});

test("notices the emulator and production", () => {
  const config = readServerConfig({ ...FULL_ENV, AWS_ENDPOINT_URL: "https://localhost:9297", NODE_ENV: "production" }, "/x");
  expect(config.isUsingEmulator).toBe(true);
  expect(config.isProduction).toBe(true);
});

test("fails loudly when a required setting is missing", () => {
  const { TALOS_ADMIN_GITHUB_ID: _left_out, ...envWithoutAdmin } = FULL_ENV;
  expect(() => readServerConfig(envWithoutAdmin, "/x")).toThrow("TALOS_ADMIN_GITHUB_ID is not set");
});

test("the admin is a GitHub account number, never a login (logins change hands)", () => {
  expect(() => readServerConfig({ ...FULL_ENV, TALOS_ADMIN_GITHUB_ID: "joeboylson" }, "/x")).toThrow("TALOS_ADMIN_GITHUB_ID");
});

test("a short session secret is refused", () => {
  expect(() => readServerConfig({ ...FULL_ENV, TALOS_SESSION_SECRET: "short" }, "/x")).toThrow("at least 32");
});

test("table names share one prefix", () => {
  expect(buildTableName("talos-", "machines")).toBe("talos-machines");
  expect(buildTableName("talos-", "signIns")).toBe("talos-sign-ins");
  expect(buildTableName("staging-", "settings")).toBe("staging-settings");
});

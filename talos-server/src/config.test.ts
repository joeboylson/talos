import { expect, test } from "bun:test";
import { readServerConfig } from "./config";

const FULL_ENV = {
  TALOS_PUBLIC_URL: "http://localhost:7070/",
  TALOS_GITHUB_CLIENT_ID: "client-id",
  TALOS_GITHUB_CLIENT_SECRET: "client-secret",
  TALOS_ALLOWED_GITHUB_LOGIN: "joeboylson",
  TALOS_SESSION_SECRET: "session-secret",
  TALOS_MACHINES_TABLE: "talos-machines",
};

test("reads the config, with defaults", () => {
  const config = readServerConfig(FULL_ENV, "/auth/callback");
  expect(config.serverPort).toBe(7070);
  expect(config.publicOrigin).toBe("http://localhost:7070");
  expect(config.signInCallbackUrl).toBe("http://localhost:7070/auth/callback");
  expect(config.isUsingEmulator).toBe(false);
  expect(config.isProduction).toBe(false);
});

test("notices the emulator and production", () => {
  const config = readServerConfig({ ...FULL_ENV, AWS_ENDPOINT_URL: "https://localhost:9297", NODE_ENV: "production" }, "/x");
  expect(config.isUsingEmulator).toBe(true);
  expect(config.isProduction).toBe(true);
});

test("fails loudly when a required setting is missing", () => {
  const { TALOS_SESSION_SECRET: _left_out, ...envWithoutSecret } = FULL_ENV;
  expect(() => readServerConfig(envWithoutSecret, "/x")).toThrow("TALOS_SESSION_SECRET is not set");
});

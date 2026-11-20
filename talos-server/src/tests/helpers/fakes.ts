import type { BunRequest } from "bun";
import type { Logger } from "talos-shared";
import type { ServerConfig } from "../../config";
import { COOKIE_NAMES } from "../../constants";
import type { SocketData } from "../../connections";
import { createSessionToken } from "../../session";
import type { SignInRecord, SignInsTable } from "../../sign-ins-table";
import { cookieName } from "../../utils/cookies";

export const quietLog: Logger = { event: () => {}, detail: () => {}, warn: () => {} };

export const TEST_ORIGIN = "https://talos.test";
export const OTHER_ORIGIN = "https://evil.test";
export const ADMIN_GITHUB_ID = 1;
export const testConfig = {
  publicOrigin: TEST_ORIGIN,
  sessionSecret: "a-session-secret-that-is-long-enough-for-tests",
  adminGithubId: ADMIN_GITHUB_ID,
  githubClientId: "client-id",
  githubClientSecret: "client-secret",
  signInCallbackUrl: `${TEST_ORIGIN}/auth/callback`,
} as ServerConfig;

const SESSION_LIFETIME_FOR_TESTS_MS = 3_600_000;
const ISSUED_BEFORE_NOW_MS = 1000;

export const personIdOf = (githubId: number) => `person-${githubId}`;
export const signInOf = (githubId: number): SignInRecord => ({
  signInId: `github-id:${githubId}`,
  personId: personIdOf(githubId),
  displayName: `u${githubId}`,
  linkedAtMs: 0,
});

// Sign-ins for any of these GitHub ids exist; endedAtMs says when each last signed out.
export const fakeSignInsTable = (githubIds: number[], endedAtMs: Map<string, number> = new Map()) => {
  const endedSignIns: string[] = [];
  const table = {
    findSignIn: async (signInId: string) => {
      const githubId = Number(signInId.replace("github-id:", ""));
      if (!githubIds.includes(githubId)) return null;
      const ended = endedAtMs.get(signInId);
      return { ...signInOf(githubId), ...(ended === undefined ? {} : { sessionsEndedAtMs: ended }) };
    },
    saveSignIn: async () => {},
    endSessions: async (signInId: string) => void endedSignIns.push(signInId),
  } as unknown as SignInsTable;
  return { table, endedSignIns };
};

export const sessionCookieFor = (githubId: number, issuedAtMs = Date.now() - ISSUED_BEFORE_NOW_MS) => {
  const { signInId, personId, displayName } = signInOf(githubId);
  const times = { issuedAtMs, expiresAtMs: Date.now() + SESSION_LIFETIME_FOR_TESTS_MS };
  return `${cookieName(COOKIE_NAMES.session, true)}=${createSessionToken({ signInId, personId, displayName }, times, testConfig.sessionSecret)}`;
};

type TestRequest = { method?: string; path?: string; githubId?: number | null; origin?: string | null; body?: unknown; params?: Record<string, string> };

// A request as the router hands it over, signed in as githubId (or no one).
export const testRequest = ({ method = "GET", path = "/x", githubId = null, origin = TEST_ORIGIN, body, params = {} }: TestRequest) => {
  const headers = new Headers();
  if (githubId !== null) headers.set("cookie", sessionCookieFor(githubId));
  if (origin) headers.set("origin", origin);
  const request = new Request(`${TEST_ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return Object.assign(request, { params }) as unknown as BunRequest;
};

// A socket that records what the server sends it, whether it was pinged and how it closed.
export const fakeSocket = (data: SocketData) => {
  const record = { sent: [] as string[], pinged: false, closedWith: null as number | null };
  return {
    data,
    record,
    send: (text: string) => void record.sent.push(text),
    ping: () => void (record.pinged = true),
    close: (code: number) => void (record.closedWith = code),
  };
};

export const pageData = (personId: string, expiresAtMs = Date.now() + SESSION_LIFETIME_FOR_TESTS_MS): SocketData => ({
  role: "page",
  personId,
  displayName: personId,
  expiresAtMs,
});

export const machineData = (machineId: string, ownerPersonId: string): SocketData => ({
  role: "machine",
  machineId,
  machineName: machineId,
  ownerPersonId,
});

export const parsedMessages = (sent: string[]) => sent.map((text) => JSON.parse(text) as { type: string } & Record<string, unknown>);

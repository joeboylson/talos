// Shared pieces for the live session checks: a session runner in a throwaway
// talos folder, real Claude Code sessions in throwaway work folders, and a way
// to act as a session's mod (with its link secret) to try what a hostile one could.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionOf, statusOf } from "../../talos-shared/src";
import { connectToSessions, type SessionSummary } from "../../talos/src/talos-sessions";
import { runnerFetch } from "../../talos/src/talos-sessions/client/runner-client";
import { RUNNER_ROUTES } from "../../talos/src/talos-sessions/client/runner-protocol";
import { homePaths } from "../../talos/src/talos-sessions/constants";

// The talos folder lives here too: the session runner talos spawns reads its
// folder list from TALOS_HOME, which it inherits.
export const HOME = mkdtempSync(join(tmpdir(), "talos-live-"));
process.env.TALOS_HOME = HOME;

export const calls = connectToSessions({ home: HOME, runnerScript: new URL("./runner.ts", import.meta.url).pathname });
export const isRunnerRunning = calls.isRunning;
// Reach-ins: what a hostile session does, which no plain call offers.
const LINK_SOCKET: string = homePaths(HOME).linkSocket;
export const rawEvents = (init: RequestInit) => runnerFetch(HOME, RUNNER_ROUTES.events, init);

// Each check gets its own folder; extra Claude Code settings go in its .claude.
export const makeFolder = (folderName: string, projectSettings?: object): string => {
  const path = join(HOME, "work", folderName);
  mkdirSync(join(path, ".claude"), { recursive: true });
  if (projectSettings) writeFileSync(join(path, ".claude", "settings.json"), JSON.stringify(projectSettings));
  return path;
};

const folders: { folderName: string; path: string }[] = [];
export const allowFolder = (folderName: string, path: string) => {
  folders.push({ folderName, path });
  writeFileSync(join(HOME, "folders.json"), JSON.stringify(folders));
};

export const startRunner = () => calls.ensureRunning();
export const stopRunner = () => calls.stopRunner().catch(() => {});

export const rawSession = async (sessionName: string): Promise<SessionSummary | undefined> =>
  (await calls.sessions()).find((session) => session.sessionName === sessionName);

export const sessionView = async (sessionName: string) => {
  const session = await rawSession(sessionName);
  return session && { ...session, status: statusOf(session), decision: openDecisionOf(session) };
};

export type SessionView = NonNullable<Awaited<ReturnType<typeof sessionView>>>;

export const waitFor = async (sessionName: string, check: (session: SessionView) => boolean, ms = 120_000): Promise<SessionView | null> => {
  const giveUpAt = Date.now() + ms;
  while (Date.now() < giveUpAt) {
    const session = await sessionView(sessionName);
    if (session && check(session)) return session;
    await Bun.sleep(500);
  }
  return null;
};

export const startSession = async (sessionName: string, folderName: string, path: string) => {
  const result = await calls.start(sessionName, folderName, path);
  if (!result.ok) throw new Error(`couldn't start ${sessionName}: ${result.reason}`);
  return waitFor(sessionName, (session) => session.state === "idle", 60_000);
};

export const send = (sessionName: string, text: string) => calls.send(sessionName, text);
// Keys as an attached terminal sends them.
export const typeKeys = (sessionName: string, keys: string) => calls.keys(sessionName, keys);
export const ask = (sessionName: string, kind: string) => calls.ask(sessionName, kind);
export const answer = (sessionName: string, outputId: string, choice: number) => calls.answer(sessionName, outputId, choice);
export const stopSession = (sessionName: string) => calls.stop(sessionName);

// The session's screen as text, for checking what it showed.
export const screen = async (sessionName: string): Promise<string> => {
  const shown = await calls.screen(sessionName);
  if (!shown.ok) throw new Error(shown.reason);
  const reader = shown.stream.getReader();
  setTimeout(() => reader.cancel(), 1000);
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    text += new TextDecoder().decode(value);
  }
};

// What the session itself saw: Claude Code's saved conversation for the folder,
// which holds each tool's reply (the screen folds those away).
export const savedConversation = async (folderPath: string): Promise<string> => {
  const folder = join(homedir(), ".claude", "projects", realpathSync(folderPath).replace(/[^a-zA-Z0-9]/g, "-"));
  const files = existsSync(folder) ? readdirSync(folder).filter((file) => file.endsWith(".jsonl")) : [];
  return (await Promise.all(files.map((file) => Bun.file(join(folder, file)).text()))).join("\n");
};

// The link secret of the one session running, read from its mod's helper
// process: what a hostile session (or anything it runs) can read, as the
// same user.
export const secretOf = async (): Promise<string> => {
  const listing = await new Response(Bun.spawn(["ps", "-AEww", "-o", "command"]).stdout).text();
  const line = listing.split("\n").find((row) => row.includes(`TALOS_LINK_SOCKET=${LINK_SOCKET}`) && row.includes("TALOS_LINK_SECRET="));
  const secret = line?.match(/TALOS_LINK_SECRET=(\S+)/)?.[1];
  if (!secret) throw new Error("no link secret found");
  return secret;
};

export const forgeLink = async (secret: string, route: string, body: unknown): Promise<{ status: number; body: unknown }> => {
  const answer = await fetch(`http://talos${route}`, {
    method: "POST",
    unix: LINK_SOCKET,
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: answer.status, body: await answer.json().catch(() => null) };
};

const results: { name: string; passed: boolean; detail: string }[] = [];
export const check = (name: string, passed: boolean, detail = "") => {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
// Stopping answers once every session has exited and trust is back, so the
// throwaway folder can go.
export const finish = async () => {
  await stopRunner();
  rmSync(HOME, { recursive: true, force: true });
  const failed = results.filter(({ passed }) => !passed);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
};

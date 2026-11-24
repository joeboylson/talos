// What talos's mod does over the link, for the fake Claude: check in with the
// one-use token, send facts and heartbeats, and start the mod's real helper.
// In a folder named relink… it checks in a second time, as a reloaded mod
// would; in one named quiet… it sends no heartbeats, as a stuck mod would.
import { basename, join } from "node:path";
import { writeFileSync } from "node:fs";
import { LINK_ENV_KEYS, LINK_ROUTES, type Fact } from "../../link/link-protocol";
import { MOD_FOLDER } from "../../constants";

const socket = process.env[LINK_ENV_KEYS.socket] ?? "";
const token = process.env[LINK_ENV_KEYS.token] ?? "";
let secret = "";
const HEARTBEAT_MS = 1000;
let seq = 0;


const postJson = (route: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://talos${route}`, { method: "POST", unix: socket, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const checkIn = () => postJson(LINK_ROUTES.checkIn, { token, sessionId: "fake-session", version: "0.0.0", snapshot: "fake" });

export const reportFact = async (type: Fact["type"], details: Record<string, unknown> = {}): Promise<void> => {
  if (!secret) return;
  seq += 1;
  const fact = { seq, type, atMs: Date.now(), sessionId: "fake-session", details };
  await postJson(LINK_ROUTES.facts, { facts: [fact] }, { authorization: `Bearer ${secret}` });
};

const askWithSecret = async (route: string, body: unknown): Promise<Record<string, unknown>> => {
  const answer = await postJson(route, body, { authorization: `Bearer ${secret}` });
  return answer.ok ? ((await answer.json()) as Record<string, unknown>) : {};
};

// A call to one of talos's tools, as the mod's tool.call guard asks about it:
// the reply the session reads, or why it's denied.
// Any other tool call, as the mod's tool.check guard asks about it: true if
// talos's asked-for turn allows it.
export const mayCallTool = async (tool: string): Promise<boolean> => typeof (await askWithSecret(LINK_ROUTES.toolCheck, { tool })).deny !== "string";

export const callTalosTool = (tool: string, toolUseId: string, input: unknown): Promise<Record<string, unknown>> =>
  askWithSecret(LINK_ROUTES.toolCall, { tool, toolUseId, input });

// The helper's process id goes in helper.pid, so a test can end it.
export const linkLikeTheMod = async (): Promise<void> => {
  if (!socket || !token) return;
  const answer = await checkIn();
  if (!answer.ok) return;
  secret = String(((await answer.json()) as { secret: string }).secret);
  const helper = Bun.spawn([process.execPath, join(MOD_FOLDER, "helper.ts")], {
    env: { [LINK_ENV_KEYS.socket]: socket, [LINK_ENV_KEYS.secret]: secret },
    stdout: "pipe",
  });
  void helper.stdout.pipeTo(new WritableStream());
  writeFileSync(join(process.cwd(), "helper.pid"), String(helper.pid));
  await reportFact("session-start");
  if (!basename(process.cwd()).startsWith("quiet")) setInterval(() => void postJson(LINK_ROUTES.facts, { facts: [] }, { authorization: `Bearer ${secret}` }), HEARTBEAT_MS);
  if (basename(process.cwd()).startsWith("relink")) await checkIn();
};

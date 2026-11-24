// What talos's mod does over the link, for the fake Claude: check in with the
// one-use token, send heartbeats, and ask about tool calls.
// In a folder named relink… it checks in a second time, as a reloaded mod
// would; in one named quiet… it sends no heartbeats, as a stuck mod would.
import { basename } from "node:path";
import { LINK_ENV_KEYS, LINK_ROUTES } from "../../link/link-protocol";

const socket = process.env[LINK_ENV_KEYS.socket] ?? "";
const token = process.env[LINK_ENV_KEYS.token] ?? "";
let secret = "";
const HEARTBEAT_MS = 1000;

const postJson = (route: string, body: unknown) =>
  fetch(`http://talos${route}`, {
    method: "POST",
    unix: socket,
    headers: { "content-type": "application/json", ...(secret && { authorization: `Bearer ${secret}` }) },
    body: JSON.stringify(body),
  });

const checkIn = () => postJson(LINK_ROUTES.checkIn, { token, sessionId: "fake-session", version: "0.0.0", snapshot: "fake" });

const ask = async (route: string, body: unknown): Promise<Record<string, unknown>> => {
  const answer = await postJson(route, body);
  return answer.ok ? ((await answer.json()) as Record<string, unknown>) : {};
};

// Any other tool call, as the mod's tool.check guard asks about it: true if
// talos's asked-for turn allows it.
export const mayCallTool = async (tool: string): Promise<boolean> => typeof (await ask(LINK_ROUTES.toolCheck, { tool })).deny !== "string";

// A call to one of talos's tools, as the mod's tool.call guard asks about it:
// the reply the session reads, or why it's denied.
export const callTalosTool = (tool: string, toolUseId: string, input: unknown): Promise<Record<string, unknown>> => ask(LINK_ROUTES.toolCall, { tool, toolUseId, input });

export const linkLikeTheMod = async (): Promise<void> => {
  if (!socket || !token) return;
  const answer = await checkIn();
  if (!answer.ok) return;
  secret = String(((await answer.json()) as { secret: string }).secret);
  if (!basename(process.cwd()).startsWith("quiet")) setInterval(() => void postJson(LINK_ROUTES.heartbeat, {}), HEARTBEAT_MS);
  if (basename(process.cwd()).startsWith("relink")) await checkIn();
};

import type { RefusalCode } from "../client/runner-protocol";

export const refuse = (code: RefusalCode, reason: string, status = 409): Response => Response.json({ code, reason }, { status });

export const noSuchSession = (sessionName: string): Response => refuse("no-such-session", `no session ${sessionName}`, 404);

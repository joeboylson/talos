import type { Logger, Settings } from "talos-shared";
import type { RequestChecks } from "./request-checks";
import type { SessionPerson } from "./session";
import { NO_STORE } from "./constants";
import type { SettingsTable } from "./settings-table";
import { readJsonBody, textResponse } from "./utils/request";

// Only the admin sees or changes settings.
export const createSettingsRoutes = (checks: RequestChecks, settingsTable: SettingsTable, log: Logger) => {
  const isAdminRequest = (person: SessionPerson | null): person is SessionPerson =>
    person !== null && checks.isAdminSignIn(person.signInId);

  const read = async (request: Request): Promise<Response> => {
    if (!isAdminRequest(await checks.readSignedInPerson(request))) return textResponse("Admins only", 403);
    return Response.json(await settingsTable.readSettings(), NO_STORE);
  };

  const update = async (request: Request): Promise<Response> => {
    const person = await checks.readTrustedPerson(request);
    if (!person || !checks.isAdminSignIn(person.signInId)) {
      log.warn(`${person?.displayName ?? "someone not signed in"} tried to change settings`);
      return textResponse("Admins only", 403);
    }
    const body = await readJsonBody(request);
    const allowNewPeople: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "allowNewPeople") : undefined;
    if (typeof allowNewPeople !== "boolean") return textResponse("allowNewPeople must be true or false", 400);

    const settings: Settings = { allowNewPeople };
    await settingsTable.saveSettings(settings);
    log.event(`${person.displayName} switched new people ${allowNewPeople ? "on: anyone can sign up" : "off: new people are turned away"}`);
    return Response.json(settings, NO_STORE);
  };

  return { read, update };
};

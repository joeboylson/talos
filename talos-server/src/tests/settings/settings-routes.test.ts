import { describe, expect, test } from "bun:test";
import type { Settings } from "talos-shared";
import { createRequestChecks } from "../../request-checks";
import { createSettingsRoutes } from "../../settings-routes";
import type { SettingsTable } from "../../settings-table";
import { ADMIN_GITHUB_ID, fakeSignInsTable, quietLog, testConfig, testRequest } from "../helpers/fakes";

const SOMEONE = 2;

const setUp = () => {
  const saved: Settings[] = [];
  const settingsTable = {
    readSettings: async () => ({ allowNewPeople: false }),
    saveSettings: async (settings: Settings) => void saved.push(settings),
  } as unknown as SettingsTable;
  const checks = createRequestChecks(testConfig, fakeSignInsTable([ADMIN_GITHUB_ID, SOMEONE]).table);
  return { routes: createSettingsRoutes(checks, settingsTable, quietLog), saved };
};

describe("settings are the admin's alone", () => {
  test("someone else can't read them", async () => {
    expect((await setUp().routes.read(testRequest({ githubId: SOMEONE }))).status).toBe(403);
  });

  test("someone else can't change them", async () => {
    const { routes, saved } = setUp();
    expect((await routes.update(testRequest({ method: "PUT", githubId: SOMEONE, body: { allowNewPeople: true } }))).status).toBe(403);
    expect(saved).toEqual([]);
  });

  test("the admin can read and change them", async () => {
    const { routes, saved } = setUp();
    expect((await routes.read(testRequest({ githubId: ADMIN_GITHUB_ID }))).status).toBe(200);
    expect((await routes.update(testRequest({ method: "PUT", githubId: ADMIN_GITHUB_ID, body: { allowNewPeople: true } }))).status).toBe(200);
    expect(saved).toEqual([{ allowNewPeople: true }]);
  });

  test("anything but true or false is turned down and not saved", async () => {
    const { routes, saved } = setUp();
    expect((await routes.update(testRequest({ method: "PUT", githubId: ADMIN_GITHUB_ID, body: { allowNewPeople: "yes" } }))).status).toBe(400);
    expect(saved).toEqual([]);
  });
});

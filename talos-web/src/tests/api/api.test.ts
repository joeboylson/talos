import { afterAll, expect, spyOn, test } from "bun:test";
import type { CurrentUserResponse } from "talos-shared";
import { fetchCurrentUser } from "../../api";

const fetchSpy = spyOn(globalThis, "fetch");
const answerWith = (status: number, body: unknown = {}) =>
  fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

afterAll(() => fetchSpy.mockRestore());

test("fetchCurrentUser: 401 means nobody is signed in", async () => {
  answerWith(401);
  expect(await fetchCurrentUser()).toBeNull();
});

test("fetchCurrentUser: other failures throw", async () => {
  answerWith(403);
  await expect(fetchCurrentUser()).rejects.toThrow("403");
});

test("fetchCurrentUser: returns who's signed in", async () => {
  const signedIn: CurrentUserResponse = { displayName: "joe", isAdmin: false };
  answerWith(200, signedIn);
  expect(await fetchCurrentUser()).toEqual(signedIn);
});

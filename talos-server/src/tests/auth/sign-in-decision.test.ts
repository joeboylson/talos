import { describe, expect, test } from "bun:test";
import { decideSignIn } from "../../sign-in-decision";
import { buildGithubSignInId } from "../../sign-ins-table";

describe("decideSignIn", () => {
  test.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])("someone who's been here before always gets in (admin %p, switch %p)", (isAdmin, allowNewPeople) => {
    expect(decideSignIn({ existingPersonId: "person-1", isAdmin, allowNewPeople })).toEqual({
      outcome: "welcome-back",
      personId: "person-1",
    });
  });

  test("a new person gets in while the switch is on", () => {
    expect(decideSignIn({ existingPersonId: null, isAdmin: false, allowNewPeople: true })).toEqual({ outcome: "new-person" });
  });

  test("a new person is turned away while the switch is off", () => {
    expect(decideSignIn({ existingPersonId: null, isAdmin: false, allowNewPeople: false })).toEqual({ outcome: "closed" });
  });

  test("the admin gets in on a fresh server with the switch off", () => {
    expect(decideSignIn({ existingPersonId: null, isAdmin: true, allowNewPeople: false })).toEqual({ outcome: "new-person" });
  });
});

test("buildGithubSignInId ignores case, since GitHub logins do", () => {
  expect(buildGithubSignInId("JoeBoylson")).toBe("github:joeboylson");
});

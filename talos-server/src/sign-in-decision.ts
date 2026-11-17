export type SignInDecision =
  | { outcome: "welcome-back"; personId: string }
  | { outcome: "new-person" }
  | { outcome: "closed" };

type SignInFacts = { existingPersonId: string | null; isAdmin: boolean; allowNewPeople: boolean };

// People who've been here before always get in. A new person gets in only
// while the admin's switch is on; the admin always does, so a fresh server
// can't lock its own admin out.
export const decideSignIn = ({ existingPersonId, isAdmin, allowNewPeople }: SignInFacts): SignInDecision => {
  if (existingPersonId) return { outcome: "welcome-back", personId: existingPersonId };
  if (isAdmin || allowNewPeople) return { outcome: "new-person" };
  return { outcome: "closed" };
};

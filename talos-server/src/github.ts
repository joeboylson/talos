import { GITHUB_URLS, GITHUB_USER_AGENT } from "./constants";

type GithubAppSettings = { clientId: string; clientSecret: string; redirectUri: string };

export const buildGithubSignInUrl = (clientId: string, redirectUri: string, signInState: string): string => {
  const signInUrl = new URL(GITHUB_URLS.authorize);
  signInUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state: signInState,
    allow_signup: "false",
  }).toString();
  return signInUrl.toString();
};

// GitHub's permanent number for an account, and its current login. Logins
// can change hands (rename an account and anyone can take the old name), so
// Talos knows people by the number and only shows the login.
export type GithubUser = { githubId: number; login: string };

// Swaps the one-time code GitHub sends back for the signed-in person.
export const fetchGithubUser = async (code: string, settings: GithubAppSettings): Promise<GithubUser> => {
  const tokenResponse = await fetch(GITHUB_URLS.accessToken, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      code,
      redirect_uri: settings.redirectUri,
    }),
  });
  // GitHub's documented reply shape; checked right below.
  const tokenBody = (await tokenResponse.json()) as { access_token?: string; error_description?: string };
  if (!tokenBody.access_token) {
    throw new Error(`GitHub refused the sign-in code: ${tokenBody.error_description ?? tokenResponse.status}`);
  }

  const userResponse = await fetch(GITHUB_URLS.user, {
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": GITHUB_USER_AGENT,
    },
  });
  if (!userResponse.ok) throw new Error(`GitHub user lookup failed: ${userResponse.status}`);
  const githubUser: unknown = await userResponse.json();
  const githubId: unknown = typeof githubUser === "object" && githubUser !== null ? Reflect.get(githubUser, "id") : null;
  const login: unknown = typeof githubUser === "object" && githubUser !== null ? Reflect.get(githubUser, "login") : null;
  if (!Number.isSafeInteger(githubId) || typeof login !== "string") throw new Error("GitHub sent an unexpected user");
  return { githubId: Number(githubId), login };
};

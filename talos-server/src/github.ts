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

// Swaps the one-time code GitHub sends back for the signed-in person's login.
export const fetchGithubLogin = async (code: string, settings: GithubAppSettings): Promise<string> => {
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
  const githubUser = (await userResponse.json()) as { login: string };
  return githubUser.login;
};

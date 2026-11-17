export const requireEnv = (envKey: string, env: Record<string, string | undefined> = process.env): string => {
  const envValue = env[envKey];
  if (!envValue) throw new Error(`${envKey} is not set. Copy .env.example to .env and fill it in.`);
  return envValue;
};

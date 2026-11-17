export const SIGN_IN_CLOSED_MESSAGE = "Talos isn't taking new people right now.";

// The two letters shown in the avatar: "joeboylson" → "JO".
export const buildInitials = (displayName: string): string => displayName.slice(0, 2).toUpperCase();

export const formatRoundTrip = (roundTripMs: number | undefined): string =>
  roundTripMs === undefined ? "—" : `${roundTripMs} ms`;

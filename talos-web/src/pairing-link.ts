// A pairing link (talos prints one) carries its code in the address. Signing
// in first lands on the home page, which would lose it, so the sign-in page
// keeps the code in this tab until the pairing dialog takes it.
import { PAIR_CODE_PARAMETER } from "talos-shared";

const KEPT_PAIR_CODE_KEY = "talos-pair-code";

const codeInAddress = (): string | null => new URL(location.href).searchParams.get(PAIR_CODE_PARAMETER);

// Browser storage can be off (a private window, blocked site data): then the
// code is only lost, as without this.
export const keepPairCodeForSignIn = (): void => {
  const code = codeInAddress();
  if (!code) return;
  try {
    sessionStorage.setItem(KEPT_PAIR_CODE_KEY, code);
  } catch {
    // Kept nowhere; the terminal still shows the code.
  }
};

const takeKeptPairCode = (): string | null => {
  try {
    const code = sessionStorage.getItem(KEPT_PAIR_CODE_KEY);
    sessionStorage.removeItem(KEPT_PAIR_CODE_KEY);
    return code;
  } catch {
    return null;
  }
};

// The code from the address, or kept from before sign-in. It leaves the
// address once read, so a reload doesn't reopen the dialog.
export const takePairCode = (): string | null => {
  const code = codeInAddress();
  if (!code) return takeKeptPairCode();
  const url = new URL(location.href);
  url.searchParams.delete(PAIR_CODE_PARAMETER);
  history.replaceState(history.state, "", url);
  takeKeptPairCode();
  return code;
};

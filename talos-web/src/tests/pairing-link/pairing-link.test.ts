import { afterEach, expect, test } from "bun:test";
import { keepPairCodeForSignIn, takePairCode } from "../../pairing-link";

// A stand-in for the browser's address, history and session storage.
const browserAt = (address: string) => {
  const stored = new Map<string, string>();
  const page = { href: address };
  Object.assign(globalThis, {
    location: page,
    history: { state: null, replaceState: (_state: unknown, _title: string, url: URL) => (page.href = String(url)) },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    },
  });
  return { page, goTo: (next: string) => (page.href = next) };
};
afterEach(() => Object.assign(globalThis, { location: undefined, history: undefined, sessionStorage: undefined }));

test("a link's code fills the dialog once, then leaves the address", () => {
  const { page } = browserAt("https://talos.example/machines?pair=ABCD-EFGH");
  expect(takePairCode()).toBe("ABCD-EFGH");
  expect(page.href).toBe("https://talos.example/machines");
  expect(takePairCode()).toBeNull();
});

test("a link opened signed out keeps its code through sign-in, which lands on the home page", () => {
  const { goTo } = browserAt("https://talos.example/machines?pair=ABCD-EFGH");
  keepPairCodeForSignIn();
  goTo("https://talos.example/machines");
  expect(takePairCode()).toBe("ABCD-EFGH");
  expect(takePairCode()).toBeNull();
});

test("with browser storage off, the code is only lost, nothing breaks", () => {
  browserAt("https://talos.example/machines?pair=ABCD-EFGH");
  Object.assign(globalThis, { sessionStorage: { setItem: () => { throw new Error("off"); }, getItem: () => { throw new Error("off"); }, removeItem: () => {} } });
  expect(() => keepPairCodeForSignIn()).not.toThrow();
  expect(takePairCode()).toBe("ABCD-EFGH");
});

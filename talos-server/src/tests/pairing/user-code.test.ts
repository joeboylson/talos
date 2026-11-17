import { expect, test } from "bun:test";
import { USER_CODE_ALPHABET } from "../../constants";
import { buildUserCode, createUserCode, normalizeUserCode } from "../../user-code";

test("buildUserCode maps bytes onto the alphabet in two groups", () => {
  expect(buildUserCode(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).toBe("ABCD-EFGH");
  expect(buildUserCode(new Uint8Array([31, 32, 63, 255, 0, 0, 0, 0]))).toBe("9A99-AAAA");
});

test("createUserCode uses only the readable alphabet", () => {
  const userCode = createUserCode();
  expect(userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect([...userCode.replace("-", "")].every((letter) => USER_CODE_ALPHABET.includes(letter))).toBe(true);
});

test.each([
  ["ABCD-EFGH", "ABCD-EFGH"],
  ["abcd-efgh", "ABCD-EFGH"],
  ["abcdefgh", "ABCD-EFGH"],
  [" ab cd ef gh ", "ABCD-EFGH"],
])("normalizeUserCode(%p) is %p", (typedCode, expectedCode) => {
  expect(normalizeUserCode(typedCode)).toBe(expectedCode);
});

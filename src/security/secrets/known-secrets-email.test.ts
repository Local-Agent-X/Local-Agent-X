// An email address is an account name, not a credential. Every vault value is
// registered as a known secret, so a login email saved beside its password made
// the agent's typing of the user's own address into a login form a refused
// "Known Secret Value" (2026-10-04, Twilio).
import { afterEach, describe, expect, it } from "vitest";
import { isEmailAddress, knownSecretValues, registerRedactedSecretValue, unregisterRedactedSecretValue } from "./known-secrets.js";
import { scanForSecrets } from "./secret-scanner.js";

const EMAIL = "peter@pmajlabs.example";
const WEBHOOK = "https://hooks.slack.com/services/T0001/B0002/Xy7Qz9Lm3Np5Rt8Vw2Ks";
const PASSWORD = "Tw1lio-login-Passw0rd!";

afterEach(() => { for (const v of [EMAIL, WEBHOOK, PASSWORD]) unregisterRedactedSecretValue(v); });

describe("the known-secret registry holds credentials, not addresses", () => {
  it("does not register an email address", () => {
    registerRedactedSecretValue(EMAIL);
    expect(knownSecretValues()).not.toContain(EMAIL);
    expect(scanForSecrets(`fill ${EMAIL} into the username box`).matches.some((m) => m.pattern === "Known Secret Value")).toBe(false);
  });

  it("still registers a password and a URL that is itself the credential", () => {
    registerRedactedSecretValue(PASSWORD);
    registerRedactedSecretValue(WEBHOOK);
    expect(knownSecretValues()).toEqual(expect.arrayContaining([PASSWORD, WEBHOOK]));
  });

  it.each([
    ["peter@pmajlabs.com", true], ["first.last+tag@mail.example.co.uk", true],
    ["user@host", false], ["https://example.com/a@b", false], ["eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl", false],
  ])("isEmailAddress(%s) = %s", (value, expected) => {
    expect(isEmailAddress(value)).toBe(expected);
  });
});

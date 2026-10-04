// One rule says which names hold a credential: the catalog's key list
// (CREDENTIAL_KEY_NAMES) for `key=value` text, namesCredential for a JSON key
// or a form field's label. A pagination cursor is not a credential: treating
// `pageToken=` / `$skiptoken=` as one masked Google, AWS and Graph paging out of
// every response and refused the next-page request.
import { describe, expect, it } from "vitest";
import { namesCredential } from "./credential-patterns.js";
import { scanForSecrets } from "./secret-scanner.js";

const VALUE = "Zq8vN2kR7tLw4Xp9Hs3Jd6Fb1Mc5Gy0Ae8Uo2Ki7";
// Caught by the catalog (any entry but the loose entropy pass, which the
// outbound scan judges separately by site provenance).
const keyValueHit = (text: string) => scanForSecrets(text).matches.some((m) => m.type !== "high-entropy-token");

describe("namesCredential", () => {
  it.each([
    "access_token", "refresh_token", "id_token", "client_secret", "apiKey", "api-key", "password",
    "privateKey", "secret_key", "Authorization", "API Key", "Auth Token", "Secret key", "Client secret",
  ])("names a credential: %s", (name) => {
    expect(namesCredential(name)).toBe(true);
  });

  it.each([
    "id", "account_sid", "Account SID", "token_type", "api_key_id", "secretName", "password_policy",
    "pageToken", "nextPageToken", "NextToken", "$skiptoken", "continuationToken", "syncToken", "pagination_token", "Order ID",
  ])("does not: %s", (name) => {
    expect(namesCredential(name)).toBe(false);
  });
});

describe("the Key-Value catalog entry uses the same names", () => {
  it.each([
    `pageToken=${VALUE}`, `NextToken=${VALUE}`, `$skiptoken=${VALUE}`, `continuation-token=${VALUE}`, `nextPageToken: ${VALUE}`,
  ])("a pagination cursor is not a credential: %s", (text) => {
    expect(keyValueHit(text)).toBe(false);
  });

  it.each([
    `GITHUB_TOKEN=${VALUE}`, `access_token=${VALUE}`, `SECRET_KEY=${VALUE}`, `privateKey: ${VALUE}`, `password=${VALUE}`,
    `MY_PAGE_TOKEN_SECRET=${VALUE}`,
  ])("a credential assignment still is: %s", (text) => {
    expect(keyValueHit(text)).toBe(true);
  });
});

// Masking stopped hiding values for looking random (secret-values.ts); a
// session cookie, a `pwd` field and a `credential` then reached the model
// because their names were not on the list.
describe("login sessions and password spellings are credential names", () => {
  it.each(["set-cookie", "Cookie", "pwd", "passwd", "passphrase", "credential", "client_credentials"])("names a credential: %s", (name) => {
    expect(namesCredential(name)).toBe(true);
  });

  it.each([
    `set-cookie: connect.sid=s%3AQx7vB2mK9pL4wR8tY1nZ6cJ3hF5dG0aE; Path=/; HttpOnly`,
    `Cookie: sessionid=Qx7vB2mK9pL4wR8tY1nZ6cJ3`,
    `pwd=${VALUE}`,
  ])("is caught: %s", (text) => {
    expect(keyValueHit(text)).toBe(true);
  });

  it("an app's own session id is not a credential name (the agent's chat ids are named that)", () => {
    expect(namesCredential("sessionId")).toBe(false);
  });
});

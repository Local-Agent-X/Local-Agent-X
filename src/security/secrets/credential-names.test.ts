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

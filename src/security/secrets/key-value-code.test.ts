// The generic Key-Value rule reads `token = <value>` as a credential. In code
// and config the right-hand side is as often a NAME for the credential: an
// expression computing it refused the write of a TV remote's pairing modules
// (Vizio and Samsung, 2026-11-20), and an environment variable's name refused
// an app's Firebase setup (2026-11-22). A name is not a value; a literal still is.
import { describe, it, expect } from "vitest";
import { scanForSecrets } from "./secret-scanner.js";
import { redact } from "./credential-patterns.js";
import { withholdSecretValues } from "../../data-lineage/secret-values.js";

const keyValueHits = (text: string) => scanForSecrets(text).matches.filter((m) => m.pattern.startsWith("Key-Value Secret"));

describe("Key-Value Secret and code", () => {
  it.each([
    ["a template interpolation", "url += `&token=${encodeURIComponent(saved.token)}`;"],
    ["a call", "if (key) { saved.token = String(key); save(); }"],
    ["a property read", "{ CHALLENGE_TYPE: pairing.challenge, PAIRING_REQ_TOKEN: pairing.token, }"],
    ["a call on a path", "const password = process.env.getPassword();"],
    // The two lines that stopped the Firebase setup chunk (2026-11-22).
    ["a long environment variable read", "  debugToken: process.env.EXPO_PUBLIC_APPCHECK_DEBUG_TOKEN,"],
    ["an environment variable's name", "token=EXPO_PUBLIC_APPCHECK_DEBUG_TOKEN"],
    ["a name with digits", "api_key: process.env.STRIPE_API_KEY_V2"],
    ["a camelCase path with a trailing digit", "const token = config.firebase.appCheckTokenV2;"],
    ["an index read", 'const apiKey = process.env["OPENAI_API_KEY"];'],
    ["a Python environment read", 'password = os.environ["DATABASE_PASSWORD"]'],
    ["a shell variable", 'curl -H "Authorization: $GITHUB_TOKEN_VALUE" https://api.github.com'],
    ["a CI secret reference", "  token: ${{ secrets.NPM_PUBLISH_TOKEN }}"],
    ["a LAX placeholder", "Authorization: {{OPENAI_API_KEY}}"],
    ["a quoted name", 'token: "EXPO_PUBLIC_APPCHECK_DEBUG_TOKEN"'],
    ["a template literal", "const token = `${prefix}${suffix}`;"],
    ["a path closed by a paren", "send(token=self.settings.secret_token)"],
    // A build worker's dev server with demo Firebase settings was held as a
    // possible password (Shop Helper, 2026-11-27).
    ["a demo stand-in", "VITE_FIREBASE_API_KEY=demo-api-key node vite.js"],
    ["a 'your ... here' stand-in", 'api_key: "your_secret_key_here"'],
    ["a fake stand-in", "password=fake-password-value"],
  ])("is not raised by %s", (_shape, line) => {
    expect(keyValueHits(line)).toEqual([]);
  });

  it.each([
    ["an unquoted literal", "token=Zx9qR2mWv7LkP4tY8nHc"],
    ["a quoted literal", 'api_key: "Zx9qR2mWv7LkP4tY8nHc"'],
    ["a dotted key with digits", "token = pk.eyJ1IjoiZXhhbXBsZSIsImEiOiJ4In0"],
    ["a password that only starts like a name", "password=Summer2026Rocks!"],
    // A placeholder word inside a real-looking value does not make it a stand-in.
    ["a key with digits beside a placeholder word", "api_key=test-9fK2mQ7xLp4vR8"],
    ["a mixed-case value beside a placeholder word", "token=Demo-ProdKey-Alpha-Bravo"],
    ["lowercase words with no placeholder word", "password=correct-horse-battery-staple"],
    ["a lowercase snake password", "password=correct_horse_battery_staple"],
    ["a base64url token with underscores", "token=xK9_mQ2vLp_7RtWz3nYb4"],
    ["a token after a dot", "secret = sess.Zx9qR2mWv7LkP4tY8nHc"],
    ["a value that continues past a name", "cookie: connect.sid=s%3Aj9K2LmQ7.xYz"],
    ["a mixed-case token shaped like a name", "token=Ab3Cd9Ef_Gh2Ij8Kl"],
    ["a bcrypt hash", "password=$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"],
  ])("still catches %s", (_shape, line) => {
    expect(scanForSecrets(line).clean).toBe(false);
  });

  it("does not register a name as a secret when it masks tool output", () => {
    const out = "const firebase = { debugToken: process.env.EXPO_PUBLIC_APPCHECK_DEBUG_TOKEN };\ntoken=EXPO_PUBLIC_APPCHECK_DEBUG_TOKEN\n";
    const r = withholdSecretValues(out);
    expect(r.masked).toBe(0);
    expect(r.text).toBe(out);
    expect(scanForSecrets("EXPO_PUBLIC_APPCHECK_DEBUG_TOKEN").clean).toBe(true);
  });

  it("leaves a name alone in the log redactor and in decoded views, and still redacts a value there", () => {
    const line = "debugToken: process.env.EXPO_PUBLIC_APPCHECK_DEBUG_TOKEN";
    expect(redact(line)).toBe(line);
    expect(redact("token=Zx9qR2mWv7LkP4tY8nHc")).not.toContain("Zx9qR2mWv7LkP4tY8nHc");
    const encoded = (s: string) => `payload=${Buffer.from(s).toString("base64")}`;
    expect(scanForSecrets(encoded(line)).clean).toBe(true);
    expect(scanForSecrets(encoded("token=Zx9qR2mWv7LkP4tY8nHc")).clean).toBe(false);
  });
});

// An evaluate result cannot carry what the page holds as a credential, however
// the script spelled the read: the guard is on the result, against values the
// host read from the page itself before the script ran.
import { describe, it, expect, vi } from "vitest";
import { handleEvaluate } from "../tools/browser-tools/page.js";
import type { BrowserBackend } from "./index.js";
import { heldSecretValues, maskHeldSecrets, HELD_SECRET_KIND } from "./evaluate-held-secrets.js";
import { heldSecretsScript, type HeldSecret, type SecretBrowserOps } from "./secret-ops.js";

const SESSION_COOKIE = "s%3A8f3kQm2vZpL9xT4wNb7cRd6yHj1aG0uE";
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const PASSWORD = "correct-horse-battery";

const holding = (held: HeldSecret[]): SecretBrowserOps => ({
  currentOrigin: async () => "https://app.example",
  describeElement: async () => ({ found: false, tag: "", type: "", autocomplete: "" }),
  readValue: async () => null,
  fillValue: async () => ({ kind: "not-found" }),
  pressEnter: async () => undefined,
  visibleValues: async () => [],
  heldSecrets: async () => held,
  markRef: async () => null,
});

describe("heldSecretValues — what the page holds that counts as a credential", () => {
  it("a long, secret-shaped cookie counts; a preference cookie does not", async () => {
    const values = await heldSecretValues(holding([
      { kind: "cookie", name: "session", value: SESSION_COOKIE },
      { kind: "cookie", name: "theme", value: "light" },
      { kind: "cookie", name: "lang", value: "en-US" },
      { kind: "cookie", name: "visits", value: "1234567890123" },
    ]));
    expect(values).toEqual([SESSION_COOKIE]);
  });

  it("a storage entry counts under a credential name or with a credential format, not as cached page data", async () => {
    const values = await heldSecretValues(holding([
      { kind: "storage", name: "sb-abc-auth-token", value: `{"access_token":"${JWT}"}` },
      { kind: "storage", name: "cache:products", value: JWT },
      { kind: "storage", name: "cache:listing", value: '[{"id":"prod_1","title":"Blue mug"}]' },
      { kind: "storage", name: "ui:collapsed", value: "sidebar,filters" },
    ]));
    expect(values).toEqual([`{"access_token":"${JWT}"}`, JWT]);
  });

  it("a password field's value counts whenever it is secret-shaped", async () => {
    const values = await heldSecretValues(holding([
      { kind: "password-field", name: "password", value: PASSWORD },
      { kind: "password-field", name: "pin", value: "1234" },
      { kind: "password-field", name: "empty", value: "" },
    ]));
    expect(values).toEqual([PASSWORD]);
  });

  it("an email address never counts: it is the account's name, not its credential", async () => {
    expect(await heldSecretValues(holding([{ kind: "cookie", name: "user", value: "someone@example.com" }]))).toEqual([]);
  });
});

describe("maskHeldSecrets — the result loses the values and keeps everything else", () => {
  it("masks a held value raw, inside JSON, and base64-encoded, and says so", () => {
    const out = maskHeldSecrets(
      `{"cookie":"session=${SESSION_COOKIE}","title":"Dashboard","b64":"${Buffer.from(SESSION_COOKIE).toString("base64")}"}`,
      [SESSION_COOKIE],
    );
    expect(out).not.toContain(SESSION_COOKIE);
    expect(out).not.toContain(Buffer.from(SESSION_COOKIE).toString("base64"));
    expect(out).toContain('"title":"Dashboard"');
    expect(out).toContain(`[redacted-secret:${HELD_SECRET_KIND}]`);
    expect(out).toMatch(/2 values the page holds as a credential/);
  });

  it("leaves a result that carries none of them byte-identical, with no note", () => {
    const result = "[\"Blue mug\",\"Red mug\"]";
    expect(maskHeldSecrets(result, [SESSION_COOKIE, PASSWORD])).toBe(result);
    expect(maskHeldSecrets(result, [])).toBe(result);
  });

  it("masks a password a script pulled out of its field by any spelling", () => {
    // The script blocklist never saw `type^="pass"`; the result guard needs no spelling.
    expect(maskHeldSecrets(`["${PASSWORD}"]`, [PASSWORD])).not.toContain(PASSWORD);
  });
});

describe("browser evaluate with a page that holds a credential", () => {
  const manager = (result: string) =>
    ({ getCurrentUrl: () => "https://app.example/dashboard", evaluate: vi.fn(async () => result) }) as unknown as BrowserBackend;

  it("reads what the page holds BEFORE the script runs, and the result loses it", async () => {
    const order: string[] = [];
    const ops = holding([{ kind: "cookie", name: "session", value: SESSION_COOKIE }]);
    const reading = { ...ops, heldSecrets: async () => { order.push("read"); return ops.heldSecrets(); } };
    const m = manager(`cookie=${SESSION_COOKIE}`);
    (m.evaluate as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push("script"); return `cookie=${SESSION_COOKIE}`; });

    const result = await handleEvaluate(m, { script: "(() => { const d = document; return d['coo' + 'kie']; })()" }, reading);
    expect(order).toEqual(["read", "script"]);
    expect(String(result.content)).not.toContain(SESSION_COOKIE);
    expect(String(result.content)).toMatch(/the page holds as a credential/);
  });

  it("an ordinary result passes through byte-identical", async () => {
    const result = await handleEvaluate(manager("Dashboard"), { script: "document.title" }, holding([{ kind: "cookie", name: "session", value: SESSION_COOKIE }]));
    expect(result.content).toBe("Dashboard");
  });
});

describe("heldSecretsScript", () => {
  it("reads cookies both raw and decoded, both storages, and password fields, and is valid JS", () => {
    const script = heldSecretsScript();
    expect(() => new Function(`return ${script}`)).not.toThrow();
    for (const needle of ["document.cookie", "decodeURIComponent", "window.localStorage", "window.sessionStorage", "input[type=password]"]) {
      expect(script).toContain(needle);
    }
  });
});

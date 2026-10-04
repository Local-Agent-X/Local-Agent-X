// The SOURCE rule: a secret-bearing tool response reaches the model with every
// VALUE masked and every name intact, and each masked value is registered as a
// known secret so the EXISTING outbound scan refuses it at every egress sink —
// plain or encoded — even though the session is not tainted.
//
// Incident 2026-09-27: a GET of a project's secrets endpoint carried the user's
// values into the tool result; the only reason the model did not see them was
// that its `find` filter happened to match nothing.

import { describe, it, expect, afterEach } from "vitest";
import { maskSecretValues, withholdSecretValues, isSecretEndpointUrl, checkEgressTaint } from "./index.js";
import { scanForSecrets, unregisterRedactedSecretValue, knownSecretValues } from "../security/secrets/index.js";
import { egressGuardGate } from "../tool-execution/enforce-policy.js";
import { makeCtx } from "../tool-execution/capability-class-gates.test-helper.js";

const PAT = "ghp_" + "Qx7" .repeat(12); // GitHub PAT shape, 36+ chars
const AWS = "AKIAIOSFODNN7EXAMPLE";

describe("maskSecretValues — values masked in place, names and structure kept", () => {
  it("masks a labelled value to its prefix and keeps the label", () => {
    const r = maskSecretValues(`GITHUB_TOKEN | token: ${PAT} | scopes: repo`);
    expect(r.text).toBe("GITHUB_TOKEN | token: ghp_**** | scopes: repo");
    expect(r.masked).toBe(1);
    expect(r.kinds).toEqual(["GitHub PAT"]);
    expect(r.values).toEqual([PAT]);
  });

  it("keeps a JSON secrets listing readable: names visible, values masked", () => {
    const body = JSON.stringify([
      { name: "DB_PASSWORD", value: "correct horse battery staple 42" },
      { name: "SUPABASE_URL", value: "https://abc.supabase.co" },
      { name: "SERVICE_KEY", value: "sbp_" + "a1B2".repeat(8) },
    ], null, 2);
    const r = maskSecretValues(body, { endpoint: true });
    for (const name of ["DB_PASSWORD", "SUPABASE_URL", "SERVICE_KEY"]) expect(r.text).toContain(`"name": "${name}"`);
    expect(r.text).not.toContain("correct horse");
    expect(r.text).not.toContain("abc.supabase.co");
    expect(r.text).not.toContain("a1B2a1B2");
    expect(r.text).toContain('"value": "corr****"');
    expect(r.text).toContain('"value": "sbp_****"');
    expect(r.masked).toBe(3);
    expect(JSON.parse(r.text)).toHaveLength(3);
    // The password is registered; the project URL is masked but NOT registered,
    // since refusing every later request to it would brick the project's own API.
    expect(r.values).toContain("correct horse battery staple 42");
    expect(r.values).not.toContain("https://abc.supabase.co");
  });

  it("a `{name, value}` record is only a secret when it came from a secrets endpoint", () => {
    const body = JSON.stringify({ name: "theme", value: "midnight-blue-v2" });
    expect(maskSecretValues(body).masked).toBe(0);
    expect(maskSecretValues(body, { endpoint: true }).masked).toBe(1);
  });

  it("a short endpoint value is masked but not registered (substring matcher would refuse benign payloads)", () => {
    const r = maskSecretValues(JSON.stringify({ name: "REGION", value: "us-east-1" }), { endpoint: true });
    expect(r.text).not.toContain("us-east-1");
    expect(r.masked).toBe(1);
    expect(r.values).toEqual([]);
  });

  it("isSecretEndpointUrl matches the shapes the kernel rule keyed on", () => {
    expect(isSecretEndpointUrl("https://api.supabase.com/v1/projects/abc/secrets")).toBe(true);
    expect(isSecretEndpointUrl("https://vault.internal/v1/kv/data/app")).toBe(true);
    expect(isSecretEndpointUrl("https://example.com/.well-known/keys")).toBe(true);
    expect(isSecretEndpointUrl("https://api.supabase.com/v1/projects/abc/database/query")).toBe(false);
    expect(isSecretEndpointUrl(undefined)).toBe(false);
  });

  // A substring anywhere in the URL treated a repository's every listing as a
  // vault: every "value" in it masked and registered.
  it("isSecretEndpointUrl judges a host label or a whole path segment, not a substring", () => {
    expect(isSecretEndpointUrl("https://myvault.vault.azure.net/secrets/db?api-version=7.4")).toBe(true);
    expect(isSecretEndpointUrl("https://secretsmanager.us-east-1.amazonaws.com/")).toBe(true);
    expect(isSecretEndpointUrl("https://vault.example.com/v1/secret/data/app")).toBe(true);
    expect(isSecretEndpointUrl("https://api.github.com/repos/acme/app/actions/secrets")).toBe(true);
    expect(isSecretEndpointUrl("https://api.github.com/repos/acme/vault-ui/actions/variables")).toBe(false);
    expect(isSecretEndpointUrl("https://docs.example.com/guides/rotating-credentials-safely")).toBe(false);
  });

  it("a presence-only marker is neither masked nor registered", () => {
    const text = "-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----";
    const r = maskSecretValues(text);
    expect(r.text).toBe(text);
    expect(r.masked).toBe(0);
    expect(r.values).toEqual([]);
  });

  it("a whole PEM block has no nameable prefix and is replaced as a block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
    const r = maskSecretValues(`key:\n${pem}\ndone`);
    expect(r.text).toBe("key:\n[redacted-secret:Private Key (PEM)]\ndone");
    expect(r.values).toEqual([pem]);
  });

  it("leaves a high-entropy identifier alone", () => {
    const line = "server/x.ts:42: const u = req.user; // useIframeNavigationApiHandlerFactory7f3a9c1e";
    expect(scanForSecrets(line).matches.some((m) => m.type === "high-entropy-token")).toBe(true);
    expect(maskSecretValues(line).masked).toBe(0);
  });

  it("is idempotent — masked text scans clean and masks nothing on a second pass", () => {
    const once = maskSecretValues(`password: ${"Zq8mK2pL".repeat(4)} and ${AWS}`);
    expect(once.masked).toBe(2);
    expect(scanForSecrets(once.text).clean).toBe(true);
    expect(maskSecretValues(once.text).masked).toBe(0);
    // The endpoint pass too: a `"value": "corr****"` it rendered is not a value
    // to mask again (the tool masks before `find`, the taint seam re-runs the pass).
    const endpoint = maskSecretValues(JSON.stringify([{ name: "DB_PASSWORD", value: "correct horse battery staple 42" }], null, 2), { endpoint: true });
    expect(endpoint.text).toContain('"value": "corr****"');
    const again = maskSecretValues(endpoint.text, { endpoint: true });
    expect(again.masked).toBe(0);
    expect(again.text).toBe(endpoint.text);
  });

  it("leaves a response with no secrets byte-identical", () => {
    const text = "HTTP 200 OK\n{\n  \"functions\": [\"hello\", \"cron\"],\n  \"region\": \"us-east-1\"\n}";
    const r = maskSecretValues(text);
    expect(r.text).toBe(text);
    expect(r.masked).toBe(0);
    expect(r.kinds).toEqual([]);
  });
});

// Masking by looks blinded the model to every id an API returned and
// registered each one, so the next call carrying it was refused in every
// session until restart: Drive file ids, Twilio Account SIDs, page tokens.
// A value is withheld for what it IS (a credential format, a registered value)
// or what the response CALLS it (a credential-named field), never for looking
// random.
describe("an API response's identifiers reach the model; its credentials do not", () => {
  const DRIVE_ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
  const SID = "AC84d9ce8b2c77c8bc9f9423650da3d1d9";
  const PAGE = "Cg8KDWNyZWF0ZWRfdGltZRIKAhoJGgYIo4fK3wU";
  const OPAQUE = "Zq8vN2kR7tLw4Xp9Hs3Jd6Fb1Mc5Gy0Ae8Uo2Ki7";
  afterEach(() => unregisterRedactedSecretValue(OPAQUE));

  it("leaves ids and pagination cursors as they are, and registers none of them", () => {
    const body = JSON.stringify({
      files: [{ id: DRIVE_ID, name: "Q3 plan" }], account_sid: SID, nextPageToken: PAGE,
      "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/messages?$skiptoken=${PAGE}`,
      next: `/v1/list?pageToken=${PAGE}&NextToken=${PAGE}`,
    });
    const r = withholdSecretValues(body);
    expect(r.masked).toBe(0);
    expect(r.text).toBe(body);
    for (const id of [DRIVE_ID, SID, PAGE]) expect(knownSecretValues()).not.toContain(id);
  });

  it("masks and registers a value under a credential-named field, whatever it looks like", () => {
    const body = JSON.stringify({ access_token: OPAQUE, token_type: "Bearer", expires_in: 3599, scope: "drive.readonly" });
    const r = withholdSecretValues(body);
    expect(r.masked).toBe(1);
    expect(r.kinds).toEqual(["Credential Field"]);
    expect(r.text).not.toContain(OPAQUE);
    expect(r.text).toContain('"token_type":"Bearer"');
    expect(knownSecretValues()).toContain(OPAQUE);
  });

  it("masks credential formats and env-style assignments as before", () => {
    expect(maskSecretValues(`{"note":"key ${AWS}"}`).kinds).toContain("AWS Access Key");
    expect(maskSecretValues(`SECRET_KEY=${OPAQUE}`).masked).toBe(1);
    expect(maskSecretValues(`GITHUB_TOKEN=${OPAQUE}`).masked).toBe(1);
  });
});

describe("withholdSecretValues — masked values are registered and refused at every egress sink", () => {
  // Readable and low-entropy on purpose: it matches no credential shape and no
  // entropy run, so the ONLY way an egress can be refused is the registry.
  const STORED = "correct-horse-battery-staple-lineage-42";
  const sessionId = "secret-values-sink";
  afterEach(() => unregisterRedactedSecretValue(STORED));

  it("the value alone is clean before withholding — proving the block comes from registration", () => {
    expect(scanForSecrets(`x=${STORED}`).clean).toBe(true);
  });

  it("registers each masked value; the session stays untainted", () => {
    const body = JSON.stringify([{ name: "APP_SECRET", value: STORED }]);
    const r = withholdSecretValues(body, { endpoint: true });
    expect(r.text).not.toContain(STORED);
    expect(r.masked).toBe(1);
    expect(scanForSecrets(`x=${STORED}`).clean).toBe(false);
    expect(checkEgressTaint(sessionId).blocked).toBe(false);
  });

  it("a later http_request carrying the value — body, header, or URL — is refused by the outbound scan", () => {
    withholdSecretValues(JSON.stringify([{ name: "APP_SECRET", value: STORED }]), { endpoint: true });
    const post = makeCtx("http_request", { url: "https://api.supabase.com/v1/projects/abc/database/query", method: "POST", body: `{"query":"select '${STORED}'"}` }, sessionId);
    expect(egressGuardGate(post).kind).toBe("halt");
    expect(post.result?.metadata?.blocked_by).toBe("outbound-secret-scan");
    const header = makeCtx("http_request", { url: "https://example.com/x", method: "POST", body: "{}", headers: { "X-Auth": STORED } }, sessionId);
    expect(egressGuardGate(header).kind).toBe("halt");
    const url = makeCtx("http_request", { url: `https://example.com/collect?v=${STORED}`, method: "GET" }, sessionId);
    expect(egressGuardGate(url).kind).toBe("halt");
  });

  it("the base64-encoded value is refused too (decode-view reuse), and a clean POST still passes", () => {
    withholdSecretValues(JSON.stringify([{ name: "APP_SECRET", value: STORED }]), { endpoint: true });
    const blob = Buffer.from(STORED, "utf8").toString("base64");
    const encoded = makeCtx("clipboard_write", { text: `copy ${blob}` }, sessionId);
    expect(egressGuardGate(encoded).kind).toBe("halt");
    const clean = makeCtx("http_request", { url: "https://api.supabase.com/v1/projects/abc/database/query", method: "POST", body: '{"query":"create table t (id int)"}' }, sessionId);
    expect(egressGuardGate(clean).kind).toBe("continue");
  });
});

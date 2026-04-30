import { describe, expect, it } from "vitest";
import { redactEventForDisk, redactString } from "../src/workers/redactor.js";
import type { OpEvent } from "../src/workers/types.js";

const mkEvent = (overrides: Partial<OpEvent> = {}): OpEvent => ({
  opId: "op-test",
  type: "tool_result",
  ts: "2026-04-30T00:00:00.000Z",
  payload: {},
  ...overrides,
});

const TAIL = "abcdef1234567890ABCDEFGH";
const LONG = "a".repeat(60);
const OPENAI_FAKE = "sk" + "-" + TAIL;
const ANTHROPIC_FAKE = "sk" + "-ant-" + TAIL;
const XAI_FAKE = "xai" + "-" + TAIL;
const GHP_FAKE = "ghp" + "_" + "abcdefghij1234567890ABCDEFGHIJ12345";
const GHPAT_FAKE = "github" + "_pat_" + LONG;
const STRIPE_LIVE_FAKE = "sk" + "_live_" + TAIL;
const STRIPE_PUB_FAKE = "pk" + "_test_" + TAIL;
const JWT_FAKE = "eyJhbGciOi.eyJzdWIiOi.SflKxwRJSMeKKF";

describe("redactString — pattern scrubbing", () => {
  it("redacts Bearer auth header value", () => {
    const r = redactString("Authorization: Bearer abcdef1234567890XYZ");
    expect(r.changed).toBe(true);
    expect(r.redacted).toContain("Bearer <redacted>");
    expect(r.redacted).not.toContain("abcdef1234567890XYZ");
  });

  it("redacts Basic auth header value", () => {
    const r = redactString("Basic dXNlcjpwYXNzd29yZG1vcmU=AAAA");
    expect(r.changed).toBe(true);
    expect(r.redacted).toContain("Basic <redacted>");
  });

  it("redacts authorization key=value form", () => {
    const r = redactString('authorization="abcdefghijklmnop12345"');
    expect(r.changed).toBe(true);
    expect(r.redacted).not.toContain("abcdefghijklmnop12345");
  });

  it("redacts OpenAI sk-style key", () => {
    const r = redactString("call with " + OPENAI_FAKE);
    expect(r.changed).toBe(true);
    expect(r.redacted).toContain("sk-<redacted>");
    expect(r.redacted).not.toContain(TAIL);
  });

  it("redacts Anthropic sk-ant- key (matched by pattern)", () => {
    const r = redactString("KEY=" + ANTHROPIC_FAKE);
    expect(r.changed).toBe(true);
    expect(r.redacted).not.toContain(TAIL);
  });

  it("redacts xAI key", () => {
    const r = redactString("token " + XAI_FAKE);
    expect(r.changed).toBe(true);
    expect(r.redacted).toContain("xai-<redacted>");
  });

  it("redacts GitHub classic PAT", () => {
    const r = redactString("export GH_TOKEN=" + GHP_FAKE);
    expect(r.changed).toBe(true);
    expect(r.redacted).toContain("ghp_<redacted>");
  });

  it("redacts GitHub fine-grained PAT", () => {
    const r = redactString("token=" + GHPAT_FAKE);
    expect(r.changed).toBe(true);
    expect(r.redacted).toContain("github_pat_<redacted>");
  });

  it("redacts Stripe live secret key", () => {
    const r = redactString("STRIPE=" + STRIPE_LIVE_FAKE);
    expect(r.changed).toBe(true);
    expect(r.redacted).toContain("sk_live_<redacted>");
  });

  it("redacts Stripe test publishable key", () => {
    const r = redactString("STRIPE_PUB=" + STRIPE_PUB_FAKE);
    expect(r.changed).toBe(true);
    expect(r.redacted).toContain("pk_test_<redacted>");
  });

  it("redacts JWT-shaped tokens", () => {
    const r = redactString("auth=" + JWT_FAKE);
    expect(r.changed).toBe(true);
    expect(r.redacted).toContain("<redacted-jwt>");
    expect(r.redacted).not.toContain(JWT_FAKE);
  });

  it("does NOT change ordinary text", () => {
    const r = redactString("hello world, this is a normal log line");
    expect(r.changed).toBe(false);
    expect(r.redacted).toBe("hello world, this is a normal log line");
  });

  it("does NOT match short tokens that look like API keys", () => {
    const r = redactString("call sk-short");
    expect(r.changed).toBe(false);
  });

  it("redacts multiple secrets in one string", () => {
    const r = redactString("token=" + GHP_FAKE + " and key=" + OPENAI_FAKE);
    expect(r.changed).toBe(true);
    expect(r.redacted).toContain("ghp_<redacted>");
    expect(r.redacted).toContain("sk-<redacted>");
  });
});

describe("redactEventForDisk — sensitive flag short-circuit", () => {
  it("replaces payload entirely when sensitive: true", () => {
    const evt = mkEvent({
      sensitive: true,
      payload: { secret: "abc", visible: "also gone" },
    });
    const out = redactEventForDisk(evt);
    expect(out.redacted).toBe(true);
    expect(out.payload).toMatchObject({ redacted: true });
    expect(out.payload.secret).toBeUndefined();
    expect(out.payload.visible).toBeUndefined();
  });

  it("preserves originalKeys for forensics on sensitive replacement", () => {
    const evt = mkEvent({
      sensitive: true,
      payload: { password: "x", token: "y", note: "z" },
    });
    const out = redactEventForDisk(evt);
    const originalKeys = (out.payload as { originalKeys: string[] }).originalKeys;
    expect(originalKeys).toEqual(["password", "token", "note"]);
  });

  it("does not mutate the input event when sensitive", () => {
    const payload = { secret: "abc" };
    const evt = mkEvent({ sensitive: true, payload });
    redactEventForDisk(evt);
    expect(payload.secret).toBe("abc");
    expect(evt.payload).toBe(payload);
  });
});

describe("redactEventForDisk — field name redaction", () => {
  it("redacts a value whose key is 'password'", () => {
    const evt = mkEvent({ payload: { user: "alice", password: "hunter2-secret-xx" } });
    const out = redactEventForDisk(evt);
    expect(out.redacted).toBe(true);
    expect((out.payload as { password: string }).password).toBe("<redacted>");
    expect((out.payload as { user: string }).user).toBe("alice");
  });

  it("redacts case-insensitively (Token, TOKEN)", () => {
    const evt = mkEvent({ payload: { Token: "abc", TOKEN: "def" } });
    const out = redactEventForDisk(evt);
    expect((out.payload as { Token: string }).Token).toBe("<redacted>");
    expect((out.payload as { TOKEN: string }).TOKEN).toBe("<redacted>");
  });

  it("redacts api_key, api_token, access_token, refresh_token", () => {
    const evt = mkEvent({
      payload: {
        api_key: "k1",
        api_token: "k2",
        access_token: "k3",
        refresh_token: "k4",
      },
    });
    const out = redactEventForDisk(evt);
    const p = out.payload as Record<string, string>;
    expect(p.api_key).toBe("<redacted>");
    expect(p.api_token).toBe("<redacted>");
    expect(p.access_token).toBe("<redacted>");
    expect(p.refresh_token).toBe("<redacted>");
  });

  it("redacts autofill_value (browser secret per spec)", () => {
    const evt = mkEvent({ payload: { autofill_value: "supersecret123" } });
    const out = redactEventForDisk(evt);
    expect((out.payload as { autofill_value: string }).autofill_value).toBe("<redacted>");
  });

  it("redacts cookie / set-cookie / authorization", () => {
    const evt = mkEvent({
      payload: {
        cookie: "sessid=abc",
        "set-cookie": "auth=xyz",
        authorization: "Bearer xyz",
      },
    });
    const out = redactEventForDisk(evt);
    const p = out.payload as Record<string, string>;
    expect(p.cookie).toBe("<redacted>");
    expect(p["set-cookie"]).toBe("<redacted>");
    expect(p.authorization).toBe("<redacted>");
  });

  it("redacts a nested sensitive field name", () => {
    const evt = mkEvent({
      payload: { user: { name: "alice", password: "hunter2" } },
    });
    const out = redactEventForDisk(evt);
    const user = (out.payload as { user: { password: string } }).user;
    expect(user.password).toBe("<redacted>");
  });

  it("redacts non-string values when key is sensitive (numbers, objects)", () => {
    const evt = mkEvent({ payload: { token: 123456, secret: { foo: "bar" } } });
    const out = redactEventForDisk(evt);
    expect((out.payload as { token: unknown }).token).toBe("<redacted>");
    expect((out.payload as { secret: unknown }).secret).toBe("<redacted>");
  });
});

describe("redactEventForDisk — pattern scrubbing inside payload", () => {
  it("scrubs a key embedded in a free-form string field", () => {
    const evt = mkEvent({
      payload: { log_line: "Got back: " + OPENAI_FAKE + " from the API" },
    });
    const out = redactEventForDisk(evt);
    expect(out.redacted).toBe(true);
    const line = (out.payload as { log_line: string }).log_line;
    expect(line).toContain("sk-<redacted>");
    expect(line).not.toContain(TAIL);
  });

  it("scrubs deeply nested string", () => {
    const evt = mkEvent({
      payload: {
        a: { b: { c: [OPENAI_FAKE, "ok"] } },
      },
    });
    const out = redactEventForDisk(evt);
    expect(out.redacted).toBe(true);
    const arr = (out.payload as { a: { b: { c: string[] } } }).a.b.c;
    expect(arr[0]).toContain("sk-<redacted>");
    expect(arr[1]).toBe("ok");
  });

  it("returns input unchanged when nothing matches", () => {
    const evt = mkEvent({ payload: { msg: "completed in 4ms", ok: true } });
    const out = redactEventForDisk(evt);
    expect(out.redacted).toBeUndefined();
    expect(out).toBe(evt);
  });

  it("array of plain strings without secrets leaves array unchanged", () => {
    const evt = mkEvent({ payload: { lines: ["one", "two", "three"] } });
    const out = redactEventForDisk(evt);
    expect(out.redacted).toBeUndefined();
    expect(out).toBe(evt);
  });

  it("primitive values (number, boolean, null) pass through", () => {
    const evt = mkEvent({
      payload: { count: 5, ok: true, result: null, tag: "x" },
    });
    const out = redactEventForDisk(evt);
    expect(out).toBe(evt);
  });
});

describe("redactEventForDisk — sensitive flag wins over field walk", () => {
  it("sensitive: true short-circuits even if no payload field would match", () => {
    const evt = mkEvent({
      sensitive: true,
      payload: { plain: "no secrets here" },
    });
    const out = redactEventForDisk(evt);
    expect(out.payload).toMatchObject({ redacted: true });
  });
});

describe("redactEventForDisk — redacted flag invariants", () => {
  it("sets redacted: true on any field-name redaction", () => {
    const evt = mkEvent({ payload: { password: "x" } });
    expect(redactEventForDisk(evt).redacted).toBe(true);
  });

  it("sets redacted: true on any pattern match", () => {
    const evt = mkEvent({ payload: { log: OPENAI_FAKE } });
    expect(redactEventForDisk(evt).redacted).toBe(true);
  });

  it("does NOT set redacted on a clean event", () => {
    const evt = mkEvent({ payload: { count: 1 } });
    expect(redactEventForDisk(evt).redacted).toBeUndefined();
  });
});

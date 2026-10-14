// ADR 0005: a vault secret is bound to the destinations it may reach. The
// record carries them as approvedDestinations (read back from the field's old
// name), every key comes from normalizeDestination, and destinationDecision is
// the one ladder every emitter runs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const preBlessed = vi.hoisted(() => new Set<string>());
vi.mock("./ops/pre-bless.js", () => ({ getActivePreBlessedSecrets: () => preBlessed }));

import { SecretsStore, normalizeDestination } from "./secrets.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-secrets-destinations-")); preBlessed.clear(); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("normalizeDestination — the one producer of destination keys", () => {
  it("a URL becomes its origin, default port dropped, path and query gone", () => {
    expect(normalizeDestination("https://API.GitHub.com:443/repos?x=1")).toBe("https://api.github.com");
    expect(normalizeDestination("http://h:8080/a")).toBe("http://h:8080");
  });

  it("a mail endpoint keeps its scheme, lowercased host and explicit port", () => {
    expect(normalizeDestination("smtp://SMTP.Fastmail.com:465")).toBe("smtp://smtp.fastmail.com:465");
    expect(normalizeDestination("imap://imap.fastmail.com:993")).toBe("imap://imap.fastmail.com:993");
    expect(normalizeDestination("smtp://smtp.fastmail.com:465")).not.toBe(normalizeDestination("smtp://smtp.fastmail.com:587"));
  });

  it("anything else is no destination", () => {
    expect(normalizeDestination("not a url")).toBeUndefined();
    expect(normalizeDestination("")).toBeUndefined();
    expect(normalizeDestination("mailto:someone@example.com")).toBeUndefined();
  });
});

describe("destinationDecision — the ladder", () => {
  it("the secret's own recorded origin is allowed first", () => {
    const store = new SecretsStore(dir);
    store.set("LOGIN", "pw", { url: "https://www.twilio.com/login", createdBySession: "s1" });
    expect(store.destinationDecision("LOGIN", "https://www.twilio.com/console", { sessionId: "other" })).toBe("origin");
  });

  it("the session that captured it is allowed on the secret's own site, nowhere else; another session is asked", () => {
    const store = new SecretsStore(dir);
    store.set("KEY", "v", { origin: "https://app.example.com", createdBySession: "s1" });
    expect(store.destinationDecision("KEY", "https://api.example.com", { sessionId: "s1" })).toBe("session");
    expect(store.destinationDecision("KEY", "https://api.other.example", { sessionId: "s1" })).toBe("ask");
    expect(store.destinationDecision("KEY", "https://api.example.com", { sessionId: "s2" })).toBe("ask");
    expect(store.destinationDecision("KEY", "https://api.example.com")).toBe("ask");
  });

  it("a secret saved with no origin has no site to hold it to, so its own session may use it anywhere", () => {
    const store = new SecretsStore(dir);
    store.set("KEY", "v", { createdBySession: "s1" });
    expect(store.destinationDecision("KEY", "https://api.other.example", { sessionId: "s1" })).toBe("session");
    expect(store.destinationDecision("KEY", "https://api.other.example", { sessionId: "s2" })).toBe("ask");
  });

  it("an operation's pre-bless comes before a user approval, and a user approval before the ask", () => {
    const store = new SecretsStore(dir);
    store.set("KEY", "v");
    expect(store.destinationDecision("KEY", "https://api.example.com")).toBe("ask");
    store.approveDestination("KEY", "https://api.example.com/v1/x");
    expect(store.destinationDecision("KEY", "https://api.example.com")).toBe("approved");
    preBlessed.add("KEY");
    expect(store.destinationDecision("KEY", "https://api.example.com")).toBe("pre_bless");
    expect(store.destinationDecision("KEY", "https://elsewhere.example")).toBe("pre_bless");
  });

  it("a pre-bless is held to the secret's site when it has one", () => {
    const store = new SecretsStore(dir);
    store.set("KEY", "v", { origin: "https://app.example.com" });
    preBlessed.add("KEY");
    expect(store.destinationDecision("KEY", "https://api.example.com")).toBe("pre_bless");
    expect(store.destinationDecision("KEY", "https://elsewhere.example")).toBe("ask");
  });

  it("an unknown secret or an unparseable destination is asked, never allowed", () => {
    const store = new SecretsStore(dir);
    store.set("KEY", "v", { createdBySession: "s1" });
    expect(store.destinationDecision("NOPE", "https://api.example.com", { sessionId: "s1" })).toBe("ask");
    expect(store.destinationDecision("KEY", "garbage", { sessionId: "s1" })).toBe("ask");
  });

  it("mail hosts are keyed by scheme, host and port", () => {
    const store = new SecretsStore(dir);
    store.set("SMTP_PASS", "v");
    store.approveDestination("SMTP_PASS", "smtp://smtp.fastmail.com:465");
    expect(store.destinationDecision("SMTP_PASS", "smtp://smtp.fastmail.com:465")).toBe("approved");
    expect(store.destinationDecision("SMTP_PASS", "smtp://smtp.fastmail.com:587")).toBe("ask");
    expect(store.destinationDecision("SMTP_PASS", "imap://smtp.fastmail.com:465")).toBe("ask");
  });
});

describe("the record on disk", () => {
  it("is written as approvedDestinations and read back from the old approvedFills name", () => {
    const seed = new SecretsStore(dir);
    seed.set("KEY", "v");
    seed.approveDestination("KEY", "https://api.example.com");
    const file = join(dir, "secrets.enc");
    const written = readFileSync(file, "utf-8");
    expect(written).toContain("approvedDestinations");
    expect(written).not.toContain("approvedFills");

    writeFileSync(file, written.replace("approvedDestinations", "approvedFills"));
    const migrated = new SecretsStore(dir);
    expect(migrated.isDestinationApproved("KEY", "https://api.example.com")).toBe(true);
    expect(migrated.getMeta("KEY")?.approvedDestinations).toEqual([expect.objectContaining({ origin: "https://api.example.com" })]);
    migrated.approveDestination("KEY", "https://b.example");
    expect(readFileSync(file, "utf-8")).not.toContain("approvedFills");
  });

  it("a replaced value keeps its destinations on the same origin and loses them on a new one", () => {
    const store = new SecretsStore(dir);
    store.set("LOGIN", "pw1", { url: "https://www.twilio.com/login" });
    store.approveDestination("LOGIN", "https://login.twilio.com");
    store.set("LOGIN", "pw2", { notes: "rotated" });
    expect(store.isDestinationApproved("LOGIN", "https://login.twilio.com")).toBe(true);
    store.set("LOGIN", "pw3", { url: "https://www.example.com/login" });
    expect(store.isDestinationApproved("LOGIN", "https://login.twilio.com")).toBe(false);
    expect(store.getMeta("LOGIN")?.origin).toBe("https://www.example.com");
  });

  it("two accounts on one platform are two records that resolve independently", () => {
    const store = new SecretsStore(dir);
    store.set("GITHUB_TOKEN", "ghp-work", { service: "GitHub", account: "work@example.com" });
    store.set("GITHUB_TOKEN_PERSONAL", "ghp-home", { service: "GitHub", account: "me@example.com" });
    expect(store.list().filter((s) => s.service === "GitHub").map((s) => s.account).sort()).toEqual(["me@example.com", "work@example.com"]);
    expect(store.resolve("{{GITHUB_TOKEN}}/{{GITHUB_TOKEN_PERSONAL}}")).toBe("ghp-work/ghp-home");
    store.approveDestination("GITHUB_TOKEN", "https://api.github.com");
    expect(store.destinationDecision("GITHUB_TOKEN", "https://api.github.com")).toBe("approved");
    expect(store.destinationDecision("GITHUB_TOKEN_PERSONAL", "https://api.github.com")).toBe("ask");
  });
});

describe("the one-time carry-over flag", () => {
  it("a version-1 file sets destinationSeedPending; marking it done writes version 2 and clears it", () => {
    const store = new SecretsStore(dir);
    store.set("KEY", "v");
    const file = join(dir, "secrets.enc");
    const v1 = JSON.parse(readFileSync(file, "utf-8"));
    expect(v1.version).toBe(2);
    v1.version = 1;
    writeFileSync(file, JSON.stringify(v1));
    const reloaded = new SecretsStore(dir);
    expect(reloaded.destinationSeedPending).toBe(true);
    reloaded.markDestinationSeedDone();
    expect(reloaded.destinationSeedPending).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf-8")).version).toBe(2);
    expect(new SecretsStore(dir).destinationSeedPending).toBe(false);
  });
});

describe("site conditioning spans schemes", () => {
  it("a password captured on the web app this session may reach the same site's mail hosts without a card", () => {
    const store = new SecretsStore(dir);
    store.set("MAIL_PASS", "v", { origin: "https://app.fastmail.com", createdBySession: "s1" });
    expect(store.destinationDecision("MAIL_PASS", "smtp://smtp.fastmail.com:465", { sessionId: "s1" })).toBe("session");
    expect(store.destinationDecision("MAIL_PASS", "imap://imap.fastmail.com:993", { sessionId: "s1" })).toBe("session");
    expect(store.destinationDecision("MAIL_PASS", "smtp://smtp.other.example:465", { sessionId: "s1" })).toBe("ask");
  });
});

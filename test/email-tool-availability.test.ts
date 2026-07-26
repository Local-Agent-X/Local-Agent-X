/**
 * The email tools' availability predicates.
 *
 * The send/read split is the part that is easy to get backwards. After C7a the
 * IMAP credentials are OPTIONAL, so a send-only user has a WORKING email_send
 * and a genuinely unusable email_read/email_search. Gating email_send on IMAP
 * would hide a tool that works — the exact invisible failure this mechanism
 * exists to prevent — so each predicate consults only its own transport.
 *
 * email_setup is deliberately ungated: it is the tool that gets you configured.
 * email_draft is pure string formatting and needs no configuration either.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emailSend } from "../src/tools/email-send-tool.js";
import { emailRead, emailSearch } from "../src/tools/email-read-tools.js";
import { emailDraft, emailSetup } from "../src/tools/email-compose-tools.js";
import { isToolAvailable } from "../src/tools/tool-search.js";

const EMAIL_ENV = [
  "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_PORT",
  "IMAP_HOST", "IMAP_USER", "IMAP_PASS", "IMAP_PORT",
];

let saved: Record<string, string | undefined>;
let dataDir: string;

beforeEach(() => {
  saved = Object.fromEntries([...EMAIL_ENV, "LAX_DATA_DIR"].map((k) => [k, process.env[k]]));
  for (const k of EMAIL_ENV) delete process.env[k];
  // Empty data dir so the real ~/.lax/email.json on the dev box can't leak in.
  dataDir = mkdtempSync(join(tmpdir(), "email-avail-"));
  process.env.LAX_DATA_DIR = dataDir;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

function configureSmtp() {
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_USER = "me@example.com";
  process.env.SMTP_PASS = "secret";
  process.env.SMTP_FROM = "me@example.com";
}
function configureImap() {
  process.env.IMAP_HOST = "imap.example.com";
  process.env.IMAP_USER = "me@example.com";
  process.env.IMAP_PASS = "secret";
}

describe("email tool availability", () => {
  it("hides send and read tools when email is not configured at all", () => {
    expect(isToolAvailable(emailSend)).toBe(false);
    expect(isToolAvailable(emailRead)).toBe(false);
    expect(isToolAvailable(emailSearch)).toBe(false);
  });

  it("send-only setup keeps email_send and hides only the IMAP readers", () => {
    configureSmtp();
    expect(isToolAvailable(emailSend)).toBe(true);
    expect(isToolAvailable(emailRead)).toBe(false);
    expect(isToolAvailable(emailSearch)).toBe(false);
  });

  it("read-only setup keeps the readers and hides only email_send", () => {
    configureImap();
    expect(isToolAvailable(emailSend)).toBe(false);
    expect(isToolAvailable(emailRead)).toBe(true);
    expect(isToolAvailable(emailSearch)).toBe(true);
  });

  it("fully configured keeps all three", () => {
    configureSmtp();
    configureImap();
    expect(isToolAvailable(emailSend)).toBe(true);
    expect(isToolAvailable(emailRead)).toBe(true);
    expect(isToolAvailable(emailSearch)).toBe(true);
  });

  it("a partial SMTP setup is not treated as configured", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "me@example.com";
    // no SMTP_PASS / SMTP_FROM
    expect(isToolAvailable(emailSend)).toBe(false);
  });

  it("never gates email_setup or email_draft — they work with nothing configured", () => {
    expect(emailSetup.available).toBeUndefined();
    expect(emailDraft.available).toBeUndefined();
    expect(isToolAvailable(emailSetup)).toBe(true);
    expect(isToolAvailable(emailDraft)).toBe(true);
  });
});

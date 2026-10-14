// email_draft's From line must come from the same config email_send uses
// (~/.lax/email.json written by email_setup / Settings), not only from the
// SMTP_FROM environment variable — a configured account otherwise drafted
// as "(not configured)".
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emailDraft } from "./email-compose-tools.js";
import { writeEmailJson } from "./email-config.js";

let dir: string;
const prevDataDir = process.env.LAX_DATA_DIR;
const prevFrom = process.env.SMTP_FROM;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-email-draft-"));
  process.env.LAX_DATA_DIR = dir;
  delete process.env.SMTP_FROM;
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevDataDir;
  if (prevFrom === undefined) delete process.env.SMTP_FROM;
  else process.env.SMTP_FROM = prevFrom;
  rmSync(dir, { recursive: true, force: true });
});

describe("email_draft From line", () => {
  it("reads the email_setup-stored From address", async () => {
    writeEmailJson({ SMTP_HOST: "smtp.fastmail.com", SMTP_USER: "me@fastmail.com", SMTP_FROM: "Me <me@fastmail.com>" });
    const res = await emailDraft.execute({ to: "you@example.com", subject: "Hi", body: "Hello" });
    expect(res.content).toContain("From: Me <me@fastmail.com>");
  });

  it("says the account is not configured when neither config nor env has a From", async () => {
    const res = await emailDraft.execute({ to: "you@example.com", subject: "Hi", body: "Hello" });
    expect(res.content).toMatch(/^From: \(not configured/);
  });
});

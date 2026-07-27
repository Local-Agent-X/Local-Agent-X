/**
 * email_send: reply threading, BCC and the HTML/plain-text alternative.
 *
 * The transport is the only thing stubbed — `createTransport` records the mail
 * options nodemailer would compose. Everything else (the idempotency guard,
 * the config loader, the subject rules) is the real code, because those are
 * what these tests are about.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const smtp = vi.hoisted(() => ({
  sent: [] as Array<Record<string, unknown>>,
  sendError: undefined as Error | undefined,
}));
vi.mock("nodemailer", () => ({
  createTransport: () => ({
    sendMail: async (opts: Record<string, unknown>) => {
      if (smtp.sendError) throw smtp.sendError;
      smtp.sent.push(opts);
      return { messageId: `<generated-${smtp.sent.length}@example.com>` };
    },
  }),
}));

import { emailSend, normalizeMessageId, buildReferences } from "./email-send-tool.js";
import { _clearIdempotencyStoreForTests } from "./idempotency.js";

const ENV_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = "bob@example.com";
  process.env.SMTP_PASS = "app-password";
  process.env.SMTP_FROM = "bob@example.com";
  smtp.sent.length = 0;
  smtp.sendError = undefined;
  _clearIdempotencyStoreForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  _clearIdempotencyStoreForTests();
});

const PARENT = "<parent-abc@mail.example.com>";

async function send(args: Record<string, unknown>) {
  return emailSend.execute!({ to: "alice@example.com", subject: "Notes", body: "Hi", ...args });
}

/** The mail options the transport was handed on the Nth send. */
function lastMail(): Record<string, unknown> {
  expect(smtp.sent.length, "no mail reached the transport").toBeGreaterThan(0);
  return smtp.sent[smtp.sent.length - 1];
}

describe("reply threading", () => {
  it("sets In-Reply-To to the parent's Message-ID", async () => {
    await send({ in_reply_to: PARENT });
    expect(lastMail().inReplyTo).toBe(PARENT);
  });

  it("builds References as the parent's chain PLUS the parent's Message-ID, in order", async () => {
    await send({
      in_reply_to: PARENT,
      references: "<root-1@mail.example.com> <mid-2@mail.example.com>",
    });
    expect(lastMail().references).toEqual([
      "<root-1@mail.example.com>",
      "<mid-2@mail.example.com>",
      PARENT,
    ]);
  });

  it("still sets a well-formed References when only the parent's Message-ID is known", async () => {
    await send({ in_reply_to: PARENT });
    expect(lastMail().references).toEqual([PARENT]);
  });

  it("accepts a bare (bracketless) Message-ID and normalises it", async () => {
    await send({ in_reply_to: "parent-abc@mail.example.com" });
    expect(lastMail().inReplyTo).toBe(PARENT);
  });

  it("refuses a malformed Message-ID instead of sending an un-threaded reply", async () => {
    const r = await send({ in_reply_to: "not a message id" });
    expect(r.isError).toBe(true);
    expect(smtp.sent, "a send happened despite the rejected id").toHaveLength(0);
  });

  it("refuses a Message-ID carrying a header injection", async () => {
    const r = await send({ in_reply_to: "x@y.com>\r\nBcc: mallory@evil.com" });
    expect(r.isError).toBe(true);
    expect(smtp.sent).toHaveLength(0);
  });

  it("prefixes a reply's subject with Re:", async () => {
    await send({ subject: "Notes", in_reply_to: PARENT });
    expect(lastMail().subject).toBe("Re: Notes");
  });

  it("does NOT double-prefix a subject that is already a reply", async () => {
    await send({ subject: "Re: Notes", in_reply_to: PARENT });
    expect(lastMail().subject).toBe("Re: Notes");
    smtp.sent.length = 0;
    await send({ subject: "RE[2]: Notes", in_reply_to: PARENT, body: "other" });
    expect(lastMail().subject).toBe("RE[2]: Notes");
  });

  it("leaves the subject alone when the message is not a reply", async () => {
    await send({ subject: "Notes" });
    expect(lastMail().subject).toBe("Notes");
    expect(lastMail().inReplyTo).toBeUndefined();
    expect(lastMail().references).toBeUndefined();
  });
});

describe("BCC", () => {
  it("reaches the transport as bcc and not as a visible recipient header", async () => {
    await send({ cc: "carol@example.com", bcc: "dan@example.com" });
    const mail = lastMail();
    expect(mail.bcc).toBe("dan@example.com");
    expect(mail.to).toBe("alice@example.com");
    expect(mail.cc).toBe("carol@example.com");
    // Nothing else may leak the address: not the headers, not the body.
    const visible = JSON.stringify({ to: mail.to, cc: mail.cc, subject: mail.subject, text: mail.text, html: mail.html, headers: mail.headers });
    expect(visible).not.toContain("dan@example.com");
  });

  it("is omitted entirely when not supplied", async () => {
    await send({});
    expect(lastMail().bcc).toBeUndefined();
  });
});

describe("HTML body", () => {
  it("sends html alongside the caller's plain text", async () => {
    await send({ body: "Hi Alice", html: "<p>Hi <b>Alice</b></p>" });
    expect(lastMail().html).toBe("<p>Hi <b>Alice</b></p>");
    expect(lastMail().text).toBe("Hi Alice");
  });

  it("derives a plain-text alternative when only html is supplied", async () => {
    const r = await emailSend.execute!({
      to: "alice@example.com",
      subject: "Notes",
      html: "<p>Hi <b>Alice</b></p><p>See <a href=\"https://x.test/p\">the plan</a>.</p>",
    });
    expect(r.isError).toBeFalsy();
    const mail = lastMail();
    expect(mail.html).toContain("<b>Alice</b>");
    const text = String(mail.text);
    expect(text, "HTML-only send left recipients with no text/plain part").toBeTruthy();
    expect(text).not.toContain("<p>");
    expect(text).toContain("Hi Alice");
    expect(text).toContain("https://x.test/p");
  });

  it("refuses a send with neither body nor html", async () => {
    const r = await emailSend.execute!({ to: "alice@example.com", subject: "Notes" });
    expect(r.isError).toBe(true);
    expect(smtp.sent).toHaveLength(0);
  });
});

describe("the idempotency guard covers every new field", () => {
  it("still refuses an identical re-send", async () => {
    await send({});
    const r = await send({});
    expect(r.metadata?.skipped).toBe("duplicate");
    expect(smtp.sent, "the duplicate reached the transport").toHaveLength(1);
  });

  it("changing ONLY bcc is a different message and is sent", async () => {
    await send({ bcc: "dan@example.com" });
    const r = await send({ bcc: "erin@example.com" });
    expect(r.metadata?.skipped, "a different BCC list was swallowed as a duplicate").toBeUndefined();
    expect(smtp.sent).toHaveLength(2);
  });

  it("adding a bcc to an otherwise identical message is sent", async () => {
    await send({});
    const r = await send({ bcc: "dan@example.com" });
    expect(r.metadata?.skipped).toBeUndefined();
    expect(smtp.sent).toHaveLength(2);
  });

  it("changing ONLY the html body is a different message and is sent", async () => {
    await send({ html: "<p>v1</p>" });
    const r = await send({ html: "<p>v2</p>" });
    expect(r.metadata?.skipped, "a rewritten HTML body was swallowed as a duplicate").toBeUndefined();
    expect(smtp.sent).toHaveLength(2);
  });

  it("changing ONLY in_reply_to is a different message and is sent", async () => {
    await send({ in_reply_to: PARENT });
    const r = await send({ in_reply_to: "<other-xyz@mail.example.com>" });
    expect(r.metadata?.skipped, "a reply to a different thread was swallowed as a duplicate").toBeUndefined();
    expect(smtp.sent).toHaveLength(2);
  });

  it("changing ONLY the references chain is a different message and is sent", async () => {
    await send({ in_reply_to: PARENT, references: "<root-1@mail.example.com>" });
    const r = await send({ in_reply_to: PARENT, references: "<root-2@mail.example.com>" });
    expect(r.metadata?.skipped).toBeUndefined();
    expect(smtp.sent).toHaveLength(2);
  });

  it("a reply is distinct from the same text sent as a new thread", async () => {
    await send({});
    const r = await send({ in_reply_to: PARENT });
    expect(r.metadata?.skipped).toBeUndefined();
    expect(smtp.sent).toHaveLength(2);
  });

  it("a failed send does not block the retry", async () => {
    smtp.sendError = new Error("connection reset");
    const first = await send({});
    expect(first.isError).toBe(true);
    smtp.sendError = undefined;
    const second = await send({});
    expect(second.metadata?.skipped).toBeUndefined();
    expect(smtp.sent).toHaveLength(1);
  });
});

describe("Message-ID normalisation", () => {
  it.each([
    ["<a@b.com>", "<a@b.com>"],
    ["a@b.com", "<a@b.com>"],
    ["  <a@b.com>  ", "<a@b.com>"],
  ])("normalises %s", (input, expected) => {
    expect(normalizeMessageId(input)).toBe(expected);
  });

  it.each(["", "   ", "no-at-sign", "a b@c.com", "<a@b.com", "a@b.com>\nBcc: x@y.com"])(
    "rejects %j",
    (input) => {
      expect(normalizeMessageId(input)).toBeNull();
    },
  );
});

describe("buildReferences", () => {
  it("drops unparseable ids from the supplied chain rather than emitting a malformed header", () => {
    expect(buildReferences("<a@b.com> garbage <c@d.com>", "<p@q.com>")).toEqual([
      "<a@b.com>",
      "<c@d.com>",
      "<p@q.com>",
    ]);
  });

  it("does not repeat the parent when it is already in the chain", () => {
    expect(buildReferences("<a@b.com> <p@q.com>", "<p@q.com>")).toEqual(["<a@b.com>", "<p@q.com>"]);
  });

  it("caps a runaway chain while keeping the thread root and the recent ancestors", () => {
    const chain = Array.from({ length: 40 }, (_, i) => `<m${i}@b.com>`);
    const out = buildReferences(chain.join(" "), "<p@q.com>");
    expect(out).toHaveLength(20);
    expect(out[0]).toBe("<m0@b.com>");
    expect(out[out.length - 1]).toBe("<p@q.com>");
  });
});

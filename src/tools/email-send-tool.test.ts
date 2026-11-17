/**
 * email_send: reply threading, BCC and the HTML/plain-text alternative.
 *
 * The transport is the only thing stubbed — `createTransport` records the mail
 * options nodemailer would compose. Everything else (the sent log,
 * the config loader, the subject rules) is the real code, because those are
 * what these tests are about.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

import { emailSend, normalizeMessageId, buildReferences, composeEmail, emailFingerprint } from "./email-send-tool.js";
import { loadSent } from "./email-sent-log.js";

const ENV_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir = "";

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = "bob@example.com";
  process.env.SMTP_PASS = "app-password";
  process.env.SMTP_FROM = "bob@example.com";
  smtp.sent.length = 0;
  smtp.sendError = undefined;
  saved.LAX_DATA_DIR = process.env.LAX_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "lax-email-send-"));
  process.env.LAX_DATA_DIR = dataDir;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  if (saved.LAX_DATA_DIR === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = saved.LAX_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
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

  it("prefixes a reply whose subject merely CONTAINS 're:' mid-string", async () => {
    // The prefix test is anchored at the start. An unanchored one would see the
    // "re:" in "Notes re: budget" and silently drop the reply marker.
    await send({ subject: "Notes re: budget", in_reply_to: PARENT });
    expect(lastMail().subject).toBe("Re: Notes re: budget");
  });

  it("leaves the subject alone when the message is not a reply", async () => {
    await send({ subject: "Notes" });
    expect(lastMail().subject).toBe("Notes");
    expect(lastMail().inReplyTo).toBeUndefined();
    expect(lastMail().references).toBeUndefined();
  });

  it("refuses `references` supplied without `in_reply_to` rather than discarding it", async () => {
    const r = await send({ references: "<root-1@mail.example.com>" });
    expect(r.isError).toBe(true);
    expect(smtp.sent, "a send happened despite the unusable references argument").toHaveLength(0);
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

  it("treats a whitespace-only body as NO plain text and derives one from the html", async () => {
    // Truthiness vs trim: "   " is truthy, so a naive `body || htmlToText(html)`
    // ships a blank text/plain part to every plain-text client.
    await send({ body: "   ", html: "<p>Real content</p>" });
    expect(String(lastMail().text).trim()).toBe("Real content");
  });

  it("omits html entirely when none was supplied", async () => {
    await send({});
    expect("html" in lastMail(), "an empty html part was emitted").toBe(false);
  });

  it("refuses a send with neither body nor html", async () => {
    const r = await emailSend.execute!({ to: "alice@example.com", subject: "Notes" });
    expect(r.isError).toBe(true);
    expect(smtp.sent).toHaveLength(0);
  });
});

describe("the composed fingerprint: identical only when the recipient gets the identical email", () => {
  const fp = (args: Record<string, unknown>) => {
    const c = composeEmail({ to: "alice@example.com", subject: "Notes", body: "Hi", ...args });
    if ("error" in c) throw new Error(c.error);
    return emailFingerprint(c);
  };

  it.each([
    ["only bcc", { bcc: "dan@example.com" }, { bcc: "erin@example.com" }],
    ["an added bcc", {}, { bcc: "dan@example.com" }],
    ["only the html body", { html: "<p>v1</p>" }, { html: "<p>v2</p>" }],
    ["only in_reply_to", { in_reply_to: PARENT }, { in_reply_to: "<other-xyz@mail.example.com>" }],
    ["only the references chain", { in_reply_to: PARENT, references: "<root-1@mail.example.com>" }, { in_reply_to: PARENT, references: "<root-2@mail.example.com>" }],
    ["a reply vs the same text as a new thread", {}, { in_reply_to: PARENT }],
    ["only cc", { cc: "carol@example.com" }, { cc: "dave@example.com" }],
    ["only the attachment list", { attachments: "[\"a.txt\"]" }, { attachments: "[\"b.txt\"]" }],
    // Every field is one fingerprintOf part, so to="a",cc="b" never collides with to="ab",cc="".
    ["characters moved from cc into to", { to: "a@x.com", cc: "b@x.com" }, { to: "a@x.comb@x.com", cc: "" }],
  ])("changing %s is a different email", (_label, a, b) => {
    expect(fp(a)).not.toBe(fp(b));
  });

  it("a subject differing only by the Re: prefix this tool adds is the same email", () => {
    expect(fp({ subject: "Notes", in_reply_to: PARENT })).toBe(fp({ subject: "Re: Notes", in_reply_to: PARENT }));
  });

  it("references differing only in tokens buildReferences discards are the same email", () => {
    expect(fp({ in_reply_to: PARENT, references: "<r@x.com>" })).toBe(fp({ in_reply_to: PARENT, references: "<r@x.com> junk" }));
  });
});

describe("what a send leaves behind", () => {
  it("is logged with who and what, and the result names both", async () => {
    const r = await send({ cc: "carol@example.com", bcc: "Dan <DAN@example.com>", body: "Hi Alice, the notes." });
    expect(r.content).toContain("Email sent to alice@example.com, carol@example.com: \"Notes\"");
    const [entry] = loadSent();
    expect(entry).toMatchObject({ recipients: ["alice@example.com", "carol@example.com", "dan@example.com"], subject: "Notes", excerpt: "Hi Alice, the notes." });
  });

  it("a failed send is not logged", async () => {
    smtp.sendError = new Error("connection reset");
    expect((await send({})).isError).toBe(true);
    expect(loadSent()).toEqual([]);
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

  it.each(["", "   ", "no-at-sign", "a b@c.com", "<a@b.com", "a@b.com>\nBcc: x@y.com",
    "@", "a@", "@b.com", "a@b.com,c@d.com", "a@b@c.com"])(
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

  it("does not repeat an id the supplied chain lists twice", () => {
    expect(buildReferences("<a@b.com> <a@b.com> <c@d.com>", "<p@q.com>")).toEqual([
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

describe("judged at send, attachments included", () => {
  const SID = "email-send-judge";
  const READ = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY and the rest of the private config file";

  it("an attachment carrying bytes the session read from a credential file is refused, and nothing is sent", async () => {
    const { recordSensitiveRead, clearSessionTaint } = await import("../data-lineage/index.js");
    const { runInEgressScope } = await import("../net/egress-scope.js");
    const dir = mkdtempSync(join(tmpdir(), "lax-email-judge-"));
    try {
      recordSensitiveRead(SID, "sensitive_file", "/home/u/.aws/credentials", READ);
      const file = join(dir, "notes.txt");
      writeFileSync(file, `meeting notes\n${READ}\nend`);
      const r = await runInEgressScope(SID, () => send({ attachments: JSON.stringify([file]) }));
      expect(r.status).toBe("blocked");
      expect(r.metadata).toMatchObject({ layer: "data-lineage", clearable: "declassify" });
      expect(r.content).not.toContain("wJalrXUtnFEMI");
      expect(smtp.sent).toHaveLength(0);

      writeFileSync(file, "meeting notes, nothing sensitive");
      const ok = await runInEgressScope(SID, () => send({ attachments: JSON.stringify([file]) }));
      expect(ok.isError).toBeFalsy();
      expect(smtp.sent).toHaveLength(1);
    } finally {
      clearSessionTaint(SID);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// egressGuardGate / canaryEgressGate payload suites, split from
// capability-class-gates.test.ts (400-LOC gate): outbound secret scan +
// sensitive attachment across every egress sink, attachment TOCTOU (C3-9),
// the registered known-secret-value registry, and the canary tripwire audit.
// Same master defect under test: synonyms (email_send, clipboard_write,
// process_start, browser, ari_*) must be gated identically to http_request.

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CAN_CREATE_FILE_SYMLINK } from "../symlink-capabilities.test-helper.js";
import { egressGuardGate, canaryEgressGate } from "./enforce-policy.js";
import { egressPayload } from "./egress-gates.js";
import { checkAttachmentPaths } from "../tools/http-egress-guard.js";
import { scanForSecrets, registerRedactedSecretValue, unregisterRedactedSecretValue } from "../security/secrets/index.js";
import { generateCanaries, registerSessionCanaries, clearSessionCanaries, _setCanaryAuditTrail } from "../threat/canaries.js";
import { CryptoAuditTrail } from "../threat/audit-trail.js";
import { getLaxDir } from "../lax-data-dir.js";
import { makeCtx } from "./capability-class-gates.test-helper.js";

describe("egressGuardGate — outbound secret scan + sensitive attachment (every egress sink)", () => {
  const sessionId = "cap-class-egress-guard";
  // A clearly secret-shaped value (AWS Access Key: AKIA + 16 upper/digit chars).
  const SECRET = "AKIA0000000000000000";

  it("blocks a hardcoded secret in clipboard_write content", () => {
    const ctx = makeCtx("clipboard_write", { text: `token=${SECRET}` }, sessionId);
    const outcome = egressGuardGate(ctx);
    expect(outcome.kind).toBe("halt");
    expect(ctx.result?.metadata?.layer).toBe("egress-guard");
  });

  it("blocks a hardcoded secret in process_start command/args", () => {
    const ctx = makeCtx("process_start", { command: "deploy", args: [`--key=${SECRET}`] }, sessionId);
    expect(egressGuardGate(ctx).kind).toBe("halt");
  });

  it("routes a hardcoded secret in an email_send body to interactive approval (confirmable downgrade)", () => {
    // Since 7c23e4a5 email_send is recipient-aware (checkOutboundEmail): a
    // secret-bearing payload to an UNKNOWN recipient is a CONFIRMABLE block —
    // the gate CONTINUEs with ctx.policyApprovalReason set, and the
    // require-approval phase prompts attended runs / hard-blocks unattended
    // ones. The scan must still FIRE: a continue with no approval reason would
    // mean the secret sailed through unscanned.
    const ctx = makeCtx("email_send", { to: "a@b.com", subject: "x", body: `here: ${SECRET}` }, sessionId);
    expect(egressGuardGate(ctx).kind).toBe("continue");
    expect(ctx.policyApprovalReason).toMatch(/a@b\.com/);
    expect(ctx.policyApprovalReason).toMatch(/secret-shaped content/);
  });

  it("routes a hardcoded secret in an email_send HTML body to approval (E5, confirmable downgrade)", () => {
    // `html` is a payload-bearing parameter: a secret rendered only in the HTML
    // part still leaves the box, so it must reach the scan (E5) — surfacing as
    // the recipient-aware confirmable downgrade, same as a plain-body secret.
    const ctx = makeCtx("email_send", { to: "a@b.com", subject: "x", body: "see below", html: `<p>key: ${SECRET}</p>` }, sessionId);
    expect(egressGuardGate(ctx).kind).toBe("continue");
    expect(ctx.policyApprovalReason).toMatch(/a@b\.com/);
    expect(ctx.policyApprovalReason).toMatch(/secret-shaped content/);
  });

  it("extracts EVERY payload-bearing email_send field, including html and bcc (E5)", () => {
    // The extractor feeds all three egress layers (secret scan, taint floor,
    // canary tripwire). A field missing here is invisible to all of them — a
    // recipient smuggled into `bcc` would never be scanned or tainted.
    const { text } = egressPayload("email_send", {
      to: "a@b.com", cc: "c@b.com", bcc: "mallory@evil.com",
      subject: "quarterly", body: "plain part", html: "<p>rich part</p>",
    });
    for (const fragment of ["a@b.com", "c@b.com", "mallory@evil.com", "quarterly", "plain part", "<p>rich part</p>"]) {
      expect(text, `egressPayload dropped ${fragment}`).toContain(fragment);
    }
  });

  it("lets a clean payload through, and passes {{SECRET_NAME}} placeholders", () => {
    expect(egressGuardGate(makeCtx("clipboard_write", { text: "hello world" }, sessionId)).kind).toBe("continue");
    // A clean continue must be a REAL pass, not the confirmable downgrade:
    // no approval reason may be stashed for a placeholder-only payload.
    const clean = makeCtx("email_send", { to: "a@b.com", subject: "x", body: "use {{API_KEY}}" }, sessionId);
    expect(egressGuardGate(clean).kind).toBe("continue");
    expect(clean.policyApprovalReason).toBeUndefined();
  });

  it("rejects email_send attaching a sensitive file path", () => {
    const ctx = makeCtx("email_send", {
      to: "a@b.com", subject: "x", body: "see attached",
      attachments: JSON.stringify(["~/.ssh/id_rsa", "/tmp/notes.txt"]),
    }, sessionId);
    const outcome = egressGuardGate(ctx);
    expect(outcome.kind).toBe("halt");
    expect(ctx.result?.metadata?.blocked_by).toBe("sensitive-attachment");
  });

  it("allows email_send with a benign attachment", () => {
    const ctx = makeCtx("email_send", {
      to: "a@b.com", subject: "x", body: "see attached",
      attachments: JSON.stringify(["/tmp/report.pdf"]),
    }, sessionId);
    expect(egressGuardGate(ctx).kind).toBe("continue");
  });

  it("sends user-uploaded photos + generated media, but STILL blocks a data-dir secret (egress false-positive regression)", () => {
    // The bug: ~/.lax/uploads (photos attached from a paired device) and
    // ~/.lax/workspace (agent-generated media) were flagged "sensitive
    // attachments", blocking generate_video-from-a-photo and WhatsApp/Telegram
    // image sends. Driving the WHOLE gate catches a regression at ANY layer —
    // egressPayload routing, checkAttachmentPaths, isSensitiveAttachmentPath, or
    // the ATTACHMENT_SENSITIVE_DIR_NAMES set — not just the leaf predicate.
    const uploadPhoto = join(getLaxDir(), "uploads", "att-regression.jpeg");
    const generatedImg = join(getLaxDir(), "workspace", "images", "gen-regression.png");
    const secretFile = join(getLaxDir(), "config.json"); // holds the authToken

    // generate_video routes reference_images through the sensitive-attachment check.
    expect(egressGuardGate(makeCtx("generate_video", { prompt: "make it", reference_images: [uploadPhoto] }, sessionId)).kind).toBe("continue");
    expect(egressGuardGate(makeCtx("generate_video", { prompt: "x", reference_images: [generatedImg] }, sessionId)).kind).toBe("continue");
    // The uploads/workspace carve-out must NOT open a hole: a real data-dir
    // secret attached to an off-box sink is still refused.
    const secretCtx = makeCtx("email_send", { to: "a@b.com", subject: "x", body: "see attached", attachments: JSON.stringify([secretFile]) }, sessionId);
    expect(egressGuardGate(secretCtx).kind).toBe("halt");
    expect(secretCtx.result?.metadata?.blocked_by).toBe("sensitive-attachment");
  });

  it("is a no-op for non-egress tools", () => {
    expect(egressGuardGate(makeCtx("read", { path: "/tmp/x" }, sessionId)).kind).toBe("continue");
  });
});

describe("egressGuardGate — attachment TOCTOU (C3-9: symlink + byte scan)", () => {
  const sessionId = "cap-class-attach-toctou";
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lax-attach-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function emailCtx(paths: string[]) {
    return makeCtx("email_send", {
      to: "a@b.com", subject: "x", body: "see attached",
      attachments: JSON.stringify(paths),
    }, sessionId);
  }

  it.skipIf(!CAN_CREATE_FILE_SYMLINK)("blocks a symlink whose REALPATH is a sensitive target (innocent .txt → .ssh/id_rsa)", () => {
    // Lay down a private-key-shaped file under a .ssh-named dir, then point an
    // innocent-looking /tmp/notes.txt at it. The lexical predicate would PASS on
    // "notes.txt"; the realpath-based check must catch the .ssh/id_rsa target.
    const sshDir = join(tmp, ".ssh");
    mkdirSync(sshDir, { recursive: true });
    const key = join(sshDir, "id_rsa");
    writeFileSync(key, "-----BEGIN OPENSSH PRIVATE KEY-----\nnotreal\n");
    const link = join(tmp, "notes.txt");
    symlinkSync(key, link);

    const ctx = emailCtx([link]);
    const outcome = egressGuardGate(ctx);
    expect(outcome.kind).toBe("halt");
    expect(ctx.result?.metadata?.blocked_by).toBe("sensitive-attachment");
  });

  it("blocks an attachment whose BYTES contain a secret even though its path is innocent", () => {
    // Path is a plain .txt with no sensitive segment; contents carry an
    // Anthropic-style key, so the byte scan must block it.
    const file = join(tmp, "harmless-report.txt");
    writeFileSync(file, "summary\napi=sk-ant-api03-" + "A".repeat(80) + "\n");
    const ctx = emailCtx([file]);
    const outcome = egressGuardGate(ctx);
    expect(outcome.kind).toBe("halt");
    expect(ctx.result?.metadata?.blocked_by).toBe("sensitive-attachment");
  });

  it("allows a genuinely innocent attachment (plain .txt, no secret, not a symlink)", () => {
    const file = join(tmp, "report.txt");
    writeFileSync(file, "Quarterly numbers look good. No credentials here.\n");
    expect(egressGuardGate(emailCtx([file])).kind).toBe("continue");
  });

  it("blocks ~/.git-credentials and a gcloud ADC path as attachments", () => {
    // Lexical predicate coverage (C3-10): these need no realpath to trip.
    const gitCreds = join(tmp, ".git-credentials");
    writeFileSync(gitCreds, "https://user:tok@github.com\n");
    expect(egressGuardGate(emailCtx([gitCreds])).kind).toBe("halt");

    const adcDir = join(tmp, ".config", "gcloud");
    mkdirSync(adcDir, { recursive: true });
    const adc = join(adcDir, "application_default_credentials.json");
    writeFileSync(adc, "{\"refresh_token\":\"x\"}\n");
    expect(egressGuardGate(emailCtx([adc])).kind).toBe("halt");
  });
});

describe("egressGuardGate — known-secret-value (the user's ACTUAL stored secret)", () => {
  const sessionId = "cap-class-known-value";
  // A long, isSecretShaped but DELIBERATELY low-entropy readable value — it
  // matches no credential pattern AND no entropy run, so on its own the scan is
  // clean. The ONLY reason the guard can block it is that it's a REGISTERED
  // known secret value (eager-populated from the SecretsStore on load).
  const STORED = "right-pony-cylinder-marble-secret-value";

  beforeAll(() => registerRedactedSecretValue(STORED));
  afterAll(() => unregisterRedactedSecretValue(STORED));

  it("the value matches no pattern on its own — proving the block comes from the registry", () => {
    unregisterRedactedSecretValue(STORED);
    expect(scanForSecrets(`x=${STORED}`).clean).toBe(true);
    registerRedactedSecretValue(STORED);
    expect(scanForSecrets(`x=${STORED}`).clean).toBe(false);
  });

  it("blocks egress of the stored value literally", () => {
    const ctx = makeCtx("clipboard_write", { text: `copy ${STORED}` }, sessionId);
    const outcome = egressGuardGate(ctx);
    expect(outcome.kind).toBe("halt");
    expect(ctx.result?.metadata?.layer).toBe("egress-guard");
  });

  it("detects the stored value base64-encoded (decode-view reuse) — email routes to approval", () => {
    // The decode-view scan must still FIRE on the encoded blob. email_send is
    // recipient-aware since 7c23e4a5, so detection surfaces as the confirmable
    // downgrade (continue + policyApprovalReason), not a hard halt — a continue
    // WITHOUT the reason would mean the encoded secret evaded the scan.
    const blob = Buffer.from(STORED, "utf8").toString("base64");
    const ctx = makeCtx("email_send", { to: "a@b.com", subject: "x", body: `data=${blob}` }, sessionId);
    expect(egressGuardGate(ctx).kind).toBe("continue");
    expect(ctx.policyApprovalReason).toMatch(/a@b\.com/);
    expect(ctx.policyApprovalReason).toMatch(/secret-shaped content/);
  });
});

describe("canaryEgressGate — canary in an outbound payload is hard-blocked + audited", () => {
  const sessionId = "cap-class-canary";
  const canaries = generateCanaries();
  const CANARY = canaries[0]; // e.g. CANARY-<id>-ALPHA
  let auditDir: string;

  beforeEach(() => {
    // Arm the session's canary set (as ThreatEngine does), and inject a temp
    // audit trail so the exfil event can be read back without touching ~/.lax.
    registerSessionCanaries(sessionId, canaries);
    auditDir = mkdtempSync(join(tmpdir(), "lax-canary-audit-"));
    _setCanaryAuditTrail(new CryptoAuditTrail(auditDir));
  });
  afterAll(() => {
    clearSessionCanaries(sessionId);
    _setCanaryAuditTrail(null);
  });

  function auditPath(): string {
    const dir = join(auditDir, "audit");
    const files = readdirSync(dir).filter(f => f.endsWith(".jsonl") && !f.endsWith(".anchors.jsonl"));
    return join(dir, files[0]);
  }

  it("hard-blocks an egress-class call whose payload contains a canary, and audits it WITHOUT the raw token", () => {
    const ctx = makeCtx("email_send", { to: "a@b.com", subject: "x", body: `leaked: ${CANARY}` }, sessionId);
    const outcome = canaryEgressGate(ctx);
    expect(outcome.kind).toBe("halt");
    expect(ctx.allowed).toBe(false);
    expect(ctx.result?.metadata?.layer).toBe("canary");
    // Model-visible block text must NOT echo the raw canary value.
    expect(ctx.result?.content).not.toContain(CANARY);

    // A canary_exfil_detected event is appended and the chain verifies.
    const raw = readFileSync(auditPath(), "utf-8").trim();
    expect(raw).toContain("canary_exfil_detected");
    expect(raw).toContain("email_send");
    expect(raw).toContain('"controlsApplied":["Canary"]');
    // The raw canary token must NEVER appear in the audit record.
    expect(raw).not.toContain(CANARY);
    expect(CryptoAuditTrail.verify(auditPath()).valid).toBe(true);
  });

  it("blocks the base64-encoded form of the canary (decode-view reuse)", () => {
    const blob = Buffer.from(CANARY, "utf8").toString("base64");
    const ctx = makeCtx("clipboard_write", { text: `copy ${blob}` }, sessionId);
    expect(canaryEgressGate(ctx).kind).toBe("halt");
    expect(ctx.result?.metadata?.layer).toBe("canary");
  });

  it("does NOT block an egress payload with no canary (taint behavior unchanged)", () => {
    const ctx = makeCtx("email_send", { to: "a@b.com", subject: "x", body: "nothing secret here" }, sessionId);
    expect(canaryEgressGate(ctx).kind).toBe("continue");
  });

  it("is a no-op for non-egress tools even if the payload would contain a canary", () => {
    const ctx = makeCtx("read", { path: `/tmp/${CANARY}` }, sessionId);
    expect(canaryEgressGate(ctx).kind).toBe("continue");
  });

  it("does not fire for a session with no registered canaries", () => {
    const clean = "cap-class-canary-none";
    clearSessionCanaries(clean);
    const ctx = makeCtx("email_send", { to: "a@b.com", subject: "x", body: `leaked: ${CANARY}` }, clean);
    expect(canaryEgressGate(ctx).kind).toBe("continue");
  });
});


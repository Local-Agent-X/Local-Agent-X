// email_setup sends the vault password to the SMTP host it is given (verify
// now, every send later). That host is a destination the secret's ladder must
// allow (ADR 0005): asked once in the chat before any connection, kept on a
// yes, nothing connected or written on a no.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const transports = vi.hoisted(() => ({ created: [] as Array<{ host: string; port: number }> }));
vi.mock("nodemailer", () => ({
  createTransport: (opts: { host: string; port: number }) => {
    transports.created.push({ host: opts.host, port: opts.port });
    return { verify: async () => true };
  },
}));

const { approvals } = vi.hoisted(() => ({ approvals: { answer: true, asked: [] as Array<{ context: string; args: Record<string, unknown> }> } }));
vi.mock("../approval-manager.js", () => ({
  getApprovalManager: () => ({
    requestApprovalDetailed: async (opts: { context: string; args: Record<string, unknown> }) => {
      approvals.asked.push(opts);
      return approvals.answer ? { approved: true } : { approved: false, reason: "declined" };
    },
  }),
}));
vi.mock("../ops/pre-bless.js", () => ({ getActivePreBlessedSecrets: () => new Set<string>() }));

import { emailSetup } from "./email-compose-tools.js";
import { SecretsStore, setSecretsStoreSingleton } from "../secrets.js";
import { parkNeedsUser } from "../tool-execution/deferred-call.js";
import { inboxStore } from "../inbox/index.js";
import { declineInboxItem } from "../inbox/approvals.js";
import type { ToolCallContext } from "../tool-execution/context.js";

let dir: string;
let store: SecretsStore;
const prev = process.env.LAX_DATA_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-email-setup-"));
  process.env.LAX_DATA_DIR = dir;
  store = new SecretsStore(dir);
  setSecretsStoreSingleton(store);
  store.set("FASTMAIL", "app-password-0123456789", { service: "Fastmail", account: "me@fastmail.com" });
  transports.created.length = 0;
  approvals.answer = true;
  approvals.asked.length = 0;
});
afterEach(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const setup = (args: Record<string, unknown>) =>
  emailSetup.execute({ _sessionId: "chat-1", _onEvent: () => undefined, _callContext: "local", smtp_host: "smtp.fastmail.com", smtp_port: 465, smtp_user: "me@fastmail.com", smtp_from: "me@fastmail.com", smtp_secret_name: "FASTMAIL", ...args });

describe("email_setup — the SMTP host is a destination the password must be approved for", () => {
  it("asks once for smtp://host:port before the verify connection, then connects; a later setup does not ask", async () => {
    const res = await setup({});
    expect(res.isError).toBeFalsy();
    expect(approvals.asked).toHaveLength(1);
    expect(approvals.asked[0].args).toEqual({ name: "FASTMAIL", destination: "smtp://smtp.fastmail.com:465" });
    expect(approvals.asked[0].context).not.toContain("app-password");
    expect(transports.created).toEqual([{ host: "smtp.fastmail.com", port: 465 }]);
    expect(store.isDestinationApproved("FASTMAIL", "smtp://smtp.fastmail.com:465")).toBe(true);

    await setup({});
    expect(approvals.asked).toHaveLength(1);
  });

  it("a no connects to nothing and writes nothing", async () => {
    approvals.answer = false;
    const res = await setup({ smtp_host: "smtp.attacker.example", smtp_port: 587 });
    expect(res.status).toBe("declined");
    expect(transports.created).toEqual([]);
    expect(existsSync(join(dir, "email.json"))).toBe(false);
    expect(store.isDestinationApproved("FASTMAIL", "smtp://smtp.attacker.example:587")).toBe(false);
  });

  it("another port on the same host is another destination", async () => {
    store.approveDestination("FASTMAIL", "smtp://smtp.fastmail.com:465");
    await setup({ smtp_port: 587 });
    expect(approvals.asked.map((a) => a.args.destination)).toEqual(["smtp://smtp.fastmail.com:587"]);
  });

  it("a configured IMAP host is asked about too, as imap://host:port", async () => {
    store.approveDestination("FASTMAIL", "smtp://smtp.fastmail.com:465");
    const res = await setup({ imap_host: "imap.fastmail.com", imap_secret_name: "FASTMAIL" });
    expect(res.isError).toBeFalsy();
    expect(approvals.asked.map((a) => a.args.destination)).toEqual(["imap://imap.fastmail.com:993"]);
    expect(store.isDestinationApproved("FASTMAIL", "imap://imap.fastmail.com:993")).toBe(true);
  });

  it("the session that captured the password is not asked", async () => {
    store.set("CAPTURED_PASS", "captured-app-password-0123", { origin: "https://app.fastmail.com", createdBySession: "chat-1" });
    const res = await setup({ smtp_secret_name: "CAPTURED_PASS" });
    expect(res.isError).toBeFalsy();
    expect(approvals.asked).toHaveLength(0);
    expect(transports.created).toHaveLength(1);
  });
});

// A background op setting up mail: nobody is watching, so the hosts the
// password would reach raise no card. The pipeline parks the call in the
// user's inbox (parkNeedsUser, as run-sandboxed.ts does), naming every host
// the call needs, and the user's yes there is what connects and keeps them.
describe("email_setup — in an unattended run", () => {
  const SESSION = "op-mail-1700000000000";
  const request = { smtp_host: "smtp.fastmail.com", smtp_port: 465, smtp_user: "me@fastmail.com", smtp_from: "me@fastmail.com", smtp_secret_name: "FASTMAIL", imap_host: "imap.fastmail.com", imap_secret_name: "FASTMAIL" };
  const background = (stamps: Record<string, unknown> = {}) =>
    emailSetup.execute({ _sessionId: SESSION, _onEvent: () => undefined, _callContext: "api", ...request, ...stamps });
  const park = (result: Awaited<ReturnType<typeof background>>) => parkNeedsUser({
    tc: { id: "tc-op", name: "email_setup", arguments: JSON.stringify(request) },
    args: { ...request }, sessionId: SESSION, callContext: "api", msgs: [],
  } as unknown as ToolCallContext, result);

  it("raises no card, connects to nothing, and parks one inbox item naming both hosts", async () => {
    const res = await background();
    expect(approvals.asked).toHaveLength(0);
    expect(transports.created).toEqual([]);
    expect(existsSync(join(dir, "email.json"))).toBe(false);
    const reason = String(res.metadata?.needsUser);
    expect(reason).toContain(`the first use of "FASTMAIL" at smtp://smtp.fastmail.com:465 needs the user's yes`);
    expect(reason).toContain(`the first use of "FASTMAIL" at imap://imap.fastmail.com:993 needs the user's yes`);
    const parked = park(res);
    const items = inboxStore().list().filter((i) => i.kind === "approval");
    expect(items).toHaveLength(1);
    expect(items[0].deferredCall).toMatchObject({ toolName: "email_setup", args: request, callContext: "api" });
    expect(parked.metadata).toMatchObject({ layer: "approval", deferredTo: items[0].id });
    expect(parked.content).not.toContain("app-password");
  });

  it("the user's yes from the inbox connects on the re-run and keeps both hosts", async () => {
    const res = await background({ _userGrant: "grant-1" });
    expect(res.isError).toBeFalsy();
    expect(approvals.asked).toHaveLength(0);
    expect(transports.created).toEqual([{ host: "smtp.fastmail.com", port: 465 }]);
    expect(store.isDestinationApproved("FASTMAIL", "smtp://smtp.fastmail.com:465")).toBe(true);
    expect(store.isDestinationApproved("FASTMAIL", "imap://imap.fastmail.com:993")).toBe(true);
  });

  it("a declined call stays refused: the next run connects to nothing and waits on the user again", async () => {
    const item = park(await background()).metadata?.deferredTo as string;
    expect(declineInboxItem(item)).toMatchObject({ ok: true, resolution: "declined" });
    const again = await background();
    expect(again.metadata?.needsUser).toBeTruthy();
    expect(approvals.asked).toHaveLength(0);
    expect(transports.created).toEqual([]);
    expect(store.isDestinationApproved("FASTMAIL", "smtp://smtp.fastmail.com:465")).toBe(false);
  });
});

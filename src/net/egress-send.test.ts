// The bytes a tool puts on the wire are judged before they leave, on evidence
// only: the session's canary, bytes from a sensitive source the session read,
// a stored secret's value the call was not approved to send. A clean request,
// and a tainted session's request that does not carry the tainted bytes, go.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FormData } from "undici";

const audits = vi.hoisted(() => [] as Array<{ sessionId: string; tool: string }>);
vi.mock("../threat/canaries.js", async (orig) => ({
  ...(await orig<typeof import("../threat/canaries.js")>()),
  recordCanaryExfilAudit: (sessionId: string, tool: string) => { audits.push({ sessionId, tool }); },
}));

const { assertSendAllowed, EgressPayloadBlocked } = await import("./egress-send.js");
const { runInEgressScope } = await import("./egress-scope.js");
const { recordSensitiveRead, clearSessionTaint } = await import("../data-lineage/index.js");
const { registerSessionCanaries, clearSessionCanaries } = await import("../threat/canaries.js");
const { registerRedactedSecretValue, unregisterRedactedSecretValue } = await import("../security/secrets/index.js");

const SESSION = "egress-send-test";
const READ = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY and the rest of the private config file";
const CANARY = "LAX-CANARY-7f3a9c2e1b";
const STORED = "sk_live_51HxQ2pZ9vR7tY3mK8nL4wJ6";

beforeEach(() => {
  audits.length = 0;
  recordSensitiveRead(SESSION, "sensitive_file", "/home/u/.aws/credentials", READ);
  registerSessionCanaries(SESSION, [CANARY]);
  registerRedactedSecretValue(STORED, "vault:STRIPE_KEY");
});
afterEach(() => {
  clearSessionTaint(SESSION);
  clearSessionCanaries(SESSION);
  unregisterRedactedSecretValue(STORED, "vault:STRIPE_KEY");
});

const inSession = (fn: () => Promise<void>) => runInEgressScope(SESSION, fn);
const URL_ = "https://api.example.com/v1/items";

describe("assertSendAllowed", () => {
  it("a clean request goes, even from a session that read something sensitive", async () => {
    await inSession(() => assertSendAllowed(URL_, '{"title":"hello"}'));
  });

  it("bytes from a sensitive source the session read are refused, with the declassify exit", async () => {
    const e = await inSession(() => assertSendAllowed(URL_, `{"note":"${READ}"}`)).catch((x) => x);
    expect(e).toBeInstanceOf(EgressPayloadBlocked);
    expect(e).toMatchObject({ layer: "data-lineage", clearable: "declassify" });
    expect(e.message).toContain("api.example.com");
    expect(e.message).not.toContain("wJalrXUtnFEMI");
  });

  it("the same bytes from another session are not that session's taint", async () => {
    await runInEgressScope("someone-else", () => assertSendAllowed(URL_, `{"note":"${READ}"}`));
  });

  it("the session's canary in the URL is refused and recorded once", async () => {
    const e = await inSession(() => assertSendAllowed(`${URL_}?ref=${CANARY}`, undefined)).catch((x) => x);
    expect(e).toMatchObject({ layer: "canary" });
    expect(audits).toEqual([{ sessionId: SESSION, tool: "network-send" }]);
  });

  it("a stored secret's value is refused unless the call was approved to send it", async () => {
    const e = await inSession(() => assertSendAllowed(URL_, `{"key":"${STORED}"}`)).catch((x) => x);
    expect(e).toMatchObject({ layer: "egress-guard" });
    expect(e.message).not.toContain(STORED);
    await inSession(() => assertSendAllowed(URL_, `{"key":"${STORED}"}`, [STORED]));
  });

  it("outside a tool call there is no session taint to judge, but a stored secret is still refused", async () => {
    await assertSendAllowed(URL_, `{"note":"${READ}"}`);
    await expect(assertSendAllowed(URL_, STORED)).rejects.toBeInstanceOf(EgressPayloadBlocked);
  });

  it("a multipart file part is judged too", async () => {
    const form = new FormData();
    form.append("caption", "a photo");
    form.append("file", new Blob([`header\n${READ}\nfooter`]), "notes.txt");
    await expect(inSession(() => assertSendAllowed(URL_, form))).rejects.toMatchObject({ layer: "data-lineage" });
  });
});

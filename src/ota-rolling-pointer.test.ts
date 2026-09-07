/**
 * The rolling pointer is the ONLY thing standing between an installed client
 * and code that has not been proven to build. These pin the two properties
 * that give it that job: it fails closed on anything it cannot resolve, and it
 * stays permissive about metadata so a future format bump cannot strand a
 * client that is unable to update itself past the change.
 */
import { describe, it, expect } from "vitest";
import {
  parseRollingPointer,
  fetchRollingPointer,
  rollingPointerUrl,
  ROLLING_POINTER_ASSET,
} from "./ota-rolling-pointer.js";

const SHA = "7ba4c12da91ca7633dc5fda236450a4b4b7af13b";
const pointer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ schemaVersion: 1, commit: SHA, subject: "fix: a thing", publishedAt: "2026-09-07T03:21:36Z", ...over });

const respond = (body: string, status = 200) =>
  (async () => ({ ok: status >= 200 && status < 300, status, text: async () => body })) as unknown as typeof fetch;

describe("parseRollingPointer", () => {
  it("reads the commit, subject and publish time of a well-formed pointer", () => {
    const p = parseRollingPointer(pointer());
    expect(p.commit).toBe(SHA);
    expect(p.subject).toBe("fix: a thing");
    expect(p.publishedAt).toBe("2026-09-07T03:21:36Z");
  });

  it("normalizes an uppercase sha rather than rejecting it", () => {
    expect(parseRollingPointer(pointer({ commit: SHA.toUpperCase() })).commit).toBe(SHA);
  });

  it("REFUSES a short sha — an unaddressable commit is not a target", () => {
    expect(() => parseRollingPointer(pointer({ commit: SHA.slice(0, 12) }))).toThrow(/no resolvable commit/i);
  });

  it("REFUSES a missing commit", () => {
    expect(() => parseRollingPointer(JSON.stringify({ schemaVersion: 1 }))).toThrow(/no resolvable commit/i);
  });

  it("REFUSES a branch name where a sha belongs", () => {
    expect(() => parseRollingPointer(pointer({ commit: "main" }))).toThrow(/no resolvable commit/i);
  });

  it("REFUSES malformed JSON instead of guessing", () => {
    expect(() => parseRollingPointer("{not json")).toThrow(/not valid JSON/i);
  });

  it("REFUSES a non-object payload", () => {
    expect(() => parseRollingPointer("[]")).toThrow(/no resolvable commit/i);
    expect(() => parseRollingPointer("null")).toThrow(/not an object/i);
  });

  // A client that rejected an unfamiliar schemaVersion could never update to
  // the client that understands it — the pointer is its only route to new code.
  // So an unknown version must stay installable as long as the commit resolves.
  it("accepts a future schemaVersion and unknown fields (no self-inflicted brick)", () => {
    const p = parseRollingPointer(pointer({ schemaVersion: 9, somethingNew: { nested: true } }));
    expect(p.commit).toBe(SHA);
    expect(p.schemaVersion).toBe(9);
  });

  it("tolerates missing display metadata", () => {
    const p = parseRollingPointer(JSON.stringify({ commit: SHA }));
    expect(p.subject).toBe("");
    expect(p.publishedAt).toBe("");
  });
});

describe("fetchRollingPointer — fails closed", () => {
  it("reads the pointer from the rolling release asset path", async () => {
    expect(rollingPointerUrl("o", "r")).toBe(`https://github.com/o/r/releases/download/rolling/${ROLLING_POINTER_ASSET}`);
  });

  it("resolves the published commit on success", async () => {
    const p = await fetchRollingPointer("o", "r", respond(pointer()));
    expect(p.commit).toBe(SHA);
  });

  // Before CI publishes its first proven build there is nothing installable.
  // The message has to say that, not read as a network failure.
  it("explains a 404 as 'nothing verified published yet'", async () => {
    await expect(fetchRollingPointer("o", "r", respond("", 404)))
      .rejects.toThrow(/no verified rolling build/i);
  });

  it("surfaces a server error instead of falling back to an unproven commit", async () => {
    await expect(fetchRollingPointer("o", "r", respond("", 500)))
      .rejects.toThrow(/could not read the rolling pointer/i);
  });

  it("refuses a corrupt published pointer", async () => {
    await expect(fetchRollingPointer("o", "r", respond("<html>404</html>")))
      .rejects.toThrow(/not valid JSON/i);
  });
});

// The private store keeps the newest reads when a session reads past its
// budget, records a repeated read once, holds fingerprints only, answers for
// each read's own correspondents, and remembers a yes for exactly one source
// and destination.
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { addressesIn, clearPrivateContent, findPrivateContent, privateShareApproved, recordPrivateRead, rememberPrivateShare } from "./private-content.js";

const SID = "private-store-test";
afterEach(() => clearPrivateContent(SID));

function doc(i: number): string {
  let s = "";
  for (let k = 0; s.length < 60_000; k++) s += createHash("sha256").update(`${i}:${k}`).digest("hex");
  return s;
}

const EMAIL = "an email you read";
const CLOSING = "From: Ana@Example.org about the closing paperwork for the house on Elm Street next week.";
const INVITE = "From: stranger@elsewhere.example: you are invited to claim a prize, reply with your details.";

describe("private content store", () => {
  it("drops the oldest reads first when a session reads past its budget", () => {
    const docs = Array.from({ length: 40 }, (_, i) => doc(i));
    docs.forEach((d, i) => recordPrivateRead(SID, { label: `doc-${i}`, key: `doc-${i}` }, d));
    expect(findPrivateContent(SID, docs[39].slice(1000, 1400)).map((m) => m.label)).toEqual(["doc-39"]);
    expect(findPrivateContent(SID, docs[0].slice(1000, 1400))).toEqual([]);
  });

  it("records a repeated read once and keeps correspondents lowercased", () => {
    recordPrivateRead(SID, { label: EMAIL, correspondents: ["Ana@Example.org"] }, CLOSING);
    recordPrivateRead(SID, { label: EMAIL, correspondents: ["Ana@Example.org"] }, CLOSING);
    const matches = findPrivateContent(SID, CLOSING);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ label: EMAIL, correspondents: ["ana@example.org"] });
  });

  it("two emails under one label each answer with their own correspondents", () => {
    recordPrivateRead(SID, { label: EMAIL, correspondents: ["ana@example.org"] }, CLOSING);
    recordPrivateRead(SID, { label: EMAIL, correspondents: ["stranger@elsewhere.example"] }, INVITE);
    expect(findPrivateContent(SID, CLOSING).map((m) => m.correspondents)).toEqual([["ana@example.org"]]);
    expect(findPrivateContent(SID, `${CLOSING} ${INVITE}`)).toHaveLength(2);
  });

  it("a document is one source however it is read; each email is its own", () => {
    recordPrivateRead(SID, { label: "C:/Users/pat/Documents/cv.txt", key: "C:/Users/pat/Documents/cv.txt" }, `${CLOSING} as text`);
    recordPrivateRead(SID, { label: "C:/Users/pat/Documents/cv.txt", key: "C:/Users/pat/Documents/cv.txt" }, `${CLOSING} as extracted`);
    expect(findPrivateContent(SID, CLOSING)).toHaveLength(1);
    recordPrivateRead(SID, { label: EMAIL }, INVITE);
    recordPrivateRead(SID, { label: EMAIL }, `${INVITE} (resent)`);
    const keys = findPrivateContent(SID, `${INVITE} (resent)`).map((m) => m.key);
    expect(new Set(keys).size).toBe(2);
  });

  it("remembers a yes for exactly the source and destination it was given", () => {
    rememberPrivateShare(SID, "cv", "site:acme.example");
    expect(privateShareApproved(SID, "cv", "site:acme.example")).toBe(true);
    expect(privateShareApproved(SID, "cv", "site:other.example")).toBe(false);
    expect(privateShareApproved(SID, "statement", "site:acme.example")).toBe(false);
    clearPrivateContent(SID);
    expect(privateShareApproved(SID, "cv", "site:acme.example")).toBe(false);
  });

  it("addressesIn reads an address however it is written", () => {
    expect(addressesIn("Mail Dana Reyes <Dana@CPA.example>, mailto:ops@cpa.example?subject=x and pat@home.example."))
      .toEqual(["dana@cpa.example", "ops@cpa.example", "pat@home.example"]);
  });
});

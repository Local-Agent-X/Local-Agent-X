// The private store keeps the newest reads when a session reads past its
// budget, records a repeated read once, and holds fingerprints only.
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { clearPrivateContent, findPrivateContent, recordPrivateRead } from "./private-content.js";

const SID = "private-store-test";
afterEach(() => clearPrivateContent(SID));

function doc(i: number): string {
  let s = "";
  for (let k = 0; s.length < 60_000; k++) s += createHash("sha256").update(`${i}:${k}`).digest("hex");
  return s;
}

describe("private content store", () => {
  it("drops the oldest reads first when a session reads past its budget", () => {
    const docs = Array.from({ length: 40 }, (_, i) => doc(i));
    docs.forEach((d, i) => recordPrivateRead(SID, `doc-${i}`, d));
    expect(findPrivateContent(SID, docs[39].slice(1000, 1400)).map((m) => m.target)).toEqual(["doc-39"]);
    expect(findPrivateContent(SID, docs[0].slice(1000, 1400))).toEqual([]);
  });

  it("records a repeated read once and keeps correspondents lowercased", () => {
    const body = "From: Ana@Example.org about the closing paperwork for the house on Elm Street next week.";
    recordPrivateRead(SID, "an email you read", body, ["Ana@Example.org"]);
    recordPrivateRead(SID, "an email you read", body, ["Ana@Example.org"]);
    expect(findPrivateContent(SID, body)).toEqual([{ target: "an email you read", correspondents: ["ana@example.org"] }]);
  });
});

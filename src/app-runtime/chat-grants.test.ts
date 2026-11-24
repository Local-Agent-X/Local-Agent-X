// Which apps may talk to the user's agents: off until the user answers, kept
// across restarts, and gone the moment they take the answer back.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appChatAnswer, forgetAppChatAnswer, listAppChatGrants, recordAppChatAnswer } from "./chat-grants.js";

let dir: string;
const prev = process.env.LAX_DATA_DIR;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "app-chat-grants-"));
  process.env.LAX_DATA_DIR = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("app chat grants", () => {
  it("no app is allowed until the user answers for it", () => {
    expect(appChatAnswer("hub")).toBeUndefined();
    expect(listAppChatGrants()).toEqual([]);
  });

  it("keeps each app's answer on disk, by app", () => {
    recordAppChatAnswer("hub", "granted", 1_000);
    recordAppChatAnswer("crm", "denied", 2_000);
    expect(appChatAnswer("hub")).toBe("granted");
    expect(appChatAnswer("crm")).toBe("denied");
    expect(appChatAnswer("hu")).toBeUndefined();
    expect(listAppChatGrants()).toEqual([{ appId: "crm", answer: "denied", at: 2_000 }, { appId: "hub", answer: "granted", at: 1_000 }]);
    expect(JSON.parse(readFileSync(join(dir, "app-chat-grants.json"), "utf-8"))).toEqual({
      grants: { hub: { answer: "granted", at: 1_000 }, crm: { answer: "denied", at: 2_000 } },
    });
  });

  it("a later answer replaces the earlier one", () => {
    recordAppChatAnswer("hub", "denied", 1_000);
    recordAppChatAnswer("hub", "granted", 2_000);
    expect(listAppChatGrants()).toEqual([{ appId: "hub", answer: "granted", at: 2_000 }]);
  });

  it("forgetting takes the answer back, and says whether there was one", () => {
    recordAppChatAnswer("hub", "granted");
    expect(forgetAppChatAnswer("hub")).toBe(true);
    expect(appChatAnswer("hub")).toBeUndefined();
    expect(forgetAppChatAnswer("hub")).toBe(false);
  });

  it("reads a damaged or hand-edited file as no answer, never as a yes", () => {
    for (const content of ["not json", JSON.stringify({ grants: { hub: true, crm: { answer: "yes", at: 1 }, pos: { answer: "granted" } } }), JSON.stringify({ grants: ["hub"] })]) {
      writeFileSync(join(dir, "app-chat-grants.json"), content);
      for (const app of ["hub", "crm", "pos"]) expect(appChatAnswer(app), `${app} in ${content}`).toBeUndefined();
      expect(listAppChatGrants()).toEqual([]);
    }
  });
});

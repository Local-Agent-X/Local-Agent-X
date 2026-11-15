// Every channel the user talks to LAX on is one memory: what they say on any
// of them is indexed and can be recalled on any other. Pinned for every
// messaging channel the registry defines, so a channel added later is held to
// it without anyone remembering to add it here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMessagingSessionId, messagingChannelIds } from "./channel-registry.js";
import {
  isExcludedFromSessionSummaries, isExcludedFromTranscriptSearch, isHiddenFromChatLists, isSyntheticSessionId,
} from "../memory/synthetic-sessions.js";
import { startsNewRequest, NEW_REQUEST_GAP_MS } from "../memory/manager.js";

describe("every messaging channel is part of the one memory", () => {
  it.each(messagingChannelIds())("%s chats are indexed, summarized and listed like a desktop chat", (id) => {
    const session = buildMessagingSessionId(id, "+15550001");
    expect(isSyntheticSessionId(session), "would never be indexed").toBe(false);
    expect(isExcludedFromTranscriptSearch(session), "would never be searched").toBe(false);
    expect(isExcludedFromSessionSummaries(session), "would never be summarized").toBe(false);
    expect(isHiddenFromChatLists(session)).toBe(false);
  });

  it("the recall trigger cannot tell channels apart: it reads only the chat's own history and quiet time", () => {
    expect(startsNewRequest.length).toBe(2);
    expect(startsNewRequest([{ role: "user" }, { role: "assistant" }], NEW_REQUEST_GAP_MS)).toBe(true);
  });

  it("messaging turns run with the desktop chat's memory, not a reduced one", () => {
    // The one runner every messaging channel's turn goes through (bootstrap-bridges.ts).
    const runner = readFileSync("src/server/inbound-channel-runner.ts", "utf8");
    expect(runner).not.toMatch(/skipMemory:\s*true/);
    const bridges = readFileSync("src/server/bootstrap-bridges.ts", "utf8");
    expect(bridges).toContain("createInboundChannelRunner");
  });
});

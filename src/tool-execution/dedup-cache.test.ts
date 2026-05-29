import { describe, expect, it, beforeEach } from "vitest";

import {
  dedupLookup,
  dedupRecord,
  _clearDedupCacheForTests,
} from "./dedup-cache.js";

const SCOPE = "sess-test";

function record(name: string, args: string, scope = SCOPE, content = "ok") {
  dedupRecord(scope, name, args, {
    msgs: [{ role: "tool", tool_call_id: "tc1", content } as never],
    allowed: true,
    resultContent: content,
  });
}

describe("dedup cache", () => {
  beforeEach(() => _clearDedupCacheForTests());

  it("returns null on first call", () => {
    expect(dedupLookup(SCOPE, "email_send", '{"to":"a@b.com"}')).toBeNull();
  });

  it("returns the prior record on identical (scope, name, args)", () => {
    record("email_send", '{"to":"a@b.com"}', SCOPE, "sent id=42");
    const hit = dedupLookup(SCOPE, "email_send", '{"to":"a@b.com"}');
    expect(hit?.resultContent).toBe("sent id=42");
  });

  it("treats arg key ordering as equivalent (canonical JSON)", () => {
    record("email_send", '{"to":"a@b.com","subject":"hi"}');
    const hit = dedupLookup(SCOPE, "email_send", '{"subject":"hi","to":"a@b.com"}');
    expect(hit).not.toBeNull();
  });

  it("does not dedup when args differ", () => {
    record("email_send", '{"to":"a@b.com"}');
    expect(dedupLookup(SCOPE, "email_send", '{"to":"c@d.com"}')).toBeNull();
  });

  it("does not dedup when tool name differs", () => {
    record("email_send", '{"to":"a@b.com"}');
    expect(dedupLookup(SCOPE, "email_draft", '{"to":"a@b.com"}')).toBeNull();
  });

  it("isolates by scope", () => {
    record("email_send", '{"to":"a@b.com"}', "sess-A");
    expect(dedupLookup("sess-B", "email_send", '{"to":"a@b.com"}')).toBeNull();
  });

  it("does not dedup when scope is missing", () => {
    record("email_send", '{"to":"a@b.com"}');
    expect(dedupLookup(undefined, "email_send", '{"to":"a@b.com"}')).toBeNull();
  });

  it("does not record skip-listed read tools", () => {
    record("process_status", '{"pid":123}');
    expect(dedupLookup(SCOPE, "process_status", '{"pid":123}')).toBeNull();
  });

  it("does not record failed results", () => {
    dedupRecord(SCOPE, "email_send", '{"to":"a@b.com"}', {
      msgs: [],
      allowed: true,
      result: { content: "smtp 500", isError: true },
      resultContent: "smtp 500",
    });
    expect(dedupLookup(SCOPE, "email_send", '{"to":"a@b.com"}')).toBeNull();
  });

  it("does not record disallowed results", () => {
    dedupRecord(SCOPE, "email_send", '{"to":"a@b.com"}', {
      msgs: [],
      allowed: false,
      resultContent: "blocked",
    });
    expect(dedupLookup(SCOPE, "email_send", '{"to":"a@b.com"}')).toBeNull();
  });
});

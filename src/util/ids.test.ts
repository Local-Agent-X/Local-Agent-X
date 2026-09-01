/**
 * The ONE place randomId()'s wire format is pinned. Consumers that derive a
 * fixture from it (chat-ws headless filter, synthetic-session classifier)
 * assert only the `<prefix>_` invariant they depend on, so a body-format
 * change fails here — not in a test that never cared about the body.
 */
import { describe, it, expect } from "vitest";
import { randomId } from "./ids.js";

describe("randomId", () => {
  it("formats `<prefix>_<16 hex>` with a prefix, and a bare 16-hex body without one", () => {
    expect(randomId("eval")).toMatch(/^eval_[0-9a-f]{16}$/);
    expect(randomId()).toMatch(/^[0-9a-f]{16}$/);
  });
});

// channel-context tests — the canonical surface enum, the untrusted frame-origin
// gate, and the per-channel grounding block the system prompt injects.

import { describe, it, expect } from "vitest";
import {
  allChannels,
  channelContextBlock,
  parseFrameOrigin,
  CHANNEL_DISPLAY_NAMES,
} from "./channel-context.js";

describe("channelContextBlock", () => {
  it("renders a non-empty harness notice naming the surface, for EVERY channel", () => {
    for (const channel of allChannels()) {
      const block = channelContextBlock(channel);
      expect(block).toContain("CHANNEL");
      expect(block).toContain(CHANNEL_DISPLAY_NAMES[channel]);
      expect(block.length).toBeGreaterThan(60);
    }
  });

  it("tells the model a mobile user is on their phone and cannot see the PC screen", () => {
    const block = channelContextBlock("mobile");
    expect(block).toContain("PHONE");
    expect(block).toContain("CANNOT see its screen");
  });

  it("tells the model voice replies are spoken and markdown is off-limits", () => {
    const block = channelContextBlock("voice");
    expect(block).toContain("spoken aloud");
    expect(block).toContain("markdown");
  });

  it("derives hard limits from the formatter config (telegram 4096)", () => {
    expect(channelContextBlock("telegram")).toContain("4096");
  });

  it("tells the model nobody is present on a scheduled run", () => {
    expect(channelContextBlock("cron")).toContain("no user is present");
  });
});

describe("parseFrameOrigin", () => {
  it("accepts the broker bridge's mobile stamp", () => {
    expect(parseFrameOrigin("mobile")).toBe("mobile");
  });

  it("rejects channels a client frame must not claim, and junk", () => {
    // Server-side surfaces are inferred, never trusted from a frame.
    for (const claim of ["web", "voice", "cron", "agent", "telegram", "", 42, null, undefined, {}]) {
      expect(parseFrameOrigin(claim)).toBeNull();
    }
  });
});

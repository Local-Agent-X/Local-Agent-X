// A reply that ends the turn on a step the agent would take itself. The first
// two cases are GPT's replies on the owner's phone test (Label Check Sol,
// 2026-11-27), each of which the owner had to answer with "?".
import { describe, expect, it } from "vitest";
import { namedNextStep, namedNextStepNudge } from "./named-next-step.js";

describe("namedNextStep", () => {
  it("finds the promised action, mid-reply too, and quotes its sentence", () => {
    const reply = "The scan failed on your Galaxy. The camera took the photo, but Google's on-device AI returned an error. " +
      "The next step is to pinpoint why the on-device request failed. In the meantime, Enter ingredients instead lets you continue.";
    expect(namedNextStep(reply)).toBe("The next step is to pinpoint why the on-device request failed.");
    expect(namedNextStep("Installed. Next, I'll run the scanner on the phone and read its log.")).toBe("Next, I'll run the scanner on the phone and read its log.");
    expect(namedNextStep("I'll go check the logcat output for the crash.")).toBe("I'll go check the logcat output for the crash.");
  });

  it("is not a promise of action: intent, a report, a closer, or a question to the user", () => {
    expect(namedNextStep("Got it — I'll leave everything in cleanup/legacy untouched; the three .tmp files are the ones I would remove.")).toBeNull();
    expect(namedNextStep("I checked the logs and ran the tests: all green.")).toBeNull();
    expect(namedNextStep("Done. Let me know if you see the error again.")).toBeNull();
    expect(namedNextStep("The phone is unplugged. Should I check the logs once you reconnect it?")).toBeNull();
    expect(namedNextStep("")).toBeNull();
  });

  it("the nudge quotes the step and leaves room to say what stops it", () => {
    const nudge = namedNextStepNudge("The next step is to pinpoint why it failed.");
    expect(nudge).toContain('("The next step is to pinpoint why it failed.")');
    expect(nudge).toContain("say what in one line");
  });
});

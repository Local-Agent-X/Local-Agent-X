import { describe, it, expect } from "vitest";

import { narrationPromisesFollowup } from "./p1-followup-detector.js";

describe("narrationPromisesFollowup", () => {
	it("flags a promised post-mutation step (the P-1 harm case)", () => {
		expect(narrationPromisesFollowup("I updated the config. I'll run the tests now.")).toBe(true);
		expect(narrationPromisesFollowup("Wrote the file. Next, I'll verify the build.")).toBe(true);
		expect(narrationPromisesFollowup("Saved it, then run the suite to confirm.")).toBe(true);
		expect(narrationPromisesFollowup("Patched the loader; now let me check the callers.")).toBe(true);
		expect(narrationPromisesFollowup("Done with the edit. Going to rebuild and confirm.")).toBe(true);
	});

	it("does NOT flag a self-contained mutation report (no follow-up pending)", () => {
		expect(narrationPromisesFollowup("Wrote the file. Done.")).toBe(false);
		expect(narrationPromisesFollowup("I ran the tests and they pass.")).toBe(false);
		expect(narrationPromisesFollowup("Verified the build is green.")).toBe(false);
		expect(narrationPromisesFollowup("Updated the config and reran the suite; all good.")).toBe(false);
	});

	it("does not count on-task-free closers as promises", () => {
		expect(narrationPromisesFollowup("Shipped the fix. Let me know if you want anything else.")).toBe(false);
		expect(narrationPromisesFollowup("All set — I'll be here if you need more.")).toBe(false);
	});

	it("treats empty / whitespace narration as no promise", () => {
		expect(narrationPromisesFollowup("")).toBe(false);
		expect(narrationPromisesFollowup("   \n\t ")).toBe(false);
	});
});

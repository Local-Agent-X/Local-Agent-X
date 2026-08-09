// Partial-aware endpoint classification — picks how long the utterance
// commit holds after VAD flags silence (smart endpointing).
import { describe, expect, it } from "vitest";
import { classifyEndpointPartial, ENDPOINT_HOLD_MS } from "./endpointing.js";

describe("classifyEndpointPartial", () => {
	it("terminal punctuation reads as complete (commit immediately)", () => {
		expect(classifyEndpointPartial("I think that's everything.")).toBe("complete");
		expect(classifyEndpointPartial("can you check that?")).toBe("complete");
		expect(classifyEndpointPartial('he said "stop!"')).toBe("complete");
	});

	it("mid-thought punctuation and trailing continuation words read as incomplete", () => {
		expect(classifyEndpointPartial("i was thinking about it and")).toBe("incomplete");
		expect(classifyEndpointPartial("the thing is,")).toBe("incomplete");
		expect(classifyEndpointPartial("because")).toBe("incomplete");
		expect(classifyEndpointPartial("i keep thinking that i'm")).toBe("incomplete");
		expect(classifyEndpointPartial("well um")).toBe("incomplete");
	});

	it("unpunctuated ordinary endings are neutral (moderate hold)", () => {
		expect(classifyEndpointPartial("i can't keep living this way")).toBe("neutral");
		expect(classifyEndpointPartial("open the browser")).toBe("neutral");
	});

	it("empty/missing partial is neutral — never blocks the commit for long", () => {
		expect(classifyEndpointPartial("")).toBe("neutral");
		expect(classifyEndpointPartial("   ")).toBe("neutral");
	});

	it("hold table: complete commits instantly, incomplete waits longest", () => {
		expect(ENDPOINT_HOLD_MS.complete).toBe(0);
		expect(ENDPOINT_HOLD_MS.incomplete).toBeGreaterThan(ENDPOINT_HOLD_MS.neutral);
	});
});

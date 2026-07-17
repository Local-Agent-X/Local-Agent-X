// Model-output hygiene regression suite.
//
// Class of bug: a small local model leaks template plumbing into its visible
// reply — chat-template special tokens, reasoning tags, tool-call markup
// hallucinated as plain text, stray closing tags, and verbatim whole-reply
// repeats — and LAX saves it raw to the transcript and feeds it raw to TTS
// (2026-07 voice incident: stray </blockquote> + fabricated
// "<execute_tool>\nNone\n</execute_tool>" + the entire reply repeated).
// providers/output-sanitize.ts is the one seam for model-output text at the
// delivery and persist points; these tests pin its guarantees:
//  - every junk family above is removed, including unterminated-at-end forms
//  - code spans (fenced + inline) are preserved byte-for-byte
//  - clean text passes through byte-identical
import { describe, it, expect } from "vitest";

import { sanitizeModelOutput, stripLeakedSpecialTokensStreaming } from "./output-sanitize.js";

// Both fixtures must clear the 80-char repeat-collapse floor (asserted below).
const INCIDENT_HALF =
	"Alright — I checked the store schedule: tomorrow opens at nine, so I set your reminder for eight forty-five, as you asked.";
const PARA =
	"The nightly report is queued: supplement trends first, then the pricing sweep, and the summary lands in your inbox by six.";

describe("sanitizeModelOutput", () => {
	const cases: Array<{ name: string; input: string; expected: string }> = [
		{
			name: "voice incident: stray closer + fabricated tool block + whole-reply repeat",
			input:
				`${INCIDENT_HALF}</blockquote>\n<execute_tool>\nNone\n</execute_tool>\n` +
				`${INCIDENT_HALF}</blockquote>\n<execute_tool>\nNone\n</execute_tool>\n`,
			expected: INCIDENT_HALF,
		},
		{
			name: "channel marker addressed to a tool goes entirely, payload included",
			input: '<|channel|>commentary to=functions.get_weather<|message|>{"city":"McKinney"}',
			expected: "",
		},
		{
			name: "channel-to-tool leak after real speech keeps the speech",
			input: "Sure thing.\n<|channel|>commentary to=functions.x<|message|>{}",
			expected: "Sure thing.",
		},
		{
			name: "plain channel markers drop, reply payload stays",
			input: "<|channel|>final<|message|>Here's the summary you asked for.",
			expected: "Here's the summary you asked for.",
		},
		{
			name: "fullwidth-bar special token",
			input: "Done.<｜end▁of▁sentence｜>",
			expected: "Done.",
		},
		{
			name: "turn-opener role word and stop token both go",
			input: "<|im_start|>assistant\nHi Peter.<|im_end|>",
			expected: "Hi Peter.",
		},
		{
			name: "role-header pair loses the stranded role word",
			input: "<|start_header_id|>assistant<|end_header_id|>\n\nOn it.",
			expected: "On it.",
		},
		{
			name: "unterminated <think> swallows the trailing text",
			input: "Here's the plan.\n<think>wait — the user probably wants the short version",
			expected: "Here's the plan.",
		},
		{
			name: "paired reasoning tag removed with its content, case-insensitive",
			input: "<THINKING>internal deliberation</THINKING>The answer is 4.",
			expected: "The answer is 4.",
		},
		{
			name: "<thought> small-model artifact removed",
			input: "Sure.<thought>small-model artifact</thought> Done.",
			expected: "Sure. Done.",
		},
		{
			name: "lone closing reasoning tag loses only the tag, content stays",
			input: "The result is 12.</think>",
			expected: "The result is 12.",
		},
		{
			name: "fenced code preserved while junk outside is scrubbed",
			input: "Use this snippet:\n```md\n<think>kept verbatim</think>\n```\nDone.<|im_end|>",
			expected: "Use this snippet:\n```md\n<think>kept verbatim</think>\n```\nDone.",
		},
		{
			name: "orphan </blockquote> removed while balanced <div> pair is kept",
			input: "<div>The plan holds.</div> We're set for Friday.</blockquote>",
			expected: "<div>The plan holds.</div> We're set for Friday.",
		},
		{
			name: "orphan </p> removed mid-text",
			input: "First point.</p> Second point.",
			expected: "First point. Second point.",
		},
		{
			name: "tool block wrapping fenced json removed wholesale",
			input: 'Done.\n<tool_call>\n```json\n{"name":"read_file"}\n```\n</tool_call>',
			expected: "Done.",
		},
		{
			name: "<function=name> paired form removed with payload",
			input: 'Saving now.<function=save_note>{"text":"milk"}</function>',
			expected: "Saving now.",
		},
		{
			name: '<function name="..."> attribute form removed with payload',
			input: '<function name="lookup">\n{"q":"hours"}\n</function>\nAnything else?',
			expected: "Anything else?",
		},
		{
			name: "unterminated <invoke ...> owns the tail",
			input: 'Let me check.\n<invoke name="get_status">',
			expected: "Let me check.",
		},
		{
			name: "unterminated <tool_result> owns the tail",
			input: "Checking.\n<tool_result>\n42",
			expected: "Checking.",
		},
		{
			name: "[TOOL_CALL] bracket pair removed with payload",
			input: "On it.\n[TOOL_CALL] get_weather [/TOOL_CALL]\nGive me a sec.",
			expected: "On it.\n\nGive me a sec.",
		},
		{
			name: "[tool:name]{json} marker removed entirely",
			input: '[tool:get_weather]{"city":"McKinney","when":"tomorrow"}',
			expected: "",
		},
		{
			name: "unterminated [TOOL_CALL] owns the tail",
			input: 'Hold on.\n[TOOL_CALL] {"name":"restart_sidecar"',
			expected: "Hold on.",
		},
		{
			name: "whole-text verbatim repeat collapses to one copy",
			input: `${PARA}\n\n${PARA}`,
			expected: PARA,
		},
		{
			name: "4x repeat folds across iterations",
			input: `${PARA}\n${PARA}\n${PARA}\n${PARA}`,
			expected: PARA,
		},
		{
			name: "removal gaps are tidied to one blank line",
			input: "Para one.\n\n<think>redo</think>\n\nPara two.",
			expected: "Para one.\n\nPara two.",
		},
		{
			name: "leading residue whitespace from a removal does not defeat repeat collapse",
			input: `<|im_end|>  ${PARA}\n\n${PARA}`,
			expected: PARA,
		},
		{
			name: "split-line channel header loses the stranded routing word",
			input: "<|channel|>final\n<|message|>Hello",
			expected: "Hello",
		},
	];

	for (const c of cases) {
		it(c.name, () => {
			expect(sanitizeModelOutput(c.input, "delivery")).toBe(c.expected);
		});
	}

	const untouched: Array<{ name: string; input: string }> = [
		{
			name: "inline code discussing tags and tokens",
			input: "Small local models sometimes leak `<think>` or `<|im_end|>` into replies.",
		},
		{
			name: "clean markdown with balanced html and fenced junk-lookalikes",
			input: [
				"# Status",
				"",
				"Everything is **on track** — 3 of 4 jobs done, and 5 > 3 while 2 < 4.",
				"",
				"- `npm run build` passed",
				"- inline `<think>` and `<|im_end|>` stay put in code",
				"",
				"```html",
				"<blockquote>quoted</blockquote>",
				"<execute_tool>None</execute_tool>",
				"```",
				"",
				"<div>balanced block</div> and an arrow -> plus a happy face :)",
			].join("\n"),
		},
		{
			name: "short repeated chant lines sit under the 80-char repeat floor",
			input: "na na na hey\nna na na hey\nna na na hey",
		},
		{
			name: "near-miss repetition differing by one char stays",
			input: `${PARA}\n\n${PARA}!`,
		},
		{
			name: "comparison operators are not tags",
			input: "In this range 2 < 4 and 9 > 7, so we're fine.",
		},
		{
			// Kills a floor-removal mutation: any collapse of tiny repeats fails here.
			name: "two-copy short repeat stays",
			input: "Yes we can.\n\nYes we can.",
		},
		{
			// A is 38 chars — inside [20, 79], so this kills a MIN_REPEAT_BLOCK
			// 80→20 mutation that the 11-char case above would survive.
			name: "mid-length two-copy repeat under the 80-char floor stays",
			input: "Yes we can — and we will, count on it.\n\nYes we can — and we will, count on it.",
		},
		{
			// Kills removal of the space exclusion in the special-token inner class.
			name: "spaced pipe operators in prose are not tokens",
			input: "x <| y |> z",
		},
		{
			// Kills loosening of the unterminated tool-opener rule: bare unpaired
			// <function>/<invoke> must not swallow the tail of real prose.
			name: "bare unpaired <function> and <invoke> in prose keep their tail",
			input: "The <function> keyword takes arguments, and <invoke> is not a call either.",
		},
		{ name: "empty string", input: "" },
	];

	for (const c of untouched) {
		it(`byte-identical: ${c.name}`, () => {
			expect(sanitizeModelOutput(c.input, "delivery")).toBe(c.input);
		});
	}

	it("fixtures respect the 80-char repeat-collapse floor", () => {
		expect(INCIDENT_HALF.length).toBeGreaterThanOrEqual(80);
		expect(PARA.length).toBeGreaterThanOrEqual(80);
	});

	it("persist profile matches delivery byte-for-byte today", () => {
		for (const c of cases) {
			expect(sanitizeModelOutput(c.input, "persist")).toBe(sanitizeModelOutput(c.input, "delivery"));
		}
	});
});

describe("stripLeakedSpecialTokensStreaming", () => {
	const cases: Array<{ name: string; delta: string; expected: string }> = [
		{ name: "strips a complete stop token", delta: "Hello<|im_end|>", expected: "Hello" },
		{ name: "strips a channel pair inside one delta", delta: "<|channel|>final<|message|>Hi", expected: "Hi" },
		{ name: "strips a turn-opener with its role word", delta: "<|im_start|>assistant\nHey", expected: "Hey" },
		{ name: "strips a fullwidth token", delta: "Done<｜end▁of▁sentence｜>", expected: "Done" },
		{ name: "leaves a token split across deltas for the full pass", delta: "<|im_en", expected: "<|im_en" },
		{ name: "plain text passes through", delta: "no tokens here", expected: "no tokens here" },
		{ name: "reasoning tags are not its job", delta: "<think>x", expected: "<think>x" },
	];

	for (const c of cases) {
		it(c.name, () => {
			expect(stripLeakedSpecialTokensStreaming(c.delta)).toBe(c.expected);
		});
	}
});

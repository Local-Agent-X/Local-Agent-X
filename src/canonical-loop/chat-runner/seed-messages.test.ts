// Sibling of adapters/image-only-nudge.contract.test.ts for the SEEDED-HISTORY
// leg of the 2026-08-31 empty-text campaign: a caption-less photo the user sent
// a turn ago round-trips through session.messages as {content:"", images:[{name,
// url:"/uploads/<f>"}]} (opMessageRowToChatParam strips filePath for the UI
// projection). seedOpMessages used to drop that row on its emptiness filter —
// the model lost sight of an image it was shown a turn ago. This drives the
// REAL seams: seedOpMessages → buildTurnInput → canonicalToTransport →
// Anthropic convertMessages / Gemini toGeminiContents.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { Op } from "../../ops/types.js";
import type { PreparedAgentRequest } from "../../agent-request/types.js";
import { uploadsDir } from "../../config.js";
import {
  seedOpMessages,
  REVIVED_HISTORY_IMAGE_MAX_COUNT,
  REVIVED_HISTORY_IMAGE_MAX_BYTES,
} from "./seed-messages.js";
import { buildTurnInput } from "../turn-loop/build-input.js";
import { canonicalToTransport } from "../adapters/canonical-to-transport.js";
import { imagesToOpenAIParts } from "../adapters/images-to-openai-parts.js";
import { toGeminiContents } from "../adapters/gemini-native-transport.js";
import type { TransportMessage } from "../adapters/anthropic.js";
import { convertMessages } from "../../anthropic-client/request.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const DIGEST_OPEN = "[SITUATIONAL CONTEXT";
// The uploads dir lives under the throwaway HOME test/setup/test-env.ts
// creates, so nothing here touches the developer's real ~/.lax.
const SHOT_NAME = "seedtest-shot.png";
const GONE_NAME = "seedtest-gone.png";

let opSeq = 0;
let opId = "";
beforeEach(() => {
  opId = `op_seed_images_${opSeq++}`;
  mkdirSync(uploadsDir(), { recursive: true });
  writeFileSync(join(uploadsDir(), SHOT_NAME), Buffer.from(PNG_B64, "base64"));
});

function op(): Op {
  return { id: opId, type: "chat_turn", task: "look again", lane: "interactive" } as unknown as Op;
}

// seedOpMessages reads only cleanHistory + images off the prepared request.
function prepared(cleanHistory: ChatCompletionMessageParam[]): PreparedAgentRequest {
  return { cleanHistory, images: [] } as unknown as PreparedAgentRequest;
}

// The exact session.messages row a caption-less photo send round-trips to
// (message-convert.ts normalizeImages: {name, url} only — filePath stripped).
function photoRow(name: string): ChatCompletionMessageParam {
  return { role: "user", content: "", images: [{ name, url: `/uploads/${name}` }] } as unknown as ChatCompletionMessageParam;
}

async function pipeline(): Promise<TransportMessage[]> {
  const input = await buildTurnInput(op(), 1, null);
  return canonicalToTransport(input.messages, input.pendingRedirect);
}

// Mirrors the module-private transport toOpenAiMessage for the rows used here.
function toParams(transport: TransportMessage[]): ChatCompletionMessageParam[] {
  return transport.map(m =>
    m.role === "user" && m.images && m.images.length > 0
      ? ({ role: "user", content: imagesToOpenAIParts(m.content, m.images) } as ChatCompletionMessageParam)
      : ({ role: m.role, content: m.content } as ChatCompletionMessageParam),
  );
}

describe("seedOpMessages — caption-less photo rows in seeded history", () => {
  it("survives seeding with filePath restored from the /uploads url, and reaches both wires as a real image", async () => {
    seedOpMessages(
      opId,
      prepared([photoRow(SHOT_NAME), { role: "assistant", content: "A tidy dashboard." }]),
      "what did I show you earlier?",
    );
    const transport = await pipeline();
    expect(transport.map(m => m.role)).toEqual(["user", "assistant", "user"]);
    // filePath revived via mapUploadsRef — the same single-source mapping the
    // file tools and the security gate resolve "/uploads/<f>" with.
    const shotPath = join(uploadsDir(), SHOT_NAME);
    expect(transport[0].content).toBe("");
    expect(transport[0].images).toEqual([{ name: SHOT_NAME, url: `/uploads/${SHOT_NAME}`, filePath: shotPath }]);
    expect(transport[2].content).toContain(DIGEST_OPEN);

    // Anthropic wire: image block + path hint, no empty text block anywhere.
    const wire = convertMessages(toParams(transport));
    expect(wire.map(m => m.role)).toEqual(["user", "assistant", "user"]);
    const blocks = wire[0].content as Array<{ type: string; text?: string }>;
    expect(blocks.map(b => b.type)).toEqual(["image", "text"]);
    expect(blocks[1].text).toContain(shotPath);
    expect(JSON.stringify(wire)).not.toContain('{"type":"text","text":""}');

    // Gemini wire: inlineData + path hint, no {text:""}.
    const contents = toGeminiContents(transport);
    expect(contents.map(c => c.role)).toEqual(["user", "model", "user"]);
    expect(contents[0].parts[0]).toEqual({ inlineData: { mimeType: "image/png", data: PNG_B64 } });
    expect((contents[0].parts[1] as { text: string }).text).toContain(shotPath);
    expect(JSON.stringify(contents)).not.toContain('"text":""');
  });

  it("a pruned upload in history degrades to the standard unreadable note — the row is neither dropped nor empty", async () => {
    seedOpMessages(
      opId,
      prepared([photoRow(GONE_NAME), { role: "assistant", content: "Looking at it." }]),
      "so what was on it?",
    );
    const transport = await pipeline();
    expect(transport.map(m => m.role)).toEqual(["user", "assistant", "user"]);

    const NOTE = `[Attachment ${GONE_NAME} could not be read (ENOENT)]`;
    const wire = convertMessages(toParams(transport));
    expect(wire[0].content).toEqual([{ type: "text", text: NOTE }]);
    // The absolute on-disk path never leaks into the wire.
    expect(JSON.stringify(wire)).not.toContain(join(uploadsDir(), GONE_NAME));

    const contents = toGeminiContents(transport);
    expect(contents[0].parts).toEqual([{ text: NOTE }]);
  });

  it("bounded revival: 7 unique images → only the 6 most recent get bytes; a repeated url revives only at its LAST occurrence", async () => {
    expect(REVIVED_HISTORY_IMAGE_MAX_COUNT).toBe(6);
    const names = ["A", "B", "C", "D", "E", "F", "G"].map(n => `seedcap-${n}.png`);
    for (const n of names) writeFileSync(join(uploadsDir(), n), Buffer.from(PNG_B64, "base64"));
    const img = (n: string) => ({ name: n, url: `/uploads/${n}` });
    const [A, B, C, D, E, F, G] = names;
    const userRow = (text: string, imgs: Array<{ name: string; url: string }>) =>
      ({ role: "user", content: text, images: imgs } as unknown as ChatCompletionMessageParam);
    seedOpMessages(
      opId,
      prepared([
        userRow("", [img(A), img(B)]),
        { role: "assistant", content: "ok" },
        userRow("look", [img(C)]),
        { role: "assistant", content: "ok" },
        userRow("", [img(D), img(E), img(F)]),
        { role: "assistant", content: "ok" },
        userRow("", [img(G), img(A)]), // A repeats — bytes belong HERE, not row 0
        { role: "assistant", content: "those are the seven" },
      ]),
      "which of those had the chart?",
    );
    const transport = await pipeline();
    expect(transport).toHaveLength(9);

    // Row 0 lost both: A's bytes moved to its most recent occurrence, B is
    // the 7th unique image — but the ROW survives as non-empty placeholders.
    expect(transport[0].images).toBeUndefined();
    expect(transport[0].content).toBe(
      `[Image ${A} shown earlier in this conversation]\n[Image ${B} shown earlier in this conversation]`,
    );
    // The six winners keep bytes, captions intact.
    expect(transport[2].content).toBe("look");
    expect(transport[2].images?.map(i => i.name)).toEqual([C]);
    expect(transport[4].images?.map(i => i.name)).toEqual([D, E, F]);
    expect(transport[6].images?.map(i => i.name)).toEqual([G, A]);
    for (const row of [transport[2], transport[4], transport[6]]) {
      for (const i of row.images ?? []) expect(i.filePath).toBe(join(uploadsDir(), i.name));
    }

    // Anthropic wire: exactly 6 image blocks, no empty text block.
    const wireJson = JSON.stringify(convertMessages(toParams(transport)));
    expect(wireJson.split('"type":"image"').length - 1).toBe(6);
    expect(wireJson).toContain(`[Image ${B} shown earlier in this conversation]`);
    expect(wireJson).not.toContain('{"type":"text","text":""}');

    // Gemini wire: exactly 6 inlineData parts, no {text:""}.
    const geminiJson = JSON.stringify(toGeminiContents(transport));
    expect(geminiJson.split('"inlineData"').length - 1).toBe(6);
    expect(geminiJson).not.toContain('"text":""');
  });

  it("an oversized history image is statted, never read: placeholder note instead of a 400-poisoning part", async () => {
    const big = "seedcap-big.png";
    writeFileSync(join(uploadsDir(), big), Buffer.alloc(REVIVED_HISTORY_IMAGE_MAX_BYTES + 1));
    seedOpMessages(
      opId,
      prepared([
        { role: "user", content: "", images: [{ name: big, url: `/uploads/${big}` }] } as unknown as ChatCompletionMessageParam,
        { role: "assistant", content: "ok" },
      ]),
      "and?",
    );
    const transport = await pipeline();
    expect(transport.map(m => m.role)).toEqual(["user", "assistant", "user"]);
    expect(transport[0].images).toBeUndefined();
    expect(transport[0].content).toBe(`[Image ${big} omitted from history: too large to resend]`);
    expect(JSON.stringify(convertMessages(toParams(transport)))).not.toContain('"type":"image"');
    expect(JSON.stringify(toGeminiContents(transport))).not.toContain("inlineData");
  });

  it("an empty user row with NO images is still dropped (the fix widens survival to image rows only)", async () => {
    seedOpMessages(
      opId,
      prepared([
        { role: "user", content: "" },
        { role: "assistant", content: "hello" },
      ]),
      "hi again",
    );
    const transport = await pipeline();
    expect(transport.map(m => m.role)).toEqual(["assistant", "user"]);
  });
});

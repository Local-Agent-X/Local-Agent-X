// Speaks one sentence through Microsoft's Edge Read-Aloud endpoint with the
// installed msedge-tts, the way the Edge Cloud voice does
// (src/voice/tier4/edge-tts-adapter.ts). Exits 1 when no audio comes back.
//
// The endpoint is unofficial: Microsoft periodically stops accepting the
// Sec-MS-GEC version token msedge-tts sends, and every Edge session then fails
// with a 403 (2026-11, fixed by msedge-tts 2.0.5 -> 2.1.1). Nothing else in the
// repo talks to the endpoint, so this is what notices.

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { readFileSync } from "node:fs";

const TIMEOUT_MS = 30_000;
const MIN_AUDIO_BYTES = 1_000;

const version = JSON.parse(
	readFileSync(new URL("../node_modules/msedge-tts/package.json", import.meta.url), "utf8"),
).version;

async function speak() {
	const tts = new MsEdgeTTS();
	try {
		await tts.setMetadata("en-US-AriaNeural", OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
		const { audioStream } = tts.toStream("Edge voice check.");
		let bytes = 0;
		for await (const chunk of audioStream) bytes += chunk.length;
		return bytes;
	} finally {
		tts.close();
	}
}

const timeout = new Promise((_, reject) =>
	setTimeout(() => reject(new Error(`no audio within ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS),
);

try {
	const bytes = await Promise.race([speak(), timeout]);
	if (bytes < MIN_AUDIO_BYTES) throw new Error(`only ${bytes} bytes of audio came back`);
	console.log(`OK: msedge-tts ${version} spoke ${bytes} bytes of audio`);
	process.exit(0);
} catch (e) {
	console.error(`FAIL: msedge-tts ${version}: ${e.message}`);
	console.error("If this is a 403, Microsoft changed the token it accepts: upgrade msedge-tts.");
	process.exit(1);
}

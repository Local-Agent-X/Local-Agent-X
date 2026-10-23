import { describe, it, expect } from "vitest";
import { scanNetworkPrimitiveUsers, type NetworkPrimitiveUser, type NetworkUse } from "./network-primitives.js";

// Every file under src/ that touches a network primitive itself (a socket
// module, a network client package, the global fetch), and why. Agent egress
// goes through the in-process transport (src/tools/web-egress.ts
// canonicalFetch), the browser's egress worker, the loopback proxy, or the
// mail send, and each of those calls the egress judge
// (docs/proposals/egress-consolidation.md). Everything else that reaches the
// network is listed here with the reason it is outside that boundary, grouped
// by where its traffic goes, so this file reads as the map of how traffic
// leaves the app. A new direct caller fails the build: route it through
// canonicalFetch, or register it with why. A path the agent can reach that
// should be judged and is not is registered under GAPS, its `why` starting
// "GAP:", until it is fixed.
//
// `uses` is what the scan sees (src/net/network-primitives.ts): `outbound`
// dials, `server` listens, `browser` loads the browser engine. A loopback or
// local-socket peer is still `outbound` to the scan; the section says local.

interface Registered {
  file: string;
  uses: readonly NetworkUse[];
  why: string;
}

/** Where the egress judge runs: the code that is the boundary. */
const ENFORCEMENT_POINTS: readonly Registered[] = [
  { file: "src/routes/connector-proxy.ts", uses: ["outbound"], why: "forwards an agent-built app's requests to the connector's pinned upstream; the URL and body head are judged at send (assertSendAllowed) before the dial" },
  { file: "src/browser/cdp-network.ts", uses: ["outbound"], why: "the response-body re-fetch: each hop passes the web-access policy and the send-time judge against the calling tool's session, redirects followed by hand" },
  { file: "src/auto-build/scenario-scorer/smoke.ts", uses: ["browser"], why: "the smoke and scenario-scorer Chromium routes every request an agent-built app makes through the send-time judge, before TLS" },
  { file: "src/tools/web-egress.ts", uses: ["outbound"], why: "canonicalFetch, the in-process transport: destination policy and DNS pinning on every hop, and the send-time judge (assertSendAllowed) on the bytes" },
  { file: "src/net/egress-proxy-core.ts", uses: ["outbound", "server"], why: "the loopback proxy, the caged shell's and sandboxed MCP servers' only route out: judges each request, then dials" },
  { file: "src/net/shell-egress-bridge.ts", uses: ["outbound", "server"], why: "relays a Linux cage's namespace to the proxy's loopback port (and sanctioned local-service ports) over a unix socket" },
  { file: "src/tools/email-send-tool.ts", uses: ["outbound"], why: "email_send: the composed message is judged by assertMailSendAllowed before nodemailer sends it" },
  { file: "src/browser/runtime.ts", uses: ["browser"], why: "launches the agent browser; its page traffic answers to the browser egress worker per request" },
  { file: "src/browser/electron-cdp.ts", uses: ["browser"], why: "attaches to the in-app browser over CDP; page traffic answers to the browser egress worker" },
  { file: "src/browser/windows-chat-chrome-runtime.ts", uses: ["browser"], why: "launches the per-session Chrome behind the browser egress proxy" },
];

/** The conversation goes to the user's chosen model by design. */
const MODEL_PROVIDERS: readonly Registered[] = [
  { file: "src/anthropic-client/stream-api.ts", uses: ["outbound"], why: "the Anthropic Messages API, the configured provider" },
  { file: "src/codex-client/fetch-once.ts", uses: ["outbound"], why: "the ChatGPT/Codex backend, the configured provider" },
  { file: "src/canonical-loop/adapters/gemini-native-transport.ts", uses: ["outbound"], why: "the Gemini API, the configured provider" },
  { file: "src/providers/adapters/openai-http.ts", uses: ["outbound"], why: "an OpenAI-compatible provider endpoint the user configured" },
  { file: "src/providers/adapters/ollama-native.ts", uses: ["outbound"], why: "the configured Ollama endpoint (local, or the user's Ollama Cloud)" },
  { file: "src/providers/model-catalog.ts", uses: ["outbound"], why: "lists a configured provider's models" },
  { file: "src/providers/ollama-capability-probe.ts", uses: ["outbound"], why: "asks the configured Ollama what a model supports" },
  { file: "src/providers/tool-capability-probe.ts", uses: ["outbound"], why: "probes a configured provider endpoint for tool-call support" },
  { file: "src/ollama-cloud.ts", uses: ["outbound"], why: "lists the user's Ollama Cloud models with their key" },
  { file: "src/llm-dispatch/hosted.ts", uses: ["outbound"], why: "side work (classifiers, summaries) on the configured hosted model" },
  { file: "src/llm-dispatch/ollama.ts", uses: ["outbound"], why: "side work on the configured Ollama" },
  { file: "src/memory/reranker.ts", uses: ["outbound"], why: "memory reranking on the configured Ollama" },
  { file: "src/embedding-providers/helpers.ts", uses: ["outbound"], why: "the configured embedding provider (retrying fetch its providers share)" },
  { file: "src/embedding-providers/ollama.ts", uses: ["outbound"], why: "embeddings from the configured Ollama" },
  { file: "src/doctor.ts", uses: ["outbound"], why: "Doctor checks a configured provider key against that provider" },
  { file: "src/startup-test.ts", uses: ["outbound"], why: "startup self-test: HEAD to the Anthropic and OpenAI API roots to report reachability" },
];

/** Speech: the voice engine and speech providers the user picked. */
const VOICE_PROVIDERS: readonly Registered[] = [
  { file: "src/voice/stt-providers/groq.ts", uses: ["outbound"], why: "speech-to-text on Groq, the configured STT provider" },
  { file: "src/voice/stt-providers/mistral.ts", uses: ["outbound"], why: "speech-to-text on Mistral, the configured STT provider" },
  { file: "src/voice/stt-providers/openai.ts", uses: ["outbound"], why: "speech-to-text on OpenAI, the configured STT provider" },
  { file: "src/voice/tts-xai.ts", uses: ["outbound"], why: "text-to-speech on xAI, the configured voice" },
  { file: "src/voice/realtime/openai-realtime-client.ts", uses: ["outbound"], why: "the OpenAI Realtime API, the configured voice mode" },
  { file: "src/voice/tier4/edge-tts-adapter.ts", uses: ["outbound"], why: "Microsoft's Edge read-aloud service, the configured TTS engine" },
];

/** Fixed URLs: model weights and SDKs fetched once into the data dir. */
const DOWNLOADS: readonly Registered[] = [
  { file: "src/voice/stt-model-fetch.ts", uses: ["outbound"], why: "downloads the speech-to-text model from its fixed release URL" },
  { file: "src/voice/tts-model-fetch.ts", uses: ["outbound"], why: "downloads the TTS bundle from its fixed release URL" },
  { file: "src/voice/vad-model-fetch.ts", uses: ["outbound"], why: "downloads the voice-activity model from its fixed URL" },
  { file: "src/voice/whisper-model-fetch.ts", uses: ["outbound"], why: "downloads the Whisper model from its fixed URL" },
  { file: "src/voice/tier4/kitten-engine.ts", uses: ["outbound"], why: "downloads a Kitten voice file from the model's Hugging Face repo" },
  { file: "src/voice/tier4/kokoro-engine.ts", uses: ["outbound"], why: "kokoro-js fetches the Kokoro weights from Hugging Face on first load" },
  { file: "src/android/sdk-installer.ts", uses: ["outbound"], why: "the Settings button's Android SDK install, from Google's fixed URL" },
];

/** The server's own fetch of its own releases. */
const UPDATES: readonly Registered[] = [
  { file: "src/update-service.ts", uses: ["outbound"], why: "the rolling runtime manifest" },
  { file: "src/ota-update.ts", uses: ["outbound"], why: "release assets and their checksums" },
  { file: "src/ota-rolling-pointer.ts", uses: ["outbound"], why: "the rolling channel's CI-built release pointer" },
];

/** Fixed destinations the user configured; replies go to the user. */
const ACCOUNT_PHONE_AND_CHANNELS: readonly Registered[] = [
  { file: "src/auth/index.ts", uses: ["outbound", "server"], why: "OpenAI (ChatGPT) OAuth: the token endpoint, and the loopback callback listener" },
  { file: "src/auth/anthropic.ts", uses: ["outbound"], why: "Anthropic OAuth token refresh" },
  { file: "src/auth/anthropic-login.ts", uses: ["outbound"], why: "Anthropic OAuth token exchange" },
  { file: "src/auth/xai.ts", uses: ["outbound"], why: "xAI OAuth discovery and refresh" },
  { file: "src/auth/xai-login.ts", uses: ["outbound", "server"], why: "xAI OAuth token exchange, and the loopback callback listener" },
  { file: "src/broker-transport/ws-socket-adapter.ts", uses: ["outbound"], why: "the phone link's broker connection" },
  { file: "src/broker-transport/vendor/account-api.ts", uses: ["outbound"], why: "the account API (device login, registration, pairing); vendored wire contract" },
  { file: "src/screen-stream/peer.ts", uses: ["outbound"], why: "WebRTC to the paired phone (screen stream), relayed through the broker's TURN" },
  { file: "src/voice/voice-peer.ts", uses: ["outbound"], why: "WebRTC to the paired phone (voice), relayed through the broker's TURN" },
  { file: "src/telegram-bridge/api.ts", uses: ["outbound"], why: "the Telegram Bot API; telegram_send is confined to the owner's authorized chats and judged at dispatch" },
  { file: "src/telegram-bridge/inbound.ts", uses: ["outbound"], why: "downloads an inbound voice note from Telegram's file endpoint" },
  { file: "src/whatsapp-bridge/index.ts", uses: ["outbound"], why: "the WhatsApp Web session; whatsapp_send is confined to the owner's authorized numbers and judged at dispatch" },
  { file: "src/whatsapp-bridge/message-handler.ts", uses: ["outbound"], why: "downloads inbound WhatsApp media" },
];

/** The user's own mail server, with the vault's mail credential. */
const MAIL: readonly Registered[] = [
  { file: "src/tools/email-imap-session.ts", uses: ["outbound"], why: "IMAP to the user's configured mail server (the email read and mailbox tools)" },
  { file: "src/tools/email-compose-tools.ts", uses: ["outbound"], why: "email_setup verifies the SMTP login, sending no message; the password's destination is approved by the secret-destination gate first" },
  { file: "src/routes/bridges/integrations.ts", uses: ["outbound"], why: "the Settings mail test: the same SMTP login email_send makes, to the host in email.json" },
];

/** Loopback to processes LAX starts or owns: local runtimes, sidecars, its
 *  own API, dev servers, and the self-tests that check them. */
const LOOPBACK: readonly Registered[] = [
  { file: "src/local-runtimes/certification-transport.ts", uses: ["outbound"], why: "certifies a local model runtime's chat endpoint" },
  { file: "src/local-runtimes/context-sizing.ts", uses: ["outbound"], why: "reads a local runtime's model context size" },
  { file: "src/local-runtimes/context-sizing-adapt.ts", uses: ["outbound"], why: "reads the local Ollama's loaded models" },
  { file: "src/local-runtimes/ollama-probe.ts", uses: ["outbound"], why: "probes the local Ollama" },
  { file: "src/local-runtimes/openai-compat-probe.ts", uses: ["outbound"], why: "probes a local OpenAI-compatible runtime" },
  { file: "src/local-runtimes/residency.ts", uses: ["outbound"], why: "reads which models the local Ollama holds in memory" },
  { file: "src/server/bootstrap-services.ts", uses: ["outbound"], why: "asks the local Ollama to pull the configured embedding model at boot" },
  { file: "src/server/bootstrap-bridges.ts", uses: ["outbound"], why: "the voice chat command calls this server's own voice-setup API" },
  { file: "src/voice/gpu-bridge.ts", uses: ["outbound"], why: "the local GPU voice sidecar's WebSocket" },
  { file: "src/voice/tts-sidecars.ts", uses: ["outbound"], why: "health of the local TTS sidecars" },
  { file: "src/voice/tier4/pocket-engine.ts", uses: ["outbound", "server"], why: "the local Pocket TTS sidecar: picks a free loopback port, then polls its health" },
  { file: "src/routes/bridges/voice-clones/sidecar-proxy.ts", uses: ["outbound"], why: "the local voice-clone sidecar's health" },
  { file: "src/routes/bridges/voice-setup/detection.ts", uses: ["outbound"], why: "detects the local voice sidecars" },
  { file: "src/routes/bridges/voice-setup/doctor.ts", uses: ["outbound"], why: "voice doctor: the local sidecars and the local voice WebSocket" },
  { file: "src/broker-transport/chat-loopback.ts", uses: ["outbound"], why: "the phone's chat, relayed to this server's own chat WebSocket" },
  { file: "src/broker-transport/http-tunnel-bridge.ts", uses: ["outbound"], why: "the phone's REST calls, relayed to this server's own loopback API under the device-path allowlist" },
  { file: "src/mcp-bridge.ts", uses: ["outbound"], why: "the MCP bridge calls this server's own API" },
  { file: "src/hooks/hook-engine.ts", uses: ["outbound"], why: "HTTP hooks: refuses any non-localhost URL by code" },
  { file: "src/server/dev-server-proxy.ts", uses: ["outbound"], why: "proxies an app's URL to its frontend dev server on loopback" },
  { file: "src/screen-stream/ffmpeg-capture.ts", uses: ["outbound"], why: "a UDP socket bound to 127.0.0.1 that receives ffmpeg's RTP; it sends nothing, but a datagram socket can, so the scan counts it" },
  { file: "src/browser/container-bridge-transport.ts", uses: ["outbound"], why: "the container's local-socket relay to the host browser bridge" },
  { file: "src/canonical-loop/adapters/app-build-smoke-gate.ts", uses: ["outbound"], why: "polls the built app's loopback dev server until it answers" },
  { file: "src/auto-build/scenario-scorer/app-launcher.ts", uses: ["outbound"], why: "polls the app under test on its loopback port" },
  { file: "src/self-edit/sandbox-gates.ts", uses: ["outbound"], why: "self_edit's boot gate: the sandbox server's loopback auth status" },
  { file: "src/self-edit/smoke-suite.ts", uses: ["outbound"], why: "self_edit's smoke suite against the sandbox server on loopback" },
  { file: "src/test-suite.ts", uses: ["outbound"], why: "`npm test`: drives this server's own API and WebSocket on loopback" },
  { file: "src/browser-availability.ts", uses: ["browser"], why: "asks Playwright where its Chromium is; launches nothing" },
  { file: "src/browser/test-browser-available.ts", uses: ["browser"], why: "test support: asks Playwright where its Chromium is; launches nothing" },
];

/** Inbound only: listeners, local IPC servers and port probes. */
const SERVERS: readonly Registered[] = [
  { file: "src/server/lifecycle.ts", uses: ["server"], why: "inbound server: the UI origin's HTTP server" },
  { file: "src/server/agent-origin.ts", uses: ["server"], why: "inbound server: the agent origin's loopback listener for workspace apps and files" },
  { file: "src/chat-ws/index.ts", uses: ["server"], why: "inbound server: the chat WebSocket upgrade" },
  { file: "src/voice/audio-ws.ts", uses: ["server"], why: "inbound server: the voice audio WebSocket upgrade" },
  { file: "src/canonical-loop/adapters/app-build-smoke-origin.ts", uses: ["server"], why: "inbound server: serves a built app on loopback for the smoke gate" },
  { file: "src/browser/egress-worker.ts", uses: ["server"], why: "local IPC: the browser egress worker's pipe, answering allow/deny asks" },
  { file: "src/browser/container-bridge-relay.ts", uses: ["server"], why: "local IPC: the host side of the container browser relay" },
  { file: "src/datadir-lock.ts", uses: ["outbound", "server"], why: "the single-instance lock: a loopback port per data dir, and the probe of its holder" },
  { file: "src/net/shell-proxy-ports.ts", uses: ["server"], why: "port probe: binds a candidate proxy port to test it is free" },
  { file: "src/self-edit/sandbox-naming.ts", uses: ["server"], why: "port probe: binds a loopback port to test it is free" },
  { file: "src/sandbox/win-cage.ts", uses: ["server"], why: "the Windows cage's fail-closed proof: a loopback listener the caged probe must not reach" },
];

/** Agent-reachable traffic that should answer to the egress judge and does
 *  not yet. Each is a finding, not a ruling. */
const GAPS: readonly Registered[] = [];

const SECTIONS: Record<string, readonly Registered[]> = {
  ENFORCEMENT_POINTS, MODEL_PROVIDERS, VOICE_PROVIDERS, DOWNLOADS, UPDATES,
  ACCOUNT_PHONE_AND_CHANNELS, MAIL, LOOPBACK, SERVERS, GAPS,
};
const REGISTRY: readonly Registered[] = Object.values(SECTIONS).flat();

const sameUses = (a: readonly NetworkUse[], b: readonly NetworkUse[]) => [...a].sort().join(",") === [...b].sort().join(",");

describe("every file that touches a network primitive is registered with why", () => {
  let found: NetworkPrimitiveUser[];

  // Reads every source file: ~2 s alone, but past the 15 s unit-test default on
  // a contended CI runner with the rest of the suite (ubuntu, 2026-10-23).
  it("scans the source tree", () => {
    found = scanNetworkPrimitiveUsers(process.cwd());
    expect(found.length).toBeGreaterThan(50);
  }, 120_000);

  it("a file the scan finds is registered", () => {
    const unregistered = found.filter((u) => !REGISTRY.some((r) => r.file === u.file)).map((u) => `${u.file}: ${u.evidence.join("; ")}`);
    expect(
      unregistered,
      "a new direct network caller: send agent-reachable traffic through canonicalFetch (src/tools/web-egress.ts) so the egress judge sees it; otherwise register the file above, in the section for where its traffic goes, with why",
    ).toEqual([]);
  });

  it("every registered file still uses a primitive", () => {
    const stale = REGISTRY.filter((r) => !found.some((u) => u.file === r.file)).map((r) => r.file);
    expect(stale, "the file no longer touches the network directly, or moved: drop or update its entry").toEqual([]);
  });

  it("a registered file's uses are what it declares", () => {
    const drift = REGISTRY.flatMap((r) => {
      const actual = found.find((u) => u.file === r.file);
      return actual && !sameUses(actual.uses, r.uses) ? [`${r.file}: declared [${r.uses.join(", ")}], scanned [${actual.uses.join(", ")}] (${actual.evidence.join("; ")})`] : [];
    });
    expect(drift, "a file started dialing, listening or driving the browser: re-check its why before updating its uses").toEqual([]);
  });

  it("each file is registered once, and only the GAPS section holds gaps", () => {
    const files = REGISTRY.map((r) => r.file);
    expect(files.filter((f, i) => files.indexOf(f) !== i), "registered twice").toEqual([]);
    const misfiled = Object.entries(SECTIONS).flatMap(([name, rows]) =>
      rows.filter((r) => r.why.startsWith("GAP:") !== (name === "GAPS")).map((r) => `${name}: ${r.file}`));
    expect(misfiled, "a GAP entry belongs in GAPS with a why starting \"GAP:\", and nothing else does").toEqual([]);
    expect(REGISTRY.filter((r) => r.why.trim().length < 20).map((r) => r.file), "every entry says why").toEqual([]);
  });
});

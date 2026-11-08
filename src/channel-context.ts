/**
 * Channel Context — the ONE source of truth for which communication surface a
 * turn arrived on, and what that surface can and cannot do.
 *
 * `ChannelId` is the canonical union; `ChannelKind` (agent-request/types.ts)
 * and `ChannelType` (session/router.ts) are aliases of it, so every layer —
 * session routing, output formatting, prompt grounding — agrees on one enum.
 *
 * `channelContextBlock` renders the per-turn grounding section telling the
 * model where the user is (desktop UI, AgentX phone app, voice call, Telegram,
 * …) and the surface's real limitations. Same rationale as the file-access
 * grounding block: without it the model guesses — assumes the user can see the
 * PC screen from their phone, sends tables to WhatsApp, reads markdown aloud.
 * Hard formatting numbers derive from CHANNEL_CONFIGS (channel-formatter.ts)
 * so the prompt and the output formatter can never disagree.
 */

import { harnessNotice } from "./context/system-prompt-builder.js";
import { getChannelConfig } from "./channel-formatter.js";

/** Every surface a turn can originate from. */
export type ChannelId =
  | "web"       // desktop app chat UI (browser/Electron)
  | "mobile"    // AgentX phone app over the broker link
  | "voice"     // live voice conversation (STT in, TTS out)
  | "telegram"
  | "whatsapp"
  | "cli"
  | "api"       // programmatic POST /api/chat client
  | "cron"      // scheduled mission — no user present
  | "agent";    // sub-agent lane — output consumed by another agent

const ALL_CHANNELS: readonly ChannelId[] = [
  "web", "mobile", "voice", "telegram", "whatsapp", "cli", "api", "cron", "agent",
];

/** Channels a client frame may claim as its origin. Only the broker bridge
 *  stamps frames today; everything else is inferred server-side, so a frame
 *  claiming e.g. "cron" is ignored rather than trusted. */
const FRAME_ORIGINS: ReadonlySet<ChannelId> = new Set<ChannelId>(["mobile"]);

/** Narrow an untrusted ws-frame `origin` value to a claimable channel. */
export function parseFrameOrigin(value: unknown): ChannelId | null {
  return typeof value === "string" && FRAME_ORIGINS.has(value as ChannelId)
    ? (value as ChannelId)
    : null;
}

/** The device a voice call runs on, known from the transport that carries it:
 *  the broker link is the phone app, the local voice socket is the desktop. */
export type VoiceDevice = "phone" | "desktop";

/** Human-readable surface names (UI labels, identity linking, prompt text). */
export const CHANNEL_DISPLAY_NAMES: Record<ChannelId, string> = {
  web: "Desktop app",
  mobile: "AgentX mobile app",
  voice: "Voice",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  cli: "CLI",
  api: "API",
  cron: "Scheduled job",
  agent: "Agent lane",
};

/** What the model needs to know about each surface beyond raw formatting
 *  limits: where the user physically is, and which UI affordances exist. */
const SURFACE_PROSE: Record<ChannelId, string> = {
  web:
    "The user is chatting from the desktop app on their computer. Full UI: markdown, code blocks, " +
    "tables, images, tool cards, and clickable approval cards all render. The user can see files and " +
    "apps on this machine directly.",
  mobile:
    "The user is on their PHONE in the AgentX mobile app, relayed to this desktop over the encrypted " +
    "broker link. They are typically AWAY from the desktop and CANNOT see its screen — describe what " +
    "happens on the PC instead of assuming they can watch it. The phone renders markdown, images, tool " +
    "cards, and approval cards, but the screen is narrow: keep replies compact and avoid wide tables or " +
    "long code dumps. Tools still run on the desktop; files you create live there, not on the phone. " +
    "When the user asks for a document from the PC (Word, Excel, PDF, …), call send_file — it stages the " +
    "file so a tappable card appears in their chat. \"My camera\" means the phone's camera: camera_capture " +
    "is the desktop's webcam, so to see something ask them to send a photo.",
  voice:
    "This is a live VOICE conversation: your reply is spoken aloud. Never use markdown, lists, tables, " +
    "code blocks, links, or emoji; keep answers short and conversational. Nothing visual reaches the " +
    "user except cards you show. There are no clickable approval cards: if an action needs approval, " +
    "say so and ask the user to approve it from the desktop or phone app.",
  telegram:
    "The user is messaging over Telegram, usually from their phone and away from the desktop — they " +
    "cannot see the PC screen. No clickable approval cards; actions needing approval must be confirmed " +
    "in words or from the desktop app.",
  whatsapp:
    "The user is messaging over WhatsApp, usually from their phone and away from the desktop — they " +
    "cannot see the PC screen. Formatting is minimal (*bold*, _italic_); no code blocks, tables, or " +
    "approval cards. Actions needing approval must be confirmed in words or from the desktop app.",
  cli:
    "The user is in a plain-text terminal. No markdown rendering, images, or approval cards — plain " +
    "text only.",
  api:
    "This turn came from a programmatic API client. Assume no human is watching a rendered UI; respond " +
    "with clean, self-contained text and do not depend on interactive approval cards.",
  cron:
    "This is a SCHEDULED autonomous run — no user is present and nobody can answer questions or click " +
    "approvals. Be decisive, complete the mission, and put results where the job's delivery channel " +
    "expects them.",
  agent:
    "This output is consumed by another agent, not rendered to the user. Return substance without " +
    "conversational padding.",
};

/** Where a voice call's user is, and whose camera "my camera" is. A phone call
 *  carries the phone camera's frame with the user's words while they have it
 *  open (voice/voice-session/utterance-media.ts). */
const VOICE_DEVICE_PROSE: Record<VoiceDevice, string> = {
  phone:
    " The call is from the AgentX PHONE app: the user is on their phone, typically away from the " +
    "desktop, and cannot see its screen. \"My camera\" means the phone's camera: while they have it " +
    "open on the call, its picture arrives with their words. If no picture came with their words, ask " +
    "them to turn the camera on in the call. camera_capture is the desktop's webcam, not theirs.",
  desktop:
    " The call is in the desktop app: the user is at this computer, so camera_capture is their webcam " +
    "and screen_capture shows what they see.",
};

/** One line of hard limits derived from the formatter's config table. */
function formattingLine(channel: ChannelId): string {
  const config = getChannelConfig(channel);
  const parts: string[] = [];
  if (config.maxTextLength !== Infinity) parts.push(`Hard message limit: ${config.maxTextLength} characters — long answers are split.`);
  if (config.markdownFlavor === "plain") parts.push("Plain text only.");
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/**
 * The per-turn grounding block for the system prompt. Pure + exported for
 * testing; every ChannelId renders a non-empty block. A voice turn names the
 * device its call runs on when the caller knows it.
 */
export function channelContextBlock(channel: ChannelId, voiceDevice?: VoiceDevice): string {
  const name = CHANNEL_DISPLAY_NAMES[channel];
  const prose = SURFACE_PROSE[channel];
  const device = channel === "voice" && voiceDevice ? VOICE_DEVICE_PROSE[voiceDevice] : "";
  return harnessNotice(
    "CHANNEL",
    `Surface: ${name}. ${prose}${device}${formattingLine(channel)}`,
  );
}

/** Exported for exhaustiveness tests. */
export function allChannels(): readonly ChannelId[] {
  return ALL_CHANNELS;
}

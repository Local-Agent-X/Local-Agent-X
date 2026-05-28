/**
 * Communication Protocol Pack — email, Slack, Discord, WhatsApp protocols.
 */

import type { Protocol } from "../../protocols/index.js";

export const emailMission: Protocol = {
  name: "send_email",
  description: "Compose and send an email with proper formatting, attachments, and follow-up tracking.",
  triggers: ["send email", "email", "compose email", "write an email", "send a message via email"],
  learnablePreferences: ["email_provider", "email_signature", "default_tone", "cc_defaults"],
  rules: [
    "Always show the complete draft before sending.",
    "Match tone to context: formal for business, casual for personal.",
    "Check recipient address carefully — suggest corrections for typos.",
    "Include a clear subject line that summarizes the email purpose.",
    "Warn if attachments are mentioned in the body but none are attached.",
    "Never send without explicit user confirmation.",
  ],
  steps: [
    { id: "gather", instruction: "Collect: recipient(s), subject, body content, tone, and attachments." },
    { id: "draft", instruction: "Compose the email with appropriate formatting and signature." },
    { id: "review", instruction: "Present the full draft including To, CC, Subject, Body. Get approval.", requiresUserAction: true },
    { id: "open_client", instruction: "Navigate to the email provider (Gmail, Outlook, etc.)." },
    { id: "compose", instruction: "Open new email compose window. Fill in all fields." },
    { id: "attach", instruction: "Attach files if any. Guide user for file picker.", requiresUserAction: true },
    { id: "send", instruction: "Click Send. Verify the email was sent.", validate: "Sent confirmation visible" },
  ],
};

export const slackMission: Protocol = {
  name: "send_slack",
  description: "Send messages on Slack: DMs, channels, threads, with formatting and reactions.",
  triggers: ["send slack", "slack message", "message on slack", "post in slack", "dm on slack"],
  learnablePreferences: ["slack_workspace", "default_channel", "message_style_slack"],
  rules: [
    "Identify target: DM, channel, or thread reply.",
    "Use Slack markdown formatting (bold, code blocks, links).",
    "For threads: find the parent message first.",
    "Check if the channel exists and you have access.",
    "Keep messages concise — Slack is for quick communication.",
  ],
  steps: [
    { id: "gather", instruction: "Collect: recipient/channel, message content, thread context if applicable." },
    { id: "draft", instruction: "Format the message with Slack markdown." },
    { id: "review", instruction: "Show the formatted message. Get approval.", requiresUserAction: true },
    { id: "open_slack", instruction: "Navigate to Slack (web or app). Find the target channel/DM." },
    { id: "send", instruction: "Send the message. Verify it appeared." },
    { id: "confirm", instruction: "Confirm message sent. Note if any reactions/threads should be monitored." },
  ],
};

export const discordMission: Protocol = {
  name: "send_discord",
  description: "Send messages on Discord: servers, channels, DMs, with embeds and reactions.",
  triggers: ["send discord", "discord message", "post on discord", "dm on discord", "message discord"],
  learnablePreferences: ["discord_server", "default_discord_channel", "message_style_discord"],
  rules: [
    "Identify server and channel, or DM recipient.",
    "Use Discord markdown (similar to Slack but with some differences).",
    "For embeds: use proper embed formatting.",
    "Respect channel topics — post in the right channel.",
    "Check character limit: 2000 per message, 4096 for embed descriptions.",
  ],
  steps: [
    { id: "gather", instruction: "Collect: server/channel or DM target, message content, embed preferences." },
    { id: "draft", instruction: "Format the message with Discord markdown." },
    { id: "review", instruction: "Show the formatted message. Get approval.", requiresUserAction: true },
    { id: "open_discord", instruction: "Navigate to Discord (web). Find the target channel." },
    { id: "send", instruction: "Send the message. Verify it appeared." },
    { id: "confirm", instruction: "Confirm message delivered." },
  ],
};

export const whatsappMission: Protocol = {
  name: "send_whatsapp",
  description: "Send WhatsApp messages: text, media, voice notes via WhatsApp Web.",
  triggers: ["send whatsapp", "whatsapp message", "message on whatsapp", "text on whatsapp"],
  learnablePreferences: ["whatsapp_contacts", "message_style_whatsapp"],
  rules: [
    "WhatsApp Web must be linked to the user's phone.",
    "If WhatsApp Web shows QR code, guide user to scan it.",
    "Search for contacts by name — verify the right contact before sending.",
    "For media: guide user through the attachment picker.",
    "WhatsApp formatting: *bold*, _italic_, ~strikethrough~, ```code```.",
    "Never send without user confirmation — messages can't be unsent after a few minutes.",
  ],
  steps: [
    { id: "gather", instruction: "Collect: recipient name/number, message content, media if any." },
    { id: "draft", instruction: "Format the message with WhatsApp formatting." },
    { id: "review", instruction: "Show the formatted message. Get approval.", requiresUserAction: true },
    { id: "open_whatsapp", instruction: "Navigate to web.whatsapp.com. Verify connected." },
    { id: "find_contact", instruction: "Search for the contact. Verify it's the right person.", validate: "Correct contact selected" },
    { id: "send", instruction: "Type and send the message. Attach media if needed." },
    { id: "confirm", instruction: "Verify message delivered (single check → double check → blue check)." },
  ],
};

export const communicationProtocols: Protocol[] = [
  emailMission,
  slackMission,
  discordMission,
  whatsappMission,
];

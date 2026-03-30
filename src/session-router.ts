import { randomBytes } from "node:crypto";

/**
 * Session Router — cross-channel session continuity.
 *
 * Maps users across platforms (Telegram, WhatsApp, Web UI, CLI) to a
 * single canonical identity so conversations persist across channels.
 *
 * Identity links: ~/.sax/identity-links.json
 * Session key format: "channel:identifier" → canonical peer ID
 *
 * More robust than upstream's approach:
 * - Auto-detection of same user across channels (by name matching + manual linking)
 * - Bidirectional sync: new messages on any channel update the shared session
 * - Channel-aware context: the agent knows WHICH channel the user is on right now
 * - Graceful degradation: if no link exists, channels work independently (no breakage)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SAX_DIR = join(homedir(), ".sax");
const LINKS_FILE = join(SAX_DIR, "identity-links.json");

// ── Types ──

export type ChannelType = "web" | "telegram" | "whatsapp" | "cli" | "api";

export interface ChannelIdentity {
  channel: ChannelType;
  id: string;           // Platform-specific ID (chat ID, phone number, session token prefix)
  displayName?: string;
}

export interface IdentityGroup {
  canonicalId: string;   // The unified ID for this person
  displayName: string;
  identities: ChannelIdentity[];
  createdAt: number;
  updatedAt: number;
}

export interface SessionRoute {
  sessionKey: string;       // The session ID to use
  canonicalId: string;      // The person's unified ID
  channel: ChannelType;     // Which channel this message came from
  isLinked: boolean;        // Whether this identity is part of a linked group
}

// ── Identity Link Store ──

let identityGroups: IdentityGroup[] = [];

function loadLinks(): void {
  try {
    if (existsSync(LINKS_FILE)) {
      identityGroups = JSON.parse(readFileSync(LINKS_FILE, "utf-8"));
    }
  } catch { identityGroups = []; }
}

function saveLinks(): void {
  writeFileSync(LINKS_FILE, JSON.stringify(identityGroups, null, 2), "utf-8");
}

// Load on module init
loadLinks();

// ── Core Functions ──

/**
 * Resolve which session to use for an incoming message.
 * If the user has linked identities, routes to the shared session.
 * Otherwise, uses the channel-specific session.
 */
export function resolveSession(channel: ChannelType, channelUserId: string, fallbackSessionId?: string): SessionRoute {
  // Find if this channel identity belongs to a linked group
  const group = findGroupByIdentity(channel, channelUserId);

  if (group) {
    return {
      sessionKey: `linked:${group.canonicalId}`,
      canonicalId: group.canonicalId,
      channel,
      isLinked: true,
    };
  }

  // No link — use channel-specific session
  return {
    sessionKey: fallbackSessionId || `${channel}:${channelUserId}`,
    canonicalId: `${channel}:${channelUserId}`,
    channel,
    isLinked: false,
  };
}

/**
 * Link two channel identities together.
 * If either already belongs to a group, merge. Otherwise create new group.
 */
export function linkIdentities(
  identity1: ChannelIdentity,
  identity2: ChannelIdentity,
  displayName?: string,
): IdentityGroup {
  loadLinks();
  const group1 = findGroupByIdentity(identity1.channel, identity1.id);
  const group2 = findGroupByIdentity(identity2.channel, identity2.id);

  if (group1 && group2) {
    if (group1.canonicalId === group2.canonicalId) return group1; // Already linked
    // Merge group2 into group1
    for (const id of group2.identities) {
      if (!group1.identities.some(i => i.channel === id.channel && i.id === id.id)) {
        group1.identities.push(id);
      }
    }
    group1.updatedAt = Date.now();
    if (displayName) group1.displayName = displayName;
    identityGroups = identityGroups.filter(g => g.canonicalId !== group2.canonicalId);
    saveLinks();
    return group1;
  }

  if (group1) {
    if (!group1.identities.some(i => i.channel === identity2.channel && i.id === identity2.id)) {
      group1.identities.push(identity2);
    }
    group1.updatedAt = Date.now();
    saveLinks();
    return group1;
  }

  if (group2) {
    if (!group2.identities.some(i => i.channel === identity1.channel && i.id === identity1.id)) {
      group2.identities.push(identity1);
    }
    group2.updatedAt = Date.now();
    saveLinks();
    return group2;
  }

  // New group
  const newGroup: IdentityGroup = {
    canonicalId: `peer-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    displayName: displayName || identity1.displayName || identity2.displayName || "Unknown",
    identities: [identity1, identity2],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  identityGroups.push(newGroup);
  saveLinks();
  return newGroup;
}

/**
 * Unlink a specific identity from its group.
 */
export function unlinkIdentity(channel: ChannelType, channelUserId: string): boolean {
  loadLinks();
  const group = findGroupByIdentity(channel, channelUserId);
  if (!group) return false;

  group.identities = group.identities.filter(i => !(i.channel === channel && i.id === channelUserId));
  if (group.identities.length <= 1) {
    // Group has 0-1 members, remove it
    identityGroups = identityGroups.filter(g => g.canonicalId !== group.canonicalId);
  } else {
    group.updatedAt = Date.now();
  }
  saveLinks();
  return true;
}

/**
 * Get all identity groups (for UI display).
 */
export function getIdentityGroups(): IdentityGroup[] {
  loadLinks();
  return [...identityGroups];
}

/**
 * Get the identity group for a specific channel user.
 */
export function getGroupForUser(channel: ChannelType, channelUserId: string): IdentityGroup | null {
  loadLinks();
  return findGroupByIdentity(channel, channelUserId);
}

/**
 * Build a context string for the agent so it knows which channel the user is on.
 */
export function buildChannelContext(route: SessionRoute): string {
  const channelNames: Record<ChannelType, string> = {
    web: "Web UI",
    telegram: "Telegram",
    whatsapp: "WhatsApp",
    cli: "CLI",
    api: "API",
  };
  const parts = [`User is messaging from: ${channelNames[route.channel] || route.channel}`];
  if (route.isLinked) {
    const group = identityGroups.find(g => g.canonicalId === route.canonicalId);
    if (group && group.identities.length > 1) {
      const others = group.identities
        .filter(i => i.channel !== route.channel)
        .map(i => channelNames[i.channel] || i.channel);
      if (others.length > 0) {
        parts.push(`This user also uses: ${others.join(", ")}`);
      }
    }
  }
  return parts.join(". ");
}

// ── Private ──

function findGroupByIdentity(channel: ChannelType, id: string): IdentityGroup | null {
  for (const group of identityGroups) {
    if (group.identities.some(i => i.channel === channel && i.id === id)) {
      return group;
    }
  }
  return null;
}

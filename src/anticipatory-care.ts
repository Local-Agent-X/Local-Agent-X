/**
 * Anticipatory Care — remember what's coming and follow up.
 *
 * Tracks mentions of future events (meetings, deadlines, trips), then
 * generates natural follow-up messages after those events pass. Knows
 * when to ask "how did it go?" without being prompted.
 *
 * Persists to ~/.sax/upcoming-events.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ── Types ────────────────────────────────────────────────────

export interface UpcomingEvent {
  id: string;
  event: string;
  date: string;
  importance: "low" | "medium" | "high";
  detectedAt: number;
  sessionId: string;
  followedUp: boolean;
}

export interface FollowUp {
  event: UpcomingEvent;
  suggestedMessage: string;
  daysSinceEvent: number;
}

interface EventStore {
  events: UpcomingEvent[];
}

// ── Persistence ─────────────────────────────────────────────

const SAX_DIR = join(homedir(), ".sax");
const STORE_FILE = join(SAX_DIR, "upcoming-events.json");
const MAX_EVENTS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

function ensureDir(): void {
  if (!existsSync(SAX_DIR)) mkdirSync(SAX_DIR, { recursive: true });
}

function atomicWrite(path: string, data: string): void {
  const tmp = path + ".tmp." + randomBytes(4).toString("hex");
  try {
    writeFileSync(tmp, data, "utf-8");
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

function loadStore(): EventStore {
  if (!existsSync(STORE_FILE)) return { events: [] };
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { events: Array.isArray(parsed.events) ? parsed.events : [] };
  } catch {
    return { events: [] };
  }
}

function saveStore(store: EventStore): void {
  ensureDir();
  if (store.events.length > MAX_EVENTS) {
    // Keep most recent events
    store.events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    store.events = store.events.slice(0, MAX_EVENTS);
  }
  atomicWrite(STORE_FILE, JSON.stringify(store, null, 2));
}

function generateId(): string {
  return randomBytes(8).toString("hex");
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseDate(dateStr: string): number {
  return new Date(dateStr).getTime();
}

// ── Date parsing helpers ────────────────────────────────────

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function resolveRelativeDate(text: string): string | null {
  const lower = text.toLowerCase();
  const now = new Date();

  if (lower.includes("tomorrow")) {
    const d = new Date(now.getTime() + DAY_MS);
    return d.toISOString().slice(0, 10);
  }

  if (lower.includes("today")) {
    return now.toISOString().slice(0, 10);
  }

  // "next week"
  if (lower.includes("next week")) {
    const d = new Date(now.getTime() + 7 * DAY_MS);
    return d.toISOString().slice(0, 10);
  }

  // "next month"
  if (lower.includes("next month")) {
    const d = new Date(now);
    d.setMonth(d.getMonth() + 1);
    return d.toISOString().slice(0, 10);
  }

  // "this friday", "next tuesday", etc.
  for (let i = 0; i < DAY_NAMES.length; i++) {
    const dayName = DAY_NAMES[i];
    if (lower.includes(dayName) || lower.includes(dayName.slice(0, 3))) {
      const currentDay = now.getDay();
      let daysAhead = i - currentDay;
      if (daysAhead <= 0) daysAhead += 7;
      if (lower.includes("next") && daysAhead < 7) daysAhead += 7;
      const d = new Date(now.getTime() + daysAhead * DAY_MS);
      return d.toISOString().slice(0, 10);
    }
  }

  // "in X days"
  const inDaysMatch = lower.match(/in\s+(\d+)\s+days?/);
  if (inDaysMatch) {
    const days = parseInt(inDaysMatch[1], 10);
    const d = new Date(now.getTime() + days * DAY_MS);
    return d.toISOString().slice(0, 10);
  }

  // "in X weeks"
  const inWeeksMatch = lower.match(/in\s+(\d+)\s+weeks?/);
  if (inWeeksMatch) {
    const weeks = parseInt(inWeeksMatch[1], 10);
    const d = new Date(now.getTime() + weeks * 7 * DAY_MS);
    return d.toISOString().slice(0, 10);
  }

  return null;
}

function guessImportance(text: string): "low" | "medium" | "high" {
  const lower = text.toLowerCase();
  const highWords = [
    "deadline", "final", "important", "critical", "big", "major",
    "presentation", "interview", "exam", "surgery", "wedding",
    "launch", "demo", "court", "closing",
  ];
  const lowWords = [
    "maybe", "might", "probably", "thinking about", "casual",
    "coffee", "lunch", "errands",
  ];

  for (const w of highWords) {
    if (lower.includes(w)) return "high";
  }
  for (const w of lowWords) {
    if (lower.includes(w)) return "low";
  }
  return "medium";
}

// ── Event detection patterns ────────────────────────────────

const EVENT_PATTERNS: { pattern: RegExp; eventExtractor: (match: RegExpMatchArray) => string }[] = [
  {
    pattern: /(?:i have|i've got|got)\s+(?:a|an|my)\s+(.+?)(?:\s+(?:tomorrow|today|on|next|this|at|in\s+\d))/i,
    eventExtractor: (m) => m[1].trim(),
  },
  {
    pattern: /(?:my|the)\s+(.+?)\s+is\s+(?:tomorrow|today|on|next|this)/i,
    eventExtractor: (m) => m[1].trim(),
  },
  {
    pattern: /(?:deadline|due date)\s+(?:is\s+)?(?:on\s+)?(.+)/i,
    eventExtractor: () => "deadline",
  },
  {
    pattern: /(?:flying|traveling|going|driving|heading)\s+to\s+(.+?)(?:\s+(?:tomorrow|today|next|this|on|in\s+\d)|$)/i,
    eventExtractor: (m) => `trip to ${m[1].trim()}`,
  },
  {
    pattern: /(?:meeting|call|appointment)\s+(?:with\s+)?(.+?)(?:\s+(?:tomorrow|today|next|this|on|at)|$)/i,
    eventExtractor: (m) => `meeting with ${m[1].trim()}`,
  },
];

// ── AnticipatoryCare ────────────────────────────────────────

export class AnticipatoryCare {
  private static instance: AnticipatoryCare | null = null;

  private constructor() {}

  static getInstance(): AnticipatoryCare {
    if (!AnticipatoryCare.instance) {
      AnticipatoryCare.instance = new AnticipatoryCare();
    }
    return AnticipatoryCare.instance;
  }

  /**
   * Record a known upcoming event.
   */
  recordUpcomingEvent(event: string, date: string, importance: "low" | "medium" | "high", sessionId?: string): void {
    const store = loadStore();

    // Avoid duplicates
    const isDupe = store.events.some(
      (e) => e.event.toLowerCase() === event.toLowerCase() && e.date === date
    );
    if (isDupe) return;

    store.events.push({
      id: generateId(),
      event,
      date,
      importance,
      detectedAt: Date.now(),
      sessionId: sessionId || "unknown",
      followedUp: false,
    });

    saveStore(store);
  }

  /**
   * Get events that have passed and haven't been followed up on.
   */
  getFollowUps(): FollowUp[] {
    const store = loadStore();
    const now = Date.now();
    const followUps: FollowUp[] = [];

    for (const event of store.events) {
      if (event.followedUp) continue;

      const eventTime = parseDate(event.date);
      if (isNaN(eventTime)) continue;
      if (eventTime > now) continue; // hasn't happened yet

      const daysSince = Math.floor((now - eventTime) / DAY_MS);

      // Only follow up within 7 days of the event
      if (daysSince > 7) continue;

      const suggestion = this.buildFollowUpMessage(event, daysSince);

      followUps.push({
        event,
        suggestedMessage: suggestion,
        daysSinceEvent: daysSince,
      });
    }

    // Sort: high importance first, then most recent
    const impOrder = { high: 0, medium: 1, low: 2 };
    followUps.sort((a, b) => {
      const impDiff = impOrder[a.event.importance] - impOrder[b.event.importance];
      if (impDiff !== 0) return impDiff;
      return a.daysSinceEvent - b.daysSinceEvent;
    });

    return followUps;
  }

  /**
   * Get events in the next N days.
   */
  getUpcoming(days: number = 7): UpcomingEvent[] {
    const store = loadStore();
    const now = Date.now();
    const cutoff = now + days * DAY_MS;

    return store.events
      .filter((e) => {
        const t = parseDate(e.date);
        return !isNaN(t) && t >= now && t <= cutoff;
      })
      .sort((a, b) => parseDate(a.date) - parseDate(b.date));
  }

  /**
   * Generate a natural check-in message for high-importance events.
   * Only for events that have passed, only once.
   */
  getProactiveMessage(currentTime: number): string | null {
    const store = loadStore();

    for (const event of store.events) {
      if (event.followedUp) continue;
      if (event.importance !== "high") continue;

      const eventTime = parseDate(event.date);
      if (isNaN(eventTime)) continue;
      if (eventTime > currentTime) continue;

      const daysSince = Math.floor((currentTime - eventTime) / DAY_MS);
      if (daysSince > 3) continue; // Only proactive for 3 days

      return this.buildFollowUpMessage(event, daysSince);
    }

    return null;
  }

  /**
   * Auto-detect upcoming events from a message.
   */
  autoDetectEvent(message: string, sessionId?: string): UpcomingEvent | null {
    const lower = message.toLowerCase();

    // Try each pattern
    for (const { pattern, eventExtractor } of EVENT_PATTERNS) {
      const match = message.match(pattern);
      if (match) {
        const eventName = eventExtractor(match);
        const date = resolveRelativeDate(message);

        if (date && eventName.length > 1 && eventName.length < 100) {
          const importance = guessImportance(message);
          const ev: UpcomingEvent = {
            id: generateId(),
            event: eventName,
            date,
            importance,
            detectedAt: Date.now(),
            sessionId: sessionId || "unknown",
            followedUp: false,
          };

          // Auto-save
          const store = loadStore();
          const isDupe = store.events.some(
            (e) => e.event.toLowerCase() === eventName.toLowerCase() && e.date === date
          );
          if (!isDupe) {
            store.events.push(ev);
            saveStore(store);
          }

          return ev;
        }
      }
    }

    // Fallback: check for date signals without structured patterns
    const date = resolveRelativeDate(message);
    if (date) {
      // Look for event-ish nouns
      const eventWords = ["meeting", "deadline", "appointment", "interview", "presentation",
        "exam", "test", "flight", "trip", "call", "demo", "launch", "party", "dinner"];
      for (const word of eventWords) {
        if (lower.includes(word)) {
          const importance = guessImportance(message);
          const ev: UpcomingEvent = {
            id: generateId(),
            event: word,
            date,
            importance,
            detectedAt: Date.now(),
            sessionId: sessionId || "unknown",
            followedUp: false,
          };

          const store = loadStore();
          const isDupe = store.events.some(
            (e) => e.event.toLowerCase() === word && e.date === date
          );
          if (!isDupe) {
            store.events.push(ev);
            saveStore(store);
          }

          return ev;
        }
      }
    }

    return null;
  }

  /**
   * Mark an event as followed up.
   */
  markFollowedUp(eventId: string): void {
    const store = loadStore();
    const event = store.events.find((e) => e.id === eventId);
    if (event) {
      event.followedUp = true;
      saveStore(store);
    }
  }

  // ── Private helpers ─────────────────────────────────────────

  private buildFollowUpMessage(event: UpcomingEvent, daysSince: number): string {
    const name = event.event;

    if (daysSince === 0) {
      return `Hey, you had that ${name} today — how'd it go?`;
    } else if (daysSince === 1) {
      return `How did the ${name} go yesterday?`;
    } else {
      return `You had that ${name} ${daysSince} days ago — how'd it turn out?`;
    }
  }
}

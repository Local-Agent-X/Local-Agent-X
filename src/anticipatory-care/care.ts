import type { UpcomingEvent, FollowUp } from "./types.js";
import { loadStore, saveStore, generateId, parseDate, DAY_MS } from "./persistence.js";
import { resolveRelativeDate } from "./date-parser.js";
import { EVENT_PATTERNS, guessImportance } from "./detection.js";

export class AnticipatoryCare {
  private static instance: AnticipatoryCare | null = null;

  private constructor() {}

  static getInstance(): AnticipatoryCare {
    if (!AnticipatoryCare.instance) {
      AnticipatoryCare.instance = new AnticipatoryCare();
    }
    return AnticipatoryCare.instance;
  }

  recordUpcomingEvent(event: string, date: string, importance: "low" | "medium" | "high", sessionId?: string): void {
    const store = loadStore();

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

  getFollowUps(): FollowUp[] {
    const store = loadStore();
    const now = Date.now();
    const followUps: FollowUp[] = [];

    for (const event of store.events) {
      if (event.followedUp) continue;

      const eventTime = parseDate(event.date);
      if (isNaN(eventTime)) continue;
      if (eventTime > now) continue;

      const daysSince = Math.floor((now - eventTime) / DAY_MS);

      if (daysSince > 7) continue;

      const suggestion = this.buildFollowUpMessage(event, daysSince);

      followUps.push({
        event,
        suggestedMessage: suggestion,
        daysSinceEvent: daysSince,
      });
    }

    const impOrder = { high: 0, medium: 1, low: 2 };
    followUps.sort((a, b) => {
      const impDiff = impOrder[a.event.importance] - impOrder[b.event.importance];
      if (impDiff !== 0) return impDiff;
      return a.daysSinceEvent - b.daysSinceEvent;
    });

    return followUps;
  }

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

  getProactiveMessage(currentTime: number): string | null {
    const store = loadStore();

    for (const event of store.events) {
      if (event.followedUp) continue;
      if (event.importance !== "high") continue;

      const eventTime = parseDate(event.date);
      if (isNaN(eventTime)) continue;
      if (eventTime > currentTime) continue;

      const daysSince = Math.floor((currentTime - eventTime) / DAY_MS);
      if (daysSince > 3) continue;

      return this.buildFollowUpMessage(event, daysSince);
    }

    return null;
  }

  autoDetectEvent(message: string, sessionId?: string): UpcomingEvent | null {
    const lower = message.toLowerCase();

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

    const date = resolveRelativeDate(message);
    if (date) {
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

  markFollowedUp(eventId: string): void {
    const store = loadStore();
    const event = store.events.find((e) => e.id === eventId);
    if (event) {
      event.followedUp = true;
      saveStore(store);
    }
  }

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

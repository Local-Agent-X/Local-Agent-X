/**
 * Anticipatory Care — remember what's coming and follow up.
 *
 * Tracks mentions of future events (meetings, deadlines, trips), then
 * generates natural follow-up messages after those events pass. Knows
 * when to ask "how did it go?" without being prompted.
 *
 * Persists to ~/.lax/upcoming-events.json.
 */

export type { UpcomingEvent, FollowUp } from "./types.js";
export { AnticipatoryCare } from "./care.js";

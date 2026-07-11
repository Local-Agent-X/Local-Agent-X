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

// Type alias (not interface) so it satisfies json-store's Record constraint.
export type EventStore = {
  events: UpcomingEvent[];
};

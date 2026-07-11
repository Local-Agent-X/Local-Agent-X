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

export interface EventStore {
  events: UpcomingEvent[];
}

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

/** Extract any active todo/task list from recent messages */
export function extractTaskState(messages: ChatCompletionMessageParam[]): string {
  const taskPatterns = [
    /(?:todo|task|checklist|plan|steps?)[\s:]*\n([\s\S]*?)(?:\n\n|\n(?=[A-Z]))/gi,
    /(?:working on|currently|in progress|next up)[\s:]+(.+)/gi,
    /\[(?:in_progress|pending|completed)\]\s+(.+)/gi,
  ];

  const tasks: string[] = [];

  // Check last 10 messages for task state
  for (const msg of messages.slice(-10)) {
    const content = typeof msg.content === "string" ? msg.content : "";
    for (const pattern of taskPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        tasks.push(match[0].trim());
      }
    }
  }

  return tasks.length > 0 ? `\nActive tasks/todo:\n${tasks.join("\n")}` : "";
}

/** Extract key facts and decisions from the conversation */
export function extractKeyFacts(messages: ChatCompletionMessageParam[]): string[] {
  const facts: string[] = [];
  const patterns = [
    /(?:decided|agreed|confirmed|will|should|must|need to)\s+(.{10,80})/gi,
    /(?:the user wants|user asked|user said|user prefers)\s+(.{10,80})/gi,
    /(?:important|note|remember|key point)[\s:]+(.{10,80})/gi,
  ];

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        facts.push(match[0].trim());
        if (facts.length >= 15) break; // Cap at 15 facts
      }
    }
  }

  return [...new Set(facts)]; // Deduplicate
}

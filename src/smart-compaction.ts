/**
 * Token-budget aware conversation compaction.
 * Replaces the basic conversation-compactor with smarter topic-clustered
 * summarisation, budget tracking, and selective preservation.
 */

// ── Types ──

interface Message {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
  tool_call_id?: string;
  tool_calls?: Array<{ function?: { name?: string } }>;
  name?: string;
  timestamp?: number;
}

export interface ContextBudget {
  total: number;
  used: number;
  remaining: number;
  percentage: number;
  overflowing: boolean;
}

export interface ClusterInfo {
  topic: string;
  messageCount: number;
  summary: string;
}

export interface CompactionResult {
  messages: Message[];
  removedCount: number;
  originalTokens: number;
  compactedTokens: number;
  savedTokens: number;
  clusters: ClusterInfo[];
}

export interface SmartCompactorOptions {
  maxTokens: number;
  targetTokens: number;
  model?: string;
  preserveSystemMessages: boolean;
  preserveToolResults: boolean;
  preserveUserInstructions: boolean;
}

interface CompactCallOptions {
  keepRecent?: number;
  clusterWindowMs?: number;
}

// ── Helpers ──

function extractText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!)
      .join(" ");
  }
  return "";
}

const INSTRUCTION_PATTERNS = [
  /always\s+/i,
  /never\s+/i,
  /make\s+sure\s+/i,
  /don'?t\s+/i,
  /do\s+not\s+/i,
  /remember\s+/i,
  /from\s+now\s+on/i,
  /going\s+forward/i,
  /keep\s+in\s+mind/i,
  /preference[s]?\s*:/i,
  /rule[s]?\s*:/i,
];

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been",
  "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "can", "shall", "to", "of",
  "in", "for", "on", "with", "at", "by", "from", "it", "this",
  "that", "and", "or", "but", "not", "no", "so", "if", "then",
  "than", "too", "very", "just", "about", "up", "out", "all",
  "what", "which", "who", "whom", "how", "when", "where", "why",
  "i", "me", "my", "we", "us", "our", "you", "your", "he",
  "she", "they", "them", "his", "her", "its",
]);

function isUserInstruction(msg: Message): boolean {
  if (msg.role !== "user") return false;
  const text = extractText(msg.content);
  return INSTRUCTION_PATTERNS.some((p) => p.test(text));
}

function extractKeywords(text: string, count: number = 3): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([w]) => w);
}

function extractToolNames(messages: Message[]): string[] {
  const names = new Set<string>();
  for (const msg of messages) {
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const n = tc.function?.name;
        if (n) names.add(n);
      }
    }
    if (msg.role === "tool" && msg.name) {
      names.add(msg.name);
    }
  }
  return [...names];
}

function inferTimestamp(msg: Message, index: number, baseTime: number): number {
  if (msg.timestamp) return msg.timestamp;
  // Approximate: assume ~10 seconds per message from a base time
  return baseTime + index * 10_000;
}

function isToolResultReferencedLater(
  toolMsg: Message,
  laterMessages: Message[],
): boolean {
  if (!toolMsg.tool_call_id) return false;
  const text = extractText(toolMsg.content).substring(0, 100).toLowerCase();
  if (!text) return false;

  // Check if any significant words from the tool result appear in later messages
  const significantWords = text
    .split(/\s+/)
    .filter((w) => w.length > 4 && !STOP_WORDS.has(w))
    .slice(0, 5);

  if (significantWords.length === 0) return false;

  for (const later of laterMessages) {
    const laterText = extractText(later.content).toLowerCase();
    for (const word of significantWords) {
      if (laterText.includes(word)) return true;
    }
  }
  return false;
}

// ── Cluster ──

interface MessageCluster {
  messages: Message[];
  startIndex: number;
  endIndex: number;
  startTime: number;
  endTime: number;
}

function clusterMessages(
  messages: Message[],
  windowMs: number,
  baseTime: number,
): MessageCluster[] {
  if (messages.length === 0) return [];

  const clusters: MessageCluster[] = [];
  let current: MessageCluster = {
    messages: [messages[0]],
    startIndex: 0,
    endIndex: 0,
    startTime: inferTimestamp(messages[0], 0, baseTime),
    endTime: inferTimestamp(messages[0], 0, baseTime),
  };

  for (let i = 1; i < messages.length; i++) {
    const ts = inferTimestamp(messages[i], i, baseTime);
    if (ts - current.endTime <= windowMs) {
      current.messages.push(messages[i]);
      current.endIndex = i;
      current.endTime = ts;
    } else {
      clusters.push(current);
      current = {
        messages: [messages[i]],
        startIndex: i,
        endIndex: i,
        startTime: ts,
        endTime: ts,
      };
    }
  }
  clusters.push(current);
  return clusters;
}

function summarizeCluster(cluster: MessageCluster): ClusterInfo {
  const allText = cluster.messages.map((m) => extractText(m.content)).join(" ");
  const toolNames = extractToolNames(cluster.messages);

  let topic: string;
  if (toolNames.length > 0) {
    topic = `Tools: ${toolNames.join(", ")}`;
  } else {
    const kw = extractKeywords(allText);
    topic = kw.length > 0 ? kw.join(", ") : "general discussion";
  }

  // Build a brief summary from the cluster messages
  const lines: string[] = [];
  for (const msg of cluster.messages) {
    const text = extractText(msg.content).trim();
    if (!text) continue;
    const prefix = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : msg.role;
    const snippet = text.length > 150 ? text.substring(0, 150) + "..." : text;
    lines.push(`${prefix}: ${snippet}`);
  }

  const summary = lines.slice(0, 6).join("\n");

  return {
    topic,
    messageCount: cluster.messages.length,
    summary,
  };
}

// ── SmartCompactor ──

export class SmartCompactor {
  private options: SmartCompactorOptions;
  private stats = {
    totalCompactions: 0,
    totalTokensSaved: 0,
  };

  constructor(options: SmartCompactorOptions) {
    this.options = options;
  }

  estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  private messageTokens(msg: Message): number {
    return this.estimateTokens(extractText(msg.content)) + 4; // 4 overhead per message
  }

  private totalTokens(messages: Message[]): number {
    let t = 0;
    for (const m of messages) t += this.messageTokens(m);
    return t;
  }

  getContextBudget(messages: Message[], systemPromptTokens: number): ContextBudget {
    const used = this.totalTokens(messages) + systemPromptTokens;
    const total = this.options.maxTokens;
    const remaining = Math.max(0, total - used);
    const percentage = total > 0 ? (used / total) * 100 : 0;
    return {
      total,
      used,
      remaining,
      percentage,
      overflowing: used > total,
    };
  }

  shouldCompact(messages: Message[], systemPromptTokens: number): boolean {
    const budget = this.getContextBudget(messages, systemPromptTokens);
    return budget.used > this.options.maxTokens * 0.8;
  }

  compact(messages: Message[], options?: CompactCallOptions): CompactionResult {
    const keepRecent = options?.keepRecent ?? 20;
    const clusterWindowMs = options?.clusterWindowMs ?? 5 * 60 * 1000;

    const originalTokens = this.totalTokens(messages);

    if (messages.length <= keepRecent) {
      return {
        messages: [...messages],
        removedCount: 0,
        originalTokens,
        compactedTokens: originalTokens,
        savedTokens: 0,
        clusters: [],
      };
    }

    const oldMessages = messages.slice(0, messages.length - keepRecent);
    const recentMessages = messages.slice(messages.length - keepRecent);

    // 1. Extract leading system messages (never touch them)
    const leadingSystem: Message[] = [];
    let startIdx = 0;
    if (this.options.preserveSystemMessages) {
      while (startIdx < oldMessages.length && oldMessages[startIdx].role === "system") {
        leadingSystem.push(oldMessages[startIdx]);
        startIdx++;
      }
    }

    const compactable = oldMessages.slice(startIdx);

    // 2. Separate preserved messages from compactable ones
    const preserved: Message[] = [];
    const toCluster: Message[] = [];

    for (let i = 0; i < compactable.length; i++) {
      const msg = compactable[i];

      // Preserve system messages
      if (this.options.preserveSystemMessages && msg.role === "system") {
        preserved.push(msg);
        continue;
      }

      // Preserve tool results referenced later
      if (
        this.options.preserveToolResults &&
        msg.role === "tool" &&
        isToolResultReferencedLater(msg, [...compactable.slice(i + 1), ...recentMessages])
      ) {
        preserved.push(msg);
        continue;
      }

      // Preserve user instructions/preferences
      if (this.options.preserveUserInstructions && isUserInstruction(msg)) {
        preserved.push(msg);
        continue;
      }

      toCluster.push(msg);
    }

    // 3. Cluster the remaining messages by time proximity
    const baseTime = Date.now() - toCluster.length * 10_000;
    const clusters = clusterMessages(toCluster, clusterWindowMs, baseTime);
    const clusterInfos = clusters.map(summarizeCluster);

    // 4. Build summary system messages per cluster
    const summaryMessages: Message[] = [];
    for (const info of clusterInfos) {
      if (!info.summary.trim()) continue;
      summaryMessages.push({
        role: "system",
        content: `[Compacted — ${info.topic} (${info.messageCount} messages)]\n${info.summary}`,
      });
    }

    // 5. Assemble result
    const result = [
      ...leadingSystem,
      ...summaryMessages,
      ...preserved,
      ...recentMessages,
    ];

    const compactedTokens = this.totalTokens(result);
    const savedTokens = originalTokens - compactedTokens;
    const removedCount = oldMessages.length - leadingSystem.length - preserved.length;

    // Update stats
    this.stats.totalCompactions++;
    this.stats.totalTokensSaved += Math.max(0, savedTokens);

    return {
      messages: result,
      removedCount,
      originalTokens,
      compactedTokens,
      savedTokens,
      clusters: clusterInfos,
    };
  }

  autoCompact(
    messages: Message[],
    systemPromptTokens: number,
  ): { messages: Message[]; compacted: boolean; savedTokens: number } {
    if (!this.shouldCompact(messages, systemPromptTokens)) {
      return { messages, compacted: false, savedTokens: 0 };
    }

    const result = this.compact(messages);
    return {
      messages: result.messages,
      compacted: true,
      savedTokens: result.savedTokens,
    };
  }

  getCompactionStats(): {
    totalCompactions: number;
    totalTokensSaved: number;
    averageSavings: number;
  } {
    return {
      totalCompactions: this.stats.totalCompactions,
      totalTokensSaved: this.stats.totalTokensSaved,
      averageSavings:
        this.stats.totalCompactions > 0
          ? this.stats.totalTokensSaved / this.stats.totalCompactions
          : 0,
    };
  }
}

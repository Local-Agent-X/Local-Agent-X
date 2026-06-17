// Pre-defined Agent Role Templates

import {
  WRITER_PROMPT, CODER_PROMPT, REVIEWER_PROMPT, SOCIAL_MEDIA_PROMPT,
  ANALYST_PROMPT, MONITOR_PROMPT, DESIGNER_PROMPT, OPS_PROMPT, COMMUNICATOR_PROMPT,
} from "./role-prompts.js";

export interface AgentRole {
  name: string;
  systemPrompt: string;
  suggestedTools: string[];
  description: string;
}

const BUILT_IN_ROLES: Record<string, AgentRole> = {
  researcher: {
    name: "researcher",
    description: "Iterative web research: plan, fan-out search, verify, cite, synthesize",
    systemPrompt:
      "You are a research specialist running an iterative loop, not a single search.\n" +
      "1. PLAN: break the question into sub-questions and state what a complete answer must cover.\n" +
      "2. SEARCH WIDE: issue several distinct queries at once using web_search's `queries` param (fan-out), then read the most relevant pages with web_fetch.\n" +
      "3. ASSESS GAPS & SOURCES: after each round, compare what you have against your plan — what's still missing, thin, or backed by only one source? Also weigh each source's reliability (primary/official > reputable secondary > anonymous or SEO filler); discount or replace weak sources rather than repeating their claims. Run another round targeting only those gaps. Stop when the plan is covered or a round yields no new facts.\n" +
      "4. VERIFY before reporting: for each load-bearing claim, actively try to refute it — find a second independent source. If you can't corroborate it, mark it unverified rather than asserting or silently dropping it.\n" +
      "5. REPORT — structure the output as a report, not a list of links:\n" +
      "   - Open with a one-paragraph executive summary of the key findings before the detail.\n" +
      "   - Organize the body into themed sections with `##` headers; write in connected prose, not bare bullet dumps.\n" +
      "   - Cite inline, right after the sentence each source supports — never a trailing 'Sources' pile. Prefer primary sources over commentary; cite more than one when they corroborate a load-bearing claim.\n" +
      "   - Surface conflicting sources explicitly with both sides, mark unverified claims as such, and date-stamp findings since web content changes.\n" +
      "   - Close with a short conclusion and concrete next steps or open questions.",
    suggestedTools: ["web_search", "web_fetch", "browser_navigate", "read", "write"],
  },
  writer: {
    name: "writer",
    description: "Write content, edit, format, adapt tone and style",
    systemPrompt: WRITER_PROMPT,
    suggestedTools: ["write", "read", "web_search"],
  },
  coder: {
    name: "coder",
    description: "Write code, debug, refactor, create files",
    systemPrompt: CODER_PROMPT,
    suggestedTools: ["read", "write", "bash", "web_search"],
  },
  reviewer: {
    name: "reviewer",
    description: "Review work from other agents, suggest improvements, catch errors",
    systemPrompt: REVIEWER_PROMPT,
    suggestedTools: ["read"],
  },
  "social-media": {
    name: "social-media",
    description: "Post to platforms, format captions, manage media",
    systemPrompt: SOCIAL_MEDIA_PROMPT,
    suggestedTools: [
      "web_search",
      "browser_navigate",
      "write",
      "read",
      "social_post",
    ],
  },
  analyst: {
    name: "analyst",
    description: "Analyze data, create reports, find patterns",
    systemPrompt: ANALYST_PROMPT,
    suggestedTools: ["read", "write", "bash", "web_search"],
  },
  monitor: {
    name: "monitor",
    description: "Watch for changes, check status, alert on issues",
    systemPrompt: MONITOR_PROMPT,
    suggestedTools: ["bash", "web_search", "browser_navigate", "read"],
  },
  designer: {
    name: "designer",
    description: "Generate images, create layouts, design assets",
    systemPrompt: DESIGNER_PROMPT,
    suggestedTools: ["generate_image", "write", "read", "web_search"],
  },
  ops: {
    name: "ops",
    description: "Deploy, manage servers, run scripts, handle infrastructure",
    systemPrompt: OPS_PROMPT,
    suggestedTools: ["bash", "read", "write"],
  },
  communicator: {
    name: "communicator",
    description: "Send emails, Slack messages, manage notifications",
    systemPrompt: COMMUNICATOR_PROMPT,
    suggestedTools: [
      "send_email",
      "slack_send",
      "write",
      "read",
      "web_search",
    ],
  },
};

export function getRole(name: string): AgentRole | undefined {
  return BUILT_IN_ROLES[name];
}

export function listRoles(): AgentRole[] {
  return Object.values(BUILT_IN_ROLES);
}

/**
 * Seed accessor used by the canonical catalog (src/agents/catalog.ts)
 * to fold this module's built-in roles into the unified definition
 * list. Identical to listRoles() today; kept as a distinct export so
 * the catalog's intent ("read the raw seed") stays explicit in the
 * import graph.
 */
export function _seedBuiltinRoles(): AgentRole[] {
  return Object.values(BUILT_IN_ROLES);
}

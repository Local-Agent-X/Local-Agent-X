// Pre-defined Agent Role Templates

import {
  WRITER_PROMPT, CODER_PROMPT, REVIEWER_PROMPT, SOCIAL_MEDIA_PROMPT,
  ANALYST_PROMPT, MONITOR_PROMPT, DESIGNER_PROMPT, OPS_PROMPT, COMMUNICATOR_PROMPT,
} from "./role-prompts.js";
import { selectTools } from "../tools/tool-kits.js";
import { DEEP_RESEARCH_CLAIMS, DEEP_RESEARCH_METHOD } from "./research-method.js";

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
      `You are a research specialist. ${DEEP_RESEARCH_METHOD}\n${DEEP_RESEARCH_CLAIMS}`,
    suggestedTools: selectTools({ tags: ["web-search", "web-read", "web-browse", "file-read", "file-write"] }),
  },
  writer: {
    name: "writer",
    description: "Write content, edit, format, adapt tone and style",
    systemPrompt: WRITER_PROMPT,
    suggestedTools: selectTools({ tags: ["file-write", "file-read", "web-search"] }),
  },
  coder: {
    name: "coder",
    description: "Write code, debug, refactor, create files",
    systemPrompt: CODER_PROMPT,
    suggestedTools: selectTools({ tags: ["file-read", "file-write", "shell", "web-search"] }),
  },
  reviewer: {
    name: "reviewer",
    description: "Review work from other agents, suggest improvements, catch errors",
    systemPrompt: REVIEWER_PROMPT,
    suggestedTools: selectTools({ tags: ["file-read"] }),
  },
  "social-media": {
    name: "social-media",
    description: "Post to platforms, format captions, manage media",
    systemPrompt: SOCIAL_MEDIA_PROMPT,
    suggestedTools: selectTools({ tags: ["web-search", "web-browse", "http-api", "file-write", "file-read"] }),
  },
  analyst: {
    name: "analyst",
    description: "Analyze data, create reports, find patterns",
    systemPrompt: ANALYST_PROMPT,
    suggestedTools: selectTools({ tags: ["file-read", "file-write", "shell", "web-search"] }),
  },
  monitor: {
    name: "monitor",
    description: "Watch for changes, check status, alert on issues",
    systemPrompt: MONITOR_PROMPT,
    suggestedTools: selectTools({ tags: ["shell", "web-search", "web-browse", "file-read"], plus: { telegram_send: "alerts the user on the chat they connected" } }),
  },
  designer: {
    name: "designer",
    description: "Generate images, create layouts, design assets",
    systemPrompt: DESIGNER_PROMPT,
    suggestedTools: selectTools({ tags: ["file-write", "file-read", "web-search"], plus: { generate_image: "makes the image assets it designs" } }),
  },
  ops: {
    name: "ops",
    description: "Deploy, manage servers, run scripts, handle infrastructure",
    systemPrompt: OPS_PROMPT,
    suggestedTools: selectTools({ tags: ["shell", "file-read", "file-write"] }),
  },
  communicator: {
    name: "communicator",
    description: "Send emails, Slack messages, manage notifications",
    systemPrompt: COMMUNICATOR_PROMPT,
    suggestedTools: selectTools({
      tags: ["http-api", "file-write", "file-read", "web-search"],
      plus: { email_send: "sends the email it writes", telegram_send: "sends the notification it writes" },
    }),
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

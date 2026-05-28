/**
 * Issue Tools — aggregator.
 *
 * Per-tool modules live in src/issue-tools/:
 *   shared.ts          — ok/err + project-scope resolvers
 *   issue-create.ts    — issue_create
 *   issue-list.ts      — issue_list
 *   issue-update.ts    — issue_update (incl. manager auto-notify + wake)
 *   issue-checkout.ts  — issue_checkout
 *   issue-release.ts   — issue_release
 *   issue-search.ts    — issue_search
 *   agent-team-list.ts — agent_team_list
 *   agent-whoami.ts    — agent_whoami
 *   agent-wakeup.ts    — agent_wakeup
 */

import type { ToolDefinition } from "../types.js";
import { issueCreateTool } from "./issue-tools/issue-create.js";
import { issueListTool } from "./issue-tools/issue-list.js";
import { issueUpdateTool } from "./issue-tools/issue-update.js";
import { issueCheckoutTool } from "./issue-tools/issue-checkout.js";
import { issueReleaseTool } from "./issue-tools/issue-release.js";
import { issueSearchTool } from "./issue-tools/issue-search.js";
import { agentTeamListTool } from "./issue-tools/agent-team-list.js";
import { agentWhoAmITool } from "./issue-tools/agent-whoami.js";
import { agentWakeupTool } from "./issue-tools/agent-wakeup.js";

export const issueTools: ToolDefinition[] = [
  issueCreateTool,
  issueListTool,
  issueUpdateTool,
  issueCheckoutTool,
  issueReleaseTool,
  issueSearchTool,
  agentTeamListTool,
  agentWhoAmITool,
  agentWakeupTool,
];

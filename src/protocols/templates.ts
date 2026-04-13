/**
 * Protocol Templates — base templates for common protocol categories.
 */

import type { Protocol, ProtocolStep } from "../protocols.js";
import type { ToolDefinition } from "../types.js";

export interface ProtocolTemplate {
  id: string;
  category: "social-media" | "developer" | "research" | "communication";
  name: string;
  description: string;
  baseSteps: ProtocolStep[];
  baseRules: string[];
  defaultTriggers: string[];
  defaultPreferences: string[];
}

const socialMediaTemplate: ProtocolTemplate = {
  id: "social-media",
  category: "social-media",
  name: "Social Media Post",
  description: "Template for creating and publishing social media content across platforms.",
  baseSteps: [
    { id: "gather_content", instruction: "Collect media, caption text, and posting preferences from the user." },
    { id: "draft_content", instruction: "Draft the post content following platform-specific formatting rules." },
    { id: "open_platform", instruction: "Navigate to the target platform, verify login status." },
    { id: "create_post", instruction: "Create the post using the platform's composer UI." },
    { id: "review", instruction: "Take a snapshot and verify content before publishing." },
    { id: "publish", instruction: "Publish the post and confirm success." },
  ],
  baseRules: [
    "Always verify login status before attempting any actions.",
    "Never attempt to fill login credentials automatically.",
    "Always preview and get user approval before publishing.",
    "Handle platform-specific formatting quirks.",
  ],
  defaultTriggers: ["post on", "publish to", "share on"],
  defaultPreferences: ["username", "default_hashtags", "posting_style"],
};

const developerTemplate: ProtocolTemplate = {
  id: "developer",
  category: "developer",
  name: "Developer Workflow",
  description: "Template for automating developer tasks like deployments, testing, and code reviews.",
  baseSteps: [
    { id: "check_environment", instruction: "Verify required tools and environment setup." },
    { id: "gather_context", instruction: "Collect repository, branch, and task details." },
    { id: "execute_task", instruction: "Run the developer workflow (build, test, deploy, etc.)." },
    { id: "verify_result", instruction: "Verify the task completed successfully." },
    { id: "report", instruction: "Report results and any issues to the user." },
  ],
  baseRules: [
    "Always check for uncommitted changes before destructive operations.",
    "Run tests before deploying.",
    "Never force-push without explicit user approval.",
    "Log all commands and their outputs for debugging.",
  ],
  defaultTriggers: ["deploy", "run tests", "review code"],
  defaultPreferences: ["default_branch", "test_command", "deploy_target"],
};

const researchTemplate: ProtocolTemplate = {
  id: "research",
  category: "research",
  name: "Research Workflow",
  description: "Template for web research, summarization, and citation workflows.",
  baseSteps: [
    { id: "define_scope", instruction: "Clarify the research question and scope with the user." },
    { id: "search", instruction: "Search for relevant sources using web search and browsing." },
    { id: "collect", instruction: "Gather key information from the most relevant sources." },
    { id: "analyze", instruction: "Analyze and cross-reference findings." },
    { id: "synthesize", instruction: "Create a structured summary with citations." },
    { id: "present", instruction: "Present findings to the user in their preferred format." },
  ],
  baseRules: [
    "Always cite sources with URLs.",
    "Cross-reference claims across multiple sources.",
    "Flag conflicting information explicitly.",
    "Distinguish between facts and opinions/analysis.",
  ],
  defaultTriggers: ["research", "look up", "find out about"],
  defaultPreferences: ["citation_format", "summary_length", "preferred_sources"],
};

const communicationTemplate: ProtocolTemplate = {
  id: "communication",
  category: "communication",
  name: "Communication Workflow",
  description: "Template for sending messages across email, chat, and messaging platforms.",
  baseSteps: [
    { id: "gather_details", instruction: "Collect recipient, message content, and platform." },
    { id: "draft_message", instruction: "Draft the message with appropriate tone and formatting." },
    { id: "review", instruction: "Present draft to user for approval." },
    { id: "open_platform", instruction: "Navigate to the messaging platform." },
    { id: "send", instruction: "Send the message." },
    { id: "confirm", instruction: "Verify the message was sent successfully." },
  ],
  baseRules: [
    "Always get user approval before sending any message.",
    "Never send messages to unintended recipients.",
    "Adapt tone to match the platform (formal for email, casual for chat).",
    "Verify recipient before sending.",
  ],
  defaultTriggers: ["send message", "email", "message"],
  defaultPreferences: ["email_signature", "default_tone", "preferred_platform"],
};

export const TEMPLATES: ProtocolTemplate[] = [
  socialMediaTemplate,
  developerTemplate,
  researchTemplate,
  communicationTemplate,
];

export function getTemplate(id: string): ProtocolTemplate | undefined {
  return TEMPLATES.find(t => t.id === id || t.category === id);
}

export function protocolFromTemplate(
  template: ProtocolTemplate,
  overrides: {
    name: string;
    description?: string;
    extraSteps?: ProtocolStep[];
    extraRules?: string[];
    triggers?: string[];
  }
): Protocol {
  return {
    name: overrides.name,
    description: overrides.description ?? template.description,
    triggers: overrides.triggers ?? template.defaultTriggers,
    steps: [...template.baseSteps, ...(overrides.extraSteps ?? [])],
    rules: [...template.baseRules, ...(overrides.extraRules ?? [])],
    learnablePreferences: template.defaultPreferences,
  };
}

export function createTemplateTools(): ToolDefinition[] {
  return [
    {
      name: "protocol_templates_list",
      description: "List available protocol templates (social-media, developer, research, communication).",
      parameters: { type: "object", properties: {} },
      async execute() {
        const list = TEMPLATES.map(t =>
          `• **${t.id}** — ${t.description}\n  Steps: ${t.baseSteps.length} | Rules: ${t.baseRules.length}`
        ).join("\n\n");
        return { content: `Available templates:\n\n${list}` };
      },
    },
    {
      name: "protocol_from_template",
      description: "Create a new protocol from a template.",
      parameters: {
        type: "object",
        properties: {
          templateId: { type: "string", description: "Template ID (social-media, developer, research, communication)" },
          name: { type: "string", description: "Name for the new protocol" },
          description: { type: "string", description: "Optional description override" },
          triggers: { type: "array", items: { type: "string" }, description: "Trigger phrases" },
          extraRules: { type: "array", items: { type: "string" }, description: "Additional rules" },
        },
        required: ["templateId", "name"],
      },
      async execute(args) {
        const template = getTemplate(String(args.templateId));
        if (!template) return { content: `Template "${args.templateId}" not found.` };
        const protocol = protocolFromTemplate(template, {
          name: String(args.name),
          description: args.description ? String(args.description) : undefined,
          triggers: args.triggers as string[] | undefined,
          extraRules: args.extraRules as string[] | undefined,
        });
        return { content: `Created protocol "${protocol.name}" from ${template.id} template with ${protocol.steps.length} steps.` };
      },
    },
  ];
}

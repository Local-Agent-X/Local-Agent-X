/**
 * Zod schemas for API request validation.
 * Used by route handlers to validate incoming JSON bodies at system boundaries.
 */
import { z } from "zod";

// ── Chat ──

export const ChatRequestSchema = z.object({
  // Empty message is allowed when at least one attachment is supplied
  // (image-only paste-and-send). Combined non-emptiness enforced below.
  message: z.string().optional().default(""),
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, "Invalid session ID").optional().default("default"),
  attachments: z.array(z.object({
    name: z.string(),
    url: z.string(),
    isImage: z.boolean(),
  })).optional().default([]),
}).superRefine((data, ctx) => {
  if (!data.message.trim() && (!data.attachments || data.attachments.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "message or at least one attachment is required",
      path: ["message"],
    });
  }
});

// ── Sessions ──

export const ForkSessionSchema = z.object({
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, "Invalid session ID"),
  atIndex: z.number().int().min(0),
});

export const CompactSchema = z.object({
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional().default("default"),
});

// ── Agents ──

export const AgentTemplateSchema = z.object({
  name: z.string().min(1, "name required"),
  role: z.string().min(1, "role required"),
  systemPrompt: z.string().optional().default(""),
  allowedTools: z.array(z.string()).optional().default([]),
  description: z.string().optional().default(""),
  icon: z.string().optional(),
});

export const SpawnAgentSchema = z.object({
  task: z.string().optional().default("Execute your role"),
});

// ── Issues ──

export const CreateIssueSchema = z.object({
  title: z.string().min(1, "title required"),
  description: z.string().optional().default(""),
  assignee: z.string().optional().default(""),
  status: z.enum(["open", "in-progress", "blocked", "done", "cancelled"]).optional().default("open"),
  priority: z.enum(["low", "medium", "high", "critical"]).optional().default("medium"),
  project: z.string().optional(),
  parentIssue: z.string().optional(),
  blockedBy: z.string().optional(),
  createdBy: z.string().optional().default("user"),
});

export const IssueCommentSchema = z.object({
  content: z.string().min(1, "content required"),
  author: z.string().optional().default("user"),
});

// ── Projects ──

export const CreateProjectSchema = z.object({
  name: z.string().min(1, "name required"),
  description: z.string().optional().default(""),
  workspace: z.string().optional(),
  agentIds: z.array(z.string()).optional().default([]),
  secretKeys: z.array(z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
});

// ── Secrets ──

export const SetSecretSchema = z.object({
  name: z.string().min(1, "name required"),
  value: z.string().min(1, "value required"),
  service: z.string().optional(),
});

// ── Identity Links ──

export const ChannelIdentitySchema = z.object({
  channel: z.enum(["web", "telegram", "whatsapp", "cli", "api"]),
  id: z.string().min(1),
  displayName: z.string().optional(),
});

export const LinkIdentitiesSchema = z.object({
  identity1: ChannelIdentitySchema,
  identity2: ChannelIdentitySchema,
  displayName: z.string().optional(),
});

// ── Settings ──

export const SwitchProviderSchema = z.object({
  provider: z.string().min(1, "provider required"),
  model: z.string().optional().default(""),
});

export const SessionPolicySchema = z.object({
  sessionId: z.string().optional().default("default"),
  preset: z.string().min(1, "preset required"),
});

// ── Cron ──

export const CreateCronSchema = z.object({
  name: z.string().min(1, "name required"),
  schedule: z.string().min(1, "schedule required"),
  prompt: z.string().min(1, "prompt required"),
  systemJob: z.boolean().optional(),
});

// ── Helper ──

/** Parse and validate request body against a Zod schema. Returns typed data or null (sends 400). */
export function validateBody<T>(
  body: unknown,
  schema: z.ZodType<T>,
): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(body);
  if (!result.success) {
    const firstError = result.error.errors[0];
    return { success: false, error: `${firstError.path.join(".")}: ${firstError.message}`.replace(/^: /, "") };
  }
  return { success: true, data: result.data };
}

/**
 * Protocol System Types — markdown-based reusable workflows.
 *
 * Protocols are the agent's reusable prompt workflows:
 * - Just a SKILL.md file with YAML frontmatter
 * - Dropped into ~/.sax/skills/my-protocol/ or workspace/.sax/skills/my-protocol/
 * - Zero code needed — the frontmatter defines metadata, the body is the prompt
 * - Missions are a separate concept (cron jobs / scheduled tasks)
 */

export interface SkillMetadata {
  /** Display name (defaults to directory name) */
  name: string;
  /** What this skill does */
  description: string;
  /** Tools this skill is allowed to use (empty = all tools) */
  allowedTools?: string[];
  /** Hint shown in help: e.g., "[search query]" */
  argumentHint?: string;
  /** When the agent should suggest this skill */
  whenToUse?: string;
}

export interface Skill {
  /** Unique ID derived from directory path */
  id: string;
  /** Parsed frontmatter metadata */
  metadata: SkillMetadata;
  /** The raw prompt body (markdown after frontmatter) */
  body: string;
  /** Source file path */
  sourcePath: string;
}

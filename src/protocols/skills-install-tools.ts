/**
 * The model-facing half of skills-install.ts: three `protocol_*` tools that
 * protocol-tool.ts collapses into `protocol(action:"install" | "refresh" |
 * "update")`. `install` and `update` write into the workspace and are listed
 * in DESTRUCTIVE_TOOL_ACTIONS (approval-decision.ts) so the collapsed family
 * keeps its approval gate; `refresh` only reports a diff.
 */

import type { ToolDefinition } from "../types.js";
import { installSkills, listInstalledSkills, refreshSkill, type InstallReport, type RefreshReport } from "./skills-install.js";

function renderInstall(report: InstallReport): string {
  const lines = [`${report.repo}@${report.ref} pinned at ${report.commit.slice(0, 8)}: installed ${report.installed.length}, skipped ${report.skipped.length}${report.notSelected ? `, ${report.notSelected} not selected` : ""}.`];
  for (const s of report.installed) {
    lines.push(`• ${s.name} ← ${s.path} (${s.files.length} file${s.files.length === 1 ? "" : "s"})${s.warnings.length ? `\n  warnings: ${s.warnings.join("; ")}` : ""}`);
  }
  for (const s of report.skipped) lines.push(`• skipped ${s.path}: ${s.reason}`);
  const n = report.notInstalled;
  if (n.mcpServers.length || n.hooks || n.agents || n.commands) {
    lines.push(`Not installed (a skills import brings SKILL.md folders only): ${[
      n.mcpServers.length ? `MCP servers ${n.mcpServers.join(", ")} — add them under Settings → MCP if wanted` : "",
      n.hooks ? `${n.hooks} hook file(s)` : "", n.agents ? `${n.agents} agent file(s)` : "", n.commands ? `${n.commands} command file(s)` : "",
    ].filter(Boolean).join("; ")}.`);
  }
  if (report.installed.length) lines.push(`Installed skills are stored protocols: protocol(action:"get", params:{name}) loads one.`);
  return lines.join("\n");
}

function renderRefresh(r: RefreshReport): string {
  if (r.upToDate) return `"${r.name}" is up to date with ${r.repo}@${r.ref} (${r.installedCommit.slice(0, 8)}).`;
  const head = `"${r.name}": ${r.repo}@${r.ref} moved ${r.installedCommit.slice(0, 8)} → ${r.upstreamCommit.slice(0, 8)}; changed: ${r.changedFiles.join(", ") || "sibling files only"}.`;
  if (r.applied) return `${head}\nApplied.`;
  return `${head}\n${r.patch || "(SKILL.md unchanged)"}\nNothing was written. Show the user this diff; protocol(action:"update", params:{name:"${r.name}"}) applies it once they agree.`;
}

export function createSkillInstallTools(): ToolDefinition[] {
  return [
    {
      name: "protocol_install",
      description:
        "Install Agent Skills (SKILL.md folders) from a GitHub repo into the workspace, pinned to the commit they were fetched at. " +
        "Use for vendor/community skill packs (a vercel or supabase plugin repo, anthropics/skills, ...). " +
        "Only MIT / Apache-2.0 / CC-BY-4.0 content is installed; .mcp.json, hooks, agents and commands in the repo are reported, not installed.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "owner/repo, owner/repo@ref, or a github.com URL (a /tree/<ref>/<path> URL limits the install to that folder)" },
          ref: { type: "string", description: "Branch, tag, or commit (default: the repo's default branch)" },
          path: { type: "string", description: "Only install skills under this folder of the repo" },
          license: { type: "string", description: "Assert the license when neither the SKILL.md nor the repo's LICENSE file declares one" },
          force: { type: "boolean", description: "Replace a same-named skill that came from elsewhere" },
          only: { type: "array", items: { type: "string" }, description: "Install only these skills (names or repo paths); a large repo is a catalog, so pick from it" },
        },
        required: ["repo"],
      },
      async execute(args) {
        try {
          const report = await installSkills({
            repo: String(args.repo ?? ""),
            ref: typeof args.ref === "string" ? args.ref : undefined,
            path: typeof args.path === "string" ? args.path : undefined,
            license: typeof args.license === "string" ? args.license : undefined,
            force: args.force === true,
            only: Array.isArray(args.only) ? (args.only as unknown[]).filter((x): x is string => typeof x === "string") : undefined,
          });
          return { content: renderInstall(report) };
        } catch (e) {
          return { content: `Install failed: ${(e as Error).message}`, isError: true };
        }
      },
    },
    {
      name: "protocol_refresh",
      description:
        "Check an installed skill against its repo and return the diff since the pinned commit. Reads only — nothing is written. " +
        "With no name, lists every installed skill with its repo and pinned commit.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Installed skill name (from protocol_list / the install report)" } },
      },
      async execute(args) {
        try {
          if (typeof args.name !== "string" || !args.name.trim()) {
            const all = listInstalledSkills();
            if (all.length === 0) return { content: "No skills installed from a repo yet. protocol(action:\"install\", params:{repo}) adds some." };
            return { content: all.map((s) => `• ${s.name} ← ${s.source.repo}@${s.source.ref} (${s.source.commit.slice(0, 8)}, ${s.source.license}, installed ${s.source.installedAt.slice(0, 10)})`).join("\n") };
          }
          return { content: renderRefresh(await refreshSkill(args.name)) };
        } catch (e) {
          return { content: `Refresh failed: ${(e as Error).message}`, isError: true };
        }
      },
    },
    {
      name: "protocol_update",
      description: "Apply the upstream changes protocol_refresh showed for an installed skill: re-pins it to the current commit and rewrites its files. Ask the user first; this overwrites the installed copy.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Installed skill name" } },
        required: ["name"],
      },
      async execute(args) {
        try {
          return { content: renderRefresh(await refreshSkill(String(args.name ?? ""), { apply: true })) };
        } catch (e) {
          return { content: `Update failed: ${(e as Error).message}`, isError: true };
        }
      },
    },
  ];
}

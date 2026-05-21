// Public surface for the agent-related stores. Legacy
// `src/agent-store.ts` re-exports from here so existing callers
// (server, agents/, tools/build-app, issue-tools, routes, tests) don't
// need to update import paths.

export type { Project } from "./project-store.js";
export { ProjectStore } from "./project-store.js";

export type { AgentRun } from "./run-store.js";
export { AgentRunStore } from "./run-store.js";

export type { AgentTemplate, AgentExecStrategy, AgentProviderStrategy } from "./template-store.js";
export { AgentTemplateStore } from "./template-store.js";

export type { Issue, IssueComment, IssueStatus, IssuePriority } from "./issue-store.js";
export { IssueStore } from "./issue-store.js";

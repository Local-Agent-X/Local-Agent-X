import type { IntegrationConfig } from "../types.js";

export const githubIntegration: IntegrationConfig = {
  id: "github",
  name: "GitHub",
  icon: "🐙",
  description: "Repos, issues, PRs, actions — full GitHub API",
  authType: "bearer_token",
  authInstructions: "1. Go to github.com/settings/tokens\n2. Generate new token (classic or fine-grained)\n3. Select scopes: repo, read:user\n4. Copy the token",
  baseUrl: "https://api.github.com",
  docsUrl: "https://docs.github.com/en/rest",
  secretName: "GITHUB_TOKEN",
  scopes: ["repo", "read:user"],
  endpoints: [
    { name: "List Repos", method: "GET", path: "/user/repos", description: "List your repositories", params: { sort: { type: "string", description: "created, updated, pushed, full_name" }, per_page: { type: "number", description: "Results per page (max 100)" } } },
    { name: "Create Issue", method: "POST", path: "/repos/{owner}/{repo}/issues", description: "Create an issue", params: { title: { type: "string", required: true, description: "Issue title" }, body: { type: "string", description: "Issue body (markdown)" } } },
    { name: "List PRs", method: "GET", path: "/repos/{owner}/{repo}/pulls", description: "List pull requests", params: { state: { type: "string", description: "open, closed, all" } } },
    { name: "Create PR", method: "POST", path: "/repos/{owner}/{repo}/pulls", description: "Create a pull request", params: { title: { type: "string", required: true, description: "PR title" }, head: { type: "string", required: true, description: "Branch with changes" }, base: { type: "string", required: true, description: "Branch to merge into" } } },
    { name: "Get User", method: "GET", path: "/user", description: "Get authenticated user profile" },
    { name: "List Notifications", method: "GET", path: "/notifications", description: "List notifications" },
  ],
  headers: { "Accept": "application/vnd.github.v3+json" },
  enabled: true,
  installed: false,
  builtin: true,
};

import type { IntegrationDeclaration } from "../types.js";

/**
 * Setup leads with the computer's own git sign-in because that is how a
 * developer pushes, and in chat a push that needs the user's yes shows its
 * review on a card. An unattended run (Autopilot, a scheduled or background
 * run) has no one to see that card, so for it the setup recommends a
 * fine-grained personal access token, held to reading and writing code and
 * pull requests (issues if the user wants them) in the repositories the user
 * picks, for one owner, for a limited time. Workflows, Administration and
 * Secrets stay off: each would let a pushed change or an API call reach CI,
 * repository settings or stored secrets.
 *
 * The token reaches a real push only through git's own sign-in, so the steps
 * say how to sign git in with it. This integration's API endpoints always use
 * the pasted token, and the pre-publish push review's dry run signs in with it
 * when git has no sign-in of its own (publish-review/push-dry-run.ts).
 *
 * Neither reaches the agent's push on Windows while the cage is on: the shell
 * runs as the separate sandbox account (sandbox/win-cage.ts drops the user's
 * profile from its environment), and Git Credential Manager keeps a browser
 * sign-in or a pasted token in the signed-in account's own credential store.
 * The Windows steps say so rather than promise a push that fails or waits on
 * a prompt no one sees.
 *
 * There is no `scopes` list: a fine-grained token carries per-repository
 * permissions, not OAuth scopes, and nothing reads the field.
 */
export const githubIntegration: IntegrationDeclaration = {
  id: "github",
  name: "GitHub",
  icon: "🐙",
  description: "Repositories, pull requests and issues through the GitHub API, with the access your token grants",
  authType: "bearer_token",
  authInstructions: [
    "Sign in first. Sign in with GitHub through your computer's git login. On a Mac or Linux the agent then pushes the way a developer does: in chat, each push is reviewed before it goes out, and a push that needs your yes shows that review on a card.",
    "- Mac / Linux: run gh auth login (it signs in through your browser; on a Mac the login is kept in the Keychain), then gh auth setup-git so git uses it.",
    "- Windows: your first git push to GitHub opens Git Credential Manager; choose Sign in with your browser. That signs in your own Windows account only. While the Windows sandbox is on (Settings → Bash Sandbox: Protected, which a new install turns on), the agent's commands run as a separate Windows account that cannot use your sign-in, or a token saved in Git Credential Manager, so the agent cannot push to GitHub: push from your own terminal.",
    "",
    "Add a token. The GitHub API actions of this integration (list repositories, open pull requests and issues) need one. On a Mac or Linux it is also recommended when the agent will push unattended (Autopilot, scheduled or background runs), where no one sees the review card: a push signed in with this token can reach only what the token allows. Git pushes with the token only when git is signed in with it: run gh auth login --with-token, then gh auth setup-git. On Windows the sandbox keeps the token from the agent's pushes too.",
    "1. Open github.com/settings/personal-access-tokens/new (a fine-grained personal access token)",
    "2. Token name: Local Agent X. Expiration: 90 days",
    "3. Resource owner: your account, or the organization that owns the repositories. A token covers one owner, so make a separate token for each organization",
    "4. Repository access: All repositories, or Only select repositories if you prefer",
    "5. Repository permissions: Contents → Read and write; Pull requests → Read and write; Issues → Read and write if you want the agent to file issues (optional). Metadata → Read-only is added automatically",
    "6. Leave every other permission at No access, Workflows, Administration and Secrets included",
    "7. Generate token, copy it, and paste it below",
  ].join("\n"),
  baseUrl: "https://api.github.com",
  docsUrl: "https://docs.github.com/en/rest",
  credentials: [{ name: "GITHUB_TOKEN" }],
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

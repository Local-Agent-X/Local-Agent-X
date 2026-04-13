/**
 * Developer Protocol Pack — git, deploy, test, PR review protocols.
 */

import type { Protocol } from "../../protocols.js";

export const gitWorkflowMission: Protocol = {
  name: "git_workflow",
  description: "Complete git workflow: branch, commit, push with conventional commit messages.",
  triggers: ["git workflow", "commit and push", "create branch and commit", "git branch"],
  learnablePreferences: ["default_branch", "commit_style", "branch_prefix"],
  rules: [
    "Always check for uncommitted changes before switching branches.",
    "Use conventional commit format: type(scope): description.",
    "Never force-push without explicit confirmation.",
    "Run status check after each git operation.",
  ],
  steps: [
    { id: "check_status", instruction: "Run git status to see current state." },
    { id: "create_branch", instruction: "Create and checkout a new branch if needed." },
    { id: "stage_changes", instruction: "Stage files, showing the user what will be committed." },
    { id: "commit", instruction: "Create commit with a descriptive conventional commit message." },
    { id: "push", instruction: "Push to remote. Set upstream if needed.", requiresUserAction: true },
    { id: "verify", instruction: "Verify push succeeded. Show remote URL.", validate: "Push succeeded without errors" },
  ],
};

export const deployMission: Protocol = {
  name: "deploy",
  description: "Deploy application to staging or production with pre-flight checks.",
  triggers: ["deploy", "deploy to production", "deploy to staging", "ship it", "push to prod"],
  learnablePreferences: ["deploy_command", "staging_url", "production_url", "deploy_branch"],
  rules: [
    "ALWAYS run tests before deploying.",
    "For production deploys, require explicit user confirmation.",
    "Check that the branch is up to date with remote before deploying.",
    "Log the deployment for rollback reference.",
    "Verify the deployment health check after deploy.",
  ],
  steps: [
    { id: "preflight", instruction: "Check branch, pull latest, verify clean working directory." },
    { id: "run_tests", instruction: "Run the test suite. Abort if tests fail.", validate: "All tests pass" },
    { id: "build", instruction: "Run the build command. Check for build errors.", validate: "Build succeeds" },
    { id: "confirm_target", instruction: "Confirm deployment target (staging/production) with user.", requiresUserAction: true },
    { id: "deploy", instruction: "Execute the deployment command." },
    { id: "health_check", instruction: "Verify the deployed application is healthy.", validate: "Health check passes" },
    { id: "notify", instruction: "Confirm successful deployment. Provide URL and rollback instructions." },
  ],
};

export const testRunnerMission: Protocol = {
  name: "test_runner",
  description: "Run tests with coverage, identify failures, and suggest fixes.",
  triggers: ["run tests", "test suite", "check tests", "run the tests"],
  learnablePreferences: ["test_command", "test_framework", "coverage_threshold"],
  rules: [
    "Detect the test framework from package.json or project config.",
    "Show failed tests clearly with file/line info.",
    "If coverage is below threshold, highlight uncovered areas.",
    "Suggest fixes for common test failures.",
  ],
  steps: [
    { id: "detect", instruction: "Detect test framework and configuration." },
    { id: "run", instruction: "Execute the test suite with coverage enabled." },
    { id: "analyze", instruction: "Parse results: total, passed, failed, skipped, coverage %." },
    { id: "report_failures", instruction: "For each failure, show test name, file, line, and error." },
    { id: "suggest_fixes", instruction: "Analyze failures and suggest fixes." },
    { id: "summary", instruction: "Provide overall summary with actionable next steps." },
  ],
};

export const prReviewMission: Protocol = {
  name: "pr_review",
  description: "Review a pull request: check diff, run tests, provide structured feedback.",
  triggers: ["review pr", "review pull request", "pr review", "check this pr"],
  learnablePreferences: ["review_style", "pr_platform", "focus_areas"],
  rules: [
    "Always read the full diff, not just changed files.",
    "Check for: bugs, security issues, performance, readability, test coverage.",
    "Be constructive — suggest improvements, don't just criticize.",
    "Flag any breaking changes or API changes explicitly.",
    "Check if tests cover the new/changed code.",
  ],
  steps: [
    { id: "fetch_pr", instruction: "Get the PR details: title, description, changed files." },
    { id: "read_diff", instruction: "Read the full diff. Note files changed and lines modified." },
    { id: "check_tests", instruction: "Verify tests exist for changed code. Note gaps." },
    { id: "run_tests", instruction: "Run the test suite against the PR branch.", validate: "Tests pass" },
    { id: "analyze", instruction: "Review for bugs, security, performance, and style issues." },
    { id: "write_review", instruction: "Write structured review with specific line comments and overall assessment." },
    { id: "submit", instruction: "Present review to user. Optionally submit via GitHub CLI.", requiresUserAction: true },
  ],
};

export const developerProtocols: Protocol[] = [
  gitWorkflowMission,
  deployMission,
  testRunnerMission,
  prReviewMission,
];

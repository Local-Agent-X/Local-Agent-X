/**
 * GitHub setup leads with the computer's git sign-in, then asks for a
 * fine-grained personal access token held to what the agent's GitHub work
 * needs, for the API actions and for unattended pushes; on Windows it says the
 * sandbox keeps both from the agent's pushes. The declaration claims no OAuth
 * scopes, which such a token does not have.
 */
import { describe, expect, it } from "vitest";
import { githubIntegration } from "./github.js";

describe("githubIntegration", () => {
  const steps = githubIntegration.authInstructions;

  it("puts the git sign-in first, per platform, before any token step", () => {
    expect(steps.startsWith("Sign in first.")).toBe(true);
    const signIn = steps.slice(0, steps.indexOf("Add a token."));
    expect(signIn).toMatch(/Git Credential Manager; choose Sign in with your browser/);
    expect(signIn).toMatch(/gh auth login .*then gh auth setup-git/);
    expect(signIn).not.toMatch(/personal-access-tokens/);
  });

  // The Windows cage runs the agent's shell as a separate account, which
  // cannot read the user's Git Credential Manager store.
  it("does not promise the agent a push on Windows while the sandbox is on", () => {
    expect(steps).not.toMatch(/Sign in with GitHub through your computer's git login and the agent pushes/);
    const windows = steps.split("\n").find((line) => line.startsWith("- Windows:")) ?? "";
    expect(windows).toMatch(/While the Windows sandbox is on .*separate Windows account that cannot use your sign-in, or a token saved in Git Credential Manager, so the agent cannot push/);
    expect(steps).not.toMatch(/in Git Credential Manager choose Token/);
    expect(steps).toMatch(/On Windows the sandbox keeps the token from the agent's pushes too/);
  });

  it("says the token is for the API actions and recommended for unattended pushes, and how git pushes with it", () => {
    const token = steps.slice(steps.indexOf("Add a token."));
    expect(token).toMatch(/API actions of this integration .* need one/);
    expect(token).toMatch(/recommended when the agent will push unattended \(Autopilot, scheduled or background runs\)/);
    expect(token).toMatch(/gh auth login --with-token, then gh auth setup-git/);
  });

  it("describes what the recommended token can reach, not the whole GitHub API", () => {
    expect(githubIntegration.description).not.toMatch(/full GitHub API|actions/i);
    expect(githubIntegration.description).toMatch(/Repositories, pull requests and issues/);
  });

  it("sends the user to the fine-grained token page, for 90 days, one token per owner", () => {
    expect(steps).toContain("github.com/settings/personal-access-tokens/new");
    expect(steps).toMatch(/Expiration: 90 days/);
    expect(steps).toMatch(/separate token for each organization/);
    expect(steps).toMatch(/Repository access: All repositories, or Only select repositories/);
  });

  it("grants Contents and Pull requests read and write, Issues optionally, and nothing that reaches CI, settings or secrets", () => {
    expect(steps).toMatch(/Contents → Read and write/);
    expect(steps).toMatch(/Pull requests → Read and write/);
    expect(steps).toMatch(/Issues → Read and write if you want .*\(optional\)/);
    expect(steps).toMatch(/Metadata → Read-only is added automatically/);
    for (const kept of ["Workflows", "Administration", "Secrets"]) {
      expect(steps).toMatch(new RegExp(`No access, .*${kept}`));
      expect(steps).not.toMatch(new RegExp(`${kept} → Read`));
    }
    expect(steps).not.toMatch(/settings\/tokens\b|classic|\brepo, read:user/);
  });

  it("declares no OAuth scopes, because a fine-grained token carries none", () => {
    expect(githubIntegration.scopes).toBeUndefined();
  });

  it("keeps the persisted id and credential name so existing installs survive", () => {
    expect(githubIntegration.id).toBe("github");
    expect(githubIntegration.credentials.map((c) => c.name)).toEqual(["GITHUB_TOKEN"]);
  });
});

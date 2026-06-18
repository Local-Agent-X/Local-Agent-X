// The point of this module is that the token is NEVER persisted to .git/config
// and NEVER appears in git's argv (process listings). These pin that invariant:
// the token value lives only in the env, while argv carries the env-var name.
import { describe, it, expect } from "vitest";
import { gitCredentialArgs, gitCredentialEnv } from "./git-auth.js";

const TOKEN = "ghp_test_SECRETvalue_should_never_be_in_argv";

describe("git sync credentials", () => {
  it("never puts the token value in argv", () => {
    const args = gitCredentialArgs(TOKEN);
    expect(args.some((a) => a.includes(TOKEN))).toBe(false);
    expect(args.join(" ")).toContain("$GIT_SYNC_TOKEN"); // references env, not the value
  });

  it("passes the token only through the env", () => {
    expect(gitCredentialEnv(TOKEN).GIT_SYNC_TOKEN).toBe(TOKEN);
  });

  it("appends an inline credential helper when a token is present", () => {
    const args = gitCredentialArgs(TOKEN);
    expect(args.filter((a) => a === "credential.helper=").length).toBe(1); // host-helper reset
    expect(args.some((a) => a.startsWith("credential.helper=!"))).toBe(true); // our helper
  });

  it("without a token, only resets the host helper chain (no auth helper, no leak)", () => {
    expect(gitCredentialArgs(undefined)).toEqual(["-c", "credential.helper="]);
    expect(gitCredentialEnv(undefined).GIT_SYNC_TOKEN).toBe("");
  });
});

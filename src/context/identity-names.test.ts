// A named agent kept re-asking "what's my call sign" on local models: the
// names sat in the memory context block, which the weak tier strips and the
// constrained-local budget sheds. These pin the extraction that runs before
// either, and the rendered block the prompt's precondition reads.
import { describe, expect, it } from "vitest";
import { identityNamesFrom, renderIdentityNames } from "./identity-names.js";

const BLOCK = `<agent_identity>
[provenance: personality memory-file]
# Identity
- Name: Nova
- Role: operations agent
</agent_identity>
<agent_heart>
- Name: should not be read from here
</agent_heart>
<user_profile>
[provenance: personality memory-file]
- Name: Peter
- Location: McKinney
</user_profile>
<core_memory>
- Name: Decoy
</core_memory>`;

describe("identityNamesFrom — the two names, from their own blocks only", () => {
  it("reads the agent's and the user's Name and ignores every other block", () => {
    expect(identityNamesFrom(BLOCK)).toEqual({ agent: "Nova", user: "Peter" });
  });

  it("treats the personality placeholders as no name", () => {
    const empty = `<agent_identity>\n- Name: (not yet named)\n</agent_identity>\n<user_profile>\n- Name:\n</user_profile>`;
    expect(identityNamesFrom(empty)).toEqual({});
    expect(identityNamesFrom("")).toEqual({});
  });

  it("one known name is carried on its own", () => {
    const only = `<agent_identity>\n- Name: Nova\n</agent_identity>`;
    expect(identityNamesFrom(only)).toEqual({ agent: "Nova" });
  });
});

describe("renderIdentityNames — the block the precondition checks first", () => {
  it("renders both names, one name, or nothing", () => {
    expect(renderIdentityNames({ agent: "Nova", user: "Peter" })).toBe("<identity_names>\n- Agent Name: Nova\n- User Name: Peter\n</identity_names>");
    expect(renderIdentityNames({ user: "Peter" })).toBe("<identity_names>\n- User Name: Peter\n</identity_names>");
    expect(renderIdentityNames({})).toBe("");
  });
});

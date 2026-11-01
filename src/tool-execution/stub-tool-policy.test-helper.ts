// The policy a pipeline test dispatches under: the default policy, plus an
// allow rule for each tool the test made up (a name with no policy row). A
// dispatch with no policy is judged by the installed one (pre-dispatch.ts),
// whose default-deny refuses a name it has no row for — right in production,
// where every tool has a row, and the opposite of what a test of the
// pipeline's other phases wants for its stub `echo`. Real tool names keep
// their real rules.
import { ToolPolicy, stampedDefaultPolicy } from "../tool-policy/index.js";
import { policyRowOf } from "../tool-registry.js";

export function withStubTools(toolNames: Iterable<string>): ToolPolicy {
  const base = stampedDefaultPolicy();
  const stubs = [...toolNames].filter((name) => !policyRowOf(name));
  return new ToolPolicy({
    ...base,
    rules: [
      ...stubs.map((tool) => ({ id: `test-stub-${tool}`, tool, decision: "allow" as const, reason: "a tool this test defines", priority: 50 })),
      ...base.rules,
    ],
  });
}

import { beforeAll, describe, it, expect } from "vitest";
import { AppRegistry } from "../../app-runtime/index.js";
import { appPermissions } from "./lifecycle.js";
import { appAction, appQuery, appRead } from "./runtime.js";
import { APP_TOOL_ACTOR } from "./shared.js";

// An app's owner and access list are checked against the actor the app tools
// pass, and the app routes act as "user", who may do anything. A tool that
// took its actor from the call's arguments would let a model claim the user's
// access to every app the user owns.
describe("the app tools act as the agent, whatever identity the arguments claim", () => {
  const registry = AppRegistry.getInstance();
  const id = "users-private-app";

  beforeAll(() => {
    const now = Date.now();
    const created = registry.create({
      id, name: "Private", description: "", components: [], dataBindings: [], actions: [], events: [],
      layout: { type: "stack" }, status: "active", version: 1, createdAt: now, updatedAt: now,
      permissions: { owner: "user", visibility: "private", allowedAgents: [], accessLevels: {} },
    }, "user");
    expect(created.error).toBeUndefined();
    // The claim would open the app if a tool honored it.
    expect(registry.checkAccess(id, "user", "admin").allowed).toBe(true);
    expect(registry.checkAccess(id, APP_TOOL_ACTOR, "read").allowed).toBe(false);
  });

  for (const claim of [{ _actor: "user" }, { _agentId: "user" }]) {
    it(`${Object.keys(claim)[0]}: "user" neither reads, drives, nor grants itself a private app of the user's`, async () => {
      expect((await appRead.execute({ id, ...claim })).isError).toBe(true);
      expect((await appQuery.execute({ id, query: "values", ...claim })).isError).toBe(true);
      expect((await appAction.execute({ id, action: "refresh", ...claim })).isError).toBe(true);
      expect((await appPermissions.execute({ id, action: "grant", agentId: APP_TOOL_ACTOR, level: "admin", ...claim })).isError).toBe(true);
      expect(registry.checkAccess(id, APP_TOOL_ACTOR, "read").allowed).toBe(false);
    });
  }
});

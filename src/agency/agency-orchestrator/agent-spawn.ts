import type { AgencyAgent, AgencyConfig, AgencyPlan } from "../types.js";
import { getRole } from "../agent-roles.js";
import { AgencyMessageBus } from "../message-bus.js";
import { EventBus } from "../../event-bus.js";
import { nextAgentId } from "./ids.js";

export function spawnAgent(
  activePlan: AgencyPlan | null,
  config: AgencyConfig,
  messageBus: AgencyMessageBus,
  role: string,
  systemPrompt: string,
  tools: string[]
): AgencyAgent {
  if (activePlan && activePlan.agents.length >= config.maxAgents) {
    throw new Error(
      `Max agents (${config.maxAgents}) reached. Cannot spawn more.`
    );
  }

  const roleDef = getRole(role);
  const agent: AgencyAgent = {
    id: nextAgentId(),
    name: `${role}-${Date.now().toString(36)}`,
    role,
    status: "idle",
    systemPrompt: systemPrompt || roleDef?.systemPrompt || "",
    tools: tools.length > 0 ? tools : roleDef?.suggestedTools ?? [],
  };

  messageBus.subscribe(agent.id, (msg) => {
    if (msg.type === "request-info") {
      EventBus.emit("agency:info-request", {
        from: msg.from,
        to: agent.id,
        payload: msg.payload,
      });
    }
  });

  return agent;
}

/**
 * Mission Chaining — output of one mission feeds as input to the next.
 */

import type { Mission } from "../missions.js";
import type { ToolDefinition } from "../types.js";

export interface ChainLink {
  missionName: string;
  inputMapping?: Record<string, string>;
  outputKey?: string;
}

export interface MissionChain {
  name: string;
  description: string;
  links: ChainLink[];
}

export interface ChainExecutionState {
  chainName: string;
  currentIndex: number;
  outputs: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed";
  error?: string;
  startedAt: number;
  completedAt?: number;
}

const activeChains = new Map<string, ChainExecutionState>();

function generateChainId(): string {
  return `chain_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createChain(chain: MissionChain): MissionChain {
  if (chain.links.length < 2) {
    throw new Error("A chain must have at least 2 missions");
  }
  return chain;
}

export function startChain(chain: MissionChain): string {
  const id = generateChainId();
  activeChains.set(id, {
    chainName: chain.name,
    currentIndex: 0,
    outputs: {},
    status: "running",
    startedAt: Date.now(),
  });
  return id;
}

export function advanceChain(chainId: string, stepOutput: unknown): ChainLink | null {
  const state = activeChains.get(chainId);
  if (!state || state.status !== "running") return null;

  const currentLink = getChainLinks(chainId)?.[state.currentIndex];
  if (currentLink?.outputKey) {
    state.outputs[currentLink.outputKey] = stepOutput;
  }

  state.currentIndex++;
  const links = getChainLinks(chainId);
  if (!links || state.currentIndex >= links.length) {
    state.status = "completed";
    state.completedAt = Date.now();
    return null;
  }

  return links[state.currentIndex];
}

export function getChainState(chainId: string): ChainExecutionState | undefined {
  return activeChains.get(chainId);
}

export function resolveInputs(chainId: string, link: ChainLink): Record<string, unknown> {
  const state = activeChains.get(chainId);
  if (!state || !link.inputMapping) return {};

  const resolved: Record<string, unknown> = {};
  for (const [paramName, outputRef] of Object.entries(link.inputMapping)) {
    resolved[paramName] = state.outputs[outputRef];
  }
  return resolved;
}

export function failChain(chainId: string, error: string): void {
  const state = activeChains.get(chainId);
  if (state) {
    state.status = "failed";
    state.error = error;
    state.completedAt = Date.now();
  }
}

const chainDefinitions = new Map<string, MissionChain>();

function getChainLinks(chainId: string): ChainLink[] | undefined {
  const state = activeChains.get(chainId);
  if (!state) return undefined;
  return chainDefinitions.get(state.chainName)?.links;
}

export function createChainTools(): ToolDefinition[] {
  return [
    {
      name: "mission_chain_create",
      description: "Create a mission chain where output of one mission feeds into the next.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Chain name" },
          description: { type: "string", description: "What this chain does" },
          links: {
            type: "array",
            items: {
              type: "object",
              properties: {
                missionName: { type: "string" },
                inputMapping: { type: "object", description: "Maps param names to output keys from previous missions" },
                outputKey: { type: "string", description: "Key to store this mission's output under" },
              },
              required: ["missionName"],
            },
            description: "Ordered list of missions in the chain",
          },
        },
        required: ["name", "description", "links"],
      },
      async execute(args) {
        try {
          const chain = createChain({
            name: String(args.name),
            description: String(args.description),
            links: args.links as ChainLink[],
          });
          chainDefinitions.set(chain.name, chain);
          return { content: `Created chain "${chain.name}" with ${chain.links.length} missions: ${chain.links.map(l => l.missionName).join(" → ")}` };
        } catch (e: any) {
          return { content: e.message, isError: true };
        }
      },
    },
    {
      name: "mission_chain_start",
      description: "Start executing a mission chain.",
      parameters: {
        type: "object",
        properties: {
          chainName: { type: "string", description: "Name of the chain to execute" },
        },
        required: ["chainName"],
      },
      async execute(args) {
        const chain = chainDefinitions.get(String(args.chainName));
        if (!chain) return { content: `Chain "${args.chainName}" not found.` };
        const id = startChain(chain);
        const firstLink = chain.links[0];
        return {
          content: `Chain started. ID: ${id}\nFirst mission: ${firstLink.missionName}\nExecute it and call mission_chain_advance with the output.`,
        };
      },
    },
    {
      name: "mission_chain_advance",
      description: "Advance a chain to the next mission, providing output from the current one.",
      parameters: {
        type: "object",
        properties: {
          chainId: { type: "string", description: "Chain execution ID" },
          output: { type: "string", description: "Output from the current mission step" },
        },
        required: ["chainId", "output"],
      },
      async execute(args) {
        const chainId = String(args.chainId);
        const nextLink = advanceChain(chainId, args.output);
        if (!nextLink) {
          const state = getChainState(chainId);
          return { content: `Chain ${state?.status === "completed" ? "completed" : "not found or already done"}. Outputs: ${JSON.stringify(state?.outputs ?? {})}` };
        }
        const inputs = resolveInputs(chainId, nextLink);
        return {
          content: `Next mission: ${nextLink.missionName}\nInputs from previous missions: ${JSON.stringify(inputs)}`,
        };
      },
    },
  ];
}

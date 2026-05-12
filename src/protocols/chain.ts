/**
 * Protocol Chaining — output of one protocol feeds as input to the next.
 */

import { randomBytes } from "node:crypto";
import type { ToolDefinition } from "../types.js";

export interface ChainLink {
  protocolName: string;
  inputMapping?: Record<string, string>;
  outputKey?: string;
}

export interface ProtocolChain {
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
  return `chain_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

export function createChain(chain: ProtocolChain): ProtocolChain {
  if (chain.links.length < 2) {
    throw new Error("A chain must have at least 2 protocols");
  }
  return chain;
}

export function startChain(chain: ProtocolChain): string {
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

const chainDefinitions = new Map<string, ProtocolChain>();

function getChainLinks(chainId: string): ChainLink[] | undefined {
  const state = activeChains.get(chainId);
  if (!state) return undefined;
  return chainDefinitions.get(state.chainName)?.links;
}

export function createChainTools(): ToolDefinition[] {
  return [
    {
      name: "protocol_chain_create",
      description: "Create a protocol chain where output of one protocol feeds into the next.",
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
                protocolName: { type: "string" },
                inputMapping: { type: "object", description: "Maps param names to output keys from previous protocols" },
                outputKey: { type: "string", description: "Key to store this protocol's output under" },
              },
              required: ["protocolName"],
            },
            description: "Ordered list of protocols in the chain",
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
          return { content: `Created chain "${chain.name}" with ${chain.links.length} missions: ${chain.links.map(l => l.protocolName).join(" → ")}` };
        } catch (e: any) {
          return { content: e.message, isError: true };
        }
      },
    },
    {
      name: "protocol_chain_start",
      description: "Start executing a protocol chain.",
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
          content: `Chain started. ID: ${id}\nFirst protocol: ${firstLink.protocolName}\nExecute it and call protocol_chain_advance with the output.`,
        };
      },
    },
    {
      name: "protocol_chain_advance",
      description: "Advance a chain to the next protocol, providing output from the current one.",
      parameters: {
        type: "object",
        properties: {
          chainId: { type: "string", description: "Chain execution ID" },
          output: { type: "string", description: "Output from the current protocol step" },
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
          content: `Next protocol: ${nextLink.protocolName}\nInputs from previous protocols: ${JSON.stringify(inputs)}`,
        };
      },
    },
  ];
}

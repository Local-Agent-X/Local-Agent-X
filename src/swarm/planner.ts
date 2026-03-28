// Swarm Planner -- Automatic task decomposition and dependency resolution

import type {
  SwarmTask,
  SwarmPlan,
  DependencyGraph,
  TaskStatus,
} from "./types.js";
import type { AgentRole } from "./agent-roles.js";
import { getRole, listRoles } from "./agent-roles.js";
import { EventBus } from "../event-bus.js";

let taskCounter = 0;
function nextTaskId(): string {
  return `task-${++taskCounter}-${Date.now().toString(36)}`;
}

// Decomposition pattern types
type PatternKind = "pipeline" | "fan-out" | "loop";

interface DecompositionPattern {
  kind: PatternKind;
  match: (goal: string) => boolean;
  apply: (goal: string) => SwarmTask[];
}

// Heuristic keyword sets for pattern matching
const PIPELINE_KEYWORDS = [
  "then",
  "after that",
  "followed by",
  "step by step",
  "sequentially",
  "first",
  "next",
  "finally",
];
const FANOUT_KEYWORDS = [
  "simultaneously",
  "in parallel",
  "at the same time",
  "all of",
  "each",
  "every",
  "multiple",
  "compare",
];
const LOOP_KEYWORDS = [
  "until",
  "keep",
  "repeat",
  "retry",
  "monitor",
  "watch",
  "poll",
  "check regularly",
];

function matchKeywords(goal: string, keywords: string[]): boolean {
  const lower = goal.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function splitGoalIntoParts(goal: string): string[] {
  // Split on common delimiters: numbered lists, "and", commas, semicolons
  const parts = goal
    .split(/(?:\d+\.\s+)|(?:\band\b)|[;,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);
  return parts.length > 1 ? parts : [goal];
}

const patterns: DecompositionPattern[] = [
  {
    kind: "pipeline",
    match: (goal) => matchKeywords(goal, PIPELINE_KEYWORDS),
    apply(goal) {
      const parts = splitGoalIntoParts(goal);
      const tasks: SwarmTask[] = [];
      let prevId: string | null = null;
      for (const part of parts) {
        const id = nextTaskId();
        tasks.push({
          id,
          description: part,
          dependsOn: prevId ? [prevId] : [],
          status: "pending" as TaskStatus,
        });
        prevId = id;
      }
      return tasks;
    },
  },
  {
    kind: "fan-out",
    match: (goal) => matchKeywords(goal, FANOUT_KEYWORDS),
    apply(goal) {
      const parts = splitGoalIntoParts(goal);
      const tasks: SwarmTask[] = [];
      // All parallel tasks
      const parallelIds: string[] = [];
      for (const part of parts) {
        const id = nextTaskId();
        tasks.push({
          id,
          description: part,
          dependsOn: [],
          status: "pending" as TaskStatus,
        });
        parallelIds.push(id);
      }
      // Merge task depends on all parallel tasks
      if (parallelIds.length > 1) {
        tasks.push({
          id: nextTaskId(),
          description: "Combine and summarize results from all parallel tasks",
          dependsOn: parallelIds,
          status: "pending" as TaskStatus,
        });
      }
      return tasks;
    },
  },
  {
    kind: "loop",
    match: (goal) => matchKeywords(goal, LOOP_KEYWORDS),
    apply(goal) {
      const checkId = nextTaskId();
      const actionId = nextTaskId();
      const evalId = nextTaskId();
      return [
        {
          id: checkId,
          description: `Initial check: ${goal}`,
          dependsOn: [],
          status: "pending" as TaskStatus,
        },
        {
          id: actionId,
          description: `Take action based on check results`,
          dependsOn: [checkId],
          status: "pending" as TaskStatus,
        },
        {
          id: evalId,
          description: `Evaluate outcome and determine if goal is met`,
          dependsOn: [actionId],
          status: "pending" as TaskStatus,
        },
      ];
    },
  },
];

export class SwarmPlanner {
  decompose(goal: string): SwarmTask[] {
    // Try each pattern in order; first match wins
    for (const pattern of patterns) {
      if (pattern.match(goal)) {
        const tasks = pattern.apply(goal);
        EventBus.emit("swarm:decompose", { goal, pattern: pattern.kind, taskCount: tasks.length });
        return tasks;
      }
    }
    // Default: single task for simple goals
    return [
      {
        id: nextTaskId(),
        description: goal,
        dependsOn: [],
        status: "pending" as TaskStatus,
      },
    ];
  }

  assignRoles(tasks: SwarmTask[]): Map<string, AgentRole> {
    const available = listRoles();
    const assignments = new Map<string, AgentRole>();

    for (const task of tasks) {
      const role = pickBestRole(task.description, available);
      assignments.set(task.id, role);
    }

    return assignments;
  }

  buildDependencyGraph(tasks: SwarmTask[]): DependencyGraph {
    const nodes = tasks.map((t) => t.id);
    const edges = new Map<string, string[]>();

    for (const task of tasks) {
      edges.set(task.id, [...task.dependsOn]);
    }

    const order = topologicalSort(nodes, edges);
    return { nodes, edges, order };
  }

  optimize(plan: SwarmPlan): SwarmPlan {
    const tasks = [...plan.tasks];

    // Merge small independent tasks that share the same likely role
    const independentGroups = new Map<string, SwarmTask[]>();
    for (const task of tasks) {
      if (task.dependsOn.length === 0 && task.description.length < 40) {
        const roleKey = guessRoleKey(task.description);
        let group = independentGroups.get(roleKey);
        if (!group) {
          group = [];
          independentGroups.set(roleKey, group);
        }
        group.push(task);
      }
    }

    // Merge groups of 2+ small tasks into one
    const merged: Set<string> = new Set();
    const newTasks: SwarmTask[] = [];
    for (const [, group] of independentGroups) {
      if (group.length >= 2) {
        const combined: SwarmTask = {
          id: nextTaskId(),
          description: group.map((t) => t.description).join("; "),
          dependsOn: [],
          status: "pending",
        };
        newTasks.push(combined);
        for (const t of group) merged.add(t.id);

        // Re-point any dependents to the merged task
        for (const task of tasks) {
          task.dependsOn = task.dependsOn.map((dep) =>
            merged.has(dep) ? combined.id : dep
          );
        }
      }
    }

    const finalTasks = [
      ...newTasks,
      ...tasks.filter((t) => !merged.has(t.id)),
    ];

    return { ...plan, tasks: finalTasks };
  }
}

// Topological sort using Kahn's algorithm
function topologicalSort(
  nodes: string[],
  edges: Map<string, string[]>
): string[] {
  const inDegree = new Map<string, number>();
  for (const n of nodes) inDegree.set(n, 0);

  for (const [, deps] of edges) {
    for (const dep of deps) {
      // dep -> node means node depends on dep; dep has outgoing edge to node
    }
  }

  // Count incoming edges per node
  for (const [node, deps] of edges) {
    inDegree.set(node, deps.length);
  }

  const queue: string[] = [];
  for (const [node, deg] of inDegree) {
    if (deg === 0) queue.push(node);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);

    // Find nodes that depend on current and decrement their in-degree
    for (const [node, deps] of edges) {
      if (deps.includes(current)) {
        const newDeg = (inDegree.get(node) ?? 0) - 1;
        inDegree.set(node, newDeg);
        if (newDeg === 0) queue.push(node);
      }
    }
  }

  if (order.length !== nodes.length) {
    throw new Error("Circular dependency detected in swarm task graph");
  }

  return order;
}

// Simple keyword-based role guessing
const ROLE_KEYWORDS: Record<string, string[]> = {
  researcher: ["search", "find", "look up", "research", "investigate", "source"],
  writer: ["write", "draft", "compose", "edit", "blog", "article", "copy"],
  coder: ["code", "implement", "build", "fix", "debug", "script", "function", "api", "deploy"],
  reviewer: ["review", "check", "verify", "validate", "approve", "quality"],
  "social-media": ["post", "tweet", "social", "instagram", "caption", "hashtag"],
  analyst: ["analyze", "data", "report", "trend", "metric", "statistics", "chart"],
  monitor: ["monitor", "watch", "alert", "status", "uptime", "poll"],
  designer: ["design", "image", "logo", "layout", "visual", "graphic", "ui"],
  ops: ["deploy", "server", "infrastructure", "devops", "pipeline", "ci"],
  communicator: ["email", "slack", "notify", "message", "send", "communicate"],
};

function guessRoleKey(description: string): string {
  const lower = description.toLowerCase();
  let best = "coder";
  let bestScore = 0;
  for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
    const score = keywords.filter((kw) => lower.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      best = role;
    }
  }
  return best;
}

function pickBestRole(description: string, roles: AgentRole[]): AgentRole {
  const key = guessRoleKey(description);
  const match = roles.find((r) => r.name === key);
  return match ?? roles.find((r) => r.name === "coder") ?? roles[0];
}

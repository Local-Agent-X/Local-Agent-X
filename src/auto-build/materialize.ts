import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { verifyWriteLanded } from "../tools/verify.js";

export interface ArtifactInput {
  filename: string;
  content: string;
}

export interface MaterializeAppBuildInput {
  projectDir: string;
  projectName: string;
  productMd: string;
  constitutionMd: string;
  planMd: string;
  architectureMd?: string;
  scenarios: ArtifactInput[];
  twins: ArtifactInput[];
  signal?: AbortSignal;
}

export interface MaterializeAppBuildResult {
  written: string[];
}

export type AppBuildMaterializer = (
  input: MaterializeAppBuildInput,
) => MaterializeAppBuildResult;

interface MaterializerDeps {
  writeFile: (path: string, data: string) => void;
  verify: (path: string) => ReturnType<typeof verifyWriteLanded>;
}

interface QueuedArtifact {
  rel: string;
  content: string;
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function validateRelPath(name: string, prefix: string): void {
  if (!name || typeof name !== "string") {
    throw new Error(`${prefix} entry: filename missing`);
  }
  if (name.includes("..")) {
    throw new Error(`${prefix}${name}: path traversal not allowed`);
  }
  if (isAbsolute(name)) {
    throw new Error(`${prefix}${name}: absolute paths not allowed`);
  }
  if (name.split(/[\\/]/).some(segment => !segment || segment === ".")) {
    throw new Error(`${prefix}${name}: invalid path segment`);
  }
  if (name.startsWith("/") || name.startsWith("\\") || /[\\/]$/.test(name)) {
    throw new Error(`${prefix}${name}: invalid leading or trailing slash`);
  }
}

function collisionKey(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function validateNoCollisions(queued: QueuedArtifact[]): void {
  const paths = queued.map(item => ({ rel: item.rel, key: collisionKey(item.rel) }));
  for (let index = 0; index < paths.length; index += 1) {
    const current = paths[index];
    for (let otherIndex = 0; otherIndex < index; otherIndex += 1) {
      const other = paths[otherIndex];
      if (
        current.key === other.key
        || current.key.startsWith(other.key + "/")
        || other.key.startsWith(current.key + "/")
      ) {
        throw new Error(`artifact path collision: ${other.rel} conflicts with ${current.rel}`);
      }
    }
  }
}

function buildQueue(input: MaterializeAppBuildInput): QueuedArtifact[] {
  const queued: QueuedArtifact[] = [
    { rel: "spec/product.md", content: input.productMd },
    { rel: "spec/constitution.md", content: input.constitutionMd },
    { rel: "spec/plan.md", content: input.planMd },
  ];
  if (input.architectureMd) {
    queued.push({ rel: "spec/architecture.md", content: input.architectureMd });
  }
  for (const scenario of input.scenarios) {
    validateRelPath(scenario.filename, "scenarios/");
    queued.push({ rel: join("scenarios", scenario.filename), content: scenario.content });
  }
  for (const twin of input.twins) {
    validateRelPath(twin.filename, "twins/");
    queued.push({ rel: join("twins", twin.filename), content: twin.content });
  }
  const readme =
    `# ${input.projectName}\n\n` +
    `Project initialized via \`finalize_app_build\` from a /app-build planning session.\n\n` +
    `## Build\n\n` +
    `Product Build owns orchestration after finalization; use \`build_plan_status\` to inspect it.\n\n` +
    `## Layout\n\n` +
    `- \`spec/\` — product, constitution, plan; the source of truth the building agents read.\n` +
    `- \`scenarios/\` — held-out user-flow tests. **Building agents must never read this.**\n` +
    (input.twins.length > 0
      ? `- \`twins/\` — in-process fakes for external services.\n`
      : "");
  queued.push({ rel: "README.md", content: readme });
  validateNoCollisions(queued);
  return queued;
}

export function createAppBuildMaterializer(
  overrides: Partial<MaterializerDeps> = {},
): AppBuildMaterializer {
  const deps: MaterializerDeps = {
    writeFile: overrides.writeFile ?? writeFileSync,
    verify: overrides.verify ?? verifyWriteLanded,
  };

  return input => {
    throwIfAborted(input.signal);
    const queued = buildQueue(input);
    const projectExisted = existsSync(input.projectDir);
    if (projectExisted && readdirSync(input.projectDir).length > 0) {
      throw new Error(`project_dir became non-empty before materialization: ${input.projectDir}`);
    }

    const parent = dirname(input.projectDir);
    mkdirSync(parent, { recursive: true });
    const stageDir = join(
      parent,
      `.${basename(input.projectDir)}.lax-finalize-${randomBytes(6).toString("hex")}`,
    );
    const written: string[] = [];
    mkdirSync(stageDir, { recursive: false });

    try {
      for (const item of queued) {
        throwIfAborted(input.signal);
        const abs = join(stageDir, item.rel);
        mkdirSync(dirname(abs), { recursive: true });
        deps.writeFile(abs, item.content);
        throwIfAborted(input.signal);
        const verified = deps.verify(abs);
        if (!verified.ok) {
          throw new Error(`verify failed for ${item.rel}: ${verified.reason}`);
        }
        written.push(item.rel.replace(/\\/g, "/"));
      }

      throwIfAborted(input.signal);
      if (existsSync(input.projectDir)) {
        if (!projectExisted || readdirSync(input.projectDir).length > 0) {
          throw new Error(`project_dir changed during materialization: ${input.projectDir}`);
        }
        rmdirSync(input.projectDir);
      }
      try {
        renameSync(stageDir, input.projectDir);
      } catch (error) {
        if (projectExisted && !existsSync(input.projectDir)) {
          mkdirSync(input.projectDir, { recursive: true });
        }
        throw error;
      }
      return { written };
    } catch (error) {
      rmSync(stageDir, { recursive: true, force: true });
      throw error;
    }
  };
}

export const materializeAppBuild = createAppBuildMaterializer();

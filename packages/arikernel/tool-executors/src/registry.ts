import type { ToolClass } from "@arikernel/core";
import type { ToolExecutor } from "./base.js";
import { DatabaseExecutor } from "./database.js";
import { FileExecutor } from "./file.js";
import { HttpExecutor } from "./http.js";
import { RetrievalExecutor } from "./retrieval.js";
import { ShellExecutor } from "./shell.js";

/**
 * Passive executor store keyed by `toolClass`. Closes DRY-AUDIT.md F2
 * (part 1) — what used to be a self-constructing parallel registry is
 * now an empty store filled from the outside. The SAX side mirrors
 * entries from the unified tool registry (src/tools/registry.ts) at
 * boot, while standalone callers use `ExecutorRegistry.withDefaults()`
 * to retain the prior plug-and-play behavior.
 */
export class ExecutorRegistry {
	private executors = new Map<string, ToolExecutor>();

	register(executor: ToolExecutor): void {
		this.executors.set(executor.toolClass, executor);
	}

	get(toolClass: ToolClass): ToolExecutor | undefined {
		return this.executors.get(toolClass);
	}

	has(toolClass: ToolClass): boolean {
		return this.executors.has(toolClass);
	}

	/**
	 * Factory for callers that want the historical five-default loadout
	 * (http, file, shell, database, retrieval). The `Firewall` constructor
	 * uses this to keep its API unchanged after the registry stopped
	 * self-constructing in `new ExecutorRegistry()`.
	 */
	static withDefaults(): ExecutorRegistry {
		const reg = new ExecutorRegistry();
		reg.register(new HttpExecutor());
		reg.register(new FileExecutor());
		reg.register(new ShellExecutor());
		reg.register(new DatabaseExecutor());
		reg.register(new RetrievalExecutor());
		return reg;
	}
}

/**
 * How a role, kit, template, background job or surface chooses its tools: by
 * what each tool is for (its row's `tags`, src/tool-policy/tool-tags.ts), so a
 * tool joins every set that wants its purpose by saying what it does. The
 * harness's own worker kits are named once here and the runners spread them;
 * a kit named in three runners drifted (the surgeon and the chunk runners each
 * kept their own copy of the same six names).
 */
import { policyRowOf, toolsTagged } from "../tool-registry.js";
import type { ToolTag } from "../tool-policy/tool-tags.js";

/** A set of tools chosen by purpose, with the deliberate exceptions named: a
 *  tool `plus` adds that no tag of the set covers, a tool `except` drops that
 *  one does, each with its one-line reason. */
export interface ToolSelection {
  tags: readonly ToolTag[];
  plus?: Readonly<Record<string, string>>;
  except?: Readonly<Record<string, string>>;
}

/** The tools of `selection`: the tagged ones in table order, then the `plus`
 *  ones. Throws when an exception names a
 *  tool with no row, a `plus` the tags already cover, or an `except` they do
 *  not: an exception that does nothing is a stale one. */
export function selectTools(selection: ToolSelection): string[] {
  const tagged = toolsTagged(...selection.tags);
  const plus = Object.keys(selection.plus ?? {});
  const except = Object.keys(selection.except ?? {});
  for (const name of [...plus, ...except]) {
    if (!policyRowOf(name)) throw new Error(`tool selection names "${name}", which has no policy row`);
  }
  const redundant = plus.filter((name) => tagged.includes(name));
  const idle = except.filter((name) => !tagged.includes(name));
  if (redundant.length > 0) throw new Error(`tool selection adds ${redundant.join(", ")}, which its tags [${selection.tags.join(", ")}] already cover`);
  if (idle.length > 0) throw new Error(`tool selection drops ${idle.join(", ")}, which its tags [${selection.tags.join(", ")}] do not cover`);
  return [...tagged.filter((name) => !except.includes(name)), ...plus];
}

/** What a coding worker needs: read, discover, modify, run. The self_edit
 *  surgeon, the auto-build chunk runners and the app-builder worker all start
 *  from it; the builder adds the web and a viewer. */
export const CODING_KIT: readonly string[] = ["read", "write", "edit", "glob", "grep", "bash"];

/** The coding kit plus the web and an image viewer: the app-builder worker and
 *  the generic Worker template, which build against live references. */
export const BUILDER_KIT: readonly string[] = [...CODING_KIT, "web_fetch", "web_search", "view_image"];

/** The Office umbrella tools (each covers create/edit/read actions). A worker
 *  delegated a deck/doc/sheet/pdf task needs them: its bash is denied in a
 *  delegated session, so without these it has no route to the file at all. */
export const OFFICE_KIT: readonly string[] = ["presentation", "document", "spreadsheet", "pdf"];

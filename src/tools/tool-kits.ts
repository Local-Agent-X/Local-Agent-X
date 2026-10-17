/**
 * Tool sets the harness's own workers start from. A worker's tools are its
 * capability boundary (tool-augmentation.ts), so each kit is named once here
 * and the runners spread it; a kit named in three runners drifted (the surgeon
 * and the chunk runners each kept their own copy of the same six names).
 */

/** What a coding worker needs: read, discover, modify, run. The self_edit
 *  surgeon, the auto-build chunk runners and the app-builder worker all start
 *  from it; the builder adds the web and a viewer. */
export const CODING_KIT: readonly string[] = ["read", "write", "edit", "glob", "grep", "bash"];

/** The coding kit plus the web and an image viewer: the app-builder worker and
 *  the generic Worker template, which build against live references. */
export const BUILDER_KIT: readonly string[] = [...CODING_KIT, "web_fetch", "web_search", "view_image"];

// Shared mutable state for the Agents page. Every submodule imports this
// object instead of holding its own copy — keeps `_currentProject`,
// provider registry cache, and the org-chart drag state consistent across
// tab boundaries.

export const state = {
  // Selected project ID — '' means "All Projects" (template view).
  // Switched via the project-select dropdown at the top of the page.
  currentProject: '',
  // Provider registry cache (first hired-agent panel open hydrates it).
  // Shape: [{id, label, models[], defaultModel}]. Source of truth:
  // GET /api/providers/registry → src/providers/registry.ts.
  providerRegistry: null,
  // Org-chart drag state. _orgAgents is the fetched hired list for the
  // current project; _orgDragId is the id of the node currently being
  // dragged (null when no drag in flight).
  orgAgents: [],
  orgDragId: null,
};

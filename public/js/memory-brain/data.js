// Fetches the memory atlas: per-memory records plus (once computed) a 3D layout
// position and cluster id on each item, and the cluster list (label + color).
// Uses the shared authed apiJson helper — a raw fetch gets 401'd since /api/*
// requires the bearer token. The first call may take several seconds while the
// layout computes server-side; it's cached after.

export async function loadAtlas() {
  try {
    const r = await window.apiJson('/api/memory/atlas');
    return {
      total: typeof r.total === 'number' ? r.total : 0,
      items: Array.isArray(r.items) ? r.items : [],
      clusters: Array.isArray(r.clusters) ? r.clusters : [],
    };
  } catch {
    return { total: 0, items: [], clusters: [] };
  }
}

export async function loadChunk(id) {
  try {
    return await window.apiJson('/api/memory/chunk?id=' + id);
  } catch {
    return null;
  }
}

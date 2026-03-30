/** Stub — app renderer (placeholder for full implementation) */
export function renderApp(def: any, port?: number): string {
  return `<!DOCTYPE html><html><head><title>${def?.name || "App"}</title></head><body><h1>${def?.name || "App"}</h1></body></html>`;
}

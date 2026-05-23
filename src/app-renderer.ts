/**
 * App Renderer — generates secure, standalone HTML from an AppDefinition.
 *
 * Security hardening:
 * - Nonce-based CSP for inline scripts
 * - Strict HTML escaping on all user-provided content
 * - No eval(), no Function(), no inline event handler strings from untrusted sources
 * - Custom HTML components are sanitized (dangerous tags stripped)
 * - Token isolation — auth tokens cleared before app code runs
 * - X-Frame-Options, X-Content-Type-Options, Referrer-Policy headers (set by server)
 *
 * Composition lives in src/app-renderer/:
 *   - sanitize.ts       — escapeHtml / sanitizeHtml / escapeJs / safeStr
 *   - components.ts     — renderComponent (per-type HTML)
 *   - layout.ts         — renderLayout (grid/flex/stack/tabs/sidebar)
 *   - styles.ts         — APP_STYLES (static CSS)
 *   - client-script.ts  — renderClientScript (poll loop, event dispatch, DOM sanitize)
 *   - page.ts           — renderApp (orchestrator assembling the document)
 */

export { renderApp } from "./app-renderer/page.js";

// Backward compatibility
export { renderApp as renderDashboard } from "./app-renderer/page.js";

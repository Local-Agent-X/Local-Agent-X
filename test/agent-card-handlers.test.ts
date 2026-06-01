// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

let renderAgentCard: (agent: Record<string, unknown>) => string;
let sanitizeHtml: (h: string) => string;

beforeAll(() => {
  const escSrc = readFileSync(join(here, "../public/js/shared-escape.js"), "utf8");
  const cardSrc = readFileSync(join(here, "../public/js/chat-agent-feeds-render.js"), "utf8");
  // eslint-disable-next-line no-new-func
  const factory = new Function(escSrc + "\n" + cardSrc + "\nreturn { renderAgentCard, sanitizeHtml };");
  ({ renderAgentCard, sanitizeHtml } = factory());
});

describe("agent worker-card markup carries no inline event handlers", () => {
  const agent = { id: "op-123", name: "Researcher", role: "researcher", status: "working", output: "did a thing" };

  it("emits no on* handler attributes", () => {
    const html = renderAgentCard(agent);
    expect(html).not.toMatch(/\son\w+\s*=/i);
  });

  it("wires controls via data-agent-action", () => {
    const html = renderAgentCard(agent);
    for (const action of ["pause", "redirect", "stayinline", "cancel", "dismiss"]) {
      expect(html).toContain(`data-agent-action="${action}"`);
    }
    expect(html).toContain('data-agent-id="op-123"');
  });

  it("wires the activity toggle and redirect input via data attributes", () => {
    const html = renderAgentCard(agent);
    expect(html).toContain('data-agent-toggle="tools"');
    expect(html).toContain('data-agent-redirect="op-123"');
  });

  it("shows Resume instead of Pause when paused", () => {
    const html = renderAgentCard({ ...agent, status: "paused" });
    expect(html).toContain('data-agent-action="resume"');
    expect(html).not.toContain('data-agent-action="pause"');
  });

  it("survives the structural sanitizer with controls intact (now sanitizer-safe)", () => {
    const clean = sanitizeHtml(renderAgentCard(agent));
    expect(clean).toContain('data-agent-action="cancel"');
    expect(clean).toContain('data-agent-id="op-123"');
    expect(clean).toContain('data-agent-toggle="tools"');
    expect(clean).not.toMatch(/\son\w+\s*=/i);
  });

  it("confines a breakout-style id to an inert data attribute, not a handler", () => {
    const payload = "');alert(1)//";
    const clean = sanitizeHtml(renderAgentCard({ ...agent, id: payload }));
    // No executable context anywhere — the payload can only ride as data.
    expect(clean).not.toMatch(/\son\w+\s*=/i);
    expect(clean).not.toContain("<script");
    const host = document.createElement("div");
    host.innerHTML = clean;
    const cancel = host.querySelector('[data-agent-action="cancel"]') as HTMLElement;
    expect(cancel.dataset.agentId).toBe(payload);
    for (const el of host.querySelectorAll("*")) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.startsWith("on")).toBe(false);
      }
    }
  });
});

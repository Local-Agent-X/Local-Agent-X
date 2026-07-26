import { describe, expect, it } from "vitest";
import { evaluateMutationReason } from "./page.js";

describe("evaluate mutation guard", () => {
  it("allows page inspection", () => {
    expect(evaluateMutationReason("({ title: document.title, text: document.body.innerText })")).toBeNull();
    expect(evaluateMutationReason("[...document.querySelectorAll('input')].map(el => el.value.length)")).toBeNull();
  });

  it("blocks raw form and DOM actions", () => {
    const scripts = [
      "document.querySelector('button').click()",
      "input.value = 'wrong field'",
      "input.dispatchEvent(new Event('input'))",
      "Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set?.call(input, 'x')",
      "overlay.remove()",
      "node.style.display = 'none'",
    ];
    for (const script of scripts) expect(evaluateMutationReason(script)).toMatch(/inspection-only/);
  });
});

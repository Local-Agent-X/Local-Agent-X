// Privacy-preserving secret capture from live browser pages.
//
// Problem: when an LLM agent reads a generated password/API key via
// browser.extract / screenshot-OCR / evaluate, the value travels through the
// model as tool-result text — so the provider (Anthropic/OpenAI/xAI) sees it.
//
// This tool reads the value server-side, writes it straight to the encrypted
// secrets vault, and returns ONLY a confirmation (name + metadata). The
// actual value never enters any tool result the LLM can see.
//
// Pattern: DOM read → Node process → secretsStore.set() → AES-256-GCM at rest.
// The model orchestrates but never touches the plaintext.

import type { ToolDefinition, ToolResult } from "../types.js";
import type { SecretsStore } from "../secrets.js";
import { getBrowserManager } from "./index.js";

function ok(content: string): ToolResult {
  return { content };
}

function err(content: string): ToolResult {
  return { content, isError: true };
}

export function createBrowserSecretCaptureTool(
  secretsStore: SecretsStore,
  getSessionId?: () => string,
): ToolDefinition {
  return {
    name: "browser_capture_to_secret",
    description:
      "Privacy-preserving capture: reads a value off the current browser page and writes it DIRECTLY to the encrypted secrets vault " +
      "without the value passing through you (the model) or any tool-result text. Use this for any one-shot or sensitive value shown on a page — " +
      "app passwords, API keys, OAuth tokens, recovery codes, TOTP seeds. The value never enters chat, session memory, or logs.\n\n" +
      "How it works: server-side DOM read → secretsStore.set() → returns only {ok: true, name, service, length}. " +
      "You never see the value; you reference it afterward via http_request placeholders like {{FASTMAIL_APP_PASSWORD}}.\n\n" +
      "Shape: pass a `selector` (CSS), `text_selector` (element whose textContent is the value), or `attribute_selector` (CSS + attribute name). " +
      "Prefer `selector` for <input> fields (reads .value); use `text_selector` for <code> / <pre> / <span> elements that display the value as text. " +
      "If you need the trimmed value (strip whitespace), pass trim: true (default).\n\n" +
      "ALWAYS use this tool for secrets. Never use browser.extract or browser.evaluate to read a secret — those leak to the LLM provider.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Secret name, SCREAMING_SNAKE_CASE (e.g. FASTMAIL_APP_PASSWORD, OPENAI_API_KEY).",
        },
        service: {
          type: "string",
          description: "Service name for display (e.g. 'Fastmail', 'OpenAI'). Optional but recommended.",
        },
        account: {
          type: "string",
          description: "Username/email paired with this password (e.g. 'peter@pmajlabs.com'). Recommended when creating new accounts — lets the user manually log in later.",
        },
        url: {
          type: "string",
          description: "Login URL for the service (e.g. 'https://app.fastmail.com/login'). Lets the user navigate back to use this credential.",
        },
        notes: {
          type: "string",
          description: "Free-form note shown in the Secrets UI — why this was created, scope, expiry, anything the user should remember.",
        },
        selector: {
          type: "string",
          description: "CSS selector for an <input>/<textarea> whose .value is the secret.",
        },
        text_selector: {
          type: "string",
          description: "CSS selector for an element whose textContent is the secret (e.g. <code>, <pre>, <span>).",
        },
        attribute_selector: {
          type: "string",
          description: "CSS selector for reading a specific attribute. Pair with `attribute` (e.g. 'data-token').",
        },
        attribute: {
          type: "string",
          description: "Attribute name to read when using attribute_selector.",
        },
        trim: {
          type: "boolean",
          description: "Strip leading/trailing whitespace. Default true.",
        },
      },
      required: ["name"],
    },
    async execute(args) {
      const rawName = String(args.name || "");
      const name = rawName.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      if (!name) return err("Secret name is required.");
      const sessionIdForLock = args._sessionId ? String(args._sessionId) : (getSessionId ? getSessionId() : "default");
      const { withBrowserLock } = await import("./index.js");
      return withBrowserLock(sessionIdForLock, async () => {

      const service = args.service ? String(args.service) : undefined;
      const account = args.account ? String(args.account) : undefined;
      const urlField = args.url ? String(args.url) : undefined;
      const notes = args.notes ? String(args.notes) : undefined;
      const trim = args.trim === false ? false : true;

      const selector = args.selector ? String(args.selector) : undefined;
      const textSelector = args.text_selector ? String(args.text_selector) : undefined;
      const attrSelector = args.attribute_selector ? String(args.attribute_selector) : undefined;
      const attribute = args.attribute ? String(args.attribute) : undefined;

      const strategies = [selector, textSelector, attrSelector].filter(Boolean).length;
      if (strategies === 0) {
        return err("Provide one of: selector, text_selector, or attribute_selector.");
      }
      if (strategies > 1) {
        return err("Provide only ONE of: selector, text_selector, or attribute_selector.");
      }
      if (attrSelector && !attribute) {
        return err("attribute_selector requires the `attribute` field.");
      }

      const sessionId = args._sessionId ? String(args._sessionId) : (getSessionId ? getSessionId() : "default");
      const manager = getBrowserManager(sessionId);

      let value: string | null = null;
      try {
        // Read the value server-side via the same page the agent is on.
        // We run a string-form evaluate so TypeScript doesn't try to type-check
        // DOM globals (which aren't in Node's lib). The returned string is
        // captured here and never placed into any tool result visible to the LLM.
        const page = await manager.getPage();
        const argsJson = JSON.stringify({
          sel: selector || null,
          textSel: textSelector || null,
          attrSel: attrSelector || null,
          attr: attribute || null,
        });
        const script = `(function(a){
          var s = a.sel || a.textSel || a.attrSel;
          var el = document.querySelector(s);
          if (!el) return null;
          if (a.sel) {
            if (el.value !== undefined && el.value !== null) return String(el.value);
            return el.textContent || '';
          }
          if (a.textSel) return el.textContent || '';
          if (a.attrSel && a.attr) return el.getAttribute(a.attr) || '';
          return null;
        })(${argsJson})`;
        const raw = await page.evaluate(script);
        value = typeof raw === "string" ? raw : null;
      } catch (e) {
        return err(`Capture failed: ${(e as Error).message}`);
      }

      if (value === null) {
        return err(`Element not found. Check the selector, make sure the page has the value visible (snapshot first), and retry.`);
      }
      if (trim) value = value.trim();
      if (!value) {
        return err(`Element was empty after ${trim ? "trim" : "read"}. The password may not have rendered yet — wait/snapshot and retry.`);
      }

      // Derive provenance: the origin of the page we captured from, and the
      // session that initiated the capture. Fill-from-secret uses these to
      // auto-approve same-session same-origin reuse without user prompts.
      let captureOrigin: string | undefined;
      try {
        const page = await manager.getPage();
        captureOrigin = new URL(page.url()).origin;
      } catch { /* best-effort */ }

      // Direct write to vault. AES-256-GCM at rest, master key in OS keychain.
      try {
        secretsStore.set(name, value, {
          service,
          account,
          url: urlField,
          notes,
          origin: captureOrigin,
          createdBySession: sessionId,
        });
      } catch (e) {
        return err(`Vault write failed: ${(e as Error).message}`);
      }

      // Deliberately zero local reference; Node will GC. This is belt-and-
      // braces — V8 may still hold it until the next GC pass.
      const len = value.length;
      value = null;

      return ok(
        `Captured into secrets vault: ${name}` +
        (service ? ` (service: ${service})` : "") +
        `. Length: ${len} chars. ` +
        `Value was NOT shown to you or logged. Reference it via {{${name}}} in http_request headers/body.`,
      );
      });
    },
  };
}

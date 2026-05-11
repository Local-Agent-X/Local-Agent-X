/**
 * Slash-command autocomplete popup for the chat input.
 *
 * Behavior matches Claude Code's affordance: typing `/` at the start of
 * the input opens a popup listing available commands. Filters as the
 * user types more characters after the slash. Arrow keys navigate;
 * Enter selects; Escape dismisses. Clicking an item also selects.
 *
 * Commands are fetched from `/api/protocols` on init (every protocol
 * the agent knows — typed packs + bundled SKILL.md + user-imported).
 * Falls back to a hardcoded list of the three bundled prompt-style
 * protocols if the fetch fails (e.g., user not authenticated yet).
 *
 * The popup is capped via CSS (max-height:280px; overflow-y:auto) so a
 * long list scrolls. Arrow navigation calls scrollIntoView so the
 * active row stays visible even when the list overflows.
 *
 * Wiring:
 *   - One input listener on #msg-input (textarea) — opens/updates/hides
 *   - One keydown listener (capture phase) on #msg-input — handles
 *     ArrowUp/Down/Enter/Escape when popup is open. Uses
 *     stopImmediatePropagation so the inline onkeydown="handleInputKeydown"
 *     in app.html doesn't also fire Enter as "send".
 *   - One click listener on the popup — selects on click.
 *
 * Single file, no DOM until the popup actually opens. Cheap.
 */

(function () {
  "use strict";

  // Fallback list if the /api/protocols fetch fails. Mirrors the three
  // prompt-style bundles in protocols/bundled/ so the popup still works
  // for an unauthenticated user or during a transient API outage.
  let COMMANDS = [
    { name: "app-build", description: "Plan a new app spec-first (drives the directed-build conversation)", category: "Developer" },
    { name: "senior-engineer", description: "Apply senior-engineer discipline (root cause, smallest correct change)", category: "Developer" },
    { name: "vibe-code", description: "Vibe-code a leaf feature responsibly (PM-for-the-model methodology)", category: "Developer" },
  ];

  // Category sort: pinned tier first, then alphabetical. "General" is a
  // catch-all so it sinks to the bottom.
  const CATEGORY_ORDER = ["Developer", "Social Media", "Communication", "Research", "Documents", "Smart Home"];
  function categoryRank(cat) {
    const i = CATEGORY_ORDER.indexOf(cat);
    if (i >= 0) return i;
    if (cat === "General") return 99;
    return 50; // unknown categories sit between pinned and "General"
  }

  let popupEl = null;
  let highlightedIdx = 0;
  let currentMatches = [];
  let textareaEl = null;

  function init() {
    textareaEl = document.getElementById("msg-input");
    if (!textareaEl) return;

    // Populate from /api/protocols in the background. Same endpoint the
    // Protocols browser uses — one source for both UIs. Fetch is async so
    // the popup is usable immediately via the hardcoded fallback; the
    // first time a user types `/`, they'll see the full list if the
    // fetch landed.
    loadCommandsFromServer();

    textareaEl.addEventListener("input", onInput);
    textareaEl.addEventListener("keydown", onKeydown, true); // capture phase so we win over inline onkeydown
    textareaEl.addEventListener("blur", () => {
      // Delay so a click on the popup can register before we close.
      setTimeout(closePopup, 120);
    });
  }

  async function loadCommandsFromServer() {
    try {
      // /api/protocols is bearer-auth gated. Use the shared apiFetch
      // wrapper (defined in shared.js) when available — it injects the
      // Authorization header from window.AUTH_TOKEN. Plain fetch would
      // 401 and silently leave us with the hardcoded fallback.
      const doFetch = (typeof window.apiFetch === "function")
        ? () => window.apiFetch("/api/protocols")
        : () => fetch("/api/protocols", { credentials: "same-origin" });
      const resp = await doFetch();
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data || !Array.isArray(data.protocols) || data.protocols.length === 0) return;
      COMMANDS = data.protocols.map((p) => ({
        name: String(p.name || ""),
        description: String(p.description || ""),
        category: String(p.category || "General"),
      })).filter((c) => c.name);
    } catch { /* keep fallback */ }
  }

  function onInput() {
    const raw = textareaEl.value;
    // Underscore allowed for typed protocol names like `instagram_post`.
    const match = raw.match(/^\/([a-zA-Z0-9_-]*)$/);
    if (!match) { closePopup(); return; }

    const prefix = match[1].toLowerCase();
    currentMatches = COMMANDS.filter(c => c.name.toLowerCase().startsWith(prefix));
    if (currentMatches.length === 0) { closePopup(); return; }

    highlightedIdx = 0;
    renderPopup();
  }

  function onKeydown(e) {
    // CRITICAL: must check the popup is actually VISIBLE, not just present in DOM.
    // popupEl persists in the DOM after first open (we just toggle display:none on
    // close). Without this check, every Enter press AFTER the popup was ever opened
    // gets intercepted, selectCurrent() fires with stale state, and the send never
    // happens. Live-failure pattern: user types real message, hits Enter, input
    // resets to "/app-build " and nothing sends.
    if (!popupEl || popupEl.style.display !== "block") return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopImmediatePropagation();
      highlightedIdx = (highlightedIdx + 1) % currentMatches.length;
      renderPopup();
      scrollActiveIntoView();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopImmediatePropagation();
      highlightedIdx = (highlightedIdx - 1 + currentMatches.length) % currentMatches.length;
      renderPopup();
      scrollActiveIntoView();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      selectCurrent();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopImmediatePropagation();
      selectCurrent();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      closePopup();
      return;
    }
  }

  function selectCurrent() {
    const choice = currentMatches[highlightedIdx];
    if (!choice) return;
    // Insert "/<name> " — trailing space lets user start typing the arg immediately.
    textareaEl.value = `/${choice.name} `;
    textareaEl.focus();
    // Position cursor at end.
    const len = textareaEl.value.length;
    textareaEl.setSelectionRange(len, len);
    closePopup();
  }

  function renderPopup() {
    if (!popupEl) {
      popupEl = document.createElement("div");
      popupEl.id = "slash-popup";
      popupEl.setAttribute("role", "listbox");
      popupEl.setAttribute("aria-label", "Slash commands");
      document.body.appendChild(popupEl);
    }

    popupEl.innerHTML = "";
    const header = document.createElement("div");
    header.className = "slash-popup-header";
    header.textContent = "Slash Commands";
    popupEl.appendChild(header);

    // Group filtered matches by category, then sort categories by
    // CATEGORY_ORDER. Within each category, preserve the API's incoming
    // order (already alphabetical from /api/protocols). When only one
    // category is present (e.g. user typed `/inst` and only matched
    // Social Media), skip the subheader — it'd be empty chrome.
    const groups = new Map();
    for (const cmd of currentMatches) {
      const cat = cmd.category || "General";
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(cmd);
    }
    const orderedCats = [...groups.keys()].sort((a, b) => {
      const r = categoryRank(a) - categoryRank(b);
      return r !== 0 ? r : a.localeCompare(b);
    });
    const showCategoryHeaders = orderedCats.length > 1;

    let flatIdx = 0;
    for (const cat of orderedCats) {
      if (showCategoryHeaders) {
        const catHeader = document.createElement("div");
        catHeader.className = "slash-popup-category";
        catHeader.textContent = cat;
        popupEl.appendChild(catHeader);
      }
      for (const cmd of groups.get(cat)) {
        const idx = flatIdx;
        const item = document.createElement("div");
        item.className = "slash-popup-item" + (idx === highlightedIdx ? " active" : "");
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", idx === highlightedIdx ? "true" : "false");
        item.addEventListener("mousedown", (ev) => {
          // mousedown (not click) so we beat the textarea blur close.
          ev.preventDefault();
          highlightedIdx = idx;
          selectCurrent();
        });
        item.addEventListener("mouseenter", () => {
          highlightedIdx = idx;
          // refresh just the active class without rebuilding
          Array.from(popupEl.querySelectorAll(".slash-popup-item")).forEach((el, i) => {
            el.classList.toggle("active", i === highlightedIdx);
            el.setAttribute("aria-selected", i === highlightedIdx ? "true" : "false");
          });
        });

        const name = document.createElement("div");
        name.className = "slash-popup-name";
        name.textContent = `/${cmd.name}`;
        item.appendChild(name);

        const desc = document.createElement("div");
        desc.className = "slash-popup-desc";
        desc.textContent = cmd.description;
        item.appendChild(desc);

        popupEl.appendChild(item);
        flatIdx++;
      }
    }

    positionPopup();
    popupEl.style.display = "block";
  }

  function positionPopup() {
    if (!popupEl || !textareaEl) return;
    const rect = textareaEl.getBoundingClientRect();
    // Place ABOVE the textarea (popup grows upward, anchored at textarea top).
    // popup width = textarea width; max height capped via CSS so long lists scroll.
    popupEl.style.left = rect.left + "px";
    popupEl.style.width = rect.width + "px";
    // Use bottom anchor so popup sits ABOVE the input.
    popupEl.style.bottom = (window.innerHeight - rect.top + 6) + "px";
    popupEl.style.top = "auto";
  }

  function closePopup() {
    if (popupEl) {
      popupEl.style.display = "none";
    }
  }

  function scrollActiveIntoView() {
    if (!popupEl) return;
    const active = popupEl.querySelector(".slash-popup-item.active");
    if (active && typeof active.scrollIntoView === "function") {
      // "nearest" avoids jarring jumps when the active item is already
      // visible — only scrolls when it's out of view.
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  // Reposition on window resize so popup tracks the textarea.
  window.addEventListener("resize", () => { if (popupEl && popupEl.style.display === "block") positionPopup(); });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

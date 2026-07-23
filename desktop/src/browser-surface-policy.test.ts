// Agent-view surface policy — the "visible pane FOLLOWS the agent" decision.
// STATELESS: follow only when the anchor's current view is an agent view the
// SURFACING session owns (view-<sid>-…) or a blank foreground; everything else
// badges (never steals). Regression context: an earlier per-session anchor MAP
// recorded adopted user-view ids (foreground / profile-* / user-N); a stale
// entry cross-matched the anchor and stole the user's hand-navigated page. With
// no stored state there is nothing to go stale, so the whole steal class is gone.
import { describe, expect, it } from "vitest";
import { decideAgentSurface, isSessionAgentView } from "./browser-surface-policy";

describe("isSessionAgentView", () => {
	it("matches the surfacing session's own agent tabs (first tab and new tabs)", () => {
		expect(isSessionAgentView("view-sessA-default", "sessA")).toBe(true);
		expect(isSessionAgentView("view-sessA-default-t2", "sessA")).toBe(true);
		expect(isSessionAgentView("view-chat-x-1o3-work-t5", "chat-x-1o3")).toBe(true); // hyphenated session id
	});
	it("excludes foreground / profile / user-N and OTHER sessions' views", () => {
		expect(isSessionAgentView("foreground", "sessA")).toBe(false);
		expect(isSessionAgentView("profile-work", "sessA")).toBe(false);
		expect(isSessionAgentView("user-3", "sessA")).toBe(false);
		expect(isSessionAgentView("view-sessB-default", "sessA")).toBe(false); // other session
	});
	it("is false with no sessionId, and a shorter id never prefixes a longer one", () => {
		expect(isSessionAgentView("view-sessA-default", undefined)).toBe(false);
		expect(isSessionAgentView("view-ab-default", "a")).toBe(false); // 'a' must not match 'ab'
	});
});

describe("decideAgentSurface (pure)", () => {
	it("follows when the anchor is an agent view the surfacing session owns", () => {
		expect(decideAgentSurface({ isForegroundFamily: false, isBlank: false, currentIsSessionAgentView: true })).toBe(true);
	});
	it("follows onto a blank foreground/profile view (nothing to steal)", () => {
		expect(decideAgentSurface({ isForegroundFamily: true, isBlank: true, currentIsSessionAgentView: false })).toBe(true);
	});
	it("NEVER steals a real page the user navigated by hand (non-blank foreground → badge)", () => {
		expect(decideAgentSurface({ isForegroundFamily: true, isBlank: false, currentIsSessionAgentView: false })).toBe(false);
	});
	it("badges a user-N tab / adopted view / other session's view (not this session's agent view)", () => {
		expect(decideAgentSurface({ isForegroundFamily: false, isBlank: false, currentIsSessionAgentView: false })).toBe(false);
	});
});

describe("scenarios (isSessionAgentView + decideAgentSurface together)", () => {
	const surface = (currentViewId: string, sessionId: string | undefined, fg: boolean, blank: boolean) =>
		decideAgentSurface({
			isForegroundFamily: fg,
			isBlank: blank,
			currentIsSessionAgentView: isSessionAgentView(currentViewId, sessionId),
		});

	it("own-tab follow (the reported symptom): agent switches among its own tabs → pane follows", () => {
		expect(surface("foreground", "A", true, true)).toBe(true); // first surface: blank foreground
		expect(surface("view-A-default", "A", false, false)).toBe(true); // then own tabs follow
		expect(surface("view-A-default-t2", "A", false, false)).toBe(true);
	});

	it("STEAL PREVENTED: agent adopts the foreground, user hand-navigates it, agent surfaces → BADGE", () => {
		// The anchor sits on the adopted foreground the user then typed into. It is
		// NOT an agent view of A (id 'foreground') → badge, no steal. This is the
		// exact hole the removed anchor map opened.
		expect(surface("foreground", "A", true, false)).toBe(false);
	});

	it("D1: a background session cannot steal the pane off another session's agent view", () => {
		expect(surface("view-A-default", "B", false, false)).toBe(false); // view-A is not B's own view
	});

	it("adopt-then-switch-back BADGES (safe tradeoff: pane stays on the user's adopted tab)", () => {
		expect(surface("user-3", "A", false, false)).toBe(false); // user-3 is not an agent view of A
	});

	it("an unattributed surface (no sessionId) follows a blank foreground but not a real page", () => {
		expect(surface("foreground", undefined, true, true)).toBe(true);
		expect(surface("foreground", undefined, true, false)).toBe(false);
	});
});

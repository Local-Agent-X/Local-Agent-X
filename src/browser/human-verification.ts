import type { BrowserObservation } from "./observation-types.js";
import type { IframeInfo } from "./iframe-detector.js";

export const HUMAN_VERIFICATION_MESSAGE =
	"HUMAN VERIFICATION REQUIRED: A CAPTCHA or anti-bot verification is active. " +
	"The agent must not click or attempt to bypass it. The user must complete it in the visible browser, then retry.";

/** The next step a refusal names (result-helpers.ts `blocked`). */
export const HUMAN_VERIFICATION_RECOVERY =
	"Tell the user a verification check is on screen and ask them to complete it in the browser. Continue with any other part of the request meanwhile, then retry here.";

/** Frames that only ever carry a challenge: Cloudflare Turnstile, hCaptcha,
 *  reCAPTCHA, Arkose (FunCaptcha), DataDome's captcha page, GeeTest, AWS WAF,
 *  Yandex SmartCaptcha and MTCaptcha. DataDome's /interstitial/ frame is a
 *  device check that clears by itself, so only its /captcha/ page counts. */
const PROVIDER_FRAME = new RegExp([
	String.raw`challenges\.cloudflare\.com\/.*turnstile`,
	String.raw`hcaptcha\.com\/.*captcha`,
	String.raw`(?:google\.com|recaptcha\.net)\/recaptcha`,
	String.raw`(?:arkoselabs|funcaptcha)\.com\/`,
	String.raw`captcha-delivery\.com\/captcha`,
	String.raw`geetest\.com\/`,
	String.raw`(?:captcha|token)\.awswaf\.com\/`,
	String.raw`smartcaptcha\.yandexcloud\.net\/`,
	String.raw`mtcaptcha\.com\/`,
].join("|"), "i");
const CHALLENGE_TITLE =
	/^(?:just a moment(?:\.\.\.)?|attention required!?\s*\|\s*cloudflare|performing security verification|access to this page has been denied\.?|robot or human\??|are you a robot\??|human verification|pardon our interruption\.*)$/i;
const CHALLENGE_CONTROL =
	/^(?:verify you are human|i(?:'|’)m not a robot|hcaptcha|recaptcha|press (?:&|and) hold)$/i;

/** A control that is only ever a challenge, whatever the page's title: the
 *  press-and-hold button (HUMAN/PerimeterX, on Walmart and others). */
const HOLD_CONTROL = /^press (?:&|and) hold(?: (?:the button|to confirm you are (?:a )?human))?$/i;

/** A field asking for the characters in a picture (Amazon's "Type characters",
 *  the classic text CAPTCHA). Told apart from a search box by its own name or
 *  identity, never by the page merely mentioning "captcha". */
const TYPED_CHALLENGE_NAME =
	/^(?:type (?:the )?characters(?: you see(?: in (?:this|the) (?:image|picture))?)?|enter (?:the )?characters(?: you see(?: (?:below|above|in (?:this|the) (?:image|picture)))?)?|type the text(?: in the image)?|enter the code (?:from|in) the (?:image|picture))$/i;

function isTypedChallengeField(ref: BrowserObservation["currentRefs"][number]): boolean {
	if (ref.role !== "textbox") return false;
	if (TYPED_CHALLENGE_NAME.test(ref.name.trim()) || TYPED_CHALLENGE_NAME.test(ref.ids?.placeholder?.trim() ?? "")) return true;
	return /captcha/i.test(ref.ids?.id ?? "") || /captcha/i.test(ref.ids?.name ?? "");
}

/**
 * A provider frame that is asking the user to act. Loading a provider is not
 * evidence of a challenge: an invisible-mode badge (size=invisible) and a
 * challenge frame parked off-screen until needed ask nothing, and a widget
 * whose response field holds a token has already been completed.
 */
function isOpenChallenge(frame: IframeInfo): boolean {
	if (!PROVIDER_FRAME.test(frame.src) || /[?#&]size=invisible\b/i.test(frame.src)) return false;
	const onScreen = frame.rect.x + frame.rect.width > 0 && frame.rect.y + frame.rect.height > 0;
	return onScreen && !frame.answered;
}

const HUMAN_CHECKBOX =
	/^(?:i am (?:a )?human|i(?:'|’)m (?:a )?human|i(?:'|’)m not a robot|i am not a robot|verify you are human)$/i;

/** A site's own "I am human" checkbox, still unticked: Amazon's checkpoint page
 *  is a plain checkbox on an ordinary title, with no provider frame (the Purell
 *  reorder, 2026-11-17). */
function hasOpenHumanCheckbox(refs: BrowserObservation["currentRefs"]): boolean {
	return refs.some((ref) => ref.role === "checkbox" && HUMAN_CHECKBOX.test(ref.name.trim()) && ref.state?.checked !== true);
}

export function requiresHumanVerification(obs: Pick<
	BrowserObservation,
	"title" | "currentRefs" | "crossOriginIframes"
>): boolean {
	if (obs.crossOriginIframes.some(isOpenChallenge)) return true;
	if (hasOpenHumanCheckbox(obs.currentRefs)) return true;
	if (obs.currentRefs.some((ref) => HOLD_CONTROL.test(ref.name.trim()) || isTypedChallengeField(ref))) return true;
	const title = obs.title.trim();
	if (!CHALLENGE_TITLE.test(title)) return false;
	return obs.currentRefs.length === 0 ||
		obs.currentRefs.some((ref) => CHALLENGE_CONTROL.test(ref.name.trim()));
}

/** The interstitial, read from a formatted snapshot. A snapshot lists frames
 *  by origin only, so provider frames are judged from the observation, never
 *  from page text (which can merely mention a provider). */
export function snapshotShowsHumanVerification(snapshot: string): boolean {
	for (const m of snapshot.matchAll(/<checkbox\b[^>]*>([^<]*)<\/checkbox>([^\n]*)/gi)) {
		if (HUMAN_CHECKBOX.test(m[1].trim()) && !/\{[^}]*\bchecked\b/.test(m[2].replace(/unchecked/g, ""))) return true;
	}
	for (const m of snapshot.matchAll(/^\[\d+\]<(\w+)\b[^>]*>([^<]*)<\/\1>/gm)) {
		const name = m[2].trim();
		if (HOLD_CONTROL.test(name) || (m[1] === "textbox" && TYPED_CHALLENGE_NAME.test(name))) return true;
	}
	const normalized = snapshot.replace(/\s+/g, " ").trim();
	return CHALLENGE_TITLE.test((/^Page:\s*(.*?)\s+[—-]\s+https?:/i.exec(snapshot)?.[1] ?? "").trim()) &&
		/(verify you are human|i(?:'|’)m not a robot|captcha)/i.test(normalized);
}

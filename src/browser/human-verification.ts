import type { BrowserObservation } from "./observation-types.js";

export const HUMAN_VERIFICATION_MESSAGE =
	"HUMAN VERIFICATION REQUIRED: A CAPTCHA or anti-bot verification is active. " +
	"The agent must not click or attempt to bypass it. The user must complete it in the visible browser, then retry.";

const PROVIDER_FRAME =
	/(?:challenges\.cloudflare\.com\/.*turnstile|hcaptcha\.com\/.*captcha|(?:google\.com|recaptcha\.net)\/recaptcha)/i;
const CHALLENGE_TITLE =
	/^(?:just a moment(?:\.\.\.)?|attention required!?\s*\|\s*cloudflare|performing security verification)$/i;
const CHALLENGE_CONTROL =
	/^(?:verify you are human|i(?:'|’)m not a robot|hcaptcha|recaptcha)$/i;

export function requiresHumanVerification(obs: Pick<
	BrowserObservation,
	"title" | "currentRefs" | "crossOriginIframes"
>): boolean {
	if (obs.crossOriginIframes.some((frame) => PROVIDER_FRAME.test(frame.src))) return true;
	const title = obs.title.trim();
	if (!CHALLENGE_TITLE.test(title)) return false;
	return obs.currentRefs.length === 0 ||
		obs.currentRefs.some((ref) => CHALLENGE_CONTROL.test(ref.name.trim()));
}

export function snapshotShowsHumanVerification(snapshot: string): boolean {
	const normalized = snapshot.replace(/\s+/g, " ").trim();
	return PROVIDER_FRAME.test(normalized) ||
		(CHALLENGE_TITLE.test((/^Page:\s*(.*?)\s+[—-]\s+https?:/i.exec(snapshot)?.[1] ?? "").trim()) &&
			/(verify you are human|i(?:'|’)m not a robot|captcha)/i.test(normalized));
}

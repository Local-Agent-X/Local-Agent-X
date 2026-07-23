/**
 * Shared string fragments for the in-app isolated-world scripts
 * (in-app-scripts.ts). Extracted to keep that file under the 400-LOC gate and
 * to give the <select> option-matcher and the React-safe value setter a single
 * home. These are STRING BUILDERS — the JS they emit runs in the view's
 * isolated world, so the free-identifier discipline still applies (document /
 * getComputedStyle / …, plus HTMLInputElement / HTMLTextAreaElement, which
 * every browser realm defines).
 */

/**
 * Write a value the way React sees it. React (>=16) tracks the value on the
 * element instance, so a bare `el.value =` write is deduped by its value
 * tracker and onChange never fires — the field reads back as filled while the
 * framework's state stays empty. Writing through the prototype's native setter
 * defeats the tracker (parity with secret-ops.ts fillSecretScript). `elVar` is
 * an in-scope element variable; `valExpr` a JS expression for the new value.
 */
export function nativeValueSetStmt(elVar: string, valExpr: string): string {
	return `const __proto = ${elVar} instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
			: ${elVar} instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
		const __desc = __proto && Object.getOwnPropertyDescriptor(__proto, "value");
		if (__desc && __desc.set) __desc.set.call(${elVar}, ${valExpr}); else ${elVar}.value = ${valExpr};`;
}

/**
 * Resolve a <select> option against a target string: exact value/label/text
 * first (CDP/HTML parity), then a trimmed + case-insensitive fallback so a
 * model emitting "In Stock" still matches an "in stock" option. `optionsExpr`
 * is a JS expression for the option array; `valExpr` for the target string.
 */
export function selectOptionMatchExpr(optionsExpr: string, valExpr: string): string {
	return `((__o, __t) => __o.find((o) => o.value === __t || o.label === __t || o.text === __t)
			|| __o.find((o) => { const __v = __t.trim().toLowerCase();
				return (o.value || "").trim().toLowerCase() === __v || (o.label || "").trim().toLowerCase() === __v || (o.text || "").trim().toLowerCase() === __v; }))(${optionsExpr}, ${valExpr})`;
}

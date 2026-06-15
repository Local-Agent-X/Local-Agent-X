// Adoptable blank-tab detection. Kept in its own leaf module (no imports) so
// acquirePage's gate is unit-testable without dragging in manager.ts's
// transitive config-loader/manifest side effects.
//
// A "blankish" URL is a throwaway tab the session should ADOPT instead of
// opening a fresh one. Miss a new-tab variant and the first navigation
// strands the real new-tab page and opens a second tab — stray tabs pile up.
// chrome://newtab is only the redirect alias; modern Chrome's actual NTP is
// chrome://new-tab-page/ (and the -third-party variant).
export function isBlankish(url: string): boolean {
  return (
    url === "" ||
    url === "about:blank" ||
    url.startsWith("chrome://newtab") ||
    url.startsWith("chrome://new-tab-page")
  );
}

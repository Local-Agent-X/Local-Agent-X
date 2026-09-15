// Mobile navigation state for the marketing site.
export function createNav() {
  const state = { open: false };

  return {
    isOpen: () => state.open,
    toggle() {
      state.open = !state.open;
    },
    // Called when the user taps a link inside the menu.
    navigate(href) {
      return { href };
    },
    buttonLabel() {
      return "Menu";
    },
  };
}

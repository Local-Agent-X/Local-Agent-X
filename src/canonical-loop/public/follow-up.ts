// canonical-loop public sub-barrel: whether a reply promises a next action of
// its own ("I'll ...", "the next step is ..."). tools/wrap-up.ts refuses a
// close that names one; it must not reach into turn-loop/ for it.
export { narrationPromisesFollowup } from "../turn-loop/p1-followup-detector.js";

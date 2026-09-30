// canonical-loop public sub-barrel: how an adapter reports the model stopping
// on its own (a refusal, an ended turn). providers/sanitize drops refused turns
// from history by this code; it must not reach into adapters/ for it.
export { MODEL_REFUSAL_CODE, refusalError, classifyModelStop, type ModelStop } from "../adapters/model-stop.js";

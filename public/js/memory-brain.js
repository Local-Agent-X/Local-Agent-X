// Memory brain visualization — entrypoint. A brain-shaped dust cloud in the
// Memory settings tab where each dot tracks a stored memory, with scroll zoom.
// Three.js resolves via the importmap in app.html. Implementation lives in
// ./memory-brain/; this file exposes the public window.MemoryBrain surface.

import { ensure, pause, resume } from './memory-brain/lifecycle.js';

window.MemoryBrain = { ensure, pause, resume };

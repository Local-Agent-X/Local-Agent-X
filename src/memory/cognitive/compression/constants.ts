import { join } from "node:path";
import { getLaxDir } from "../../../lax-data-dir.js";

export const compressedDir = (): string => join(getLaxDir(), "memory-compressed");

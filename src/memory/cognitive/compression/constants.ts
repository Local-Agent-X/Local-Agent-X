import { join } from "node:path";
import { getLaxDir } from "../../../lax-data-dir.js";

export const COMPRESSED_DIR = join(getLaxDir(), "memory-compressed");

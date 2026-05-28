/**
 * Local Agent X — Memory Compression
 *
 * Multi-resolution memory storage: keeps four compression levels
 * (full / summary / keypoints / skeleton) so older memories use
 * less space while remaining retrievable at any resolution.
 *
 * Persists compressed versions to ~/.lax/memory-compressed/.
 */

export type {
  CompressedSession,
  CompressionLevel,
  CompressionReport,
} from "./types.js";

export { MemoryCompressor } from "./compressor.js";

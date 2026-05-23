export type CompressionLevel = "full" | "summary" | "keypoints" | "skeleton";

export interface CompressedSession {
  id: string;
  levels: Record<CompressionLevel, string>;
  originalTokens: number;
  compressedTokens: number;
}

export interface CompressionReport {
  processed: number;
  compressed: number;
  savedTokens: number;
  byLevel: Record<CompressionLevel, number>;
}

export interface StoredCompression {
  id: string;
  levels: Record<CompressionLevel, string>;
  originalTokens: number;
  compressedTokens: number;
  createdAt: number;
  ageAtCompression: number;
}

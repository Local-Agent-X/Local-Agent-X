import type { EmbeddingProvider } from "./types.js";

// Which chunks a provider may be handed to embed. A project document is the
// user's file, so its text goes only to an embedder running on this machine:
// with a cloud provider it is indexed for keyword search alone. Every path
// that embeds chunks (first index, the background re-embed after an outage or
// a provider switch) asks here, so a switch to a cloud provider never ships
// the documents out on the re-embed pass.

export function mayEmbed(provider: EmbeddingProvider, source: string): boolean {
  return source !== "project-doc" || provider.onBox === true;
}

/** SQL fragment (leading AND) narrowing `chunks` to rows `provider` may embed. */
export function embeddableChunksWhere(provider: EmbeddingProvider): string {
  return provider.onBox === true ? "" : " AND source <> 'project-doc'";
}

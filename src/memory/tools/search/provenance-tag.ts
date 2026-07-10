import type { ChunkMetadata, FactProvenance } from "../../types.js";

/**
 * Trust-origin tag for a search-result header line, mirroring how `source=`
 * is printed. Chunk metadata carries no explicit provenance column, but the
 * import source_types are external content by definition — history the user
 * brought in from other assistants/apps, never something this agent verified.
 * Native sessions and profile files stay untagged (no honest single value).
 */
export function provenanceTag(metadata?: ChunkMetadata): string {
	const provenance = provenanceOf(metadata);
	return provenance ? ` prov=${provenance}` : "";
}

function provenanceOf(metadata?: ChunkMetadata): FactProvenance | undefined {
	if (!metadata?.source_type) return undefined;
	if (metadata.source_type === "agent-x-session") return undefined;
	if (metadata.source_type.includes("import")) return "external_content";
	return undefined;
}

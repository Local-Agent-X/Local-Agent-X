// ── Portable Memory Format ── Export/import memory as JSON-LD

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";

const CONTEXT_URL = "https://schema.org/";
const MEMORY_TYPE = "DigitalDocument";

export interface MemoryNode {
  "@context": string;
  "@type": string;
  "@id": string;
  name: string;
  content: string;
  dateCreated: string;
  dateModified?: string;
  keywords: string[];
  relations: MemoryRelation[];
  encoding?: string;
  sourceFormat?: string;
}

export interface MemoryRelation {
  "@type": "relatedTo" | "derivedFrom" | "supersedes" | "references";
  target: string;
  description?: string;
}

interface MemoryExport {
  "@context": string;
  "@type": "ItemList";
  name: string;
  dateExported: string;
  numberOfItems: number;
  itemListElement: MemoryNode[];
}

function extractTags(content: string): string[] {
  const tags: string[] = [];
  // Extract markdown headers as tags
  const headerMatches = content.match(/^#+\s+(.+)$/gm);
  if (headerMatches) {
    for (const h of headerMatches) {
      const text = h.replace(/^#+\s+/, "").trim().toLowerCase();
      if (text.length > 0 && text.length < 60) {
        tags.push(text);
      }
    }
  }
  return tags;
}

function extractRelations(content: string, allFiles: string[]): MemoryRelation[] {
  const relations: MemoryRelation[] = [];
  // Find markdown links to other memory files
  const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(content)) !== null) {
    const target = match[2];
    // Only create relations to other files in the memory directory
    const targetBase = basename(target);
    if (allFiles.includes(targetBase)) {
      relations.push({
        "@type": "references",
        target: targetBase,
        description: match[1] || undefined,
      });
    }
  }
  return relations;
}

function validateMemoryNode(node: unknown): node is MemoryNode {
  if (!node || typeof node !== "object") return false;
  const n = node as Record<string, unknown>;
  if (typeof n["@context"] !== "string") return false;
  if (typeof n["@type"] !== "string") return false;
  if (typeof n["@id"] !== "string") return false;
  if (typeof n.name !== "string") return false;
  if (typeof n.content !== "string") return false;
  if (typeof n.dateCreated !== "string") return false;
  if (!Array.isArray(n.keywords)) return false;
  if (!Array.isArray(n.relations)) return false;
  return true;
}

export function exportMemoryJsonLD(memoryDir: string): MemoryExport {
  if (!existsSync(memoryDir)) {
    throw new Error(`Memory directory not found: ${memoryDir}`);
  }

  const entries = readdirSync(memoryDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && (extname(e.name) === ".md" || extname(e.name) === ".txt" || extname(e.name) === ".json"))
    .map((e) => e.name);

  const nodes: MemoryNode[] = [];

  for (const fileName of files) {
    const filePath = join(memoryDir, fileName);
    const content = readFileSync(filePath, "utf-8");
    let mtime = new Date();
    try {
      mtime = statSync(filePath).mtime;
    } catch {
      // use default
    }

    const tags = extractTags(content);
    const relations = extractRelations(content, files);

    nodes.push({
      "@context": CONTEXT_URL,
      "@type": MEMORY_TYPE,
      "@id": fileName,
      name: fileName.replace(extname(fileName), ""),
      content,
      dateCreated: mtime.toISOString(),
      keywords: tags,
      relations,
      encoding: "utf-8",
      sourceFormat: extname(fileName).slice(1),
    });
  }

  return {
    "@context": CONTEXT_URL,
    "@type": "ItemList",
    name: "Agent Memory Export",
    dateExported: new Date().toISOString(),
    numberOfItems: nodes.length,
    itemListElement: nodes,
  };
}

export function importMemoryJsonLD(data: unknown, memoryDir: string): number {
  if (!data || typeof data !== "object") {
    throw new Error("Import data must be a JSON-LD object");
  }

  const doc = data as Record<string, unknown>;

  // Support both ItemList wrapper and raw array of nodes
  let nodes: unknown[];
  if (Array.isArray(doc.itemListElement)) {
    nodes = doc.itemListElement;
  } else if (Array.isArray(data)) {
    nodes = data as unknown[];
  } else {
    throw new Error("Expected itemListElement array or array of MemoryNode objects");
  }

  // Validate all nodes before writing any
  const validated: MemoryNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!validateMemoryNode(node)) {
      throw new Error(
        `Invalid memory node at index ${i}. ` +
          "Required: @context, @type, @id, name, content, dateCreated, keywords[], relations[]"
      );
    }
    validated.push(node);
  }

  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  let written = 0;
  for (const node of validated) {
    const ext = node.sourceFormat ? `.${node.sourceFormat}` : ".md";
    const fileName = node["@id"].includes(".") ? node["@id"] : `${node["@id"]}${ext}`;
    const filePath = join(memoryDir, fileName);
    writeFileSync(filePath, node.content, "utf-8");
    written++;
  }

  return written;
}

// ── Conversion from other agent formats ──

interface GenericMemoryEntry {
  id?: string;
  title?: string;
  text?: string;
  content?: string;
  body?: string;
  timestamp?: string | number;
  created?: string | number;
  date?: string | number;
  tags?: string[];
  labels?: string[];
  metadata?: Record<string, unknown>;
}

export function convertFromGenericFormat(entries: GenericMemoryEntry[]): MemoryNode[] {
  return entries.map((entry, idx) => {
    const id = entry.id || entry.title || `memory-${idx}`;
    const content = entry.text || entry.content || entry.body || "";
    const rawDate = entry.timestamp || entry.created || entry.date;
    let dateStr: string;
    if (typeof rawDate === "number") {
      dateStr = new Date(rawDate).toISOString();
    } else if (typeof rawDate === "string") {
      dateStr = new Date(rawDate).toISOString();
    } else {
      dateStr = new Date().toISOString();
    }

    const keywords = entry.tags || entry.labels || [];

    return {
      "@context": CONTEXT_URL,
      "@type": MEMORY_TYPE,
      "@id": id,
      name: entry.title || id,
      content,
      dateCreated: dateStr,
      keywords,
      relations: [],
      encoding: "utf-8",
    };
  });
}

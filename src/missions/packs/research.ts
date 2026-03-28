/**
 * Research Mission Pack — web research, summarize, cite missions.
 */

import type { Mission } from "../../missions.js";

export const webResearchMission: Mission = {
  name: "web_research",
  description: "Deep web research on a topic: search, browse, collect, and synthesize findings with citations.",
  triggers: ["research", "look up", "find out about", "deep research", "investigate", "what do we know about"],
  learnablePreferences: ["citation_format", "summary_length", "preferred_sources", "research_depth"],
  rules: [
    "Always use multiple sources — minimum 3 for any factual claim.",
    "Cite every claim with a URL.",
    "Distinguish primary sources from commentary/analysis.",
    "Flag conflicting information explicitly with both sides.",
    "Date-stamp findings — web content changes.",
    "Prefer authoritative sources: academic papers, official docs, established news.",
  ],
  steps: [
    { id: "define_scope", instruction: "Clarify the research question. Identify sub-topics and boundaries." },
    { id: "initial_search", instruction: "Run broad searches to map the topic landscape." },
    { id: "deep_dive", instruction: "Browse the most relevant results. Extract key facts and quotes." },
    { id: "cross_reference", instruction: "Cross-reference findings across sources. Note agreements and conflicts." },
    { id: "synthesize", instruction: "Create a structured summary with sections and citations." },
    { id: "present", instruction: "Present findings in user's preferred format (brief, detailed, bullet points, report)." },
  ],
};

export const summarizeMission: Mission = {
  name: "summarize",
  description: "Summarize a document, article, or webpage into key points with configurable detail level.",
  triggers: ["summarize", "tldr", "sum up", "give me the gist", "key points", "summarize this"],
  learnablePreferences: ["summary_style", "preferred_length", "include_quotes"],
  rules: [
    "Preserve the original meaning — don't editorialize.",
    "Include the most important 3-5 points minimum.",
    "For long documents, provide section-by-section summaries.",
    "Always link back to the source.",
    "Mention what was omitted so the user knows the summary's scope.",
  ],
  steps: [
    { id: "get_source", instruction: "Get the content to summarize — URL, file, or pasted text." },
    { id: "read_content", instruction: "Read/fetch the full content." },
    { id: "identify_key_points", instruction: "Identify the main arguments, facts, and conclusions." },
    { id: "draft_summary", instruction: "Write the summary at the requested detail level." },
    { id: "review", instruction: "Verify accuracy against the source. Present to user." },
  ],
};

export const citationMission: Mission = {
  name: "citation_builder",
  description: "Build properly formatted citations from URLs, DOIs, or reference information.",
  triggers: ["cite this", "build citation", "format reference", "bibliography", "cite source"],
  learnablePreferences: ["citation_format", "include_access_date", "preferred_style"],
  rules: [
    "Support APA, MLA, Chicago, Harvard, and IEEE formats.",
    "Extract metadata from URLs when possible (title, author, date, publisher).",
    "For DOIs, resolve to full metadata.",
    "Always include access date for web sources.",
    "Group multiple citations into a formatted bibliography.",
  ],
  steps: [
    { id: "collect_sources", instruction: "Gather URLs, DOIs, or reference details from the user." },
    { id: "extract_metadata", instruction: "Fetch and parse metadata for each source." },
    { id: "determine_format", instruction: "Use user's preferred citation format (default: APA 7th)." },
    { id: "format_citations", instruction: "Generate formatted citations for each source." },
    { id: "compile", instruction: "Compile into a bibliography if multiple sources. Present to user." },
  ],
};

export const factCheckMission: Mission = {
  name: "fact_check",
  description: "Verify claims by cross-referencing multiple authoritative sources.",
  triggers: ["fact check", "is this true", "verify this claim", "check if", "is it true that"],
  learnablePreferences: ["trusted_sources", "verification_depth"],
  rules: [
    "Check at least 3 independent sources per claim.",
    "Prefer primary/official sources over secondary reporting.",
    "Rate confidence: Confirmed, Likely True, Unverified, Disputed, False.",
    "Show the evidence for and against.",
    "Note the date of the claim vs date of evidence — things change.",
  ],
  steps: [
    { id: "parse_claim", instruction: "Extract the specific claim(s) to verify." },
    { id: "search_sources", instruction: "Search for evidence from authoritative sources." },
    { id: "evaluate_evidence", instruction: "Assess each source's reliability and relevance." },
    { id: "render_verdict", instruction: "Rate each claim with confidence level and supporting evidence." },
    { id: "present", instruction: "Present findings with citations and confidence ratings." },
  ],
};

export const researchMissions: Mission[] = [
  webResearchMission,
  summarizeMission,
  citationMission,
  factCheckMission,
];

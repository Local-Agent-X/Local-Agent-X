// KittenTTS g2p — normalize → punctuation-preserving phonemize.
//
// KittenTTS 0.1 is a StyleTTS2 model that consumes the SAME misaki/espeak IPA
// token vocab Kokoro uses. A naive `phonemize(text,"en-us").join(" ")` drops
// every punctuation mark, so em-dash / ellipsis / paren pauses vanish and the
// model runs clauses together. kokoro-js avoids that by (1) normalizing the
// text (curly quotes → straight, parens → guillemets, abbreviation + number
// expansion) and (2) splitting on a punctuation regex so punctuation runs pass
// through VERBATIM while only the word runs get phonemized — the punctuation
// then survives into the token stream as pause cues.
//
// This module ports that pipeline from kokoro-js's internal normalize+phonemize
// (which is not exported) MINUS its Kokoro-brand-word fixups (kəkˈoːɹoʊ→…) which
// are specific to the word "kokoro". The generic espeak→misaki fixups are kept
// because they are model-family-level, not brand-level.

// Number / time / year expansion (e.g. "1999" → "19 99", "3:05" → "3 oh 5").
function expandNumber(e: string): string {
  if (e.includes(".")) return e;
  if (e.includes(":")) {
    const [a, t] = e.split(":").map(Number);
    return t === 0 ? `${a} o'clock` : t < 10 ? `${a} oh ${t}` : `${a} ${t}`;
  }
  const a = parseInt(e.slice(0, 4), 10);
  if (a < 1100 || a % 1e3 < 10) return e;
  const t = e.slice(0, 2);
  const r = parseInt(e.slice(2, 4), 10);
  const n = e.endsWith("s") ? "s" : "";
  if (a % 1e3 >= 100 && a % 1e3 <= 999) {
    if (r === 0) return `${t} hundred${n}`;
    if (r < 10) return `${t} oh ${r}${n}`;
  }
  return `${t} ${r}${n}`;
}

// Currency expansion (e.g. "$3.50" → "3 dollars and 50 cents").
function expandMoney(e: string): string {
  const a = e[0] === "$" ? "dollar" : "pound";
  if (isNaN(Number(e.slice(1)))) return `${e.slice(1)} ${a}s`;
  if (!e.includes(".")) {
    const t = e.slice(1) === "1" ? "" : "s";
    return `${e.slice(1)} ${a}${t}`;
  }
  const [t, r] = e.slice(1).split(".");
  const n = parseInt(r.padEnd(2, "0"), 10);
  const unit = e[0] === "$" ? (n === 1 ? "cent" : "cents") : n === 1 ? "penny" : "pence";
  return `${t} ${a}${t === "1" ? "" : "s"} and ${n} ${unit}`;
}

// Decimal expansion (e.g. "3.14" → "3 point 1 4").
function expandDecimal(e: string): string {
  const [a, t] = e.split(".");
  return `${a} point ${t.split("").join(" ")}`;
}

function normalizeText(e: string): string {
  return e
    .replace(/[‘’]/g, "'").replace(/«/g, "“").replace(/»/g, "”").replace(/[“”]/g, '"')
    .replace(/\(/g, "«").replace(/\)/g, "»")
    .replace(/、/g, ", ").replace(/。/g, ". ").replace(/！/g, "! ").replace(/，/g, ", ")
    .replace(/：/g, ": ").replace(/；/g, "; ").replace(/？/g, "? ")
    .replace(/[^\S \n]/g, " ").replace(/  +/g, " ").replace(/(?<=\n) +(?=\n)/g, "")
    .replace(/\bD[Rr]\.(?= [A-Z])/g, "Doctor")
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, "Mister")
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, "Miss")
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, "Mrs")
    .replace(/\betc\.(?! [A-Z])/gi, "etc")
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, expandNumber)
    .replace(/(?<=\d),(?=\d)/g, "")
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, expandMoney)
    .replace(/\d*\.\d+/g, expandDecimal)
    .replace(/(?<=\d)-(?=\d)/g, " to ")
    .replace(/(?<=\d)S/g, " S")
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, "s")
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, "-"))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, "-")
    .trim();
}

// Punctuation the split keeps verbatim (matches kokoro-js's `u` regex set).
const PUNCT = `;:,.!?¡¿—…"«»“”(){}[]`;
const PUNCT_SPLIT = new RegExp(
  `(\\s*[${PUNCT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}]+\\s*)+`,
  "g",
);

interface Segment { punct: boolean; text: string }

function segment(e: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of e.matchAll(PUNCT_SPLIT)) {
    const hit = m[0];
    if (last < m.index!) out.push({ punct: false, text: e.slice(last, m.index) });
    if (hit.length > 0) out.push({ punct: true, text: hit });
    last = m.index! + hit.length;
  }
  if (last < e.length) out.push({ punct: false, text: e.slice(last) });
  return out;
}

type Phonemize = (text: string, lang: string) => Promise<string[]>;

// Public entry: text → IPA token string, punctuation preserved. Kitten voices
// are all English, so language is fixed to en-us.
export async function phonemizeKitten(text: string, phonemize: Phonemize): Promise<string> {
  const norm = normalizeText(text);
  const segs = segment(norm);
  const parts = await Promise.all(
    segs.map(async (s) => (s.punct ? s.text : (await phonemize(s.text, "en-us")).join(" "))),
  );
  const joined = parts.join("");
  return joined
    .replace(/ʲ/g, "j").replace(/r/g, "ɹ").replace(/x/g, "k").replace(/ɬ/g, "l")
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, " ")
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, "z")
    .replace(/(?<=nˈaɪn)ti(?!ː)/g, "di")
    .trim();
}

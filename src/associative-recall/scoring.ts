export function timeProximity(a: number, b: number): number {
  const diff = Math.abs(a - b);
  const wrapped = Math.min(diff, 24 - diff);
  return 1 - wrapped / 12;
}

export function overlapScore(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b.map((s) => s.toLowerCase()));
  let matches = 0;
  for (const item of a) {
    if (setB.has(item.toLowerCase())) matches++;
  }
  return matches / Math.max(a.length, b.length);
}

export function textContains(text: string, trigger: string): boolean {
  return text.toLowerCase().includes(trigger.toLowerCase());
}

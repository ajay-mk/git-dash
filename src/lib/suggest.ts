/**
 * Picks repository suggestions (`owner/name`) matching what has been typed,
 * case-insensitively. Matches at the start of the full name rank first, then
 * matches at the start of the repository name, then anywhere; ties keep the
 * order of `all` (most recently pushed first). An empty query matches all.
 */
export function matchRepos(
  all: readonly string[],
  query: string,
  exclude: ReadonlySet<string>,
  limit: number,
): string[] {
  const q = query.trim().toLowerCase();
  const ranked: { name: string; rank: number }[] = [];
  for (const name of all) {
    const lower = name.toLowerCase();
    if (exclude.has(lower)) continue;
    const repo = lower.slice(lower.indexOf('/') + 1);
    const rank = lower.startsWith(q) ? 0 : repo.startsWith(q) ? 1 : lower.includes(q) ? 2 : -1;
    if (rank >= 0) ranked.push({ name, rank });
  }
  // Array.prototype.sort is stable, so equal ranks keep their order.
  return ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((r) => r.name);
}

// Trait rarity per collection, computed once from the frozen item templates and
// cached in memory (items never change after deploy). Score = the classic
// rarity score, sum over an item's traits of N / count(trait, value); rank 1 is
// the rarest. Tiers follow the launchpad legend: top 2% legendary, top 10%
// epic, top 30% rare, the rest common. Collections whose items carry no
// attributes have no rarity at all (null), so nothing is invented.
import { db } from "./db.ts";

export type Tier = "legendary" | "epic" | "rare" | "common";
export type Rarity = { rank: number; tier: Tier; score: number };

const itemsStmt = db.query<{ item_index: number; template: string }, [string]>("SELECT item_index, template FROM item WHERE slug = ?");
const cache = new Map<string, Map<number, Rarity> | null>();

export function rarityOf(slug: string): Map<number, Rarity> | null {
  if (cache.has(slug)) return cache.get(slug)!;
  const rows = itemsStmt.all(slug);
  const traits = rows.map((r) => {
    try {
      const t = JSON.parse(r.template) as { attributes?: { trait_type?: string; value?: unknown }[] };
      return (t.attributes ?? []).filter((a) => a && a.trait_type != null).map((a) => `${a.trait_type}\u0000${String(a.value)}`);
    } catch { return []; }
  });
  if (!traits.some((t) => t.length)) { cache.set(slug, null); return null; }
  const count = new Map<string, number>();
  for (const t of traits) for (const k of t) count.set(k, (count.get(k) ?? 0) + 1);
  const n = rows.length;
  const scored = rows.map((r, i) => ({ index: r.item_index, score: traits[i].reduce((s, k) => s + n / count.get(k)!, 0) }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const out = new Map<number, Rarity>();
  scored.forEach((s, i) => {
    const pct = (i + 1) / n;
    out.set(s.index, { rank: i + 1, score: Math.round(s.score * 100) / 100, tier: pct <= 0.02 ? "legendary" : pct <= 0.1 ? "epic" : pct <= 0.3 ? "rare" : "common" });
  });
  cache.set(slug, out);
  return out;
}

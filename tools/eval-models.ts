// Walk-forward evaluation of candidate implied-value models, measured, not asserted.
//
//   node tools/eval-models.ts [snapshot.json]
//
// Each candidate is refit at each cutoff on the protocols that trade (they record a market cap and a
// TVL) and were listed before it, then scores the trading protocols listed on or after it. A
// candidate's headline number is the mean over cutoffs of the Spearman rank correlation between its
// implied value and the actual market cap; the top-fifth hit is the share of the actual market-cap top
// fifth that the candidate also ranks in its top fifth. The winner moves into lib/model.ts unchanged.
//
// Categories are carried through the evaluation itself (the row's own category from the snapshot),
// which is what the shipped model's Comp type has to do too: a comparable with no category is pooled
// into one giant "Uncategorised" bucket and the per-category medians are dead on arrival.

import { readFileSync } from 'node:fs';
import { compSet, comparables, monthsBetween, parseSnapshot, scoreProtocol, spearman } from '../lib/model.ts';
import type { Comp, Snapshot, SnapshotProtocol } from '../lib/model.ts';

type CatComp = Comp & { category: string };
type Scorer = (p: SnapshotProtocol, train: CatComp[], snapshot: Snapshot) => number;

export const CUTOFFS = ['2025-01-01', '2025-07-01', '2026-01-01'];

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return Number.NaN;
  const m = n >> 1;
  return n % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const primaryChain = (p: SnapshotProtocol) => (p.chains.length ? p.chains[0]! : 'none');

export function withCategory(snapshot: Snapshot, comps: Comp[]): CatComp[] {
  const cat = new Map(snapshot.protocols.map((p) => [p.slug, p.category ?? 'Uncategorised']));
  return comps.map((c) => ({ ...c, category: cat.get(c.slug) ?? 'Uncategorised' }));
}

// A row's own growth and age adjustment, shared by every candidate so only the base ratio differs.
const growth = (c: number | null) => 1 + 0.5 * clamp((c ?? 0) / 100, -0.5, 0.5);
const age = (snapshot: Snapshot, p: SnapshotProtocol) => {
  const m = monthsBetween(snapshot.as_of, p.listed_at) ?? 18;
  return 0.85 + 0.45 * (Math.min(m, 36) / 36);
};

/** Category median mcap/TVL shrunk toward the global median with weight k. */
const catBase = (p: SnapshotProtocol, train: CatComp[], k: number) => {
  const g = median(train.map((c) => c.ratio));
  const rs = train.filter((c) => c.category === (p.category ?? 'Uncategorised')).map((c) => c.ratio);
  return (rs.length * median(rs) + k * g) / (rs.length + k);
};

/** Pooled first-stage slopes on (log tvl, log ratio) across all training comparables. */
const fitSlope = (xy: [number, number][], cap: number) => {
  const mt = mean(xy.map((x) => x[0]));
  const mr = mean(xy.map((x) => x[1]));
  let num = 0;
  let den = 0;
  for (const [t, r] of xy) {
    num += (t - mt) * (r - mr);
    den += (t - mt) ** 2;
  }
  const b = clamp(den > 0 ? num / den : 0, -cap, cap);
  return { b, mt, mr };
};

/** Means of a residual by key, shrunk toward zero with k pseudo-observations. */
const shrunkOffsets = (pairs: [string, number][], k: number) => {
  const by = new Map<string, number[]>();
  for (const [key, v] of pairs) {
    const list = by.get(key);
    if (list) list.push(v);
    else by.set(key, [v]);
  }
  const out = new Map<string, number>();
  for (const [key, rs] of by) out.set(key, rs.reduce((a, v) => a + v, 0) / (rs.length + k));
  return out;
};

const combo = (p: SnapshotProtocol, snapshot: Snapshot, ratio: number) =>
  p.tvl_usd * clamp(ratio * growth(p.change_7d) * age(snapshot, p), 0.02, 1.5);

export function evaluate(scorer: Scorer, snapshot: Snapshot) {
  const per: { cutoff: string; n: number; rho: number; hit: number }[] = [];
  for (const cutoff of CUTOFFS) {
    const train = withCategory(snapshot, comparables(snapshot, cutoff));
    const preds: number[] = [];
    const acts: number[] = [];
    for (const p of snapshot.protocols) {
      if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
      if (p.listed_at === null || p.listed_at < cutoff) continue;
      preds.push(scorer(p, train, snapshot));
      acts.push(p.mcap_usd);
    }
    const rho = preds.length >= 3 ? spearman(preds, acts) : 0;
    const k = Math.max(1, Math.round(preds.length * 0.2));
    const top = (xs: number[]) => new Set(xs.map((v, i) => [v, i] as [number, number]).sort((x, y) => y[0] - x[0]).slice(0, k).map(([, i]) => i));
    const tp = top(preds);
    const ta = top(acts);
    let hit = 0;
    for (const i of tp) if (ta.has(i)) hit += 1;
    per.push({ cutoff, n: preds.length, rho, hit: preds.length ? hit / k : 0 });
  }
  return { per, mean_rho: mean(per.map((x) => x.rho)), mean_hit: mean(per.map((x) => x.hit)) };
}

function main(): void {
  const path = process.argv[2] ?? '/home/ubuntu/projects/makefun/kits/token-radar-01/token-radar-01-kit/input/snapshot.json';
  const snapshot = parseSnapshot(readFileSync(path, 'utf8'));

  // (a) the shipped model as it stood: category medians, but the comparable set loses its categories.
  const a0: Scorer = (p, train, snap) => {
    const s = scoreProtocol(p, compSet(train.map(({ category: _c, ...rest }) => rest as Comp)), snap.as_of);
    return p.tvl_usd * s.ratio_used;
  };
  // (a) the same model with categories carried: the shipped one, after the Comp fix.
  const a1: Scorer = (p, train, snap) => p.tvl_usd * scoreProtocol(p, compSet(train), snap.as_of).ratio_used;

  // (b) log-log of mcap on tvl, pooled slope, plus a per-chain offset on the log ratio.
  const bx: Scorer = (p, train, snap) => {
    const fx = fitSlope(train.map((c) => [Math.log(c.tvl_usd), Math.log(c.ratio)] as [number, number]), 3);
    const at = new Map(train.map((c) => [c.slug, c]));
    const byChain = new Map<string, string[]>();
    for (const pr of snapshot.protocols) byChain.set(pr.slug, pr.chains);
    const off = shrunkOffsets(train.map((c) => [primaryChain(byChain.get(c.slug) ? { chains: byChain.get(c.slug)! } as SnapshotProtocol : { chains: [] } as SnapshotProtocol), Math.log(c.ratio) - fx.mr - fx.b * (Math.log(c.tvl_usd) - fx.mt)] as [string, number]), 3);
    void at;
    const ratio = Math.exp(fx.mr + fx.b * (Math.log(p.tvl_usd) - fx.mt) + (off.get(primaryChain(p)) ?? 0));
    return combo(p, snap, ratio);
  };

  // (c) log-log of mcap on tvl with category offsets on the log ratio, refit per cutoff.
  const cx: Scorer = (p, train, snap) => {
    const fx = fitSlope(train.map((c) => [Math.log(c.tvl_usd), Math.log(c.mcap_usd)] as [number, number]), 2);
    const a = fx.mr - fx.b * fx.mt;
    const off = shrunkOffsets(train.map((c) => [c.category, Math.log(c.mcap_usd) - a - fx.b * Math.log(c.tvl_usd)] as [string, number]), 3);
    const ratio = Math.exp(a + fx.b * Math.log(p.tvl_usd) + (off.get(p.category ?? 'Uncategorised') ?? 0));
    return combo(p, snap, ratio);
  };

  // (d) category median, no chain term, with a TVL slope folded into the level.
  const dx: Scorer = (p, train, snap) => {
    const fx = fitSlope(train.map((c) => [Math.log(c.tvl_usd), Math.log(c.ratio)] as [number, number]), 0.5);
    return combo(p, snap, catBase(p, train, 6) * Math.exp(fx.b * (Math.log(p.tvl_usd) - fx.mt)));
  };

  // (e) category median, plus the per-chain offset as a multiplier.
  const ex: Scorer = (p, train, snap) => {
    const n = train.length;
    const mt = mean(train.map((c) => Math.log(c.tvl_usd)));
    const mr = mean(train.map((c) => Math.log(c.ratio)));
    const chainOf = new Map(snapshot.protocols.map((q) => [q.slug, primaryChain(q)]));
    const off = shrunkOffsets(train.map((c) => [chainOf.get(c.slug) ?? 'none', Math.log(c.ratio) - mr - 0.4 * (Math.log(c.tvl_usd) - mt)] as [string, number]), 3);
    void n;
    return combo(p, snap, catBase(p, train, 6) * Math.exp(off.get(primaryChain(p)) ?? 0));
  };

  // (f) the global median only: no category, the baseline any category model must beat.
  const fx0: Scorer = (p, train, snap) => combo(p, snap, median(train.map((c) => c.ratio)));

  // (g) category median at a range of shrink weights, no slopes at all.
  const shrink = (k: number): Scorer => (p, train, snap) => combo(p, snap, catBase(p, train, k));

  // (h) the category median is a ratio of medians (median mcap / median tvl in the category), more
  //     robust than a median of ratios when one comparable has a wild ratio.
  const hx: Scorer = (p, train, snap) => {
    const cat = p.category ?? 'Uncategorised';
    const rs = train.filter((c) => c.category === cat);
    const m = rs.length ? median(rs.map((c) => c.mcap_usd)) / median(rs.map((c) => c.tvl_usd)) : median(train.map((c) => c.ratio));
    const g = median(train.map((c) => c.ratio));
    return combo(p, snap, (rs.length * m + 6 * g) / (rs.length + 6));
  };

  // (i) ratio of medians with the pooled tvl slope (the best structure so far), k = 6.
  const ix: Scorer = (p, train, snap) => {
    const fx = fitSlope(train.map((c) => [Math.log(c.tvl_usd), Math.log(c.mcap_usd)] as [number, number]), 1);
    const g = median(train.map((c) => c.ratio));
    const life = median(train.map((c) => c.tvl_usd));
    const rg = Math.exp(fx.mr - fx.mt * fx.b);
    void life;
    return combo(p, snap, catBase(p, train, 6) * Math.exp((fx.b - 1) * (Math.log(p.tvl_usd) - fx.mt)) * (rg > 0 ? 1 : 1));
  };

  const candidates: [string, Scorer][] = [
    ['(a0) shipped: category median, categories lost in the compare set', a0],
    ['(a) shipped, categories carried: category median k = 6 + growth + age', a1],
    ['(b) log-log tvl, pooled slope + per-chain offset', bx],
    ['(c) log-log mcap ~ tvl + category offsets, refit per cutoff', cx],
    ['(d) category median k = 6 x tvl slope + growth + age', dx],
    ['(e) category median k = 6 x per-chain offset + growth + age', ex],
    ['(f) global median + growth + age (no category)', fx0],
    ['(g) category median k = 2 + growth + age', shrink(2)],
    ['(g) category median k = 4 + growth + age', shrink(4)],
    ['(g) category median k = 10 + growth + age', shrink(10)],
    ['(h) ratio of medians in category, k = 6 + growth + age', hx],
    ['(i) ratio of medians x tvl slope + growth + age', ix],
  ];
  const results = candidates.map(([name, s]) => ({ name, ...evaluate(s, snapshot) }));
  results.sort((a, b) => b.mean_rho - a.mean_rho);
  const pad = (s: string, n: number) => s.padEnd(n);
  process.stdout.write(`${pad('candidate', 74)} ${'mean rho'.padStart(8)} ${'mean hit'.padStart(8)}  per cutoff (rho, hit, n)\n`);
  for (const r of results) {
    const detail = r.per.map((x) => `${x.cutoff}: ${x.rho.toFixed(3)}, ${x.hit.toFixed(2)}, n=${x.n}`).join(' | ');
    process.stdout.write(`${pad(r.name, 74)} ${r.mean_rho.toFixed(4).padStart(8)} ${r.mean_hit.toFixed(3).padStart(8)}  ${detail}\n`);
  }
}

if (import.meta.main) main();

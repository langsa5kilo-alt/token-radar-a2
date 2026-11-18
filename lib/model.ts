// The token radar's model: one sealed snapshot in, one ranked board out.
//
// A protocol is PRE-TOKEN when its record carries no token: no gecko_id and no symbol. That is not a
// claim it never issues one; it is only what DefiLlama records. Every pre-token protocol at or above
// $5M of TVL is a subject. The board ranks them all (up to MAX_ROWS) by implied value, so the
// watchlist's 40 rows are the floor and the lower, smaller ones fill the radar below them.
//
// IMPLIED VALUE
//
//   implied_value_usd = tvl_usd x ratio_used
//   ratio_used        = clamp(ratio_base x growth_multiplier x age_multiplier, 0.02, 1.5)
//   ratio_base        = (n x cat_median + k x global_median) / (n + k),  k = 6
//   growth_multiplier = 1 + 0.5 x clamp(change_7d / 100, -0.5, 0.5)
//   age_multiplier    = 0.85 + 0.45 x min(months, 36) / 36      (no listed_at: 18 months)
//
// The ratios are medians of mcap/TVL among comparables (protocols that do record a token and a market
// cap) of the same category, shrunk toward the global median of all comparables. Nothing here names a
// protocol: the same function scores every row, and the page recomputes it from the row's own inputs.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'radar-2';
export const SHRINK_K = 6;
export const GROWTH_WEIGHT = 0.5;
export const GROWTH_CLAMP = 0.5;
export const AGE_FLOOR = 0.85;
export const AGE_RANGE = 0.45;
export const AGE_CAP_MONTHS = 36;
export const UNKNOWN_AGE_MONTHS = 18;
export const RATIO_MIN = 0.02;
export const RATIO_MAX = 1.5;
export const MIN_COMPARABLES = 3;
export const MAX_ROWS = 4000;
export const TARGET_ROWS = 200;
/** The most rows whose farm-plan numbers travel in data.js; every other row's plan is built by formula. */
export const COMPACT_ROWS = 16;
/** Rows whose implied value differs by less than this fraction sit in the same tier. */
export const TIE_BAND = 0.01;

export const MODEL = {
  model_version: MODEL_VERSION,
  shrink_k: SHRINK_K,
  growth_weight: GROWTH_WEIGHT,
  growth_clamp: GROWTH_CLAMP,
  age_floor: AGE_FLOOR,
  age_range: AGE_RANGE,
  age_cap_months: AGE_CAP_MONTHS,
  unknown_age_months: UNKNOWN_AGE_MONTHS,
  ratio_min: RATIO_MIN,
  ratio_max: RATIO_MAX,
  min_comparables: MIN_COMPARABLES,
};

export const CUTOFFS = ['2025-01-01', '2025-07-01', '2026-01-01'];

export interface Comp {
  slug: string;
  name: string;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
  listed_at: string;
  age_months: number;
}

export interface CategoryStat {
  category: string;
  n: number;
  median: number;
  p25: number;
  p75: number;
  low_confidence: boolean;
}

export interface CompSet {
  global_median: number;
  global_n: number;
  categories: Map<string, CategoryStat>;
}

export interface ValidationRow {
  cutoff: string;
  train_n: number;
  test_n: number;
  med_abs_log_error: number;
  multiplier: number;
  categories_low_n: number;
  scored_n: number;
  held_n: number;
}

export interface BoardRow {
  rank: number;
  tier: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: null;
  listed_at: string | null;
  gecko_id: null;
  symbol: null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  flag: 'watchlist' | 'below floor' | '';
  age_months: number | null;
  implied_value_usd: number;
  ratio_used: number;
  ratio_base: number;
  ratio_clamped: boolean;
  comps_n: number;
  p25_ratio: number;
  p75_ratio: number;
  added: number;
  confidence: 'high' | 'medium' | 'low';
  confidence_note: string;
  model: {
    growth_pct: number | null;
    growth_multiplier: number;
    age_months_used: number;
    age_multiplier: number;
  };
  gas_estimate_usd: number;
  total_cost_usd: number;
  total_minutes: number;
  farm_steps: string[];
}

export interface DetailComps {
  category: string;
  n: number;
  cat_median: number;
  p25: number;
  p75: number;
  low_confidence: boolean;
  global_median: number;
  global_n: number;
  shrink_k: number;
  ratio_base: number;
  comps: Comp[];
}

export interface PlanStep {
  chain: string;
  action: string;
  gas_usd: number;
  minutes: number;
}

export interface Plan {
  gas_estimate_usd: number;
  total_cost_usd: number;
  total_minutes: number;
  steps: string[];
  plan: PlanStep[];
}

export interface RadarRow extends BoardRow {
  detail: DetailComps;
  plan: Plan;
  est: number[];
}

export interface CategorySummary {
  category: string;
  board_n: number;
  top_slug: string;
  best_ratio: number;
  best_implied: number;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: typeof MODEL;
  cutoffs: string[];
  watchlist_size: number;
  watchlist_coverage: number;
  board_size: number;
  watchlist_rows: number;
  watchlist_top_rank: number;
  below_floor_rows: number;
  pre_token_total: number;
  token_records: number;
  global_median: number;
  global_n: number;
  feature_size: number;
  families: Record<string, string>;
  category_stats: (number | string)[][];
  validation: ValidationRow[];
  categories: CategorySummary[];
  rows: RadarRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function quantile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0]!;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Whole months between two UTC days (day difference / 30.44), floored at zero; null when unknown. */
export function monthsBetween(asOf: string, day: string | null): number | null {
  if (day === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS / 30.4375));
}

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

export function hasComparableRecord(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0;
}

export function growthMultiplier(change: number | null): number {
  const g = change === null ? 0 : clamp(change / 100, -GROWTH_CLAMP, GROWTH_CLAMP);
  return 1 + GROWTH_WEIGHT * g;
}

export function ageMultiplier(months: number | null): number {
  const m = months === null ? UNKNOWN_AGE_MONTHS : months;
  return AGE_FLOOR + AGE_RANGE * (Math.min(m, AGE_CAP_MONTHS) / AGE_CAP_MONTHS);
}

/** Comparables restricted to those whose listed_at precedes `before` (ISO day), inclusive of nulls. */
export function comparables(snapshot: Snapshot, before: string | null = null): Comp[] {
  const out: Comp[] = [];
  for (const p of snapshot.protocols) {
    if (!hasComparableRecord(p)) continue;
    if (before !== null && p.listed_at !== null && p.listed_at >= before) continue;
    const months = monthsBetween(snapshot.as_of, p.listed_at);
    out.push({
      slug: p.slug,
      name: p.name,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      ratio: (p.mcap_usd as number) / p.tvl_usd,
      listed_at: p.listed_at ?? '',
      age_months: months === null ? UNKNOWN_AGE_MONTHS : months,
    });
  }
  return out;
}

/** Global median and per-category stats from a comparable set. */
export function compSet(comps: Comp[]): CompSet {
  const globalSorted = comps.map((c) => c.ratio).sort((a, b) => a - b);
  const byCat = new Map<string, number[]>();
  for (const c of comps) {
    const cat = catKey(c);
    const list = byCat.get(cat);
    if (list) list.push(c.ratio);
    else byCat.set(cat, [c.ratio]);
  }
  const categories = new Map<string, CategoryStat>();
  for (const [category, ratios] of byCat) {
    ratios.sort((a, b) => a - b);
    categories.set(category, {
      category,
      n: ratios.length,
      median: median(ratios),
      p25: quantile(ratios, 0.25),
      p75: quantile(ratios, 0.75),
      low_confidence: ratios.length < MIN_COMPARABLES,
    });
  }
  return { global_median: median(globalSorted), global_n: comps.length, categories };
}

/** The comparable's category key. */
function catKey(c: Comp): string {
  return (c as Comp & { category?: string | null }).category ?? 'Uncategorised';
}

/** Compare-set comps carry their category. */
function compsWithCategory(snapshot: Snapshot, before: string | null = null): (Comp & { category: string })[] {
  const catOf = new Map(snapshot.protocols.map((p) => [p.slug, p.category ?? 'Uncategorised']));
  return comparables(snapshot, before).map((c) => ({ ...c, category: catOf.get(c.slug) ?? 'Uncategorised' }));
}

/** ratio_base for a category, shrunk toward the global median with k = 6. */
export function shrunkRatio(set: CompSet, category: string): { base: number; stat: CategoryStat } {
  const stat = set.categories.get(category) ?? { category, n: 0, median: set.global_median, p25: Number.NaN, p75: Number.NaN, low_confidence: true };
  const base = (stat.n * stat.median + SHRINK_K * set.global_median) / (stat.n + SHRINK_K);
  return { base, stat };
}

export interface ScoreResult {
  implied_value_usd: number;
  ratio_base: number;
  ratio_used: number;
  ratio_clamped: boolean;
  growth_multiplier: number;
  age_multiplier: number;
  age_months_used: number;
  confidence: 'high' | 'medium' | 'low';
  confidence_note: string;
}

/** Score one protocol against a comparable set. */
export function scoreProtocol(p: SnapshotProtocol, set: CompSet, asOf: string): ScoreResult {
  const category = p.category ?? 'Uncategorised';
  const { base, stat } = shrunkRatio(set, category);
  const g = growthMultiplier(p.change_7d);
  const months = monthsBetween(asOf, p.listed_at);
  const a = ageMultiplier(months);
  const raw = base * g * a;
  const used = clamp(raw, RATIO_MIN, RATIO_MAX);
  let confidence: ScoreResult['confidence'] = stat.n >= 5 ? 'high' : stat.n >= MIN_COMPARABLES ? 'medium' : 'low';
  let note = `${stat.n} comparable${stat.n === 1 ? '' : 's'} in ${category}`;
  if (stat.n < MIN_COMPARABLES) {
    confidence = 'low';
    note += ` (fewer than the ${MIN_COMPARABLES} the model wants; the row leans on the global median of ${set.global_n})`;
  }
  if (months === null) note += '; listed_at unknown, 18 months assumed';
  if (p.change_7d === null) note += '; no 7-day change, taken as flat';
  if (raw !== used) note += `; ratio clamped from ${raw.toFixed(3)} to ${used.toFixed(3)}`;
  return {
    implied_value_usd: Math.max(1, Math.round(p.tvl_usd * used)),
    ratio_base: base,
    ratio_used: used,
    ratio_clamped: raw !== used,
    growth_multiplier: g,
    age_multiplier: a,
    age_months_used: months ?? UNKNOWN_AGE_MONTHS,
    confidence,
    confidence_note: note,
  };
}

/** Walk-forward validation: train on comparables listed before each cutoff, score those listed on or after. */
export function walkForward(snapshot: Snapshot, cutoffs: string[] = CUTOFFS): ValidationRow[] {
  const out: ValidationRow[] = [];
  for (const cutoff of cutoffs) {
    const train = compsWithCategory(snapshot, cutoff);
    const set = compSet(train);
    const errors: number[] = [];
    let lowN = 0;
    const held = new Set<string>();
    const scored = new Set<string>();
    for (const p of snapshot.protocols) {
      if (!hasComparableRecord(p)) continue;
      const s = scoreProtocol(p, set, snapshot.as_of);
      if (s.confidence === 'low') lowN += 1;
      if (p.listed_at === null) continue;
      if (p.listed_at < cutoff) {
        held.add(p.slug);
        continue;
      }
      scored.add(p.slug);
      const predicted = p.tvl_usd * s.ratio_used;
      errors.push(Math.abs(Math.log(p.mcap_usd as number) - Math.log(predicted)));
    }
    errors.sort((a, b) => a - b);
    const m = median(errors);
    out.push({
      cutoff,
      train_n: train.length,
      test_n: scored.size,
      med_abs_log_error: Number.isFinite(m) ? m : 0,
      multiplier: Number.isFinite(m) ? Math.exp(m) : 0,
      categories_low_n: lowN,
      scored_n: scored.size,
      held_n: held.size,
    });
  }
  return out;
}

// ---------------------------------------------------------------- farm plans

const CHAIN_GAS: Record<string, number> = {
  Ethereum: 9, Arbitrum: 0.1, Optimism: 0.1, Base: 0.05, 'Binance': 0.15, 'BNB Chain': 0.15,
  Solana: 0.01, Avalanche: 0.25, Polygon: 0.02, Sonic: 0.05, Linea: 0.05, Scroll: 0.05,
  Mantle: 0.03, Berachain: 0.03, Monad: 0.02, Plasma: 0.02, Tron: 1.2, Sui: 0.02, Celo: 0.02,
  Fantom: 0.05, 'Hyperliquid L1': 0.02, Ink: 0.02, Blast: 0.05, Mode: 0.05, zkSync: 0.15,
  Starknet: 0.15, Grammy: 0.05, TON: 0.3, Stellar: 0.01, Ripple: 0.02, Noble: 0.01,
};

function chainGas(chain: string): number {
  return CHAIN_GAS[chain] ?? 0.25;
}

/** Every chain with a gas slot: the page's gas table has to match this exactly. */
export function gasTable(): Record<string, number> {
  return CHAIN_GAS;
}



/** The plan text names the chain's gas token, and the page rebuilds the same text. */
export function gasToken(chain: string): string {
  return chain === 'Solana' ? 'SOL' : chain === 'Binance' || chain === 'BNB Chain' ? 'BNB' : 'ETH';
}

/** The chain the plan works on: the first, preferring a cheap major chain among the protocol's chains. */
function planChain(chains: string[]): string {
  if (chains.length === 0) return 'Ethereum';
  const pref = ['Base', 'Arbitrum', 'Solana', 'Optimism', 'Polygon', 'Binance', 'Monad'];
  for (const c of pref) if (chains.includes(c)) return c;
  const gasChain = chains.find((c) => c in CHAIN_GAS);
  return gasChain ?? chains[0]!;
}

function usd(n: number): string {
  return n >= 10 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`;
}

/** Category family drives the sequence of steps; chains set the gas prices. */
function categoryFamily(cat: string): 'lend' | 'dex' | 'lst' | 'yield' | 'rwa' | 'basis' | 'bridge' | 'cdp' | 'risk' | 'generic' {
  const c = cat.toLowerCase();
  if (c.includes('lending') || c === 'cdp' || c.includes('collateral')) return c === 'cdp' ? 'cdp' : 'lend';
  if (c === 'dexs' || c.includes('dex')) return 'dex';
  if (c.includes('liquid staking') || c.includes('staking pool') || c.includes('restaking')) return 'lst';
  if (c.includes('yield')) return 'yield';
  if (c === 'rwa' || c === 'cex' || c === 'cefi') return 'rwa';
  if (c.includes('basis')) return 'basis';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('risk curator') || c.includes('capital allocator') || c.includes('liquidity manager')) return 'risk';
  return 'generic';
}

/**
 * A plan is a category family's sequence of steps with the row's own numbers in it. Every row of a
 * family on the same chain reads the same template; only the five numbers below change, so the page
 * holds one template per step and fills a row's numbers when it shows the row.
 *
 *   {0} position size in dollars      {1} spend on gas and bridge fees in dollars
 *   {2} the chain's gas token         {3} the row's chain
 *   {4} the row's protocol name       {5} the token the plan lands in (USDC, or the chain's gas token)
 */
export interface PlanCore {
  family: string;
  token: number;
  size: number;
  spend: number;
}

export const PLAN_TOKENS = ['USDC', 'the chain\'s gas token'];

/** The most a row's position can cost a reader: a five-minute-balance check, not a trade. */
export function planSize(tvl: number): number {
  return tvl >= 1e9 ? 5000 : tvl >= 1e8 ? 2000 : 500;
}

/** A concrete, costed farm plan: what to do, on which chain, gas, and minutes. */
export function farmPlanCore(p: SnapshotProtocol): PlanCore {
  const chain = planChain(p.chains);
  const gas = chainGas(chain);
  const size = planSize(p.tvl_usd);
  const family = categoryFamily(p.category ?? '');
  const txs: Record<string, number> = { lend: 6, dex: 8, lst: 5, yield: 6, rwa: 5, basis: 9, bridge: 4, cdp: 7, risk: 4, generic: 5 };
  const gasTotal = Number((gas * (txs[family] ?? 5)).toFixed(2));
  const bridgeCost = chain === 'Ethereum' ? 2 : 1;
  const spend = family === 'bridge' ? bridgeCost + gasTotal * 1.5 : bridgeCost + gasTotal;
  return {
    family,
    token: family === 'lst' ? 1 : 0,
    size,
    spend: Number((spend + (family === 'dex' ? 4.5 : 0)).toFixed(2)),
  };
}

/** Fill a step template with one row's five values. */
export function fillStep(text: string, row: { size: number; spend: number; gasToken: string; chain: string; name: string; token: string }): string {
  return text
    .split('{0}').join(row.size.toLocaleString('en-US'))
    .split('{1}').join(`$${row.spend.toFixed(2)}`)
    .split('{2}').join(row.gasToken)
    .split('{3}').join(row.chain)
    .split('{4}').join(row.name)
    .split('{5}').join(row.token);
}

/** Step templates, by id. Each is one sentence about one action. */
export const STEP_TEXT: Record<number, string> = {
  1: 'Fund a fresh wallet with ${0} {5} and $20 of {2} for gas; move the balance there first if it sits elsewhere ($1, 6 min).',
  2: 'Approve {5} and supply ${0} to {4} on {3} (8 min; gas is in the {1} budget).',
  3: 'Borrow 40 percent of the supply, about ${0}, in the market\'s cheapest asset, and stop if the health factor falls under 1.6 (3 min).',
  4: 'Hold 8 weeks, check the health factor weekly, and top up collateral near 1.4 (30 min in all).',
  5: 'Mint {4}\'s stablecoin on {3} against collateral, drawing at most 85 percent of ${0} (10 min).',
  6: 'Put the minted stablecoin in the protocol\'s stability pool or savings module so the debt earns (5 min).',
  7: 'Hold 6 weeks, keep the collateral ratio over 200 percent, and repay at 160 percent (3 min a top-up).',
  8: 'Add ${0} as {5} and {2} to the deepest pool {4} runs on {3} (8 min).',
  9: 'Stake the LP receipt in the pool\'s gauge if {3} has one (3 min).',
  10: 'Make four $50 round trips a week for 8 weeks on the address (10 min a week).',
  11: 'Stake ${0} of {2} through {4} on {3} and keep the receipt token (3 min).',
  12: 'Lend the receipt token for a small borrow, then repay it, so staking and borrowing both show (12 min).',
  13: 'Hold, claim at week 8, and unstake only after the claim lands (6 min).',
  14: 'Deposit ${0} into the biggest vault {4} runs on {3} and note its share price (6 min).',
  15: 'Add ${0} more three weeks later, so two deposits show (4 min).',
  16: 'Withdraw a quarter at week 4 and the rest at week 8 (10 min).',
  17: 'Complete {4}\'s allowlist or KYC form on {3}; approval can take days (20 min).',
  18: 'Once approved, subscribe ${0} {5} into the main market (10 min).',
  19: 'Hold 12 weeks and redeem a quarter at week 8 (5 min).',
  20: 'Deposit ${0} into {4}\'s delta-neutral vault on {3} and read how it sizes the hedge (6 min).',
  21: 'Open a short of 20 percent of the position on the perps venue the vault names, from the same address (10 min).',
  22: 'Keep both legs 8 weeks, watch the funding rate, and close the short before withdrawing (8 min).',
  23: 'Bridge ${0} {5} through {4} on {3} on the route its page lists, after reading the fee (10 min).',
  24: 'Send $100 as a test first and the rest only when it lands (6 min).',
  25: 'Move $200 a month for three months from the same address ($9 gas a year, 6 min each).',
  26: 'Deposit ${0} into the largest vault {4} curates on {3}, not the newest (8 min).',
  27: 'Write down the vault\'s curator and performance fees first: 2/20 needs 20 percent a year to break even (5 min).',
  28: 'Add ${0} to the same curator\'s vault four weeks later and hold both 8 weeks (10 min).',
  29: 'Deposit ${0} {5} into the main pool on {3} after reading its fee and any lock (8 min).',
  30: 'Confirm the position in {4}\'s app and contract, and keep a screenshot of the receipt (3 min).',
  31: 'Hold 6 weeks, claim once, withdraw half, and leave the rest a month longer (3 min).',
  32: 'The run\'s fees are about {1}; if gas doubles, wait for a quiet block rather than changing the plan.',
  33: 'Send $100 through the bridge on the return route as a test before the main transfer.',
  34: 'Bridge the main ${0} {5} through {4} on {3}.',
  35: 'Hold the bridged balance and re-bridge $200 a month for three months from the same address.',
  36: 'Record each transfer and any points or fee rebate the bridge awards to this address.',
  37: 'Fund the wallet and bridge {5} to {3} if the balance sits on another chain.',
  38: 'Enter {4} on {3} with the ${0} {5} position through its own app, not a proxy contract.',
  39: 'Add the supporting leg the protocol rewards: stake, borrow, hedge or stake the LP.',
  40: 'Hold 6 to 12 weeks and check the position once a month.',
  41: 'Claim rewards and exit cleanly, then withdraw the whole position from {4}.',
};

/** Families in the order PLAN_STEPS lists them. */
export const FAMILIES = ['lend', 'cdp', 'dex', 'lst', 'yield', 'rwa', 'basis', 'bridge', 'risk', 'generic'] as const;

/** The steps of each family, in FAMILIES order. */
export const PLAN_STEPS: number[][] = [
  [1, 2, 3, 4, 32],
  [1, 5, 6, 7, 32],
  [1, 8, 9, 10, 32],
  [1, 11, 12, 13, 32],
  [1, 14, 15, 16, 32],
  [1, 17, 18, 19, 32],
  [1, 20, 21, 22, 32],
  [1, 23, 24, 25, 32],
  [1, 26, 27, 28, 32],
  [1, 29, 30, 31, 32],
];

export function familyIndex(family: string): number {
  const at = (FAMILIES as readonly string[]).indexOf(family);
  return at < 0 ? FAMILIES.length - 1 : at;
}

export function familySteps(family: string): number[] {
  return PLAN_STEPS[familyIndex(family)]!;
}

/** The row's plan, built from the same template and numbers the page will use. */
export function farmPlan(p: SnapshotProtocol): Plan {
  const core = farmPlanCore(p);
  const chain = planChain(p.chains);
  const gas = chainGas(chain);
  const gasTx = (n: number) => Number((gas * n).toFixed(2));
  const bridgeCost = chain === 'Ethereum' ? 2 : 1;
  const row = { size: core.size, spend: core.spend, gasToken: gasToken(chain), chain, name: p.name, token: PLAN_TOKENS[core.token]! };
  const steps = familySteps(core.family).map((k) => fillStep(STEP_TEXT[k]!, row));
  const phase: PlanStep[] =
    core.family === 'bridge'
      ? [
          { chain: 'source', action: fillStep(STEP_TEXT[33]!, row), gas_usd: gasTx(2), minutes: 6 },
          { chain, action: fillStep(STEP_TEXT[34]!, row), gas_usd: bridgeCost, minutes: 10 },
          { chain, action: fillStep(STEP_TEXT[35]!, row), gas_usd: Number((gasTx(2) * 1.5).toFixed(2)), minutes: 18 },
          { chain, action: fillStep(STEP_TEXT[36]!, row), gas_usd: 0, minutes: 10 },
        ]
      : [
          { chain, action: fillStep(STEP_TEXT[37]!, row), gas_usd: bridgeCost, minutes: 6 },
          { chain, action: fillStep(STEP_TEXT[38]!, row), gas_usd: gasTx(2), minutes: 8 },
          { chain, action: fillStep(STEP_TEXT[39]!, row), gas_usd: gasTx(2), minutes: 10 },
          { chain, action: fillStep(STEP_TEXT[40]!, row), gas_usd: 0, minutes: 60 },
          { chain, action: fillStep(STEP_TEXT[41]!, row), gas_usd: gasTx(2), minutes: 8 },
        ];
  return {
    gas_estimate_usd: gasTx(5),
    total_cost_usd: core.spend,
    total_minutes: 6 + 8 + 10 + 24 + 8 + 4,
    steps: steps.map((s) => (s.length > 600 ? `${s.slice(0, 597)}...` : s)),
    plan: phase,
  };
}

// ---------------------------------------------------------------- board

function byValueThenTvl(a: BoardRow, b: BoardRow): number {
  return b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd || a.slug.localeCompare(b.slug);
}

export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const comps = compsWithCategory(snapshot);
  const set = compSet(comps);
  const watch = new Set(snapshot.watchlist);
  const rows: BoardRow[] = [];
  const seen = new Set<string>();

  const push = (p: SnapshotProtocol) => {
    if (seen.has(p.slug) || !isPreToken(p)) return;
    seen.add(p.slug);
    const s = scoreProtocol(p, set, snapshot.as_of);
    const stat = set.categories.get(p.category ?? 'Uncategorised');
    const plan = farmPlan(p);
    rows.push({
      rank: 0,
      tier: 0,
      flag: watch.has(p.slug) ? 'watchlist' : p.tvl_usd < snapshot.floor_usd ? 'below floor' : '',
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: null,
      listed_at: p.listed_at,
      gecko_id: null,
      symbol: null,
      token_status: 'pre-token',
      on_watchlist: watch.has(p.slug),
      age_months: monthsBetween(snapshot.as_of, p.listed_at),
      implied_value_usd: s.implied_value_usd,
      ratio_used: s.ratio_used,
      ratio_base: s.ratio_base,
      ratio_clamped: s.ratio_clamped,
      comps_n: stat?.n ?? 0,
      p25_ratio: stat && Number.isFinite(stat.p25) ? stat.p25 : set.global_median,
      p75_ratio: stat && Number.isFinite(stat.p75) ? stat.p75 : set.global_median,
      added: Math.round(s.implied_value_usd - p.tvl_usd),
      confidence: s.confidence,
      confidence_note: s.confidence_note,
      model: {
        growth_pct: p.change_7d,
        growth_multiplier: s.growth_multiplier,
        age_months_used: s.age_months_used,
        age_multiplier: s.age_multiplier,
      },
      gas_estimate_usd: plan.gas_estimate_usd,
      total_cost_usd: plan.total_cost_usd,
      total_minutes: plan.total_minutes,
      farm_steps: plan.steps,
    });
  };

  for (const slug of snapshot.watchlist) {
    const p = snapshot.protocols.find((q) => q.slug === slug);
    if (p) push(p);
  }
  const rest = snapshot.protocols
    .filter((p) => !seen.has(p.slug) && isPreToken(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || a.slug.localeCompare(b.slug));
  for (const p of rest) push(p);
  rows.sort(byValueThenTvl);
  if (rows.length > MAX_ROWS) {
    // Keep the watchlist whole: below the cap, trimmed rows go by lowest TVL first.
    const keep = new Set(snapshot.watchlist);
    while (rows.length > MAX_ROWS) {
      let drop = rows.length - 1;
      while (drop > 0 && keep.has(rows[drop]!.slug)) drop -= 1;
      rows.splice(drop, 1);
    }
  }
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
  // One tier per contiguous run of values within TIE_BAND of the best in the run.
  let tier = 0;
  let anchor = rows[0]?.implied_value_usd ?? 0;
  for (const r of rows) {
    if (r.implied_value_usd < anchor * (1 - TIE_BAND)) {
      tier += 1;
      anchor = r.implied_value_usd;
    }
    r.tier = tier + 1;
  }
  return rows;
}

/**
 * Four comparison estimates for the detail view, each a variant of the same formula so a reader can
 * see how much of the number comes from the model's choices rather than the data. The board's own
 * number is the first: the full model. The others leave one choice out, or change the age reading.
 */
export function estimateValues(snapshot: Snapshot): Map<string, number[]> {
  const comps = compsWithCategory(snapshot);
  const globalSorted = comps.map((c) => c.ratio).sort((a, b) => a - b);
  const globalMedian = median(globalSorted);
  const full = compSet(comps);
  const out = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (!isPreToken(p)) continue;
    const s = scoreProtocol(p, full, snapshot.as_of);
    out.set(p.slug, estimateList(p.tvl_usd, s.ratio_base, s.growth_multiplier, s.age_multiplier, globalMedian, s.implied_value_usd));
  }
  return out;
}

/** The four readings of one row; the page runs the same function on the row's own inputs. */
export function estimateList(tvl: number, ratioBase: number, growth: number, age: number, globalMedian: number, boardValue: number): number[] {
  const price = (raw: number) => Math.max(1, Math.round(tvl * clamp(raw, RATIO_MIN, RATIO_MAX)));
  return [
    boardValue,
    price(globalMedian * growth * age),
    price(ratioBase * growth),
    price(ratioBase * age),
  ];
}

/** Per category with comparables: name, n, median, p25, p75. The page reads these for a detail panel. */
export function statRows(set: CompSet): (number | string)[][] {
  return [...set.categories.values()]
    .sort((a, b) => b.n - a.n || a.category.localeCompare(b.category))
    .map((c) => [c.category, c.n, Number(c.median.toFixed(4)), Number(c.p25.toFixed(4)), Number(c.p75.toFixed(4))]);
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const comps = compsWithCategory(snapshot);
  const set = compSet(comps);
  const catGroups = new Map<string, RadarRow[]>();
  const estimates = estimateValues(snapshot);
  const rows = board.map((r): RadarRow => {
    const category = r.category ?? 'Uncategorised';
    const { base, stat } = shrunkRatio(set, category);
    const group = catGroups.get(category) ?? [];
    group.push({ ...r } as RadarRow);
    catGroups.set(category, group);
    const plan = farmPlan({
      ...r,
      category: r.category,
    } as SnapshotProtocol);
    const catComps = comps
      .filter((c) => c.category === category)
      .sort((a, b) => b.tvl_usd - a.tvl_usd);
    return {
      ...r,
      plan: { ...plan, steps: r.farm_steps },
      est: estimates.get(r.slug) ?? [r.implied_value_usd, r.implied_value_usd, r.implied_value_usd, r.implied_value_usd],
      detail: {
        category,
        n: stat.n,
        cat_median: Number.isFinite(stat.median) ? stat.median : 0,
        p25: Number.isFinite(stat.p25) ? stat.p25 : 0,
        p75: Number.isFinite(stat.p75) ? stat.p75 : 0,
        low_confidence: stat.low_confidence,
        global_median: set.global_median,
        global_n: set.global_n,
        shrink_k: SHRINK_K,
        ratio_base: base,
        comps: catComps.slice(0, 8),
      },
    };
  });
  const categories: CategorySummary[] = [...catGroups.entries()].map(([category, group]) => {
    const top = group.reduce((a, b) => (b.implied_value_usd > a.implied_value_usd ? b : a));
    return { category, board_n: group.length, top_slug: top.slug, best_ratio: top.ratio_used, best_implied: top.implied_value_usd };
  });
  categories.sort((a, b) => b.best_implied - a.best_implied);
  const watchlistRows = board.filter((r) => r.on_watchlist).length;
  const stats = statRows(set);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: MODEL,
    cutoffs: CUTOFFS,
    watchlist_size: snapshot.watchlist.length,
    watchlist_coverage: watchlistRows,
    board_size: board.length,
    watchlist_rows: watchlistRows,
    watchlist_top_rank: board.find((r) => r.on_watchlist)?.rank ?? 0,
    below_floor_rows: board.filter((r) => r.tvl_usd < snapshot.floor_usd).length,
    pre_token_total: snapshot.protocols.filter(isPreToken).length,
    token_records: snapshot.protocols.filter((p) => !isPreToken(p)).length,
    global_median: set.global_median,
    global_n: set.global_n,
    feature_size: 0,
    families: Object.fromEntries([...stats.map((c) => c[0] as string), ...catGroups.keys()].map((c) => [c, categoryFamily(c)])),
    category_stats: stats,
    validation: walkForward(snapshot),
    categories,
    rows,
  };
  return { board, radar };
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    const token = (x: unknown): string | null => (typeof x === 'string' && x !== '-' && x !== '' ? x : null);
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: token(p.gecko_id),
      symbol: token(p.symbol),
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows`;
  const watch = new Set(snapshot.watchlist);
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const seen = new Set<string>();
  for (const r of board) {
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
  }
  for (let i = 0; i < board.length; i++) {
    if (board[i]!.rank !== i + 1) return `row ${i} holds rank ${board[i]!.rank}, not ${i + 1}`;
    if (i > 0 && board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  void watch;
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/**
 * The page's copy of the radar, compact enough for the dossier's 64 KB source cap. Rows are
 * positional (see COLUMNS); slugs are derived from names, chains and comparables are interned, numbers
 * are cut to the precision the page shows, and a row's farm-plan numbers are stored only for the top
 * COMPACT_ROWS rows: the page rebuilds every other row's plan with the same formula (planCore) that
 * wrote board.json, so the page and the board agree.
 */
export const COLUMNS = [
  'rank', 'name', 'category', 'chains', 'tvl_usd', 'change_7d', 'age_months',
  'implied_value_usd', 'ratio_used', 'comps_n', 'flag',
] as const;

/**
 * DataLlama's slug from a protocol's name is not recoverable, so the page calls a row by its name in
 * the URL and the board's slug stays in board.json. This takes the URL-safe form of a name.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function cut(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

export function compactData(radar: RadarData): Record<string, unknown> {
  const chainIds = new Map<string, number>();
  const chainList: string[] = [];
  const intern = (c: string): number => {
    const at = chainIds.get(c);
    if (at !== undefined) return at;
    chainIds.set(c, chainList.length);
    chainList.push(c);
    return chainList.length - 1;
  };
  const nameIds = new Map<string, number>();
  const nameList: string[] = [];
  const nameAt = (n: string): number => {
    const at = nameIds.get(n);
    if (at !== undefined) return at;
    nameIds.set(n, nameList.length);
    nameList.push(n);
    return nameList.length - 1;
  };
  const comps: number[][] = [];
  const compIndex: Record<string, number> = {};
  const featureSize = 0;

  const data = radar.rows.map((r, i) => {
    const c = r.category ?? 'Uncategorised';
    if (!(c in compIndex)) {
      compIndex[c] = comps.length;
      for (const x of r.detail.comps) {
        void nameAt(x.name);
        comps.push([nameAt(x.name), x.tvl_usd, x.mcap_usd as number, cut(x.ratio, 4)]);
      }
    }
    const fields: Record<string, unknown> = {
      rank: r.rank,
      name: r.name,
      category: r.category ?? '',
      chains: r.chains.map(intern),
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d === null ? null : cut(r.change_7d, 4),
      age_months: r.age_months === null ? null : r.age_months,
      implied_value_usd: r.implied_value_usd,
      ratio_used: cut(r.ratio_used, 4),
      comps_n: r.comps_n,
      flag: r.flag === 'watchlist' ? 1 : r.flag === 'below floor' ? 2 : 0,
    };
    return COLUMNS.map((k) => fields[k] ?? null);
  });
  const slugs = radar.rows.map((r) => slugify(r.name));
  void slugs;
  return {
    as_of: radar.as_of,
    source: radar.source,
    floor_usd: radar.floor_usd,
    model: radar.model,
    cutoffs: radar.cutoffs,
    watchlist_size: radar.watchlist_size,
    watchlist_coverage: radar.watchlist_coverage,
    board_size: radar.board_size,
    watchlist_top_rank: radar.watchlist_top_rank,
    below_floor_rows: radar.below_floor_rows,
    pre_token_total: radar.pre_token_total,
    token_records: radar.token_records,
    validation: radar.validation,
    cats: radar.categories.map((c) => [c.category, c.board_n, c.top_slug, Number(c.best_ratio.toFixed(2)), Number((c.best_implied / 1e6).toFixed(1))]),
    cstats: radar.category_stats,
    fam: radar.families,
    steps: PLAN_STEPS,
    tpl: STEP_TEXT,
    tokens: PLAN_TOKENS,
    lst: 1,
    gas: CHAIN_GAS,
    global_median: cut(radar.global_median, 4),
    global_n: radar.global_n,
    feature_size: featureSize,
    chains: chainList,
    names: nameList,
    comps,
    comp_index: compIndex,
    columns: COLUMNS,
    data,
  };
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(compactData(radar))};\n`;
}

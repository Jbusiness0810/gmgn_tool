import type { ScreenerConfig } from "../config.js";
import type { ScoreBreakdown, Signals, Snapshot, TokenFacts } from "./model.js";

/**
 * Composite 0–100 score.
 *
 * The two delta signals are blended OR-style, so ONE strong recent delta is
 * enough to climb the ranking: a token adding holders fast with flat volume
 * (or vice versa) reaches 64 of the 80 momentum points; both together reach 80.
 *
 *   holder momentum   0–40   velocity vs target, % growth, acceleration bonus
 *   volume momentum   0–40   1m/5m volume vs the token's own 1h baseline,
 *                            OR trailing-5m volume vs the 5m before it
 *   momentum          0–80   1.6 × max(holder, volume) + 0.4 × min(holder, volume)
 *   confirmation     −4–20   buy ratio, 5m price move, smart money / KOLs
 *   penalties         ≤ 0    holders draining, bot-driven activity, concentration,
 *                            bundlers, insiders, dev overhang, snipers, extreme youth,
 *                            unverified source, fresh-wallet holders, serial creators
 *
 * Hard gates (supply control, rug/wash/honeypot, liquidity, holder count, and
 * on EVM chains ownership, taxes, LP lock and creator factories) zero the
 * score and mark the token blocked, no matter how fast it is moving.
 * Fresh launches (still on the curve, or younger than cfg.freshMaxAgeMin)
 * trade the liquidity floor for a market-cap floor: see isFreshLaunch().
 */
export function scoreToken(
  facts: TokenFacts,
  signals: Signals,
  latest: Snapshot | undefined,
  cfg: ScreenerConfig,
  now: number = Date.now()
): ScoreBreakdown {
  const reasons: string[] = [];
  const ageMin = facts.createdAt != null ? (now / 1000 - facts.createdAt) / 60 : null;
  const blockers = hardGates(facts, latest, cfg, ageMin);
  const holderTarget = Math.max(0.1, cfg.holderVelTarget);
  const volSpan = Math.max(0.01, cfg.volRatioTarget - 1); // 1× = baseline, target× = full

  // ---- Holder momentum (0–40) ----
  let holder = 0;
  if (signals.holderVelPerMin != null) {
    const velPart = clamp01(signals.holderVelPerMin / holderTarget);
    const pctPart = signals.holderPct5m != null ? clamp01(signals.holderPct5m / 0.10) : 0; // +10%/5m = full
    holder = 40 * (0.6 * velPart + 0.4 * pctPart);
    if (signals.holderAccel != null && signals.holderAccel > 0 && holder > 0) {
      holder = Math.min(40, holder * 1.15); // accelerating, not just growing
      reasons.push(`holder growth accelerating (+${signals.holderAccel.toFixed(1)}/min vs prior 5m)`);
    }
    if (signals.holderVelPerMin >= holderTarget / 2) {
      reasons.push(`+${Math.round(signals.holderDelta5m ?? 0)} holders in ${signals.minutesCovered?.toFixed(0)}m (${signals.holderVelPerMin.toFixed(1)}/min)`);
    }
  }

  // ---- Volume momentum (0–40) ----
  let volume = 0;
  const r1 = signals.volRatio1m;
  const r5 = signals.volRatio5m;
  const g5 = signals.volGrowth5m;
  if (r1 != null || r5 != null || g5 != null) {
    const r1Part = r1 != null ? clamp01((r1 - 1) / volSpan) : 0;
    const r5Part = r5 != null ? clamp01((r5 - 1) / Math.max(0.01, cfg.volRatioTarget * 0.8 - 1)) : 0;
    const baselinePart = 0.65 * r1Part + 0.35 * r5Part;          // vs the token's own hour
    const growthPart = g5 != null ? clamp01((g5 - 1) / volSpan) : 0; // vs ~5 minutes ago
    volume = 40 * Math.max(baselinePart, growthPart);
    // Thin absolute volume can't earn full points no matter the ratio.
    const volNow = latest?.vol1m ?? (latest?.vol5m != null ? latest.vol5m / 5 : 0);
    if (volNow < 1_000) volume *= clamp01(volNow / 1_000);
    if (r1 != null && r1 >= 2) reasons.push(`1m volume ${r1.toFixed(1)}× its 1h average`);
    if (g5 != null && g5 >= 1.5 && (latest?.vol5m ?? 0) > 5_000) {
      reasons.push(`5m volume ${g5.toFixed(1)}× the previous 5m (+$${fmtUsd(signals.volDelta5m ?? 0)})`);
    }
  }

  // ---- Momentum (0–80): OR-blend, one strong delta is enough ----
  const momentum = 1.6 * Math.max(holder, volume) + 0.4 * Math.min(holder, volume);

  // ---- Confirmation (−4–20) ----
  let confirmation = 0;
  if (signals.buyRatio5m != null && signals.buyRatio5m > 0.5) {
    confirmation += Math.min(8, ((signals.buyRatio5m - 0.5) / 0.25) * 8);
    if (signals.buyRatio5m >= 0.6) reasons.push(`${Math.round(signals.buyRatio5m * 100)}% of 5m swaps are buys`);
  }
  const p5 = facts.priceChange5m ?? signals.pricePct5m;
  if (p5 != null && p5 > 0) {
    confirmation += Math.min(6, (p5 / 30) * 6); // +30%/5m = full 6 pts
  } else if (p5 != null && p5 < -10) {
    confirmation -= 4; // holders/volume rising into a dumping price = distribution risk
    reasons.push(`price ${p5.toFixed(0)}% in 5m despite inflows — possible distribution`);
  }
  if (facts.smartMoney != null && facts.smartMoney > 0) {
    confirmation += Math.min(4, facts.smartMoney);
    if (facts.smartMoney >= 3) reasons.push(`${facts.smartMoney} smart-money wallets in`);
  }
  if (facts.kols != null && facts.kols > 0) confirmation += Math.min(2, facts.kols);
  confirmation = Math.max(-4, Math.min(20, confirmation));

  // ---- Soft penalties ----
  // Supply-control ramps start well under their hard gate so a token that is
  // *nearly* blocked already ranks below a clean one with the same momentum.
  let penalty = 0;
  const pen = (pts: number, why: string) => {
    if (pts <= 0) return;
    penalty -= pts;
    reasons.push(`⚠ ${why}`);
  };
  pen(ramp(signals.holderPct5m == null ? null : -signals.holderPct5m, 0.02, 0.10, 10),
    `holders draining: ${signals.holderDelta5m} in ${signals.minutesCovered?.toFixed(0)}m`);
  // Bot wallets show up as holders too: holder growth on a bot-heavy token is
  // partly fake. Live median is ~40%, so only the bot-dominated tail is docked.
  pen(ramp(facts.botRate, 0.5, 0.8, 8), `${pct(facts.botRate)} of activity is bot wallets`);
  pen(ramp(facts.top10Rate, 0.20, cfg.maxTop10Rate, 8), `top-10 hold ${pct(facts.top10Rate)}`);
  pen(ramp(facts.bundlerRate, 0.10, cfg.maxBundlerRate, 10), `bundled supply ${pct(facts.bundlerRate)}`);
  pen(ramp(facts.insiderRate, 0.05, cfg.maxInsiderRate, 8), `insiders hold ${pct(facts.insiderRate)}`);
  pen(ramp(facts.devHoldRate, 0.03, cfg.maxDevHoldRate, 4), `dev/team holds ${pct(facts.devHoldRate)}`);
  pen(ramp(facts.sniperHoldRate, 0.15, cfg.maxSniperHoldRate, 6), `snipers hold ${pct(facts.sniperHoldRate)}`);
  pen(facts.openSource === false ? 8 : 0, "contract source not verified");
  pen(ramp(facts.freshWalletRate, 0.3, 0.6, 8), `${pct(facts.freshWalletRate)} of holders are fresh wallets`);
  pen(ramp(facts.creatorTokens, 3, cfg.maxCreatorTokens, 8), `creator has launched ${facts.creatorTokens} tokens`);

  // Youth: 10 pts at launch fading to 0 at 10 minutes (deltas need ~4 min of
  // history anyway, and the volume baseline is already age-aware).
  pen(ramp(ageMin == null ? null : 10 - ageMin, 0, 10, 10), `only ${ageMin?.toFixed(0)}m old, signals still settling`);

  const intensity = momentumIntensity(signals, cfg);
  const total = Math.max(0, Math.min(100, momentum + confirmation + penalty));
  return {
    holder: round1(holder),
    volume: round1(volume),
    momentum: round1(momentum),
    confirmation: round1(confirmation),
    penalty: round1(penalty),
    intensity: round1(intensity),
    total: round1(blockers.length ? 0 : total),
    reasons,
    blockers,
  };
}

/**
 * Strongest recent delta as a multiple of its target, unclamped (1 = exactly at
 * target, 3 = three times it). Used to order tokens whose scores tie once the
 * components saturate, so the biggest mover goes first.
 */
export function momentumIntensity(signals: Signals, cfg: ScreenerConfig): number {
  const volSpan = Math.max(0.01, cfg.volRatioTarget - 1);
  const candidates = [
    signals.holderVelPerMin != null ? signals.holderVelPerMin / Math.max(0.1, cfg.holderVelTarget) : 0,
    signals.volRatio1m != null ? (signals.volRatio1m - 1) / volSpan : 0,
    signals.volGrowth5m != null ? (signals.volGrowth5m - 1) / volSpan : 0,
  ];
  return Math.max(0, ...candidates);
}

/**
 * Share of supply in coordinated hands: launch-bundle wallets + wallets that
 * hold without ever having bought (insiders) + dev/team. These three sets are
 * (mostly) disjoint, so the sum is a fair estimate; snipers overlap bundlers
 * and are gated separately. Null when GMGN reports none of the three.
 */
export function controlledSupply(facts: TokenFacts): number | null {
  const parts = [facts.bundlerRate, facts.insiderRate, facts.devHoldRate].filter((x): x is number => x != null);
  if (!parts.length) return null;
  return Math.min(1, parts.reduce((a, b) => a + b, 0));
}

/**
 * A fresh launch is a token still on its launchpad bonding curve, or one
 * younger than cfg.freshMaxAgeMin. Its "liquidity" is a curve reserve or a
 * minutes-old pool GMGN may not have indexed yet, so it is gated on market
 * cap instead of the DEX liquidity floor.
 */
export function isFreshLaunch(facts: TokenFacts, ageMin: number | null, cfg: ScreenerConfig): boolean {
  return facts.onCurve === true || (ageMin != null && ageMin < cfg.freshMaxAgeMin);
}

function hardGates(facts: TokenFacts, latest: Snapshot | undefined, cfg: ScreenerConfig, ageMin: number | null): string[] {
  const blockers: string[] = [];

  // Rug / manipulation
  if ((facts.rugRatio ?? 0) > cfg.maxRugRatio) blockers.push(`rug_ratio ${pct(facts.rugRatio)} > ${pct(cfg.maxRugRatio)}`);
  if (facts.washTrading === true) blockers.push("wash trading detected");
  if (facts.honeypot === true) blockers.push("honeypot");

  // Supply control: bundled launch, insider distribution, concentration.
  // Unknown (null) never blocks; only a reported value can.
  const gate = (value: number | null, max: number, what: string) => {
    if (value != null && value > max) blockers.push(`${what} ${pct(value)} > ${pct(max)}`);
  };
  gate(facts.bundlerRate, cfg.maxBundlerRate, "bundled supply");
  gate(facts.insiderRate, cfg.maxInsiderRate, "insiders hold");
  gate(facts.top10Rate, cfg.maxTop10Rate, "top-10 holders own");
  gate(facts.devHoldRate, cfg.maxDevHoldRate, "dev/team holds");
  gate(facts.sniperHoldRate, cfg.maxSniperHoldRate, "snipers hold");
  gate(controlledSupply(facts), cfg.maxControlledSupply, "controlled supply (bundlers + insiders + dev) ≈");
  if (cfg.requireRenounced) {
    if (facts.mintRenounced === false) blockers.push("mint authority not renounced (supply can be inflated)");
    if (facts.freezeRenounced === false) blockers.push("freeze authority not renounced (holders can be frozen)");
    if (facts.ownerRenounced === false) blockers.push("contract ownership not renounced (owner can change the rules)");
  }

  // EVM chains: taxes, LP lock once a DEX pool exists, creator factories.
  const taxHit = Math.max(facts.buyTax ?? 0, facts.sellTax ?? 0);
  if (taxHit > cfg.maxTax) blockers.push(`buy/sell tax ${pct(facts.buyTax)}/${pct(facts.sellTax)} > ${pct(cfg.maxTax)}`);
  if (facts.lpLockRate != null && facts.onCurve !== true && facts.lpLockRate < cfg.minLpLock) {
    blockers.push(`LP locked ${pct(facts.lpLockRate)} < ${pct(cfg.minLpLock)} (pool can be pulled)`);
  }
  if (facts.creatorTokens != null && facts.creatorTokens > cfg.maxCreatorTokens) {
    const opened = facts.creatorOpenRatio != null ? ` (${pct(facts.creatorOpenRatio)} ever opened)` : "";
    blockers.push(`creator launched ${facts.creatorTokens} tokens${opened} > ${cfg.maxCreatorTokens}`);
  }

  // Size: DEX liquidity floor, or a market-cap floor for fresh launches
  // (a curve has no pool to pull, and a just-created pool often reads $0).
  if (isFreshLaunch(facts, ageMin, cfg)) {
    const mc = latest?.marketCap;
    if (mc != null && mc < cfg.minFreshMcapUsd) blockers.push(`market cap ${fmtUsd(mc)} < ${fmtUsd(cfg.minFreshMcapUsd)} (fresh launch floor)`);
  } else {
    const liq = latest?.liquidity;
    if (liq != null && liq < cfg.minLiquidityUsd) blockers.push(`liquidity ${fmtUsd(liq)} < ${fmtUsd(cfg.minLiquidityUsd)}`);
  }
  const holders = latest?.holders;
  if (holders != null && holders < cfg.minHolders) blockers.push(`only ${holders} holders`);
  return blockers;
}

/** Linear penalty ramp: 0 pts at `from`, `maxPts` at `to` and beyond. */
function ramp(x: number | null, from: number, to: number, maxPts: number): number {
  if (x == null || x <= from) return 0;
  if (to <= from) return maxPts;
  return maxPts * clamp01((x - from) / (to - from));
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function pct(x: number | null | undefined): string {
  return x == null ? "?" : `${(x * 100).toFixed(0)}%`;
}
function fmtUsd(x: number): string {
  if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(1)}M`;
  if (x >= 1_000) return `${(x / 1_000).toFixed(1)}k`;
  return x.toFixed(0);
}

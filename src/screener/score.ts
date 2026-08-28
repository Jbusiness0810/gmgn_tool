import type { ScreenerConfig } from "../config.js";
import type { ScoreBreakdown, Signals, Snapshot, TokenFacts } from "./model.js";

/**
 * Composite 0–100 score. Weighting follows the brief — holder delta and volume
 * delta carry 80 of the 100 points; confirmation (buy pressure, price, smart
 * money) tops up 20; risk signals subtract; hard gates block outright.
 *
 *   holder momentum   0–40   velocity vs target, % growth, acceleration bonus
 *   volume momentum   0–40   1m & 5m volume vs the token's own 1h baseline
 *   confirmation      0–20   buy ratio, 5m price move, smart money / KOLs
 *   penalties         ≤ 0    bundlers, insiders, concentration, dev overhang…
 */
export function scoreToken(
  facts: TokenFacts,
  signals: Signals,
  latest: Snapshot | undefined,
  cfg: ScreenerConfig
): ScoreBreakdown {
  const reasons: string[] = [];
  const blockers = hardGates(facts, latest, cfg);

  // ---- Holder momentum (0–40) ----
  let holder = 0;
  if (signals.holderVelPerMin != null) {
    const velPart = clamp01(signals.holderVelPerMin / cfg.holderVelTarget);
    const pctPart = signals.holderPct5m != null ? clamp01(signals.holderPct5m / 0.10) : 0; // +10%/5m = full
    holder = 40 * (0.6 * velPart + 0.4 * pctPart);
    if (signals.holderAccel != null && signals.holderAccel > 0 && holder > 0) {
      holder = Math.min(40, holder * 1.15); // accelerating, not just growing
      reasons.push(`holder growth accelerating (+${signals.holderAccel.toFixed(1)}/min vs prior 5m)`);
    }
    if (signals.holderVelPerMin >= cfg.holderVelTarget / 2) {
      reasons.push(`+${Math.round(signals.holderDelta5m ?? 0)} holders in ${signals.minutesCovered?.toFixed(0)}m (${signals.holderVelPerMin.toFixed(1)}/min)`);
    }
  }

  // ---- Volume momentum (0–40) ----
  let volume = 0;
  const r1 = signals.volRatio1m;
  const r5 = signals.volRatio5m;
  if (r1 != null || r5 != null) {
    const r1Part = r1 != null ? clamp01((r1 - 1) / (cfg.volRatioTarget - 1)) : 0; // 1x = baseline, target x = full
    const r5Part = r5 != null ? clamp01((r5 - 1) / (cfg.volRatioTarget * 0.8 - 1)) : 0;
    volume = 40 * (0.65 * r1Part + 0.35 * r5Part);
    // Thin absolute volume can't earn full points no matter the ratio.
    const vol1m = latest?.vol1m ?? 0;
    if (vol1m < 1_000) volume *= clamp01(vol1m / 1_000);
    if (r1 != null && r1 >= 2) reasons.push(`1m volume ${r1.toFixed(1)}× its 1h average`);
    if (signals.volDelta5m != null && signals.volDelta5m > 0 && (latest?.vol5m ?? 0) > 5_000) {
      reasons.push(`5m volume up $${fmtUsd(signals.volDelta5m)} vs 5m ago`);
    }
  }

  // ---- Confirmation (0–20) ----
  let confirmation = 0;
  if (signals.buyRatio5m != null && signals.buyRatio5m > 0.5) {
    confirmation += Math.min(8, ((signals.buyRatio5m - 0.5) / 0.25) * 8);
    if (signals.buyRatio5m >= 0.6) reasons.push(`${Math.round(signals.buyRatio5m * 100)}% of 5m swaps are buys`);
  }
  const p5 = facts.priceChange5m;
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
  let penalty = 0;
  const pen = (cond: boolean, pts: number, why: string) => {
    if (cond) {
      penalty -= pts;
      reasons.push(`⚠ ${why}`);
    }
  };
  pen((facts.bundlerRate ?? 0) > 0.3, 10, `bundler rate ${pct(facts.bundlerRate)}`);
  pen((facts.insiderRate ?? 0) > 0.2, 8, `insider trading ${pct(facts.insiderRate)}`);
  const top10 = facts.top10Rate;
  if (top10 != null && top10 > 0.2 && top10 <= cfg.maxTop10Rate) {
    penalty -= ((top10 - 0.2) / (cfg.maxTop10Rate - 0.2)) * 8;
    if (top10 > 0.35) reasons.push(`⚠ top-10 hold ${pct(top10)}`);
  }
  pen(facts.creatorStatus === "creator_hold" && (facts.devHoldRate ?? 0) > 0.05, 4, `dev still holds ${pct(facts.devHoldRate)}`);
  pen((facts.sniperHoldRate ?? 0) > 0.3, 6, `snipers hold ${pct(facts.sniperHoldRate)}`);

  const ageMin = facts.createdAt != null ? (Date.now() / 1000 - facts.createdAt) / 60 : null;
  pen(ageMin != null && ageMin < 10, 10, `only ${ageMin?.toFixed(0)}m old — signals unreliable`);

  const total = Math.max(0, Math.min(100, holder + volume + confirmation + penalty));
  return {
    holder: round1(holder),
    volume: round1(volume),
    confirmation: round1(confirmation),
    penalty: round1(penalty),
    total: round1(blockers.length ? 0 : total),
    reasons,
    blockers,
  };
}

function hardGates(facts: TokenFacts, latest: Snapshot | undefined, cfg: ScreenerConfig): string[] {
  const blockers: string[] = [];
  if ((facts.rugRatio ?? 0) > cfg.maxRugRatio) blockers.push(`rug_ratio ${pct(facts.rugRatio)} > ${pct(cfg.maxRugRatio)}`);
  if (facts.washTrading === true) blockers.push("wash trading detected");
  if (facts.honeypot === true) blockers.push("honeypot");
  if ((facts.top10Rate ?? 0) > cfg.maxTop10Rate) blockers.push(`top-10 holders own ${pct(facts.top10Rate)}`);
  const liq = latest?.liquidity;
  if (liq != null && liq < cfg.minLiquidityUsd) blockers.push(`liquidity $${fmtUsd(liq)} < $${fmtUsd(cfg.minLiquidityUsd)}`);
  const holders = latest?.holders;
  if (holders != null && holders < cfg.minHolders) blockers.push(`only ${holders} holders`);
  return blockers;
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

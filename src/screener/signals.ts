import type { Signals, Snapshot } from "./model.js";

const MIN = 60_000;

/**
 * Delta math over a token's snapshot history. All windows are "closest snapshot
 * to now-X", so the numbers stay honest when a token was only just discovered:
 * anything without ≥3.5 minutes of history reports null holder deltas rather
 * than extrapolating from a 30-second blip.
 */
export function computeSignals(history: Snapshot[], now: number, ageMin: number | null = null): Signals {
  const latest = history[history.length - 1];
  const empty: Signals = {
    minutesCovered: null,
    holderDelta5m: null,
    holderVelPerMin: null,
    holderPct5m: null,
    holderAccel: null,
    volRatio1m: null,
    volRatio5m: null,
    volDelta5m: null,
    volGrowth5m: null,
    pricePct5m: null,
    buyRatio5m: null,
  };
  if (!latest) return empty;

  const out = { ...empty };

  // --- Holder deltas (needs history) ---
  const ref5 = closest(history, now - 5 * MIN);
  if (ref5 && latest.holders != null && ref5.holders != null && latest.ts > ref5.ts) {
    const minutes = (latest.ts - ref5.ts) / MIN;
    if (minutes >= 3.5) {
      out.minutesCovered = minutes;
      out.holderDelta5m = latest.holders - ref5.holders;
      out.holderVelPerMin = out.holderDelta5m / minutes;
      out.holderPct5m = ref5.holders > 0 ? out.holderDelta5m / ref5.holders : null;

      const ref10 = closest(history, ref5.ts - 5 * MIN);
      if (ref10 && ref10.holders != null && ref5.ts - ref10.ts >= 3.5 * MIN) {
        const priorVel = (ref5.holders - ref10.holders) / ((ref5.ts - ref10.ts) / MIN);
        out.holderAccel = out.holderVelPerMin - priorVel;
      }
    }
  }

  // --- Volume acceleration (cross-interval, works from the first snapshot) ---
  // vol1m vs the token's own 1h average answers "is money arriving *right now*
  // faster than it has been?" — the volume-delta signal the screener centres on.
  // A token younger than an hour has vol1h covering only its lifetime, so the
  // per-minute baseline divides by its age rather than 60; otherwise a
  // 5-minute-old token with steady volume would read as 12× its "hourly" pace.
  const baselineMin = ageMin != null && ageMin < 60 ? Math.max(ageMin, 1) : 60;
  if (latest.vol1m != null && latest.vol1h != null && latest.vol1h >= 300) {
    out.volRatio1m = latest.vol1m / (latest.vol1h / baselineMin);
  }
  if (latest.vol5m != null && latest.vol1h != null && latest.vol1h >= 300 && baselineMin > 5) {
    out.volRatio5m = latest.vol5m / ((latest.vol1h / baselineMin) * 5);
  }

  // --- Volume delta vs ~5 minutes ago (needs history) ---
  // The 1h baseline hides a ramp inside an already-busy hour; comparing the
  // trailing 5m window with the one before it catches "just started moving".
  // The $500 floor keeps a dead token going $0 → $600 from reading as ∞×.
  if (ref5 && latest.vol5m != null && ref5.vol5m != null && latest.ts - ref5.ts >= 3.5 * MIN) {
    out.volDelta5m = latest.vol5m - ref5.vol5m;
    out.volGrowth5m = latest.vol5m / Math.max(ref5.vol5m, 500);
  }

  // Price move over the same ~5m window, from our own snapshots (the rank feed
  // also reports one; launchpad rows don't, so this fills the gap for them).
  if (ref5 && latest.price != null && ref5.price != null && ref5.price > 0 && latest.ts - ref5.ts >= 3.5 * MIN) {
    out.pricePct5m = (latest.price / ref5.price - 1) * 100;
  }

  if (latest.buys5m != null && latest.sells5m != null && latest.buys5m + latest.sells5m > 0) {
    out.buyRatio5m = latest.buys5m / (latest.buys5m + latest.sells5m);
  } else if (ageMin != null && ageMin < 60 && latest.buys24h != null && latest.sells24h != null && latest.buys24h + latest.sells24h > 0) {
    // Launchpad rows only carry 24h counts; under an hour old, that is the
    // token's whole life, which is recent enough to stand in for "trailing".
    out.buyRatio5m = latest.buys24h / (latest.buys24h + latest.sells24h);
  }

  return out;
}

function closest(history: Snapshot[], targetTs: number): Snapshot | null {
  let best: Snapshot | null = null;
  let bestDist = Infinity;
  for (const snap of history) {
    const dist = Math.abs(snap.ts - targetTs);
    if (dist < bestDist) {
      best = snap;
      bestDist = dist;
    }
  }
  return best;
}

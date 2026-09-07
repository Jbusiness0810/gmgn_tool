/** One per-cycle observation of a token. Only what delta math needs. */
export interface Snapshot {
  ts: number;            // ms
  holders: number | null;
  vol1m: number | null;  // USD volume, trailing 1 minute (rank interval=1m)
  vol5m: number | null;
  vol1h: number | null;
  swaps5m: number | null;
  buys5m: number | null;
  sells5m: number | null;
  price: number | null;
  marketCap: number | null;
  liquidity: number | null;
}

/** Latest static/risk facts about a token (overwritten each cycle). */
export interface TokenFacts {
  address: string;
  symbol: string;
  name: string;
  chain: string;
  logo: string | null;
  source: "trending" | "trenches";
  launchpad: string | null;
  createdAt: number | null; // unix seconds
  priceChange1m: number | null;
  priceChange5m: number | null;
  priceChange1h: number | null;
  smartMoney: number | null;
  kols: number | null;
  hotLevel: number | null;
  botRate: number | null;   // share of activity from bot wallets; inflates holder counts

  rugRatio: number | null;
  washTrading: boolean | null;
  honeypot: boolean | null;

  // Supply control: every one of these is a fraction of total supply.
  top10Rate: number | null;      // top-10 wallets
  bundlerRate: number | null;    // wallets that bought in the launch bundle
  insiderRate: number | null;    // wallets holding without ever buying after open
  devHoldRate: number | null;    // dev / team wallets
  sniperHoldRate: number | null; // first-blocks buyers still holding
  creatorStatus: string | null;  // creator_hold / creator_close
  mintRenounced: boolean | null;   // false => more supply can be minted
  freezeRenounced: boolean | null; // false => holder accounts can be frozen

  twitter: string | null;
  website: string | null;
}

export interface Signals {
  minutesCovered: number | null;   // history span actually used for the 5m window
  holderDelta5m: number | null;    // holders gained over the ~5m window
  holderVelPerMin: number | null;  // holders/minute over that window
  holderPct5m: number | null;      // fractional growth over that window
  holderAccel: number | null;      // recent velocity minus prior velocity (holders/min)
  volRatio1m: number | null;       // vol1m ÷ (vol1h/60): >1 = running hot vs its own hour
  volRatio5m: number | null;       // vol5m ÷ (vol1h/12)
  volDelta5m: number | null;       // change in trailing-5m USD volume vs ~5m ago
  volGrowth5m: number | null;      // vol5m ÷ vol5m ~5m ago: >1 = volume ramping right now
  buyRatio5m: number | null;       // buys ÷ (buys+sells) over trailing 5m
}

export type TokenStatus = "flagged" | "watch" | "tracking" | "blocked";

export interface ScoreBreakdown {
  holder: number;       // 0..40  holder-delta component
  volume: number;       // 0..40  volume-delta component
  momentum: number;     // 0..80  OR-blend of the two: 1.6·max(h, v) + 0.4·min(h, v)
  confirmation: number; // -4..20
  penalty: number;      // <= 0
  /** Strongest delta as a multiple of its target (1 = at target), unclamped. Ranking tiebreak. */
  intensity: number;
  total: number;        // 0..100
  reasons: string[];    // human-readable contributors
  blockers: string[];   // hard-gate failures (non-empty => blocked)
}

export interface TrackedToken {
  facts: TokenFacts;
  history: Snapshot[];
  signals: Signals;
  score: ScoreBreakdown;
  status: TokenStatus;
  /** consecutive cycles at/above the flag score (for debounce) */
  hotStreak: number;
  firstSeenAt: number;  // ms
  lastSeenAt: number;   // ms
  flaggedAt: number | null;
}

export interface Alert {
  ts: number;
  address: string;
  symbol: string;
  chain: string;
  score: number;
  holderVelPerMin: number | null;
  volRatio1m: number | null;
  reasons: string[];
}

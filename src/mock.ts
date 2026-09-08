import type { GmgnDataSource, RawRankToken, RawTrenchToken, TrenchesData } from "./gmgn/types.js";

/**
 * Synthetic GMGN feed for keyless demos (`npm run mock`).
 *
 * Every metric is a deterministic function of wall-clock time, so replaying past
 * timestamps (backfill) and live polling produce one consistent trajectory:
 *  - "surgers" start a holder/volume ramp a few minutes before launch, so the
 *    screener visibly catches them climbing from tracking → watch → flagged;
 *    two of them move on ONE signal only (holders-only / volume-only) to show
 *    the OR-style ranking;
 *  - "risky" tokens carry rug/wash/bundle/insider/mint-authority signals and
 *    stay blocked however fast they move;
 *  - the rest jitter around a baseline.
 */

interface Profile {
  address: string;
  symbol: string;
  name: string;
  createdAgoMin: number;      // age at process start
  baseHolders: number;
  baseVolPerMin: number;      // USD
  liquidity: number;
  marketCap: number;
  price: number;
  surge?: { startAgoMin: number; holdersPerMin: number; volMultiple: number };
  fade?: boolean;
  risk?: Partial<RawRankToken>;
  smartMoney?: number;
  kols?: number;
  buyBias?: number;           // 0.5 = neutral
}

const START = Date.now();

const PROFILES: Profile[] = [
  // --- surgers: the ones the screener should flag ---
  {
    address: "MockRocketPumpSurge1111111111111111111111111",
    symbol: "RCKT",
    name: "Rocket Season",
    createdAgoMin: 95,
    baseHolders: 420,
    baseVolPerMin: 900,
    liquidity: 86_000,
    marketCap: 640_000,
    price: 0.00064,
    surge: { startAgoMin: 9, holdersPerMin: 14, volMultiple: 6 },
    smartMoney: 4,
    kols: 1,
    buyBias: 0.68,
  },
  {
    address: "MockFrogWifHatSurge2222222222222222222222222",
    symbol: "FWH",
    name: "frog wif hat",
    createdAgoMin: 55,
    baseHolders: 260,
    baseVolPerMin: 500,
    liquidity: 42_000,
    marketCap: 310_000,
    price: 0.00031,
    surge: { startAgoMin: 6, holdersPerMin: 9, volMultiple: 4.5 },
    smartMoney: 3,
    buyBias: 0.64,
  },
  {
    address: "MockGigaChadSurge333333333333333333333333333",
    symbol: "GIGA",
    name: "gigachad v2",
    createdAgoMin: 220,
    baseHolders: 1350,
    baseVolPerMin: 2_100,
    liquidity: 190_000,
    marketCap: 2_400_000,
    price: 0.0024,
    surge: { startAgoMin: 3, holdersPerMin: 22, volMultiple: 3.2 },
    smartMoney: 6,
    kols: 2,
    buyBias: 0.61,
  },
  // --- single-signal surgers: one strong delta should be enough to rank ---
  {
    address: "MockHoldersOnlySurge9999999999999999999999999",
    symbol: "HODLR",
    name: "holders only, flat volume",
    createdAgoMin: 70,
    baseHolders: 380,
    baseVolPerMin: 700,
    liquidity: 58_000,
    marketCap: 410_000,
    price: 0.00041,
    surge: { startAgoMin: 7, holdersPerMin: 16, volMultiple: 1 },
    smartMoney: 1,
    buyBias: 0.55,
  },
  {
    address: "MockVolumeOnlySurge8888888888888888888888888",
    symbol: "VOLUP",
    name: "volume only, flat holders",
    createdAgoMin: 160,
    baseHolders: 900,
    baseVolPerMin: 1_100,
    liquidity: 97_000,
    marketCap: 780_000,
    price: 0.00078,
    surge: { startAgoMin: 5, holdersPerMin: 0, volMultiple: 6 },
    smartMoney: 2,
    buyBias: 0.58,
  },
  // --- fresh launch still on the curve: liquidity is a curve reserve, so the
  //     DEX liquidity floor must not apply; the market-cap floor does ---
  {
    address: "MockCurveFreshLaunch4040404040404040404040404",
    symbol: "CURVY",
    name: "fresh launch on the curve",
    createdAgoMin: 14,
    baseHolders: 60,
    baseVolPerMin: 400,
    liquidity: 7_200,
    marketCap: 26_000,
    price: 0.000026,
    surge: { startAgoMin: 6, holdersPerMin: 7, volMultiple: 3 },
    smartMoney: 1,
    buyBias: 0.62,
    risk: { exchange: "pump", launchpad_status: 0 },
  },
  // --- EVM-chain examples (0x addresses): ownership, tax and LP-lock gates ---
  {
    address: "0x1111111111111111111111111111111111111111",
    symbol: "HOODY",
    name: "clean robinhood launch",
    createdAgoMin: 45,
    baseHolders: 300,
    baseVolPerMin: 800,
    liquidity: 60_000,
    marketCap: 500_000,
    price: 0.0005,
    surge: { startAgoMin: 6, holdersPerMin: 10, volMultiple: 4 },
    smartMoney: 3,
    buyBias: 0.63,
    risk: { is_renounced: 1, is_open_source: 1, lock_percent: 0.95, buy_tax: "0", sell_tax: "0", exchange: "0x8366a39cc670b4001a1121b8f6a443a643e40951", launchpad_platform: "pons_v2", launchpad_status: 1 },
  },
  {
    address: "0x2222222222222222222222222222222222222222",
    symbol: "UNLOCK",
    name: "LP not locked",
    createdAgoMin: 120,
    baseHolders: 400,
    baseVolPerMin: 900,
    liquidity: 80_000,
    marketCap: 700_000,
    price: 0.0007,
    surge: { startAgoMin: 7, holdersPerMin: 9, volMultiple: 4 },
    buyBias: 0.62,
    risk: { is_renounced: 1, is_open_source: 1, lock_percent: 0.2, buy_tax: "0", sell_tax: "0", exchange: "0x8366a39cc670b4001a1121b8f6a443a643e40951", launchpad_platform: "pool_uniswap_v4", launchpad_status: 1 },
  },
  {
    address: "0x3333333333333333333333333333333333333333",
    symbol: "OWNED",
    name: "owner live, 15% sell tax",
    createdAgoMin: 90,
    baseHolders: 350,
    baseVolPerMin: 700,
    liquidity: 50_000,
    marketCap: 400_000,
    price: 0.0004,
    surge: { startAgoMin: 6, holdersPerMin: 8, volMultiple: 3.5 },
    buyBias: 0.6,
    risk: { is_renounced: 0, is_open_source: 0, lock_percent: 0.95, buy_tax: "0", sell_tax: "15", exchange: "0x8366a39cc670b4001a1121b8f6a443a643e40951", launchpad_platform: "pons_v2", launchpad_status: 1 },
  },
  // --- risky: momentum but hard-gated ---
  {
    address: "MockBundledLaunch1010101010101010101010101010",
    symbol: "BUNDL",
    name: "bundled launch",
    createdAgoMin: 35,
    baseHolders: 290,
    baseVolPerMin: 1_300,
    liquidity: 61_000,
    marketCap: 520_000,
    price: 0.00052,
    surge: { startAgoMin: 7, holdersPerMin: 13, volMultiple: 5 },
    risk: { bundler_rate: 0.38, top_10_holder_rate: 0.27 },
    smartMoney: 2,
    buyBias: 0.7,
  },
  {
    address: "MockInsiderSupply2020202020202020202020202020",
    symbol: "INSDR",
    name: "insider distribution",
    createdAgoMin: 50,
    baseHolders: 340,
    baseVolPerMin: 1_000,
    liquidity: 49_000,
    marketCap: 460_000,
    price: 0.00046,
    surge: { startAgoMin: 6, holdersPerMin: 10, volMultiple: 4 },
    risk: { rat_trader_amount_rate: 0.27, dev_team_hold_rate: 0.08 },
    buyBias: 0.63,
  },
  {
    address: "MockMintAuthority303030303030303030303030303",
    symbol: "MINTY",
    name: "mint authority still live",
    createdAgoMin: 80,
    baseHolders: 510,
    baseVolPerMin: 800,
    liquidity: 70_000,
    marketCap: 590_000,
    price: 0.00059,
    surge: { startAgoMin: 8, holdersPerMin: 9, volMultiple: 3.5 },
    risk: { renounced_mint: 0 },
    buyBias: 0.6,
  },
  {
    address: "MockRugCandidate44444444444444444444444444444",
    symbol: "SAFEMOON2",
    name: "definitely safe moon",
    createdAgoMin: 40,
    baseHolders: 310,
    baseVolPerMin: 1_500,
    liquidity: 55_000,
    marketCap: 420_000,
    price: 0.00042,
    surge: { startAgoMin: 8, holdersPerMin: 11, volMultiple: 5 },
    risk: { rug_ratio: 0.62, top_10_holder_rate: 0.44 },
    buyBias: 0.66,
  },
  {
    address: "MockWashTrader555555555555555555555555555555",
    symbol: "VOLUME",
    name: "organic volume token",
    createdAgoMin: 130,
    baseHolders: 800,
    baseVolPerMin: 4_000,
    liquidity: 120_000,
    marketCap: 900_000,
    price: 0.0009,
    risk: { is_wash_trading: true, bundler_rate: 0.41 },
    buyBias: 0.52,
  },
  {
    address: "MockThinLiquidity6666666666666666666666666666",
    symbol: "THIN",
    name: "thin ice",
    createdAgoMin: 180,
    baseHolders: 140,
    baseVolPerMin: 350,
    liquidity: 6_500,
    marketCap: 95_000,
    price: 0.000095,
    surge: { startAgoMin: 5, holdersPerMin: 6, volMultiple: 3 },
    buyBias: 0.6,
  },
  // --- faders ---
  {
    address: "MockYesterdayHero7777777777777777777777777777",
    symbol: "HERO",
    name: "yesterdays hero",
    createdAgoMin: 900,
    baseHolders: 5_200,
    baseVolPerMin: 800,
    liquidity: 260_000,
    marketCap: 1_800_000,
    price: 0.0018,
    fade: true,
    smartMoney: 1,
    buyBias: 0.42,
  },
  {
    address: "MockSlowBleed88888888888888888888888888888888",
    symbol: "BLEED",
    name: "slow bleed",
    createdAgoMin: 400,
    baseHolders: 2_100,
    baseVolPerMin: 300,
    liquidity: 74_000,
    marketCap: 380_000,
    price: 0.00038,
    fade: true,
    buyBias: 0.45,
  },
];

// A tail of unremarkable tokens to fill the tables.
for (let i = 0; i < 18; i++) {
  PROFILES.push({
    address: `MockFiller${String(i).padStart(2, "0")}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    symbol: ["DOGE2", "PEPE3", "MOON", "CHAD", "WAGMI", "NGMI", "SER", "FUD", "COPE", "HODL", "APE", "BONK2", "MEOW", "WOOF", "SNEK", "BULL", "BEAR", "CRAB"][i]!,
    name: `mock token ${i}`,
    createdAgoMin: 60 + i * 37,
    baseHolders: 150 + i * 61,
    baseVolPerMin: 120 + (i % 7) * 90,
    liquidity: 15_000 + i * 6_000,
    marketCap: 120_000 + i * 45_000,
    price: 0.0001 * (i + 1),
    smartMoney: i % 5 === 0 ? 1 : 0,
    buyBias: 0.47 + (i % 5) * 0.02,
  });
}

export class MockSource implements GmgnDataSource {
  private nowOverride: number | null = null;

  /** Backfill support: pins "now" while the engine replays past cycles. */
  setNow(ts: number | null): void {
    this.nowOverride = ts;
  }

  private now(): number {
    return this.nowOverride ?? Date.now();
  }

  async trendingRank(chain: string, interval: string): Promise<RawRankToken[]> {
    const now = this.now();
    return PROFILES.map((p, i) => this.rankRow(p, i, chain, interval, now));
  }

  async trenches(chain: string): Promise<TrenchesData> {
    const now = this.now();
    const early: RawTrenchToken[] = [
      {
        address: "MockTrenchNewborn99999999999999999999999999999",
        symbol: "BABY",
        name: "newborn launchpad token",
        usd_market_cap: 48_000,
        liquidity: 21_000,
        volume_1h: 60_000 + noise(now, 991) * 8_000,
        holder_count: Math.round(60 + minutesSince(now, 12) * 4),
        created_timestamp: Math.floor((START - 12 * 60_000) / 1000),
        launchpad_platform: "Pump.fun",
        exchange: "pump",
        launchpad_status: 0,
        complete_timestamp: 0,
        progress: 0.82,
        rug_ratio: 0.08,
        smart_degen_count: 2,
        price: 0.00004 * (1 + minutesSince(now, 12) * 0.02), // +2%/min since launch
        buys_24h: 40 + Math.round(minutesSince(now, 12) * 3),
        sells_24h: 18 + Math.round(minutesSince(now, 12)),
      },
    ];
    return { near_completion: early, completed: [] };
  }

  private rankRow(p: Profile, seed: number, chain: string, interval: string, now: number): RawRankToken {
    const holders = this.holders(p, now);
    const volPerMin = this.volPerMin(p, now);
    const vol1hAvgPerMin = this.avgVolPerMin(p, now, 60);

    const volume =
      interval === "1m" ? volPerMin :
      interval === "5m" ? this.avgVolPerMin(p, now, 5) * 5 :
      vol1hAvgPerMin * 60;

    const surging = this.surgeFactor(p, now) > 0.3;
    const buyBias = (p.buyBias ?? 0.5) + (surging ? 0.05 : 0);
    const swaps5m = Math.max(4, Math.round((this.avgVolPerMin(p, now, 5) * 5) / 150));
    const buys = Math.round(swaps5m * buyBias);

    const priceChange5m = p.fade
      ? -3 - noise(now + seed, 17) * 4
      : surging
        ? 6 + this.surgeFactor(p, now) * 18 + noise(now + seed, 31) * 3
        : noise(now + seed, 13) * 4 - 2;

    return {
      address: p.address,
      symbol: p.symbol,
      name: p.name,
      chain,
      price: p.price * (1 + priceChange5m / 100),
      market_cap: p.marketCap * (1 + this.surgeFactor(p, now) * 0.6),
      liquidity: p.liquidity,
      volume: Math.round(volume),
      swaps: interval === "5m" ? swaps5m : Math.round(swaps5m * (interval === "1m" ? 0.25 : 10)),
      buys: interval === "5m" ? buys : undefined,
      sells: interval === "5m" ? swaps5m - buys : undefined,
      holder_count: holders,
      price_change_percent1m: priceChange5m / 4,
      price_change_percent5m: priceChange5m,
      price_change_percent1h: priceChange5m * 2.5,
      creation_timestamp: Math.floor((START - p.createdAgoMin * 60_000) / 1000),
      launchpad_platform: seed % 2 ? "Pump.fun" : "letsbonk",
      exchange: "pump_amm",
      launchpad_status: 1,
      hot_level: surging ? 3 : 1,
      rug_ratio: 0.05,
      is_wash_trading: false,
      top_10_holder_rate: 0.14 + (seed % 4) * 0.03,
      bundler_rate: 0.05,
      rat_trader_amount_rate: 0.04,
      dev_team_hold_rate: 0.02,
      renounced_mint: 1,
      renounced_freeze_account: 1,
      creator_token_status: seed % 3 ? "creator_close" : "creator_hold",
      smart_degen_count: p.smartMoney ?? 0,
      renowned_count: p.kols ?? 0,
      bot_degen_rate: 0.2 + (seed % 4) * 0.05,
      twitter_username: `${p.symbol.toLowerCase()}_coin`,
      website: null,
      ...p.risk,
    };
  }

  /** Holders as a function of time: base + surge ramp (or fade), plus jitter. */
  private holders(p: Profile, now: number): number {
    let h = p.baseHolders + minutesSince(now, 0) * 0.15; // slow organic drift for all
    if (p.surge) {
      const surgeStart = START - p.surge.startAgoMin * 60_000;
      const minsIn = Math.max(0, (now - surgeStart) / 60_000);
      h += p.surge.holdersPerMin * minsIn * sigmoid(minsIn / 2);
    }
    if (p.fade) h -= minutesSince(now, 0) * 0.4;
    return Math.round(h + noise(now, hash(p.address)) * 3);
  }

  private volPerMin(p: Profile, now: number): number {
    let v = p.baseVolPerMin * (0.85 + noise(now, hash(p.address) + 7) * 0.3);
    if (p.surge) v *= 1 + (p.surge.volMultiple - 1) * this.surgeFactor(p, now);
    if (p.fade) v *= 0.5;
    return v;
  }

  /** Trailing average of volPerMin — numeric integral, 1-minute steps. */
  private avgVolPerMin(p: Profile, now: number, minutes: number): number {
    let sum = 0;
    for (let i = 0; i < minutes; i++) sum += this.volPerMin(p, now - i * 60_000);
    return sum / minutes;
  }

  private surgeFactor(p: Profile, now: number): number {
    if (!p.surge) return 0;
    const surgeStart = START - p.surge.startAgoMin * 60_000;
    const minsIn = (now - surgeStart) / 60_000;
    return minsIn <= 0 ? 0 : sigmoid((minsIn - 2) / 1.5);
  }
}

/** Minutes elapsed since `agoMin` minutes before process start. */
function minutesSince(now: number, agoMin: number): number {
  return Math.max(0, (now - (START - agoMin * 60_000)) / 60_000);
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Deterministic 0..1 "noise" from time bucket + seed (30s buckets). */
function noise(ts: number, seed: number): number {
  const bucket = Math.floor(ts / 30_000);
  const x = Math.sin(bucket * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h % 1000);
}

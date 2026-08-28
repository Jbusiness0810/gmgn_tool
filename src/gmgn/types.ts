// Shapes returned by the GMGN OpenAPI (https://openapi.gmgn.ai).
// Numeric fields arrive as number OR string depending on route, so raw types are
// loose and every consumer goes through the coercers in client.ts.

/** One entry of GET /v1/market/rank → data.rank[] */
export interface RawRankToken {
  address?: string;
  symbol?: string;
  name?: string;
  chain?: string;
  logo?: string;

  price?: number | string;
  market_cap?: number | string;
  liquidity?: number | string;
  volume?: number | string; // USD volume for the *queried interval*
  swaps?: number | string;
  buys?: number | string;
  sells?: number | string;
  holder_count?: number | string;

  price_change_percent?: number | string;
  price_change_percent1m?: number | string;
  price_change_percent5m?: number | string;
  price_change_percent1h?: number | string;

  open_timestamp?: number | string;
  creation_timestamp?: number | string;
  launchpad_platform?: string;
  exchange?: string;
  hot_level?: number | string;
  rank?: number | string;

  // Security / risk
  rug_ratio?: number | string | null;
  is_wash_trading?: boolean | null;
  is_honeypot?: number | string | null;
  top_10_holder_rate?: number | string | null;
  bundler_rate?: number | string | null;
  rat_trader_amount_rate?: number | string | null;
  entrapment_ratio?: number | string | null;
  dev_team_hold_rate?: number | string | null;
  top70_sniper_hold_rate?: number | string | null;
  creator_token_status?: string | null;
  renounced_mint?: number | string | null;
  renounced_freeze_account?: number | string | null;

  // Smart money / social
  smart_degen_count?: number | string;
  renowned_count?: number | string;
  twitter_username?: string | null;
  website?: string | null;
  telegram?: string | null;

  [key: string]: unknown;
}

/** One entry of POST /v1/trenches → data.{new_creation|pump|completed}[] */
export interface RawTrenchToken {
  address?: string;
  symbol?: string;
  name?: string;
  logo?: string;
  usd_market_cap?: number | string;
  liquidity?: number | string;
  volume_1h?: number | string;
  volume_24h?: number | string;
  swaps_1h?: number | string;
  swaps_24h?: number | string;
  holder_count?: number | string;
  created_timestamp?: number | string;
  open_timestamp?: number | string;
  launchpad_platform?: string;
  progress?: number | string;
  rug_ratio?: number | string | null;
  top_holder_rate?: number | string | null;
  bundler_rate?: number | string | null;
  insider_ratio?: number | string | null;
  smart_degen_count?: number | string;
  renowned_count?: number | string;
  creator_token_status?: string | null;
  price_change_percent1m?: number | string;
  price_change_percent5m?: number | string;
  price_change_percent1h?: number | string;
  buys?: number | string;
  sells?: number | string;
  [key: string]: unknown;
}

export interface TrenchesData {
  new_creation?: RawTrenchToken[];
  /** near_completion comes back under the key `pump` */
  pump?: RawTrenchToken[];
  completed?: RawTrenchToken[];
  [key: string]: unknown;
}

export interface GmgnDataSource {
  /** GET /v1/market/rank for one interval; returns data.rank */
  trendingRank(chain: string, interval: string, extra?: Record<string, string | number | string[]>): Promise<RawRankToken[]>;
  /** POST /v1/trenches; returns the category map */
  trenches(chain: string, types: string[], limit: number, filters?: Record<string, number | string>): Promise<TrenchesData>;
}

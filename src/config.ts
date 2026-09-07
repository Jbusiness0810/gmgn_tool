import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Minimal .env loader (KEY=VALUE lines, # comments, optional surrounding quotes).
// Real environment variables always win over .env values.
function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!;
    if (val.startsWith("#")) val = "";
    val = val.replace(/\s+#.*$/, "").trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotenv(join(process.cwd(), ".env"));

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

export interface ScreenerConfig {
  apiKey: string;
  host: string;
  chain: string;
  mock: boolean;
  pollIntervalSec: number;
  port: number;

  // Scoring
  flagScore: number;
  watchScore: number;
  holderVelTarget: number; // holders/min for full holder points
  volRatioTarget: number;  // 1m-vs-1h-average volume multiple for full points

  // Hard gates: size / rug
  minLiquidityUsd: number;
  minHolders: number;
  maxRugRatio: number;

  // Hard gates: supply control (fractions of total supply; a token over ANY
  // of these is blocked, unknown values never block)
  maxTop10Rate: number;         // top-10 wallets
  maxBundlerRate: number;       // launch-bundle wallets
  maxInsiderRate: number;       // wallets holding without ever buying after open
  maxDevHoldRate: number;       // dev / team wallets
  maxSniperHoldRate: number;    // first-blocks buyers still holding
  maxControlledSupply: number;  // bundlers + insiders + dev combined
  requireRenounced: boolean;    // block when mint or freeze authority is still live

  alertWebhookUrl: string;
  dataDir: string;
}

export function loadConfig(): ScreenerConfig {
  const mock = process.env.MOCK === "1" || process.argv.includes("--mock");
  const apiKey = str("GMGN_API_KEY", "");
  if (!apiKey && !mock) {
    console.error(
      "[gmgn-screener] GMGN_API_KEY is not set.\n" +
        "  1. Go to https://gmgn.ai → API → GMGN API Management → Create API Key\n" +
        "  2. cp .env.example .env and paste the key into GMGN_API_KEY\n" +
        "  (or run `npm run mock` to try the dashboard with synthetic data)"
    );
    process.exit(1);
  }
  return {
    apiKey,
    host: str("GMGN_HOST", "https://openapi.gmgn.ai"),
    chain: str("CHAIN", "sol"),
    mock,
    pollIntervalSec: Math.max(10, num("POLL_INTERVAL_SEC", 30)),
    port: num("PORT", 4477),

    flagScore: num("FLAG_SCORE", 70),
    watchScore: num("WATCH_SCORE", 50),
    holderVelTarget: num("HOLDER_VEL_TARGET", 10),
    volRatioTarget: num("VOL_RATIO_TARGET", 3),

    minLiquidityUsd: num("MIN_LIQUIDITY_USD", 10_000),
    minHolders: num("MIN_HOLDERS", 25),
    maxRugRatio: num("MAX_RUG_RATIO", 0.3),

    // GMGN's own security check calls top-10 < 30% "relatively safe".
    maxTop10Rate: num("MAX_TOP10_RATE", 0.3),
    maxBundlerRate: num("MAX_BUNDLER_RATE", 0.25),
    maxInsiderRate: num("MAX_INSIDER_RATE", 0.2),
    maxDevHoldRate: num("MAX_DEV_HOLD_RATE", 0.1),
    maxSniperHoldRate: num("MAX_SNIPER_HOLD_RATE", 0.4),
    maxControlledSupply: num("MAX_CONTROLLED_SUPPLY", 0.4),
    requireRenounced: bool("REQUIRE_RENOUNCED", true),

    alertWebhookUrl: str("ALERT_WEBHOOK_URL", ""),
    dataDir: str("DATA_DIR", join(process.cwd(), "data")),
  };
}

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScreenerConfig } from "../config.js";
import { toNum } from "../gmgn/client.js";
import type { GmgnDataSource, RawRankToken, RawTrenchToken } from "../gmgn/types.js";
import type { Alert, Snapshot, TokenFacts, TrackedToken } from "./model.js";
import { controlledSupply, isFreshLaunch, scoreToken } from "./score.js";
import { computeSignals } from "./signals.js";

const HISTORY_WINDOW_MS = 3 * 60 * 60 * 1000; // keep 3h of snapshots
const EVICT_AFTER_MS = 30 * 60 * 1000;        // drop tokens unseen for 30m
const REALERT_COOLDOWN_MS = 30 * 60 * 1000;
const FLAG_STREAK = 2;                        // cycles at/above flag score before flagging

interface CycleFetch {
  rank1m: RawRankToken[];
  rank5m: RawRankToken[];
  rank1h: RawRankToken[];
  trench: RawTrenchToken[];
}

export class ScreenerEngine {
  private tokens = new Map<string, TrackedToken>();
  private alerts: Alert[] = [];
  private lastAlertAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private cycleCount = 0;
  private inFlight = false;
  lastCycleAt: number | null = null;
  lastError: string | null = null;

  constructor(
    private readonly source: GmgnDataSource,
    private readonly cfg: ScreenerConfig
  ) {
    this.restore();
  }

  start(): void {
    void this.cycle();
    this.timer = setInterval(() => void this.cycle(), this.cfg.pollIntervalSec * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.persist();
  }

  /**
   * One poll cycle: fetch → merge snapshots → score → alert. Never throws.
   * `nowOverride` exists for mock-mode backfill, which replays past cycles to
   * pre-populate history (holder deltas need ≥3.5 min of snapshots).
   */
  async cycle(nowOverride?: number): Promise<void> {
    if (this.inFlight) return; // a rate-limit pause can outlast the poll interval; never stack cycles
    this.inFlight = true;
    const now = nowOverride ?? Date.now();
    try {
      const fetched = await this.fetchAll();
      this.merge(fetched, now);
      this.rescore(now);
      this.lastCycleAt = now;
      this.lastError = null;
      this.cycleCount++;
      if (this.cycleCount % 5 === 0) this.persist();
      const flagged = [...this.tokens.values()].filter((t) => t.status === "flagged").length;
      console.log(
        `[screener] cycle ${this.cycleCount}: tracking ${this.tokens.size} tokens, ${flagged} flagged`
      );
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error(`[screener] cycle failed: ${this.lastError}`);
    } finally {
      this.inFlight = false;
    }
  }

  private async fetchAll(): Promise<CycleFetch> {
    const { chain } = this.cfg;
    // 4 requests per cycle, serialized and spaced 2s apart inside the client
    // (free tier tolerates ~1 req/s), so a cycle takes ~8s of API time.
    const rank1m = await this.source.trendingRank(chain, "1m", { limit: 100 });
    const rank5m = await this.source.trendingRank(chain, "5m", { limit: 100 });
    const rank1h = await this.source.trendingRank(chain, "1h", { limit: 100 });
    const trenchData = await this.source.trenches(chain, ["near_completion", "completed"], 50, {
      min_holder_count: Math.max(1, Math.floor(this.cfg.minHolders / 2)),
    });
    const trench = [
      ...(trenchData.near_completion ?? trenchData.pump ?? []),
      ...(trenchData.completed ?? []),
    ];
    return { rank1m, rank5m, rank1h, trench };
  }

  private merge(fetched: CycleFetch, now: number): void {
    // Index per-interval rank rows by address; 5m is the primary row (buys/sells
    // over a window long enough to mean something), 1m/1h fill the volume ratios.
    const by1m = indexBy(fetched.rank1m);
    const by5m = indexBy(fetched.rank5m);
    const by1h = indexBy(fetched.rank1h);

    const addresses = new Set([...by1m.keys(), ...by5m.keys(), ...by1h.keys()]);
    for (const address of addresses) {
      const r5 = by5m.get(address);
      const r1 = by1m.get(address);
      const rh = by1h.get(address);
      const primary = r5 ?? r1 ?? rh!;

      const snapshot: Snapshot = {
        ts: now,
        holders: toNum(primary.holder_count),
        vol1m: toNum(r1?.volume),
        vol5m: toNum(r5?.volume),
        vol1h: toNum(rh?.volume),
        swaps5m: toNum(r5?.swaps),
        buys5m: toNum(r5?.buys),
        sells5m: toNum(r5?.sells),
        price: toNum(primary.price),
        marketCap: toNum(primary.market_cap),
        liquidity: toNum(primary.liquidity),
      };
      this.upsert(address, rankFacts(primary, this.cfg.chain), snapshot, now);
    }

    for (const raw of fetched.trench) {
      const address = raw.address;
      if (!address) continue;
      // Trenches tokens that are also in rank already got a snapshot this cycle.
      const existing = this.tokens.get(address);
      if (existing && existing.lastSeenAt === now) continue;
      const snapshot: Snapshot = {
        ts: now,
        holders: toNum(raw.holder_count),
        vol1m: null,
        vol5m: null,
        vol1h: toNum(raw.volume_1h),
        swaps5m: null,
        buys5m: toNum(raw.buys),
        sells5m: toNum(raw.sells),
        price: toNum(raw.price),
        marketCap: toNum(raw.usd_market_cap) ?? toNum(raw.market_cap),
        liquidity: toNum(raw.liquidity),
      };
      this.upsert(address, trenchFacts(raw, this.cfg.chain), snapshot, now);
    }

    // Evict tokens that fell out of every feed long ago.
    for (const [address, token] of this.tokens) {
      if (now - token.lastSeenAt > EVICT_AFTER_MS) this.tokens.delete(address);
    }
  }

  private upsert(address: string, facts: TokenFacts, snapshot: Snapshot, now: number): void {
    let token = this.tokens.get(address);
    if (!token) {
      token = {
        facts,
        history: [],
        signals: computeSignals([], now),
        score: { holder: 0, volume: 0, momentum: 0, confirmation: 0, penalty: 0, intensity: 0, total: 0, reasons: [], blockers: [] },
        status: "tracking",
        hotStreak: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        flaggedAt: null,
      };
      this.tokens.set(address, token);
    }
    // Preserve fields the current feed doesn't carry (trenches rows lack some).
    token.facts = { ...token.facts, ...definedOnly(facts) };
    token.lastSeenAt = now;
    token.history.push(snapshot);
    const cutoff = now - HISTORY_WINDOW_MS;
    while (token.history.length && token.history[0]!.ts < cutoff) token.history.shift();
  }

  private rescore(now: number): void {
    for (const token of this.tokens.values()) {
      token.signals = computeSignals(token.history, now, ageMinutes(token.facts.createdAt, now));
      const latest = token.history[token.history.length - 1];
      token.score = scoreToken(token.facts, token.signals, latest, this.cfg, now);

      if (token.score.blockers.length) {
        token.status = "blocked";
        token.hotStreak = 0;
        continue;
      }
      if (token.score.total >= this.cfg.flagScore) {
        token.hotStreak++;
        if (token.hotStreak >= FLAG_STREAK) {
          const isNewFlag = token.status !== "flagged";
          token.status = "flagged";
          if (isNewFlag) {
            token.flaggedAt = now;
            this.emitAlert(token, now);
          }
        } else {
          token.status = "watch"; // hot but not yet debounced
        }
      } else {
        token.hotStreak = 0;
        token.status = token.score.total >= this.cfg.watchScore ? "watch" : "tracking";
      }
    }
  }

  private emitAlert(token: TrackedToken, now: number): void {
    const last = this.lastAlertAt.get(token.facts.address) ?? 0;
    if (now - last < REALERT_COOLDOWN_MS) return;
    this.lastAlertAt.set(token.facts.address, now);

    const alert: Alert = {
      ts: now,
      address: token.facts.address,
      symbol: token.facts.symbol,
      chain: token.facts.chain,
      score: token.score.total,
      holderVelPerMin: token.signals.holderVelPerMin,
      volRatio1m: token.signals.volRatio1m,
      reasons: token.score.reasons,
    };
    this.alerts.unshift(alert);
    this.alerts = this.alerts.slice(0, 200);
    console.log(
      `[ALERT] ${alert.symbol} (${alert.chain}) score ${alert.score} — ${alert.reasons.join("; ") || "momentum threshold crossed"}\n` +
        `        https://gmgn.ai/${alert.chain}/token/${alert.address}`
    );
    try {
      mkdirSync(this.cfg.dataDir, { recursive: true });
      appendFileSync(join(this.cfg.dataDir, "alerts.jsonl"), JSON.stringify(alert) + "\n");
    } catch {
      /* alert log is best-effort */
    }
    if (this.cfg.alertWebhookUrl) {
      const text =
        `🚨 ${alert.symbol} flagged (score ${alert.score}) on ${alert.chain} — ` +
        `${alert.reasons.slice(0, 3).join("; ")} — https://gmgn.ai/${alert.chain}/token/${alert.address}`;
      fetch(this.cfg.alertWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `content` covers Discord-style webhooks; `text` covers Slack-style.
        body: JSON.stringify({ ...alert, content: text, text }),
      }).catch((err) => console.warn(`[screener] alert webhook failed: ${err}`));
    }
  }

  // ---- persistence ----

  private get statePath(): string {
    return join(this.cfg.dataDir, "state.json");
  }

  persist(): void {
    try {
      mkdirSync(this.cfg.dataDir, { recursive: true });
      const state = {
        savedAt: Date.now(),
        chain: this.cfg.chain,
        tokens: [...this.tokens.entries()],
        alerts: this.alerts,
      };
      writeFileSync(this.statePath, JSON.stringify(state));
    } catch (err) {
      console.warn(`[screener] persist failed: ${err}`);
    }
  }

  private restore(): void {
    try {
      if (!existsSync(this.statePath)) return;
      const state = JSON.parse(readFileSync(this.statePath, "utf-8")) as {
        savedAt?: number;
        chain?: string;
        tokens?: [string, TrackedToken][];
        alerts?: Alert[];
      };
      if (state.chain !== this.cfg.chain) return; // stale state for another chain
      if (!state.savedAt || Date.now() - state.savedAt > HISTORY_WINDOW_MS) return;
      this.tokens = new Map(state.tokens ?? []);
      this.alerts = state.alerts ?? [];
      console.log(`[screener] restored ${this.tokens.size} tokens from ${this.statePath}`);
    } catch {
      /* corrupt state file — start fresh */
    }
  }

  // ---- read API for the dashboard ----

  getState() {
    const now = Date.now();
    const tokens = [...this.tokens.values()]
      .map((t) => ({
        ...t.facts,
        status: t.status,
        score: t.score,
        signals: t.signals,
        controlledSupply: controlledSupply(t.facts),
        fresh: isFreshLaunch(t.facts, ageMinutes(t.facts.createdAt, now), this.cfg),
        firstSeenAt: t.firstSeenAt,
        flaggedAt: t.flaggedAt,
        latest: t.history[t.history.length - 1] ?? null,
        holderSpark: spark(t.history, (s) => s.holders),
        volSpark: spark(t.history, (s) => s.vol1m ?? s.vol1h),
      }))
      // Rank: status, then score, then the raw delta blend / the single biggest
      // mover, so among equal scores the fastest holder or volume delta leads.
      // (`?? 0` guards scores restored from a state file written by an older build.)
      .sort(
        (a, b) =>
          statusRank(a.status) - statusRank(b.status) ||
          b.score.total - a.score.total ||
          (b.score.momentum ?? 0) - (a.score.momentum ?? 0) ||
          (b.score.intensity ?? 0) - (a.score.intensity ?? 0)
      );
    return {
      updatedAt: this.lastCycleAt,
      chain: this.cfg.chain,
      mock: this.cfg.mock,
      pollIntervalSec: this.cfg.pollIntervalSec,
      thresholds: {
        flagScore: this.cfg.flagScore,
        watchScore: this.cfg.watchScore,
        holderVelTarget: this.cfg.holderVelTarget,
        volRatioTarget: this.cfg.volRatioTarget,
        minLiquidityUsd: this.cfg.minLiquidityUsd,
        maxTop10Rate: this.cfg.maxTop10Rate,
        maxBundlerRate: this.cfg.maxBundlerRate,
        maxInsiderRate: this.cfg.maxInsiderRate,
        maxDevHoldRate: this.cfg.maxDevHoldRate,
        maxSniperHoldRate: this.cfg.maxSniperHoldRate,
        maxControlledSupply: this.cfg.maxControlledSupply,
        requireRenounced: this.cfg.requireRenounced,
        minFreshMcapUsd: this.cfg.minFreshMcapUsd,
        freshMaxAgeMin: this.cfg.freshMaxAgeMin,
      },
      lastError: this.lastError,
      counts: {
        tracking: tokens.length,
        flagged: tokens.filter((t) => t.status === "flagged").length,
        watch: tokens.filter((t) => t.status === "watch").length,
        blocked: tokens.filter((t) => t.status === "blocked").length,
        fresh: tokens.filter((t) => t.fresh && t.status !== "blocked").length,
      },
      tokens,
      alerts: this.alerts.slice(0, 50),
    };
  }
}

function statusRank(s: string): number {
  return s === "flagged" ? 0 : s === "watch" ? 1 : s === "tracking" ? 2 : 3;
}

/** Last ~40 points of a metric for tiny dashboard sparklines. */
function spark(history: Snapshot[], pick: (s: Snapshot) => number | null): (number | null)[] {
  return history.slice(-40).map(pick);
}

function indexBy(rows: RawRankToken[]): Map<string, RawRankToken> {
  const map = new Map<string, RawRankToken>();
  for (const row of rows) if (row.address) map.set(row.address, row);
  return map;
}

/** Strip undefined/null so a sparse feed doesn't wipe known facts. */
function definedOnly<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) (out as Record<string, unknown>)[k] = v;
  }
  // address/symbol/etc. always survive via spread of prior facts
  return out;
}

function rankFacts(raw: RawRankToken, chain: string): TokenFacts {
  return {
    address: raw.address ?? "",
    symbol: raw.symbol ?? "?",
    name: raw.name ?? raw.symbol ?? "?",
    chain,
    logo: raw.logo ?? null,
    source: "trending",
    launchpad: raw.launchpad_platform ?? null,
    onCurve: onCurve(raw),
    createdAt: toNum(raw.creation_timestamp) ?? toNum(raw.open_timestamp),
    priceChange1m: toNum(raw.price_change_percent1m),
    priceChange5m: toNum(raw.price_change_percent5m),
    priceChange1h: toNum(raw.price_change_percent1h),
    smartMoney: toNum(raw.smart_degen_count),
    kols: toNum(raw.renowned_count),
    hotLevel: toNum(raw.hot_level),
    botRate: toNum(raw.bot_degen_rate),
    rugRatio: toNum(raw.rug_ratio),
    washTrading: typeof raw.is_wash_trading === "boolean" ? raw.is_wash_trading : null,
    honeypot: raw.is_honeypot == null ? null : toNum(raw.is_honeypot) === 1,
    top10Rate: toNum(raw.top_10_holder_rate),
    bundlerRate: toNum(raw.bundler_rate),
    insiderRate: toNum(raw.rat_trader_amount_rate),
    devHoldRate: toNum(raw.dev_team_hold_rate),
    sniperHoldRate: toNum(raw.top70_sniper_hold_rate),
    creatorStatus: raw.creator_token_status ?? null,
    mintRenounced: renounced(raw.renounced_mint),
    freezeRenounced: renounced(raw.renounced_freeze_account),
    twitter: raw.twitter_username ?? null,
    website: raw.website ?? null,
  };
}

function ageMinutes(createdAtSec: number | null, nowMs: number): number | null {
  return createdAtSec != null ? (nowMs / 1000 - createdAtSec) / 60 : null;
}

/**
 * Still on the launchpad bonding curve? The exchange name decides ("pump",
 * "ray_launchpad", "meteora_virtual_curve" are curves; pump_amm / ray_v4 /
 * ray_clmm / meteora_* are DEX pools). launchpad_status (0 = on curve,
 * 1 = migrated) and complete_timestamp only ever rule a curve *out*, since a
 * few DEX-native tokens also report status 0.
 */
function onCurve(raw: { exchange?: unknown; launchpad_status?: unknown; complete_timestamp?: unknown }): boolean | null {
  if ((toNum(raw.complete_timestamp) ?? 0) > 0) return false;
  const status = toNum(raw.launchpad_status);
  if (status != null && status !== 0) return false;
  const ex = typeof raw.exchange === "string" ? raw.exchange.toLowerCase() : "";
  if (!ex) return status === 0 ? true : null;
  return ex === "pump" || /launchpad|virtual_curve|bonding/.test(ex);
}

/** GMGN reports renounce status as 1/0 (sometimes boolean); anything else is unknown. */
function renounced(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  const n = toNum(v);
  return n === 1 ? true : n === 0 ? false : null;
}

function trenchFacts(raw: RawTrenchToken, chain: string): TokenFacts {
  return {
    address: raw.address ?? "",
    symbol: raw.symbol ?? "?",
    name: raw.name ?? raw.symbol ?? "?",
    chain,
    logo: raw.logo ?? null,
    source: "trenches",
    launchpad: raw.launchpad_platform ?? null,
    onCurve: onCurve(raw),
    createdAt: toNum(raw.created_timestamp) ?? toNum(raw.open_timestamp),
    priceChange1m: toNum(raw.price_change_percent1m),
    priceChange5m: toNum(raw.price_change_percent5m),
    priceChange1h: toNum(raw.price_change_percent1h),
    smartMoney: toNum(raw.smart_degen_count),
    kols: toNum(raw.renowned_count),
    hotLevel: null,
    botRate: toNum(raw.bot_degen_rate),
    rugRatio: toNum(raw.rug_ratio),
    washTrading: typeof raw.is_wash_trading === "boolean" ? raw.is_wash_trading : null,
    honeypot: null,
    top10Rate: toNum(raw.top_holder_rate) ?? toNum(raw.top_10_holder_rate),
    bundlerRate: toNum(raw.bundler_rate) ?? toNum(raw.bundler_trader_amount_rate),
    insiderRate: toNum(raw.insider_ratio) ?? toNum(raw.rat_trader_amount_rate),
    devHoldRate: toNum(raw.dev_team_hold_rate),
    sniperHoldRate: toNum(raw.top70_sniper_hold_rate),
    creatorStatus: raw.creator_token_status ?? null,
    mintRenounced: renounced(raw.renounced_mint),
    freezeRenounced: renounced(raw.renounced_freeze_account),
    twitter: null,
    website: null,
  };
}

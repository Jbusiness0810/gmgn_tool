import { randomUUID } from "node:crypto";
import type { GmgnDataSource, RawRankToken, TrenchesData } from "./types.js";

/**
 * GMGN OpenAPI client — read-only ("exist auth") routes.
 *
 * Auth: X-APIKEY header + `timestamp` (unix seconds, server allows ±5s skew) and
 * `client_id` (fresh UUID per request) query params. Responses are wrapped in a
 * `{ code, data, message, error }` envelope; code 0 = success.
 *
 * Rate limits: leaky bucket, rate=20 capacity=20; route weights: rank=1,
 * trenches=3. The client spaces requests and honours 429 `x-ratelimit-reset`.
 */

interface Envelope {
  code: number | string;
  data?: unknown;
  message?: string;
  error?: string;
}

export class GmgnApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly apiError?: string,
    readonly resetAtUnix?: number
  ) {
    super(message);
    this.name = "GmgnApiError";
  }
}

const MIN_REQUEST_SPACING_MS = 250; // ≈4 req/s, far under the 20/s bucket
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

export class GmgnClient implements GmgnDataSource {
  private lastRequestAt = 0;
  /** When set, all requests pause until this wall-clock ms timestamp (429 cooldown). */
  private pausedUntil = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly apiKey: string,
    private readonly host: string
  ) {}

  async trendingRank(
    chain: string,
    interval: string,
    extra: Record<string, string | number | string[]> = {}
  ): Promise<RawRankToken[]> {
    const data = await this.request("GET", "/v1/market/rank", { chain, interval, ...extra });
    const rank = (data as { rank?: unknown })?.rank;
    return Array.isArray(rank) ? (rank as RawRankToken[]) : [];
  }

  async trenches(
    chain: string,
    types: string[],
    limit: number,
    filters: Record<string, number | string> = {}
  ): Promise<TrenchesData> {
    const section = { filters: ["offchain", "onchain"], launchpad_platform_v2: true, limit, ...filters };
    const body: Record<string, unknown> = { version: "v2" };
    for (const type of types) body[type] = { ...section };
    const data = await this.request("POST", "/v1/trenches", { chain }, body);
    return (data ?? {}) as TrenchesData;
  }

  private request(
    method: string,
    subPath: string,
    query: Record<string, string | number | string[]>,
    body: unknown = null
  ): Promise<unknown> {
    // Serialize requests so spacing + cooldowns apply across concurrent callers.
    const result = this.queue.then(() => this.doRequest(method, subPath, query, body));
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async doRequest(
    method: string,
    subPath: string,
    query: Record<string, string | number | string[]>,
    body: unknown
  ): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      await this.throttle();

      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (Array.isArray(v)) for (const item of v) params.append(k, item);
        else params.set(k, String(v));
      }
      params.set("timestamp", String(Math.floor(Date.now() / 1000)));
      params.set("client_id", randomUUID());
      const url = `${this.host}${subPath}?${params.toString()}`;

      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            "X-APIKEY": this.apiKey,
            "Content-Type": "application/json",
            "User-Agent": "gmgn-screener/0.1",
          },
          body: body !== null ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        throw new GmgnApiError(`${method} ${subPath} network error: ${rootCause(err)}`, 0);
      }
      this.lastRequestAt = Date.now();

      const text = await res.text();
      let json: Envelope;
      try {
        json = JSON.parse(text) as Envelope;
      } catch {
        throw new GmgnApiError(
          `${method} ${subPath} HTTP ${res.status}: non-JSON response (${text.slice(0, 200)})`,
          res.status
        );
      }

      if (json.code === 0) return json.data;

      const resetHeader = Number.parseInt(res.headers.get("x-ratelimit-reset") ?? "", 10);
      const resetAt = Number.isFinite(resetHeader) && resetHeader > 0 ? resetHeader : undefined;
      const rateLimited = json.error === "RATE_LIMIT_EXCEEDED" || json.error === "RATE_LIMIT_BANNED";

      if (rateLimited && resetAt && attempt === 1) {
        // Back off until the bucket resets (+1s buffer), then retry once. Hammering
        // during a ban extends it by 5s per request, so never retry more than once.
        const waitMs = Math.max(resetAt * 1000 - Date.now(), 0) + 1000;
        if (waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
          this.pausedUntil = Date.now() + waitMs;
          console.warn(`[gmgn] rate limited on ${subPath}; retrying in ${Math.ceil(waitMs / 1000)}s`);
          continue;
        }
      }

      if (rateLimited) this.pausedUntil = Math.max(this.pausedUntil, (resetAt ?? 0) * 1000);

      throw new GmgnApiError(
        `${method} ${subPath} failed: HTTP ${res.status} code=${json.code}` +
          (json.error ? ` error=${json.error}` : "") +
          (json.message ? ` message=${json.message}` : ""),
        res.status,
        json.error,
        resetAt
      );
    }
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const waits: number[] = [];
    if (this.pausedUntil > now) waits.push(this.pausedUntil - now);
    const sinceLast = now - this.lastRequestAt;
    if (sinceLast < MIN_REQUEST_SPACING_MS) waits.push(MIN_REQUEST_SPACING_MS - sinceLast);
    const wait = Math.max(0, ...waits);
    if (wait > 0) await sleep(wait);
  }
}

// ---- coercion helpers used across the screener ----

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function toNumOr(v: unknown, fallback: number): number {
  return toNum(v) ?? fallback;
}

function rootCause(err: unknown): string {
  let cur = err;
  while (cur instanceof Error && cur.cause) cur = cur.cause;
  return cur instanceof Error ? cur.message : String(cur);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

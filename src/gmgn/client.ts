import { randomUUID } from "node:crypto";
import type { GmgnDataSource, RawRankToken, TrenchesData } from "./types.js";

/**
 * GMGN OpenAPI client — read-only ("exist auth") routes.
 *
 * Auth: X-APIKEY header + `timestamp` (unix seconds, server allows ±5s skew) and
 * `client_id` (fresh UUID per request) query params. Responses are wrapped in a
 * `{ code, data, message, error }` envelope; code 0 = success. Some routes
 * (market/rank) wrap the payload twice — `{code, data: {code, data: {rank}}}` —
 * so `unwrap()` peels envelopes until it reaches the payload.
 *
 * Rate limits (measured on the free tier, Sep 2026): ~1 request/second
 * sustained with a burst of about 3. Faster than that answers 429
 * RATE_LIMIT_EXCEEDED, and repeated violations answer RATE_LIMIT_BANNED with a
 * ~60s `reset_at` (unix seconds) in the body. There are no x-ratelimit-*
 * headers. The client spaces requests 2s apart, pauses until `reset_at` on a
 * 429, and retries at most once per request.
 */

interface Envelope {
  code: number | string;
  data?: unknown;
  message?: string;
  error?: string;
  reset_at?: number | string;
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

const MIN_REQUEST_SPACING_MS = 2_000;           // free tier: ~1 req/s sustained, tiny burst
const RATE_LIMIT_EXCEEDED_PAUSE_MS = 10_000;    // fallback when a 429 carries no reset_at
const RATE_LIMIT_BANNED_PAUSE_MS = 65_000;
const MAX_RATE_LIMIT_WAIT_MS = 90_000;          // wait through one ban, never longer

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

      if (toNum(json.code) === 0) return unwrap(json, method, subPath);

      const rateLimited = json.error === "RATE_LIMIT_EXCEEDED" || json.error === "RATE_LIMIT_BANNED";
      const resetAt = toNum(json.reset_at) ?? toNum(res.headers.get("x-ratelimit-reset"));

      if (rateLimited) {
        // Pause everything until the server says the bucket resets (+1s buffer).
        // Hammering during a ban extends it, so never retry more than once.
        const fallback = json.error === "RATE_LIMIT_BANNED" ? RATE_LIMIT_BANNED_PAUSE_MS : RATE_LIMIT_EXCEEDED_PAUSE_MS;
        const waitMs = Math.max(resetAt != null ? resetAt * 1000 - Date.now() : 0, fallback) + 1000;
        this.pausedUntil = Math.max(this.pausedUntil, Date.now() + waitMs);
        if (attempt === 1 && waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
          console.warn(`[gmgn] ${json.error} on ${subPath}; retrying in ${Math.ceil(waitMs / 1000)}s`);
          continue;
        }
      }

      throw new GmgnApiError(
        `${method} ${subPath} failed: HTTP ${res.status} code=${json.code}` +
          (json.error ? ` error=${json.error}` : "") +
          (json.message ? ` message=${json.message}` : ""),
        res.status,
        json.error,
        resetAt ?? undefined
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

/** Peel nested `{code, data}` envelopes; a non-zero inner code is an API error. */
function unwrap(json: Envelope, method: string, subPath: string): unknown {
  let data = json.data;
  while (isEnvelope(data)) {
    if (toNum(data.code) !== 0) {
      throw new GmgnApiError(
        `${method} ${subPath} failed: inner code=${data.code}` + (data.message ? ` message=${data.message}` : ""),
        200,
        String(data.code)
      );
    }
    data = data.data;
  }
  return data;
}

function isEnvelope(v: unknown): v is Envelope {
  return typeof v === "object" && v !== null && "code" in v && "data" in v;
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

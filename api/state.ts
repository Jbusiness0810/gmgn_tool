import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";
import { loadConfig, type ScreenerConfig } from "../src/config.js";
import { GmgnClient } from "../src/gmgn/client.js";
import { MockSource } from "../src/mock.js";
import { ScreenerEngine } from "../src/screener/engine.js";

// Vercel entry point. Serverless has no always-on process, so the dashboard's
// own 10s polling drives the screener: each request starts a cycle when the
// last one is older than POLL_INTERVAL_SEC. Module scope survives while the
// function instance stays warm, so history (and the deltas) build up as long
// as someone has the dashboard open; a cold start begins with empty history.

let cfg: ScreenerConfig | null = null;
let engine: ScreenerEngine | null = null;
let ready: Promise<void> | null = null;

function init(): ScreenerEngine {
  if (engine) return engine;
  cfg = loadConfig();
  if (cfg.mock) {
    const mock = new MockSource();
    engine = new ScreenerEngine(mock, cfg);
    // Replay the last 15 minutes so holder/volume deltas are live immediately.
    const e = engine;
    const step = cfg.pollIntervalSec * 1000;
    ready = (async () => {
      const now = Date.now();
      for (let t = now - 15 * 60_000; t < now; t += step) {
        mock.setNow(t);
        await e.cycle(t);
      }
      mock.setNow(null);
    })();
  } else {
    engine = new ScreenerEngine(new GmgnClient(cfg.apiKey, cfg.host), cfg);
  }
  return engine;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  let e: ScreenerEngine;
  try {
    e = init();
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (ready) await ready;

  const due = !e.lastCycleAt || Date.now() - e.lastCycleAt >= cfg!.pollIntervalSec * 1000;
  if (due) {
    // A live cycle takes ~8s per chain (rate-limit spacing), so run it after
    // responding; cycle() never throws and skips if one is already running.
    const run = e.cycle();
    if (e.lastCycleAt) waitUntil(run);
    else await run; // first request on a cold instance: wait so the page isn't empty
  }
  send(res, 200, e.getState());
}

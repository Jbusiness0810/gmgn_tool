import { loadConfig } from "./config.js";
import { GmgnClient } from "./gmgn/client.js";
import type { GmgnDataSource } from "./gmgn/types.js";
import { MockSource } from "./mock.js";
import { ScreenerEngine } from "./screener/engine.js";
import { startServer } from "./server.js";

const cfg = loadConfig();

let source: GmgnDataSource;
let mock: MockSource | null = null;
if (cfg.mock) {
  mock = new MockSource();
  source = mock;
  console.log("[gmgn-screener] MOCK mode — synthetic data, no API key needed");
} else {
  source = new GmgnClient(cfg.apiKey, cfg.host);
}

const engine = new ScreenerEngine(source, cfg);
const server = startServer(engine, cfg.port);

async function main(): Promise<void> {
  if (mock) {
    // Replay the last 15 minutes so holder/volume deltas are live immediately.
    const now = Date.now();
    const step = cfg.pollIntervalSec * 1000;
    for (let t = now - 15 * 60_000; t < now; t += step) {
      mock.setNow(t);
      await engine.cycle(t);
    }
    mock.setNow(null);
    console.log("[gmgn-screener] mock backfill complete");
  }
  engine.start();
}

function shutdown(): void {
  console.log("\n[gmgn-screener] shutting down…");
  engine.stop();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

void main();

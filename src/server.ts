import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScreenerEngine } from "./screener/engine.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

export function startServer(engine: ScreenerEngine, port: number): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/api/state") {
      const body = JSON.stringify(engine.getState());
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(body);
      return;
    }

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        // Re-read per request: dev-friendly, and the file is small.
        const html = readFileSync(join(PUBLIC_DIR, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`dashboard missing: ${err}`);
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  server.listen(port, () => {
    console.log(`[gmgn-screener] dashboard → http://localhost:${port}`);
  });
  return server;
}

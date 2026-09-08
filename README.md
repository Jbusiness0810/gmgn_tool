# GMGN Momentum Screener

Flags up-and-coming tokens on [GMGN.ai](https://gmgn.ai), on Robinhood Chain by
default (Solana, BSC, Base and Ethereum via `CHAIN`), by watching for the two
signals that most often precede a run: **rapid holder growth** and **volume
acceleration**. It polls the GMGN OpenAPI, keeps a rolling history per token,
computes the deltas itself (GMGN only serves point-in-time snapshots), scores
every token 0–100, and raises an alert when one crosses the flag threshold —
with hard risk gates so rugs, honeypots, wash-traded and bundled or
supply-controlled tokens never get flagged no matter how fast they move.

![status](https://img.shields.io/badge/data-GMGN.ai%20OpenAPI-6ce675)

> ⚠️ **Not financial advice.** This is a research/screening tool. Meme-token
> trading is extremely high risk; *flagged ≠ safe*. Always do your own due
> diligence before touching anything it surfaces.

## Quick start

```bash
git clone https://github.com/Jbusiness0810/gmgn_tool.git
cd gmgn_tool
npm install

# Try it immediately with synthetic data (no API key needed):
npm run mock
# → open http://localhost:4477

# Real data:
cp .env.example .env       # then paste your key into GMGN_API_KEY
npm start
```

**Getting an API key:** the *Create API Key* dialog (gmgn.ai → **API** → *GMGN
API Management* → **Create API Key**) asks you to upload an Ed25519/RSA public
key first. Generate one with:

```bash
npm run keygen
```

This creates an Ed25519 key pair at `~/.config/gmgn/keypair.pem` (same location
and format as the official `gmgn-cli config`, and reused if one already exists),
prints the **public** key to paste into the dialog, and prints a
`gmgn.ai/ai/generateapi?pbk=…` link that pre-fills it for you. In the dialog
keep **Enable Reading** on — **Enable Trading is not needed**: this screener
only calls read-only routes, never loads the private key, and never trades.
Paste the resulting API key into `.env` as `GMGN_API_KEY` (up to 3 keys per
account, free tier available).

Note: the GMGN OpenAPI is IPv4-only. If requests fail with 401/403 and the key
is correct, disable IPv6 on your interface.

## What it does

Every `POLL_INTERVAL_SEC` (default 30s) the engine:

1. **Fetches** `GET /v1/market/rank` at three intervals (`1m`, `5m`, `1h`) plus
   `POST /v1/trenches` (near-completion + freshly graduated launchpad tokens):
   4 requests per cycle, spaced 2s apart. The free tier allows roughly one
   request per second with a burst of about three; faster than that answers
   429 and repeated violations ban the key for about a minute. The client
   honours the `reset_at` in a 429 body and never stacks overlapping cycles.
2. **Snapshots** every token: holders, per-interval USD volume, buys/sells,
   price, market cap, liquidity. History is kept for 3h (persisted to
   `data/state.json`, so restarts don't lose the deltas).
3. **Computes deltas** per token:
   - *Holder velocity*: holders gained per minute over the last ~5 minutes,
     plus *acceleration* (recent 5m velocity vs the 5m before it).
   - *Volume ratio*: trailing 1m (and 5m) volume vs the token's **own** 1h
     average: `vol_1m ÷ (vol_1h / 60)`. A token doing 3× its own baseline is
     heating up regardless of its absolute size. For tokens younger than an
     hour the baseline divides by their age instead of 60, so a five-minute-old
     launch isn't credited with 12× its "hourly" pace.
   - *Volume growth*: trailing 5m volume vs the 5m before it. Catches a ramp
     that starts inside an already-busy hour, where the 1h baseline is high
     and the ratio above looks tame.
   - *Buy pressure*: buys ÷ total swaps over the trailing 5m. Launchpad rows
     only report lifetime counts, which for a token under an hour old is the
     same thing, so those are used as the fallback. Price change over the
     window is likewise derived from the screener's own snapshots when the
     feed doesn't report one.
4. **Scores** 0–100. The two deltas are blended **OR-style**: one strong
   recent delta is enough to rank near the top; both together rank highest.

   | Component | Points | Driven by |
   |---|---|---|
   | Holder Δ | 0–40 | velocity vs target (default 10/min = full), % growth, acceleration bonus |
   | Volume Δ | 0–40 | 1m & 5m volume vs own 1h average (default 3× = full) **or** 5m volume vs the previous 5m; absolute-volume floor |
   | Momentum | 0–80 | `1.6 × max(holderΔ, volumeΔ) + 0.4 × min(…)`: one full-strength delta scores 64, both score 80 |
   | Confirmation | −4–20 | buy ratio > 50%, positive 5m price, smart-money & KOL wallets |
   | Penalties | ≤ 0 | holders draining, bot-heavy activity (`bot_degen_rate` above 50%: bot wallets count as holders too), supply concentration approaching a gate (top-10, bundlers, insiders, dev, snipers), extreme youth |

   Ranking order is status, then score, then momentum, then the single
   strongest delta as a multiple of its target, so among equal scores the
   biggest mover leads.

5. **Gates**: hard blocks with score 0, never flagged however fast they move.
   Blocked tokens sit under the dashboard's *Blocked* tab with the reason.
   - *Rug / manipulation:* `rug_ratio` > 0.3, wash trading, honeypot.
   - *Size:* liquidity < $10k, < 25 holders. **Fresh launches** (still on
     the launchpad bonding curve, or younger than 60 min) skip the liquidity
     floor, because a curve reserve or a minutes-old pool isn't comparable to
     DEX liquidity, and must clear a $5k market-cap floor instead.
   - *Bundled or supply-controlled* (any one trips it; an unknown value never
     blocks): top-10 holders > 30% (GMGN's own "relatively safe" line),
     bundled supply > 25%, insider-held supply > 20% (wallets that hold
     without ever having bought after open), dev/team > 10%, snipers > 40%,
     bundlers + insiders + dev combined > 40%, and a mint or freeze authority
     that is still live (supply can be inflated / holders frozen).
   - *EVM chains (Robinhood Chain, Ethereum, BSC, Base):* contract ownership
     not renounced, buy or sell tax > 10%, LP less than 80% locked or burned
     once a DEX pool exists (Pons launches lock 95%; Uniswap-native pools are
     often 0%), and creator wallets that have launched more than 20 tokens
     (the launchpad feed shows factories with hundreds of launches of which
     under 1% ever opened). Unverified source, fresh-wallet holders and
     serial creators below the gate cost points instead.
6. **Flags** a token when it scores ≥ `FLAG_SCORE` (default 70) for **2
   consecutive cycles** (debounce against one-tick spikes); ≥ `WATCH_SCORE`
   (default 50) marks it *watch*. Flag events print to the console, append to
   `data/alerts.jsonl`, feed the dashboard's alert panel, and optionally POST to
   `ALERT_WEBHOOK_URL` (payload includes Discord-style `content` and
   Slack-style `text` fields).

The dashboard (http://localhost:4477) shows flagged/watch tokens with holder and
volume sparklines, Δholders/5m, volume-vs-baseline multiple, buy %, market cap,
liquidity, smart-money count, a supply column (top-10 / bundled / insider share:
amber near a gate, red over it), and a click-to-expand score breakdown with
every reason, blocker and the full supply-control read-out. The *Ranked* tab
lists everything that passed the gates in rank order; *Fresh launches* narrows
that to tokens under an hour old (those still on a launchpad curve are tagged
CURVE, the rest NEW). Rows link straight to the token's gmgn.ai page.

## Hosting it (always-on)

The screener is a long-running process: it polls GMGN every 30 seconds and
keeps minutes of history in memory to compute the deltas. It therefore needs a
host that keeps one process alive. **It cannot run on Vercel, Netlify or other
serverless platforms**: those run your code only for the instant a page is
requested and forget everything in between, so the deltas can never form
(and the function crashes at startup when no `GMGN_API_KEY` is present).

Any host that runs a Docker container or a Node process works. Two easy ones:

**Render (free tier).** Click the button, sign in with GitHub, paste your GMGN
API key when asked, deploy.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Jbusiness0810/gmgn_tool)

The free instance goes to sleep after 15 minutes without visitors, and polling
stops while it sleeps. A free uptime pinger (for example UptimeRobot hitting
`https://<your-app>.onrender.com/healthz` every 5 minutes) keeps it awake.
Paid instances don't sleep.

**Railway (about $5/month, never sleeps).** New Project → Deploy from GitHub
repo → pick this repo (the `Dockerfile` is detected automatically) → Variables
→ add `GMGN_API_KEY` → Settings → Networking → Generate Domain.

Notes for any host: set `GMGN_API_KEY` as an environment variable in the
host's dashboard, never in git; the app listens on the `PORT` the host injects;
`data/` (history and alert log) lives on the instance's disk, so a restart
starts with an empty history and rebuilds it within ten minutes; and the
dashboard has no login, so anyone who has the URL can view it.

## Configuration

All via `.env` (see [.env.example](.env.example)):

| Variable | Default | Meaning |
|---|---|---|
| `GMGN_API_KEY` | — | required (except `npm run mock`) |
| `CHAIN` | `robinhood` | `robinhood` / `sol` / `bsc` / `base` / `eth` / `arc` / `stable` (the API's own list) |
| `POLL_INTERVAL_SEC` | `30` | seconds between cycles (min 10) |
| `PORT` | `4477` | dashboard port |
| `FLAG_SCORE` / `WATCH_SCORE` | `70` / `50` | status thresholds |
| `HOLDER_VEL_TARGET` | `10` | holders/min that earns full holder points |
| `VOL_RATIO_TARGET` | `3` | volume-vs-1h-average multiple for full points |
| `MIN_LIQUIDITY_USD` / `MIN_HOLDERS` | `10000` / `25` | hard gates |
| `MAX_RUG_RATIO` | `0.3` | hard gate |
| `MIN_FRESH_MCAP_USD` | `5000` | market-cap floor for fresh launches (replaces the liquidity floor) |
| `FRESH_MAX_AGE_MIN` | `60` | age under which a token counts as a fresh launch |
| `MAX_TOP10_RATE` | `0.3` | supply gate: top-10 holders' share |
| `MAX_BUNDLER_RATE` | `0.25` | supply gate: launch-bundle wallets' share |
| `MAX_INSIDER_RATE` | `0.2` | supply gate: insider-held share |
| `MAX_DEV_HOLD_RATE` | `0.1` | supply gate: dev/team share |
| `MAX_SNIPER_HOLD_RATE` | `0.4` | supply gate: sniper-held share |
| `MAX_CONTROLLED_SUPPLY` | `0.4` | supply gate: bundlers + insiders + dev combined |
| `REQUIRE_RENOUNCED` | `1` | block while mint/freeze authority (Solana) or contract ownership (EVM) is live |
| `MIN_LP_LOCK` | `0.8` | EVM: LP locked-or-burned share a DEX-listed token must have |
| `MAX_TAX` | `0.1` | EVM: buy or sell tax above this fraction is blocked |
| `MAX_CREATOR_TOKENS` | `20` | launchpad feed: creator wallets that launched more tokens than this are blocked |
| `ALERT_WEBHOOK_URL` | — | optional webhook for flag alerts |

Tune the two targets to taste: lower them on quiet days to surface more, raise
them in a frenzy to only see the outliers. Loosen the supply gates if too much
gets blocked; the *Blocked* tab shows exactly which gate tripped for each token.

## Project layout

```
src/gmgn/client.ts      GMGN OpenAPI client (X-APIKEY auth, envelope parsing,
                        request spacing + 429/reset handling)
src/gmgn/types.ts       raw API response shapes
src/screener/model.ts   snapshot / signals / score / token models
src/screener/signals.ts delta math (holder velocity & acceleration, vol ratios)
src/screener/score.ts   scoring + hard risk gates
src/screener/engine.ts  poll loop, history, statuses, alerts, persistence
src/mock.ts             deterministic synthetic feed for `npm run mock`
src/server.ts           http server: dashboard + /api/state
public/index.html       the dashboard (vanilla JS, zero deps)
```

Zero runtime dependencies — Node ≥ 18.17 (built-in `fetch`), `tsx` to run
TypeScript directly. `npm run typecheck` for the strict `tsc` pass.
`Dockerfile` + `render.yaml` package it for always-on hosts (see above).

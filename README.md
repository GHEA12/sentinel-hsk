# Sentinel — an autonomous trading agent with on-chain risk rails

**HSK Chain Horizon Hackathon · Track 1: AI Agent Trading**

Sentinel is an AI trading agent that trades on HSKSwap (HashKey Chain's DEX) — but it never holds the money. Funds sit in the **SentinelGuard** contract, and the agent's key can do exactly one thing: ask the guard to execute a swap. Every swap is checked on-chain against hard limits the human owner set in advance. A brilliant agent, a buggy agent, or a *stolen* agent key all face the same ceiling: the worst day Sentinel can have is bounded by contract, not by trust.

## Architecture

```
                ┌─────────────────────────────────────────────┐
                │              SentinelGuard (on-chain)        │
  Owner ───────►│  holds funds · per-trade cap · daily volume  │
  (sets caps,   │  cap · daily loss cap · slippage rail ·      │
   kill-switch, │  kill-switch · average-cost PnL accounting   │
   withdraws)   └──────────────▲───────────────────┬──────────┘
                               │ executeSwap        │ swap
  Agent ───────────────────────┘ (only callable     ▼
  (polls prices, momentum+spread  by the agent)   DEX router
   signal, proposes trades)                      (HSKSwap)
```

- **`contracts/SentinelGuard.sol`** — the vault + risk engine. Owner/agent separation: the agent cannot withdraw, change limits, or pause; the owner cannot trade. Only single-pool swaps against a designated **quote token** (e.g. USDT) are allowed, which keeps every trade's notional comparable for the daily caps.
- **`contracts/interfaces/ISwapRouter02Like.sol`** — the minimal HSKSwap V3 surface the guard talks to: SwapRouter02 (`exactInputSingle`) + QuoterV2 (`quoteExactInputSingle`). The Phase 1 V2 interface file is kept alongside, marked deprecated, for reference.
- **`contracts/mocks/MockERC20.sol`** — testnet-only mintable token for the fallback demo path (below).
- **`agent/`** — plain Node.js agent (ethers only dependency):
  - `src/prices.js` — polls the pool price through QuoterV2 (`staticCall` quotes) and keeps a history ring buffer.
  - `src/signal.js` — pure momentum + spread/dislocation signal (fast vs slow moving average, plus an overextension guard so the agent doesn't chase pumps). Unit-testable offline.
  - `src/trader.js` — turns signals into `executeSwap` proposals sized by config, checks guard state first, defaults to DRY_RUN.
  - `src/index.js` — the poll → signal → propose loop.
- **`scripts/live-run.js`** — testnet deploy + live-run script (deploy guard, set caps, fund, trade; see "Live testnet run" below).
- **`dashboard/`** — read-only conversational web dashboard (`index.html` + `app.js`, zero dependencies): live USDT/WHSK price from QuoterV2, the guard's risk state read straight from the contract, a trade feed (`TradeExecuted` logs, or clearly-labelled signal previews before the guard exists), and a plain-English narration strip generated from live state. See "Dashboard" below.

## How the risk rails work

All enforced inside `executeSwap`, on every trade, fail-closed (a cap of `0` means "not configured" and trades revert):

1. **Kill-switch** — owner can `setPaused(true)` at any time; the contract also latches a `halted` state if executed accounting ever breaches the loss budget, and only the owner can clear it.
2. **Per-trade size cap** — max input per swap, per token (override) or global default, in the input token's own units.
3. **Daily volume cap** — cumulative traded notional per UTC day in quote-token units, checked pre-trade on the guaranteed notional (`amountIn` for buys, `amountOutMin` for sells).
4. **Daily loss cap (stop-loss budget)** — the guard keeps an average-cost basis per position. Before a sell executes, its worst-case realized loss (from `amountOutMin`) must fit the remaining daily loss budget. Buys can't realize losses, so they don't consume the budget.
5. **Slippage rail** — `amountOutMin` must sit within `maxSlippageBps` of the QuoterV2 live quote for the exact pool being traded, so the agent can't accept a bad fill (or be sandwiched into one) beyond the owner's tolerance. If the pool doesn't exist or has no liquidity, the quoter call fails and the trade reverts — fail-closed.

The agent additionally reads `paused` / `halted` / `dayStats` / `getPosition` before proposing, so the dashboard (Phase 2) can show exactly the same risk state the contract enforces.

## The V2/V3 router note (important, honest)

Research (see `../RESEARCH.md`) verified from HSKSwap's own SDK packages (`@hskswap/sdk-core@1.0.3`) that **HSKSwap is a Uniswap V3 fork**: its router is SwapRouter02 (`exactInputSingle`), deployed on both mainnet (177) and testnet (133) at published addresses. The Phase 1 scaffold was built against a Uniswap V2-style interface; **Phase 2 retargeted the guard to V3**: `executeSwap(tokenIn, tokenOut, feeTier, amountIn, amountOutMin)` routes through SwapRouter02 `exactInputSingle` on the single pool the pair + fee tier identify, and the slippage rail quotes through QuoterV2. All risk rails and the average-cost accounting are behavior-identical — V3's direct pairs make the quote token simply "the pair's other token", which is what the accounting already assumed. Two V3 adaptations worth knowing: SwapRouter02 has **no deadline parameter**, so the guard dropped it (staleness is bounded by the live-quote slippage rail in the same transaction), and QuoterV2's quote functions are non-view swap simulations, so the rail calls them with a plain CALL wrapped in try/catch (any failure = no quote = no trade). The old V2 interface file remains in `contracts/interfaces/`, marked deprecated.

## Status — Phase 2 (2026-11-25): V3 retarget done, testnet-ready, live run gated on the faucet

- [x] Chain + DEX research verified from official sources (`../RESEARCH.md`)
- [x] **Guard retargeted to HSKSwap V3** (SwapRouter02 `exactInputSingle` + QuoterV2 slippage quote; rails/accounting unchanged) and **recompiled** (solc 0.8.28, optimizer on; 6,293 bytes creation bytecode, zero errors). `MockERC20` compiles too (2,446 bytes)
- [x] Agent updated to match: QuoterV2 `staticCall` price polling, new `executeSwap` signature, `FEE_TIER`/`QUOTER_ADDRESS` config; all files pass `node --check`; offline signal test re-run OK; the agent's own `PricePoller` was smoke-tested live against testnet (price 78.02 USDT/WHSK)
- [x] **RPC verdict:** `https://testnet.hsk.xyz` answers from our sandbox (chain 133, full read workload). The alt.technology endpoint returns empty replies; dRPC's free plan excludes this chain
- [x] **Testnet tokens + pool verified on-chain:** WHSK `0xca8a…ebf6`, test USDT `0x98b6…aa4f` (18 dp), and their **fee-500 pool `0xff2b…f6ab` holds real liquidity** (≈2.86M USDT / ≈489.5 WHSK; quotes both directions). Neither stable is publicly mintable
- [x] `scripts/live-run.js` written and dry-verified up to its funding gate (generates throwaway keys into `scripts/.env`, mode 600, and stops cleanly with instructions when unfunded)
- [ ] **Live testnet run** — blocked only on faucet HSK: the official faucet (faucet.hsk.xyz) is a browser form behind Google reCAPTCHA (1 HSK/address/24h), so the drip to the script's owner address `0xcD3821db13150C1dBc3983f9FED00e990E612DC2` needs a human/live-browser step. After the drip, `node scripts/live-run.js` deploys the guard and trades end-to-end with no further input
- [x] **Conversational dashboard built** (`dashboard/index.html` + `dashboard/app.js`, dependency-free — no ethers/CDN; hand-rolled ABI encoding + a small pure-JS Keccak-256 for selectors). Smoke-tested headlessly (see "Dashboard" below): all 14 checks pass, including the live price path returning 78.02 USDT/WHSK from the real testnet RPC. It is **read-only by design** (no wallet, no keys, no transactions), so the "adjustable risk appetite" idea from the original sketch is *not* in the dashboard — the owner adjusts caps with `setRiskParams` directly, and the dashboard reflects them. Not click-tested in a real browser (impossible from the sandbox); the RPC does answer `access-control-allow-origin: *`, so browser fetches are not CORS-blocked
- [ ] Final phase: public repo + DoraHacks registration + submission before **3 Dec 2026, 11:00 WIB**; mainnet (177) guard deploy for demo eligibility — **requires Karis's explicit go-ahead and real HSK for gas**

Nothing is deployed anywhere yet; no mainnet anything; the only keys are the throwaway testnet pair in the gitignored `scripts/.env` (zero balance) and the placeholder in `agent/.env.example`.

## Live testnet run

```bash
cd agent && npm install && cd ..   # ethers lives in agent/node_modules
node scripts/live-run.js           # real USDT/WHSK fee-500 pool
node scripts/live-run.js --mock-pool   # fallback: self-deployed mock pool
```

The script hard-refuses any chain other than 133 and any RPC URL containing "mainnet". On first run it generates owner/agent testnet keys into `scripts/.env`; if the owner holds < 0.12 test HSK it exits (code 2) printing the faucet address to drip to. Once funded it: tops up the agent, deploys `SentinelGuard`, sets demo caps, funds the guard, and executes guarded swaps (buy then sell, or — when the owner holds no test USDT — wrap HSK → WHSK, sell first, buy back). Every tx hash is printed, plus the guard's day stats and a ready-to-paste `agent/.env` block.

### Fallback plan (if the real pool ever becomes unusable)

If the fee-500 USDT/WHSK pool's liquidity disappears before the demo, `--mock-pool` mode is the self-contained fallback: it deploys two `MockERC20`s (SUSD/SAST, 18 dp, permissionless mint — testnet only), creates the pair's V3 pool through the HSKSwap Factory (`createPool`, fee 3000), initializes it at price 1.0 (`sqrtPriceX96 = 2^96`), seeds 10,000/10,000 full-range liquidity through the NonfungiblePositionManager, deploys a guard whose quote token is SUSD, funds it, and runs the same buy/sell sequence against the mock pool. Same rails, same agent — only the market is synthetic.

## Dashboard

```bash
cd dashboard
python3 -m http.server 8000   # then open http://127.0.0.1:8000
```

One static page, two files, no build step and no external requests except JSON-RPC to `https://testnet.hsk.xyz` (chain 133), polled every ~15 s:

- **Narration strip** — the agent explains itself in plain sentences generated from live state (price, momentum verdict, kill-switch state, daily volume/loss budget usage, position and unrealized PnL). Template-generated locally; no LLM, no API keys.
- **Market panel** — USDT/WHSK price from a QuoterV2 `quoteExactInputSingle` eth_call against the real fee-500 pool, inverse rate, and a session sparkline.
- **Guard panel** — once `CONFIG.guardAddress` at the top of `app.js` is set (empty by default), it reads the guard's own getters: owner/agent, `paused`/`halted`, per-trade caps (`effectiveMaxTradeIn` for both spend directions), daily volume used vs cap, daily realized PnL and loss used vs cap, `getPosition` (held WHSK + average cost) with unrealized PnL priced off the live quote, and the guard's token balances. Before an address is configured it shows a clear "guard not deployed yet" state while price/signals keep working.
- **Activity feed** — with a guard configured: decoded `TradeExecuted` events (`eth_getLogs`, last 5,000 blocks). Without one: the agent's signal decisions simulated on the live price stream using a verbatim port of `agent/src/signal.js`, each entry badged **SIGNAL PREVIEW — NOT A TRADE**.

The ABI work is hand-rolled on purpose (no ethers in the browser): selectors and the event topic are derived at runtime by a small pure-JS Keccak-256 in `app.js`.

### What was tested, honestly

- **Tested (headless, Node, running `app.js`'s exact code):** Keccak-256 against canonical vectors; every selector/topic cross-checked against ethers and the compiled guard ABI (all guard getters the page uses exist in the ABI with matching output types); word/int256/address decoding on synthetic returns; a synthetic `TradeExecuted` log decode; the dashboard's `computeSignal` is output-identical to `agent/src/signal.js` on multiple series; narration view-models for guard-absent, warm-up, and guard-present (with position/PnL) states; position-PnL BigInt math. **Live:** `eth_blockNumber` and the full price path against `https://testnet.hsk.xyz` returned block ≈ 36.19M and **78.02 USDT/WHSK**. Both files served over `python3 -m http.server` (HTTP 200).
- **Not tested:** a real browser click/render test (no browser in the sandbox) — the DOM layer is a thin renderer over the tested pure functions, and the RPC sends `access-control-allow-origin: *`, but the page has not been visually verified. The guard-configured path has not run against a real deployed guard (none exists yet — it is gated on the same faucet drip as the live run); its calls were verified against the compiled ABI shapes and synthetic data only. After the guard deploys, set `CONFIG.guardAddress` and the panel/feed switch over automatically.

## Quick start (local, offline parts)

```bash
cd agent
npm install
npm run signal-test   # exercise the signal on a synthetic series
cp .env.example .env  # fill in testnet addresses after the Phase 2 deploy
npm start             # DRY_RUN=true by default
```

Compile check for the contracts (artifacts land in `contracts/build/`, which `scripts/live-run.js` consumes):

```bash
cd contracts
npx -p solc@0.8.28 solcjs --bin --abi --optimize --output-dir build SentinelGuard.sol
npx -p solc@0.8.28 solcjs --bin --abi --optimize --output-dir build mocks/MockERC20.sol
```

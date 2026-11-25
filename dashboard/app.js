'use strict';

// ============================================================================
// Sentinel dashboard — dependency-free, read-only.
//
// No ethers, no CDN, no API keys: the handful of eth_call reads this page
// needs (QuoterV2 quote, SentinelGuard getters, ERC-20 balanceOf, plus
// eth_getLogs for TradeExecuted) are done with plain fetch JSON-RPC and
// hand-rolled ABI encoding below. Function selectors and the event topic are
// derived at runtime with the small pure-JS Keccak-256 implementation in this
// file (cross-checked against ethers + the compiled guard ABI by the smoke
// test — see the project README).
// ============================================================================

// ============================== CONFIG ======================================
// Set guardAddress after `scripts/live-run.js` deploys SentinelGuard on
// testnet. While it is empty the dashboard runs in "guard not deployed yet"
// mode: live price + signal previews work, the guard panel explains itself.
const CONFIG = {
  guardAddress: '0x5cb71581A809df2794cfE0191802E32FFC5006f2', // SentinelGuard deployed on HSK testnet (chain 133), 2026-11-25

  rpcUrl: 'https://testnet.hsk.xyz',
  chainId: 133,
  pollMs: 15_000,

  // HSKSwap V3 on testnet (verified on-chain, see ../RESEARCH.md Phase 2).
  quoterAddress: '0x73820d9eE5Bf1BfcD429580320FC7A374E8fa1cC', // QuoterV2
  poolAddress: '0xff2b7E501C870980Bf5641B4a70D0F9fb0f6f6ab', // USDT/WHSK fee-500
  feeTier: 500,

  quoteToken: { address: '0x98b6173a8b7dfc52ce8bc88f1184a918a1ccaa4f', symbol: 'USDT', decimals: 18 },
  tradeToken: { address: '0xca8aaceec5db1e91b9ed3a344ba026c4a2b3ebf6', symbol: 'WHSK', decimals: 18 },

  // How far back the trade feed looks for TradeExecuted logs each poll.
  tradeFeedBlocks: 5_000,
  historySize: 200,
};

// ============================ Keccak-256 ====================================
// Minimal Keccak-256 (the pre-NIST padding variant Ethereum uses), BigInt
// lanes. Only ever fed short ASCII signatures here, but the sponge handles
// arbitrary lengths.
const _RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const _ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];
const _MASK64 = (1n << 64n) - 1n;

function _rotl64(x, n) {
  if (n === 0) return x;
  const b = BigInt(n);
  return ((x << b) | (x >> (64n - b))) & _MASK64;
}

function _keccakF(state) {
  const B = new Array(25);
  const C = new Array(5);
  const D = new Array(5);
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ _rotl64(C[(x + 1) % 5], 1);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) state[x + 5 * y] ^= D[x];
    // rho + pi
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
      B[y + 5 * ((2 * x + 3 * y) % 5)] = _rotl64(state[x + 5 * y], _ROT[x][y]);
    }
    // chi
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
      state[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & B[((x + 2) % 5) + 5 * y]);
    }
    // iota
    state[0] ^= _RC[round];
  }
}

function keccak256Bytes(input) {
  const rate = 136; // 1088-bit rate for Keccak-256
  const state = new Array(25).fill(0n);
  const absorb = (block, len) => {
    for (let i = 0; i < len; i++) {
      state[(i / 8) | 0] ^= BigInt(block[i]) << BigInt(8 * (i % 8));
    }
  };
  let offset = 0;
  while (input.length - offset >= rate) {
    absorb(input.subarray(offset, offset + rate), rate);
    _keccakF(state);
    offset += rate;
  }
  const tail = new Uint8Array(rate);
  tail.set(input.subarray(offset));
  tail[input.length - offset] ^= 0x01; // Keccak domain suffix
  tail[rate - 1] ^= 0x80; // pad10*1
  absorb(tail, rate);
  _keccakF(state);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number((state[(i / 8) | 0] >> BigInt(8 * (i % 8))) & 0xffn);
  }
  return out;
}

function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function keccak256Hex(text) {
  return '0x' + bytesToHex(keccak256Bytes(new TextEncoder().encode(text)));
}

// ============================ ABI helpers ===================================
function selector(signature) {
  return keccak256Hex(signature).slice(0, 10); // '0x' + 4 bytes
}

function encUint(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function encAddress(address) {
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function encodeCall(signature, ...words) {
  return selector(signature) + words.join('');
}

// Decoders: hexData is the raw eth_call return ('0x…'), words are 32 bytes.
function wordAt(hexData, i) {
  const h = hexData.startsWith('0x') ? hexData.slice(2) : hexData;
  const w = h.slice(i * 64, i * 64 + 64);
  if (w.length < 64) throw new Error('short eth_call response');
  return BigInt('0x' + w);
}

function wordToAddress(hexData, i) {
  const h = hexData.startsWith('0x') ? hexData.slice(2) : hexData;
  return '0x' + h.slice(i * 64 + 24, i * 64 + 64);
}

function wordToBool(hexData, i) {
  return wordAt(hexData, i) !== 0n;
}

function wordToInt(hexData, i) {
  const v = wordAt(hexData, i);
  return v >= (1n << 255n) ? v - (1n << 256n) : v;
}

// ============================ JSON-RPC ======================================
let _rpcId = 1;

async function rpcCall(method, params) {
  const res = await fetch(CONFIG.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: _rpcId++, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message || json.error.code}`);
  return json.result;
}

function ethCall(to, data) {
  return rpcCall('eth_call', [{ to, data }, 'latest']);
}

function getBlockNumber() {
  return rpcCall('eth_blockNumber', []).then((h) => Number(BigInt(h)));
}

// ============================ Chain reads ===================================
// QuoterV2.quoteExactInputSingle((tokenIn, tokenOut, amountIn, fee,
// sqrtPriceLimitX96)) — the tuple is all static types, so the calldata is
// just the five words inline. QuoterV2 is non-view (it simulates the swap);
// eth_call handles that fine.
const QUOTE_SIG = 'quoteExactInputSingle((address,address,uint256,uint24,uint160))';

async function quoteExactInputSingle(tokenIn, tokenOut, amountInRaw) {
  const data = encodeCall(
    QUOTE_SIG,
    encAddress(tokenIn),
    encAddress(tokenOut),
    encUint(amountInRaw),
    encUint(CONFIG.feeTier),
    encUint(0n)
  );
  const out = await ethCall(CONFIG.quoterAddress, data);
  return wordAt(out, 0); // amountOut
}

// Spot price: USDT received for exactly 1 WHSK. Both tokens are 18 dp on
// testnet, so the raw amountOut is also the price in 1e18 fixed point.
async function fetchPrice() {
  const oneTrade = 10n ** BigInt(CONFIG.tradeToken.decimals);
  const amountOut = await quoteExactInputSingle(CONFIG.tradeToken.address, CONFIG.quoteToken.address, oneTrade);
  return { amountOutRaw: amountOut, price: Number(amountOut) / 10 ** CONFIG.quoteToken.decimals };
}

const GUARD = {
  owner: 'owner()',
  agent: 'agent()',
  paused: 'paused()',
  halted: 'halted()',
  defaultMaxTradeIn: 'defaultMaxTradeIn()',
  dailyVolumeCapQuote: 'dailyVolumeCapQuote()',
  dailyLossCapQuote: 'dailyLossCapQuote()',
  maxSlippageBps: 'maxSlippageBps()',
  quoteToken: 'quoteToken()',
  dayStats: 'dayStats()',
  getPosition: 'getPosition(address)',
  effectiveMaxTradeIn: 'effectiveMaxTradeIn(address)',
};
const BALANCE_OF_SIG = 'balanceOf(address)';

async function fetchGuardState(guardAddress) {
  const call = (sig, ...words) => ethCall(guardAddress, encodeCall(sig, ...words));
  const balanceOf = (token) => ethCall(token, encodeCall(BALANCE_OF_SIG, encAddress(guardAddress)));
  const [
    owner, agent, paused, halted, defCap, volCap, lossCap, slipBps, qToken,
    stats, position, effQuoteIn, effTradeIn, balQuote, balTrade,
  ] = await Promise.all([
    call(GUARD.owner), call(GUARD.agent), call(GUARD.paused), call(GUARD.halted),
    call(GUARD.defaultMaxTradeIn), call(GUARD.dailyVolumeCapQuote), call(GUARD.dailyLossCapQuote),
    call(GUARD.maxSlippageBps), call(GUARD.quoteToken), call(GUARD.dayStats),
    call(GUARD.getPosition, encAddress(CONFIG.tradeToken.address)),
    call(GUARD.effectiveMaxTradeIn, encAddress(CONFIG.quoteToken.address)),
    call(GUARD.effectiveMaxTradeIn, encAddress(CONFIG.tradeToken.address)),
    balanceOf(CONFIG.quoteToken.address),
    balanceOf(CONFIG.tradeToken.address),
  ]);

  const posAmount = wordAt(position, 0);
  const posCost = wordAt(position, 1);
  return {
    address: guardAddress,
    owner: wordToAddress(owner, 0),
    agent: wordToAddress(agent, 0),
    paused: wordToBool(paused, 0),
    halted: wordToBool(halted, 0),
    defaultMaxTradeIn: wordAt(defCap, 0),
    dailyVolumeCapQuote: wordAt(volCap, 0),
    dailyLossCapQuote: wordAt(lossCap, 0),
    maxSlippageBps: wordAt(slipBps, 0),
    quoteToken: wordToAddress(qToken, 0),
    dayVolumeQuote: wordAt(stats, 0),
    dayRealizedPnlQuote: wordToInt(stats, 1),
    positionAmount: posAmount, // trade-token raw units
    positionCostQuote: posCost, // quote-token raw units
    effectiveCapQuoteIn: wordAt(effQuoteIn, 0),
    effectiveCapTradeIn: wordAt(effTradeIn, 0),
    balanceQuote: wordAt(balQuote, 0),
    balanceTrade: wordAt(balTrade, 0),
  };
}

// Derived position economics, in raw quote-token units (BigInt throughout).
function positionEconomics(guard, priceAmountOutRaw) {
  const amount = guard.positionAmount;
  const cost = guard.positionCostQuote;
  if (amount === 0n) {
    return { avgCostRaw: 0n, valueRaw: 0n, unrealizedPnlRaw: 0n };
  }
  const oneTrade = 10n ** BigInt(CONFIG.tradeToken.decimals);
  const valueRaw = (amount * priceAmountOutRaw) / oneTrade;
  const avgCostRaw = (cost * oneTrade) / amount; // quote raw per 1 trade token
  return { avgCostRaw, valueRaw, unrealizedPnlRaw: valueRaw - cost };
}

const TRADE_EXECUTED_TOPIC = keccak256Hex('TradeExecuted(address,address,uint24,uint256,uint256,uint256,int256)');

function decodeTradeLog(log) {
  const data = log.data;
  return {
    blockNumber: Number(BigInt(log.blockNumber)),
    txHash: log.transactionHash,
    logIndex: Number(BigInt(log.logIndex)),
    tokenIn: '0x' + log.topics[1].slice(-40),
    tokenOut: '0x' + log.topics[2].slice(-40),
    feeTier: Number(wordAt(data, 0)),
    amountIn: wordAt(data, 1),
    amountOut: wordAt(data, 2),
    notionalQuote: wordAt(data, 3),
    dayRealizedPnlQuote: wordToInt(data, 4),
  };
}

async function fetchTradeEvents(guardAddress, latestBlock) {
  const from = Math.max(0, latestBlock - CONFIG.tradeFeedBlocks + 1);
  const logs = await rpcCall('eth_getLogs', [{
    address: guardAddress,
    topics: [TRADE_EXECUTED_TOPIC],
    fromBlock: '0x' + from.toString(16),
    toBlock: 'latest',
  }]);
  return logs.map(decodeTradeLog).sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
}

// ============================ Signal ========================================
// Ported verbatim (logic + defaults) from agent/src/signal.js so the
// dashboard's signal previews are exactly what the agent would compute on
// the same price series. Pure function over prices (quote per 1 trade
// token, oldest -> newest).
function sma(values, window) {
  if (values.length < window) return null;
  const slice = values.slice(values.length - window);
  return slice.reduce((a, b) => a + b, 0) / window;
}

function computeSignal(prices, opts = {}) {
  const fastWindow = opts.fastWindow ?? 5;
  const slowWindow = opts.slowWindow ?? 20;
  const momentumThresholdBps = opts.momentumThresholdBps ?? 30; // 0.30%
  const overextendedBps = opts.overextendedBps ?? 300; // 3% above slow MA: don't chase

  const reasons = [];
  if (!Array.isArray(prices) || prices.length < slowWindow) {
    return { side: 'hold', strengthBps: 0, momentumBps: 0, deviationBps: 0, reasons: ['not enough price history'] };
  }

  const last = prices[prices.length - 1];
  const fast = sma(prices, fastWindow);
  const slow = sma(prices, slowWindow);
  const momentumBps = Math.round(((fast - slow) / slow) * 10000);
  const deviationBps = Math.round(((last - slow) / slow) * 10000);

  let side = 'hold';
  if (momentumBps >= momentumThresholdBps) {
    if (deviationBps <= overextendedBps) {
      side = 'buy';
      reasons.push(`momentum +${momentumBps}bps (fast MA above slow MA)`);
    } else {
      reasons.push(`momentum +${momentumBps}bps but price overextended (+${deviationBps}bps vs slow MA); not chasing`);
    }
  } else if (momentumBps <= -momentumThresholdBps) {
    side = 'sell';
    reasons.push(`momentum ${momentumBps}bps (fast MA below slow MA)`);
  } else {
    reasons.push(`momentum ${momentumBps}bps inside ±${momentumThresholdBps}bps band`);
  }

  return { side, strengthBps: Math.abs(momentumBps), momentumBps, deviationBps, reasons };
}

// ============================ Formatting ====================================
function fmtUnits(raw, decimals, dp = 2) {
  const v = Number(raw) / 10 ** decimals;
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function fmtSignedUnits(raw, decimals, dp = 2) {
  const v = Number(raw) / 10 ** decimals;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return (v > 0 ? '+' : v < 0 ? '−' : '') + s;
}

function fmtPrice(p) {
  return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shortAddr(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—';
}

function tokenSymbol(address) {
  const a = (address || '').toLowerCase();
  if (a === CONFIG.quoteToken.address.toLowerCase()) return CONFIG.quoteToken.symbol;
  if (a === CONFIG.tradeToken.address.toLowerCase()) return CONFIG.tradeToken.symbol;
  return shortAddr(address);
}

function tokenDecimals(address) {
  const a = (address || '').toLowerCase();
  if (a === CONFIG.quoteToken.address.toLowerCase()) return CONFIG.quoteToken.decimals;
  if (a === CONFIG.tradeToken.address.toLowerCase()) return CONFIG.tradeToken.decimals;
  return 18;
}

// ============================ Narration =====================================
// The conversational strip: plain sentences generated from live state.
// Pure function of a plain state object so the smoke test can exercise it:
//   { price, signal, historyLength, guard|null, econ|null }
function buildNarration(s) {
  const Q = CONFIG.quoteToken.symbol;
  const T = CONFIG.tradeToken.symbol;
  const out = [];

  if (s.price == null) {
    return ['I cannot reach the market right now — the last price poll failed, so I am standing still.'];
  }
  out.push(`Price is ${fmtPrice(s.price)} ${Q} per ${T} on the HSKSwap fee-${CONFIG.feeTier} pool.`);

  const sig = s.signal;
  if (!sig || sig.reasons.includes('not enough price history')) {
    const need = 20 - (s.historyLength || 0);
    out.push(`I am still warming up — I need ${Math.max(need, 0)} more price samples before my momentum signal activates, so for now I am holding.`);
  } else if (sig.side === 'buy') {
    out.push(`Momentum is +${sig.momentumBps} bps with the fast average above the slow one, so my signal says buy — I would spend ${Q} on ${T} if my guard allows it.`);
  } else if (sig.side === 'sell') {
    out.push(`Momentum is ${sig.momentumBps} bps with the fast average below the slow one, so my signal says sell — I would move ${T} back into ${Q} if my guard allows it.`);
  } else if (sig.reasons.some((r) => r.includes('overextended'))) {
    out.push(`Momentum is +${sig.momentumBps} bps, but the price is overextended versus its slow average, so I am not chasing it — holding.`);
  } else {
    out.push(`Momentum is flat (${sig.momentumBps >= 0 ? '+' : ''}${sig.momentumBps} bps, inside my ±30 bps band), so I am holding.`);
  }

  if (!s.guard) {
    out.push('My guard contract is not deployed yet, so nothing can actually trade — everything you see here is a live signal preview, not a trade.');
    return out;
  }

  const g = s.guard;
  const qd = CONFIG.quoteToken.decimals;
  if (g.paused) out.push('The owner has flipped the kill-switch: I am paused and cannot trade.');
  else if (g.halted) out.push('My loss-budget latch has tripped: I am halted until the owner clears it.');
  else out.push('Kill-switch is off and I am not halted.');

  out.push(`Daily volume used ${fmtUnits(g.dayVolumeQuote, qd)} of ${fmtUnits(g.dailyVolumeCapQuote, qd)} ${Q}.`);
  const pnl = g.dayRealizedPnlQuote;
  if (pnl < 0n) {
    out.push(`Today's realized PnL is ${fmtSignedUnits(pnl, qd)} ${Q}, using ${fmtUnits(-pnl, qd)} of my ${fmtUnits(g.dailyLossCapQuote, qd)} ${Q} daily loss budget.`);
  } else {
    out.push(`Today's realized PnL is ${fmtSignedUnits(pnl, qd)} ${Q} against a daily loss budget of ${fmtUnits(g.dailyLossCapQuote, qd)} ${Q}.`);
  }

  if (g.positionAmount === 0n) {
    out.push(`I hold no ${T} position right now.`);
  } else if (s.econ) {
    out.push(
      `I hold ${fmtUnits(g.positionAmount, CONFIG.tradeToken.decimals, 4)} ${T} at an average cost of ${fmtUnits(s.econ.avgCostRaw, qd)} ${Q}, ` +
      `worth ${fmtUnits(s.econ.valueRaw, qd)} ${Q} now — unrealized PnL ${fmtSignedUnits(s.econ.unrealizedPnlRaw, qd)} ${Q}.`
    );
  }
  return out;
}

// ============================ Browser UI ====================================
const ui = {
  priceHistory: [], // floats, oldest -> newest (this browser session)
  previews: [], // signal-preview feed entries (guard-absent mode)
  lastPreviewKey: null,
};

function el(id) {
  return document.getElementById(id);
}

function kv(k, v, title) {
  return `<div class="kv"><span class="k">${k}</span><span class="v"${title ? ` title="${title}"` : ''}>${v}</span></div>`;
}

function bar(pct, cls) {
  const w = Math.max(0, Math.min(100, pct));
  return `<div class="bar ${cls || ''}"><div style="width:${w.toFixed(1)}%"></div></div>`;
}

function pctOf(used, cap) {
  if (cap === 0n) return 0;
  return Number((used * 10000n) / cap) / 100;
}

function renderGuard(g, econ) {
  const body = el('guard-body');
  const Q = CONFIG.quoteToken;
  const T = CONFIG.tradeToken;
  if (!g) {
    body.innerHTML =
      `<div class="notice"><strong>Guard not deployed yet.</strong><br>` +
      `No SentinelGuard address is configured, so there is no vault, no position and no trades — ` +
      `the price and signal data on this page are live, and the feed below shows signal previews only.<br><br>` +
      `After <code>scripts/live-run.js</code> deploys the guard on testnet, set ` +
      `<code>CONFIG.guardAddress</code> at the top of <code>app.js</code> and reload.</div>`;
    return;
  }

  const lossUsed = g.dayRealizedPnlQuote < 0n ? -g.dayRealizedPnlQuote : 0n;
  const pnlCls = g.dayRealizedPnlQuote > 0n ? 'pos' : g.dayRealizedPnlQuote < 0n ? 'neg' : '';
  const unPnlCls = econ && econ.unrealizedPnlRaw > 0n ? 'pos' : econ && econ.unrealizedPnlRaw < 0n ? 'neg' : '';
  const capsOff = g.dailyVolumeCapQuote === 0n && g.dailyLossCapQuote === 0n;

  body.innerHTML =
    `<div class="chips">` +
    `<span class="chip ${g.paused ? 'on' : 'off'}">Kill-switch (paused): ${g.paused ? 'ON — cannot trade' : 'off'}</span>` +
    `<span class="chip ${g.halted ? 'on' : 'off'}">Loss-budget halt: ${g.halted ? 'TRIPPED' : 'clear'}</span>` +
    `</div>` +
    kv('Guard', shortAddr(g.address), g.address) +
    kv('Owner', shortAddr(g.owner), g.owner) +
    kv('Agent', shortAddr(g.agent), g.agent) +
    kv('Guard balance', `${fmtUnits(g.balanceQuote, Q.decimals)} ${Q.symbol} · ${fmtUnits(g.balanceTrade, T.decimals, 4)} ${T.symbol}`) +
    kv(`Per-trade cap (spend ${Q.symbol})`, g.effectiveCapQuoteIn === 0n ? 'not configured' : `${fmtUnits(g.effectiveCapQuoteIn, Q.decimals)} ${Q.symbol}`) +
    kv(`Per-trade cap (spend ${T.symbol})`, g.effectiveCapTradeIn === 0n ? 'not configured' : `${fmtUnits(g.effectiveCapTradeIn, T.decimals, 4)} ${T.symbol}`) +
    kv('Max slippage rail', `${(Number(g.maxSlippageBps) / 100).toFixed(2)}%`) +
    `<div style="margin-top:10px">` +
    kv('Daily volume', `${fmtUnits(g.dayVolumeQuote, Q.decimals)} / ${fmtUnits(g.dailyVolumeCapQuote, Q.decimals)} ${Q.symbol}`) +
    bar(pctOf(g.dayVolumeQuote, g.dailyVolumeCapQuote)) +
    kv('Daily realized PnL', `<span class="${pnlCls}">${fmtSignedUnits(g.dayRealizedPnlQuote, Q.decimals)} ${Q.symbol}</span>`) +
    kv('Daily loss used', `${fmtUnits(lossUsed, Q.decimals)} / ${fmtUnits(g.dailyLossCapQuote, Q.decimals)} ${Q.symbol}`) +
    bar(pctOf(lossUsed, g.dailyLossCapQuote), 'loss') +
    `</div>` +
    (g.positionAmount === 0n
      ? kv('Position', `no ${T.symbol} held`)
      : kv('Position', `${fmtUnits(g.positionAmount, T.decimals, 4)} ${T.symbol}`) +
        kv('Average cost', `${fmtUnits(econ.avgCostRaw, Q.decimals)} ${Q.symbol} / ${T.symbol}`) +
        kv('Position value now', `${fmtUnits(econ.valueRaw, Q.decimals)} ${Q.symbol}`) +
        kv('Unrealized PnL', `<span class="${unPnlCls}">${fmtSignedUnits(econ.unrealizedPnlRaw, Q.decimals)} ${Q.symbol}</span>`)) +
    (capsOff ? `<div class="empty" style="margin-top:8px">Caps are 0 = unconfigured: the guard reverts every trade (fail-closed) until the owner sets them.</div>` : '');
}

function renderFeed(events, guardConfigured) {
  const title = el('feed-title');
  const list = el('feed');
  if (!guardConfigured) {
    title.innerHTML = 'Signal previews <span class="tag">NOT TRADES</span>';
    if (ui.previews.length === 0) {
      list.innerHTML = '<li class="empty">No signal computed yet — previews appear once 20 live price samples have accumulated (about 5 minutes at this poll rate), exactly like the agent\'s warm-up.</li>';
      return;
    }
    list.innerHTML = ui.previews.map((p) => {
      const cls = p.side === 'buy' ? 'buy' : p.side === 'sell' ? 'sell' : 'hold';
      return `<li><span class="side ${cls}">${p.side.toUpperCase()}</span><span class="tag">SIGNAL PREVIEW</span>` +
        ` <span class="meta">${p.time} · ${fmtPrice(p.price)} ${CONFIG.quoteToken.symbol}/${CONFIG.tradeToken.symbol}</span>` +
        `<br>${p.reasons.join('; ')}</li>`;
    }).join('');
    return;
  }

  title.textContent = 'Trades — TradeExecuted events';
  if (!events || events.length === 0) {
    list.innerHTML = `<li class="empty">No TradeExecuted events in the last ${CONFIG.tradeFeedBlocks.toLocaleString('en-US')} blocks.</li>`;
    return;
  }
  list.innerHTML = events.map((ev) => {
    const isBuy = ev.tokenIn.toLowerCase() === CONFIG.quoteToken.address.toLowerCase();
    const side = isBuy ? 'BUY' : 'SELL';
    const cls = isBuy ? 'buy' : 'sell';
    const inAmt = `${fmtUnits(ev.amountIn, tokenDecimals(ev.tokenIn), isBuy ? 2 : 4)} ${tokenSymbol(ev.tokenIn)}`;
    const outAmt = `${fmtUnits(ev.amountOut, tokenDecimals(ev.tokenOut), isBuy ? 4 : 2)} ${tokenSymbol(ev.tokenOut)}`;
    const pnl = ev.dayRealizedPnlQuote;
    const pnlCls = pnl > 0n ? 'pos' : pnl < 0n ? 'neg' : '';
    return `<li><span class="side ${cls}">${side}</span> ${inAmt} → ${outAmt}` +
      ` <span class="meta">block ${ev.blockNumber} · <a href="https://hashkeychain-testnet-explorer.alt.technology/tx/${ev.txHash}" target="_blank" rel="noopener">${ev.txHash.slice(0, 10)}…</a></span>` +
      `<br><span class="meta">notional ${fmtUnits(ev.notionalQuote, CONFIG.quoteToken.decimals)} ${CONFIG.quoteToken.symbol} · day realized PnL after trade: <span class="${pnlCls}">${fmtSignedUnits(pnl, CONFIG.quoteToken.decimals)} ${CONFIG.quoteToken.symbol}</span></span></li>`;
  }).join('');
}

function drawSpark() {
  const canvas = el('spark');
  if (!canvas || ui.priceHistory.length < 2) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const prices = ui.priceHistory;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  prices.forEach((p, i) => {
    const x = (i / (prices.length - 1)) * (w - 8) + 4;
    const y = h - 6 - ((p - min) / span) * (h - 12);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#4da3ff';
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

async function refresh() {
  const dot = el('rpc-dot');
  try {
    const block = await getBlockNumber();
    const { amountOutRaw, price } = await fetchPrice();

    ui.priceHistory.push(price);
    if (ui.priceHistory.length > CONFIG.historySize) ui.priceHistory.shift();
    const signal = computeSignal(ui.priceHistory);

    let guard = null;
    let econ = null;
    let events = null;
    if (CONFIG.guardAddress) {
      guard = await fetchGuardState(CONFIG.guardAddress);
      econ = positionEconomics(guard, amountOutRaw);
      try {
        events = await fetchTradeEvents(CONFIG.guardAddress, block);
      } catch (e) {
        events = null; // feed degrades gracefully; guard state still renders
      }
    } else if (ui.priceHistory.length >= 20) {
      const key = `${signal.side}|${signal.reasons.join(';')}`;
      if (key !== ui.lastPreviewKey) {
        ui.lastPreviewKey = key;
        ui.previews.unshift({ side: signal.side, reasons: signal.reasons, price, time: new Date().toLocaleTimeString('en-GB') });
        if (ui.previews.length > 12) ui.previews.pop();
      }
    }

    dot.className = 'dot ok';
    el('rpc-status').textContent = 'RPC live';
    el('block-num').textContent = block.toLocaleString('en-US');
    el('updated-at').textContent = new Date().toLocaleTimeString('en-GB');
    el('price').textContent = fmtPrice(price);
    el('price-inv').textContent = `1 ${CONFIG.quoteToken.symbol} ≈ ${(1 / price).toFixed(6)} ${CONFIG.tradeToken.symbol}`;
    el('pool-addr').textContent = shortAddr(CONFIG.poolAddress);
    el('pool-addr').title = CONFIG.poolAddress;
    el('quoter-addr').textContent = shortAddr(CONFIG.quoterAddress);
    el('quoter-addr').title = CONFIG.quoterAddress;
    el('signal-line').textContent = ui.priceHistory.length < 20
      ? `warming up (${ui.priceHistory.length}/20 samples)`
      : `${signal.side.toUpperCase()} — ${signal.reasons.join('; ')}`;
    el('narration').textContent = buildNarration({
      price, signal, historyLength: ui.priceHistory.length, guard, econ,
    }).join(' ');
    renderGuard(guard, econ);
    renderFeed(events, Boolean(CONFIG.guardAddress));
    drawSpark();
  } catch (err) {
    dot.className = 'dot bad';
    el('rpc-status').textContent = 'RPC unreachable';
    el('narration').textContent = buildNarration({ price: null, signal: null, historyLength: ui.priceHistory.length, guard: null, econ: null }).join(' ');
    el('signal-line').textContent = `poll failed: ${err.message}`;
  }
}

if (typeof document !== 'undefined') {
  el('pool-addr').textContent = shortAddr(CONFIG.poolAddress);
  refresh();
  setInterval(refresh, CONFIG.pollMs);
}

// ============================ Node exports ==================================
// Used by the smoke test to run this file's exact read logic headlessly.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG,
    keccak256Hex,
    selector,
    encodeCall,
    encAddress,
    encUint,
    wordAt,
    wordToAddress,
    wordToBool,
    wordToInt,
    rpcCall,
    ethCall,
    getBlockNumber,
    quoteExactInputSingle,
    fetchPrice,
    fetchGuardState,
    fetchTradeEvents,
    decodeTradeLog,
    TRADE_EXECUTED_TOPIC,
    computeSignal,
    positionEconomics,
    buildNarration,
    fmtUnits,
    fmtSignedUnits,
  };
}

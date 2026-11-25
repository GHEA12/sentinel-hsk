'use strict';

// Minimal config loader: reads an optional .env file next to the agent
// folder (no dotenv dependency — ethers is the only dependency), then
// overlays real environment variables.

const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function loadConfig() {
  loadDotEnv();
  return {
    rpcUrl: required('RPC_URL'),
    chainId: Number(process.env.CHAIN_ID || 133),
    guardAddress: required('GUARD_ADDRESS'),
    routerAddress: required('ROUTER_ADDRESS'),
    quoterAddress: required('QUOTER_ADDRESS'),
    // HSKSwap V3 pool fee tier for the traded pair (500 = 0.05%).
    feeTier: Number(process.env.FEE_TIER || 3000),
    quoteToken: required('QUOTE_TOKEN'),
    tradeToken: required('TRADE_TOKEN'),
    quoteDecimals: Number(process.env.QUOTE_DECIMALS || 18),
    tradeDecimals: Number(process.env.TRADE_DECIMALS || 18),
    agentPrivateKey: required('AGENT_PRIVATE_KEY'),
    pollMs: Number(process.env.POLL_MS || 15000),
    // Human-denominated quote amount per trade (e.g. "10" = 10 USDT).
    tradeAmountQuote: process.env.TRADE_AMOUNT_QUOTE || '10',
    slippageBps: Number(process.env.SLIPPAGE_BPS || 100),
    dryRun: String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false',
  };
}

module.exports = { loadConfig };

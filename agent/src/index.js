'use strict';

// Sentinel agent — main loop.
//
//   poll price -> update history -> compute signal -> propose trade ->
//   SentinelGuard enforces the risk rails on-chain.
//
// Phase 2: runs against HashKey Chain testnet (133) with DRY_RUN on by
// default, quoting via HSKSwap's QuoterV2. It never holds owner powers: the
// agent key can only call executeSwap, and the guard contract bounds what
// that can do.

const { ethers } = require('ethers');
const { loadConfig } = require('./config');
const { PricePoller } = require('./prices');
const { computeSignal } = require('./signal');
const { Trader } = require('./trader');

async function main() {
  const config = loadConfig();
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);

  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.chainId) {
    throw new Error(`RPC chain mismatch: expected ${config.chainId}, got ${network.chainId}`);
  }
  console.log(`[sentinel] connected to chain ${network.chainId} via ${config.rpcUrl}`);
  console.log(`[sentinel] guard ${config.guardAddress} | dry-run: ${config.dryRun}`);

  const poller = new PricePoller({
    provider,
    quoterAddress: config.quoterAddress,
    feeTier: config.feeTier,
    quoteToken: config.quoteToken,
    tradeToken: config.tradeToken,
    quoteDecimals: config.quoteDecimals,
    tradeDecimals: config.tradeDecimals,
  });
  const trader = new Trader({ config, provider, poller });

  let stopped = false;
  process.on('SIGINT', () => {
    console.log('[sentinel] shutting down');
    stopped = true;
  });

  while (!stopped) {
    try {
      const price = await poller.pollOnce();
      const signal = computeSignal(poller.prices(), {});
      console.log(
        `[sentinel] price=${price.toFixed(6)} momentum=${signal.momentumBps}bps deviation=${signal.deviationBps}bps -> ${signal.side}`
      );
      const proposal = await trader.buildProposal(signal);
      if (proposal) await trader.executeProposal(proposal);
    } catch (err) {
      // A reverted proposal (rail hit) or a flaky RPC must not kill the loop.
      console.error('[sentinel] loop error:', err.shortMessage || err.message);
    }
    await new Promise((r) => setTimeout(r, config.pollMs));
  }
}

main().catch((err) => {
  console.error('[sentinel] fatal:', err);
  process.exit(1);
});

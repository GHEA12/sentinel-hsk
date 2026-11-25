'use strict';

// Trade-proposal flow: turn a signal into a SentinelGuard.executeSwap call.
//
// The agent proposes; the guard disposes. Every proposal is checked against
// the guard's live state (paused / halted / position) before sending, and
// the guard re-checks all caps on-chain anyway — a proposal that violates a
// rail simply reverts, which the agent logs instead of retrying blindly.

const { ethers } = require('ethers');

const GUARD_ABI = [
  'function executeSwap(address tokenIn, address tokenOut, uint24 feeTier, uint256 amountIn, uint256 amountOutMin) returns (uint256 amountOut)',
  'function paused() view returns (bool)',
  'function halted() view returns (bool)',
  'function dayStats() view returns (uint256 volumeQuote, int256 realizedPnlQuote)',
  'function getPosition(address token) view returns (uint256 amount, uint256 costQuote)',
  'function effectiveMaxTradeIn(address token) view returns (uint256)',
];

class Trader {
  constructor({ config, provider, poller }) {
    this.config = config;
    this.poller = poller;
    this.wallet = new ethers.Wallet(config.agentPrivateKey, provider);
    this.guard = new ethers.Contract(config.guardAddress, GUARD_ABI, this.wallet);
  }

  /// Build a proposal from a signal. Returns null when the signal is not
  /// actionable for the current position.
  async buildProposal(signal) {
    const cfg = this.config;
    if (signal.side === 'hold') return null;

    if (signal.side === 'buy') {
      const amountIn = ethers.parseUnits(cfg.tradeAmountQuote, cfg.quoteDecimals);
      const quotedOut = await this.poller.quoteExactIn(cfg.quoteToken, cfg.tradeToken, amountIn);
      return this.#finalize(cfg.quoteToken, cfg.tradeToken, amountIn, quotedOut, signal);
    }

    // sell: dump the guard's tracked position in the trade token (capped by
    // the configured quote notional at current price, so sells stay sized).
    const [posAmount] = await this.guard.getPosition(cfg.tradeToken);
    if (posAmount === 0n) return null;
    const notionalCap = ethers.parseUnits(cfg.tradeAmountQuote, cfg.tradeDecimals);
    const fullQuote = await this.poller.quoteExactIn(cfg.tradeToken, cfg.quoteToken, posAmount);
    let amountIn = posAmount;
    if (fullQuote > notionalCap) {
      amountIn = (posAmount * notionalCap) / fullQuote; // proportional slice
    }
    const quotedOut = await this.poller.quoteExactIn(cfg.tradeToken, cfg.quoteToken, amountIn);
    return this.#finalize(cfg.tradeToken, cfg.quoteToken, amountIn, quotedOut, signal);
  }

  #finalize(tokenIn, tokenOut, amountIn, quotedOut, signal) {
    const slippageFactor = 10_000n - BigInt(this.config.slippageBps);
    const amountOutMin = (quotedOut * slippageFactor) / 10_000n;
    return {
      tokenIn,
      tokenOut,
      feeTier: this.config.feeTier,
      amountIn,
      amountOutMin,
      quotedOut,
      signal,
    };
  }

  /// Check guard state, then either log the proposal (DRY_RUN) or send it.
  async executeProposal(proposal) {
    const [paused, halted] = await Promise.all([this.guard.paused(), this.guard.halted()]);
    const summary = {
      side: proposal.tokenIn === this.config.quoteToken ? 'buy' : 'sell',
      feeTier: proposal.feeTier,
      amountIn: proposal.amountIn.toString(),
      amountOutMin: proposal.amountOutMin.toString(),
      quotedOut: proposal.quotedOut.toString(),
      reasons: proposal.signal.reasons,
      guardPaused: paused,
      guardHalted: halted,
    };

    if (paused || halted) {
      console.log('[sentinel] proposal skipped — guard is', paused ? 'PAUSED (kill-switch)' : 'HALTED (loss budget)', summary);
      return { skipped: true, summary };
    }
    if (this.config.dryRun) {
      console.log('[sentinel] DRY_RUN proposal (not sent):', summary);
      return { dryRun: true, summary };
    }

    const tx = await this.guard.executeSwap(
      proposal.tokenIn,
      proposal.tokenOut,
      proposal.feeTier,
      proposal.amountIn,
      proposal.amountOutMin
    );
    console.log('[sentinel] executeSwap sent:', tx.hash);
    const receipt = await tx.wait();
    console.log('[sentinel] confirmed in block', receipt.blockNumber);
    return { txHash: tx.hash, summary };
  }
}

module.exports = { Trader, GUARD_ABI };

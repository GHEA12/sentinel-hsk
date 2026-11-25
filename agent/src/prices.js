'use strict';

// Price polling against HSKSwap's QuoterV2 (Uniswap V3 fork).
//
// QuoterV2's quote functions are non-view (they simulate the swap on-chain),
// so every read goes through ethers' `.staticCall` — an eth_call that never
// sends a transaction. The interface exposed to the rest of the agent
// (getPrice, quoteExactIn, pollOnce, history) is unchanged from Phase 1.

const { ethers } = require('ethers');

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

class PricePoller {
  constructor({ provider, quoterAddress, feeTier, quoteToken, tradeToken, quoteDecimals, tradeDecimals, historySize = 200 }) {
    this.quoter = new ethers.Contract(quoterAddress, QUOTER_ABI, provider);
    this.feeTier = feeTier;
    this.quoteToken = quoteToken;
    this.tradeToken = tradeToken;
    this.quoteDecimals = quoteDecimals;
    this.tradeDecimals = tradeDecimals;
    this.historySize = historySize;
    this.history = []; // [{ t: epochMs, price: quote per 1 trade token (float) }]
  }

  /// Spot price of 1 TRADE_TOKEN in QUOTE_TOKEN units, via a QuoterV2 quote.
  async getPrice() {
    const probeIn = ethers.parseUnits('1', this.tradeDecimals);
    const quoted = await this.quoteExactIn(this.tradeToken, this.quoteToken, probeIn);
    return Number(ethers.formatUnits(quoted, this.quoteDecimals));
  }

  /// Quote an exact input on the configured pool; returns raw amountOut
  /// (bigint, tokenOut units).
  async quoteExactIn(tokenIn, tokenOut, amountInRaw) {
    const result = await this.quoter.quoteExactInputSingle.staticCall({
      tokenIn,
      tokenOut,
      amountIn: amountInRaw,
      fee: this.feeTier,
      sqrtPriceLimitX96: 0,
    });
    return result[0]; // amountOut
  }

  async pollOnce() {
    const price = await this.getPrice();
    this.history.push({ t: Date.now(), price });
    if (this.history.length > this.historySize) this.history.shift();
    return price;
  }

  prices() {
    return this.history.map((h) => h.price);
  }
}

module.exports = { PricePoller, QUOTER_ABI };

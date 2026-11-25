'use strict';

// Momentum + spread signal. Pure function over a price series — no I/O, so
// it is unit-testable offline (see the `signal-test` npm script).
//
// Inputs: prices = quote-token price of 1 trade token, oldest -> newest.
//   - Momentum: fast MA vs slow MA of the pool price. Rising fast-over-slow
//     means the market is trending up.
//   - Spread/dislocation: distance of the latest price from the slow MA.
//     In Phase 2 this slot is where a second reference (another pool, the
//     HSKSwap subgraph, or an oracle) gets compared against the pool price
//     for a true cross-venue spread; in Phase 1 the slow MA is the
//     reference, i.e. a mean-reversion/dislocation proxy.
//
// Output: { side: 'buy' | 'sell' | 'hold', strengthBps, momentumBps,
//           deviationBps, reasons: string[] }
//   buy  = spend quote, acquire trade token (guard: quote -> token)
//   sell = dump trade token back to quote    (guard: token -> quote)

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
  const momentumBps = Math.round(((fast - slow) / slow) * 10_000);
  const deviationBps = Math.round(((last - slow) / slow) * 10_000);

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

  return {
    side,
    strengthBps: Math.abs(momentumBps),
    momentumBps,
    deviationBps,
    reasons,
  };
}

module.exports = { computeSignal };

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20, ISwapRouter02Like, IQuoterV2Like} from "./interfaces/ISwapRouter02Like.sol";

/// @title SentinelGuard
/// @notice A risk-rail vault for an autonomous trading agent ("Sentinel",
///         HSK Chain Horizon Hackathon, Track 1: AI Agent Trading).
///
///         The human owner funds this contract and sets hard limits. The
///         authorized agent address — and only the agent — can execute swaps,
///         and every swap is forced through the rails below. The agent's key
///         can be fully compromised and the maximum damage is still bounded
///         by the caps: it cannot withdraw funds, change limits, or trade
///         beyond them.
///
/// Risk rails enforced on every `executeSwap`:
///   1. Kill-switch: owner can pause all trading instantly (`paused`), and
///      the contract also halts itself if accounting ever breaches the daily
///      loss budget (`halted`, owner clears it manually).
///   2. Per-trade size cap: max `amountIn` per swap, per input token
///      (per-token override, else the default cap), in the input token's own
///      smallest units.
///   3. Daily volume cap: cumulative traded notional per UTC day, measured in
///      the designated quote token (e.g. USDT). Every swap must involve the
///      quote token on one side, which is what makes notionals comparable.
///   4. Daily loss cap: average-cost-basis accounting per token position.
///      A sell's worst-case realized loss (computed from `amountOutMin`) is
///      checked *before* execution against the remaining daily loss budget.
///   5. Slippage rail: `amountOutMin` must be within `maxSlippageBps` of the
///      QuoterV2 quote for the same pool at execution time.
///
/// DEX integration (Phase 2): HSKSwap is a Uniswap V3 fork. Swaps are
/// single-pool direct pairs executed via SwapRouter02 `exactInputSingle`
/// (tokenIn/tokenOut/feeTier identify exactly one pool), and the quote token
/// is always the pair's other token — which is precisely the instrument the
/// accounting below already reasons about, so the V2->V3 retarget changed
/// only the router/quoter call sites, not the rails or the accounting.
/// SwapRouter02 has no deadline parameter, so neither does `executeSwap`;
/// a stale proposal is bounded by the slippage rail (live quote vs
/// `amountOutMin`) inside the same transaction instead.
///
/// Accounting model (deliberately simple, no oracle):
///   - "Day" = block.timestamp / 1 days (UTC). Volume and realized PnL reset
///     lazily on the first trade of a new day; position cost basis persists.
///   - Buys (quote -> token): position amount += actual out,
///     position cost += quote spent.
///   - Sells (token -> quote): cost is removed proportionally at average
///     cost; realized PnL += quote received - cost removed. Tokens deposited
///     directly (not bought through the guard) carry zero cost basis, so
///     selling them books the full proceeds as profit — conservative for the
///     loss cap, and documented here so nobody is surprised.
///   - The volume cap is enforced pre-trade on the guaranteed notional
///     (amountIn for buys, amountOutMin for sells); the recorded volume uses
///     actual executed amounts, so a sell can land slightly above the cap if
///     the pool pays more than the minimum. The loss cap is enforced on the
///     true worst case (amountOutMin), so it can never be overshot.
///   - All caps are fail-closed: a cap of 0 means "not configured" and
///     trades revert until the owner sets real values.
///
/// Scope limits of this scaffold: single-pool token<->quote swaps only
/// (no multi-hop); no native-token (HSK) swaps — use the wrapped token
/// (WHSK) as a normal ERC-20.
contract SentinelGuard {
    // ------------------------------------------------------------------ types

    struct Position {
        uint256 amount; // tokens held that were bought through the guard
        uint256 costQuote; // total quote-token cost basis of `amount`
    }

    // ------------------------------------------------------------------ state

    address public owner;
    address public agent;
    ISwapRouter02Like public router;
    IQuoterV2Like public quoter;
    address public quoteToken;

    /// @notice Kill-switch: when true, no swaps execute.
    bool public paused;
    /// @notice Auto-halt latch, set if the daily loss budget is ever breached
    ///         by executed accounting. Owner must call `clearHalt`.
    bool public halted;

    /// @notice Default per-trade cap on amountIn (input-token units). 0 = unset.
    uint256 public defaultMaxTradeIn;
    /// @notice Per-token per-trade cap overrides. 0 = fall back to default.
    mapping(address => uint256) public maxTradeInOverride;
    /// @notice Max cumulative daily notional, in quote-token units. 0 = unset.
    uint256 public dailyVolumeCapQuote;
    /// @notice Max cumulative daily realized loss, in quote-token units. 0 = unset.
    uint256 public dailyLossCapQuote;
    /// @notice Max allowed distance between router quote and amountOutMin.
    uint256 public maxSlippageBps;

    uint256 public dayIndex; // block.timestamp / 1 days at last roll
    uint256 public dayVolumeQuote; // traded notional today (quote units)
    int256 public dayRealizedPnlQuote; // realized PnL today (quote units)

    mapping(address => Position) public positions;

    bool private _locked; // reentrancy mutex

    // ------------------------------------------------------------------ events

    event TradeExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint24 feeTier,
        uint256 amountIn,
        uint256 amountOut,
        uint256 notionalQuote,
        int256 dayRealizedPnlQuote
    );
    event AgentUpdated(address indexed newAgent);
    event RouterUpdated(address indexed newRouter);
    event QuoterUpdated(address indexed newQuoter);
    event PausedSet(bool paused);
    event HaltCleared();
    event CapsUpdated(uint256 defaultMaxTradeIn, uint256 dailyVolumeCapQuote, uint256 dailyLossCapQuote, uint256 maxSlippageBps);
    event MaxTradeInOverrideSet(address indexed token, uint256 cap);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    // ------------------------------------------------------------------ errors

    error NotOwner();
    error NotAgent();
    error TradingPaused();
    error TradingHalted();
    error Reentrant();
    error ZeroAddress();
    error PairMustIncludeQuote();
    error SameToken();
    error ZeroAmount();
    error InvalidFeeTier();
    error CapsNotConfigured();
    error ExceedsTradeCap(uint256 amountIn, uint256 cap);
    error ExceedsDailyVolume(uint256 projected, uint256 cap);
    error ExceedsDailyLoss(int256 projectedPnl, int256 budgetFloor);
    error SlippageOutOfBounds(uint256 amountOutMin, uint256 quote);
    error InsufficientBalance(uint256 have, uint256 need);
    error NoQuote();

    // ------------------------------------------------------------------ modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    modifier nonReentrant() {
        if (_locked) revert Reentrant();
        _locked = true;
        _;
        _locked = false;
    }

    // ------------------------------------------------------------------ constructor

    constructor(address router_, address quoter_, address quoteToken_, address agent_) {
        if (router_ == address(0) || quoter_ == address(0) || quoteToken_ == address(0) || agent_ == address(0)) {
            revert ZeroAddress();
        }
        owner = msg.sender;
        router = ISwapRouter02Like(router_);
        quoter = IQuoterV2Like(quoter_);
        quoteToken = quoteToken_;
        agent = agent_;
        maxSlippageBps = 100; // 1% default; owner can change (0 disables the quote check)
        dayIndex = block.timestamp / 1 days;
    }

    // ------------------------------------------------------------------ trading

    /// @notice Execute one swap through the guard's risk rails. Agent only.
    /// @param tokenIn  Token sold by the guard. Must be `quoteToken` or paired against it.
    /// @param tokenOut Token bought by the guard. The other side of the pair.
    /// @param feeTier  V3 pool fee tier (100 / 500 / 3000 / 10000). Together
    ///        with the pair this identifies exactly one pool.
    /// @param amountIn Exact input amount (tokenIn units).
    /// @param amountOutMin Minimum acceptable output; doubles as the worst-case
    ///        bound for the loss and slippage checks.
    /// @return amountOut Actual output amount received by the guard.
    function executeSwap(
        address tokenIn,
        address tokenOut,
        uint24 feeTier,
        uint256 amountIn,
        uint256 amountOutMin
    ) external onlyAgent nonReentrant returns (uint256 amountOut) {
        if (paused) revert TradingPaused();
        if (halted) revert TradingHalted();
        if (amountIn == 0) revert ZeroAmount();
        if (feeTier == 0) revert InvalidFeeTier();
        if (tokenIn == tokenOut) revert SameToken();
        if (tokenIn != quoteToken && tokenOut != quoteToken) revert PairMustIncludeQuote();

        _rollDay();

        bool isBuy = tokenIn == quoteToken; // quote -> token
        _checkRails(tokenIn, tokenOut, feeTier, amountIn, amountOutMin, isBuy);
        amountOut = _swap(tokenIn, tokenOut, feeTier, amountIn, amountOutMin);

        // --- Accounting (actual executed amounts) ---
        uint256 notionalQuote;
        if (isBuy) {
            Position storage pos = positions[tokenOut];
            pos.amount += amountOut;
            pos.costQuote += amountIn;
            notionalQuote = amountIn;
        } else {
            uint256 costRemoved = _costRemoved(tokenIn, amountIn);
            Position storage pos = positions[tokenIn];
            uint256 accounted = amountIn < pos.amount ? amountIn : pos.amount;
            pos.amount -= accounted;
            pos.costQuote -= costRemoved;
            dayRealizedPnlQuote += int256(amountOut) - int256(costRemoved);
            notionalQuote = amountOut;
            // Belt-and-braces: the pre-trade check uses amountOutMin (the true
            // worst case), so this should be unreachable — latch the halt if
            // accounting ever disagrees.
            if (dayRealizedPnlQuote < -int256(dailyLossCapQuote)) {
                halted = true;
            }
        }
        dayVolumeQuote += notionalQuote;

        emit TradeExecuted(tokenIn, tokenOut, feeTier, amountIn, amountOut, notionalQuote, dayRealizedPnlQuote);
    }

    // ------------------------------------------------------------------ owner controls

    function setAgent(address newAgent) external onlyOwner {
        if (newAgent == address(0)) revert ZeroAddress();
        agent = newAgent;
        emit AgentUpdated(newAgent);
    }

    function setRouter(address newRouter) external onlyOwner {
        if (newRouter == address(0)) revert ZeroAddress();
        router = ISwapRouter02Like(newRouter);
        emit RouterUpdated(newRouter);
    }

    function setQuoter(address newQuoter) external onlyOwner {
        if (newQuoter == address(0)) revert ZeroAddress();
        quoter = IQuoterV2Like(newQuoter);
        emit QuoterUpdated(newQuoter);
    }

    /// @notice Kill-switch. Owner can pause/unpause at any time.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Clear the auto-halt latch after reviewing what happened.
    function clearHalt() external onlyOwner {
        halted = false;
        emit HaltCleared();
    }

    /// @notice Set the main risk parameters in one call. Any cap left at 0
    ///         keeps trading fail-closed for the rails that depend on it.
    function setRiskParams(
        uint256 defaultMaxTradeIn_,
        uint256 dailyVolumeCapQuote_,
        uint256 dailyLossCapQuote_,
        uint256 maxSlippageBps_
    ) external onlyOwner {
        if (maxSlippageBps_ > 10_000) revert SlippageOutOfBounds(0, 0);
        defaultMaxTradeIn = defaultMaxTradeIn_;
        dailyVolumeCapQuote = dailyVolumeCapQuote_;
        dailyLossCapQuote = dailyLossCapQuote_;
        maxSlippageBps = maxSlippageBps_;
        emit CapsUpdated(defaultMaxTradeIn_, dailyVolumeCapQuote_, dailyLossCapQuote_, maxSlippageBps_);
    }

    function setMaxTradeInOverride(address token, uint256 cap) external onlyOwner {
        maxTradeInOverride[token] = cap;
        emit MaxTradeInOverrideSet(token, cap);
    }

    /// @notice Recover funds. Owner only — the agent can never withdraw.
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (!IERC20(token).transfer(to, amount)) revert InsufficientBalance(0, amount);
        emit Withdrawn(token, to, amount);
    }

    // ------------------------------------------------------------------ views

    function effectiveMaxTradeIn(address token) public view returns (uint256) {
        uint256 overrideCap = maxTradeInOverride[token];
        return overrideCap != 0 ? overrideCap : defaultMaxTradeIn;
    }

    function getPosition(address token) external view returns (uint256 amount, uint256 costQuote) {
        Position storage pos = positions[token];
        return (pos.amount, pos.costQuote);
    }

    /// @notice Today's counters, with the lazy day-roll applied virtually.
    function dayStats() external view returns (uint256 volumeQuote, int256 realizedPnlQuote) {
        if (block.timestamp / 1 days != dayIndex) return (0, 0);
        return (dayVolumeQuote, dayRealizedPnlQuote);
    }

    // ------------------------------------------------------------------ internals

    /// @dev Rails 2–5, checked pre-trade. Reverts on any violation.
    ///      Not `view`: the slippage rail calls QuoterV2, whose quote
    ///      functions simulate the swap (see IQuoterV2Like). The simulation
    ///      never persists state — the quoter unwinds it internally.
    function _checkRails(
        address tokenIn,
        address tokenOut,
        uint24 feeTier,
        uint256 amountIn,
        uint256 amountOutMin,
        bool isBuy
    ) internal {
        // Rail 2: per-trade size cap (input-token units).
        uint256 cap = effectiveMaxTradeIn(tokenIn);
        if (cap == 0) revert CapsNotConfigured();
        if (amountIn > cap) revert ExceedsTradeCap(amountIn, cap);
        if (dailyVolumeCapQuote == 0 || dailyLossCapQuote == 0) revert CapsNotConfigured();

        // Rail 5: slippage vs the QuoterV2 quote for this exact pool.
        // A revert from the quoter (no such pool, no liquidity) is
        // fail-closed: no quote, no trade.
        uint256 quote;
        try quoter.quoteExactInputSingle(
            IQuoterV2Like.QuoteExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                amountIn: amountIn,
                fee: feeTier,
                sqrtPriceLimitX96: 0
            })
        ) returns (uint256 amountOut, uint160, uint32, uint256) {
            quote = amountOut;
        } catch {
            revert NoQuote();
        }
        if (quote == 0) revert NoQuote();
        if (amountOutMin > quote) revert SlippageOutOfBounds(amountOutMin, quote);
        if (maxSlippageBps > 0) {
            uint256 floorOut = (quote * (10_000 - maxSlippageBps)) / 10_000;
            if (amountOutMin < floorOut) revert SlippageOutOfBounds(amountOutMin, quote);
        }

        // Rail 3: daily volume, on the guaranteed notional.
        uint256 guaranteedNotional = isBuy ? amountIn : amountOutMin;
        if (dayVolumeQuote + guaranteedNotional > dailyVolumeCapQuote) {
            revert ExceedsDailyVolume(dayVolumeQuote + guaranteedNotional, dailyVolumeCapQuote);
        }

        // Rail 4: daily loss, worst case implied by amountOutMin (sells only —
        // buys cannot realize a loss).
        if (!isBuy) {
            int256 worstPnl = dayRealizedPnlQuote + int256(amountOutMin) - int256(_costRemoved(tokenIn, amountIn));
            if (worstPnl < -int256(dailyLossCapQuote)) {
                revert ExceedsDailyLoss(worstPnl, -int256(dailyLossCapQuote));
            }
        }
    }

    /// @dev Balance-checked SwapRouter02 call; returns the actual amount
    ///      received (measured by balance delta, not just the router's
    ///      return value, so fee-on-transfer tokens can't fool accounting).
    function _swap(address tokenIn, address tokenOut, uint24 feeTier, uint256 amountIn, uint256 amountOutMin)
        internal
        returns (uint256 amountOut)
    {
        uint256 balInBefore = IERC20(tokenIn).balanceOf(address(this));
        if (balInBefore < amountIn) revert InsufficientBalance(balInBefore, amountIn);
        uint256 balOutBefore = IERC20(tokenOut).balanceOf(address(this));

        _approveExact(tokenIn, address(router), amountIn);
        router.exactInputSingle(
            ISwapRouter02Like.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: feeTier,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );

        amountOut = IERC20(tokenOut).balanceOf(address(this)) - balOutBefore;
    }

    function _rollDay() internal {
        uint256 today = block.timestamp / 1 days;
        if (today != dayIndex) {
            dayIndex = today;
            dayVolumeQuote = 0;
            dayRealizedPnlQuote = 0;
        }
    }

    /// @dev Average-cost removal for selling `amountIn` of `token`: the share
    ///      of the position's cost basis attributable to the amount sold.
    ///      Tokens held beyond the tracked position (deposited directly)
    ///      carry zero cost basis.
    function _costRemoved(address token, uint256 amountIn) internal view returns (uint256) {
        Position storage pos = positions[token];
        if (pos.amount == 0) return 0;
        uint256 accounted = amountIn < pos.amount ? amountIn : pos.amount;
        return (pos.costQuote * accounted) / pos.amount;
    }

    function _approveExact(address token, address spender, uint256 amount) internal {
        if (IERC20(token).allowance(address(this), spender) != 0) {
            IERC20(token).approve(spender, 0);
        }
        IERC20(token).approve(spender, amount);
    }
}

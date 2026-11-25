// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal ERC-20 surface used by SentinelGuard.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Minimal Uniswap V3 SwapRouter02 surface used by SentinelGuard.
///
/// HSKSwap is a Uniswap V3 fork; its canonical router on both HashKey Chain
/// mainnet (177) and testnet (133) is SwapRouter02 (addresses verified in
/// ../../RESEARCH.md at the hackathon folder root). SwapRouter02 has NO
/// deadline parameter — that was SwapRouter01 — so the guard does not take
/// one either; staleness is bounded by the slippage rail (live QuoterV2
/// quote vs `amountOutMinimum`) checked in the same transaction.
interface ISwapRouter02Like {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    /// @dev Included for completeness; SentinelGuard deliberately trades
    ///      single-pool direct pairs only and does not call this.
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Minimal Uniswap V3 QuoterV2 surface used by SentinelGuard for the
///         slippage rail.
///
/// QuoterV2's quote functions are NOT view: the quoter simulates the swap
/// against the pool and reverts internally with the result, which it then
/// decodes and returns. Calling it on-chain (a plain CALL, never STATICCALL —
/// the pool writes state during the simulation, all of it unwound by the
/// internal revert) is safe but costs roughly a swap's worth of gas. If the
/// pool does not exist or has no liquidity, the call reverts, and the guard
/// treats that as fail-closed (no quote, no trade).
interface IQuoterV2Like {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (
            uint256 amountOut,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        );
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal ERC-20 surface used by SentinelGuard.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Minimal Uniswap V2-style router surface. **DEPRECATED (Phase 2).**
///
/// SentinelGuard no longer imports this file: Phase 2 retargeted the guard
/// to HSKSwap's actual deployment, a Uniswap *V3* fork, via
/// `ISwapRouter02Like.sol` (SwapRouter02 `exactInputSingle` + QuoterV2).
/// This file is retained for reference only — the Phase 1 scaffold was built
/// against it, and it documents what changed. Do not wire the guard back to
/// a V2 router unless a future phase deliberately deploys a V2-style AMM.
interface IUniswapV2RouterLike {
    function factory() external view returns (address);
    function WETH() external view returns (address);

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

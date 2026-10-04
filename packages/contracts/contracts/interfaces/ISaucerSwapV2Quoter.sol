// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title ISaucerSwapV2Quoter
 * @notice SaucerSwap V2 QuoterV2, used to price a claim before swapping.
 * @dev Hedera testnet: `0.0.1390002`. Hedera mainnet: `0.0.3949424`.
 *
 *      `quoteExactInput` is declared non-view because it simulates the swap, so it can
 *      revert (for example when the pool does not exist or has no liquidity). The vesting
 *      contract wraps it in `try/catch` and surfaces a dedicated error rather than
 *      letting a simulated failure bubble up as a bare revert.
 *
 *      Reference: https://docs.saucerswap.finance/developers/v2/swap/swap-quote
 */
interface ISaucerSwapV2Quoter {
    /**
     * @notice Prices a swap along `path` without executing it.
     * @param path Reversed route: `[outputToken(20), fee(3), inputToken(20), ...]`.
     * @param amountIn Input amount in the input token's smallest unit.
     * @return amountOut Output amount in the output token's smallest unit.
     * @return sqrtPriceX96AfterList Post-swap sqrt prices, one per pool in the route.
     * @return initializedTicksCrossedList Ticks crossed per pool in the route.
     * @return gasEstimate Gas the swap is expected to consume.
     */
    function quoteExactInput(
        bytes calldata path,
        uint256 amountIn
    )
        external
        returns (
            uint256 amountOut,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        );
}

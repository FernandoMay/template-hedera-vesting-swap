// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title MockSaucerSwapQuoter
 * @notice Stand-in for the SaucerSwap V2 QuoterV2 at `0.0.1390002` on Hedera testnet.
 * @dev Prices a two-token route at a fixed rate expressed in basis points, so a test can
 *      make the quote disagree with the router and drive the slippage guard.
 */
contract MockSaucerSwapQuoter {
    /// Multiplies the input amount to produce the quoted output.
    uint256 public rateBps;

    /// When true, every quote reverts, mirroring a route that does not exist.
    bool public quoteReverts;

    error RouteUnavailable();

    constructor(uint256 rateBps_) {
        rateBps = rateBps_;
    }

    function setRateBps(uint256 value) external {
        rateBps = value;
    }

    function setQuoteReverts(bool value) external {
        quoteReverts = value;
    }

    function quoteExactInput(
        bytes calldata,
        uint256 amountIn
    )
        external
        view
        returns (
            uint256 amountOut,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        )
    {
        if (quoteReverts) revert RouteUnavailable();
        amountOut = (amountIn * rateBps) / 10_000;
        sqrtPriceX96AfterList = new uint160[](1);
        initializedTicksCrossedList = new uint32[](1);
        gasEstimate = 250_000;
    }
}

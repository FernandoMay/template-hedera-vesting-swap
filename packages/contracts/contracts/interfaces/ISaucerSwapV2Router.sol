// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title ISaucerSwapV2Router
 * @notice The subset of the SaucerSwap V2 SwapRouter used to settle vesting claims in HBAR.
 * @dev Hedera testnet: `0.0.1414040`. Hedera mainnet: `0.0.3949434`.
 *
 *      Two behaviours in this interface drive the design of `StreamedVesting`:
 *
 *      1. `exactInput` takes a *reversed* path. The first token in `path` is the OUTPUT
 *         token, the last is the INPUT token. For a claim we stream `<grantToken>` into
 *         `<WHBAR>`, so the path reads `[WHBAR, fee, grantToken]`.
 *
 *      2. HBAR has no pool. SaucerSwap trades wrapped HBAR, so a token-to-HBAR swap ends
 *         with WHBAR sitting in the recipient. Passing the router itself as `recipient`
 *         and then calling `unwrapWHBAR` is the documented settlement path: the router
 *         burns the WHBAR it already holds and forwards native HBAR to the final
 *         recipient. Routing through the router means we never need an allowance to a
 *         separate WHBAR helper contract.
 *
 *      Reference: SaucerSwap V2 docs, "Swap Tokens for HBAR"
 */
interface ISaucerSwapV2Router {
    struct ExactInputParams {
        /// Encoded route: `[outputToken(20), fee(3), inputToken(20), ...]`, reversed.
        bytes path;
        /// Recipient of the output token. Must be the router when unwrapping to HBAR.
        address recipient;
        /// Unix-second deadline checked by the router.
        uint256 deadline;
        /// Exact input amount in the input token's smallest unit.
        uint256 amountIn;
        /// Floor for the output amount. Reverts the router if the swap yields less.
        uint256 amountOutMinimum;
    }

    /**
     * @notice Swaps an exact amount of the input token for as much of the output token as
     *         the route allows, subject to `amountOutMinimum`.
     */
    function exactInput(
        ExactInputParams calldata params
    ) external payable returns (uint256 amountOut);

    /**
     * @notice Burns WHBAR held by the router and sends the equivalent native HBAR to
     *         `recipient`.
     * @dev Only usable after `exactInput` left the WHBAR output in the router, which is
     *      why `exactInput.recipient` must be the router address.
     * @param minAmountOut Floor for the unwrapped amount. This template passes `0` because
     *        `exactInput.amountOutMinimum` already enforces the slippage bound on the
     *        exact amount the router is holding, and a second floor would depend on the
     *        WHBAR-to-HBAR unit convention rather than on anything this contract controls.
     * @param recipient Account that receives native HBAR.
     */
    function unwrapWHBAR(
        uint256 minAmountOut,
        address recipient
    ) external;
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IHederaTokenServiceApprove
 * @notice The allowance-related slice of the HTS system contract (`0x167`).
 * @dev Hedera native tokens are HTS entities, not Solidity contracts, so this is the
 *      authoritative way to grant a spender allowance. Like every HTS system contract
 *      entry point it never reverts: it returns a `ResponseCodeEnum` ordinal that must be
 *      compared against `SUCCESS` (22).
 *
 *      The ERC20-shaped `approve` selector also resolves on an HTS token, but it reverts
 *      instead of returning a code, which makes failures much harder to diagnose on chain.
 */
interface IHederaTokenServiceApprove {
    /**
     * @notice Grants `spender` an allowance of `amount` (smallest unit) over `token`.
     * @param token HTS token address.
     * @param spender Account allowed to move the tokens.
     * @param amount Allowance in the token's smallest unit. Overwrites any previous value.
     * @return responseCode `22` on success, otherwise a `ResponseCodeEnum` ordinal.
     */
    function approve(
        address token,
        address spender,
        uint256 amount
    ) external returns (int64 responseCode);

    /**
     * @notice Reads the remaining allowance.
     * @return responseCode `22` on success, otherwise a `ResponseCodeEnum` ordinal.
     * @return allowance Remaining allowance in the token's smallest unit.
     */
    function allowance(
        address token,
        address owner,
        address spender
    ) external returns (int64 responseCode, uint256 allowance);
}

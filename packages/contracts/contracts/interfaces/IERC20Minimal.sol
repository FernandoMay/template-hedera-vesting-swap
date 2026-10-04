// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IERC20Minimal
 * @notice The ERC20 surface that Hedera native (HTS) tokens implement.
 * @dev Verified on Hedera testnet: the SAUCE token at `0.0.1183558` resolves the
 *      `balanceOf`, `decimals`, `approve`, `transfer` and `transferFrom` selectors. Callers
 *      must still check the returned `bool`, because HTS tokens revert rather than return
 *      `false` on some failure paths.
 */
interface IERC20Minimal {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function totalSupply() external view returns (uint256);

    function balanceOf(address account) external view returns (uint256);

    function decimals() external view returns (uint8);

    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);

    function approve(address spender, uint256 amount) external returns (bool);

    function allowance(
        address owner,
        address spender
    ) external view returns (uint256);
}

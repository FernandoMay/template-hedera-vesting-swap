// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20Minimal} from "../interfaces/IERC20Minimal.sol";
import {MockERC20} from "./MockERC20.sol";

/**
 * @title MockHtsApprove
 * @notice Stand-in for the HTS system contract allowance surface at `0x167`.
 * @dev Its whole reason to exist is to reproduce the behaviour that trips people up on a
 *      real network: `approve` never reverts, it returns `22` for success and a
 *      `ResponseCodeEnum` ordinal for every failure. `approveReverts` lets a test force the
 *      failure branch, and `failNextApprove` makes exactly one call fail so a test can
 *      observe the retry-free error path.
 */
contract MockHtsApprove {
    /// Mirrors `ResponseCodeEnum.SUCCESS`.
    int64 public constant SUCCESS = 22;

    /// Mirrors `ResponseCodeEnum.INVALID_ALLOWANCE_OWNER`.
    int64 public constant FAILURE_CODE = 333;

    error UnexpectedToken();

    bool public failNextApprove;

    function setFailNextApprove(bool value) external {
        failNextApprove = value;
    }

    /**
     * @notice Grants `spender` an allowance of `amount` over `token`, owned by the caller.
     * @dev The allowance is recorded against `msg.sender`, not against this contract. That
     *      is the behaviour a real ledger exhibits when a contract asks HTS for an
     *      allowance, and getting it wrong makes the swap fail on a missing allowance.
     */
    function approve(
        address token,
        address spender,
        uint256 amount
    ) external returns (int64 responseCode) {
        if (failNextApprove) {
            failNextApprove = false;
            return FAILURE_CODE;
        }
        MockERC20(token).setAllowanceBySystem(msg.sender, spender, amount);
        return SUCCESS;
    }

    function allowance(
        address token,
        address owner,
        address spender
    ) external view returns (int64 responseCode, uint256 remaining) {
        remaining = IERC20Minimal(token).allowance(owner, spender);
        responseCode = SUCCESS;
    }
}

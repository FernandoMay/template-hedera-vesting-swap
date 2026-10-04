// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20Minimal} from "../interfaces/IERC20Minimal.sol";
import {ISaucerSwapV2Router} from "../interfaces/ISaucerSwapV2Router.sol";

/**
 * @title MockSaucerSwapRouter
 * @notice Stand-in for the SaucerSwap V2 SwapRouter at `0.0.1414040` on Hedera testnet.
 * @dev Reproduces the three router behaviours the vesting contract depends on:
 *
 *      - `exactInput` pulls the input token from `msg.sender` using the allowance granted to
 *        the router, which is why the vesting contract must approve before swapping
 *      - `exactInput` credits the output token to `params.recipient`, and when that
 *        recipient is the router itself, the WHBAR stays put ready for `unwrapWHBAR`
 *      - `unwrapWHBAR` converts router-held WHBAR into native HBAR for a final recipient,
 *        at a one-to-one rate because the WHBAR token has eight decimals like tinybars
 *      - `exactInput` rejects a deadline that has already passed, and refuses to pull the
 *        input token when the router is not associated to it, which is how the ledger
 *        reports `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`
 *
 *      Pool reserves are tracked separately from the swap output. The real router custodies
 *      only what the swap just delivered, so `unwrapWHBAR` burns `unwrapReserve` rather than
 *      the router's whole token balance; otherwise a funded router would drain its own
 *      liquidity on the first claim.
 */
contract MockSaucerSwapRouter is ISaucerSwapV2Router {
    address public immutable tokenIn;
    address public immutable tokenOut;
    uint256 public rateBps;

    /// When true, `exactInput` reverts, mirroring a pool with no liquidity.
    bool public swapReverts;

    /**
     * @dev When false, the router behaves as if it were not associated to `tokenIn`, which
     *      is what makes the ledger refuse the transfer on a real network.
     */
    bool public inputTokenAssociated = true;

    /// @dev When true, every `exactInput` is treated as having arrived past its deadline.
    bool public forceExpiredDeadline;

    /// Mirrors `ResponseCodeEnum.TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`.
    int64 public constant TOKEN_NOT_ASSOCIATED_TO_ACCOUNT = 232;

    error InsufficientOutputAmount(uint256 amountOut, uint256 amountOutMinimum);
    error PoolHasNoLiquidity();
    error NothingToUnwrap();
    error BelowUnwrapFloor(uint256 available, uint256 required);
    error NativeTransferFailed();
    error NotWhbarHolder();
    error DeadlineExceeded(uint256 deadline, uint256 consensusSecond);
    error TokenNotAssociatedToAccount(address token, address account);

    event Swapped(
        address indexed caller,
        address indexed recipient,
        uint256 amountIn,
        uint256 amountOut
    );
    event Unwrapped(address indexed recipient, uint256 amount);

    uint256 public swapCount;
    uint256 public unwrapCount;
    uint256 public lastAmountIn;
    uint256 public lastAmountOut;
    uint256 public lastHbarDelivered;

    /// Arguments of the most recent accepted swap, used by assertions.
    bytes public lastPath;
    uint256 public lastDeadline;
    address public lastRecipient;
    uint256 public lastAmountOutMinimum;

    /// Account the most recent accepted swap pulled from.
    address public lastCaller;

    /**
     * @dev Allowance the router saw on the input token when it pulled, which proves the
     *      allowance was recorded against `msg.sender` rather than against the token.
     */
    uint256 public lastAllowanceAtSwap;

    /// WHBAR delivered by swaps addressed to this router and not yet unwrapped.
    uint256 public unwrapReserve;

    constructor(
        address tokenIn_,
        address tokenOut_,
        uint256 rateBps_
    ) {
        tokenIn = tokenIn_;
        tokenOut = tokenOut_;
        rateBps = rateBps_;
    }

    function setSwapReverts(bool value) external {
        swapReverts = value;
    }

    function setInputTokenAssociated(bool value) external {
        inputTokenAssociated = value;
    }

    function setForceExpiredDeadline(bool value) external {
        forceExpiredDeadline = value;
    }

    /**
     * @notice Re-prices the pool, so a test can make the router fill worse than the quote
     *         the vesting contract relied on.
     */
    function setRateBps(uint256 value) external {
        rateBps = value;
    }

    function exactInput(
        ExactInputParams calldata params
    ) external payable returns (uint256 amountOut) {
        if (swapReverts) revert PoolHasNoLiquidity();

        uint256 observedDeadline = forceExpiredDeadline
            ? block.timestamp - 1
            : params.deadline;
        if (observedDeadline < block.timestamp) {
            revert DeadlineExceeded(observedDeadline, block.timestamp);
        }

        // A Hedera account cannot move an HTS token until it is associated to that token,
        // and the ledger reports the refusal rather than the token reporting a false.
        if (!inputTokenAssociated) {
            revert TokenNotAssociatedToAccount(tokenIn, msg.sender);
        }

        uint256 allowed = IERC20Minimal(tokenIn).allowance(
            msg.sender,
            address(this)
        );
        if (allowed < params.amountIn) {
            revert InsufficientOutputAmount(0, params.amountOutMinimum);
        }

        bool pulled = IERC20Minimal(tokenIn).transferFrom(
            msg.sender,
            address(this),
            params.amountIn
        );
        if (!pulled) revert PoolHasNoLiquidity();

        amountOut = (params.amountIn * rateBps) / 10_000;
        if (amountOut < params.amountOutMinimum) {
            revert InsufficientOutputAmount(amountOut, params.amountOutMinimum);
        }

        bool paid = IERC20Minimal(tokenOut).transfer(
            params.recipient,
            amountOut
        );
        if (!paid) revert PoolHasNoLiquidity();

        swapCount += 1;
        lastAmountIn = params.amountIn;
        lastAmountOut = amountOut;
        lastPath = params.path;
        lastDeadline = params.deadline;
        lastRecipient = params.recipient;
        lastAmountOutMinimum = params.amountOutMinimum;
        lastCaller = msg.sender;
        lastAllowanceAtSwap = allowed;
        if (params.recipient == address(this)) {
            unwrapReserve += amountOut;
        }
        emit Swapped(msg.sender, params.recipient, params.amountIn, amountOut);
    }

    function unwrapWHBAR(
        uint256 minAmountOut,
        address recipient
    ) external {
        // Only the amount the swap just delivered is unwrappable. Reserve liquidity backing
        // the pools stays put, exactly as it does on the real router.
        uint256 held = unwrapReserve;
        if (held == 0) revert NothingToUnwrap();
        if (held < minAmountOut) revert BelowUnwrapFloor(held, minAmountOut);
        unwrapReserve = 0;

        // Mirror the real WHBAR contract: burn the wrapper token, return native HBAR.
        bool burned = IERC20Minimal(tokenOut).transfer(
            address(0xdead),
            held
        );
        if (!burned) revert NotWhbarHolder();

        (bool sent, ) = payable(recipient).call{ value: held }("");
        if (!sent) revert NativeTransferFailed();

        unwrapCount += 1;
        lastHbarDelivered = held;
        emit Unwrapped(recipient, held);
    }

    /// @notice Lets a test fund the router so it can pay out HBAR on unwrap.
    receive() external payable { }
}

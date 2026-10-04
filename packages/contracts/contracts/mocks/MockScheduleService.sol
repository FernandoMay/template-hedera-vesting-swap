// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IHederaScheduleService} from "../interfaces/IHederaScheduleService.sol";

/**
 * @title MockScheduleService
 * @notice Reproduces the HSS system contract at `0x16b` closely enough to test the parts
 *         of HIP-1215 that are easy to get wrong.
 * @dev The behaviours under test are:
 *
 *      - calls never revert; failures come back as a `ResponseCodeEnum` ordinal
 *      - a consensus second has a finite gas budget, and exceeding it yields
 *        `SCHEDULE_EXPIRY_IS_BUSY`
 *      - the expiry second must be strictly later than the current consensus second
 *      - `executeDue()` lets a test prove a release fired with no bot and no relayer,
 *        which is the whole point of the template
 *
 *      Ordinals are copied from the Hedera `response_code.proto`, so assertions in the test
 *      suite use the same numbers a real network would report.
 */
contract MockScheduleService is IHederaScheduleService {
    /// Mirrors `ResponseCodeEnum.SUCCESS`.
    int64 public constant SUCCESS = 22;

    /// Mirrors `ResponseCodeEnum.SCHEDULE_EXPIRY_IS_BUSY`.
    int64 public constant SCHEDULE_EXPIRY_IS_BUSY = 370;

    /// Mirrors `ResponseCodeEnum.INVALID_EXPIRATION_TIME`.
    int64 public constant INVALID_EXPIRATION_TIME = 45;

    /// Mirrors `ResponseCodeEnum.INVALID_SCHEDULE_ID`.
    int64 public constant INVALID_SCHEDULE_ID = 201;

    /// Mirrors `ResponseCodeEnum.SCHEDULE_ALREADY_EXECUTED`.
    int64 public constant SCHEDULE_ALREADY_EXECUTED = 213;

    struct ScheduledCall {
        address target;
        uint256 expirySecond;
        uint256 gasLimit;
        uint64 value;
        bytes callData;
        bool executed;
        bool deleted;
    }

    /// Gas budget available per consensus second.
    uint256 public gasCapacityPerSecond;

    /// Gas already reserved per consensus second.
    mapping(uint256 => uint256) public reservedGas;

    /**
     * @dev Response code `scheduleCall` reports instead of behaving normally, or `0` to
     *      behave normally. Lets a test prove the caller inspects the returned code even
     *      when `hasScheduleCapacity` said the second was free.
     */
    int64 public forcedResponseCode;

    /// @dev When true, `scheduleCall` reports `forcedResponseCode` with a zero address.
    bool public forcedZeroAddress;

    /// Consensus seconds this mock will accept. `0` disables the upper bound.
    uint256 public maxFutureSeconds;

    mapping(address => ScheduledCall) private _calls;
    address[] private _callLog;

    uint256 public createdCount;
    uint256 public deletedCount;

    event ScheduleCreatedMock(
        address indexed scheduleAddress,
        address indexed target,
        uint256 expirySecond,
        uint256 gasLimit
    );
    event ScheduleDeletedMock(address indexed scheduleAddress);
    event ScheduleExecutedMock(
        address indexed scheduleAddress,
        bool success,
        bytes returnData
    );

    constructor(uint256 gasCapacityPerSecond_, uint256 maxFutureSeconds_) {
        gasCapacityPerSecond = gasCapacityPerSecond_;
        maxFutureSeconds = maxFutureSeconds_;
    }

    // ---------------------------------------------------------------------
    // IHederaScheduleService
    // ---------------------------------------------------------------------

    function hasScheduleCapacity(
        uint256 expirySecond,
        uint256 gasLimit
    ) external view returns (bool) {
        if (!_isValidExpiry(expirySecond, gasLimit)) return false;
        return reservedGas[expirySecond] + gasLimit <= gasCapacityPerSecond;
    }

    function scheduleCall(
        address to,
        uint256 expirySecond,
        uint256 gasLimit,
        uint64 value,
        bytes calldata callData
    ) external returns (int64 responseCode, address scheduleAddress) {
        if (forcedResponseCode != 0) {
            return (
                forcedResponseCode,
                forcedZeroAddress ? address(0) : address(uint160(0x6000 + (++createdCount)))
            );
        }
        if (!_isValidExpiry(expirySecond, gasLimit)) {
            return (INVALID_EXPIRATION_TIME, address(0));
        }
        if (reservedGas[expirySecond] + gasLimit > gasCapacityPerSecond) {
            return (SCHEDULE_EXPIRY_IS_BUSY, address(0));
        }

        reservedGas[expirySecond] += gasLimit;
        scheduleAddress = address(
            uint160(0x5000 + (++createdCount))
        );

        _calls[scheduleAddress] = ScheduledCall({
            target: to,
            expirySecond: expirySecond,
            gasLimit: gasLimit,
            value: value,
            callData: callData,
            executed: false,
            deleted: false
        });
        _callLog.push(scheduleAddress);

        emit ScheduleCreatedMock(scheduleAddress, to, expirySecond, gasLimit);
        return (SUCCESS, scheduleAddress);
    }

    function scheduleCallWithPayer(
        address,
        address,
        uint256,
        uint256,
        uint64,
        bytes calldata
    ) external pure returns (int64 responseCode, address scheduleAddress) {
        // Not exercised by this template. Returning a code rather than reverting keeps the
        // mock faithful to the real system contract.
        responseCode = SCHEDULE_EXPIRY_IS_BUSY;
        scheduleAddress = address(0);
    }

    function executeCallOnPayerSignature(
        address,
        address,
        uint256,
        uint256,
        uint64,
        bytes calldata
    ) external pure returns (int64 responseCode, address scheduleAddress) {
        responseCode = SCHEDULE_EXPIRY_IS_BUSY;
        scheduleAddress = address(0);
    }

    function deleteSchedule(
        address scheduleAddress
    ) external returns (int64 responseCode) {
        ScheduledCall storage entry = _calls[scheduleAddress];
        if (scheduleAddress == address(0) || entry.executed) {
            return INVALID_SCHEDULE_ID;
        }
        reservedGas[entry.expirySecond] -= entry.gasLimit;
        entry.deleted = true;
        deletedCount += 1;
        emit ScheduleDeletedMock(scheduleAddress);
        return SUCCESS;
    }

    // ---------------------------------------------------------------------
    // Test control surface
    // ---------------------------------------------------------------------

    /**
     * @notice Executes every schedule whose expiry second has arrived.
     * @dev On a real network this work is done by the network itself. Here it stands in for
     *      consensus so a test can prove the vesting contract's releases fire unattended.
     * @return executed How many schedules were executed.
     */
    function executeDue() external returns (uint256 executed) {
        for (uint256 i = 0; i < _callLog.length; ++i) {
            address scheduleAddress = _callLog[i];
            ScheduledCall storage entry = _calls[scheduleAddress];
            if (entry.executed || entry.deleted) continue;
            if (entry.expirySecond > block.timestamp) continue;

            entry.executed = true;
            (bool success, bytes memory returnData) = entry.target.call{
                value: entry.value,
                gas: entry.gasLimit
            }(entry.callData);

            emit ScheduleExecutedMock(scheduleAddress, success, returnData);
            if (success) executed += 1;
        }
    }

    /// @notice Reads a stored schedule, used by assertions.
    function getCall(
        address scheduleAddress
    )
        external
        view
        returns (
            address target,
            uint256 expirySecond,
            uint256 gasLimit,
            uint64 value,
            bytes memory callData,
            bool executed,
            bool deleted
        )
    {
        ScheduledCall storage entry = _calls[scheduleAddress];
        return (
            entry.target,
            entry.expirySecond,
            entry.gasLimit,
            entry.value,
            entry.callData,
            entry.executed,
            entry.deleted
        );
    }

    /// @notice Number of schedules created so far.
    function callCount() external view returns (uint256) {
        return _callLog.length;
    }

    /// @notice Address of the schedule at `index` in creation order.
    function callAt(uint256 index) external view returns (address) {
        return _callLog[index];
    }

    /// @notice Overrides the per-second gas budget so throttling can be exercised.
    function setGasCapacityPerSecond(uint256 value) external {
        gasCapacityPerSecond = value;
    }

    /**
     * @notice Makes every subsequent `scheduleCall` report `code` instead of scheduling.
     * @dev Models the failure mode `hasScheduleCapacity` cannot predict: the second looked
     *      free and the network still refused the call. `zeroAddress` selects whether the
     *      refusal carries a zero schedule address or a plausible one, because the caller
     *      has to reject both shapes.
     */
    function setForcedScheduleCallResponse(int64 code, bool zeroAddress) external {
        forcedResponseCode = code;
        forcedZeroAddress = zeroAddress;
    }

    function _isValidExpiry(
        uint256 expirySecond,
        uint256 gasLimit
    ) private view returns (bool) {
        if (gasLimit == 0) return false;
        // HSS requires the expiry second to be strictly later than the current consensus
        // second, so that a contract cannot loop on itself within a single second.
        if (expirySecond <= block.timestamp) return false;
        if (maxFutureSeconds != 0 && expirySecond > block.timestamp + maxFutureSeconds) {
            return false;
        }
        return true;
    }
}

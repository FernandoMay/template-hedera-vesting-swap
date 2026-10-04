// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IHederaScheduleService
 * @notice The Hedera Schedule Service (HSS) system contract, exposed on every Hedera
 *         network at the reserved EVM address `0x16b`.
 * @dev HIP-1215 "Generalized Scheduled Contract Calls" (status Final, shipped in v0.68.0).
 *
 *      READ THIS BEFORE CALLING ANY FUNCTION HERE:
 *
 *      None of these functions revert. On failure they return a failure `int64` whose value
 *      is the protobuf ordinal of a `ResponseCodeEnum` member and `address(0)` for the
 *      schedule address. On success they return `(22, scheduleAddress)`, where `22` is
 *      `SUCCESS`. Any integration that wraps these calls in a `require` on the returned
 *      address is broken, because the call itself will always appear to succeed.
 *
 *      Reference: HIP-1215 "Generalized Scheduled Contract Calls",
 *      https://hips.hedera.com/hip/hip-1215
 *      Address:  Hedera docs, "System Smart Contracts",
 *      https://docs.hedera.com/hedera/core-concepts/smart-contracts/system-smart-contracts
 */
interface IHederaScheduleService {
    /**
     * @notice Creates a schedule that calls `to` with `callData` at `expirySecond`.
     * @dev `expirySecond` must be strictly later than the current consensus second. The
     *      current consensus second is the EVM `block.timestamp`.
     * @param to Contract to call. Must not be the zero address; contract *creation* is out
     *        of scope for HIP-1215 and yields `INVALID_CONTRACT_ID`.
     * @param expirySecond Consensus second at which the call becomes executable.
     * @param gasLimit Gas the scheduled call may consume.
     * @param value Tinybars forwarded with the scheduled call. `0` for self-calls.
     * @param callData ABI-encoded calldata.
     * @return responseCode `22` on success, otherwise a `ResponseCodeEnum` ordinal.
     * @return scheduleAddress Address of the new schedule, or `address(0)` on failure.
     */
    function scheduleCall(
        address to,
        uint256 expirySecond,
        uint256 gasLimit,
        uint64 value,
        bytes calldata callData
    ) external returns (int64 responseCode, address scheduleAddress);

    /**
     * @notice Like `scheduleCall`, but the scheduled call only executes once the `payer`
     *         account has supplied valid signatures.
     * @dev Still waits for `expirySecond` to arrive, unlike `executeCallOnPayerSignature`.
     */
    function scheduleCallWithPayer(
        address to,
        address payer,
        uint256 expirySecond,
        uint256 gasLimit,
        uint64 value,
        bytes calldata callData
    ) external returns (int64 responseCode, address scheduleAddress);

    /**
     * @notice Creates a schedule that executes as soon as the `payer` signs, provided
     *         consensus time has not already passed `expirySecond`.
     */
    function executeCallOnPayerSignature(
        address to,
        address payer,
        uint256 expirySecond,
        uint256 gasLimit,
        uint64 value,
        bytes calldata callData
    ) external returns (int64 responseCode, address scheduleAddress);

    /**
     * @notice Deletes an existing schedule.
     * @return responseCode `22` when the delete succeeds.
     */
    function deleteSchedule(
        address scheduleAddress
    ) external returns (int64 responseCode);

    /**
     * @notice Reports whether `expirySecond` still has room for a scheduled call of
     *         `gasLimit`.
     * @dev Costs roughly a cold `SLOAD`, so it is cheap enough to probe repeatedly. When
     *      this returns `true`, a subsequent valid `scheduleCall` for the same second is
     *      guaranteed to succeed. Returns `false` when the arguments are invalid, including
     *      when `expirySecond` is not after the current consensus second or is too far ahead.
     */
    function hasScheduleCapacity(
        uint256 expirySecond,
        uint256 gasLimit
    ) external view returns (bool);
}

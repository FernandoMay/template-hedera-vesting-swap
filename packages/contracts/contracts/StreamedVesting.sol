// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";
import {IHederaScheduleService} from "./interfaces/IHederaScheduleService.sol";
import {IHederaTokenServiceApprove} from "./interfaces/IHederaTokenServiceApprove.sol";
import {ISaucerSwapV2Quoter} from "./interfaces/ISaucerSwapV2Quoter.sol";
import {ISaucerSwapV2Router} from "./interfaces/ISaucerSwapV2Router.sol";
import {VestingMath} from "./libraries/VestingMath.sol";

/**
 * @title StreamedVesting
 * @notice A vesting stream that pays the beneficiary in native HBAR with no off-chain bot,
 *         relayer, or cron job anywhere in the loop.
 * @dev Two Hedera services compose here, and both are load-bearing:
 *
 *      **HIP-1215 generalized scheduled contract calls.** At grant time the contract calls
 *      the Schedule Service system contract (`0x16b`) once per release, asking it to call
 *      back into `executeClaim` at a future consensus second. When that second arrives the
 *      network performs the call. Nobody is watching a clock.
 *
 *      **SaucerSwap V2.** Every claim settles through the V2 SwapRouter: the vested HTS
 *      tokens are swapped into wrapped HBAR and then unwrapped, so the beneficiary receives
 *      native HBAR and has no way to redirect the payout into another asset. Removing the
 *      swap removes the product.
 *
 *      ## Why this contract never assumes a revert
 *
 *      The Schedule Service does not revert. A saturated second comes back as
 *      `(370, address(0))`, where `370` is the ordinal of `SCHEDULE_EXPIRY_IS_BUSY` in the
 *      Hedera `response_code.proto`. The HTS allowance call behaves the same way and
 *      returns `22` or an error ordinal. Both are checked as values here. A schedule that
 *      cannot be created is reported through an event and the stream continues, because
 *      `executeClaim` is permissionless and safe for anyone to call once tokens are vested.
 *
 *      ## Permissionless execution, on purpose
 *
 *      `executeClaim` pays only the difference between what is vested at the current
 *      consensus second and what has already been paid out, so calling it early pays
 *      nothing, calling it late pays the same amount, and calling it twice in the same
 *      second pays once. Front-running an execution cannot redirect funds: the HBAR always
 *      goes to the recorded beneficiary, and the swap is protected by a quoted
 *      `amountOutMinimum`. That is what makes the contract survive a lost schedule.
 */
contract StreamedVesting {
    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @dev Mirrors `ResponseCodeEnum.SUCCESS`. Every Hedera system contract reports this.
    int64 private constant HEDERA_SUCCESS = 22;

    /// @dev Mirrors `ResponseCodeEnum.SCHEDULE_EXPIRY_IS_BUSY`.
    int64 private constant SCHEDULE_EXPIRY_IS_BUSY = 370;

    /// @dev Seconds of headroom given to the router's swap deadline.
    uint256 private constant SWAP_DEADLINE_BUFFER = 300;

    /// @dev Upper bound on backoff probes when a release second is saturated.
    uint256 private constant MAX_SCHEDULE_PROBES = 8;

    /// @dev Basis-point denominator for slippage and quoting maths.
    uint256 private constant BPS_DENOMINATOR = 10_000;

    // ---------------------------------------------------------------------
    // Immutable configuration
    // ---------------------------------------------------------------------

    /// @notice Hedera Schedule Service system contract. `0x16b` on every Hedera network.
    address public immutable scheduleService;

    /// @notice Hedera Token Service system contract. `0x167` on every Hedera network.
    address public immutable tokenService;

    /// @notice SaucerSwap V2 SwapRouter.
    address public immutable swapRouter;

    /// @notice SaucerSwap V2 QuoterV2, used to bound swap slippage.
    address public immutable quoter;

    /// @notice SaucerSwap WHBAR HTS token, the swap output that becomes native HBAR.
    address public immutable wrappedHbar;

    /// @notice Pool fee tier used to build the swap route, e.g. `3000` for 0.30%.
    uint24 public immutable poolFee;

    /// @notice Gas budget reserved for each scheduled release.
    uint256 public immutable releaseGasLimit;

    // ---------------------------------------------------------------------
    // Mutable configuration
    // ---------------------------------------------------------------------

    /// @notice Administrator. May retune slippage, revoke any schedule, or hand over.
    address public owner;

    /// @notice Maximum slippage tolerated between the quote and the swap, in basis points.
    uint16 public maxSlippageBps;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    struct Schedule {
        address grantor;
        address beneficiary;
        address grantToken;
        uint128 total;
        uint128 claimed;
        uint64 startTime;
        uint64 cliffTime;
        uint64 endTime;
        uint64 interval;
        uint32 releaseCount;
        uint32 scheduledCount;
        bool revoked;
    }

    /// @notice Snapshot used by the dashboard and by callers deciding whether to execute.
    struct Status {
        address grantor;
        address beneficiary;
        address grantToken;
        uint256 total;
        uint256 vested;
        uint256 claimed;
        uint256 claimable;
        uint256 startTime;
        uint256 cliffTime;
        uint256 endTime;
        uint256 interval;
        uint256 nextReleaseSecond;
        uint32 releaseCount;
        uint32 scheduledCount;
        bool revoked;
        bool cliffReached;
    }

    mapping(uint256 => Schedule) private _schedules;
    mapping(uint256 => mapping(uint256 => address)) private _releaseSchedules;
    uint256[] private _scheduleIds;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event ScheduleCreated(
        uint256 indexed scheduleId,
        address indexed grantor,
        address indexed beneficiary,
        address grantToken,
        uint256 total,
        uint256 startTime,
        uint256 cliffTime,
        uint256 endTime,
        uint32 releaseCount
    );
    event ReleaseScheduled(
        uint256 indexed scheduleId,
        uint256 indexed index,
        uint256 expirySecond,
        address scheduleAddress
    );
    event ReleaseScheduleRejected(
        uint256 indexed scheduleId,
        uint256 indexed index,
        uint256 requestedSecond,
        int64 responseCode
    );
    event ReleaseScheduleCancelled(
        uint256 indexed scheduleId,
        uint256 indexed index,
        address scheduleAddress,
        int64 responseCode
    );
    event ClaimExecuted(
        uint256 indexed scheduleId,
        address indexed caller,
        address indexed beneficiary,
        address grantToken,
        uint256 amountConverted,
        uint256 vestedTotal,
        uint256 hbarDelivered
    );
    event ScheduleRevoked(
        uint256 indexed scheduleId,
        address indexed grantor,
        uint256 unvestedReturned
    );
    event MaxSlippageUpdated(uint16 previousBps, uint16 newBps);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner(address caller);
    error ZeroAddress();
    error ZeroAmount();
    error ZeroInterval();
    error ZeroReleaseCount();
    error InvalidSlippage();
    error UnknownSchedule(uint256 scheduleId);
    error CliffNotReached(
        uint256 scheduleId,
        uint256 cliffTime,
        uint256 consensusSecond
    );
    error NothingNewlyVested(uint256 scheduleId);
    error ScheduleIsRevoked(uint256 scheduleId);
    error AlreadyRevoked(uint256 scheduleId);
    error NotScheduleAuthority(uint256 scheduleId, address caller);
    error TokenPullFailed(address grantToken, uint256 amount);
    error TokenReturnFailed(address grantToken, uint256 amount);
    error TokenApprovalFailed(address grantToken, int64 responseCode);
    error SwapQuoteFailed(address grantToken, uint256 amountIn);
    error SwapQuoteZero(address grantToken, uint256 amountIn);
    error AmountExceedsUint128(uint256 total);

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    /**
     * @notice Binds the contract to one Hedera network and one SaucerSwap route.
     * @dev Every address arrives as a parameter instead of being baked in as a literal.
     *      That is what lets the test suite swap in test doubles for HSS, HTS, and
     *      SaucerSwap, and it also means switching networks is a deployment concern rather
     *      than a recompile.
     * @param owner_ Account allowed to retune slippage, revoke any stream, or hand over.
     * @param scheduleService_ Hedera Schedule Service system contract, `0x16b`.
     * @param tokenService_ Hedera Token Service system contract, `0x167`.
     * @param swapRouter_ SaucerSwap V2 SwapRouter.
     * @param quoter_ SaucerSwap V2 QuoterV2.
     * @param wrappedHbar_ SaucerSwap WHBAR HTS token, the swap output that becomes HBAR.
     * @param poolFee_ Pool fee tier for the route, e.g. `3000` for 0.30%.
     * @param releaseGasLimit_ Gas budget reserved for each scheduled release.
     * @param maxSlippageBps_ Slippage tolerance between quote and swap, in basis points.
     */
    constructor(
        address owner_,
        address scheduleService_,
        address tokenService_,
        address swapRouter_,
        address quoter_,
        address wrappedHbar_,
        uint24 poolFee_,
        uint256 releaseGasLimit_,
        uint16 maxSlippageBps_
    ) {
        if (owner_ == address(0)) revert ZeroAddress();
        if (scheduleService_ == address(0)) revert ZeroAddress();
        if (tokenService_ == address(0)) revert ZeroAddress();
        if (swapRouter_ == address(0)) revert ZeroAddress();
        if (quoter_ == address(0)) revert ZeroAddress();
        if (wrappedHbar_ == address(0)) revert ZeroAddress();
        if (poolFee_ == 0) revert ZeroAmount();
        if (releaseGasLimit_ == 0) revert ZeroAmount();
        if (maxSlippageBps_ >= BPS_DENOMINATOR) revert InvalidSlippage();

        owner = owner_;
        scheduleService = scheduleService_;
        tokenService = tokenService_;
        swapRouter = swapRouter_;
        quoter = quoter_;
        wrappedHbar = wrappedHbar_;
        poolFee = poolFee_;
        releaseGasLimit = releaseGasLimit_;
        maxSlippageBps = maxSlippageBps_;
    }

    // ---------------------------------------------------------------------
    // Creation
    // ---------------------------------------------------------------------

    /**
     * @notice Creates a vesting stream and asks the Schedule Service to execute every
     *         release without further involvement.
     * @dev Callable by anyone, because the tokens come from `msg.sender` and the beneficiary
     *      can only gain. Administrative actions are gated separately by `owner`.
     * @param beneficiary Account that receives HBAR as tokens vest. Must be associated to
     *        nothing in particular for HBAR, which needs no association.
     * @param grantToken HTS token to stream. Must have a SaucerSwap V2 pool against WHBAR at
     *        `poolFee`, or every claim will fail on the swap.
     * @param total Total grant in the token's smallest unit. Must fit a `uint128`.
     * @param cliffDelay Seconds from now until the first release.
     * @param interval Seconds between consecutive releases.
     * @param releaseCount Number of releases, at least one.
     * @return scheduleId Identifier of the new schedule.
     */
    function createVesting(
        address beneficiary,
        address grantToken,
        uint256 total,
        uint64 cliffDelay,
        uint64 interval,
        uint32 releaseCount
    ) external returns (uint256 scheduleId) {
        if (beneficiary == address(0)) revert ZeroAddress();
        if (grantToken == address(0)) revert ZeroAddress();
        if (total == 0) revert ZeroAmount();
        if (interval == 0) revert ZeroInterval();
        if (releaseCount == 0) revert ZeroReleaseCount();
        // `total` is stored as a `uint128`. An explicit downcast truncates instead of
        // reverting, so an oversized grant would pull the full amount and then record a
        // truncated one, stranding the difference in this contract forever.
        if (total > type(uint128).max) revert AmountExceedsUint128(total);

        scheduleId = _scheduleIds.length;
        _scheduleIds.push(scheduleId);

        uint64 startTime = uint64(block.timestamp);
        VestingMath.Timeline memory timeline = VestingMath.buildTimeline(
            startTime,
            cliffDelay,
            interval,
            releaseCount
        );

        Schedule storage schedule = _schedules[scheduleId];
        schedule.grantor = msg.sender;
        schedule.beneficiary = beneficiary;
        schedule.grantToken = grantToken;
        schedule.total = uint128(total);
        schedule.claimed = 0;
        schedule.startTime = timeline.startTime;
        schedule.cliffTime = timeline.cliffTime;
        schedule.endTime = timeline.endTime;
        schedule.interval = interval;
        schedule.releaseCount = releaseCount;
        schedule.scheduledCount = 0;
        schedule.revoked = false;

        emit ScheduleCreated(
            scheduleId,
            msg.sender,
            beneficiary,
            grantToken,
            total,
            timeline.startTime,
            timeline.cliffTime,
            timeline.endTime,
            releaseCount
        );

        // Pull the grant in before any schedule exists, so a failed pull cannot leave
        // orphaned schedules pointing at an unfunded contract.
        if (
            !IERC20Minimal(grantToken).transferFrom(
                msg.sender,
                address(this),
                total
            )
        ) {
            revert TokenPullFailed(grantToken, total);
        }

        _scheduleReleases(scheduleId);
    }

    // ---------------------------------------------------------------------
    // Execution
    // ---------------------------------------------------------------------

    /**
     * @notice Settles everything currently vested for `scheduleId` and pays the beneficiary
     *         in HBAR.
     * @dev Intended to be called by the Schedule Service at each release second, and safe to
     *      call by anyone at any time. Payout equals vested minus already paid, so early
     *      calls settle zero and repeat calls settle nothing new.
     * @param scheduleId Schedule to settle.
     */
    function executeClaim(uint256 scheduleId) external {
        Schedule storage schedule = _schedules[scheduleId];
        if (schedule.beneficiary == address(0)) {
            revert UnknownSchedule(scheduleId);
        }
        if (schedule.revoked) revert ScheduleIsRevoked(scheduleId);

        uint256 consensusSecond = block.timestamp;
        if (consensusSecond < schedule.cliffTime) {
            revert CliffNotReached(
                scheduleId,
                schedule.cliffTime,
                consensusSecond
            );
        }

        uint256 vested = vestedAmount(scheduleId);
        if (vested <= schedule.claimed) {
            revert NothingNewlyVested(scheduleId);
        }

        uint256 amount = vested - schedule.claimed;
        schedule.claimed = uint128(vested);

        uint256 hbarDelivered = _settleInHbar(
            schedule.grantToken,
            schedule.beneficiary,
            amount,
            consensusSecond
        );

        emit ClaimExecuted(
            scheduleId,
            msg.sender,
            schedule.beneficiary,
            schedule.grantToken,
            amount,
            vested,
            hbarDelivered
        );
    }

    /**
     * @notice Swaps `amount` of `grantToken` into WHBAR and unwraps it into HBAR for
     *         `beneficiary`.
     * @dev The swap is mandatory. There is no branch that pays the grant token instead.
     */
    function _settleInHbar(
        address grantToken,
        address beneficiary,
        uint256 amount,
        uint256 consensusSecond
    ) private returns (uint256 hbarDelivered) {
        // The SwapRouter pulls its input with transferFrom, so it needs an allowance. The
        // router is not an HTS token and exposes no ERC20 approve, which is exactly why the
        // grant must be approved here rather than on the token. HTS approve returns a code.
        int64 approvalCode = IHederaTokenServiceApprove(tokenService).approve(
            grantToken,
            swapRouter,
            amount
        );
        if (approvalCode != HEDERA_SUCCESS) {
            revert TokenApprovalFailed(grantToken, approvalCode);
        }

        // Price the route first so the swap carries a floor the claim cannot slip under.
        bytes memory path = _buildPath(grantToken);
        uint256 quotedOut;
        try
            ISaucerSwapV2Quoter(quoter).quoteExactInput(path, amount)
        returns (
            uint256 amountOut,
            uint160[] memory,
            uint32[] memory,
            uint256
        ) {
            quotedOut = amountOut;
        } catch {
            revert SwapQuoteFailed(grantToken, amount);
        }
        if (quotedOut == 0) revert SwapQuoteZero(grantToken, amount);

        uint256 minimumOut = (quotedOut *
            (BPS_DENOMINATOR - maxSlippageBps)) / BPS_DENOMINATOR;

        // recipient is the router so the WHBAR output stays there ready for the unwrap.
        uint256 whbarOut = ISaucerSwapV2Router(swapRouter).exactInput(
            ISaucerSwapV2Router.ExactInputParams({
                path: path,
                recipient: swapRouter,
                deadline: consensusSecond + SWAP_DEADLINE_BUFFER,
                amountIn: amount,
                amountOutMinimum: minimumOut
            })
        );

        // Burn the router-held WHBAR and forward native HBAR to the beneficiary. Zero is
        // passed as the unwrap floor because the swap above already guaranteed the amount;
        // a second floor would restate a unit convention this contract does not control.
        ISaucerSwapV2Router(swapRouter).unwrapWHBAR(0, beneficiary);

        // The WHBAR token carries eight decimals, matching tinybars, so the unwrapped
        // native HBAR equals the WHBAR amount one for one.
        hbarDelivered = whbarOut;
    }

    // ---------------------------------------------------------------------
    // HIP-1215 scheduling
    // ---------------------------------------------------------------------

    /**
     * @notice Registers one Schedule Service entry per release of `scheduleId`.
     * @dev A release that cannot be scheduled is reported and skipped, never reverted on.
     *      The stream keeps working through permissionless `executeClaim`, which is the
     *      whole reason a lost schedule is survivable.
     */
    function _scheduleReleases(uint256 scheduleId) private {
        Schedule storage schedule = _schedules[scheduleId];
        VestingMath.Timeline memory timeline = VestingMath.buildTimeline(
            schedule.startTime,
            schedule.cliffTime - schedule.startTime,
            schedule.interval,
            schedule.releaseCount
        );

        bytes memory callData = abi.encodeCall(
            this.executeClaim,
            (scheduleId)
        );

        for (uint256 i = 0; i < schedule.releaseCount; ++i) {
            uint256 requestedSecond = VestingMath.releaseSecond(
                timeline,
                schedule.interval,
                i
            );

            (uint256 expirySecond, bool hasCapacity) = _findAvailableSecond(
                requestedSecond,
                releaseGasLimit
            );
            if (!hasCapacity) {
                emit ReleaseScheduleRejected(
                    scheduleId,
                    i,
                    requestedSecond,
                    SCHEDULE_EXPIRY_IS_BUSY
                );
                continue;
            }

            // Never reverts. Inspect the returned code instead of trusting the call.
            (int64 responseCode, address scheduleAddress) = IHederaScheduleService(
                scheduleService
            ).scheduleCall(
                    address(this),
                    expirySecond,
                    releaseGasLimit,
                    0,
                    callData
                );

            if (responseCode != HEDERA_SUCCESS || scheduleAddress == address(0)) {
                emit ReleaseScheduleRejected(
                    scheduleId,
                    i,
                    expirySecond,
                    responseCode
                );
                continue;
            }

            _releaseSchedules[scheduleId][i] = scheduleAddress;
            schedule.scheduledCount += 1;
            emit ReleaseScheduled(scheduleId, i, expirySecond, scheduleAddress);
        }
    }

    /**
     * @notice Finds a consensus second at or after `desiredSecond` that still has room for
     *         `gasLimit` units of scheduled work.
     * @dev Probes are spread by exponentially growing delays with a jitter derived from
     *      values the contract cannot influence. `block.prevrandao` is deliberately avoided
     *      so the contract does not depend on the Cancun opcode set.
     */
    function _findAvailableSecond(
        uint256 desiredSecond,
        uint256 gasLimit
    ) private view returns (uint256 second, bool found) {
        if (
            IHederaScheduleService(scheduleService).hasScheduleCapacity(
                desiredSecond,
                gasLimit
            )
        ) {
            return (desiredSecond, true);
        }

        bytes32 seed = keccak256(
            abi.encode(block.timestamp, address(this), desiredSecond)
        );
        for (uint256 probe = 1; probe <= MAX_SCHEDULE_PROBES; ++probe) {
            uint256 baseDelay = 1 << probe;
            uint256 jitter = uint256(
                uint16(uint256(keccak256(abi.encode(seed, probe))))
            ) % baseDelay;
            uint256 candidate = desiredSecond + baseDelay + jitter;

            if (
                IHederaScheduleService(scheduleService).hasScheduleCapacity(
                    candidate,
                    gasLimit
                )
            ) {
                return (candidate, true);
            }
        }
        return (desiredSecond, false);
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    /**
     * @notice Stops a stream, cancels its pending schedules, and returns the unvested
     *         grant tokens to the grantor.
     */
    function revoke(uint256 scheduleId) external {
        Schedule storage schedule = _schedules[scheduleId];
        if (schedule.beneficiary == address(0)) {
            revert UnknownSchedule(scheduleId);
        }
        if (msg.sender != schedule.grantor && msg.sender != owner) {
            revert NotScheduleAuthority(scheduleId, msg.sender);
        }
        if (schedule.revoked) revert AlreadyRevoked(scheduleId);

        schedule.revoked = true;

        for (uint256 i = 0; i < schedule.releaseCount; ++i) {
            address pending = _releaseSchedules[scheduleId][i];
            if (pending == address(0)) continue;

            // deleteSchedule also reports through a return code rather than reverting.
            int64 responseCode = IHederaScheduleService(scheduleService)
                .deleteSchedule(pending);
            _releaseSchedules[scheduleId][i] = address(0);

            // The live count drops either way. A success means the schedule was deleted; a
            // rejection such as INVALID_SCHEDULE_ID means the network had already executed it,
            // so it is spent rather than pending. Leaving it counted would inflate
            // `scheduledCount` for the rest of the stream's life.
            schedule.scheduledCount -= 1;

            emit ReleaseScheduleCancelled(
                scheduleId,
                i,
                pending,
                responseCode
            );
        }

        uint256 unvested = schedule.total - schedule.claimed;
        if (
            !IERC20Minimal(schedule.grantToken).transfer(
                schedule.grantor,
                unvested
            )
        ) {
            revert TokenReturnFailed(schedule.grantToken, unvested);
        }

        emit ScheduleRevoked(scheduleId, schedule.grantor, unvested);
    }

    /**
     * @notice Retunes the slippage tolerance applied between quote and swap.
     * @param newBps Tolerance in basis points. Must be below `10000`.
     */
    function setMaxSlippageBps(uint16 newBps) external {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        if (newBps >= BPS_DENOMINATOR) revert InvalidSlippage();

        uint16 previousBps = maxSlippageBps;
        maxSlippageBps = newBps;
        emit MaxSlippageUpdated(previousBps, newBps);
    }

    /**
     * @notice Transfers administration.
     */
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Builds the reversed swap route `[WHBAR, fee, grantToken]`.
    function _buildPath(
        address grantToken
    ) private view returns (bytes memory path) {
        // SaucerSwap expects the output token first: [token(20) fee(3) token(20) ...].
        // The fee is a three-byte big-endian word, so 3000 encodes as 0x000bb8.
        //
        // The fee has to land in the *leftmost* three bytes of the word, because
        // `bytes32` to `bytes3` keeps the leading bytes and drops the trailing 29. A
        // left-aligned 24-bit value therefore needs a shift of 29 bytes, not 10: shifting
        // by 80 would put the tier in the middle of the word and encode a zero fee, which
        // matches no pool and reverts every swap.
        bytes3 feeWord = bytes3(bytes32(uint256(poolFee) << 232));
        path = abi.encodePacked(wrappedHbar, feeWord, grantToken);
    }

    /// @notice Total number of schedules created.
    function scheduleCount() external view returns (uint256) {
        return _scheduleIds.length;
    }

    /// @notice All schedule identifiers, in creation order.
    function scheduleIds() external view returns (uint256[] memory) {
        return _scheduleIds;
    }

    /// @notice Raw schedule record.
    function getSchedule(
        uint256 scheduleId
    ) external view returns (Schedule memory) {
        return _schedules[scheduleId];
    }

    /// @notice Tokens vested for `scheduleId` at the current consensus second.
    function vestedAmount(uint256 scheduleId) public view returns (uint256) {
        Schedule storage schedule = _schedules[scheduleId];
        if (schedule.beneficiary == address(0)) {
            revert UnknownSchedule(scheduleId);
        }
        return
            VestingMath.vestedAmount(
                schedule.total,
                VestingMath.buildTimeline(
                    schedule.startTime,
                    schedule.cliffTime - schedule.startTime,
                    schedule.interval,
                    schedule.releaseCount
                ),
                block.timestamp
            );
    }

    /// @notice Tokens already paid out for `scheduleId`.
    function claimedAmount(
        uint256 scheduleId
    ) external view returns (uint256) {
        if (_schedules[scheduleId].beneficiary == address(0)) {
            revert UnknownSchedule(scheduleId);
        }
        return _schedules[scheduleId].claimed;
    }

    /// @notice Consensus second of release `index`.
    function releaseSecondAt(
        uint256 scheduleId,
        uint256 index
    ) external view returns (uint256) {
        Schedule storage schedule = _schedules[scheduleId];
        if (schedule.beneficiary == address(0)) {
            revert UnknownSchedule(scheduleId);
        }
        if (index >= schedule.releaseCount) revert ZeroReleaseCount();
        return uint256(schedule.cliffTime) + (uint256(schedule.interval) * index);
    }

    /// @notice Schedule Service address for release `index`, or zero when unscheduled.
    function releaseScheduleAt(
        uint256 scheduleId,
        uint256 index
    ) external view returns (address) {
        return _releaseSchedules[scheduleId][index];
    }

    /// @notice Everything the dashboard needs to render one schedule.
    function status(
        uint256 scheduleId
    ) external view returns (Status memory result) {
        Schedule storage schedule = _schedules[scheduleId];
        if (schedule.beneficiary == address(0)) {
            revert UnknownSchedule(scheduleId);
        }

        uint256 vested = vestedAmount(scheduleId);

        result.grantor = schedule.grantor;
        result.beneficiary = schedule.beneficiary;
        result.grantToken = schedule.grantToken;
        result.total = schedule.total;
        result.vested = vested;
        result.claimed = schedule.claimed;
        result.claimable = vested > schedule.claimed
            ? vested - schedule.claimed
            : 0;
        result.startTime = schedule.startTime;
        result.cliffTime = schedule.cliffTime;
        result.endTime = schedule.endTime;
        result.interval = schedule.interval;
        result.releaseCount = schedule.releaseCount;
        result.scheduledCount = schedule.scheduledCount;
        result.revoked = schedule.revoked;
        result.cliffReached = block.timestamp >= schedule.cliffTime;
        result.nextReleaseSecond = _nextReleaseSecond(
            schedule,
            block.timestamp
        );
    }

    /**
     * @notice First release second still in the future, or zero when the stream is finished.
     */
    function _nextReleaseSecond(
        Schedule storage schedule,
        uint256 consensusSecond
    ) private view returns (uint256) {
        if (consensusSecond >= schedule.endTime) return 0;
        if (consensusSecond < schedule.cliffTime) return schedule.cliffTime;

        uint256 elapsed = consensusSecond - schedule.cliffTime;
        uint256 nextIndex = elapsed / schedule.interval + 1;
        uint256 candidate = uint256(schedule.cliffTime) +
            (uint256(schedule.interval) * nextIndex);
        return candidate > schedule.endTime ? 0 : candidate;
    }
}

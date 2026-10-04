// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title VestingMath
 * @notice Pure arithmetic for a cliff-then-linear vesting timeline.
 * @dev Kept separate from `StreamedVesting` so the schedule maths can be reasoned about,
 *      and unit-tested, without touching storage or external protocols.
 *
 *      A schedule is described by three consensus seconds:
 *
 *      - `startTime` when the grant is created. Nothing is vested yet.
 *      - `cliffTime` when the first token becomes claimable. Before this instant the
 *        beneficiary is owed exactly zero.
 *      - `endTime` when the grant is fully vested.
 *
 *      Between `cliffTime` and `endTime` the vested amount grows linearly. Using integer
 *      division on a ratio means rounding always favours the protocol: `vested` is a
 *      monotonic step function that never overshoots `total`.
 */
library VestingMath {
    struct Timeline {
        uint64 startTime;
        uint64 cliffTime;
        uint64 endTime;
    }

    /**
     * @notice Amount vested at `timestamp`, in the grant token's smallest unit.
     * @param total Total grant size.
     * @param timeline The schedule's consensus seconds.
     * @param timestamp Consensus second to evaluate at (the EVM `block.timestamp`).
     * @return amount Tokens vested at that instant, between `0` and `total`.
     */
    function vestedAmount(
        uint256 total,
        Timeline memory timeline,
        uint256 timestamp
    ) internal pure returns (uint256 amount) {
        if (total == 0 || timestamp < timeline.cliffTime) {
            return 0;
        }
        if (timestamp >= timeline.endTime) {
            return total;
        }


        uint256 elapsed = timestamp - timeline.cliffTime;
        uint256 window = timeline.endTime - timeline.cliffTime;
        if (window == 0) {
            // Degenerate case: every token unlocks at the cliff. Handled here rather than
            // at schedule creation so a stored schedule can never divide by zero.
            return total;
        }

        amount = (total * elapsed) / window;
    }

    /**
     * @notice Consensus second of release `index` in a schedule that unlocks every
     *         `interval` seconds starting at the cliff.
     * @param timeline The schedule's consensus seconds.
     * @param interval Spacing between releases, in seconds.
     * @param index Zero-based release ordinal.
     * @return second Consensus second of that release.
     */
    function releaseSecond(
        Timeline memory timeline,
        uint64 interval,
        uint256 index
    ) internal pure returns (uint256 second) {
        second = uint256(timeline.cliffTime) + (interval * index);
    }

    /**
     * @notice Derives a timeline from a cliff delay and a release cadence.
     * @param startTime Consensus second the grant is created.
     * @param cliffDelay Seconds between `startTime` and the first unlock.
     * @param interval Seconds between consecutive releases.
     * @param releaseCount Number of releases, at least one.
     * @return timeline The resulting timeline.
     */
    function buildTimeline(
        uint64 startTime,
        uint64 cliffDelay,
        uint64 interval,
        uint32 releaseCount
    ) internal pure returns (Timeline memory timeline) {
        timeline.startTime = startTime;
        timeline.cliffTime = startTime + cliffDelay;
        // `releaseCount - 1` extra intervals sit after the cliff release.
        timeline.endTime =
            timeline.cliffTime +
            (interval * uint64(releaseCount - 1));
    }
}

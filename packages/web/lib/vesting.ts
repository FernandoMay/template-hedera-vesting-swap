/**
 * Rebuilds the state of a vesting stream from the contract's event log.
 *
 * The dashboard deliberately does not call the contract's `status()` view. Mirror Node
 * already stores every event the contract emitted, and the events carry everything needed to
 * show a stream: the schedule's shape from `ScheduleCreated`, the paid amounts from
 * `ClaimExecuted`, and which releases the network actually accepted from
 * `ReleaseScheduled` / `ReleaseScheduleRejected`. Replaying the log keeps the dashboard
 * credential-free and makes the history auditable, because every number shown can be traced
 * back to a transaction that produced it.
 */

import type { DecodedLog } from "./hedera";

/** A release the contract asked the Schedule Service to execute. */
export interface ScheduledRelease {
  readonly index: number;
  readonly expirySecond: number;
  readonly scheduleAddress: string;
}

/** A release the Schedule Service refused, kept so the UI can explain a gap. */
export interface RejectedRelease {
  readonly index: number;
  readonly requestedSecond: number;
  readonly responseCode: number;
}

/** One settled claim. */
export interface ClaimRecord {
  readonly consensusSecond: number;
  readonly caller: string;
  readonly amountConverted: bigint;
  readonly vestedTotal: bigint;
  readonly hbarDelivered: bigint;
}

/** Everything known about one stream at a point in time. */
export interface StreamSummary {
  readonly scheduleId: bigint;
  readonly grantor: string;
  readonly beneficiary: string;
  readonly grantToken: string;
  readonly total: bigint;
  readonly startTime: number;
  readonly cliffTime: number;
  readonly endTime: number;
  readonly releaseCount: number;
  readonly releases: ScheduledRelease[];
  readonly rejected: RejectedRelease[];
  readonly claims: ClaimRecord[];
  readonly revoked: boolean;
  readonly unvestedReturned: bigint;
  /** Tokens released by the network, which are the ones it can execute unattended. */
  readonly claimed: bigint;
  /** Tokens vested at `nowSecond` under the contract's linear cliff schedule. */
  readonly vested: bigint;
  /** Tokens vested but not yet paid, which is what a claim would settle right now. */
  readonly claimable: bigint;
  /** Seconds still to run, or zero once the stream is finished. */
  readonly secondsRemaining: number;
  /** First release second still in the future, or zero when the stream is finished. */
  readonly nextReleaseSecond: number;
}

/**
 * Mirrors the contract's linear vesting maths.
 *
 * This must agree with `VestingMath.vestedAmount` in the contract. If the two ever drift the
 * dashboard would show a `claimable` figure that a claim cannot actually pay, which is worse
 * than showing nothing, so the contract's own suite pins that behaviour under "vesting maths"
 * in `packages/contracts/test/StreamedVesting.test.ts`. Change both together.
 */
export function vestedAmount(
  total: bigint,
  cliffTime: number,
  endTime: number,
  nowSecond: number,
): bigint {
  if (nowSecond < cliffTime) return 0n;
  if (nowSecond >= endTime) return total;
  const window = BigInt(endTime - cliffTime);
  return (total * BigInt(nowSecond - cliffTime)) / window;
}

/**
 * Replays a contract's event log into one summary per stream.
 *
 * @param events Decoded logs in ascending consensus order.
 * @param nowSecond Consensus second to evaluate vesting against. Passed in rather than read
 *        from `Date.now()` so the caller controls the clock and tests stay deterministic.
 */
export function buildStreams(
  events: readonly DecodedLog[],
  nowSecond: number,
): StreamSummary[] {
  interface Draft {
    scheduleId: bigint;
    grantor: string;
    beneficiary: string;
    grantToken: string;
    total: bigint;
    startTime: number;
    cliffTime: number;
    endTime: number;
    releaseCount: number;
    releases: ScheduledRelease[];
    rejected: RejectedRelease[];
    claims: ClaimRecord[];
    revoked: boolean;
    unvestedReturned: bigint;
  }

  const drafts = new Map<bigint, Draft>();

  const big = (value: unknown): bigint => value as bigint;
  const num = (value: unknown): number => Number(value as bigint);

  for (const event of events) {
    switch (event.name) {
      case "ScheduleCreated": {
        const scheduleId = big(event.args.scheduleId);
        drafts.set(scheduleId, {
          scheduleId,
          grantor: event.args.grantor as string,
          beneficiary: event.args.beneficiary as string,
          grantToken: event.args.grantToken as string,
          total: big(event.args.total),
          startTime: num(event.args.startTime),
          cliffTime: num(event.args.cliffTime),
          endTime: num(event.args.endTime),
          releaseCount: num(event.args.releaseCount),
          releases: [],
          rejected: [],
          claims: [],
          revoked: false,
          unvestedReturned: 0n,
        });
        break;
      }

      case "ReleaseScheduled": {
        const draft = drafts.get(big(event.args.scheduleId));
        if (draft) {
          draft.releases.push({
            index: num(event.args.index),
            expirySecond: num(event.args.expirySecond),
            scheduleAddress: event.args.scheduleAddress as string,
          });
        }
        break;
      }

      case "ReleaseScheduleRejected": {
        const draft = drafts.get(big(event.args.scheduleId));
        if (draft) {
          draft.rejected.push({
            index: num(event.args.index),
            requestedSecond: num(event.args.requestedSecond),
            responseCode: Number(big(event.args.responseCode)),
          });
        }
        break;
      }

      case "ClaimExecuted": {
        const draft = drafts.get(big(event.args.scheduleId));
        if (draft) {
          draft.claims.push({
            consensusSecond: event.consensusTimestamp,
            caller: event.args.caller as string,
            amountConverted: big(event.args.amountConverted),
            vestedTotal: big(event.args.vestedTotal),
            hbarDelivered: big(event.args.hbarDelivered),
          });
        }
        break;
      }

      case "ScheduleRevoked": {
        const draft = drafts.get(big(event.args.scheduleId));
        if (draft) {
          draft.revoked = true;
          draft.unvestedReturned = big(event.args.unvestedReturned);
        }
        break;
      }

      default:
        // `ReleaseScheduleCancelled` and `MaxSlippageUpdated` carry nothing the dashboard
        // renders; a revoked or finished stream already tells the story.
        break;
    }
  }

  return [...drafts.values()]
    .sort((a, b) => (a.scheduleId < b.scheduleId ? -1 : 1))
    .map((draft) => {
      const vested = vestedAmount(
        draft.total,
        draft.cliffTime,
        draft.endTime,
        nowSecond,
      );
      // The contract tracks `claimed` as the last vested total it paid, so the paid amount
      // is the final claim's vestedTotal rather than a running sum of the deltas.
      const claimed =
        draft.claims.length === 0
          ? 0n
          : draft.claims[draft.claims.length - 1]!.vestedTotal;
      const finished = nowSecond >= draft.endTime;

      let nextReleaseSecond = 0;
      if (!finished) {
        if (nowSecond < draft.cliffTime) {
          nextReleaseSecond = draft.cliffTime;
        } else {
          const interval = Math.floor(
            (draft.endTime - draft.cliffTime) / Math.max(draft.releaseCount - 1, 1),
          );
          const elapsed = nowSecond - draft.cliffTime;
          const candidate = draft.cliffTime + interval * (Math.floor(elapsed / interval) + 1);
          nextReleaseSecond = candidate <= draft.endTime ? candidate : 0;
        }
      }

      return {
        ...draft,
        claimed,
        vested,
        claimable: vested > claimed ? vested - claimed : 0n,
        secondsRemaining: finished ? 0 : draft.endTime - nowSecond,
        nextReleaseSecond,
      };
    });
}

/**
 * Maps a `ResponseCodeEnum` ordinal to the subset worth showing in the UI.
 *
 * Only the codes a vesting stream can realistically hit are named. Anything else is
 * rendered by number, which is still more useful than a blank cell.
 */
export const RESPONSE_CODE_LABELS: Record<number, string> = {
  22: "SUCCESS",
  45: "INVALID_EXPIRATION_TIME",
  201: "INVALID_SCHEDULE_ID",
  213: "SCHEDULE_ALREADY_EXECUTED",
  370: "SCHEDULE_EXPIRY_IS_BUSY",
};

export function responseCodeLabel(code: number): string {
  return RESPONSE_CODE_LABELS[code] ?? `code ${code}`;
}
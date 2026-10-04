/**
 * Assembles everything a page needs to render, in one place.
 *
 * Keeping the fetch and the error handling together means the two routes cannot drift, and
 * it keeps `app/page.tsx` and `app/schedule/[id]/page.tsx` free of try/catch noise.
 */

import { formatHbar, formatTokenAmount } from "./format";
import {
  configuredNetwork,
  fetchContractEvents,
  fetchHbarBalance,
  fetchToken,
  vestingContractId,
  type NetworkConfig,
  type TokenInfo,
} from "./hedera";
import { buildStreams, type StreamSummary } from "./vesting";

/** A stream paired with the metadata needed to render its amounts. */
export interface RenderedStream {
  readonly summary: StreamSummary;
  readonly token: TokenInfo | null;
  /** Total grant and payouts scaled to whole tokens. */
  readonly totalFormatted: string;
  readonly vestedFormatted: string;
  readonly claimedFormatted: string;
  readonly claimableFormatted: string;
  /** Share of the grant vested, 0 to 100. */
  readonly vestedPercent: number;
  /** Share of the grant paid out, 0 to 100. */
  readonly claimedPercent: number;
}

/** Result of a dashboard load, including why a page may be empty. */
export interface DashboardData {
  readonly network: NetworkConfig;
  readonly contractId: string | null;
  readonly streams: RenderedStream[];
  readonly nowSecond: number;
  /** Set when the chain could not be read, so the page can explain itself instead of lying. */
  readonly error: string | null;
  /** Sum of HBAR delivered across every claim of every stream. */
  readonly totalHbarDeliveredFormatted: string;
}

function percentOf(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  // Four digits of precision is more than a progress bar can show and keeps the number
  // stable for very large grants.
  return Number((part * 10_000n) / whole) / 100;
}

/** Loads the streams for the configured contract. */
export async function loadDashboard(): Promise<DashboardData> {
  const network = configuredNetwork();
  const nowSecond = Math.floor(Date.now() / 1000);
  const contractId = vestingContractId();

  const empty: DashboardData = {
    network,
    contractId,
    streams: [],
    nowSecond,
    error: null,
    totalHbarDeliveredFormatted: "0",
  };

  // No contract configured is a normal state for a freshly scaffolded repo, not a failure.
  if (!contractId) return empty;

  try {
    const events = await fetchContractEvents(network, contractId);
    const summaries = buildStreams(events, nowSecond);

    // Token metadata is shared across streams, so fetch each distinct token once.
    const tokenCache = new Map<string, Promise<TokenInfo | null>>();
    const tokenFor = (tokenId: string): Promise<TokenInfo | null> => {
      const cached = tokenCache.get(tokenId);
      if (cached) return cached;
      const pending = fetchToken(network, tokenId);
      tokenCache.set(tokenId, pending);
      return pending;
    };

    const streams = await Promise.all(
      summaries.map(async (summary): Promise<RenderedStream> => {
        const token = await tokenFor(summary.grantToken);
        const decimals = token?.decimals ?? 8;
        return {
          summary,
          token,
          totalFormatted: formatTokenAmount(summary.total, decimals, 4),
          vestedFormatted: formatTokenAmount(summary.vested, decimals, 4),
          claimedFormatted: formatTokenAmount(summary.claimed, decimals, 4),
          claimableFormatted: formatTokenAmount(summary.claimable, decimals, 6),
          vestedPercent: percentOf(summary.vested, summary.total),
          claimedPercent: percentOf(summary.claimed, summary.total),
        };
      }),
    );

    let delivered = 0n;
    for (const stream of streams) {
      for (const claim of stream.summary.claims) {
        delivered += claim.hbarDelivered;
      }
    }

    return {
      ...empty,
      streams,
      totalHbarDeliveredFormatted: formatHbar(delivered, 6),
    };
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : "The Hedera Mirror Node could not be read.";
    return { ...empty, error: message };
  }
}

/** Loads one stream by id, or `null` when no such stream exists. */
export async function loadStream(
  scheduleId: bigint,
): Promise<RenderedStream | null> {
  const data = await loadDashboard();
  return data.streams.find((stream) => stream.summary.scheduleId === scheduleId) ?? null;
}

/**
 * Reads a beneficiary's HBAR balance in tinybars.
 *
 * Kept separate from `loadDashboard` because the list view does not need it and paying for
 * one extra request per page view would be wasteful.
 */
export async function loadHbarBalance(accountId: string): Promise<bigint | null> {
  try {
    return await fetchHbarBalance(configuredNetwork(), accountId);
  } catch {
    return null;
  }
}
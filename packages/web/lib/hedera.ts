/**
 * Everything the dashboard needs to read a deployed `StreamedVesting` contract.
 *
 * The dashboard talks to the Hedera Mirror Node REST API and nothing else. That is a
 * deliberate choice: the Mirror Node is public on every network, needs no API key, and
 * serves the contract's event log, so the state of a stream can be reconstructed from the
 * chain's own record of what happened. A JSON-RPC relay would give direct view calls, but
 * it would also add a credential, a rate limit, and a second network to fail.
 */

import { Interface } from "ethers";

export type HederaNetworkName = "testnet" | "previewnet" | "mainnet";

export interface NetworkConfig {
  readonly name: HederaNetworkName;
  readonly label: string;
  readonly mirrorNodeUrl: string;
}

/**
 * Mirror Node bases. These are the only network-specific values the dashboard needs.
 *
 * Verified against the live testnet service while building this template: a request for
 * `0.0.15058` returns the WHBAR token record, and a request for contract `0.0.1414040`
 * returns the SaucerSwap V2 router record.
 */
export const NETWORKS: Record<HederaNetworkName, NetworkConfig> = {
  testnet: {
    name: "testnet",
    label: "Hedera testnet",
    mirrorNodeUrl: "https://testnet.mirrornode.hedera.com/api/v1",
  },
  previewnet: {
    name: "previewnet",
    label: "Hedera previewnet",
    mirrorNodeUrl: "https://previewnet.mirrornode.hedera.com/api/v1",
  },
  mainnet: {
    name: "mainnet",
    label: "Hedera mainnet",
    mirrorNodeUrl: "https://mainnet-public.mirrornode.hedera.com/api/v1",
  },
};

/** Contract ID the dashboard reads, or `null` when none is configured. */
export function vestingContractId(): string | null {
  const raw = process.env.NEXT_PUBLIC_VESTING_CONTRACT_ID?.trim();
  if (!raw) return null;
  if (!/^0\.0\.\d+$/.test(raw)) {
    throw new Error(
      `NEXT_PUBLIC_VESTING_CONTRACT_ID must look like 0.0.1234, received "${raw}".`,
    );
  }
  return raw;
}

/** Network the dashboard reads, defaulting to testnet. */
export function configuredNetwork(): NetworkConfig {
  const raw = (process.env.NEXT_PUBLIC_HEDERA_NETWORK ?? "testnet")
    .trim()
    .toLowerCase();
  if (raw !== "testnet" && raw !== "previewnet" && raw !== "mainnet") {
    throw new Error(
      `NEXT_PUBLIC_HEDERA_NETWORK must be testnet, previewnet, or mainnet, received "${raw}".`,
    );
  }
  return NETWORKS[raw];
}

/**
 * Events emitted by `StreamedVesting`, kept to the ones the dashboard renders.
 *
 * Declaring only the event signatures keeps the browser bundle small: the Mirror Node hands
 * back raw `topics` and `data`, and a topic hash plus a tuple decoder is all that is needed
 * to turn them back into typed events.
 */
const STREAMED_VESTING_EVENTS = [
  "event ScheduleCreated(uint256 indexed scheduleId, address indexed grantor, address indexed beneficiary, address grantToken, uint256 total, uint256 startTime, uint256 cliffTime, uint256 endTime, uint32 releaseCount)",
  "event ClaimExecuted(uint256 indexed scheduleId, address indexed caller, address indexed beneficiary, address grantToken, uint256 amountConverted, uint256 vestedTotal, uint256 hbarDelivered)",
  "event ReleaseScheduled(uint256 indexed scheduleId, uint256 indexed index, uint256 expirySecond, address scheduleAddress)",
  "event ReleaseScheduleRejected(uint256 indexed scheduleId, uint256 indexed index, uint256 requestedSecond, int64 responseCode)",
  "event ReleaseScheduleCancelled(uint256 indexed scheduleId, uint256 indexed index, address scheduleAddress, int64 responseCode)",
  "event ScheduleRevoked(uint256 indexed scheduleId, address indexed grantor, uint256 unvestedReturned)",
] as const;

export const vestingInterface = new Interface(
  STREAMED_VESTING_EVENTS as unknown as string[],
);

/** One decoded contract log, flattened out of the Mirror Node's wire shape. */
export interface DecodedLog {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly consensusTimestamp: number;
}

/** A Mirror Node contract log, before decoding. */
interface MirrorNodeLog {
  contract_id: string;
  topics: string[];
  data: string;
  consensus_timestamp: string;
}

/**
 * Fetches and decodes every log a contract emitted, oldest first.
 *
 * @returns Decoded events, or an empty list when the contract has not emitted anything yet.
 * @throws When the Mirror Node cannot be reached or answers with a non-2xx status, because
 *         silently returning "no schedules" would misrepresent a network outage as an empty
 *         contract.
 */
export async function fetchContractEvents(
  network: NetworkConfig,
  contractId: string,
): Promise<DecodedLog[]> {
  const url = `${network.mirrorNodeUrl}/contracts/${contractId}/results/logs?limit=100&order=asc`;
  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(
      `Mirror Node returned ${response.status} ${response.statusText} for contract ${contractId}.`,
    );
  }

  const body = (await response.json()) as { logs?: MirrorNodeLog[] };
  const logs = body.logs ?? [];

  const decoded: DecodedLog[] = [];
  for (const log of logs) {
    try {
      const parsed = vestingInterface.parseLog({
        topics: log.topics,
        data: log.data,
      });
      if (!parsed) continue;
      decoded.push({
        name: parsed.name,
        args: parsed.args as Record<string, unknown>,
        consensusTimestamp: Number(log.consensus_timestamp),
      });
    } catch {
      // A log from a future contract version that this template does not know about. Skipping
      // it keeps the dashboard rendering the streams it does understand.
      continue;
    }
  }
  return decoded;
}

/** Token metadata as reported by the Mirror Node. */
export interface TokenInfo {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * Reads a token record so amounts can be scaled and labelled.
 *
 * @returns The token, or `null` when the node has no record for it.
 */
export async function fetchToken(
  network: NetworkConfig,
  tokenId: string,
): Promise<TokenInfo | null> {
  const response = await fetch(
    `${network.mirrorNodeUrl}/tokens/${tokenId}`,
    { cache: "no-store" },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Mirror Node returned ${response.status} ${response.statusText} for token ${tokenId}.`,
    );
  }

  const body = (await response.json()) as {
    name?: string;
    symbol?: string;
    decimals?: string;
  };
  return {
    name: body.name ?? tokenId,
    symbol: body.symbol ?? "???",
    decimals: Number(body.decimals ?? 0),
  };
}

/**
 * Reads an account's HBAR balance in tinybars.
 *
 * @returns The balance, or `null` when the node has no record for the account.
 */
export async function fetchHbarBalance(
  network: NetworkConfig,
  accountId: string,
): Promise<bigint | null> {
  const response = await fetch(
    `${network.mirrorNodeUrl}/accounts/${accountId}`,
    { cache: "no-store" },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Mirror Node returned ${response.status} ${response.statusText} for account ${accountId}.`,
    );
  }

  const body = (await response.json()) as {
    balance?: { balance?: number | string };
  };
  if (!body.balance || body.balance.balance === undefined) return null;
  return BigInt(body.balance.balance);
}
/**
 * Single source of truth for every Hedera and SaucerSwap address used by this template.
 *
 * Nothing outside this file should contain a raw contract ID or EVM address. The Solidity
 * contracts receive these values through their constructor; the web app reads them from the
 * same shapes via `packages/web/lib/hedera.ts`, which is derived from the exported constants.
 *
 * Provenance for every entry is recorded in the `verified` field and in README.md, section
 * "Where these addresses come from".
 */

export type HederaNetworkName = "testnet" | "previewnet" | "mainnet";

export interface ContractRef {
  /** Hedera entity ID in `0.0.x` form. */
  readonly id: string;
  /** Why this value is considered correct. */
  readonly verified: string;
}

export interface NetworkConfig {
  readonly name: HederaNetworkName;
  readonly chainId: number;
  readonly mirrorNodeUrl: string;
  readonly jsonRpcUrl: string | null;
  readonly hssSystemContract: string;
  readonly htsSystemContract: string;
  /**
   * Token streamed when `HEDERA_GRANT_TOKEN_ID` is unset, or `""` on a network where no
   * default is safe. The swap is mandatory, so the token has to have live SaucerSwap
   * liquidity against WHBAR at the configured fee tier or every claim reverts.
   */
  readonly defaultGrantToken: string;
  readonly saucerSwap: {
    readonly swapRouterV2: ContractRef;
    readonly quoterV2: ContractRef;
    readonly factoryV2: ContractRef;
    readonly routerV1: ContractRef;
    readonly whbarHelper: ContractRef;
    readonly whbarToken: ContractRef;
    readonly sauceToken: ContractRef;
  };
}

/**
 * Hedera reserves a fixed EVM address per system contract. These values are network
 * independent: every Hedera network exposes the same addresses.
 *
 * - HSS (Schedule Service) lives at `0x16b`. Confirmed by a live `hasScheduleCapacity`
 *   call on Hedera testnet that returned `true`, and by the official docs page
 *   https://docs.hedera.com/hedera/core-concepts/smart-contracts/system-smart-contracts
 * - HTS (Token Service) lives at `0x167`. `0x167` is frequently misquoted as the schedule
 *   service; it is the token service. A `hasScheduleCapacity` call against `0x167` on
 *   testnet returns an empty result, confirming it does not serve HSS selectors.
 */
export const HEDERA_SYSTEM_CONTRACTS = {
  /** HIP-1215 generalized scheduled contract calls. */
  scheduleService: "0x000000000000000000000000000000000000016b",
  /** HTS precompile: token create, mint, associate, allowance, transfer. */
  tokenService: "0x0000000000000000000000000000000000000167",
  /** HIP-475 exchange rate contract. */
  exchangeRate: "0x0000000000000000000000000000000000000168",
} as const;

/**
 * `SUCCESS` in the Hedera protobuf `ResponseCodeEnum`. Every system contract entry point
 * returns this ordinal instead of reverting, so it is the value to compare against.
 */
export const HEDERA_SUCCESS = 22;

export const NETWORKS: Record<HederaNetworkName, NetworkConfig> = {
  testnet: {
    name: "testnet",
    chainId: 296,
    mirrorNodeUrl: "https://testnet.mirrornode.hedera.com/api/v1",
    jsonRpcUrl: "https://testnet.hashscan.io/mainnet/evm",
    hssSystemContract: HEDERA_SYSTEM_CONTRACTS.scheduleService,
    htsSystemContract: HEDERA_SYSTEM_CONTRACTS.tokenService,
    defaultGrantToken: "0.0.1183558",
    saucerSwap: {
      swapRouterV2: {
        id: "0.0.1414040",
        verified: "SaucerSwap docs, Hedera testnet deployments table",
      },
      quoterV2: {
        id: "0.0.1390002",
        verified: "SaucerSwap docs, Hedera testnet deployments table",
      },
      factoryV2: {
        id: "0.0.1197038",
        verified: "SaucerSwap docs; confirmed by a live getPool() call on testnet",
      },
      routerV1: {
        id: "0.0.19264",
        verified: "SaucerSwap docs, Hedera testnet deployments table",
      },
      whbarHelper: {
        id: "0.0.5286055",
        verified: "SaucerSwap docs, Hedera testnet deployments table",
      },
      whbarToken: {
        id: "0.0.15058",
        verified:
          "SaucerSwap docs; decimals() == 8 confirmed by a live call on testnet",
      },
      sauceToken: {
        id: "0.0.1183558",
        verified: "SaucerSwap docs; live SAUCE/WHBAR 0.30% pool confirmed on testnet",
      },
    },
  },

  previewnet: {
    name: "previewnet",
    chainId: 145,
    mirrorNodeUrl: "https://previewnet.mirrornode.hedera.com/api/v1",
    jsonRpcUrl: null,
    hssSystemContract: HEDERA_SYSTEM_CONTRACTS.scheduleService,
    htsSystemContract: HEDERA_SYSTEM_CONTRACTS.tokenService,
    // SaucerSwap deploys no V2 contracts on Hedera previewnet, so there is no pool to
    // stream against and no safe default. The deploy script requires an explicit choice.
    defaultGrantToken: "",
    saucerSwap: {
      swapRouterV2: {
        id: "",
        verified: "SaucerSwap does not deploy V2 contracts on Hedera previewnet",
      },
      quoterV2: { id: "", verified: "Not deployed on Hedera previewnet" },
      factoryV2: { id: "", verified: "Not deployed on Hedera previewnet" },
      routerV1: { id: "", verified: "Not deployed on Hedera previewnet" },
      whbarHelper: { id: "", verified: "Not deployed on Hedera previewnet" },
      whbarToken: { id: "", verified: "Not deployed on Hedera previewnet" },
      sauceToken: { id: "", verified: "Not deployed on Hedera previewnet" },
    },
  },

  mainnet: {
    name: "mainnet",
    chainId: 295,
    mirrorNodeUrl: "https://mainnet-public.mirrornode.hedera.com/api/v1",
    jsonRpcUrl: "https://mainnet.hashscan.io/mainnet/evm",
    hssSystemContract: HEDERA_SYSTEM_CONTRACTS.scheduleService,
    htsSystemContract: HEDERA_SYSTEM_CONTRACTS.tokenService,
    defaultGrantToken: "0.0.731861",
    saucerSwap: {
      swapRouterV2: {
        id: "0.0.3949434",
        verified: "SaucerSwap docs, Hedera mainnet deployments table",
      },
      quoterV2: {
        id: "0.0.3949424",
        verified: "SaucerSwap docs, Hedera mainnet deployments table",
      },
      factoryV2: {
        id: "0.0.3946833",
        verified: "SaucerSwap docs, Hedera mainnet deployments table",
      },
      routerV1: {
        id: "0.0.3045981",
        verified: "SaucerSwap docs, Hedera mainnet deployments table",
      },
      whbarHelper: {
        id: "0.0.5808826",
        verified: "SaucerSwap docs, Hedera mainnet deployments table",
      },
      whbarToken: {
        id: "0.0.1456986",
        verified: "SaucerSwap docs, Hedera mainnet deployments table",
      },
      sauceToken: {
        id: "0.0.731861",
        verified: "SaucerSwap docs, Hedera mainnet deployments table",
      },
    },
  },
};

/**
 * Fee tiers used by SaucerSwap V2 pools, in hundredths of a bip. The wire format is a
 * 3-byte big-endian value, so 3000 becomes `0x000bb8`.
 */
export const POOL_FEE_TIERS = {
  /** 0.01% */
  hundredthBps: 100,
  /** 0.05% */
  fiveThousandthsBps: 500,
  /** 0.30% — the tier with a confirmed live SAUCE/WHBAR testnet pool. */
  thirtyThousandthsBps: 3000,
  /** 1.00% */
  onePercentBps: 10000,
} as const;

/** Human-readable labels for the fee tiers above. */
export const POOL_FEE_LABELS: Record<number, string> = {
  100: "0.01%",
  500: "0.05%",
  3000: "0.30%",
  10000: "1.00%",
};

export const DEFAULT_POOL_FEE = POOL_FEE_TIERS.thirtyThousandthsBps;

/**
 * Default grant token for Hedera testnet.
 *
 * The swap is the product here, so the grant token must have live liquidity. A token
 * created minutes ago has no SaucerSwap pool, which would make every claim fail on the
 * `exactInput` call. Testnet SAUCE is used because it has a confirmed WHBAR pool at the
 * 0.30% tier. Prefer `NetworkConfig.defaultGrantToken`, which resolves per network, over
 * this testnet-only constant.
 */
export const DEFAULT_GRANT_TOKEN = NETWORKS.testnet.defaultGrantToken;

/**
 * Converts a Hedera entity ID of the form `0.0.<number>` into its long-zero EVM address.
 * Valid for shard 0 / realm 0 entities, which covers every address in this file.
 */
export function toEvmAddress(accountId: string): string {
  const match = /^0\.0\.(\d+)$/.exec(accountId.trim());
  if (!match) {
    throw new Error(
      `Cannot convert "${accountId}" to an EVM address: expected the form 0.0.<number>`,
    );
  }
  return `0x${BigInt(match[1]).toString(16).padStart(40, "0")}`;
}

/**
 * Converts a long-zero EVM address into the `0.0.<number>` entity ID the SDK expects.
 *
 * The system contracts are addressed as EVM hex in Solidity but have to be addressed as
 * entity IDs in SDK transactions, so both directions are needed. Only shard 0 / realm 0
 * long-zero addresses are handled, which covers every system contract and token in this file.
 */
export function toEntityId(evmAddress: string): string {
  const match = /^0x0{24}([0-9a-fA-F]{1,16})$/.exec(evmAddress.trim());
  if (!match) {
    throw new Error(
      `Cannot convert "${evmAddress}" to an entity ID: expected a shard 0 / realm 0` +
        " long-zero address such as 0x000000000000000000000000000000000000016b",
    );
  }
  return `0.0.${BigInt(`0x${match[1]}`).toString(10)}`;
}

/** Reads the configured network from the environment, defaulting to Hedera testnet. */
export function resolveNetwork(
  value: string | undefined = process.env.HEDERA_NETWORK,
): NetworkConfig {
  const key = (value ?? "testnet").toLowerCase();
  if (key !== "testnet" && key !== "previewnet" && key !== "mainnet") {
    throw new Error(
      `Unsupported HEDERA_NETWORK "${value}". Expected testnet, previewnet, or mainnet.`,
    );
  }
  return NETWORKS[key];
}

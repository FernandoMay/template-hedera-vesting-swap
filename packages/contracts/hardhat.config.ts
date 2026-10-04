import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@typechain/hardhat";

import { HEDERA_SYSTEM_CONTRACTS } from "./config/networks";

/**
 * Hedera networks are driven through the Hedera SDK from `scripts/deploy.ts`, so the
 * Hardhat network entries only need chain settings. The compiler settings below are the
 * ones Hedera's EVM is happiest with: Solidity 0.8.24 with the Shanghai instruction set,
 * which every Hedera node supports.
 *
 * HIP-1215 also requires release `v0.68.0` or newer, so the deployed target network must
 * run Hedera services `0.68` or later for scheduled calls to work.
 */
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "shanghai",
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: false,
    },
    // These entries exist so `hardhat run --network hedera-testnet` resolves. The deploy
    // script submits through the Hedera SDK rather than through the JSON-RPC relay, so no
    // RPC credentials are needed for it to work.
    "hedera-testnet": {
      url: "https://testnet.hashscan.io/mainnet/evm",
      chainId: 296,
    },
    "hedera-previewnet": {
      url: "https://previewnet.hashscan.io/mainnet/evm",
      chainId: 145,
    },
    "hedera-mainnet": {
      url: "https://mainnet.hashscan.io/mainnet/evm",
      chainId: 295,
    },
  },
  mocha: {
    timeout: 120_000,
  },
};

/**
 * Surfaces the two system contract addresses in test output so a reader can confirm which
 * addresses the suite assumes without digging through Solidity.
 */
export const SYSTEM_CONTRACTS = HEDERA_SYSTEM_CONTRACTS;

export default config;

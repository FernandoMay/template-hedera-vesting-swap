/**
 * Deploys the streamed vesting stack to a Hedera network and prints what a developer needs
 * to point the dashboard at the result.
 *
 * Steps, in order:
 *
 *   1. Confirm credentials are present without echoing any secret material.
 *   2. Resolve the grant token. By default this is a token that already has SaucerSwap
 *      liquidity, because the swap is mandatory and a brand new token has no pool.
 *   3. Associate the operator with the grant token and with WHBAR. A Hedera account cannot
 *      hold an HTS token until the association exists, and skipping it is the most common
 *      reason a swap reverts.
 *   4. Optionally create a grant token through the SDK, with a real supply key and
 *      treasury account, for the case where you intend to seed a pool yourself.
 *   5. Publish the initcode to the File Service, because the creation bytecode is larger
 *      than Hedera's 6,144-byte inline transaction limit.
 *   6. Deploy `StreamedVesting` with the confirmed system-contract and SaucerSwap
 *      addresses for the target network.
 *   7. Associate the new contract with the grant token and approve it to pull the grant.
 *   8. Probe HSS for capacity on the first release second.
 *   9. Create a first vesting stream.
 *
 * Usage:
 *   npm run deploy:testnet
 *   npm run deploy:previewnet
 *   npm run deploy:mainnet
 *
 * The target network is read from `HEDERA_NETWORK`, which defaults to `testnet`. The npm
 * scripts above only select the Hardhat network entry; `HEDERA_NETWORK` is what chooses the
 * Hedera client and the address table, so the two must agree.
 *
 * Constructor and function arguments are ABI-encoded with ethers and handed to the SDK as
 * opaque calldata. That keeps this script independent of the SDK's structured-parameter
 * surface, which changes between minor releases.
 */

import * as hbar from "@hiero-ledger/sdk";
import { AbiCoder, Interface } from "ethers";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_POOL_FEE,
  NETWORKS,
  POOL_FEE_LABELS,
  resolveNetwork,
  toEntityId,
  toEvmAddress,
  type HederaNetworkName,
} from "../config/networks";

/** Gas budget reserved for each scheduled release. */
const RELEASE_GAS_LIMIT = 800_000n;

/** Slippage tolerance between the SaucerSwap quote and the swap, in basis points. */
const DEFAULT_SLIPPAGE_BPS = 300;

/** Default stream shape used by a deploy run. */
const DEFAULT_TOTAL_UNITS = 1_000_000_000_000n; // 10,000 tokens at 8 decimals
const DEFAULT_CLIFF_SECONDS = 86_400n;
const DEFAULT_RELEASE_INTERVAL_SECONDS = 86_400n;
const DEFAULT_RELEASE_COUNT = 5;

/** Default fee ceiling applied to every transaction this script submits. */
const MAX_TRANSACTION_FEE = new hbar.Hbar(2);

/** Signatures the deploy script needs. Kept here so the script owns its own ABI. */
const STREAMED_VESTING_ABI = [
  "constructor(address owner_, address scheduleService_, address tokenService_, address swapRouter_, address quoter_, address wrappedHbar_, uint24 poolFee_, uint256 releaseGasLimit_, uint16 maxSlippageBps_)",
  "function createVesting(address beneficiary, address grantToken, uint256 total, uint64 cliffDelay, uint64 interval, uint32 releaseCount) returns (uint256 scheduleId)",
] as const;

/** HIP-1215 view call used by the capacity probe. */
const SCHEDULE_SERVICE_ABI = [
  "function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) view returns (bool)",
] as const;

/** Reads a required environment variable. */
function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing ${key}. Copy .env.example to .env, fill it in, and run the command again.`,
    );
  }
  return value.trim();
}

/**
 * Loads `.env` into the environment before any variable is read.
 *
 * `hardhat run` does not read `.env`, so a deploy that followed the documented
 * `cp .env.example .env` step would still fail with "Missing HEDERA_ACCOUNT_ID". Node's own
 * loader does the job without adding a dependency, and it never overrides a variable that
 * is already exported, so `HEDERA_NETWORK=mainnet npm run deploy:testnet` still wins.
 *
 * `__dirname` is `<repo>/packages/contracts/scripts`, so the repository root is three levels
 * up. Two levels up would resolve to `<repo>/packages/.env`, which never exists, and the
 * loader would return silently and every credential would read as missing.
 */
function loadDotEnv(): void {
  const envPath = path.join(__dirname, "..", "..", "..", ".env");
  if (!existsSync(envPath)) return;
  process.loadEnvFile(envPath);
}

/** Reads an optional numeric environment variable, falling back to `fallback`. */
function readNumericEnv(key: string, fallback: bigint): bigint {
  const raw = process.env[key];
  if (!raw || raw.trim() === "") return fallback;
  try {
    return BigInt(raw.trim());
  } catch {
    throw new Error(`${key} must be a whole number, received "${raw}".`);
  }
}

/** Reads an optional boolean environment variable, falling back to `fallback`. */
function readBooleanEnv(key: string, fallback = false): boolean {
  const raw = process.env[key];
  if (!raw || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * Builds an SDK client for the target network.
 *
 * Hedera operator accounts hold either an Ed25519 or an ECDSA(secp256k1) key, and the SDK
 * refuses to guess which one a bare hex string is. `HEDERA_ACCOUNT_KEY_TYPE` says which,
 * and picking the wrong constructor fails later with an opaque signature error, so the
 * value is validated up front.
 */
function buildClient(networkName: HederaNetworkName) {
  const accountId = hbar.AccountId.fromString(requireEnv("HEDERA_ACCOUNT_ID"));
  const rawKey = requireEnv("HEDERA_PRIVATE_KEY");

  const keyType = (process.env.HEDERA_ACCOUNT_KEY_TYPE ?? "ED25519")
    .trim()
    .toUpperCase();
  let privateKey: hbar.PrivateKey;
  if (keyType === "ED25519") {
    privateKey = hbar.PrivateKey.fromString(rawKey);
  } else if (keyType === "ECDSA") {
    privateKey = hbar.PrivateKey.fromStringECDSA(rawKey);
  } else {
    throw new Error(
      `HEDERA_ACCOUNT_KEY_TYPE must be ED25519 or ECDSA, received "${keyType}".`,
    );
  }

  const client =
    networkName === "mainnet"
      ? hbar.Client.forMainnet()
      : networkName === "previewnet"
        ? hbar.Client.forPreviewnet()
        : hbar.Client.forTestnet();

  client.setOperator(accountId, privateKey);
  client.setMaxTransactionFee(MAX_TRANSACTION_FEE);
  return { client, accountId, publicKey: privateKey.publicKey, keyType };
}

/**
 * Associates `accountRef` with `token`, treating an existing association as success.
 *
 * HTS transactions report a response code instead of throwing, so the code is inspected
 * and only unexpected statuses are fatal.
 *
 * @param accountRef Entity ID of the account or contract to associate. A deployed contract
 *        is associated through the account ID that matches its contract number.
 */
async function ensureAssociated(
  client: hbar.Client,
  accountRef: string,
  token: hbar.TokenId,
): Promise<void> {
  try {
    await new hbar.TokenAssociateTransaction({
      accountId: accountRef,
      tokenIds: [token],
    }).execute(client);
    console.log(`  associated ${accountRef} with ${token.toString()}`);
  } catch (error) {
    // The SDK raises for a non-success status. A pre-existing association is fine.
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
      console.log(`  ${accountRef} already associated with ${token.toString()}`);
      return;
    }
    throw new Error(`Token association failed for ${accountRef}: ${text}`);
  }
}

/** Reads the compiled `StreamedVesting` creation bytecode. */
function loadCreationCode(): Uint8Array {
  const artifactPath = path.join(
    __dirname,
    "..",
    "artifacts",
    "contracts",
    "StreamedVesting.sol",
    "StreamedVesting.json",
  );
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
    bytecode: string;
  };
  if (!artifact.bytecode || artifact.bytecode.length <= 2) {
    throw new Error(
      "Compiled bytecode is empty. Run `npm run compile` before deploying.",
    );
  }
  return Uint8Array.from(Buffer.from(artifact.bytecode.replace(/^0x/, ""), "hex"));
}

/** Converts a hex string into the byte array shape the SDK expects. */
function toBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));
}

/**
 * Publishes the full initcode to the Hedera File Service and returns its `FileId`.
 *
 * A `ContractCreateTransaction` that carries its initcode inline is bounded by
 * `transactionMaxBytes`, which is 6,144 bytes on Hedera. This contract's creation bytecode
 * is roughly twice that, so an inline create is rejected with `TRANSACTION_OVERSIZE` before
 * it ever reaches consensus.
 *
 * Referencing a `FileId` instead lifts that bound: the transaction then carries a reference,
 * and the initcode is limited only by the network's file size limit. The file content is the
 * creation bytecode with the constructor arguments appended, because the file replaces the
 * whole `initcode` field rather than supplementing it.
 */
async function uploadInitCode(
  client: hbar.Client,
  creationCode: Uint8Array,
  constructorArgs: Uint8Array,
): Promise<hbar.FileId> {
  const initcode = new Uint8Array(creationCode.length + constructorArgs.length);
  initcode.set(creationCode, 0);
  initcode.set(constructorArgs, creationCode.length);

  console.log(
    `  initcode      ${initcode.length} bytes, over the 6,144-byte inline limit` +
      ", publishing to the File Service",
  );

  const fileResponse = await new hbar.FileCreateTransaction()
    .setContents(initcode)
    .execute(client);
  const receipt = await fileResponse.getReceipt(client);

  if (receipt.status !== hbar.Status.Success || !receipt.fileId) {
    throw new Error(
      `FileCreateTransaction failed with status ${receipt.status}` +
        (receipt.fileId ? "" : " and no file ID."),
    );
  }
  console.log(`  initcode file ${receipt.fileId.toString()}`);
  return receipt.fileId;
}

/**
 * Asks the HSS system contract whether a future consensus second can still take a scheduled
 * call of `gasLimit`.
 *
 * The SDK exposes no HIP-1215 helper, so this goes through the system contract with an
 * ABI-encoded `hasScheduleCapacity` selector over `ContractCallQuery`. The call is a view,
 * which is why a query and not a transaction is the right transport.
 *
 * @returns `true` when HSS reported spare capacity, `false` when it reported none, and
 *          `null` when the node could not answer at all.
 */
async function probeScheduleCapacity(
  client: hbar.Client,
  scheduleServiceAddress: string,
  expirySecond: bigint,
  gasLimit: bigint,
): Promise<boolean | null> {
  const data = new Interface(SCHEDULE_SERVICE_ABI as unknown as string[])
    .encodeFunctionData("hasScheduleCapacity", [expirySecond, gasLimit]);

  const result = await new hbar.ContractCallQuery({
    contractId: toEntityId(scheduleServiceAddress),
    gas: 100_000,
    functionParameters: toBytes(data),
  }).execute(client);

  if (!result || result.bytes.length === 0) return null;
  return AbiCoder.defaultAbiCoder().decode(["bool"], result.bytes)[0] as boolean;
}

/**
 * Creates the grant token through the SDK, with a real treasury account and supply key.
 *
 * Going through the SDK rather than the HTS system contract keeps key handling explicit:
 * without a supply key nobody could inflate the stream after creation, and without an
 * admin key nobody could update or delete the token at all.
 */
async function createGrantToken(
  client: hbar.Client,
  treasury: hbar.AccountId,
  adminKey: hbar.PublicKey,
): Promise<hbar.TokenId> {
  console.log("\nCreating a grant token with the SDK");

  const supplyKey = hbar.PrivateKey.generateED25519();

  const response = await new hbar.TokenCreateTransaction({
    tokenName: "Streamed Vesting Grant",
    tokenSymbol: "SVG",
    decimals: 8,
    initialSupply: 1_000_000_000_000n, // 10,000 tokens at 8 decimals
    treasuryAccountId: treasury,
    supplyKey: supplyKey.publicKey,
    adminKey,
    maxSupply: 2_000_000_000_000n,
  }).execute(client);

  const receipt = await response.getReceipt(client);
  if (receipt.status !== hbar.Status.Success) {
    throw new Error(
      `Token creation failed with status ${receipt.status} (${receipt.status._code}).`,
    );
  }

  const tokenId = receipt.tokenId;
  if (!tokenId) {
    throw new Error("Token creation receipt contained no token ID.");
  }

  console.log(`  token id    ${tokenId.toString()}`);
  console.log("  treasury    operator account");
  console.log("  admin key   operator public key");
  console.log(
    "  supply key  generated in memory only. A real deployment must store it offline.",
  );
  return tokenId;
}

async function main(): Promise<void> {
  loadDotEnv();

  const networkName = (process.env.HEDERA_NETWORK ?? "testnet") as HederaNetworkName;
  const network = resolveNetwork(networkName);
  const config = NETWORKS[networkName];

  console.log(`\nStreamed vesting deploy -> Hedera ${network.name}`);
  console.log(`  mirror node       ${network.mirrorNodeUrl}`);
  console.log(`  schedule service  ${config.hssSystemContract}`);
  console.log(`  token service     ${config.htsSystemContract}`);
  console.log(
    `  swap router       ${config.saucerSwap.swapRouterV2.id} (${toEvmAddress(config.saucerSwap.swapRouterV2.id)})`,
  );

  const { client, accountId, publicKey, keyType } = buildClient(networkName);
  console.log(`  account key type  ${keyType}`);

  // A contract this size costs real HBAR to create, because Hedera charges for storing the
  // code, not just for executing it. Check the balance up front so an empty account fails
  // with an instruction instead of an `INSUFFICIENT_TX_FEE` receipt after the code has
  // already been uploaded to the File Service.
  const operatorBalance = await client
    .getAccountBalance(accountId)
    .then((info) => BigInt(info.hbars.toTinybars()));
  const deployCostHbar = 0.1;
  console.log(
    `  operator balance  ${Number(operatorBalance) / 1e8} HBAR` +
      (operatorBalance === 0n ? "  (EMPTY)" : ""),
  );
  if (operatorBalance === 0n) {
    throw new Error(
      "The operator account holds 0 HBAR, so this deploy cannot pay its fees. " +
        "Fund it from the testnet faucet at https://portal.hedera.com and run again. " +
        "A deploy of this contract typically costs a few tenths of an HBAR, because Hedera " +
        "charges for storing the ~11 KB of code as well as for executing it.",
    );
  }
  if (Number(operatorBalance) / 1e8 < deployCostHbar) {
    console.log(
      `  WARNING: below ${deployCostHbar} HBAR. A deploy this size may run out of fees.`,
    );
  }

  const iface = new Interface(STREAMED_VESTING_ABI as unknown as string[]);
  const coder = AbiCoder.defaultAbiCoder();

  try {
    // ------------------------------------------------------------------
    // 1. Grant token
    // ------------------------------------------------------------------
    let tokenId: hbar.TokenId;

    if (readBooleanEnv("HEDERA_CREATE_GRANT_TOKEN")) {
      tokenId = await createGrantToken(client, accountId, publicKey);
      console.log(
        "\n  WARNING: a token created now has no SaucerSwap pool. Claims will revert on the" +
          " swap until you seed a pool, or point HEDERA_GRANT_TOKEN_ID at a token that has one.",
      );
    } else {
      const configured = process.env.HEDERA_GRANT_TOKEN_ID?.trim();
      const tokenRef = configured || config.defaultGrantToken;
      if (!tokenRef) {
        throw new Error(
          `Hedera ${network.name} has no default grant token because SaucerSwap has no pool` +
            " to stream against there. Set HEDERA_GRANT_TOKEN_ID to a token that has a" +
            ` SaucerSwap V2 pool against WHBAR at fee tier ${DEFAULT_POOL_FEE}.`,
        );
      }
      tokenId = hbar.TokenId.fromString(tokenRef);

      const info = await new hbar.TokenInfoQuery({ tokenId }).execute(client);
      console.log("\nUsing grant token");
      console.log(`  token id    ${tokenId.toString()}`);
      console.log(`  name        ${info.name}`);
      console.log(`  symbol      ${info.symbol}`);
      console.log(`  decimals    ${info.decimals}`);
      if (!configured) {
        console.log(
          "  note        defaulted to this network's reference token because the swap is" +
            " mandatory. Set HEDERA_GRANT_TOKEN_ID to stream a different one.",
        );
      }
    }

    const whbarToken = hbar.TokenId.fromString(config.saucerSwap.whbarToken.id);
    console.log("\nAssociations");
    await ensureAssociated(client, accountId.toString(), tokenId);
    await ensureAssociated(client, accountId.toString(), whbarToken);

    // ------------------------------------------------------------------
    // 2. Vesting contract
    // ------------------------------------------------------------------
    const beneficiary = hbar.AccountId.fromString(
      requireEnv("VESTING_BENEFICIARY_ID"),
    );
    const poolFee = Number(
      readNumericEnv("VESTING_POOL_FEE", BigInt(DEFAULT_POOL_FEE)),
    );
    const slippageBps = Number(
      readNumericEnv("VESTING_MAX_SLIPPAGE_BPS", BigInt(DEFAULT_SLIPPAGE_BPS)),
    );
    if (!Number.isInteger(poolFee) || poolFee <= 0 || poolFee > 0xffffff) {
      throw new Error(
        `VESTING_POOL_FEE must be a three-byte fee tier such as 3000, received ${poolFee}.`,
      );
    }
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
      throw new Error(
        `VESTING_MAX_SLIPPAGE_BPS must be below 10000, received ${slippageBps}.`,
      );
    }

    console.log("\nDeploying StreamedVesting");
    const constructorArgs = coder.encode(
      [
        "address",
        "address",
        "address",
        "address",
        "address",
        "address",
        "uint24",
        "uint256",
        "uint16",
      ],
      [
        accountId.toEvmAddress(),
        config.hssSystemContract,
        config.htsSystemContract,
        toEvmAddress(config.saucerSwap.swapRouterV2.id),
        toEvmAddress(config.saucerSwap.quoterV2.id),
        toEvmAddress(config.saucerSwap.whbarToken.id),
        poolFee,
        RELEASE_GAS_LIMIT,
        slippageBps,
      ],
    );

    const creationCode = loadCreationCode();
    console.log(
      `  creation code ${creationCode.length} bytes. Hedera caps a single transaction at` +
        " 6,144 bytes, so the code is published to the File Service and the contract is" +
        " created from a FileId.",
    );

    const deployTx = await new hbar.ContractCreateFlow()
      .setBytecode(creationCode)
      .setConstructorParameters(toBytes(constructorArgs))
      .setGas(3_000_000)
      .execute(client);

    const deployReceipt = await deployTx.getReceipt(client);
    if (deployReceipt.status !== hbar.Status.Success) {
      throw new Error(
        `Contract creation failed with status ${deployReceipt.status} (${deployReceipt.status._code}).`,
      );
    }
    const contractId = deployReceipt.contractId;
    if (!contractId) {
      throw new Error("Deployment receipt contained no contract ID.");
    }
    console.log(`  contract id   ${contractId.toString()}`);
    console.log(`  evm address   ${contractId.toEvmAddress()}`);

    // The vesting contract pulls the grant in, so it must be able to hold the token.
    console.log("\nVesting contract setup");
    await ensureAssociated(client, contractId.toString(), tokenId);

    // The vesting contract uses `transferFrom` when a stream is created, so the operator
    // has to approve it. HTS allowances are exact amounts, not ERC20 infinite approval, and
    // the spender is expressed as an account ID even though it is a contract.
    const total = readNumericEnv("VESTING_TOTAL_UNITS", DEFAULT_TOTAL_UNITS);
    await new hbar.AccountAllowanceApproveTransaction({
      tokenApprovals: [
        new hbar.TokenAllowance({
          tokenId,
          ownerAccountId: accountId,
          spenderAccountId: hbar.AccountId.fromString(contractId.toString()),
          amount: total,
        }),
      ],
    }).execute(client);
    console.log("  approved the vesting contract to pull the grant");

    // ------------------------------------------------------------------
    // 3. First stream
    // ------------------------------------------------------------------
    const cliff = readNumericEnv("VESTING_CLIFF_SECONDS", DEFAULT_CLIFF_SECONDS);
    const interval = readNumericEnv(
      "VESTING_RELEASE_INTERVAL_SECONDS",
      DEFAULT_RELEASE_INTERVAL_SECONDS,
    );
    const releaseCount = Number(
      readNumericEnv("VESTING_RELEASE_COUNT", BigInt(DEFAULT_RELEASE_COUNT)),
    );

    console.log("\nCreating the first vesting stream");

    // Preflight the first release second against HSS. A saturated second does not fail the
    // deploy, because the contract retries with backoff, but knowing it up front avoids a
    // stream that only ever settles through permissionless manual calls.
    const nowSecond = BigInt(Math.floor(Date.now() / 1000));
    const capacity = await probeScheduleCapacity(
      client,
      config.hssSystemContract,
      nowSecond + cliff,
      RELEASE_GAS_LIMIT,
    );
    if (capacity === true) {
      console.log(`  schedule capacity  available for second ${nowSecond + cliff}`);
    } else if (capacity === false) {
      console.log(
        `  schedule capacity  saturated for second ${nowSecond + cliff}; the contract` +
          " will retry with exponential backoff and jitter",
      );
    } else {
      console.log(
        "  schedule capacity  HSS did not answer the probe; the contract will retry" +
          " with exponential backoff and jitter",
      );
    }

    const createData = iface.encodeFunctionData("createVesting", [
      beneficiary.toEvmAddress(),
      tokenId.toEvmAddress(),
      total,
      cliff,
      interval,
      releaseCount,
    ]);

    const createTx = await new hbar.ContractExecuteTransaction({
      contractId,
      gas: 4_500_000,
      functionParameters: toBytes(createData),
    }).execute(client);
    const createReceipt = await createTx.getReceipt(client);
    if (createReceipt.status !== hbar.Status.Success) {
      throw new Error(
        `createVesting failed with status ${createReceipt.status} (${createReceipt.status._code}).`,
      );
    }
    console.log("  status        SUCCESS");
    console.log("  schedule id   0");

    console.log("\nDone. Point the dashboard at this deployment:\n");
    console.log(`  NEXT_PUBLIC_HEDERA_NETWORK=${network.name} \\`);
    console.log(`  NEXT_PUBLIC_VESTING_CONTRACT_ID=${contractId.toString()} \\`);
    console.log("  npm run dev\n");
    console.log(
      `  Mirror Node logs: ${network.mirrorNodeUrl}/contracts/${contractId.toString()}/results/logs`,
    );
    console.log(`  Grant token EVM address: ${tokenId.toEvmAddress()}`);
    console.log(
      `  Pool tier required: ${poolFee} (${POOL_FEE_LABELS[poolFee] ?? "custom"}) on Hedera ${network.name}`,
    );
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nDeployment failed: ${message}`);
  process.exitCode = 1;
});
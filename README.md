# Streamed vesting, paid in HBAR

An on-chain vesting stream that unlocks itself and settles every claim in **native HBAR**, with
no bot, no relayer, and no cron job anywhere in the loop.

Two Hedera capabilities do the work, and neither is decorative:

- **[HIP-1215](https://hips.hedera.com/hip/hip-1215)** generalized scheduled contract calls. At grant
  time the contract asks the Hedera Schedule Service to call back into `executeClaim` at a future
  consensus second. When that second arrives, the network performs the call.
- **[SaucerSwap V2](https://docs.saucerswap.finance/developers/contracts)**. Every claim is swapped
  into WHBAR and unwrapped to native HBAR. The beneficiary **cannot** end up holding the grant
  token, and cannot redirect the payout.

> If you are looking for a generic recurring-payment example, this is not it. The interesting part
> is that the payout asset is decided by a liquidity route the grantee cannot override.

---

## Contents

- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Environment variables](#environment-variables)
- [Deploy to testnet](#deploy-to-testnet)
- [The dashboard](#the-dashboard)
- [Why the swap is load-bearing](#why-the-swap-is-load-bearing)
- [How HIP-1215 removes the bot](#how-hip-1215-removes-the-bot)
- [Hedera gotchas this template handles](#hedera-gotchas-this-template-handles)
- [Architecture](#architecture)
- [Where the addresses come from](#where-the-addresses-come-from)
- [Testing](#testing)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)

---

## Quick start

Scaffold it directly:

```bash
npm create scaffold-hbar@latest --template <owner>/template-hedera-vesting-swap
```

Or clone this repository and run it locally:

```bash
git clone <owner>/template-hedera-vesting-swap.git
cd template-hedera-vesting-swap
npm install
npm run compile
npm test
```

Then fill in `.env` (see [Environment variables](#environment-variables)) and deploy:

```bash
npm run deploy:testnet
```

The script prints the deployed contract ID and the `NEXT_PUBLIC_*` lines to paste into `.env`.
Then start the dashboard:

```bash
npm run dev
```

## Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js `>=20.18.3` | Enforced by the root `package.json` and by `template.json`. |
| npm | This template declares `npm` workspaces. |
| A funded Hedera account | [Hedera Portal](https://portal.hedera.com) → **Faucet** for testnet HBAR. |
| Nothing else | No local Hedera node, no indexer, no database. |

The dashboard reads from the **public Mirror Node REST API**. There is no backend to run.

## Environment variables

Copy `.env.example` to `.env` and fill it in. Never commit `.env`.

### Deploy-time

| Variable | Required | Description |
| --- | --- | --- |
| `HEDERA_ACCOUNT_ID` | yes | Operator account, `0.0.<num>`. Pays for deploy. |
| `HEDERA_PRIVATE_KEY` | yes | Hex-encoded, **no** `0x` prefix. |
| `HEDERA_ACCOUNT_KEY_TYPE` | no | `ED25519` (default) or `ECDSA`. |
| `HEDERA_NETWORK` | no | `testnet` (default), `previewnet`, `mainnet`. |
| `HEDERA_GRANT_TOKEN_ID` | no | Token to stream. Defaults to testnet SAUCE. Must have a SaucerSwap V2 pool against WHBAR. |
| `HEDERA_CREATE_GRANT_TOKEN` | no | `true` to mint a new grant token with the SDK. See the warning below. |
| `VESTING_BENEFICIARY_ID` | yes | Account that receives HBAR, `0.0.<num>`. |
| `VESTING_TOTAL_UNITS` | no | Grant amount in the token's smallest unit. Default `1000000000000`. |
| `VESTING_CLIFF_SECONDS` | no | Seconds to first unlock. Default `86400`. |
| `VESTING_RELEASE_INTERVAL_SECONDS` | no | Seconds between unlocks. Default `86400`. |
| `VESTING_RELEASE_COUNT` | no | Number of unlocks. Default `5`. |
| `VESTING_POOL_FEE` | no | SaucerSwap fee tier. Default `3000` (0.30%). |
| `VESTING_MAX_SLIPPAGE_BPS` | no | Quote-to-swap slippage tolerance. Must be `< 10000`. |

> **Creating a grant token does not give it liquidity.** A token minted by this deploy script has
> no SaucerSwap pool, so every claim will revert on the swap. Either use a token that already has a
> pool against WHBAR (testnet SAUCE does), or create and seed a pool before claiming. The deploy
> script prints this warning when `HEDERA_CREATE_GRANT_TOKEN=true`.

### Dashboard (read-only, `NEXT_PUBLIC_` prefix)

| Variable | Description |
| --- | --- |
| `NEXT_PUBLIC_HEDERA_NETWORK` | Which Mirror Node to read. Default `testnet`. |
| `NEXT_PUBLIC_VESTING_CONTRACT_ID` | The deployed contract, `0.0.<num>`. |

## Deploy to testnet

```bash
npm run deploy:testnet
```

What it does, in order:

1. Resolves the network and every Hedera and SaucerSwap address from `packages/contracts/config/networks.ts`.
2. Verifies the operator account, its key type, and its HBAR balance.
3. Associates the operator and the grant token so later transfers cannot fail on
   `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`.
4. Optionally mints the grant token through HTS with a treasury key, an admin key, and a supply key.
5. Deploys `StreamedVesting`, passing all addresses and the fee tier **as constructor arguments**
   rather than baking them into the bytecode. Switching networks is therefore a deployment concern,
   not a recompile.
6. Prints the contract ID and the `NEXT_PUBLIC_*` values for the dashboard.

`npm run deploy:mainnet` does the same against mainnet. Use it only with a funded mainnet account.

## The dashboard

Next.js App Router, server-rendered from Mirror Node contract logs. It decodes
`ScheduleCreated`, `ReleaseScheduled`, `ReleaseScheduleRejected`, `ClaimExecuted` and
`ScheduleRevoked` events, so there is no indexer and nothing to keep in sync.

| Route | Shows |
| --- | --- |
| `/` | Every stream, total HBAR delivered, releases the network refused, claim history. |
| `/schedule/[id]` | One stream: parties, timeline, per-release scheduled seconds and schedule addresses, claims. |

It degrades honestly: a missing `NEXT_PUBLIC_VESTING_CONTRACT_ID` renders setup instructions rather
than an error, and a Mirror Node outage renders the failure instead of a blank page.

## Why the swap is load-bearing

This is the design constraint that makes the template worth having, so it is worth being precise
about it.

`_settleInHbar` has exactly one payout branch. It approves the router, quotes the route, sets
`amountOutMinimum` from the quote and the configured slippage tolerance, swaps into WHBAR with the
router as recipient, then unwraps to the beneficiary. **There is no path that pays the grant
token**, and no flag to skip the conversion.

Remove SaucerSwap and there is no product left, because the only thing this template does that a
plain vesting contract does not is decide *which asset* the beneficiary ends up holding — and it
decides that by routing through live liquidity rather than by asking. A developer copying this gets
a capability that is awkward to build alone: on-chain liquidity routing inside a self-executing,
scheduled payout.

The corollary is the one real constraint: **the grant token must have a live SaucerSwap V2 pool
against WHBAR at the configured fee tier**, or every claim reverts on `exactInput`. That is why the
deploy script refuses to invent a token and why `previewnet` has no defaults at all — SaucerSwap
deploys no V2 contracts there.

## How HIP-1215 removes the bot

HIP-1215 lets a contract schedule an arbitrary future contract call, which turns a vesting stream
from an infrastructure problem into a deployment artifact.

At `createVesting` the contract calls the Schedule Service (`0x16b`) once per release, encoding
`this.executeClaim(scheduleId)` and a future consensus second. That is the entire scheduling
mechanism. There is no process to keep alive, no gas top-up, and no process that can go down between
two releases.

Two properties make it safe to depend on:

- **Scheduled calls never revert.** A saturated second comes back as `(370, address(0))`, where
  `370` is the ordinal of `SCHEDULE_EXPIRY_IS_BUSY` in `response_code.proto`. The contract checks
  that code as a *value*. Every call to a Hedera system contract in this template is checked this
  way.
- **`executeClaim` is permissionless.** It pays `vested - claimed`, so calling it early pays zero,
  calling it late pays the same amount, and calling it twice in one second pays once. A release the
  network refused is therefore not lost — anyone can settle it on demand. This is what lets the
  stream survive a schedule it could not create.

When a requested second is already full, `_findAvailableSecond` probes with exponentially growing
delays plus jitter, capped at `MAX_SCHEDULE_PROBES`, and reports through
`ReleaseScheduleRejected` if it truly cannot place the release.

## Hedera gotchas this template handles

These are the four that cost real debugging time. Each one is already solved in code.

1. **System contracts report, they do not revert.** `scheduleCall`, `deleteSchedule` and the HTS
   `approve` all return an `int64` `ResponseCodeEnum` ordinal. `22` is `SUCCESS`. Treating these as
   normal calls and asserting the return value is mandatory on Hedera, and wrong-looking Solidity
   will silently mis-handle failures.
2. **`0x16b` is the Schedule Service; `0x167` is HTS.** These are constantly misquoted for each
   other. Both are network-independent addresses, and `networks.ts` records how each was confirmed.
3. **The router needs an allowance, and it cannot grant one itself.** SaucerSwap pulls its input
   with `transferFrom`, so for a non-HBAR input the grantee must hold an allowance to the router.
   The router is not an HTS token and exposes no ERC-20 `approve`, so the allowance is granted
   through the HTS system contract.
4. **An HTS token cannot move to an unassociated account.** The deploy script associates the
   operator and the contract with the grant token before anything else runs.

There is a fifth, narrower one: the SaucerSwap route path is **reversed** (it starts with the
*output* token), and the three-byte fee must be left-aligned in its 32-bit word — `<< 232`, not
`<< 80`. `<< 80` encodes a zero fee, matches no pool, and reverts every swap. `_buildPath` has the
derivation in a comment.

## Architecture

```
packages/
  contracts/
    contracts/
      StreamedVesting.sol          the whole product
      interfaces/                  IHederaScheduleService, ISaucerSwapV2Router,
                                   ISaucerSwapV2Quoter, IHederaTokenServiceApprove, IERC20Minimal
      libraries/VestingMath.sol    timeline and linear vesting arithmetic
      mocks/                       test doubles for HSS, HTS, the router and the quoter
    config/networks.ts             every address, with provenance
    scripts/deploy.ts              env-driven, network-aware
    test/StreamedVesting.test.ts   65 tests
  web/
    app/                           dashboard routes
    lib/hedera.ts                  Mirror Node client, ABI-driven event decoding
    lib/dashboard.ts               view model assembly
```

The contract takes every external address through its constructor. That is what lets the test suite
substitute test doubles for the Schedule Service, HTS and SaucerSwap, and it is why the tests can
assert on exact response-code ordinals instead of mocking away the behaviour that matters.

### The claim flow

```
network reaches release second
        │
        ▼
Schedule Service calls StreamedVesting.executeClaim(scheduleId)
        │
        ├─ vested = vestedAmount(id)          linear, from block.timestamp
        ├─ amount = vested - claimed          so early/duplicate calls are no-ops
        │
        ▼
_settleInHbar
        ├─ HTS approve(grantToken → router, amount)      returns int64, checked
        ├─ quoter.quoteExactInput(path, amount)          in try/catch; a simulated
        │                                               failure surfaces as
        │                                               SwapQuoteFailed
        ├─ minimumOut = quotedOut × (10000 − slippageBps) / 10000
        ├─ router.exactInput(path, router, deadline, amount, minimumOut)
        └─ router.unwrapWHBAR(0, beneficiary)
        │
        ▼
beneficiary holds native HBAR
```

## Where the addresses come from

Every value lives in `packages/contracts/config/networks.ts` and nothing else contains a raw
address. Each entry carries a `verified` note recording its source.

| Contract | Testnet | Mainnet |
| --- | --- | --- |
| Schedule Service (HIP-1215) | `0x16b` | `0x16b` |
| HTS system contract | `0x167` | `0x167` |
| SaucerSwap V2 SwapRouter | `0.0.1414040` | `0.0.3949434` |
| SaucerSwap V2 QuoterV2 | `0.0.1390002` | `0.0.3949424` |
| SaucerSwap WHBAR token | `0.0.15058` | `0.0.1456986` |
| Default grant token | `0.0.1183558` (SAUCE) | `0.0.731861` (SAUCE) |

The system contract addresses are EVM hex; the SDK needs entity IDs. `networks.ts` exports
`toEvmAddress` and `toEntityId` for both directions.

The V2 router and quoter addresses were additionally checked against the deployed bytecode on
testnet: the router exposes `exactInput` and `unwrapWHBAR(uint256,address)` (`0x5fb043af`) but not
`unwrapWETH9`, and the quoter exposes `quoteExactInput(bytes,uint256)` (`0xcdca1753`). That is why
this template uses the V2 `unwrapWHBAR` name rather than the V1 `unwrapWETH9` name.

**Previewnet has no defaults.** SaucerSwap deploys no V2 contracts there, so there is no pool to
route through and the deploy script requires an explicit configuration.

## Testing

```bash
npm test
```

41 Hardhat tests against test doubles for the Schedule Service, HTS, the SaucerSwap router and the
quoter. They cover the behaviour that actually matters on Hedera:

- releases land at the requested seconds while capacity allows, and move forward when a second is saturated;
- a release that can *never* be scheduled is reported, and the stream still settles on demand;
- `scheduleCall` reporting success with a zero address is rejected rather than trusted;
- a claim before the cliff, a second claim that would pay nothing, and an unknown schedule all revert;
- the beneficiary tops up as more vests, and the HBAR delivered is recorded per claim;
- settlement always converts to HBAR and leaves no grant token with the beneficiary;
- a grant too large for the recorded `uint128` is refused rather than silently truncated;
- allowance failure, slippage and quote failure are surfaced as dedicated errors.

```bash
npm run lint     # solhint + eslint
npm run build    # contracts typecheck + Next.js production build
```

## Security notes

This template is production-quality scaffolding, **not audited software**. Read it before putting
real value behind it.

- `owner` can retune slippage and revoke any stream, returning unvested tokens to the grantor.
  Treat that key as trusted.
- A grantor can only create a stream for themselves and always receives the unvested remainder back.
  The beneficiary can only gain.
- Claim settlement is permissionless by design. Front-running it cannot redirect funds: HBAR always
  goes to the recorded beneficiary, and the swap carries a quoted floor.
- `.env` is gitignored. Never commit a private key.

## Troubleshooting

**Every claim reverts on the swap.** The grant token has no SaucerSwap V2 pool against WHBAR at
`VESTING_POOL_FEE`. Use testnet SAUCE, or create and seed a pool.

**`SwapQuoteFailed`.** The quoter simulates the swap and reverts when the pool is missing or
illiquid. This is a liquidity problem, not a configuration one.

**`ReleaseScheduleRejected`.** The network refused that second. Read the `responseCode` in the
event; `370` means the second was saturated. The release can still be settled manually by anyone
once tokens vest.

**Dashboard says "No contract configured yet".** `NEXT_PUBLIC_VESTING_CONTRACT_ID` is unset. The
deploy script prints the line to paste into `.env`.

**Dashboard cannot read logs.** Mirror Node indexes a few seconds behind consensus. If the contract
was just deployed, wait and reload.

**Hardhat fails on a newer Node.** Use Node `>=20.18.3` and `<23`. Some Hedera and Hardhat
dependencies still assume an older V8.

---

## License

MIT. See [LICENSE](./LICENSE).
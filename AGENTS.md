# AGENTS.md

Guidance for AI coding agents working in this repository, and the invariants that must not be
broken. Read this before editing.

## What this repo is

A `scaffold-hbar` community template: an on-chain vesting stream that unlocks itself via HIP-1215
scheduled contract calls and settles every claim in native HBAR through the SaucerSwap V2 router.

Read `README.md` first. It explains the product; this file explains how to change it safely.

## Layout

```
packages/contracts/
  contracts/StreamedVesting.sol      the product; read before touching anything else
  contracts/interfaces/              external ABIs, hand-written minimal interfaces
  contracts/libraries/VestingMath.sol timeline + linear vesting arithmetic
  contracts/mocks/                   test doubles for HSS, HTS, router, quoter
  config/networks.ts                 the single source of truth for every address
  scripts/deploy.ts                  env-driven deploy for any Hedera network
  test/StreamedVesting.test.ts       41 tests
packages/web/
  app/                               dashboard routes (server components)
  lib/hedera.ts                      Mirror Node client + ABI-driven event decoding
  lib/dashboard.ts                   view model assembly
```

## Commands

The repo-local Node 22 runtime lives at `.tooling/node-v22.23.3-darwin-arm64/bin` and is gitignored.
If `hardhat` misbehaves under your default Node, prepend it:

```bash
export PATH="$PWD/.tooling/node-v22.23.3-darwin-arm64/bin:$PATH"
```

| Command | Effect |
| --- | --- |
| `npm run compile` | Compile Solidity. Run this after any `.sol` change. |
| `npm test` | Full Hardhat suite. Must pass before you call anything done. |
| `npm run lint` | `solhint` on contracts, `eslint` on the web app. |
| `npm run build` | Contract typecheck plus the Next.js production build. |
| `npm run dev` | Dashboard on `localhost:3000`. |
| `npm run deploy:testnet` | Deploy. Requires credentials in `.env`. |
| `npm run clean` | Remove build output and caches. |

Never run `npm install -g`. Never commit `.env`.

## Invariants

Breaking any of these does more than break a test; it breaks the premise of the template.

### 1. Hedera system contract calls are checked as return values, never `require`d

`scheduleCall`, `deleteSchedule`, and the HTS `approve` **never revert**. They return an `int64`
ordinal from `ResponseCodeEnum`, where `22` is `SUCCESS`. A saturated release second returns
`(370, address(0))`; `370` is `SCHEDULE_EXPIRY_IS_BUSY`.

Compare the code as a value and emit a domain event on failure. Wrapping these in `require` or
expecting a revert will silently mis-handle every failure mode Hedera actually produces.

The test doubles in `packages/contracts/mocks/` reproduce this behaviour, including returning a
non-`SUCCESS` code with a plausible-looking zero address. Do not "simplify" them into reverting
mocks; the point of the suite is that the contract handles the real, non-throwing shape.

### 2. `executeClaim` must stay permissionless and idempotent

It pays `vested - claimed`. Early calls pay zero, late calls pay the same amount, duplicate calls
pay once. This is what makes a lost schedule survivable: the stream still settles on demand.

Do not add access control to `executeClaim`, and do not make it pay a fixed per-release amount.

### 3. The SaucerSwap swap stays mandatory in the payout path

`_settleInHbar` has one branch. There is no flag to pay the grant token instead of HBAR, and one
must not be added. The conversion is the product; removing it reduces the template to an ordinary
vesting contract that an existing template already covers.

Corollary: the grant token must have a live SaucerSwap V2 pool against WHBAR at the configured fee
tier. Do not add a fallback that pays the raw token when the swap fails — it would turn a loud,
clear failure into a silent change in what the beneficiary receives.

### 4. All external addresses arrive through the constructor

`scheduleService`, `tokenService`, `swapRouter`, `quoter`, `wrappedHbar`, `poolFee`,
`releaseGasLimit` are constructor parameters, resolved by `deploy.ts` from
`config/networks.ts`. Never bake an address into bytecode or a Solidity constant. This is what lets
the suite inject test doubles and what makes switching networks a deployment concern.

`0x16b` is the **Schedule Service**. `0x167` is **HTS**. They are routinely misquoted for each other.

### 5. Never commit secrets, never commit `.env`

`.gitignore` already covers it. Check `git status` before you finish.

## Traps that look like bugs

**The SaucerSwap path is reversed.** It begins with the *output* token:
`[outputToken(20), fee(3), inputToken(20)]`. For grant-token → HBAR, WHBAR comes first.

**The fee is a three-byte big-endian value**, so `3000` is `0x000bb8`. It must be **left-aligned**
in its 32-bit word. `_buildPath` uses `bytes3(bytes32(uint256(poolFee) << 232))`. Do not "correct"
it to `<< 80`; that encodes a zero fee, matches no pool, and reverts every swap. `bytes32 → bytes3`
keeps the leading three bytes and drops the trailing 29.

**V2 renamed `unwrapWETH9` to `unwrapWHBAR`.** The deployed testnet V2 router exposes
`unwrapWHBAR(uint256,address)` (`0x5fb043af`) and not `unwrapWETH9`. This was verified against
deployed bytecode, so do not "fix" it back to the V1 name.

**WHBAR carries eight decimals**, matching tinybar, so the unwrapped HBAR equals the WHBAR amount
one for one.

**`quoteExactInput` is non-view and can revert** because it simulates the swap. That is why
`_settleInHbar` wraps it in `try/catch` and raises `SwapQuoteFailed`. Do not mark it `view` or drop
the `catch`.

**Hedera lacks some newer opcodes.** `_findAvailableSecond` deliberately avoids `block.prevrandao`
so the contract does not depend on the Cancun opcode set. Keep it that way.

**The contract is larger than Hedera's 6,144-byte transaction limit.** Its creation code is
roughly 11 KB, so `npm run deploy:testnet` cannot use an inline `ContractCreateTransaction` and
fails on purpose with the exact byte count. Do not "fix" this by raising a limit — there isn't one
to raise. Shrink the contract below 6 KB, publish the initcode through the File Service, or use a
HIP-1086 jumbo `EthereumTransaction`. README section "The 6,144-byte transaction limit" has the
three routes and their traps. Whichever you pick, set `maxTransactionFee` explicitly: Hedera
charges for storing code, and the SDK default is too low for a payload this size.

**Never trust a Mirror Node field name you have not checked.** The account balance moved from
`balance.tinybar` to `balance.balance` between API versions. A `?? 0` fallback turns "field
missing" into "account is empty" and sends the operator to the faucet for nothing. Read both
shapes and distinguish unknown from zero.

## Working on the dashboard

The web app reads the **public Mirror Node**, has no backend, and decodes contract events through
the ABI. When you add an event to the contract, add it to the decoded set in `lib/hedera.ts` and
render it — do not introduce a second source of truth for stream state.

Keep the degradation paths. A missing `NEXT_PUBLIC_VESTING_CONTRACT_ID` renders setup
instructions, and a Mirror Node outage renders the failure. Both are intentional: a dashboard that
shows a blank page tells the reader nothing.

## Before you finish

1. `npm run compile`
2. `npm test`
3. `npm run lint`
4. `npm run build`
5. `git status` — confirm no `.env`, no key, no stray artifact

If a test fails, fix the cause. Do not relax an assertion to make a suite green; the suite is the
only description of the non-reverting Hedera behaviour this contract depends on.

## Provenance rule

Every entry in `config/networks.ts` carries a `verified` field recording where the address came
from. When you add one, add its source. An address with no provenance is a bug waiting to cost
someone an afternoon.
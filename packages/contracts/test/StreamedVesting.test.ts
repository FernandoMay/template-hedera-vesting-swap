import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { Interface } from "ethers";

import type { StreamedVesting } from "../typechain-types/StreamedVesting";
import type { MockScheduleService } from "../typechain-types/mocks/MockScheduleService";
import type { MockHtsApprove } from "../typechain-types/mocks/MockHtsApprove";
import type { MockSaucerSwapRouter } from "../typechain-types/mocks/MockSaucerSwapRouter";
import type { MockSaucerSwapQuoter } from "../typechain-types/mocks/MockSaucerSwapQuoter";
import type { MockERC20 } from "../typechain-types/mocks/MockERC20";

/** Release gas reserved per scheduled claim, mirroring the deploy script default. */
const RELEASE_GAS_LIMIT = 500_000n;

/** Slippage tolerance the fixture configures. */
const SLIPPAGE_BPS = 300n;

/** One grant unit buys this many WHBAR units, so the happy path settles 1:1. */
const RATE_BPS = 10_000n;

/** Pool fee tier the fixture quotes and swaps at: 0.30%. */
const POOL_FEE = 3000;

/** One day in seconds. */
const DAY = 86_400n;

/** Total grant in the fixture, 10,000 units at eight decimals. */
const TOTAL = 1_000_000_000_000n;

/** WHBAR the mock router holds as pool liquidity, far more than any test can consume. */
const ROUTER_WHAR_LIQUIDITY = 1_000_000_000_000_000_000n;

/** Releases in the default fixture stream. */
const RELEASES = 5n;

/** The default stream vests linearly across four day-long steps after a one-day cliff. */
const VESTING_WINDOW = (RELEASES - 1n) * DAY;

/** Exact vested amount at a given number of days past the cliff. */
function vestedAfterDays(days: bigint): bigint {
  return (TOTAL * (days * DAY)) / VESTING_WINDOW;
}

/**
 * Mines a block at `second`, so read-only calls afterwards observe exactly that second.
 *
 * On Hedera the EVM `block.timestamp` *is* the consensus second, which is what lets the
 * contract compare against a HIP-1215 expiry directly. Tests drive that clock directly
 * instead of waiting in real time.
 */
async function observeAt(second: bigint): Promise<void> {
  await ethers.provider.send("evm_setNextBlockTimestamp", [
    `0x${second.toString(16)}`,
  ]);
  await ethers.provider.send("evm_mine");
}

/**
 * Advances the chain so that the very next transaction executes at exactly `second`.
 *
 * Hardhat stamps each transaction one second after the latest block, so the block mined
 * here has to sit at `second - 1`.
 */
async function executeAt(second: bigint): Promise<void> {
  await observeAt(second - 1n);
}

interface Fixture {
  vesting: StreamedVesting;
  scheduleService: MockScheduleService;
  hts: MockHtsApprove;
  router: MockSaucerSwapRouter;
  quoter: MockSaucerSwapQuoter;
  grantToken: MockERC20;
  whbar: MockERC20;
  owner: HardhatEthersSigner;
  beneficiary: HardhatEthersSigner;
  grantor: HardhatEthersSigner;
  stranger: HardhatEthersSigner;
}

/**
 * Deploys a contract by name and returns it with its generated TypeChain type.
 *
 * `getContractFactory` is widened to the untyped ethers contract, so the cast restores the
 * per-contract signature that TypeChain generates from the compiled artifact.
 */
async function deploy<T>(
  name: string,
  args: unknown[] = [],
): Promise<T> {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract as unknown as T;
}

/**
 * Deploys the whole stack with test doubles standing in for HSS, HTS, and SaucerSwap.
 *
 * The doubles are wired so the success path has the same shape as a live settlement: the
 * router pulls its input with `transferFrom` using the allowance the vesting contract
 * grants through HTS, leaves the WHBAR output with itself, and pays native HBAR on unwrap.
 */
async function deployFixture(): Promise<Fixture> {
  const [owner, beneficiary, grantor, stranger] = await ethers.getSigners();

  const scheduleService = await deploy<MockScheduleService>(
    "MockScheduleService",
    [5_000_000n, 0n],
  );

  const hts = await deploy<MockHtsApprove>("MockHtsApprove");

  const grantToken = await deploy<MockERC20>("MockERC20", ["Grant", "GRT", 8]);
  const whbar = await deploy<MockERC20>("MockERC20", [
    "Wrapped HBAR",
    "WHBAR",
    8,
  ]);

  const router = await deploy<MockSaucerSwapRouter>(
    "MockSaucerSwapRouter",
    [await grantToken.getAddress(), await whbar.getAddress(), RATE_BPS],
  );

  const quoter = await deploy<MockSaucerSwapQuoter>("MockSaucerSwapQuoter", [
    RATE_BPS,
  ]);

  const vesting = await deploy<StreamedVesting>("StreamedVesting", [
    owner.address,
    await scheduleService.getAddress(),
    await hts.getAddress(),
    await router.getAddress(),
    await quoter.getAddress(),
    await whbar.getAddress(),
    POOL_FEE,
    RELEASE_GAS_LIMIT,
    SLIPPAGE_BPS,
  ]);

  // A live router holds native HBAR so it can pay out on unwrap.
  await ethers.provider.send("hardhat_setBalance", [
    await router.getAddress(),
    "0x21e19e0c9bab2400000",
  ]);

  // It also holds WHBAR, which is the pool's liquidity. Without this the swap output
  // transfer fails exactly as an empty pool would.
  await whbar.mint(await router.getAddress(), ROUTER_WHAR_LIQUIDITY);

  await grantToken.mint(grantor.address, TOTAL);
  await grantToken.connect(grantor).approve(await vesting.getAddress(), TOTAL);

  return {
    vesting,
    scheduleService,
    hts,
    router,
    quoter,
    grantToken,
    whbar,
    owner,
    beneficiary,
    grantor,
    stranger,
  };
}

/** Finds one event by name in a receipt, ignoring contract-address filtering. */
function findEvent(
  contract: { interface: Interface },
  receipt: { logs: readonly { topics: readonly string[]; data: string }[] },
  name: string,
): Record<string, unknown> {
  for (const log of receipt.logs) {
    const parsed = contract.interface.parseLog({
      topics: [...log.topics],
      data: log.data,
    });
    if (parsed?.name === name) {
      return parsed.args as Record<string, unknown>;
    }
  }
  throw new Error(`No ${name} event found in the receipt.`);
}

/** Parses every log in a receipt into named event args. */
function parseEvents(
  contract: { interface: Interface },
  receipt: { logs: readonly { topics: readonly string[]; data: string }[] },
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const log of receipt.logs) {
    const parsed = contract.interface.parseLog({
      topics: [...log.topics],
      data: log.data,
    });
    if (parsed) out.push(parsed.args as Record<string, unknown>);
  }
  return out;
}

/** Creates the default five-release daily stream and returns its id. */
async function createDailyStream(
  fixture: Fixture,
): Promise<bigint> {
  const receipt = await (
    await fixture.vesting
      .connect(fixture.grantor)
      .createVesting(
        fixture.beneficiary.address,
        await fixture.grantToken.getAddress(),
        TOTAL,
        DAY,
        DAY,
        Number(RELEASES),
      )
  ).wait();
  return findEvent(fixture.vesting, receipt!, "ScheduleCreated")
    .scheduleId as bigint;
}

/** HBAR balance of an address. */
function balanceOf(address: string): Promise<bigint> {
  return ethers.provider.getBalance(address);
}

describe("StreamedVesting", () => {
  describe("creation", () => {
    it("registers a stream, pulls the grant, and schedules every release", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);

      expect(scheduleId).to.equal(0n);
      expect(await f.vesting.scheduleCount()).to.equal(1n);

      const schedule = await f.vesting.getSchedule(0n);
      expect(schedule.beneficiary).to.equal(f.beneficiary.address);
      expect(schedule.grantor).to.equal(f.grantor.address);
      expect(schedule.total).to.equal(TOTAL);
      expect(schedule.claimed).to.equal(0n);
      expect(schedule.releaseCount).to.equal(RELEASES);
      expect(schedule.scheduledCount).to.equal(RELEASES);
      expect(schedule.revoked).to.equal(false);

      expect(
        await f.grantToken.balanceOf(await f.vesting.getAddress()),
      ).to.equal(TOTAL);

      expect(await f.scheduleService.callCount()).to.equal(RELEASES);
      for (let i = 0; i < Number(RELEASES); i += 1) {
        const pending = await f.vesting.releaseScheduleAt(0n, i);
        expect(pending).to.not.equal(ethers.ZeroAddress);

        const entry = await f.scheduleService.getCall(pending);
        expect(entry.target).to.equal(await f.vesting.getAddress());
        expect(entry.gasLimit).to.equal(RELEASE_GAS_LIMIT);
        expect(entry.value).to.equal(0n);

        const decoded = f.vesting.interface.parseTransaction({
          data: entry.callData,
        });
        expect(decoded!.name).to.equal("executeClaim");
        expect(decoded!.args[0]).to.equal(0n);
      }
    });

    it("spaces releases at the cliff and every interval after it", async () => {
      const f = await deployFixture();
      await createDailyStream(f);

      const schedule = await f.vesting.getSchedule(0n);
      expect(schedule.endTime).to.equal(
        schedule.cliffTime + schedule.interval * (RELEASES - 1n),
      );

      for (let i = 0; i < Number(RELEASES); i += 1) {
        expect(await f.vesting.releaseSecondAt(0n, i)).to.equal(
          schedule.cliffTime + schedule.interval * BigInt(i),
        );
      }
    });

    it("rejects invalid parameters with custom errors", async () => {
      const f = await deployFixture();
      const token = await f.grantToken.getAddress();

      await expect(
        f.vesting
          .connect(f.grantor)
          .createVesting(ethers.ZeroAddress, token, 100n, DAY, DAY, 3),
      ).to.be.revertedWithCustomError(f.vesting, "ZeroAddress");

      await expect(
        f.vesting
          .connect(f.grantor)
          .createVesting(f.beneficiary.address, token, 0n, DAY, DAY, 3),
      ).to.be.revertedWithCustomError(f.vesting, "ZeroAmount");

      await expect(
        f.vesting
          .connect(f.grantor)
          .createVesting(f.beneficiary.address, token, 100n, DAY, 0n, 3),
      ).to.be.revertedWithCustomError(f.vesting, "ZeroInterval");

      await expect(
        f.vesting
          .connect(f.grantor)
          .createVesting(f.beneficiary.address, token, 100n, DAY, DAY, 0),
      ).to.be.revertedWithCustomError(f.vesting, "ZeroReleaseCount");
    });

    it("refuses a grant too large to record instead of truncating it", async () => {
      const f = await deployFixture();
      const oversized = 2n ** 128n;

      await f.grantToken.mint(f.grantor.address, oversized);
      await f.grantToken
        .connect(f.grantor)
        .approve(await f.vesting.getAddress(), oversized);

      // A `uint128` downcast truncates silently, so the contract would pull the full
      // amount and then record a smaller one, stranding the difference with no way out.
      await expect(
        f.vesting
          .connect(f.grantor)
          .createVesting(
            f.beneficiary.address,
            await f.grantToken.getAddress(),
            oversized,
            DAY,
            DAY,
            2,
          ),
      )
        .to.be.revertedWithCustomError(f.vesting, "AmountExceedsUint128")
        .withArgs(oversized);

      expect(await f.scheduleService.callCount()).to.equal(0n);
      expect(
        await f.grantToken.balanceOf(await f.vesting.getAddress()),
      ).to.equal(0n);
    });

    it("refuses to open a stream it cannot fund", async () => {
      const f = await deployFixture();
      const token = await f.grantToken.getAddress();

      await expect(
        f.vesting
          .connect(f.stranger)
          .createVesting(f.beneficiary.address, token, 1_000n, DAY, DAY, 2),
      ).to.be.revertedWithCustomError(f.grantToken, "InsufficientBalance");

      expect(await f.vesting.scheduleCount()).to.equal(0n);
      expect(await f.scheduleService.callCount()).to.equal(0n);
    });
  });

  describe("vesting maths", () => {
    it("vests nothing before the cliff and everything after the end", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      await observeAt(schedule.cliffTime - 1n);
      expect(await f.vesting.vestedAmount(scheduleId)).to.equal(0n);

      await observeAt(schedule.endTime + 10_000n);
      expect(await f.vesting.vestedAmount(scheduleId)).to.equal(TOTAL);
    });

    it("releases linearly between cliff and end", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      await observeAt(schedule.cliffTime + 2n * DAY);
      expect(await f.vesting.vestedAmount(scheduleId)).to.equal(
        vestedAfterDays(2n),
      );

      await observeAt(schedule.cliffTime + 4n * DAY);
      expect(await f.vesting.vestedAmount(scheduleId)).to.equal(TOTAL);
    });

    it("refuses a claim before the cliff", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      await executeAt(schedule.cliffTime - 10n);
      await expect(
        f.vesting.connect(f.stranger).executeClaim(scheduleId),
      ).to.be.revertedWithCustomError(f.vesting, "CliffNotReached");
    });

    it("refuses an unknown schedule", async () => {
      const f = await deployFixture();
      await expect(
        f.vesting.connect(f.stranger).executeClaim(99n),
      ).to.be.revertedWithCustomError(f.vesting, "UnknownSchedule");
    });
  });

  describe("HIP-1215 scheduled execution", () => {
    it("settles a claim when the Schedule Service fires, with no caller involvement", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      await executeAt(schedule.cliffTime + 2n * DAY);

      const before = await balanceOf(f.beneficiary.address);
      await (await f.scheduleService.executeDue()).wait();
      const after = await balanceOf(f.beneficiary.address);

      const expected = vestedAfterDays(2n);
      expect(after - before).to.equal(expected);

      expect(
        await f.grantToken.balanceOf(await f.vesting.getAddress()),
      ).to.equal(TOTAL - expected);
      expect(await f.router.swapCount()).to.equal(1n);
      expect(await f.router.lastAmountIn()).to.equal(expected);
      expect(await f.router.lastHbarDelivered()).to.equal(expected);
      expect(await f.vesting.claimedAmount(scheduleId)).to.equal(expected);
    });

    it("settles every release as its second arrives", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const startingBalance = await balanceOf(f.beneficiary.address);

      for (let i = 0; i < Number(RELEASES); i += 1) {
        await executeAt(await f.vesting.releaseSecondAt(scheduleId, i));
        await (await f.scheduleService.executeDue()).wait();
      }

      const delivered =
        (await balanceOf(f.beneficiary.address)) - startingBalance;

      // The first release sits exactly on the cliff, where nothing has vested yet, so the
      // stream pays on the remaining four and lands on the full grant.
      expect(delivered).to.equal(TOTAL);
      expect(await f.router.swapCount()).to.equal(RELEASES - 1n);
      expect(await f.vesting.claimedAmount(scheduleId)).to.equal(TOTAL);
      expect(
        await f.grantToken.balanceOf(await f.vesting.getAddress()),
      ).to.equal(0n);
    });

    it("uses the requested release seconds while the schedule service has room", async () => {
      const f = await deployFixture();
      await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(0n);

      for (let i = 0; i < Number(RELEASES); i += 1) {
        const pending = await f.vesting.releaseScheduleAt(0n, i);
        const entry = await f.scheduleService.getCall(pending);
        expect(entry.expirySecond).to.equal(
          schedule.cliffTime + schedule.interval * BigInt(i),
        );
      }
    });

    it("moves a release to a later second when the requested one is saturated", async () => {
      const f = await deployFixture();

      // Room for exactly one release per consensus second.
      await f.scheduleService.setGasCapacityPerSecond(RELEASE_GAS_LIMIT);

      const latestBlock = await ethers.provider.getBlock("latest");
      if (!latestBlock) throw new Error("No block to read a consensus second from.");
      const latest = BigInt(latestBlock.timestamp);

      // Pin the clock so every step below has a known consensus second:
      // blocking scheduleCall lands at latest + 2, createVesting at latest + 3.
      await observeAt(latest + 1n);
      await f.scheduleService.scheduleCall(
        f.stranger.address,
        latest + 4n,
        RELEASE_GAS_LIMIT,
        0n,
        "0x",
      );

      // The only release wants `latest + 4`, which is now full.
      await f.vesting
        .connect(f.grantor)
        .createVesting(
          f.beneficiary.address,
          await f.grantToken.getAddress(),
          TOTAL,
          1n,
          1n,
          1,
        );

      const schedule = await f.vesting.getSchedule(0n);
      expect(schedule.cliffTime).to.equal(latest + 4n);

      const pending = await f.vesting.releaseScheduleAt(0n, 0n);
      expect(pending).to.not.equal(ethers.ZeroAddress);

      const entry = await f.scheduleService.getCall(pending);
      expect(entry.expirySecond).to.be.greaterThan(schedule.cliffTime);
      expect(schedule.scheduledCount).to.equal(1n);
    });

    it("moves a release forward when the requested second is not strictly in the future", async () => {
      const f = await deployFixture();

      // A zero cliff delay puts the first release on the current consensus second, which
      // HSS rejects because an expiry must be strictly later than now.
      const receipt = await (
        await f.vesting
          .connect(f.grantor)
          .createVesting(
            f.beneficiary.address,
            await f.grantToken.getAddress(),
            TOTAL,
            0n,
            60n,
            3,
          )
      ).wait();

      const scheduled = parseEvents(f.vesting, receipt!).filter(
        (event) => event.expirySecond !== undefined,
      );
      expect(scheduled).to.have.lengthOf(3);
      expect((await f.vesting.getSchedule(0n)).scheduledCount).to.equal(3n);

      // Every release landed strictly after the consensus second that created the stream,
      // so the unusable request cost the beneficiary nothing.
      const created = await f.vesting.getSchedule(0n);
      for (const entry of scheduled) {
        expect(entry.expirySecond as bigint).to.be.greaterThan(
          created.startTime,
        );
      }
      expect(scheduled[0]!.expirySecond as bigint).to.be.greaterThan(
        created.cliffTime,
      );

      // The two later releases are already in the future and keep their exact seconds.
      expect(scheduled[1]!.expirySecond).to.equal(
        created.cliffTime + created.interval,
      );
      expect(scheduled[2]!.expirySecond).to.equal(
        created.cliffTime + created.interval * 2n,
      );
    });

    it("survives a schedule that can never be created and still settles on demand", async () => {
      const f = await deployFixture();

      // No capacity at all: not one release can be scheduled.
      await f.scheduleService.setGasCapacityPerSecond(0);

      const receipt = await (
        await f.vesting
          .connect(f.grantor)
          .createVesting(
            f.beneficiary.address,
            await f.grantToken.getAddress(),
            TOTAL,
            DAY,
            DAY,
            3,
          )
      ).wait();

      const schedule = await f.vesting.getSchedule(0n);
      expect(schedule.scheduledCount).to.equal(0n);
      expect(await f.scheduleService.callCount()).to.equal(0n);
      expect(
        parseEvents(f.vesting, receipt!).filter(
          (event) => event.responseCode === 370n,
        ),
      ).to.have.lengthOf(3);

      // The stream itself is intact, because settlement is permissionless.
      await executeAt(schedule.cliffTime + DAY);
      const before = await balanceOf(f.beneficiary.address);
      await (await f.vesting.connect(f.stranger).executeClaim(0n)).wait();
      const after = await balanceOf(f.beneficiary.address);

      expect(after - before).to.equal(TOTAL / 2n);
      expect(await f.vesting.claimedAmount(0n)).to.equal(TOTAL / 2n);
    });

    it("reports the code when scheduleCall refuses a second that looked free", async () => {
      const f = await deployFixture();

      // Capacity is plentiful, so `hasScheduleCapacity` answers true for every release and
      // the contract commits to the exact second. The network then refuses anyway, which is
      // the only way to prove the returned code is inspected instead of trusted.
      await f.scheduleService.setForcedScheduleCallResponse(387n, true);

      const receipt = await (
        await f.vesting
          .connect(f.grantor)
          .createVesting(
            f.beneficiary.address,
            await f.grantToken.getAddress(),
            TOTAL,
            DAY,
            DAY,
            3,
          )
      ).wait();

      const rejections = parseEvents(f.vesting, receipt!).filter(
        (event) => event.responseCode !== undefined,
      );
      expect(rejections).to.have.lengthOf(3);
      for (const rejection of rejections) {
        expect(rejection.responseCode).to.equal(387n);
      }

      const schedule = await f.vesting.getSchedule(0n);
      expect(schedule.scheduledCount).to.equal(0n);
      expect(
        await f.vesting.releaseScheduleAt(0n, 0n),
      ).to.equal(ethers.ZeroAddress);

      // A refused release still leaves a stream the beneficiary can be paid from. Three
      // releases means a two-day window, so one day past the cliff is half the grant.
      await executeAt(schedule.cliffTime + DAY);
      await (await f.vesting.connect(f.stranger).executeClaim(0n)).wait();
      expect(await f.vesting.claimedAmount(0n)).to.equal(TOTAL / 2n);
    });

    it("rejects a scheduleCall that reports success with no schedule address", async () => {
      const f = await deployFixture();

      // SUCCESS with a zero address is the other shape of refusal. Trusting the address
      // alone would leave a release counted as live while nothing exists to execute it.
      await f.scheduleService.setForcedScheduleCallResponse(22n, true);

      const receipt = await (
        await f.vesting
          .connect(f.grantor)
          .createVesting(
            f.beneficiary.address,
            await f.grantToken.getAddress(),
            TOTAL,
            DAY,
            DAY,
            2,
          )
      ).wait();

      const rejections = parseEvents(f.vesting, receipt!).filter(
        (event) => event.responseCode !== undefined,
      );
      expect(rejections).to.have.lengthOf(2);
      expect((await f.vesting.getSchedule(0n)).scheduledCount).to.equal(0n);
    });
  });

  describe("permissionless settlement", () => {
    it("refuses a second claim that would pay nothing", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      // Settle the whole grant in one go, so nothing can vest afterwards.
      await executeAt(schedule.endTime);
      await (await f.vesting.connect(f.stranger).executeClaim(scheduleId)).wait();

      expect(await f.vesting.claimedAmount(scheduleId)).to.equal(TOTAL);
      expect(await f.router.swapCount()).to.equal(1n);

      // Vested is capped at the grant, so a repeat call has nothing left to pay and is
      // rejected instead of swapping the same tokens a second time.
      await executeAt(schedule.endTime + 10n * DAY);
      await expect(
        f.vesting.connect(f.stranger).executeClaim(scheduleId),
      ).to.be.revertedWithCustomError(f.vesting, "NothingNewlyVested");

      expect(await f.vesting.claimedAmount(scheduleId)).to.equal(TOTAL);
      expect(await f.router.swapCount()).to.equal(1n);
    });

    it("tops the beneficiary up as more vests", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      await executeAt(schedule.cliffTime + DAY);
      await (await f.vesting.connect(f.stranger).executeClaim(scheduleId)).wait();
      const first = await f.vesting.claimedAmount(scheduleId);

      await executeAt(schedule.cliffTime + 4n * DAY);
      await (await f.vesting.connect(f.stranger).executeClaim(scheduleId)).wait();
      const second = await f.vesting.claimedAmount(scheduleId);

      expect(first).to.equal(TOTAL / 4n);
      expect(second).to.equal(TOTAL);
    });

    it("records the caller and the HBAR delivered on every claim", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      await executeAt(schedule.cliffTime + DAY);
      const receipt = await (
        await f.vesting.connect(f.stranger).executeClaim(scheduleId)
      ).wait();

      const claim = findEvent(f.vesting, receipt!, "ClaimExecuted");
      expect(claim.caller).to.equal(f.stranger.address);
      expect(claim.beneficiary).to.equal(f.beneficiary.address);
      expect(claim.hbarDelivered).to.equal(claim.amountConverted);
      expect(claim.amountConverted).to.equal(TOTAL / 4n);
    });
  });

  describe("swap settlement", () => {
    it("always converts to HBAR and leaves no grant token with the beneficiary", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      await executeAt(schedule.cliffTime + DAY);
      await (await f.vesting.executeClaim(scheduleId)).wait();

      expect(await f.grantToken.balanceOf(f.beneficiary.address)).to.equal(0n);
      expect(await f.whbar.balanceOf(f.beneficiary.address)).to.equal(0n);
      expect(await f.router.unwrapCount()).to.equal(1n);
      expect(await f.router.lastHbarDelivered()).to.equal(TOTAL / 4n);
    });

    it("grants the router an allowance through HTS before swapping", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      expect(
        await f.grantToken.allowance(
          await f.vesting.getAddress(),
          await f.router.getAddress(),
        ),
      ).to.equal(0n);

      await executeAt(schedule.cliffTime + DAY);
      await (await f.vesting.executeClaim(scheduleId)).wait();

      // The router pulled the exact vested amount, leaving no allowance behind.
      expect(
        await f.grantToken.allowance(
          await f.vesting.getAddress(),
          await f.router.getAddress(),
        ),
      ).to.equal(0n);
      expect(await f.grantToken.balanceOf(await f.router.getAddress())).to.equal(
        TOTAL / 4n,
      );

      // The allowance existed at the moment the router pulled it. On Hedera the token
      // service records an allowance from the *calling* account, not from itself, so the
      // router could only see it if the vesting contract was the owner.
      expect(await f.router.lastAllowanceAtSwap()).to.equal(TOTAL / 4n);
      expect(await f.router.lastCaller()).to.equal(await f.vesting.getAddress());
    });

    it("refuses a claim while the router cannot be associated to the grant token", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      // A Hedera account cannot move an HTS token it is not associated to. The ledger
      // refuses the pull, so the whole claim fails rather than settling in the grant token.
      await f.router.setInputTokenAssociated(false);
      await executeAt(schedule.cliffTime + DAY);

      await expect(f.vesting.executeClaim(scheduleId))
        .to.be.revertedWithCustomError(f.router, "TokenNotAssociatedToAccount")
        .withArgs(await f.grantToken.getAddress(), await f.vesting.getAddress());

      // Nothing is marked claimed, so no vested token is lost by the failure.
      expect(await f.vesting.claimedAmount(scheduleId)).to.equal(0n);
      expect(await f.router.swapCount()).to.equal(0n);

      // Once the association exists the very same claim settles, which is why the failure
      // has to leave the stream retryable. The reverted transaction still consumed a
      // consensus second, so the settled amount is derived from the block the claim
      // actually landed in rather than from the second the test asked for.
      await f.router.setInputTokenAssociated(true);
      const before = await balanceOf(f.beneficiary.address);
      await (await f.vesting.executeClaim(scheduleId)).wait();
      const landed = await ethers.provider.getBlock("latest");
      const expectedVested =
        (TOTAL * (BigInt(landed!.timestamp) - schedule.cliffTime)) / VESTING_WINDOW;

      expect((await balanceOf(f.beneficiary.address)) - before).to.equal(
        expectedVested,
      );
      expect(await f.vesting.claimedAmount(scheduleId)).to.equal(expectedVested);
    });

    it("encodes the reversed route with the configured pool fee tier", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      await executeAt(schedule.cliffTime + DAY);
      await (await f.vesting.executeClaim(scheduleId)).wait();

      const path = await f.router.lastPath();

      // [outputToken(20) fee(3) inputToken(20) ...], with the fee as a big-endian 3-byte
      // word. The wrong shift silently produces a zero fee, which matches no pool, so this
      // pins the exact bytes rather than the intent.
      // Only the leading `0x` belongs to the whole word, so the input token sits in the
      // final 40 characters.
      expect(ethers.getBytes(path).length).to.equal(43);
      expect(path.slice(0, 42)).to.equal(
        (await f.whbar.getAddress()).toLowerCase(),
      );
      expect(path.slice(42, 48)).to.equal("000bb8");
      expect(path.slice(48, 88)).to.equal(
        (await f.grantToken.getAddress()).slice(2).toLowerCase(),
      );

      // The router must be the recipient so the WHBAR stays put ready for the unwrap.
      expect(await f.router.lastRecipient()).to.equal(await f.router.getAddress());
    });

    it("carries the consensus second plus a buffer into the swap deadline", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      await executeAt(schedule.cliffTime + DAY);
      await (await f.vesting.executeClaim(scheduleId)).wait();

      const block = await ethers.provider.getBlock("latest");
      expect(await f.router.lastDeadline()).to.equal(
        BigInt(block!.timestamp) + 300n,
      );
    });

    it("keeps the claim retryable when the swap deadline has already passed", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      await f.router.setForceExpiredDeadline(true);
      await executeAt(schedule.cliffTime + DAY);

      await expect(f.vesting.executeClaim(scheduleId))
        .to.be.revertedWithCustomError(f.router, "DeadlineExceeded");

      expect(await f.vesting.claimedAmount(scheduleId)).to.equal(0n);
      expect(await f.router.unwrapCount()).to.equal(0n);
    });

    it("derives the swap floor from the quote and the slippage tolerance", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      await executeAt(schedule.cliffTime + DAY);
      await (await f.vesting.executeClaim(scheduleId)).wait();

      // Quote 1:1, tolerance 3%, so the floor sits at 97% of the vested amount. A missing
      // floor would let the claim fill at any price the pool happened to offer.
      expect(await f.router.lastAmountOutMinimum()).to.equal(
        (TOTAL / 4n) * 9_700n / 10_000n,
      );
    });

    it("surfaces a non-success HTS allowance code as a custom error", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      await f.hts.setFailNextApprove(true);
      await executeAt(schedule.cliffTime + DAY);

      // The HTS call returns 333 rather than reverting, so the contract must read it.
      await expect(f.vesting.executeClaim(scheduleId))
        .to.be.revertedWithCustomError(f.vesting, "TokenApprovalFailed")
        .withArgs(await f.grantToken.getAddress(), 333n);

      // Nothing was marked as claimed, so the claim stays retryable.
      expect(await f.vesting.claimedAmount(scheduleId)).to.equal(0n);
    });

    it("fails cleanly when the route cannot be quoted", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      await f.quoter.setQuoteReverts(true);
      await executeAt(schedule.cliffTime + DAY);

      await expect(
        f.vesting.executeClaim(scheduleId),
      ).to.be.revertedWithCustomError(f.vesting, "SwapQuoteFailed");
      expect(await f.vesting.claimedAmount(scheduleId)).to.equal(0n);
    });

    it("fails cleanly when the quote prices the route at zero", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      await f.quoter.setRateBps(0n);
      await executeAt(schedule.cliffTime + DAY);

      await expect(
        f.vesting.executeClaim(scheduleId),
      ).to.be.revertedWithCustomError(f.vesting, "SwapQuoteZero");
    });

    it("enforces the slippage floor when the router fills worse than quoted", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      // The quote stays healthy while the pool suddenly fills at half the price. The
      // vesting contract has to carry that floor into amountOutMinimum.
      await f.router.setRateBps(RATE_BPS / 2n);
      await executeAt(schedule.cliffTime + DAY);

      await expect(f.vesting.executeClaim(scheduleId)).to.be.revertedWithCustomError(
        f.router,
        "InsufficientOutputAmount",
      );

      expect(await f.vesting.claimedAmount(scheduleId)).to.equal(0n);
      expect(await f.router.swapCount()).to.equal(0n);
    });

    it("proceeds when the router fills inside the slippage band", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      // 98% of the quote sits inside the 3% band the fixture configures.
      await f.router.setRateBps(9_800n);
      await executeAt(schedule.cliffTime + DAY);

      const before = await balanceOf(f.beneficiary.address);
      await (await f.vesting.executeClaim(scheduleId)).wait();
      const after = await balanceOf(f.beneficiary.address);

      expect(after - before).to.equal((TOTAL / 4n) * 9_800n / 10_000n);
    });
  });

  describe("revocation", () => {
    it("lets the grantor stop the stream and take back the unvested tokens", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      // Let the network fire the releases that are due, so those schedules are spent.
      await executeAt(schedule.cliffTime + DAY);
      await (await f.scheduleService.executeDue()).wait();

      const claimed = await f.vesting.claimedAmount(scheduleId);
      expect(claimed).to.equal(TOTAL / 4n);

      const before = await f.grantToken.balanceOf(f.grantor.address);
      const receipt = await (
        await f.vesting.connect(f.grantor).revoke(scheduleId)
      ).wait();

      expect(await f.grantToken.balanceOf(f.grantor.address)).to.equal(
        before + TOTAL - claimed,
      );
      expect(
        await f.grantToken.balanceOf(await f.vesting.getAddress()),
      ).to.equal(0n);
      expect((await f.vesting.getSchedule(scheduleId)).revoked).to.equal(true);

      // Three releases were still pending; all three are cancelled.
      expect(await f.scheduleService.deletedCount()).to.equal(RELEASES - 2n);

      // Every release is reported, including the two already spent. `deleteSchedule` answers
      // with a code instead of reverting, and only a success decrements the live count.
      const cancelled = parseEvents(f.vesting, receipt!).filter(
        (event) => event.responseCode !== undefined,
      );
      expect(cancelled).to.have.lengthOf(Number(RELEASES));
      // INVALID_SCHEDULE_ID for the two the network already executed.
      expect(cancelled.filter((event) => event.responseCode === 201n)).to.have.lengthOf(2n);

      expect((await f.vesting.getSchedule(scheduleId)).scheduledCount).to.equal(
        0n,
      );
    });

    it("lets the contract owner revoke but not a stranger", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);

      await expect(
        f.vesting.connect(f.stranger).revoke(scheduleId),
      ).to.be.revertedWithCustomError(f.vesting, "NotScheduleAuthority");

      await expect(
        f.vesting.connect(f.owner).revoke(scheduleId),
      ).to.not.be.reverted;
    });

    it("blocks execution after revocation", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);

      await (await f.vesting.connect(f.grantor).revoke(scheduleId)).wait();

      await expect(
        f.vesting.connect(f.stranger).executeClaim(scheduleId),
      ).to.be.revertedWithCustomError(f.vesting, "ScheduleIsRevoked");
    });
  });

  describe("administration", () => {
    it("only lets the owner retune slippage", async () => {
      const f = await deployFixture();

      await expect(
        f.vesting.connect(f.stranger).setMaxSlippageBps(100n),
      ).to.be.revertedWithCustomError(f.vesting, "NotOwner");

      await expect(
        f.vesting.connect(f.owner).setMaxSlippageBps(10_000n),
      ).to.be.revertedWithCustomError(f.vesting, "InvalidSlippage");

      await expect(f.vesting.connect(f.owner).setMaxSlippageBps(100n))
        .to.emit(f.vesting, "MaxSlippageUpdated")
        .withArgs(SLIPPAGE_BPS, 100n);

      expect(await f.vesting.maxSlippageBps()).to.equal(100n);
    });

    it("hands over ownership and refuses the zero address", async () => {
      const f = await deployFixture();

      await expect(
        f.vesting.connect(f.owner).transferOwnership(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(f.vesting, "ZeroAddress");

      await f.vesting.connect(f.owner).transferOwnership(f.stranger.address);
      expect(await f.vesting.owner()).to.equal(f.stranger.address);
    });

    it("refuses a misconfigured deployment", async () => {
      const f = await deployFixture();

      await expect(
        (
          await ethers.getContractFactory("StreamedVesting")
        ).deploy(
          ethers.ZeroAddress,
          await f.scheduleService.getAddress(),
          await f.hts.getAddress(),
          await f.router.getAddress(),
          await f.quoter.getAddress(),
          await f.whbar.getAddress(),
          POOL_FEE,
          RELEASE_GAS_LIMIT,
          SLIPPAGE_BPS,
        ),
      ).to.be.revertedWithCustomError(
        await ethers.getContractFactory("StreamedVesting"),
        "ZeroAddress",
      );
    });
  });

  describe("views", () => {
    it("reports the next release second and the claimable balance", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      let view = await f.vesting.status(scheduleId);
      expect(view.cliffReached).to.equal(false);
      expect(view.nextReleaseSecond).to.equal(schedule.cliffTime);
      expect(view.claimable).to.equal(0n);

      await observeAt(schedule.cliffTime + 2n * DAY);

      view = await f.vesting.status(scheduleId);
      expect(view.cliffReached).to.equal(true);
      expect(view.vested).to.equal(vestedAfterDays(2n));
      expect(view.claimable).to.equal(vestedAfterDays(2n));
      expect(view.nextReleaseSecond).to.equal(schedule.cliffTime + 3n * DAY);
    });

    it("reports no next release once the stream is finished", async () => {
      const f = await deployFixture();
      const scheduleId = await createDailyStream(f);
      const schedule = await f.vesting.getSchedule(scheduleId);

      await observeAt(schedule.endTime + 1n);
      expect((await f.vesting.status(scheduleId)).nextReleaseSecond).to.equal(0n);
    });

    it("rejects views for unknown schedules", async () => {
      const f = await deployFixture();

      await expect(f.vesting.status(7n)).to.be.revertedWithCustomError(
        f.vesting,
        "UnknownSchedule",
      );
      await expect(f.vesting.vestedAmount(7n)).to.be.revertedWithCustomError(
        f.vesting,
        "UnknownSchedule",
      );
      await expect(f.vesting.claimedAmount(7n)).to.be.revertedWithCustomError(
        f.vesting,
        "UnknownSchedule",
      );
      await expect(f.vesting.releaseSecondAt(7n, 0n)).to.be.revertedWithCustomError(
        f.vesting,
        "UnknownSchedule",
      );
    });
  });
});

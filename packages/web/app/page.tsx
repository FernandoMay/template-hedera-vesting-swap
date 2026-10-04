import Link from "next/link";

import { loadDashboard, type RenderedStream } from "../lib/dashboard";
import { formatDuration, formatTimestamp, shortenEntityId } from "../lib/format";
import { responseCodeLabel } from "../lib/vesting";

export const dynamic = "force-dynamic";

/** Renders one stream card with its progress, releases and claims. */
function StreamCard({ stream }: { stream: RenderedStream }) {
  const { summary } = stream;
  const symbol = stream.token?.symbol ?? "tokens";
  const finished = summary.secondsRemaining === 0;
  const scheduledCount = summary.releases.length;

  return (
    <article className="panel">
      <h2>
        <Link href={`/schedule/${summary.scheduleId}`}>Stream #{summary.scheduleId}</Link>{" "}
        <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
          · {stream.totalFormatted} {symbol}
        </span>
      </h2>
      <p className="hint">
        Beneficiary <span className="mono">{shortenEntityId(summary.beneficiary)}</span> ·{" "}
        granted by <span className="mono">{shortenEntityId(summary.grantor)}</span>
        {summary.revoked ? " · revoked" : ""}
      </p>

      <div className="meter" aria-hidden="true">
        <span className="paid" style={{ width: `${stream.claimedPercent}%` }} />
        <span style={{ width: `${stream.vestedPercent}%` }} />
      </div>
      <p className="hint" style={{ margin: 0 }}>
        {stream.claimedFormatted} {symbol} paid · {stream.vestedFormatted} {symbol} vested
        {" · "}
        {summary.claimable > 0n
          ? `${stream.claimableFormatted} ${symbol} claimable now`
          : finished
            ? "stream finished"
            : "nothing claimable yet"}
      </p>

      <div className="stats">
        <dl className="stat">
          <dt>Claimable now</dt>
          <dd>{stream.claimableFormatted}</dd>
        </dl>
        <dl className="stat">
          <dt>Unlocks scheduled</dt>
          <dd>
            {scheduledCount}/{summary.releaseCount}
          </dd>
        </dl>
        <dl className="stat">
          <dt>Claims settled</dt>
          <dd>{summary.claims.length}</dd>
        </dl>
        <dl className="stat">
          <dt>{finished ? "Ended" : "Next release"}</dt>
          <dd>
            {finished
              ? formatTimestamp(summary.endTime)
              : formatDuration(summary.secondsRemaining)}
          </dd>
        </dl>
      </div>

      {summary.rejected.length > 0 ? (
        <>
          <h3>Releases the network refused</h3>
          <p className="hint">
            These unlocks could not be scheduled. Nothing is lost: the stream still settles,
            because `executeClaim` is permissionless and pays whatever has vested.
          </p>
          <table>
            <thead>
              <tr>
                <th>Release</th>
                <th>Requested second</th>
                <th>Reported code</th>
              </tr>
            </thead>
            <tbody>
              {summary.rejected.map((release) => (
                <tr key={release.index}>
                  <td className="mono">#{release.index}</td>
                  <td className="mono">{formatTimestamp(release.requestedSecond)}</td>
                  <td className="mono">{responseCodeLabel(release.responseCode)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {summary.claims.length > 0 ? (
        <>
          <h3>Claim history</h3>
          <table>
            <thead>
              <tr>
                <th>Settled at</th>
                <th>Tokens converted</th>
                <th>HBAR delivered</th>
                <th>Called by</th>
              </tr>
            </thead>
            <tbody>
              {summary.claims.map((claim, index) => (
                <tr key={`${claim.consensusSecond}-${index}`}>
                  <td className="mono">{formatTimestamp(claim.consensusSecond)}</td>
                  <td className="mono">{claim.amountConverted.toString()}</td>
                  <td className="mono">
                    {(Number(claim.hbarDelivered) / 1e10).toLocaleString("en-US", {
                      maximumFractionDigits: 8,
                    })}{" "}
                    ℏ
                  </td>
                  <td className="mono">
                    {shortenEntityId(claim.caller) === shortenEntityId(summary.beneficiary)
                      ? "Schedule Service"
                      : shortenEntityId(claim.caller)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </article>
  );
}

export default async function Home() {
  const data = await loadDashboard();

  return (
    <>
      <header className="masthead">
        <h1>Streamed vesting, paid in HBAR</h1>
        <p>
          Each stream below unlocks itself through HIP-1215 scheduled contract calls and
          settles every claim through the SaucerSwap V2 router, so the beneficiary receives
          native HBAR and nothing else. No bot, no relayer, no cron.
        </p>
        <div className="badges">
          <span className="badge">{data.network.label}</span>
          <span className="badge">
            Mirror Node {data.network.mirrorNodeUrl.replace(/^https:\/\/|\/api\/v1$/g, "")}
          </span>
          <span className="badge">
            contract {data.contractId ?? "not configured"}
          </span>
          {data.error ? <span className="badge warn">chain unreachable</span> : null}
        </div>
      </header>

      {data.error ? (
        <section className="panel error">
          <h2>Could not read the contract log</h2>
          <p className="hint">{data.error}</p>
          <p className="hint">
            The contract id looks correct but the Mirror Node did not answer. Check that
            {" "}
            <code>NEXT_PUBLIC_HEDERA_NETWORK</code> matches the network the contract was
            deployed to, and that the contract has been created.
          </p>
        </section>
      ) : null}

      {!data.error && !data.contractId ? (
        <section className="panel">
          <h2>No contract configured yet</h2>
          <p className="hint">
            This dashboard reads a deployed <code>StreamedVesting</code> from the Hedera
            Mirror Node. Point it at your deployment:
          </p>
          <pre>{`NEXT_PUBLIC_HEDERA_NETWORK=testnet
NEXT_PUBLIC_VESTING_CONTRACT_ID=0.0.1234`}</pre>
          <p className="hint">
            Deploy one with <code>npm run deploy:testnet</code> from the repository root. The
            deploy script prints these two lines when it finishes.
          </p>
        </section>
      ) : null}

      {!data.error && data.contractId && data.streams.length === 0 ? (
        <section className="panel">
          <h2>Contract deployed, no streams yet</h2>
          <p className="hint">
            <span className="mono">{data.contractId}</span> is live and has emitted no{" "}
            <code>ScheduleCreated</code> event. Create one with{" "}
            <code>createVesting</code>, and this page fills in.
          </p>
        </section>
      ) : null}

      {data.streams.map((stream) => (
        <StreamCard key={stream.summary.scheduleId.toString()} stream={stream} />
      ))}

      {data.streams.length > 0 ? (
        <section className="panel">
          <h2>Total HBAR delivered</h2>
          <p className="hint">
            Across every claim on this contract the beneficiaries have received{" "}
            <span className="mono">{data.totalHbarDeliveredFormatted} ℏ</span>, converted
            from the grant token by the SaucerSwap V2 router at claim time.
          </p>
        </section>
      ) : null}
    </>
  );
}